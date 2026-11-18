import { Router, type Request } from 'express';
import type { ZodObject, ZodRawShape } from 'zod';
import { reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, diff, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, inLegalEntityScope, legalEntityScope } from '../../middleware/context';
import { registerSubjectHandler, submitForApproval, type ApprovalRequestRow } from '../workflow/engine';

/**
 * Generic maker-checker lifecycle for organisation masters (MDM-002):
 *   Draft --submit--> Submitted --approve--> Active --deactivate--> Inactive --reactivate--> Submitted
 *   Submitted --reject--> Rejected (editable) | --return/cancel--> Draft
 * Status only changes inside this module and the workflow engine (DB trigger enforces it).
 */
export interface LifecycleConfig {
  resource: string;              // e.g. org.plant (permission prefix and approval subject type)
  table: string;                 // e.g. org.plants
  label: string;                 // human label, e.g. Plant
  schema: ZodObject<ZodRawShape>;
  /** camelCase input field -> column */
  columns: Record<string, string>;
  /** select list (aliased to camelCase) and from-clause for reads; the main table must be aliased `t` */
  select: string;
  from: string;
  /** column holding the legal entity for data scoping */
  scopeColumn: 'id' | 'legal_entity_id';
  validateSubmit?: (tx: Tx, row: Record<string, unknown>) => Promise<void>;
  validateWrite?: (tx: Tx, data: Record<string, unknown>, id: string | null) => Promise<void>;
  /** block deactivation while dependent records are still active */
  validateDeactivate?: (tx: Tx, row: Record<string, unknown>) => Promise<void>;
}

const perm = (c: LifecycleConfig, action: string) => `${c.resource}:${action}`;

function allowedActions(req: Request, c: LifecycleConfig, status: string): string[] {
  const out: string[] = [];
  if (['Draft', 'Rejected'].includes(status)) {
    if (can(req, perm(c, 'edit_draft'))) out.push('edit');
    if (can(req, perm(c, 'submit'))) out.push('submit');
  }
  if (status === 'Active' && can(req, perm(c, 'deactivate'))) out.push('deactivate');
  if (status === 'Inactive' && can(req, perm(c, 'submit'))) out.push('reactivate');
  return out;
}

async function setStatus(tx: Tx, c: LifecycleConfig, id: string, status: string, actor: Actor, reason?: string) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from ${c.table} where id = $1`, [id])).rows[0];
  await tx.query(`update ${c.table} set status = $2, updated_by = $3 where id = $1`, [id, status, actor.userId]);
  await audit(tx, actor, { action: `${c.resource}.status`, entityType: c.resource, entityId: id, before, after: { status }, reason: reason ?? null });
  await emit(tx, c.resource, id, `${c.resource}.${status.toLowerCase()}`);
}

export function lifecycleRoutes(db: Db, c: LifecycleConfig) {
  registerSubjectHandler(c.resource, {
    onApproved: (tx, r: ApprovalRequestRow, a) => setStatus(tx, c, r.subject_id, 'Active', a),
    onRejected: (tx, r, a) => setStatus(tx, c, r.subject_id, 'Rejected', a),
    onReturned: (tx, r, a) => setStatus(tx, c, r.subject_id, 'Draft', a),
    onCancelled: (tx, r, a) => setStatus(tx, c, r.subject_id, 'Draft', a),
  });

  const r = Router();
  const scopeCol = `t.${c.scopeColumn}`;

  r.get('/', requirePermission(perm(c, 'view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where: string[] = [];
    const scope = legalEntityScope(req, perm(c, 'view'));
    if (scope) { args.push(scope); where.push(`${scopeCol} = any($${args.length}::uuid[])`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`t.status = $${args.length}`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(t.code ilike $${args.length} or t.name ilike $${args.length})`); }
    const le = str(req.query.legalEntityId);
    if (le && c.scopeColumn === 'legal_entity_id') { args.push(le); where.push(`t.legal_entity_id = $${args.length}`); }
    const plant = str(req.query.plantId);
    if (plant && c.columns.plantId) { args.push(plant); where.push(`t.plant_id = $${args.length}`); }
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const rows = await db.query(`select ${c.select}, count(*) over() as total ${c.from} ${w} order by t.code limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/:id', requirePermission(perm(c, 'view')), asyncHandler(async (req, res) => {
    const row = (await db.query(`select ${c.select}, ${scopeCol} as "scopeLegalEntityId" ${c.from} where t.id = $1`, [req.params.id])).rows[0];
    if (!row || !inLegalEntityScope(req, perm(c, 'view'), row.scopeLegalEntityId)) throw Errors.notFound(c.label);
    const approvals = (await db.query(
      `select a.id, a.doc_no, a.status, a.submitted_at, a.completed_at, u.full_name as initiator
         from wf.approval_requests a join iam.users u on u.id = a.initiated_by
        where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc`, [c.resource, row.id])).rows;
    const { scopeLegalEntityId: _s, ...data } = row;
    res.json({ ...data, approvals, allowedActions: allowedActions(req, c, row.status) });
  }));

  function toColumns(data: Record<string, unknown>) {
    const cols = Object.keys(c.columns).filter((k) => k in data);
    return { cols: cols.map((k) => c.columns[k]!), vals: cols.map((k) => data[k] ?? null) };
  }

  function assertWriteScope(req: Request, action: string, data: Record<string, unknown>) {
    if (c.scopeColumn === 'id') {
      if (legalEntityScope(req, perm(c, action)) !== null) throw Errors.forbidden(`${perm(c, action)} (all legal entities)`);
    } else if (!inLegalEntityScope(req, perm(c, action), (data.legalEntityId as string) ?? null)) {
      throw Errors.forbidden(`${perm(c, action)} for this legal entity`);
    }
  }

  r.post('/', requirePermission(perm(c, 'create')), asyncHandler(async (req, res) => {
    const data = parse(c.schema, req.body) as Record<string, unknown>;
    assertWriteScope(req, 'create', data);
    const actor = actorOf(req);
    const id = await withTx(db, async (tx) => {
      await c.validateWrite?.(tx, data, null);
      const { cols, vals } = toColumns(data);
      const ins = await tx.query(
        `insert into ${c.table} (${cols.join(', ')}, created_by, updated_by) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}, $${cols.length + 1}) returning *`,
        [...vals, actor.userId]);
      await audit(tx, actor, { action: `${c.resource}.created`, entityType: c.resource, entityId: ins.rows[0].id, after: ins.rows[0] });
      return ins.rows[0].id as string;
    });
    res.status(201).json({ id });
  }));

  r.put('/:id', requirePermission(perm(c, 'edit_draft')), asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const data = parse(c.schema, body) as Record<string, unknown>;
    const version = Number(body.version);
    if (!Number.isInteger(version)) throw Errors.validation([{ field: 'version', message: 'Required' }]);
    const actor = actorOf(req);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from ${c.table} where id = $1 for update`, [req.params.id])).rows[0];
      if (!before || !inLegalEntityScope(req, perm(c, 'edit_draft'), before[c.scopeColumn])) throw Errors.notFound(c.label);
      assertWriteScope(req, 'edit_draft', data);
      if (!['Draft', 'Rejected'].includes(before.status)) throw Errors.state(`A ${before.status} ${c.label.toLowerCase()} cannot be edited.`);
      if (before.version !== version) throw Errors.concurrent();
      await c.validateWrite?.(tx, data, before.id);
      const { cols, vals } = toColumns(data);
      const after = (await tx.query(
        `update ${c.table} set ${cols.map((col, i) => `${col} = $${i + 2}`).join(', ')}, updated_by = $${cols.length + 2} where id = $1 returning *`,
        [before.id, ...vals, actor.userId])).rows[0];
      const d = diff(before, after);
      await audit(tx, actor, { action: `${c.resource}.updated`, entityType: c.resource, entityId: before.id, before: d.before, after: d.after });
    });
    res.json({ ok: true });
  }));

  const submitLike = (fromStatuses: string[], action: 'submit') => asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const result = await withTx(db, async (tx) => {
      const row = (await tx.query(`select * from ${c.table} where id = $1 for update`, [req.params.id])).rows[0];
      if (!row || !inLegalEntityScope(req, perm(c, action), row[c.scopeColumn])) throw Errors.notFound(c.label);
      if (!fromStatuses.includes(row.status)) throw Errors.state(`A ${row.status} ${c.label.toLowerCase()} cannot be submitted.`);
      await c.validateSubmit?.(tx, row);
      await setStatus(tx, c, row.id, 'Submitted', actor);
      return submitForApproval(tx, actor, {
        subjectType: c.resource, subjectId: row.id, subjectLabel: `${c.label} ${row.code} — ${row.name}`,
        revision: row.version, legalEntityId: row[c.scopeColumn], facts: { legalEntityId: row[c.scopeColumn] },
      });
    });
    res.json({ approvalRequestId: result.id, approvalDocNo: result.doc_no, status: result.status });
  });

  r.post('/:id/submit', requirePermission(perm(c, 'submit')), submitLike(['Draft', 'Rejected'], 'submit'));
  r.post('/:id/reactivate', requirePermission(perm(c, 'submit')), submitLike(['Inactive'], 'submit'));

  r.post('/:id/deactivate', requirePermission(perm(c, 'deactivate')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const row = (await tx.query(`select * from ${c.table} where id = $1 for update`, [req.params.id])).rows[0];
      if (!row || !inLegalEntityScope(req, perm(c, 'deactivate'), row[c.scopeColumn])) throw Errors.notFound(c.label);
      if (row.status !== 'Active') throw Errors.state(`Only an active ${c.label.toLowerCase()} can be deactivated.`);
      await c.validateDeactivate?.(tx, row);
      await setStatus(tx, c, row.id, 'Inactive', actorOf(req), reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
