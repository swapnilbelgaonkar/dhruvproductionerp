import { Router } from 'express';
import { z } from 'zod';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf } from '../../middleware/context';

/**
 * Integration modes (MP §21). OFF / MANUAL / SIMULATED / LIVE as set by the administrator; see migration 0030.
 * LIVE needs an adapter in code. Messages have SMTP and HTTPS-webhook adapters; the GST integrations wait for the GSP chosen under D27,
 * and bank host-to-host waits for the bank's interface — until then they run MANUAL (file out, reply in).
 */
export type Mode = 'OFF' | 'MANUAL' | 'SIMULATED' | 'LIVE';
export interface Integration { code: string; name: string; mode: Mode; provider: string | null; config: Record<string, unknown> }

export const LIVE_ADAPTERS: Record<string, { providers: string[]; config: string[]; note: string } | undefined> = {
  EMAIL: { providers: ['SMTP'], config: ['host', 'port', 'secure', 'from', 'userEnv', 'passwordEnv'], note: 'Any SMTP server (Office 365, Google Workspace, SES, a hosted relay). The password is read from the environment variable named in passwordEnv.' },
  SMS: { providers: ['WEBHOOK'], config: ['url', 'tokenEnv', 'senderId'], note: 'An HTTPS SMS gateway: the ERP posts {to, text, templateId, senderId} as JSON with the token from tokenEnv as a Bearer header.' },
  WHATSAPP: { providers: ['WEBHOOK'], config: ['url', 'tokenEnv'], note: 'A WhatsApp Business provider: the ERP posts {to, template, variables, text} as JSON with the token from tokenEnv as a Bearer header.' },
  EINVOICE: undefined, EWAYBILL: undefined, GST_RETURNS: undefined, BANK_PAYMENTS: undefined,
};

export async function getIntegration(dbx: Db | Tx, code: string): Promise<Integration> {
  const x = (await dbx.query(`select code, name, mode, provider, config from sys.integrations where code = $1`, [code])).rows[0];
  if (!x) throw Errors.notFound('Integration');
  return x as Integration;
}

/** Refuses when the integration is off, naming it, so the person knows what to switch on. */
export async function requireOn(dbx: Db | Tx, code: string): Promise<Integration> {
  const i = await getIntegration(dbx, code);
  if (i.mode === 'OFF') throw Errors.rule('INTEGRATION_OFF', `${i.name} is switched off. An administrator can switch it on in Administration → Integrations.`);
  if (i.mode === 'LIVE' && !LIVE_ADAPTERS[code]) throw Errors.rule('NO_LIVE_ADAPTER', `${i.name} has no live connection yet; use the manual mode.`);
  return i;
}

export async function logCall(tx: Db | Tx, e: { integration: string; operation: string; mode: string; subjectType?: string; subjectId?: string; ok: boolean; request?: unknown; response?: unknown; error?: string; userId?: string | null }) {
  await tx.query(`insert into sys.integration_log (integration, operation, mode, subject_type, subject_id, ok, request, response, error, by_user) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.integration, e.operation, e.mode, e.subjectType ?? null, e.subjectId ?? null, e.ok, e.request === undefined ? null : JSON.stringify(e.request),
      e.response === undefined ? null : JSON.stringify(e.response), e.error ?? null, e.userId ?? null]);
}

export function integrationRoutes(db: Db) {
  const r = Router();
  const CONF = 'sys.integration:configure';

  r.get('/', requirePermission('sys.integration:view'), asyncHandler(async (_req, res) => {
    const rows = (await db.query(`select i.code, i.name, i.area, i.description, i.modes, i.mode, i.provider, i.config, i.updated_at as "updatedAt",
        (select count(*)::int from sys.integration_log l where l.integration = i.code and l.at > now() - interval '30 days') as "calls30d",
        (select count(*)::int from sys.integration_log l where l.integration = i.code and not l.ok and l.at > now() - interval '30 days') as "failures30d",
        (select count(*)::int from sys.messages m where m.channel = i.code and m.status = 'Queued') as "queued"
        from sys.integrations i order by i.area, i.name`)).rows;
    res.json({ data: rows.map((x) => ({ ...x, live: LIVE_ADAPTERS[x.code] ?? null })) });
  }));

  r.get('/log', requirePermission('sys.integration:view'), asyncHandler(async (req, res) => {
    const code = typeof req.query.integration === 'string' ? req.query.integration : null;
    const rows = (await db.query(`select l.id, l.integration, l.operation, l.mode, l.subject_type as "subjectType", l.subject_id as "subjectId", l.ok, l.error, l.at, u.full_name as "byUser"
        from sys.integration_log l left join iam.users u on u.id = l.by_user where ($1::text is null or l.integration = $1) order by l.at desc limit 200`, [code])).rows;
    res.json({ data: rows });
  }));

  r.put('/:code', requirePermission(CONF), asyncHandler(async (req, res) => {
    const d = parse(z.object({ mode: z.enum(['OFF', 'MANUAL', 'SIMULATED', 'LIVE']), provider: z.string().trim().max(40).optional().nullable(),
      config: z.record(z.union([z.string().max(300), z.number(), z.boolean()])).default({}) }), req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from sys.integrations where code = $1 for update`, [req.params.code])).rows[0];
      if (!before) throw Errors.notFound('Integration');
      if (!before.modes.includes(d.mode)) throw Errors.rule('MODE_NOT_SUPPORTED', `${before.name} cannot run ${d.mode.toLowerCase()}.`);
      const live = LIVE_ADAPTERS[before.code];
      if (d.mode === 'LIVE') {
        if (!live) throw Errors.rule('NO_LIVE_ADAPTER', `${before.name} has no live connection yet${before.area === 'GST' ? ' — it needs the GST service provider chosen under D27' : ''}. Use the manual mode meanwhile.`);
        if (!d.provider || !live.providers.includes(d.provider)) throw Errors.rule('PROVIDER_REQUIRED', `Choose the provider: ${live.providers.join(', ')}.`);
        for (const k of Object.keys(d.config)) if (!live.config.includes(k)) throw Errors.rule('UNKNOWN_SETTING', `${before.name} has no setting ${k}.`);
        // secrets stay in the environment: the config may only name the variable
        for (const [k, v] of Object.entries(d.config)) if (/password|token|secret|key/i.test(k) && !/Env$/.test(k)) throw Errors.rule('SECRET_IN_CONFIG', `Put ${k} in an environment variable and give its name instead.`, { key: k, value: typeof v });
      }
      await tx.query(`update sys.integrations set mode = $2, provider = $3, config = $4, updated_at = now(), updated_by = $5 where code = $1`,
        [before.code, d.mode, d.mode === 'LIVE' ? d.provider : null, JSON.stringify(d.mode === 'LIVE' ? d.config : before.config), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'sys.integration.configured', entityType: 'sys.integration', entityId: before.code, before: { mode: before.mode, provider: before.provider }, after: { mode: d.mode, provider: d.provider } });
    });
    res.json({ ok: true });
  }));
  return r;
}
