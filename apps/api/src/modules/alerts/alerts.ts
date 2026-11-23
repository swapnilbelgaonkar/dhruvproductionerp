import { Router } from 'express';
import { z } from 'zod';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { todayIST } from '../sales/quotations';

/**
 * Alerts and escalations (NOT-001…NOT-006, WF-008). Each rule turns a business condition into one open alert per subject.
 *  - raised: the subject's owner (approver, CAPA owner, dealer's sales owner…) and the rule's recipient roles are notified in-app;
 *  - worsened (e.g. due → overdue): severity rises to critical and everyone notified is told again;
 *  - not acknowledged within the rule's hours: escalated to the escalation roles and, where set, the owners' reporting managers;
 *  - condition gone (paid, calibrated, approved, delivered…): the alert resolves itself.
 * Rules, thresholds and routing are configured by the administrator; the scan runs hourly in the worker and on demand.
 */
interface Rule { code: string; name: string; params: Record<string, number>; recipient_roles: string[]; escalate_after_hours: number | null; escalate_roles: string[]; escalate_to_manager: boolean; enabled: boolean }
interface Candidate { key: string; subjectType: string; subjectId: string | null; ref: string; severity: 'warning' | 'critical'; title: string; body: string; link: string; owners: string[] }
type Finder = (tx: Tx, r: Rule) => Promise<Candidate[]>;

const days = (n: unknown) => Math.round(Number(n));
const ids = (a: unknown) => ((a as string[] | null) ?? []).filter(Boolean);

const FINDERS: Record<string, Finder> = {
  APPROVAL_OVERDUE: async (tx) => (await tx.query(`select s.id, s.label, s.approver_ids, r.id as request_id, r.doc_no, r.subject_label, floor(extract(epoch from now() - s.due_at) / 3600)::int as hours_late
      from wf.approval_steps s join wf.approval_requests r on r.id = s.request_id where s.status = 'Pending' and s.step_kind = 'approve' and s.due_at < now()`)).rows
    .map((x) => ({ key: x.id, subjectType: 'wf.approval', subjectId: x.request_id, ref: x.doc_no, severity: x.hours_late >= 24 ? 'critical' : 'warning',
      title: `Approval overdue — ${x.doc_no}`, body: `${x.subject_label}: “${x.label}” is ${x.hours_late} h past its SLA`, link: `/approvals/${x.request_id}`, owners: ids(x.approver_ids) })),

  CALIBRATION_DUE: async (tx, r) => (await tx.query(`select id, code, name, calibration_due, calibration_due - $1::date as d from qc.instruments
      where status = 'Active' and calibration_due is not null and calibration_due <= $1::date + $2::int`, [todayIST(), days(r.params.daysBefore ?? 7)])).rows
    .map((x) => ({ key: x.id, subjectType: 'qc.instrument', subjectId: x.id, ref: x.code, severity: x.d < 0 ? 'critical' : 'warning',
      title: x.d < 0 ? `Calibration overdue — ${x.code}` : `Calibration due in ${x.d} day${x.d === 1 ? '' : 's'} — ${x.code}`,
      body: `${x.name}${x.d < 0 ? ': locked for QC results until calibrated' : ''}`, link: '/qc/master', owners: [] })),

  LOT_EXPIRY: async (tx, r) => (await tx.query(`select lt.id, lt.lot_no, i.code, lt.expiry_date, lt.expiry_date - $1::date as d, sum(sl.qty) as qty, i.base_uom
      from inv.lots lt join inv.stock_ledger sl on sl.lot_id = lt.id join mdm.items i on i.id = lt.item_id
      where lt.expiry_date is not null and lt.expiry_date <= $1::date + $2::int group by lt.id, i.code, i.base_uom having sum(sl.qty) > 0`, [todayIST(), days(r.params.daysBefore ?? 30)])).rows
    .map((x) => ({ key: x.id, subjectType: 'inv.lot', subjectId: x.id, ref: x.lot_no, severity: x.d < 0 ? 'critical' : 'warning',
      title: x.d < 0 ? `Expired stock — lot ${x.lot_no}` : `Lot ${x.lot_no} expires in ${x.d} day${x.d === 1 ? '' : 's'}`,
      body: `${x.code}: ${Number(x.qty)} ${x.base_uom} in stock`, link: `/stores/lots/${x.id}`, owners: [] })),

  QUARANTINE_HOLD: async (tx, r) => (await tx.query(`select lt.id, lt.lot_no, i.code, floor(extract(epoch from now() - min(sl.posted_at)) / 3600)::int as hours
      from inv.stock_ledger sl join inv.lots lt on lt.id = sl.lot_id join mdm.items i on i.id = sl.item_id where sl.bucket = 'QUARANTINE'
      group by lt.id, i.code having sum(sl.qty) > 0 and extract(epoch from now() - min(sl.posted_at)) / 3600 > $1`, [days(r.params.hours ?? 48)])).rows
    .map((x) => ({ key: x.id, subjectType: 'inv.lot', subjectId: x.id, ref: x.lot_no, severity: 'critical' as const, title: `Lot ${x.lot_no} held ${x.hours} h in quarantine`,
      body: `${x.code} is waiting for a QC or QA decision`, link: `/stores/lots/${x.id}`, owners: [] })),

  RECEIVABLE_DUE: async (tx, r) => (await tx.query(`select i.id, i.doc_no, i.due_date, i.due_date - $1::date as d, i.grand_total - i.amount_settled as o, p.legal_name, u.id as owner
      from sales.invoices i join mdm.parties p on p.id = i.party_id left join mdm.dealer_profiles dp on dp.party_id = i.party_id
      left join iam.users u on u.employee_id = dp.sales_owner_id and u.status = 'Active'
      where i.status = 'Posted' and i.grand_total - i.amount_settled > 0.004 and i.due_date <= $1::date + $2::int`, [todayIST(), days(r.params.daysBefore ?? 3)])).rows
    .map((x) => ({ key: x.id, subjectType: 'sales.invoice', subjectId: x.id, ref: x.doc_no, severity: x.d < 0 ? 'critical' : 'warning',
      title: x.d < 0 ? `Payment overdue ${-x.d} day${x.d === -1 ? '' : 's'} — ${x.doc_no}` : `Payment due ${x.d === 0 ? 'today' : `in ${x.d} day${x.d === 1 ? '' : 's'}`} — ${x.doc_no}`,
      body: `${x.legal_name}: ₹${Number(x.o).toLocaleString('en-IN')} outstanding`, link: `/finance/invoices/${x.id}`, owners: ids([x.owner]) })),

  DEALER_FROZEN: async (tx) => {
    if ((await getSetting(tx, 'sales.credit.overdueFreeze', true)) !== true) return [];
    const grace = Number(await getSetting(tx, 'sales.credit.overdueGraceDays', 0));
    return (await tx.query(`select p.id, p.code, p.legal_name, count(*)::int as n, sum(i.grand_total - i.amount_settled) as o, max($1::date - i.due_date) as worst, u.id as owner
        from sales.invoices i join mdm.parties p on p.id = i.party_id left join mdm.dealer_profiles dp on dp.party_id = p.id left join iam.users u on u.employee_id = dp.sales_owner_id and u.status = 'Active'
        where i.status = 'Posted' and i.grand_total - i.amount_settled > 0.004 and $1::date - i.due_date > $2 group by p.id, u.id`, [todayIST(), grace])).rows
      .map((x) => ({ key: x.id, subjectType: 'mdm.party', subjectId: x.id, ref: x.code, severity: 'critical' as const, title: `Orders frozen — ${x.legal_name}`,
        body: `${x.n} invoice${x.n === 1 ? '' : 's'} overdue up to ${x.worst} days, ₹${Number(x.o).toLocaleString('en-IN')}`, link: `/finance/statements/${x.id}`, owners: ids([x.owner]) }));
  },

  PAYABLE_DUE: async (tx, r) => {
    const args = [todayIST(), days(r.params.daysBefore ?? 3)];
    const si = (await tx.query(`select si.id, si.doc_no, si.invoice_no, si.due_date - $1::date as d, si.grand_total - si.amount_settled as o, p.legal_name from purchase.supplier_invoices si
        join mdm.parties p on p.id = si.party_id where si.status in ('Matched','Approved') and si.grand_total - si.amount_settled > 0.004 and si.due_date <= $1::date + $2::int`, args)).rows
      .map((x) => ({ ...x, kind: 'purchase.supplier_invoice', link: `/purchase/invoices/${x.id}` }));
    const fb = (await tx.query(`select fb.id, fb.doc_no, fb.bill_no as invoice_no, fb.due_date - $1::date as d, fb.grand_total - fb.amount_settled as o, t.name as legal_name from logistics.freight_bills fb
        join logistics.transporters t on t.id = fb.transporter_id where fb.status = 'Approved' and fb.grand_total - fb.amount_settled > 0.004 and fb.due_date <= $1::date + $2::int`, args)).rows
      .map((x) => ({ ...x, kind: 'logistics.freight_bill', link: `/logistics/freight-bills/${x.id}` }));
    return [...si, ...fb].map((x) => ({ key: x.id, subjectType: x.kind, subjectId: x.id, ref: x.doc_no, severity: x.d < 0 ? 'critical' : 'warning',
      title: x.d < 0 ? `Bill overdue ${-x.d} day${x.d === -1 ? '' : 's'} — ${x.doc_no}` : `Bill due ${x.d === 0 ? 'today' : `in ${x.d} day${x.d === 1 ? '' : 's'}`} — ${x.doc_no}`,
      body: `${x.legal_name} bill ${x.invoice_no}: ₹${Number(x.o).toLocaleString('en-IN')} to pay`, link: x.link, owners: [] }));
  },

  PO_DELIVERY_LATE: async (tx, r) => (await tx.query(`select po.id, po.doc_no, p.legal_name, count(*)::int as lines, max($1::date - coalesce(l.delivery_date, po.delivery_date)) as late, u.id as owner
      from purchase.purchase_orders po join purchase.purchase_order_lines l on l.purchase_order_id = po.id join mdm.parties p on p.id = po.party_id
      left join iam.users u on u.id = po.created_by and u.status = 'Active'
      where po.status in ('Issued','Acknowledged','PartiallyReceived') and l.received_qty < l.qty and coalesce(l.delivery_date, po.delivery_date) < $1::date - $2::int
      group by po.id, p.legal_name, u.id`, [todayIST(), days(r.params.graceDays ?? 0)])).rows
    .map((x) => ({ key: x.id, subjectType: 'purchase.order', subjectId: x.id, ref: x.doc_no, severity: x.late > 7 ? 'critical' : 'warning',
      title: `Delivery ${x.late} day${x.late === 1 ? '' : 's'} late — ${x.doc_no}`, body: `${x.legal_name}: ${x.lines} line${x.lines === 1 ? '' : 's'} still to receive`, link: `/purchase/orders/${x.id}`, owners: ids([x.owner]) })),

  CAPA_OVERDUE: async (tx) => (await tx.query(`select id, doc_no, title, owner_id, $1::date - due_date as late from qa.capas where status in ('Open','EffectivenessCheck') and due_date < $1::date`, [todayIST()])).rows
    .map((x) => ({ key: x.id, subjectType: 'qa.capa', subjectId: x.id, ref: x.doc_no, severity: x.late > 14 ? 'critical' : 'warning',
      title: `CAPA overdue ${x.late} day${x.late === 1 ? '' : 's'} — ${x.doc_no}`, body: x.title, link: `/qa/capas/${x.id}`, owners: ids([x.owner_id]) })),

  POD_PENDING: async (tx, r) => (await tx.query(`select s.id, s.doc_no, p.legal_name, t.name as transporter, floor(extract(epoch from now() - s.dispatched_at) / 86400)::int as d
      from logistics.shipments s join mdm.parties p on p.id = s.party_id left join logistics.transporters t on t.id = s.transporter_id
      where s.status = 'Dispatched' and s.dispatched_at < now() - make_interval(days => $1)`, [days(r.params.days ?? 7)])).rows
    .map((x) => ({ key: x.id, subjectType: 'logistics.shipment', subjectId: x.id, ref: x.doc_no, severity: x.d > 14 ? 'critical' : 'warning',
      title: `No POD ${x.d} days after dispatch — ${x.doc_no}`, body: `${x.legal_name}${x.transporter ? ` via ${x.transporter}` : ''}`, link: `/logistics/shipments/${x.id}`, owners: [] })),
};
export const ALERT_RULES = Object.keys(FINDERS);

async function usersWithRoles(tx: Tx, roles: string[]) {
  if (!roles.length) return [];
  return (await tx.query(`select distinct u.id from iam.user_roles ur join iam.roles r on r.id = ur.role_id join iam.users u on u.id = ur.user_id
      where r.code = any($1) and ur.status = 'Active' and u.status = 'Active'`, [roles])).rows.map((x) => x.id as string);
}
async function managersOf(tx: Tx, userIds: string[]) {
  if (!userIds.length) return [];
  return (await tx.query(`select distinct mu.id from iam.users u join org.employees e on e.id = u.employee_id join iam.users mu on mu.employee_id = e.manager_id and mu.status = 'Active'
      where u.id = any($1)`, [userIds])).rows.map((x) => x.id as string);
}
async function notify(tx: Tx, users: string[], a: { id: string; title: string; body: string; link: string | null }, suffix: string, prefix = '') {
  for (const u of new Set(users)) {
    await tx.query(`insert into sys.notifications (user_id, kind, title, body, link, dedupe_key) values ($1,'warning',$2,$3,$4,$5) on conflict (user_id, dedupe_key) do nothing`,
      [u, `${prefix}${a.title}`, a.body, a.link, `alert:${a.id}:${suffix}`]);
  }
}

export interface ScanResult { raised: number; worsened: number; resolved: number; escalated: number; failed: { rule: string; error: string }[] }

/** Evaluates every enabled rule; each rule in its own transaction so one failure does not stop the others. */
export async function scanAlerts(db: Db): Promise<ScanResult> {
  const out: ScanResult = { raised: 0, worsened: 0, resolved: 0, escalated: 0, failed: [] };
  const rules = (await db.query(`select code, name, params, recipient_roles, escalate_after_hours, escalate_roles, escalate_to_manager, enabled from sys.alert_rules order by code`)).rows as Rule[];
  for (const rule of rules) {
    const find = FINDERS[rule.code];
    if (!find) continue;
    try {
      await withTx(db, async (tx) => {
        const found = rule.enabled ? await find(tx, rule) : [];
        const open = (await tx.query(`select id, subject_key, severity, notified_user_ids from sys.alerts where rule_code = $1 and resolved_at is null for update`, [rule.code])).rows;
        const roleUsers = await usersWithRoles(tx, rule.recipient_roles);
        for (const c of found) {
          const ex = open.find((o) => o.subject_key === c.key);
          if (!ex) {
            const users = [...new Set([...c.owners, ...roleUsers])];
            const a = (await tx.query(`insert into sys.alerts (rule_code, subject_key, subject_type, subject_id, subject_ref, severity, title, body, link, notified_user_ids)
                values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`, [rule.code, c.key, c.subjectType, c.subjectId, c.ref, c.severity, c.title, c.body, c.link, users])).rows[0];
            await notify(tx, users, { id: a.id, title: c.title, body: c.body, link: c.link }, 'raised');
            out.raised++;
          } else if (ex.severity === 'warning' && c.severity === 'critical') {
            const users = [...new Set([...ids(ex.notified_user_ids), ...c.owners, ...roleUsers])];
            await tx.query(`update sys.alerts set severity = 'critical', title = $2, body = $3, last_seen_at = now(), notified_user_ids = $4 where id = $1`, [ex.id, c.title, c.body, users]);
            await notify(tx, users, { id: ex.id, title: c.title, body: c.body, link: c.link }, 'critical');
            out.worsened++;
          } else {
            await tx.query(`update sys.alerts set title = $2, body = $3, last_seen_at = now() where id = $1`, [ex.id, c.title, c.body]);
          }
        }
        const gone = open.filter((o) => !found.some((c) => c.key === o.subject_key)).map((o) => o.id);
        if (gone.length) out.resolved += (await tx.query(`update sys.alerts set resolved_at = now() where id = any($1)`, [gone])).rowCount ?? 0;

        if (rule.escalate_after_hours) {
          const due = (await tx.query(`select id, title, body, link, notified_user_ids from sys.alerts where rule_code = $1 and resolved_at is null and acknowledged_at is null
              and escalated_at is null and raised_at < now() - make_interval(hours => $2)`, [rule.code, rule.escalate_after_hours])).rows;
          if (due.length) {
            const escRole = await usersWithRoles(tx, rule.escalate_roles);
            for (const a of due) {
              const mgrs = rule.escalate_to_manager ? await managersOf(tx, ids(a.notified_user_ids)) : [];
              const users = [...new Set([...mgrs, ...escRole])];
              if (!users.length) continue;
              await tx.query(`update sys.alerts set escalated_at = now(), escalated_user_ids = $2 where id = $1`, [a.id, users]);
              await notify(tx, users, a, 'escalated', 'Escalated: ');
              out.escalated++;
            }
          }
        }
      });
    } catch (e) {
      out.failed.push({ rule: rule.code, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

const alertSel = `select a.id, a.rule_code as "ruleCode", r.name as "ruleName", r.area, a.subject_type as "subjectType", a.subject_ref as "subjectRef", a.severity, a.title, a.body, a.link,
    a.raised_at as "raisedAt", a.last_seen_at as "lastSeenAt", a.escalated_at as "escalatedAt", a.acknowledged_at as "acknowledgedAt", au.full_name as "acknowledgedBy", a.ack_note as "ackNote",
    a.resolved_at as "resolvedAt", cardinality(a.notified_user_ids) as recipients
  from sys.alerts a join sys.alert_rules r on r.code = a.rule_code left join iam.users au on au.id = a.acknowledged_by`;

export function alertRoutes(db: Db) {
  const r = Router();
  const ruleSchema = z.object({ enabled: z.boolean(), params: z.record(z.number().int().min(0).max(3650)), recipientRoles: z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(20),
    escalateAfterHours: z.number().int().min(1).max(2160).nullable(), escalateRoles: z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(20), escalateToManager: z.boolean() });

  // my alerts (or all for the administrator), open by default
  r.get('/', asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where: string[] = [];
    const all = can(req, 'sys.alert:view_all') && req.query.scope === 'all';
    if (!all) { args.push(req.auth!.user.id); where.push(`($${args.length} = any(a.notified_user_ids) or $${args.length} = any(a.escalated_user_ids))`); }
    const status = str(req.query.status) ?? 'open';
    if (status === 'open') where.push('a.resolved_at is null');
    if (status === 'resolved') where.push('a.resolved_at is not null');
    const area = str(req.query.area);
    if (area) { args.push(area); where.push(`r.area = $${args.length}`); }
    const rows = (await db.query(`${alertSel} ${where.length ? `where ${where.join(' and ')}` : ''}
        order by (a.resolved_at is null) desc, (a.severity = 'critical') desc, a.raised_at desc limit 500`, args)).rows;
    res.json({ data: rows, total: rows.length, canViewAll: can(req, 'sys.alert:view_all'), canConfigure: can(req, 'sys.alert:configure') });
  }));

  r.post('/:id/acknowledge', asyncHandler(async (req, res) => {
    const { note } = parse(z.object({ note: z.string().trim().max(500).optional().nullable() }), req.body);
    await withTx(db, async (tx) => {
      const a = (await tx.query(`select id, notified_user_ids, escalated_user_ids, acknowledged_at, resolved_at from sys.alerts where id = $1 for update`, [req.params.id])).rows[0];
      const mine = a && ([...ids(a.notified_user_ids), ...ids(a.escalated_user_ids)].includes(req.auth!.user.id) || can(req, 'sys.alert:view_all'));
      if (!mine) throw Errors.notFound('Alert');
      if (a.resolved_at) throw Errors.state('This alert is already resolved.');
      if (a.acknowledged_at) throw Errors.state('This alert is already acknowledged.');
      await tx.query(`update sys.alerts set acknowledged_at = now(), acknowledged_by = $2, ack_note = $3 where id = $1`, [a.id, req.auth!.user.id, note ?? null]);
      await audit(tx, actorOf(req), { action: 'sys.alert.acknowledged', entityType: 'sys.alert', entityId: a.id, after: { note } });
    });
    res.json({ ok: true });
  }));

  r.get('/rules', requirePermission('sys.alert:configure'), asyncHandler(async (_req, res) => {
    const rows = (await db.query(`select r.code, r.name, r.description, r.area, r.enabled, r.params, r.recipient_roles as "recipientRoles", r.escalate_after_hours as "escalateAfterHours",
        r.escalate_roles as "escalateRoles", r.escalate_to_manager as "escalateToManager", r.updated_at as "updatedAt",
        (select count(*)::int from sys.alerts a where a.rule_code = r.code and a.resolved_at is null) as "openAlerts" from sys.alert_rules r order by r.area, r.name`)).rows;
    const roles = (await db.query(`select code, name from iam.roles order by name`)).rows;
    res.json({ data: rows, roles });
  }));

  r.put('/rules/:code', requirePermission('sys.alert:configure'), asyncHandler(async (req, res) => {
    const d = parse(ruleSchema, req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from sys.alert_rules where code = $1 for update`, [req.params.code])).rows[0];
      if (!before) throw Errors.notFound('Alert rule');
      const known = new Set((await tx.query(`select code from iam.roles`)).rows.map((x) => x.code));
      for (const role of [...d.recipientRoles, ...d.escalateRoles]) if (!known.has(role)) throw Errors.rule('UNKNOWN_ROLE', `No role ${role}.`);
      for (const k of Object.keys(d.params)) if (!(k in (before.params ?? {}))) throw Errors.rule('UNKNOWN_PARAMETER', `${req.params.code} has no setting ${k}.`);
      await tx.query(`update sys.alert_rules set enabled = $2, params = $3, recipient_roles = $4, escalate_after_hours = $5, escalate_roles = $6, escalate_to_manager = $7, updated_at = now(), updated_by = $8 where code = $1`,
        [req.params.code, d.enabled, JSON.stringify({ ...before.params, ...d.params }), d.recipientRoles, d.escalateAfterHours, d.escalateRoles, d.escalateToManager, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'sys.alert_rule.updated', entityType: 'sys.alert_rule', entityId: req.params.code!, before, after: d });
    });
    res.json({ ok: true });
  }));

  r.post('/run', requirePermission('sys.alert:configure'), asyncHandler(async (_req, res) => { res.json(await scanAlerts(db)); }));
  return r;
}
