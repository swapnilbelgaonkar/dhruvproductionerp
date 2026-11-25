import { Router, type Request } from 'express';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { getSetting } from '../../lib/settings';
import { grantsFor, requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { reportCsv } from '../mis/reports';
import { todayIST } from '../sales/quotations';
import { getIntegration, logCall } from './registry';

/**
 * Messages outside the ERP (D11): e-mail, SMS and WhatsApp. Everything goes through one queue (sys.messages) so a message is sent once,
 * retried on failure and can be audited. Senders:
 *  - alerts, to users who chose the channel (and whose rule allows it);
 *  - scheduled reports, e-mailed as CSV to the chosen users, limited to what the schedule's owner may see;
 *  - dealer payment reminders, before the due date and every few days while overdue.
 * The integration mode decides delivery: OFF = nothing queued; SIMULATED = marked sent without leaving the system; LIVE = SMTP or the HTTPS provider.
 */
export type Channel = 'EMAIL' | 'SMS' | 'WHATSAPP';
const CHANNELS: Channel[] = ['EMAIL', 'SMS', 'WHATSAPP'];
export const fill = (t: string, v: Record<string, unknown>) => t.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (v[k] == null ? '' : String(v[k])));
const MAX_TRIES = 5;

/** Queues a message from a template if the channel is on; the dedupe key makes repeated calls harmless. */
export async function queueMessage(tx: Db | Tx, m: { channel: Channel; template: string; to: string; toUserId?: string | null; toPartyId?: string | null; vars: Record<string, unknown>;
  attachments?: { name: string; contentType: string; base64: string }[]; dedupeKey: string }) {
  const i = await getIntegration(tx, m.channel);
  if (i.mode === 'OFF') return false;
  const t = (await tx.query(`select subject, body, provider_template_id from sys.message_templates where code = $1 and channel = $2`, [m.template, m.channel])).rows[0];
  if (!t) return false;
  const r = await tx.query(`insert into sys.messages (channel, template, to_address, to_user_id, to_party_id, subject, body, vars, attachments, dedupe_key)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (dedupe_key) do nothing`,
    [m.channel, m.template, m.to, m.toUserId ?? null, m.toPartyId ?? null, t.subject ? fill(t.subject, m.vars).slice(0, 200) : null, fill(t.body, m.vars), JSON.stringify(m.vars), JSON.stringify(m.attachments ?? []), m.dedupeKey]);
  return (r.rowCount ?? 0) > 0;
}

type Sender = (cfg: Record<string, unknown>, msg: { to: string; subject: string | null; body: string; template: string; vars: Record<string, unknown>; templateId: string | null; attachments: { name: string; contentType: string; base64: string }[] }) => Promise<string>;
const env = (name: unknown) => (typeof name === 'string' && name ? process.env[name] : undefined);
let smtp: { key: string; t: nodemailer.Transporter } | null = null;
const SENDERS: Record<Channel, Sender> = {
  EMAIL: async (c, m) => {
    const key = JSON.stringify(c);
    if (smtp?.key !== key) smtp = { key, t: nodemailer.createTransport({ host: String(c.host), port: Number(c.port ?? 587), secure: c.secure === true || c.secure === 'true',
      auth: env(c.userEnv) ? { user: env(c.userEnv)!, pass: env(c.passwordEnv) ?? '' } : undefined }) };
    const info = await smtp.t.sendMail({ from: String(c.from), to: m.to, subject: m.subject ?? '', text: m.body,
      attachments: m.attachments.map((a) => ({ filename: a.name, contentType: a.contentType, content: Buffer.from(a.base64, 'base64') })) });
    return info.messageId;
  },
  SMS: async (c, m) => webhook(c, { to: m.to, text: m.body, templateId: m.templateId, senderId: c.senderId ?? null }),
  WHATSAPP: async (c, m) => webhook(c, { to: `91${m.to}`, template: m.templateId ?? m.template, variables: m.vars, text: m.body }),
};
async function webhook(c: Record<string, unknown>, body: unknown) {
  const token = env(c.tokenEnv);
  const r = await fetch(String(c.url), { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  try { const j = JSON.parse(text); return String(j.id ?? j.messageId ?? j.message_id ?? j.sid ?? 'accepted'); } catch { return 'accepted'; }
}

/** Sends queued messages (worker loop). Each is claimed with SKIP LOCKED so several workers do not send twice. */
export async function sendQueued(db: Db, batch = 25) {
  let sent = 0; let failed = 0;
  for (let k = 0; k < batch; k++) {
    const done = await withTx(db, async (tx) => {
      const m = (await tx.query(`select m.*, t.provider_template_id from sys.messages m left join sys.message_templates t on t.code = m.template and t.channel = m.channel
          where m.status = 'Queued' order by m.created_at limit 1 for update of m skip locked`)).rows[0];
      if (!m) return null;
      const i = await getIntegration(tx, m.channel);
      if (i.mode === 'OFF') { await tx.query(`update sys.messages set status = 'Skipped', last_error = 'Channel switched off', mode = 'OFF' where id = $1`, [m.id]); return 'skip'; }
      try {
        const ref = i.mode === 'SIMULATED' ? `SIM-${m.id.slice(0, 8)}` : await SENDERS[m.channel as Channel](i.config, { to: m.to_address, subject: m.subject, body: m.body, template: m.template, vars: m.vars,
          templateId: m.provider_template_id, attachments: m.attachments });
        await tx.query(`update sys.messages set status = 'Sent', sent_at = now(), attempts = attempts + 1, provider_ref = $2, mode = $3, last_error = null where id = $1`, [m.id, ref, i.mode]);
        await logCall(tx, { integration: m.channel, operation: `send ${m.template}`, mode: i.mode, subjectType: 'sys.message', subjectId: m.id, ok: true, response: { ref } });
        sent++; return 'ok';
      } catch (e) {
        const err = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        await tx.query(`update sys.messages set attempts = attempts + 1, last_error = $2, mode = $3, status = case when attempts + 1 >= $4 then 'Failed' else 'Queued' end where id = $1`, [m.id, err, i.mode, MAX_TRIES]);
        await logCall(tx, { integration: m.channel, operation: `send ${m.template}`, mode: i.mode, subjectType: 'sys.message', subjectId: m.id, ok: false, error: err });
        failed++; return 'fail';
      }
    });
    if (!done || done === 'fail') break;     // nothing left, or the provider is failing: try again on the next round
  }
  return { sent, failed };
}

/** Alerts also go out on the channels the rule allows and each user has chosen (in-app notification always). */
export async function fanOutAlert(tx: Tx, rule: { channels?: string[] | null }, users: string[], a: { id: string; title: string; body: string; link: string | null }, suffix: string, prefix = '') {
  const allowed = (rule.channels ?? []).filter((c): c is Channel => CHANNELS.includes(c as Channel));
  if (!allowed.length || !users.length) return;
  const base = (await getSetting<string>(tx, 'app.publicUrl', '')).replace(/\/$/, '');
  const us = (await tx.query(`select id, email, mobile, notify_channels from iam.users where id = any($1::uuid[]) and status = 'Active'`, [users])).rows;
  for (const u of us) {
    for (const ch of allowed.filter((c) => (u.notify_channels ?? []).includes(c))) {
      const to = ch === 'EMAIL' ? u.email : u.mobile;
      if (!to) continue;
      await queueMessage(tx, { channel: ch, template: 'ALERT', to, toUserId: u.id, vars: { title: `${prefix}${a.title}`, body: a.body, link: a.link ? `${base}${a.link}` : '' }, dedupeKey: `alert:${a.id}:${suffix}:${u.id}:${ch}` });
    }
  }
}

// ---------------------------------------------------------------- dealer reminders
export async function scanDealerReminders(db: Db) {
  const s = await getSetting<{ enabled: boolean; daysBefore: number; overdueEveryDays: number; channels: Channel[] }>(db, 'dealer.reminders', { enabled: false, daysBefore: 3, overdueEveryDays: 7, channels: ['EMAIL'] });
  if (!s.enabled) return 0;
  const company = await getSetting<string>(db, 'company.displayName', 'Dhruv Agro');
  const today = todayIST();
  const rows = (await db.query(`select i.id, i.doc_no, i.invoice_date, i.due_date, i.due_date - $1::date as d, i.grand_total - i.amount_settled as o, p.id as party_id, p.legal_name, p.email, p.mobile
      from sales.invoices i join mdm.parties p on p.id = i.party_id join mdm.dealer_profiles dp on dp.party_id = p.id
      where i.status = 'Posted' and i.grand_total - i.amount_settled > 0.004 and i.due_date <= $1::date + $2::int`, [today, s.daysBefore])).rows;
  let n = 0;
  const fmt = (v: unknown) => { const x = new Date(v as string).toISOString().slice(0, 10); return `${x.slice(8)}-${x.slice(5, 7)}-${x.slice(0, 4)}`; };
  for (const r of rows) {
    const overdue = Number(r.d) < 0;
    const bucket = overdue ? `overdue:${Math.floor(-Number(r.d) / Math.max(1, s.overdueEveryDays))}` : 'due';
    const vars = { dealer: r.legal_name, invoiceNo: r.doc_no, invoiceDate: fmt(r.invoice_date), dueDate: fmt(r.due_date), amount: Number(r.o).toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      daysOverdue: -Number(r.d), company };
    for (const ch of s.channels) {
      const to = ch === 'EMAIL' ? r.email : r.mobile;
      if (!to) continue;
      if (await queueMessage(db, { channel: ch, template: overdue ? 'DEALER_PAYMENT_OVERDUE' : 'DEALER_PAYMENT_DUE', to, toPartyId: r.party_id, vars, dedupeKey: `remind:${r.id}:${bucket}:${ch}` })) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- scheduled reports
/** Next run (UTC) after `from` for a schedule at hour_ist on the given day pattern. */
export function nextRun(s: { frequency: string; weekday?: number | null; month_day?: number | null; hour_ist: number }, from = new Date()) {
  const ist = new Date(from.getTime() + 5.5 * 3_600_000);
  for (let add = 0; add < 400; add++) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + add, s.hour_ist, 0, 0) - 5.5 * 3_600_000);
    if (d <= from) continue;
    const dIst = new Date(d.getTime() + 5.5 * 3_600_000);
    const wd = ((dIst.getUTCDay() + 6) % 7) + 1;
    if (s.frequency === 'DAILY' || (s.frequency === 'WEEKLY' && wd === s.weekday) || (s.frequency === 'MONTHLY' && dIst.getUTCDate() === s.month_day)) return d;
  }
  throw new Error('No next run');
}

/** A request standing for a user, so a report is limited exactly as it would be for them. */
async function requestAs(db: Db, userId: string, query: Record<string, string>) {
  const u = (await db.query(`select id, email, full_name, status, employee_id from iam.users where id = $1`, [userId])).rows[0];
  if (!u || u.status !== 'Active') return null;
  const g = await grantsFor(db, userId);
  return { query, ip: 'scheduler', get: () => 'scheduler', auth: { sessionId: 'scheduler', csrfToken: '', mfaSatisfied: true, mfaRequiredByRole: false,
    user: { id: u.id, email: u.email, fullName: u.full_name, status: u.status, mustChangePassword: false, mfaEnabled: false, employeeId: u.employee_id },
    roles: [...g.roles].map(([code, name]) => ({ code, name })), grants: g.grants } } as unknown as Request;
}

export async function runSchedule(db: Db, id: string) {
  const s = (await db.query(`select s.*, u.full_name as owner from sys.report_schedules s join iam.users u on u.id = s.run_as where s.id = $1`, [id])).rows[0];
  if (!s) throw Errors.notFound('Schedule');
  let status: string;
  try {
    const req = await requestAs(db, s.run_as, s.params ?? {});
    if (!req) throw new Error('The schedule owner is no longer active');
    const out = await reportCsv(db, req, s.report_id);
    const rec = (await db.query(`select id, email from iam.users where id = any($1::uuid[]) and status = 'Active'`, [s.recipient_user_ids])).rows;
    const stamp = new Date().toISOString().slice(0, 13);
    let queued = 0;
    for (const u of rec) {
      if (await queueMessage(db, { channel: 'EMAIL', template: 'REPORT', to: u.email, toUserId: u.id, vars: { reportName: out.title, date: todayIST(), rows: out.count, owner: s.owner },
        attachments: [{ name: out.fileName, contentType: 'text/csv', base64: Buffer.from(out.csv).toString('base64') }], dedupeKey: `report:${s.id}:${stamp}:${u.id}` })) queued++;
    }
    status = queued ? `Sent to ${queued}: ${out.count} rows` : (await getIntegration(db, 'EMAIL')).mode === 'OFF' ? 'E-mail is switched off' : 'No active recipients';
  } catch (e) { status = `Failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`; }
  await db.query(`update sys.report_schedules set last_run_at = now(), last_status = $2, next_run_at = $3 where id = $1`, [s.id, status, nextRun(s)]);
  return status;
}
export async function runDueSchedules(db: Db) {
  const due = (await db.query(`select id from sys.report_schedules where enabled and next_run_at <= now() order by next_run_at limit 50`)).rows;
  for (const d of due) await runSchedule(db, d.id);
  return due.length;
}

// ---------------------------------------------------------------- routes
export function messagingRoutes(db: Db) {
  const r = Router();

  r.get('/messages', requirePermission('sys.message:view'), asyncHandler(async (req, res) => {
    const st = str(req.query.status); const ch = str(req.query.channel);
    const rows = (await db.query(`select m.id, m.channel, m.template, m.to_address as "to", m.subject, left(m.body, 300) as body, m.status, m.attempts, m.last_error as "lastError", m.provider_ref as "providerRef",
        m.mode, m.created_at as "createdAt", m.sent_at as "sentAt", jsonb_array_length(m.attachments) as attachments, coalesce(u.full_name, p.legal_name) as "recipient"
        from sys.messages m left join iam.users u on u.id = m.to_user_id left join mdm.parties p on p.id = m.to_party_id
        where ($1::text is null or m.status = $1) and ($2::text is null or m.channel = $2) order by m.created_at desc limit 300`, [st ?? null, ch ?? null])).rows;
    res.json({ data: rows });
  }));

  r.post('/messages/:id/retry', requirePermission('sys.integration:configure'), asyncHandler(async (req, res) => {
    const n = (await db.query(`update sys.messages set status = 'Queued', attempts = 0 where id = $1 and status in ('Failed','Skipped')`, [req.params.id])).rowCount;
    if (!n) throw Errors.state('Only a failed or skipped message can be sent again.');
    res.json({ ok: true });
  }));

  r.post('/messages/test', requirePermission('sys.integration:configure'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP']), to: z.string().trim().max(120) }).refine((x) => (x.channel === 'EMAIL' ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.to) : /^[6-9][0-9]{9}$/.test(x.to)),
      { message: 'An e-mail address, or a 10-digit mobile number', path: ['to'] }), req.body);
    const ok = await queueMessage(db, { channel: d.channel, template: 'ALERT', to: d.to, vars: { title: 'Test message from Dhruv Agro ERP', body: `Sent by ${req.auth!.user.fullName} to check the ${d.channel.toLowerCase()} settings.`, link: '' },
      dedupeKey: `test:${d.channel}:${d.to}:${Date.now()}` });
    if (!ok) throw Errors.rule('INTEGRATION_OFF', `${d.channel} is switched off.`);
    const out = await sendQueued(db, 5);
    const m = (await db.query(`select status, last_error as "lastError", provider_ref as "providerRef" from sys.messages where to_address = $1 and template = 'ALERT' order by created_at desc limit 1`, [d.to])).rows[0];
    res.json({ ...out, message: m });
  }));

  r.get('/message-templates', requirePermission('sys.integration:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select code, channel, subject, body, provider_template_id as "providerTemplateId", updated_at as "updatedAt" from sys.message_templates order by code, channel`)).rows });
  }));
  r.put('/message-templates/:code/:channel', requirePermission('sys.integration:configure'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ subject: z.string().trim().max(200).nullable().optional(), body: z.string().trim().min(5).max(4000), providerTemplateId: z.string().trim().max(80).nullable().optional() }), req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from sys.message_templates where code = $1 and channel = $2 for update`, [req.params.code, req.params.channel])).rows[0];
      if (!before) throw Errors.notFound('Template');
      const known = new Set([...(before.body as string).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).concat([...String(before.subject ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])));
      for (const m of `${d.subject ?? ''} ${d.body}`.matchAll(/\{\{(\w+)\}\}/g)) if (!known.has(m[1]!)) throw Errors.rule('UNKNOWN_PLACEHOLDER', `{{${m[1]}}} is not available in this message. Available: ${[...known].map((k) => `{{${k}}}`).join(' ')}`);
      if (req.params.channel === 'SMS' && d.body.length > 306) throw Errors.rule('SMS_TOO_LONG', 'An SMS template should stay within two messages (306 characters).');
      await tx.query(`update sys.message_templates set subject = $3, body = $4, provider_template_id = $5, updated_at = now(), updated_by = $6 where code = $1 and channel = $2`,
        [before.code, before.channel, req.params.channel === 'EMAIL' ? d.subject ?? before.subject : null, d.body, d.providerTemplateId ?? null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'sys.message_template.updated', entityType: 'sys.message_template', entityId: `${before.code}/${before.channel}`, before, after: d });
    });
    res.json({ ok: true });
  }));

  // my own channels for alerts (the in-app notification is always kept)
  r.put('/me/channels', asyncHandler(async (req, res) => {
    const d = parse(z.object({ channels: z.array(z.enum(['EMAIL', 'SMS', 'WHATSAPP'])).max(3), mobile: z.string().regex(/^[6-9][0-9]{9}$/, '10-digit mobile number').nullable().optional() }), req.body);
    await withTx(db, async (tx) => {
      const u = (await tx.query(`update iam.users set notify_channels = $2, mobile = coalesce($3, mobile) where id = $1 returning mobile`, [req.auth!.user.id, [...new Set(d.channels)], d.mobile ?? null])).rows[0];
      if (d.channels.some((c) => c !== 'EMAIL') && !u.mobile) throw Errors.rule('MOBILE_REQUIRED', 'Give your mobile number for SMS or WhatsApp.');
      await audit(tx, actorOf(req), { action: 'iam.user.channels', entityType: 'iam.user', entityId: req.auth!.user.id, after: d });
    });
    res.json({ ok: true });
  }));
  r.get('/me/channels', asyncHandler(async (req, res) => {
    const u = (await db.query(`select notify_channels as channels, mobile from iam.users where id = $1`, [req.auth!.user.id])).rows[0];
    const modes = (await db.query(`select code, mode from sys.integrations where code = any($1)`, [CHANNELS])).rows;
    res.json({ ...u, available: modes.filter((m) => m.mode !== 'OFF').map((m) => m.code) });
  }));

  // alert rule channels
  r.put('/alert-rules/:code/channels', requirePermission('sys.alert:configure'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ channels: z.array(z.enum(['EMAIL', 'SMS', 'WHATSAPP'])).max(3) }), req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`update sys.alert_rules set channels = $2, updated_at = now(), updated_by = $3 where code = $1`, [req.params.code, [...new Set(d.channels)], req.auth!.user.id])).rowCount;
      if (!n) throw Errors.notFound('Alert rule');
      await audit(tx, actorOf(req), { action: 'sys.alert_rule.channels', entityType: 'sys.alert_rule', entityId: req.params.code!, after: d });
    });
    res.json({ ok: true });
  }));

  // dealer reminders setting
  r.get('/dealer-reminders', requirePermission('sys.integration:view'), asyncHandler(async (_req, res) => {
    res.json(await getSetting(db, 'dealer.reminders', { enabled: false, daysBefore: 3, overdueEveryDays: 7, channels: ['EMAIL'] }));
  }));
  r.put('/dealer-reminders', requirePermission('sys.integration:configure'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ enabled: z.boolean(), daysBefore: z.number().int().min(0).max(30), overdueEveryDays: z.number().int().min(1).max(60), channels: z.array(z.enum(['EMAIL', 'SMS', 'WHATSAPP'])).min(1).max(3) }), req.body);
    await withTx(db, async (tx) => {
      const before = await getSetting(tx, 'dealer.reminders', null);
      await tx.query(`update sys.settings set value = $2, updated_at = now(), updated_by = $3 where key = $1`, ['dealer.reminders', JSON.stringify(d), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'sys.setting.updated', entityType: 'sys.setting', entityId: 'dealer.reminders', before: { value: before }, after: { value: d } });
    });
    res.json({ ok: true });
  }));

  // scheduled reports
  const M = 'mis.schedule:manage';
  const schedSchema = z.object({ name: z.string().trim().min(3).max(120), reportId: z.string().max(80), params: z.record(z.string().max(100)).default({}),
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']), weekday: z.number().int().min(1).max(7).nullable().default(null), monthDay: z.number().int().min(1).max(28).nullable().default(null),
    hourIst: z.number().int().min(0).max(23).default(8), recipientUserIds: z.array(z.string().uuid()).min(1).max(50), enabled: z.boolean().default(true) })
    .refine((x) => x.frequency !== 'WEEKLY' || x.weekday != null, { message: 'Choose the day of the week', path: ['weekday'] })
    .refine((x) => x.frequency !== 'MONTHLY' || x.monthDay != null, { message: 'Choose the day of the month', path: ['monthDay'] });
  const mine = (req: Request) => (can(req, 'sys.integration:configure') ? null : req.auth!.user.id);
  r.get('/recipients', requirePermission(M), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select id, full_name as "fullName" from iam.users where status = 'Active' order by full_name`)).rows });
  }));
  r.get('/report-schedules', requirePermission(M), asyncHandler(async (req, res) => {
    const rows = (await db.query(`select s.id, s.name, s.report_id as "reportId", s.params, s.frequency, s.weekday, s.month_day as "monthDay", s.hour_ist as "hourIst", s.enabled, s.next_run_at as "nextRunAt",
        s.last_run_at as "lastRunAt", s.last_status as "lastStatus", s.recipient_user_ids as "recipientUserIds", u.full_name as "owner",
        (select array_agg(x.full_name order by x.full_name) from iam.users x where x.id = any(s.recipient_user_ids)) as recipients
        from sys.report_schedules s join iam.users u on u.id = s.run_as where ($1::uuid is null or s.run_as = $1) order by s.name`, [mine(req)])).rows;
    res.json({ data: rows, emailMode: (await getIntegration(db, 'EMAIL')).mode });
  }));
  const check = async (req: Request, d: z.infer<typeof schedSchema>) => {
    await reportCsv(db, req, d.reportId).catch((e) => { throw e instanceof Error && 'status' in e && (e as { status: number }).status === 404 ? Errors.rule('UNKNOWN_REPORT', 'You cannot run that report.') : e; });
    const n = Number((await db.query(`select count(*) from iam.users where id = any($1::uuid[]) and status = 'Active'`, [d.recipientUserIds])).rows[0].count);
    if (n !== new Set(d.recipientUserIds).size) throw Errors.rule('UNKNOWN_RECIPIENT', 'Every recipient must be an active user.');
  };
  r.post('/report-schedules', requirePermission(M), asyncHandler(async (req, res) => {
    const d = parse(schedSchema, req.body);
    await check({ ...req, query: d.params } as Request, d);
    const id = await withTx(db, async (tx) => {
      const next = nextRun({ frequency: d.frequency, weekday: d.weekday, month_day: d.monthDay, hour_ist: d.hourIst });
      const x = (await tx.query(`insert into sys.report_schedules (name, report_id, params, frequency, weekday, month_day, hour_ist, run_as, recipient_user_ids, enabled, next_run_at, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8) returning id`, [d.name, d.reportId, JSON.stringify(d.params), d.frequency, d.weekday, d.monthDay, d.hourIst, req.auth!.user.id, d.recipientUserIds, d.enabled, next])).rows[0].id as string;
      await audit(tx, actorOf(req), { action: 'mis.schedule.created', entityType: 'sys.report_schedule', entityId: x, after: d });
      return x;
    });
    res.status(201).json({ id });
  }));
  r.put('/report-schedules/:id', requirePermission(M), asyncHandler(async (req, res) => {
    const d = parse(schedSchema, req.body);
    const own = (await db.query(`select run_as from sys.report_schedules where id = $1`, [req.params.id])).rows[0];
    if (!own || (mine(req) && own.run_as !== mine(req))) throw Errors.notFound('Schedule');
    await check({ ...req, query: d.params } as Request, d);
    await withTx(db, async (tx) => {
      await tx.query(`update sys.report_schedules set name=$2, report_id=$3, params=$4, frequency=$5, weekday=$6, month_day=$7, hour_ist=$8, recipient_user_ids=$9, enabled=$10, next_run_at=$11, updated_at=now() where id=$1`,
        [req.params.id, d.name, d.reportId, JSON.stringify(d.params), d.frequency, d.weekday, d.monthDay, d.hourIst, d.recipientUserIds, d.enabled, nextRun({ frequency: d.frequency, weekday: d.weekday, month_day: d.monthDay, hour_ist: d.hourIst })]);
      await audit(tx, actorOf(req), { action: 'mis.schedule.updated', entityType: 'sys.report_schedule', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));
  r.delete('/report-schedules/:id', requirePermission(M), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const n = (await tx.query(`delete from sys.report_schedules where id = $1 and ($2::uuid is null or run_as = $2)`, [req.params.id, mine(req)])).rowCount;
      if (!n) throw Errors.notFound('Schedule');
      await audit(tx, actorOf(req), { action: 'mis.schedule.deleted', entityType: 'sys.report_schedule', entityId: req.params.id! });
    });
    res.json({ ok: true });
  }));
  r.post('/report-schedules/:id/run', requirePermission(M), asyncHandler(async (req, res) => {
    const own = (await db.query(`select run_as from sys.report_schedules where id = $1`, [req.params.id])).rows[0];
    if (!own || (mine(req) && own.run_as !== mine(req))) throw Errors.notFound('Schedule');
    res.json({ status: await runSchedule(db, req.params.id!) });
  }));
  return r;
}
