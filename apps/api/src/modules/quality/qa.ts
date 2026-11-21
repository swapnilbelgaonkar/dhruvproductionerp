import { Router, type Request } from 'express';
import { z } from 'zod';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

/**
 * QA core (BRD p.16; MP §14.4–14.5): CAPA with effectiveness verification (QA-007), non-conformance, change control (QA-009),
 * complaint investigation linked to dealer, lot and box (QA-013), and recall with drill mode (QA-008, QA-016: trace and lock within 2 hours).
 */
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const optText = (n: number) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

const capaSchema = z.object({
  title: text(200), sourceType: z.enum(['DEVIATION', 'NON_CONFORMANCE', 'COMPLAINT', 'AUDIT', 'OOS', 'CHANGE', 'RECALL', 'OTHER']), sourceId: uuid.optional().nullable(), sourceRef: optText(60),
  problem: text(2000), rootCause: optText(2000), ownerId: uuid, dueDate: day,
  actions: z.array(z.object({ kind: z.enum(['CORRECTION', 'CORRECTIVE', 'PREVENTIVE']), description: text(1000), ownerId: uuid, dueDate: day })).min(1, 'Add at least one action').max(20),
});
const ncSchema = z.object({ kind: z.enum(['MATERIAL', 'PROCESS', 'SUPPLIER', 'PRODUCT', 'OTHER']), title: text(200), description: text(2000), severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']),
  lotId: uuid.optional().nullable(), partyId: uuid.optional().nullable() });
const changeSchema = z.object({ title: text(200), changeType: z.enum(['FORMULATION', 'SPECIFICATION', 'PROCESS', 'EQUIPMENT', 'SOP', 'SUPPLIER', 'OTHER']), description: text(2000),
  justification: text(2000), impact: text(2000), risk: z.enum(['LOW', 'MEDIUM', 'HIGH']), targetDate: day.optional().nullable() });
const complaintSchema = z.object({ partyId: uuid.optional().nullable(), receivedOn: day, channel: z.enum(['PHONE', 'EMAIL', 'FIELD_VISIT', 'WHATSAPP', 'LETTER', 'OTHER']),
  itemId: uuid.optional().nullable(), lotId: uuid.optional().nullable(), boxSerial: optText(40), category: z.enum(['QUALITY', 'EFFICACY', 'PACKAGING', 'LABELLING', 'QUANTITY', 'DAMAGE', 'OTHER']),
  description: text(2000), severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']) });
const recallSchema = z.object({ mode: z.enum(['DRILL', 'ACTUAL']), reason: text(1000), sourceLotId: uuid, complaintId: uuid.optional().nullable() });

async function users(tx: Db | Tx, ids: string[]) {
  const n = Number((await tx.query(`select count(*) from iam.users where id = any($1::uuid[]) and status = 'Active'`, [[...new Set(ids)]])).rows[0].count);
  if (n !== new Set(ids).size) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose active users as owners.');
}
const list = (db: Db, sql: string) => asyncHandler(async (req: Request, res) => {
  const status = str(req.query.status);
  const rows = (await db.query(`${sql} ${status ? 'where x.status = $1' : ''} order by x.created_at desc limit 300`, status ? [status] : [])).rows;
  res.json({ data: rows, total: rows.length });
});

export function qaRoutes(db: Db) {
  registerSubjectHandler('qa.change_request', {
    onApproved: (tx, r, a) => setChange(tx, a, r.subject_id, 'Approved'),
    onRejected: (tx, r, a) => setChange(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setChange(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setChange(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  const r = Router();

  // ================================================================ CAPA (QA-007)
  const capaSel = `select x.id, x.doc_no as "docNo", x.title, x.source_type as "sourceType", x.source_id as "sourceId", x.source_ref as "sourceRef", x.problem, x.root_cause as "rootCause",
      x.owner_id as "ownerId", ou.full_name as owner, x.due_date as "dueDate", x.status, x.effective, x.verification_note as "verificationNote", vu.full_name as "verifiedBy", x.verified_at as "verifiedAt",
      x.created_at as "createdAt", (select count(*)::int from qa.capa_actions a where a.capa_id = x.id) as "actionCount",
      (select count(*)::int from qa.capa_actions a where a.capa_id = x.id and a.status = 'Done') as "actionsDone", x.version
    from qa.capas x join iam.users ou on ou.id = x.owner_id left join iam.users vu on vu.id = x.verified_by`;
  r.get('/capas', requirePermission('qa.capa:view'), list(db, capaSel));
  r.get('/capas/:id', requirePermission('qa.capa:view'), asyncHandler(async (req, res) => {
    const c = (await db.query(`${capaSel} where x.id = $1`, [req.params.id])).rows[0];
    if (!c) throw Errors.notFound('CAPA');
    const actions = (await db.query(`select a.id, a.kind, a.description, a.owner_id as "ownerId", u.full_name as owner, a.due_date as "dueDate", a.status, a.evidence, a.done_at as "doneAt"
      from qa.capa_actions a join iam.users u on u.id = a.owner_id where a.capa_id = $1 order by a.kind, a.due_date`, [c.id])).rows;
    const me = req.auth!.user.id;
    const acts: string[] = [];
    if (c.status === 'Open' && actions.some((a) => a.status === 'Open' && (a.ownerId === me || can(req, 'qa.capa:manage')))) acts.push('complete_action');
    if (c.status === 'EffectivenessCheck' && can(req, 'qa.capa:verify') && c.ownerId !== me) acts.push('verify');
    if (c.status === 'Open' && can(req, 'qa.capa:manage')) acts.push('add_action', 'cancel');
    res.json({ ...c, actions, allowedActions: acts, overdue: c.status !== 'Closed' && String(c.dueDate) < todayIST() });
  }));
  r.post('/capas', requirePermission('qa.capa:manage'), asyncHandler(async (req, res) => {
    const d = parse(capaSchema, req.body);
    const out = await withTx(db, async (tx) => {
      await users(tx, [d.ownerId, ...d.actions.map((a) => a.ownerId)]);
      const docNo = await nextDocNo(tx, 'CAPA');
      const c = (await tx.query(`insert into qa.capas (doc_no, title, source_type, source_id, source_ref, problem, root_cause, owner_id, due_date, created_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id`, [docNo, d.title, d.sourceType, d.sourceId ?? null, d.sourceRef, d.problem, d.rootCause, d.ownerId, d.dueDate, req.auth!.user.id])).rows[0];
      for (const a of d.actions) await tx.query(`insert into qa.capa_actions (capa_id, kind, description, owner_id, due_date) values ($1,$2,$3,$4,$5)`, [c.id, a.kind, a.description, a.ownerId, a.dueDate]);
      if (d.sourceType === 'COMPLAINT' && d.sourceId) await tx.query(`update qa.complaints set capa_id = $2 where id = $1`, [d.sourceId, c.id]);
      if (d.sourceType === 'NON_CONFORMANCE' && d.sourceId) await tx.query(`update qa.non_conformances set capa_id = $2 where id = $1`, [d.sourceId, c.id]);
      await audit(tx, actorOf(req), { action: 'qa.capa.created', entityType: 'qa.capa', entityId: c.id, after: { docNo, ...d } });
      return { id: c.id as string, docNo };
    });
    res.status(201).json(out);
  }));
  r.post('/capas/:id/actions', requirePermission('qa.capa:manage'), asyncHandler(async (req, res) => {
    const a = parse(capaSchema.shape.actions.element, req.body);
    await withTx(db, async (tx) => {
      const c = (await tx.query(`select status from qa.capas where id = $1 for update`, [req.params.id])).rows[0];
      if (c?.status !== 'Open') throw Errors.state('Actions can be added while the CAPA is open.');
      await users(tx, [a.ownerId]);
      await tx.query(`insert into qa.capa_actions (capa_id, kind, description, owner_id, due_date) values ($1,$2,$3,$4,$5)`, [req.params.id, a.kind, a.description, a.ownerId, a.dueDate]);
      await audit(tx, actorOf(req), { action: 'qa.capa.action_added', entityType: 'qa.capa', entityId: req.params.id!, after: a });
    });
    res.status(201).json({ ok: true });
  }));
  // an action is completed by its owner (or QA) with evidence; when the last one is done the CAPA goes to the effectiveness check
  r.post('/capas/:id/actions/:aid/complete', requirePermission('qa.capa:view'), asyncHandler(async (req, res) => {
    const { evidence } = parse(z.object({ evidence: text(1000) }), req.body);
    const out = await withTx(db, async (tx) => {
      const a = (await tx.query(`select a.*, c.status as capa_status from qa.capa_actions a join qa.capas c on c.id = a.capa_id where a.id = $1 and a.capa_id = $2 for update of a`, [req.params.aid, req.params.id])).rows[0];
      if (!a) throw Errors.notFound('Action');
      if (a.capa_status !== 'Open' || a.status !== 'Open') throw Errors.state('This action is not open.');
      if (a.owner_id !== req.auth!.user.id && !can(req, 'qa.capa:manage')) throw Errors.forbidden('Only the action owner or QA can complete it.');
      await tx.query(`update qa.capa_actions set status = 'Done', evidence = $2, done_at = now(), done_by = $3 where id = $1`, [a.id, evidence, req.auth!.user.id]);
      const open = Number((await tx.query(`select count(*) from qa.capa_actions where capa_id = $1 and status = 'Open'`, [a.capa_id])).rows[0].count);
      if (!open) await tx.query(`update qa.capas set status = 'EffectivenessCheck', updated_by = $2 where id = $1`, [a.capa_id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.capa.action_done', entityType: 'qa.capa', entityId: a.capa_id, after: { action: a.description, evidence } });
      return { capaStatus: open ? 'Open' : 'EffectivenessCheck' };
    });
    res.json(out);
  }));
  // QA-007: someone other than the owner verifies effectiveness; not effective → back to open for further action
  r.post('/capas/:id/verify', requirePermission('qa.capa:verify'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ effective: z.boolean(), note: text(2000) }), req.body);
    await withTx(db, async (tx) => {
      const c = (await tx.query(`select status, owner_id from qa.capas where id = $1 for update`, [req.params.id])).rows[0];
      if (c?.status !== 'EffectivenessCheck') throw Errors.state('The CAPA is not waiting for its effectiveness check.');
      if (c.owner_id === req.auth!.user.id) throw Errors.sod('The CAPA owner cannot verify its effectiveness.');
      await tx.query(`update qa.capas set status = $2, effective = $3, verification_note = $4, verified_by = $5, verified_at = now(), updated_by = $5 where id = $1`,
        [req.params.id, d.effective ? 'Closed' : 'Open', d.effective, d.note, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.capa.verified', entityType: 'qa.capa', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));

  // ================================================================ non-conformance
  const ncSel = `select x.id, x.doc_no as "docNo", x.kind, x.title, x.description, x.severity, x.lot_id as "lotId", l.lot_no as "lotNo", x.party_id as "partyId", p.legal_name as "partyName",
      x.disposition, x.disposition_note as "dispositionNote", x.capa_id as "capaId", c.doc_no as "capaNo", x.status, ru.full_name as "raisedBy", x.created_at as "createdAt", cu.full_name as "closedBy", x.closed_at as "closedAt"
    from qa.non_conformances x left join inv.lots l on l.id = x.lot_id left join mdm.parties p on p.id = x.party_id left join qa.capas c on c.id = x.capa_id
    join iam.users ru on ru.id = x.raised_by left join iam.users cu on cu.id = x.closed_by`;
  r.get('/ncs', requirePermission('qa.nc:view'), list(db, ncSel));
  r.get('/ncs/:id', requirePermission('qa.nc:view'), asyncHandler(async (req, res) => {
    const n = (await db.query(`${ncSel} where x.id = $1`, [req.params.id])).rows[0];
    if (!n) throw Errors.notFound('Non-conformance');
    res.json({ ...n, allowedActions: n.status === 'Open' && can(req, 'qa.nc:manage') ? ['close'] : [] });
  }));
  r.post('/ncs', requirePermission('qa.nc:create'), asyncHandler(async (req, res) => {
    const d = parse(ncSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const docNo = await nextDocNo(tx, 'NON_CONFORMANCE');
      const n = (await tx.query(`insert into qa.non_conformances (doc_no, kind, title, description, severity, lot_id, party_id, raised_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [docNo, d.kind, d.title, d.description, d.severity, d.lotId ?? null, d.partyId ?? null, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qa.nc.raised', entityType: 'qa.non_conformance', entityId: n.id, after: { docNo, ...d } });
      return { id: n.id as string, docNo };
    });
    res.status(201).json(out);
  }));
  r.post('/ncs/:id/close', requirePermission('qa.nc:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ disposition: z.enum(['USE_AS_IS', 'REWORK', 'RETURN', 'SCRAP']), note: text(2000) }), req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`select status, severity, capa_id from qa.non_conformances where id = $1 for update`, [req.params.id])).rows[0];
      if (n?.status !== 'Open') throw Errors.state('This non-conformance is not open.');
      if (n.severity === 'CRITICAL' && !n.capa_id) throw Errors.rule('CAPA_REQUIRED', 'A critical non-conformance needs a CAPA before it is closed.');
      await tx.query(`update qa.non_conformances set status = 'Closed', disposition = $2, disposition_note = $3, closed_by = $4, closed_at = now(), updated_by = $4 where id = $1`, [req.params.id, d.disposition, d.note, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.nc.closed', entityType: 'qa.non_conformance', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));

  // ================================================================ change control (QA-009)
  async function setChange(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
    await allowTransition(tx);
    await tx.query(`update qa.change_requests set status = $2, status_reason = $3, updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
    await audit(tx, actor, { action: 'qa.change.status', entityType: 'qa.change_request', entityId: id, after: { status }, reason });
    await emit(tx, 'qa.change_request', id, `qa.change.${status.toLowerCase()}`);
  }
  const ccSel = `select x.id, x.doc_no as "docNo", x.title, x.change_type as "changeType", x.description, x.justification, x.impact, x.risk, x.target_date as "targetDate", x.status,
      x.status_reason as "statusReason", x.implementation_note as "implementationNote", x.requested_by as "requestedById", u.full_name as "requestedBy", x.created_at as "createdAt", x.version,
      (select a.id from wf.approval_requests a where a.subject_type = 'qa.change_request' and a.subject_id = x.id order by a.submitted_at desc limit 1) as "approvalId"
    from qa.change_requests x join iam.users u on u.id = x.requested_by`;
  r.get('/changes', requirePermission('qa.change:view'), list(db, ccSel));
  r.get('/changes/:id', requirePermission('qa.change:view'), asyncHandler(async (req, res) => {
    const c = (await db.query(`${ccSel} where x.id = $1`, [req.params.id])).rows[0];
    if (!c) throw Errors.notFound('Change request');
    const acts: string[] = [];
    if (['Draft', 'Rejected'].includes(c.status) && c.requestedById === req.auth!.user.id) acts.push('submit');
    if (c.status === 'Approved' && can(req, 'qa.change:manage')) acts.push('implement');
    if (c.status === 'Implemented' && can(req, 'qa.change:manage')) acts.push('close');
    res.json({ ...c, allowedActions: acts });
  }));
  r.post('/changes', requirePermission('qa.change:create'), asyncHandler(async (req, res) => {
    const d = parse(changeSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const docNo = await nextDocNo(tx, 'CHANGE_REQUEST');
      const c = (await tx.query(`insert into qa.change_requests (doc_no, title, change_type, description, justification, impact, risk, target_date, requested_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`, [docNo, d.title, d.changeType, d.description, d.justification, d.impact, d.risk, d.targetDate ?? null, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qa.change.created', entityType: 'qa.change_request', entityId: c.id, after: { docNo, ...d } });
      return { id: c.id as string, docNo };
    });
    res.status(201).json(out);
  }));
  r.post('/changes/:id/submit', requirePermission('qa.change:create'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const c = (await tx.query(`select id, doc_no, title, status, risk, requested_by from qa.change_requests where id = $1 for update`, [req.params.id])).rows[0];
      if (!c) throw Errors.notFound('Change request');
      if (!['Draft', 'Rejected'].includes(c.status)) throw Errors.state(`A ${c.status} change cannot be submitted.`);
      if (c.requested_by !== req.auth!.user.id) throw Errors.forbidden('Only the requester submits a change.');
      await setChange(tx, actorOf(req), c.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: 'qa.change_request', subjectId: c.id, subjectLabel: `${c.doc_no} — ${c.title}`, facts: { risk: c.risk }, legalEntityId: null });
      return { approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));
  for (const [path, from, to] of [['implement', 'Approved', 'Implemented'], ['close', 'Implemented', 'Closed']] as const) {
    r.post(`/changes/:id/${path}`, requirePermission('qa.change:manage'), asyncHandler(async (req, res) => {
      const { note } = parse(z.object({ note: text(2000) }), req.body);
      await withTx(db, async (tx) => {
        const c = (await tx.query(`select status from qa.change_requests where id = $1 for update`, [req.params.id])).rows[0];
        if (c?.status !== from) throw Errors.state(`Only a ${from.toLowerCase()} change can be ${to.toLowerCase()}.`);
        if (path === 'implement') await tx.query(`update qa.change_requests set implementation_note = $2 where id = $1`, [req.params.id, note]);
        await setChange(tx, actorOf(req), req.params.id!, to, path === 'close' ? note : null);
      });
      res.json({ ok: true });
    }));
  }

  // ================================================================ complaints (QA-013)
  const cmpSel = `select x.id, x.doc_no as "docNo", x.party_id as "partyId", p.legal_name as "partyName", p.code as "partyCode", x.received_on as "receivedOn", x.channel, x.item_id as "itemId",
      i.code as "itemCode", i.name as "itemName", x.lot_id as "lotId", l.lot_no as "lotNo", x.box_serial as "boxSerial", x.category, x.description, x.severity, x.status, x.findings, x.conclusion,
      x.response, x.capa_id as "capaId", c.doc_no as "capaNo", lu.full_name as "loggedBy", x.created_at as "createdAt", cu.full_name as "closedBy", x.closed_at as "closedAt",
      (select r.id from qa.recalls r where r.complaint_id = x.id order by r.initiated_at desc limit 1) as "recallId"
    from qa.complaints x left join mdm.parties p on p.id = x.party_id left join mdm.items i on i.id = x.item_id left join inv.lots l on l.id = x.lot_id
    left join qa.capas c on c.id = x.capa_id join iam.users lu on lu.id = x.logged_by left join iam.users cu on cu.id = x.closed_by`;
  r.get('/complaints', requirePermission('qa.complaint:view'), list(db, cmpSel));
  r.get('/complaints/:id', requirePermission('qa.complaint:view'), asyncHandler(async (req, res) => {
    const c = (await db.query(`${cmpSel} where x.id = $1`, [req.params.id])).rows[0];
    if (!c) throw Errors.notFound('Complaint');
    const acts: string[] = [];
    if (c.status !== 'Closed' && can(req, 'qa.complaint:manage')) acts.push('investigate', 'close');
    res.json({ ...c, allowedActions: acts });
  }));
  // a box serial from the label resolves the lot and product (D24)
  r.post('/complaints', requirePermission('qa.complaint:create'), asyncHandler(async (req, res) => {
    const d = parse(complaintSchema, req.body);
    const out = await withTx(db, async (tx) => {
      let { lotId, itemId } = d;
      if (d.boxSerial) {
        const b = (await tx.query(`select b.lot_id, l.item_id from inv.boxes b join inv.lots l on l.id = b.lot_id where b.serial = $1`, [d.boxSerial])).rows[0];
        if (!b) throw Errors.rule('UNKNOWN_BOX', `No box ${d.boxSerial} was packed by us.`);
        lotId = b.lot_id; itemId = b.item_id;
      }
      if (lotId && !itemId) itemId = (await tx.query(`select item_id from inv.lots where id = $1`, [lotId])).rows[0]?.item_id ?? null;
      if (d.receivedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'The received date cannot be in the future.');
      const docNo = await nextDocNo(tx, 'COMPLAINT');
      const c = (await tx.query(`insert into qa.complaints (doc_no, party_id, received_on, channel, item_id, lot_id, box_serial, category, description, severity, logged_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
        [docNo, d.partyId ?? null, d.receivedOn, d.channel, itemId ?? null, lotId ?? null, d.boxSerial, d.category, d.description, d.severity, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qa.complaint.logged', entityType: 'qa.complaint', entityId: c.id, after: { docNo, ...d, lotId } });
      return { id: c.id as string, docNo, lotId };
    });
    res.status(201).json(out);
  }));
  r.post('/complaints/:id/investigate', requirePermission('qa.complaint:manage'), asyncHandler(async (req, res) => {
    const { findings } = parse(z.object({ findings: text(3000) }), req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`update qa.complaints set findings = $2, status = 'Investigating', updated_by = $3 where id = $1 and status <> 'Closed' returning id`, [req.params.id, findings, req.auth!.user.id])).rowCount;
      if (!n) throw Errors.state('The complaint is closed.');
      await audit(tx, actorOf(req), { action: 'qa.complaint.investigated', entityType: 'qa.complaint', entityId: req.params.id!, after: { findings } });
    });
    res.json({ ok: true });
  }));
  r.post('/complaints/:id/close', requirePermission('qa.complaint:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ conclusion: z.enum(['Justified', 'NotJustified']), response: text(2000) }), req.body);
    await withTx(db, async (tx) => {
      const c = (await tx.query(`select status, findings, capa_id, severity from qa.complaints where id = $1 for update`, [req.params.id])).rows[0];
      if (!c || c.status === 'Closed') throw Errors.state('The complaint is already closed.');
      if (!c.findings) throw Errors.rule('NOT_INVESTIGATED', 'Record the investigation findings first.');
      if (d.conclusion === 'Justified' && c.severity !== 'MINOR' && !c.capa_id) throw Errors.rule('CAPA_REQUIRED', 'A justified major or critical complaint needs a CAPA before it is closed.');
      await tx.query(`update qa.complaints set status = 'Closed', conclusion = $2, response = $3, closed_by = $4, closed_at = now(), updated_by = $4 where id = $1`, [req.params.id, d.conclusion, d.response, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.complaint.closed', entityType: 'qa.complaint', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));

  // ================================================================ recall (QA-008, QA-016, UAT-15)
  /** Every lot the source lot went into, recursively (forward genealogy), with the source itself. */
  async function affectedLots(tx: Tx, sourceLotId: string) {
    const out: { lotId: string; depth: number; relation: string }[] = [{ lotId: sourceLotId, depth: 0, relation: 'SOURCE' }];
    const seen = new Set([sourceLotId]);
    let frontier = [sourceLotId];
    for (let depth = 1; depth <= 6 && frontier.length; depth++) {
      const next = (await tx.query(`select distinct b.fg_lot_id from mfg.batch_consumptions c join mfg.batches b on b.id = c.batch_id where c.lot_id = any($1::uuid[]) and b.fg_lot_id is not null`, [frontier])).rows
        .map((x) => x.fg_lot_id as string).filter((x) => !seen.has(x));
      next.forEach((x) => { seen.add(x); out.push({ lotId: x, depth, relation: 'MADE_FROM' }); });
      frontier = next;
    }
    return out;
  }
  const rclSel = `select x.id, x.doc_no as "docNo", x.mode, x.reason, x.source_lot_id as "sourceLotId", l.lot_no as "sourceLotNo", i.code as "itemCode", x.complaint_id as "complaintId", q.doc_no as "complaintNo",
      x.status, iu.full_name as "initiatedBy", x.initiated_at as "initiatedAt", x.traced_at as "tracedAt", x.locked_at as "lockedAt", x.trace_seconds as "traceSeconds", x.closure_note as "closureNote",
      cu.full_name as "closedBy", x.closed_at as "closedAt", (select count(*)::int from qa.recall_lots rl where rl.recall_id = x.id) as "lotCount", x.initiated_at as created_at
    from qa.recalls x join inv.lots l on l.id = x.source_lot_id join mdm.items i on i.id = l.item_id left join qa.complaints q on q.id = x.complaint_id
    join iam.users iu on iu.id = x.initiated_by left join iam.users cu on cu.id = x.closed_by`;
  r.get('/recalls', requirePermission('qa.recall:view'), asyncHandler(async (_req, res) => {
    const rows = (await db.query(`${rclSel} order by x.initiated_at desc limit 200`)).rows;
    res.json({ data: rows, total: rows.length });
  }));
  r.get('/recalls/:id', requirePermission('qa.recall:view'), asyncHandler(async (req, res) => {
    const x = (await db.query(`${rclSel} where x.id = $1`, [req.params.id])).rows[0];
    if (!x) throw Errors.notFound('Recall');
    const lots = (await db.query(`select rl.lot_id as "lotId", l.lot_no as "lotNo", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, rl.depth, rl.relation, rl.produced_qty as "producedQty",
        rl.on_hand_qty as "onHandQty", rl.boxes, rl.locked_qty as "lockedQty", l.qc_status as "qcStatus"
      from qa.recall_lots rl join inv.lots l on l.id = rl.lot_id join mdm.items i on i.id = l.item_id where rl.recall_id = $1 order by rl.depth, l.lot_no`, [x.id])).rows;
    res.json({ ...x, lots, allowedActions: x.status === 'Open' && can(req, x.mode === 'ACTUAL' ? 'qa.recall:actual' : 'qa.recall:drill') ? ['close'] : [] });
  }));
  // tracing (and, for an actual recall, locking) happens in the same transaction as the initiation: the 2-hour target is met in seconds
  r.post('/recalls', requirePermission('qa.recall:drill'), asyncHandler(async (req, res) => {
    const d = parse(recallSchema, req.body);
    if (d.mode === 'ACTUAL' && !can(req, 'qa.recall:actual')) throw Errors.forbidden('qa.recall:actual');
    const out = await withTx(db, async (tx) => {
      const src = (await tx.query(`select id, lot_no from inv.lots where id = $1`, [d.sourceLotId])).rows[0];
      if (!src) throw Errors.notFound('Lot');
      const docNo = await nextDocNo(tx, 'RECALL');
      const rc = (await tx.query(`insert into qa.recalls (doc_no, mode, reason, source_lot_id, complaint_id, initiated_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id, initiated_at`,
        [docNo, d.mode, d.reason, d.sourceLotId, d.complaintId ?? null, req.auth!.user.id])).rows[0];
      const lots = await affectedLots(tx, d.sourceLotId);
      let lockedLots = 0;
      for (const a of lots) {
        const s = (await tx.query(`select coalesce(sum(qty), 0) as on_hand, coalesce(sum(qty) filter (where txn_type = 'PRODUCTION_OUTPUT'), 0) as produced from inv.stock_ledger where lot_id = $1`, [a.lotId])).rows[0];
        const boxes = Number((await tx.query(`select count(*) from inv.boxes where lot_id = $1`, [a.lotId])).rows[0].count);
        let locked = 0;
        if (d.mode === 'ACTUAL') {
          await tx.query(`select id from inv.lots where id = $1 for update`, [a.lotId]);
          const held = (await tx.query(`select warehouse_id, bucket, sum(qty) as qty, sum(qty * unit_cost) / nullif(sum(qty), 0) as cost from inv.stock_ledger
                                          where lot_id = $1 and bucket in ('UNRESTRICTED','QUARANTINE') group by warehouse_id, bucket having sum(qty) > 0`, [a.lotId])).rows;
          for (const h of held) {
            const itemId = (await tx.query(`select item_id from inv.lots where id = $1`, [a.lotId])).rows[0].item_id;
            await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by) values
                            ($1,$2,$3,$4,$5,$6,'RECALL_HOLD','qa.recall',$7,$8), ($1,$2,$3,'BLOCKED',$9,$6,'RECALL_HOLD','qa.recall',$7,$8)`,
              [itemId, a.lotId, h.warehouse_id, h.bucket, -Number(h.qty), Number(h.cost ?? 0), rc.id, req.auth!.user.id, Number(h.qty)]);
            locked += Number(h.qty);
          }
          await allowTransition(tx);
          await tx.query(`update inv.lots set qc_status = 'Hold', qc_decided_by = $2, qc_decided_at = now() where id = $1 and qc_status <> 'Rejected'`, [a.lotId, req.auth!.user.id]);
          if (locked) lockedLots++;
        }
        await tx.query(`insert into qa.recall_lots (recall_id, lot_id, depth, relation, produced_qty, on_hand_qty, boxes, locked_qty) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rc.id, a.lotId, a.depth, a.relation, Number(s.produced) || null, Number(s.on_hand), boxes, locked]);
      }
      const secs = Math.max(0, Math.round((Date.now() - new Date(rc.initiated_at).getTime()) / 1000));
      await tx.query(`update qa.recalls set traced_at = now(), locked_at = case when $2 = 'ACTUAL' then now() end, trace_seconds = $3 where id = $1`, [rc.id, d.mode, secs]);
      await audit(tx, actorOf(req), { action: `qa.recall.${d.mode.toLowerCase()}`, entityType: 'qa.recall', entityId: rc.id, after: { docNo, source: src.lot_no, lots: lots.length, lockedLots } });
      await emit(tx, 'qa.recall', rc.id, `qa.recall.${d.mode.toLowerCase()}`);
      return { id: rc.id as string, docNo, lots: lots.length, lockedLots, traceSeconds: secs };
    });
    res.status(201).json(out);
  }));
  r.post('/recalls/:id/close', requirePermission('qa.recall:drill'), asyncHandler(async (req, res) => {
    const { note } = parse(z.object({ note: text(2000) }), req.body);
    await withTx(db, async (tx) => {
      const x = (await tx.query(`select status, mode from qa.recalls where id = $1 for update`, [req.params.id])).rows[0];
      if (x?.status !== 'Open') throw Errors.state('The recall is already closed.');
      if (x.mode === 'ACTUAL' && !can(req, 'qa.recall:actual')) throw Errors.forbidden('qa.recall:actual');
      await tx.query(`update qa.recalls set status = 'Closed', closure_note = $2, closed_by = $3, closed_at = now(), updated_by = $3 where id = $1`, [req.params.id, note, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.recall.closed', entityType: 'qa.recall', entityId: req.params.id!, after: { note } });
    });
    res.json({ ok: true });
  }));

  // people who can own CAPA actions (active users with a QA, QC, plant, stores or purchase role)
  r.get('/people', requirePermission('qa.capa:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select distinct u.id, u.full_name as name from iam.users u join iam.user_roles ur on ur.user_id = u.id and ur.status = 'Active'
      join iam.roles r on r.id = ur.role_id where u.status = 'Active' and r.department in ('QA','QC','Plant','Stores','Purchase','Sales','Logistics') order by u.full_name`)).rows });
  }));

  return r;
}
