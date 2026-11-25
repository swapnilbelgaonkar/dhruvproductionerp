import { Router, type Request } from 'express';
import { usableStatuses } from '../parties/shared';
import { z } from 'zod';
import { reasonSchema, requisitionSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, inLegalEntityScope, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

type PrInput = z.infer<typeof requisitionSchema>;
const SUBJECT = 'purchase.requisition';
const P = (a: string) => `${SUBJECT}:${a}`;
const EDITABLE = ['Draft', 'Rejected'];

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from purchase.requisitions where id = $1`, [id])).rows[0];
  await tx.query(`update purchase.requisitions set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    approved_at = case when $2 = 'Approved' then now() else approved_at end where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

const prSelect = `select r.id, r.doc_no as "docNo", r.legal_entity_id as "legalEntityId", le.name as "legalEntityName", r.warehouse_id as "warehouseId",
    w.code as "warehouseCode", w.name as "warehouseName", r.department_id as "departmentId", d.name as "departmentName", r.requested_by as "requestedById",
    u.full_name as "requestedBy", r.required_by as "requiredBy", r.priority, r.purpose, r.status, r.status_reason as "statusReason",
    r.estimated_total as "estimatedTotal", r.approved_at as "approvedAt", r.created_at as "createdAt", r.updated_at as "updatedAt", r.version,
    (select count(*)::int from purchase.requisition_lines l where l.requisition_id = r.id) as "lineCount"
  from purchase.requisitions r join org.legal_entities le on le.id = r.legal_entity_id join org.warehouses w on w.id = r.warehouse_id
  join iam.users u on u.id = r.requested_by left join org.departments d on d.id = r.department_id`;

/**
 * Who sees what: everyone with the view permission sees their own requisitions; purchase, stores heads and finance (view_all)
 * see every requisition of their legal entities.
 */
function visibility(req: Request, args: unknown[]) {
  const where: string[] = [];
  const scope = legalEntityScope(req, P('view'));
  if (scope) { args.push(scope); where.push(`r.legal_entity_id = any($${args.length}::uuid[])`); }
  if (!can(req, P('view_all'))) { args.push(req.auth!.user.id); where.push(`r.requested_by = $${args.length}`); }
  return where.length ? where.join(' and ') : 'true';
}

function allowedActions(req: Request, row: { status: string; requestedById: string }, orderedAny: boolean) {
  const own = row.requestedById === req.auth!.user.id;
  const out: string[] = [];
  if (EDITABLE.includes(row.status) && own && can(req, P('edit'))) out.push('edit');
  if (EDITABLE.includes(row.status) && own && can(req, P('submit'))) out.push('submit');
  if ((EDITABLE.includes(row.status) && own) || (row.status === 'Approved' && !orderedAny && can(req, P('cancel')))) out.push('cancel');
  return out;
}

export function requisitionRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Approved'),
    onRejected: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const row = (await dbx.query(`${prSelect} where r.id = $1 and ${visibility(req, args)} ${lock ? 'for update of r' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Purchase requisition');
    return row;
  }

  /** Validates references and returns the lines with their units. */
  async function validate(tx: Tx, req: Request, d: PrInput) {
    if (!inLegalEntityScope(req, P('create'), d.legalEntityId)) throw Errors.forbidden(`${P('create')} for this legal entity`);
    const le = (await tx.query(`select status from org.legal_entities where id = $1`, [d.legalEntityId])).rows[0];
    if (le?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active legal entity.');
    const wh = (await tx.query(`select status, legal_entity_id from org.warehouses where id = $1`, [d.warehouseId])).rows[0];
    if (wh?.status !== 'Active' || wh.legal_entity_id !== d.legalEntityId) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active warehouse of the same legal entity to deliver to.');
    if (d.departmentId) {
      const dep = (await tx.query(`select status from org.departments where id = $1`, [d.departmentId])).rows[0];
      if (dep?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active department.');
    }
    const today = todayIST();
    if (d.requiredBy < today) throw Errors.rule('INVALID_DATE', 'The required-by date cannot be in the past.');
    const lines = [];
    let n = 0;
    for (const l of d.lines) {
      n++;
      const item = (await tx.query(`select code, status, base_uom from mdm.items where id = $1`, [l.itemId])).rows[0];
      if (item?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', `Line ${n}: only approved items can be requisitioned.`);
      if (l.requiredBy && l.requiredBy < today) throw Errors.rule('INVALID_DATE', `Line ${n}: the required-by date cannot be in the past.`);
      if (l.suggestedVendorId) {
        const v = (await tx.query(`select status from mdm.vendor_profiles where party_id = $1`, [l.suggestedVendorId])).rows[0];
        if (!v || !(await usableStatuses(tx)).includes(v.status)) throw Errors.rule('REFERENCE_NOT_ACTIVE', `Line ${n}: the suggested vendor must be an active vendor.`);
      }
      lines.push({ ...l, lineNo: n, uom: item.base_uom as string });
    }
    const total = lines.reduce((a, l) => a + (l.estimatedRate ?? 0) * l.qty, 0);
    return { lines, total: Math.round(total * 100) / 100 };
  }
  async function writeLines(tx: Tx, id: string, lines: Awaited<ReturnType<typeof validate>>['lines']) {
    await tx.query(`delete from purchase.requisition_lines where requisition_id = $1`, [id]);
    for (const l of lines) {
      await tx.query(
        `insert into purchase.requisition_lines (requisition_id, line_no, item_id, uom, qty, estimated_rate, required_by, suggested_vendor_id, remarks)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, l.lineNo, l.itemId, l.uom, l.qty, l.estimatedRate ?? null, l.requiredBy ?? null, l.suggestedVendorId ?? null, l.remarks]);
    }
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = [visibility(req, args)];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(r.doc_no ilike $${args.length} or r.purpose ilike $${args.length} or u.full_name ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`r.status = $${args.length}`); }
    const rows = await db.query(`${prSelect.replace('select r.id,', 'select count(*) over() as total, r.id,')} where ${where.join(' and ')}
      order by case r.priority when 'EMERGENCY' then 0 when 'URGENT' then 1 else 2 end, r.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const pr = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select l.line_no as "lineNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType", l.uom, l.qty,
              l.estimated_rate as "estimatedRate", l.required_by as "requiredBy", l.suggested_vendor_id as "suggestedVendorId", p.legal_name as "suggestedVendor",
              l.remarks, l.ordered_qty as "orderedQty",
              (select count(*)::int from mdm.vendor_items vi join mdm.vendor_profiles vp on vp.party_id = vi.party_id
                where vi.item_id = l.item_id and vi.status = 'Active' and vp.status = 'Active') as "approvedVendors"
         from purchase.requisition_lines l join mdm.items i on i.id = l.item_id left join mdm.parties p on p.id = l.suggested_vendor_id
        where l.requisition_id = $1 order by l.line_no`, [pr.id])).rows;
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, a.rule_name as "ruleName",
              (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'kind', s.step_kind, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, pr.id])).rows[0] ?? null;
    const orderedAny = lines.some((l) => Number(l.orderedQty) > 0);
    res.json({ ...pr, lines, approval, allowedActions: allowedActions(req, pr, orderedAny) });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(requisitionSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const v = await validate(tx, req, d);
      const docNo = await nextDocNo(tx, 'PURCHASE_REQUISITION');
      const pr = (await tx.query(
        `insert into purchase.requisitions (doc_no, legal_entity_id, warehouse_id, department_id, requested_by, required_by, priority, purpose, estimated_total, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$5,$5) returning id`,
        [docNo, d.legalEntityId, d.warehouseId, d.departmentId ?? null, req.auth!.user.id, d.requiredBy, d.priority, d.purpose, v.total])).rows[0];
      await writeLines(tx, pr.id, v.lines);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: pr.id, after: { docNo, ...d } });
      return { id: pr.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('edit')), asyncHandler(async (req, res) => {
    const d = parse(requisitionSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const pr = await load(tx, req, req.params.id!, true);
      if (!EDITABLE.includes(pr.status)) throw Errors.state(`A ${pr.status} requisition cannot be edited.`);
      if (pr.requestedById !== req.auth!.user.id) throw Errors.forbidden('Only the requester can edit a requisition.');
      if (pr.version !== d.version) throw Errors.concurrent();
      const v = await validate(tx, req, d);
      await tx.query(
        `update purchase.requisitions set legal_entity_id=$2, warehouse_id=$3, department_id=$4, required_by=$5, priority=$6, purpose=$7, estimated_total=$8, updated_by=$9 where id = $1`,
        [pr.id, d.legalEntityId, d.warehouseId, d.departmentId ?? null, d.requiredBy, d.priority, d.purpose, v.total, req.auth!.user.id]);
      await writeLines(tx, pr.id, v.lines);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: pr.id, before: { estimatedTotal: Number(pr.estimatedTotal) }, after: d });
    });
    res.json({ ok: true });
  }));

  // PUR-002: department head approves; an emergency goes straight to the purchase head (D06 default)
  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const pr = await load(tx, req, req.params.id!, true);
      if (!EDITABLE.includes(pr.status)) throw Errors.state(`Only a Draft or Rejected requisition can be submitted (this one is ${pr.status}).`);
      if (pr.requestedById !== req.auth!.user.id) throw Errors.forbidden('Only the requester can submit a requisition.');
      if (String(pr.requiredBy) < todayIST()) throw Errors.rule('INVALID_DATE', 'The required-by date has passed. Edit the requisition first.');
      // items deactivated since saving block submission
      const stale = (await tx.query(`select i.code from purchase.requisition_lines l join mdm.items i on i.id = l.item_id where l.requisition_id = $1 and i.status <> 'Active'`, [pr.id])).rows;
      if (stale.length) throw Errors.rule('REFERENCE_NOT_ACTIVE', `No longer active: ${stale.map((x) => x.code).join(', ')}. Edit the requisition.`);
      const facts = { priority: pr.priority, estimatedValue: Number(pr.estimatedTotal), lineCount: pr.lineCount };
      await setStatus(tx, actorOf(req), pr.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: pr.id, subjectLabel: `${pr.docNo} — ${pr.purpose.slice(0, 60)}`, facts, legalEntityId: pr.legalEntityId });
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  r.post('/:id/cancel', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const pr = await load(tx, req, req.params.id!, true);
      const ordered = Number((await tx.query(`select coalesce(sum(ordered_qty), 0) as q from purchase.requisition_lines where requisition_id = $1`, [pr.id])).rows[0].q) > 0;
      if (!allowedActions(req, pr, ordered).includes('cancel')) throw Errors.state(`This ${pr.status} requisition cannot be cancelled by you.`);
      await setStatus(tx, actorOf(req), pr.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
