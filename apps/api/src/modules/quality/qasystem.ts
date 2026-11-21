import { Router } from 'express';
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
 * QA system (BRD p.4, p.16; MP §14.3): controlled documents with versions, approval and biennial review (QA-006, QA-018); training compliance
 * per document and role (QA-011); internal, supplier and customer audits whose major findings need CAPA (QA-010); the FMEA risk register (QA-012);
 * line clearance before a batch or packing run (QA-017); and the QC and QA dashboards (QC-002, QA-002).
 */
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DOCV = 'qa.document_version';
const addMonths = (iso: string, m: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };

/** QA-017: the latest unused clearance of the line, recorded after the line was last used; consumed by the batch or packing run. */
export async function takeLineClearance(tx: Tx, lineId: string, purpose: 'BATCH' | 'PACKING') {
  const required = (await tx.query(`select value from sys.settings where key = 'mfg.lineClearance.required'`)).rows[0]?.value;
  if (required === false || required === 'false') return null;
  const lastUse = (await tx.query(`select greatest(
      (select max(coalesce(completed_at, started_at)) from mfg.batches where line_id = $1),
      (select max(posted_at) from mfg.packing_runs where line_id = $1)) as t`, [lineId])).rows[0].t;
  const c = (await tx.query(`select id from mfg.line_clearances where line_id = $1 and purpose = $2 and outcome = 'Cleared' and used_by_batch is null and used_by_packing is null
      and ($3::timestamptz is null or cleared_at > $3) order by cleared_at desc limit 1 for update`, [lineId, purpose, lastUse])).rows[0];
  if (!c) throw Errors.rule('LINE_NOT_CLEARED', `QA has not cleared this line for ${purpose === 'BATCH' ? 'a batch' : 'packing'} since it was last used (QA-017).`);
  return c.id as string;
}

export function qaSystemRoutes(db: Db) {
  registerSubjectHandler(DOCV, {
    onApproved: (tx, r, a) => makeEffective(tx, a, r.subject_id),
    onRejected: (tx, r, a) => setDocStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setDocStatus(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setDocStatus(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  const r = Router();

  // ================================================================ controlled documents (QA-006, QA-018)
  async function setDocStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
    await allowTransition(tx);
    await tx.query(`update qa.document_versions set status = $2, status_reason = $3, updated_by = $4, approved_at = case when $2 = 'Effective' then now() else approved_at end where id = $1`, [id, status, reason, actor.userId]);
    await audit(tx, actor, { action: `${DOCV}.status`, entityType: DOCV, entityId: id, after: { status }, reason });
    await emit(tx, DOCV, id, `${DOCV}.${status.toLowerCase()}`);
  }
  async function makeEffective(tx: Tx, actor: Actor, id: string) {
    const v = (await tx.query(`select document_id from qa.document_versions where id = $1`, [id])).rows[0];
    await allowTransition(tx);
    await tx.query(`update qa.document_versions set status = 'Superseded', updated_by = $2 where document_id = $1 and status = 'Effective'`, [v.document_id, actor.userId]);
    await setDocStatus(tx, actor, id, 'Effective');
  }
  const docSel = `select d.id, d.code, d.title, d.doc_type as "docType", d.department, d.owner_id as "ownerId", u.full_name as owner, d.review_months as "reviewMonths", d.status,
      v.id as "currentVersionId", v.version_no as "currentVersion", v.effective_from as "effectiveFrom", v.review_due as "reviewDue",
      (select count(*)::int from qa.document_versions x where x.document_id = d.id and x.status = 'Submitted') as "pendingCount",
      coalesce((select array_agg(role_code order by role_code) from qa.training_requirements t where t.document_id = d.id), '{}') as roles
    from qa.controlled_documents d join iam.users u on u.id = d.owner_id left join qa.document_versions v on v.document_id = d.id and v.status = 'Effective'`;
  r.get('/documents', requirePermission('qa.document:view'), asyncHandler(async (_req, res) => {
    const rows = (await db.query(`${docSel} order by d.code`)).rows;
    const today = todayIST();
    res.json({ data: rows.map((x) => ({ ...x, reviewState: !x.reviewDue ? null : x.reviewDue < today ? 'Overdue' : x.reviewDue <= addMonths(today, 1) ? 'DueSoon' : 'InDate' })) });
  }));
  r.post('/documents', requirePermission('qa.document:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,30}$/), title: text(200), docType: z.enum(['SOP', 'STP', 'POLICY', 'WORK_INSTRUCTION', 'FORM', 'MANUAL']),
      department: text(60), ownerId: z.string().uuid(), reviewMonths: z.number().int().min(1).max(60).default(24), roles: z.array(z.string()).max(30).default([]) }), req.body);
    const out = await withTx(db, async (tx) => {
      if ((await tx.query(`select 1 from qa.controlled_documents where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `${d.code} exists.`);
      const row = (await tx.query(`insert into qa.controlled_documents (code, title, doc_type, department, owner_id, review_months, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id`,
        [d.code, d.title, d.docType, d.department, d.ownerId, d.reviewMonths, req.auth!.user.id])).rows[0];
      for (const role of d.roles) await tx.query(`insert into qa.training_requirements (document_id, role_code) values ($1,$2)`, [row.id, role]);
      await audit(tx, actorOf(req), { action: 'qa.document.created', entityType: 'qa.controlled_document', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));
  r.get('/documents/:id', requirePermission('qa.document:view'), asyncHandler(async (req, res) => {
    const d = (await db.query(`${docSel} where d.id = $1`, [req.params.id])).rows[0];
    if (!d) throw Errors.notFound('Document');
    const versions = (await db.query(`select v.id, v.version_no as "versionNo", v.effective_from as "effectiveFrom", v.review_due as "reviewDue", v.change_summary as "changeSummary", v.file_id as "fileId",
        v.training_required as "trainingRequired", v.status, v.status_reason as "statusReason", u.full_name as author,
        (select dv.id from sys.document_versions dv where dv.document_id = v.file_id order by dv.version desc limit 1) as "fileVersionId", v.approved_at as "approvedAt", v.version,
        (select a.id from wf.approval_requests a where a.subject_type = $2 and a.subject_id = v.id order by a.submitted_at desc limit 1) as "approvalId",
        (select count(*)::int from qa.training_records t where t.document_version_id = v.id and t.assessment = 'Pass') as trained
      from qa.document_versions v join iam.users u on u.id = v.author_id where v.document_id = $1 order by v.version_no desc`, [d.id, DOCV])).rows;
    res.json({ ...d, versions, canManage: can(req, 'qa.document:manage') });
  }));
  r.post('/documents/:id/versions', requirePermission('qa.document:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ effectiveFrom: day, changeSummary: text(1000), fileId: z.string().uuid().optional().nullable(), trainingRequired: z.boolean().default(true) }), req.body);
    const out = await withTx(db, async (tx) => {
      const doc = (await tx.query(`select id, review_months from qa.controlled_documents where id = $1 and status = 'Active' for update`, [req.params.id])).rows[0];
      if (!doc) throw Errors.notFound('Document');
      if ((await tx.query(`select 1 from qa.document_versions where document_id = $1 and status in ('Draft','Submitted','Rejected')`, [doc.id])).rowCount) throw Errors.state('Finish the open draft first.');
      if (d.fileId && !(await tx.query(`select 1 from sys.documents where id = $1 and entity_type = 'qa.controlled_document' and entity_id = $2`, [d.fileId, doc.id])).rowCount) throw Errors.rule('DOCUMENT_INVALID', 'Upload the file to this document first.');
      const no = Number((await tx.query(`select coalesce(max(version_no), 0) + 1 as n from qa.document_versions where document_id = $1`, [doc.id])).rows[0].n);
      const v = (await tx.query(`insert into qa.document_versions (document_id, version_no, effective_from, review_due, change_summary, file_id, training_required, author_id, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [doc.id, no, d.effectiveFrom, addMonths(d.effectiveFrom, doc.review_months), d.changeSummary, d.fileId ?? null, d.trainingRequired, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: `${DOCV}.created`, entityType: DOCV, entityId: v.id, after: { versionNo: no, ...d } });
      return { id: v.id as string, versionNo: no };
    });
    res.status(201).json(out);
  }));
  r.post('/documents/:id/versions/:vid/submit', requirePermission('qa.document:manage'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const v = (await tx.query(`select v.id, v.status, v.version_no, v.file_id, d.code, d.title from qa.document_versions v join qa.controlled_documents d on d.id = v.document_id where v.id = $1 and v.document_id = $2 for update of v`,
        [req.params.vid, req.params.id])).rows[0];
      if (!v) throw Errors.notFound('Version');
      if (!['Draft', 'Rejected'].includes(v.status)) throw Errors.state(`A ${v.status} version cannot be submitted.`);
      if (!v.file_id) throw Errors.rule('FILE_REQUIRED', 'Attach the document file before submitting it.');
      await setDocStatus(tx, actorOf(req), v.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: DOCV, subjectId: v.id, subjectLabel: `${v.code} v${v.version_no} — ${v.title}`, facts: {}, legalEntityId: null });
      return { approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  /** Business roles a document can require training for. */
  r.get('/roles', requirePermission('qa.document:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select code, name, department from iam.roles where not privileged order by department, name`)).rows });
  }));

  // ================================================================ training compliance (QA-011)
  r.post('/training', requirePermission('qa.training:record'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ documentVersionId: z.string().uuid(), userIds: z.array(z.string().uuid()).min(1).max(100), trainedOn: day, trainer: text(120),
      assessment: z.enum(['Pass', 'Fail']), score: z.number().min(0).max(100).optional().nullable() }), req.body);
    await withTx(db, async (tx) => {
      const v = (await tx.query(`select status from qa.document_versions where id = $1`, [d.documentVersionId])).rows[0];
      if (v?.status !== 'Effective') throw Errors.rule('NOT_EFFECTIVE', 'Training is recorded against the effective version.');
      if (d.trainedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'Training cannot be dated in the future.');
      for (const u of d.userIds) await tx.query(`insert into qa.training_records (user_id, document_version_id, trained_on, trainer, assessment, score, recorded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
        [u, d.documentVersionId, d.trainedOn, d.trainer, d.assessment, d.score ?? null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.training.recorded', entityType: DOCV, entityId: d.documentVersionId, after: d });
    });
    res.status(201).json({ ok: true });
  }));
  /** The training matrix: for every effective version that needs training, each active user holding a required role, trained or not. */
  r.get('/training/matrix', requirePermission('qa.document:view'), asyncHandler(async (req, res) => {
    const rows = (await db.query(
      `select d.id as "documentId", d.code, d.title, v.id as "versionId", v.version_no as "versionNo", u.id as "userId", u.full_name as "userName",
              string_agg(distinct tr.role_code, ', ') as roles,
              (select max(t.trained_on) from qa.training_records t where t.user_id = u.id and t.document_version_id = v.id and t.assessment = 'Pass') as "trainedOn"
         from qa.controlled_documents d join qa.document_versions v on v.document_id = d.id and v.status = 'Effective' and v.training_required
         join qa.training_requirements tr on tr.document_id = d.id join iam.roles r on r.code = tr.role_code
         join iam.user_roles ur on ur.role_id = r.id and ur.status = 'Active' join iam.users u on u.id = ur.user_id and u.status = 'Active'
        where d.status = 'Active' ${str(req.query.userId) ? 'and u.id = $1' : ''}
        group by d.id, v.id, u.id order by d.code, u.full_name`, str(req.query.userId) ? [str(req.query.userId)] : [])).rows;
    res.json({ data: rows, gaps: rows.filter((x) => !x.trainedOn).length });
  }));

  // ================================================================ audits (QA-010)
  const audSel = `select a.id, a.doc_no as "docNo", a.audit_type as "auditType", a.title, a.scope, a.party_id as "partyId", p.legal_name as "partyName", a.auditor, a.planned_date as "plannedDate",
      a.status, a.summary, cu.full_name as "closedBy", a.closed_at as "closedAt", a.created_at as "createdAt",
      (select count(*)::int from qa.audit_findings f where f.audit_id = a.id) as findings,
      (select count(*)::int from qa.audit_findings f where f.audit_id = a.id and f.classification in ('MAJOR','CRITICAL') and f.capa_id is null) as "openMajor"
    from qa.audits a left join mdm.parties p on p.id = a.party_id left join iam.users cu on cu.id = a.closed_by`;
  r.get('/audits', requirePermission('qa.audit:view'), asyncHandler(async (_req, res) => { res.json({ data: (await db.query(`${audSel} order by a.planned_date desc`)).rows }); }));
  r.get('/audits/:id', requirePermission('qa.audit:view'), asyncHandler(async (req, res) => {
    const a = (await db.query(`${audSel} where a.id = $1`, [req.params.id])).rows[0];
    if (!a) throw Errors.notFound('Audit');
    const findings = (await db.query(`select f.id, f.seq, f.classification, f.clause, f.description, f.capa_id as "capaId", c.doc_no as "capaNo" from qa.audit_findings f left join qa.capas c on c.id = f.capa_id where f.audit_id = $1 order by f.seq`, [a.id])).rows;
    res.json({ ...a, findingList: findings, canManage: can(req, 'qa.audit:manage') && a.status !== 'Closed' });
  }));
  r.post('/audits', requirePermission('qa.audit:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ auditType: z.enum(['INTERNAL', 'SUPPLIER', 'CUSTOMER', 'REGULATORY']), title: text(200), scope: text(1000), partyId: z.string().uuid().optional().nullable(), auditor: text(120), plannedDate: day })
      .refine((x) => x.auditType !== 'SUPPLIER' || !!x.partyId, { message: 'Choose the supplier audited', path: ['partyId'] }), req.body);
    const out = await withTx(db, async (tx) => {
      const docNo = await nextDocNo(tx, 'AUDIT');
      const a = (await tx.query(`insert into qa.audits (doc_no, audit_type, title, scope, party_id, auditor, planned_date, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [docNo, d.auditType, d.title, d.scope, d.partyId ?? null, d.auditor, d.plannedDate, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qa.audit.planned', entityType: 'qa.audit', entityId: a.id, after: { docNo, ...d } });
      return { id: a.id as string, docNo };
    });
    res.status(201).json(out);
  }));
  r.post('/audits/:id/findings', requirePermission('qa.audit:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ classification: z.enum(['OBSERVATION', 'MINOR', 'MAJOR', 'CRITICAL']), clause: z.string().trim().max(60).optional().nullable(), description: text(2000) }), req.body);
    await withTx(db, async (tx) => {
      const a = (await tx.query(`select status from qa.audits where id = $1 for update`, [req.params.id])).rows[0];
      if (!a || a.status === 'Closed') throw Errors.state('The audit is closed.');
      const seq = Number((await tx.query(`select coalesce(max(seq), 0) + 1 as n from qa.audit_findings where audit_id = $1`, [req.params.id])).rows[0].n);
      await tx.query(`insert into qa.audit_findings (audit_id, seq, classification, clause, description) values ($1,$2,$3,$4,$5)`, [req.params.id, seq, d.classification, d.clause ?? null, d.description]);
      await tx.query(`update qa.audits set status = 'InProgress', updated_by = $2 where id = $1 and status = 'Planned'`, [req.params.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.audit.finding', entityType: 'qa.audit', entityId: req.params.id!, after: d });
    });
    res.status(201).json({ ok: true });
  }));
  r.post('/audits/:id/findings/:fid/capa', requirePermission('qa.audit:manage'), asyncHandler(async (req, res) => {
    const { capaId } = parse(z.object({ capaId: z.string().uuid() }), req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`update qa.audit_findings set capa_id = $3 where id = $2 and audit_id = $1 returning id`, [req.params.id, req.params.fid, capaId])).rowCount;
      if (!n) throw Errors.notFound('Finding');
      await audit(tx, actorOf(req), { action: 'qa.audit.finding_capa', entityType: 'qa.audit', entityId: req.params.id!, after: { finding: req.params.fid, capaId } });
    });
    res.json({ ok: true });
  }));
  r.post('/audits/:id/close', requirePermission('qa.audit:manage'), asyncHandler(async (req, res) => {
    const { summary } = parse(z.object({ summary: text(3000) }), req.body);
    await withTx(db, async (tx) => {
      const a = (await tx.query(`${audSel} where a.id = $1 for update of a`, [req.params.id])).rows[0];
      if (!a || a.status === 'Closed') throw Errors.state('The audit is already closed.');
      if (a.openMajor) throw Errors.rule('CAPA_REQUIRED', `${a.openMajor} major or critical finding(s) need a CAPA before the audit closes.`);
      await tx.query(`update qa.audits set status = 'Closed', summary = $2, closed_by = $3, closed_at = now(), updated_by = $3 where id = $1`, [req.params.id, summary, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.audit.closed', entityType: 'qa.audit', entityId: req.params.id!, after: { summary } });
    });
    res.json({ ok: true });
  }));

  // ================================================================ risk register (QA-012)
  r.get('/risks', requirePermission('qa.risk:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select r.id, r.doc_no as "docNo", r.title, r.process_area as "processArea", r.failure_mode as "failureMode", r.effect, r.severity, r.occurrence, r.detection, r.rpn,
      r.controls, r.owner_id as "ownerId", u.full_name as owner, r.review_date as "reviewDate", r.status from qa.risks r join iam.users u on u.id = r.owner_id order by r.rpn desc, r.doc_no`)).rows });
  }));
  const riskSchema = z.object({ title: text(200), processArea: text(80), failureMode: text(500), effect: text(500), severity: z.number().int().min(1).max(10), occurrence: z.number().int().min(1).max(10),
    detection: z.number().int().min(1).max(10), controls: z.string().trim().max(1000).optional().nullable(), ownerId: z.string().uuid(), reviewDate: day,
    status: z.enum(['Open', 'Mitigated', 'Accepted']).default('Open') });
  r.post('/risks', requirePermission('qa.risk:manage'), asyncHandler(async (req, res) => {
    const d = parse(riskSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const docNo = await nextDocNo(tx, 'RISK');
      const row = (await tx.query(`insert into qa.risks (doc_no, title, process_area, failure_mode, effect, severity, occurrence, detection, controls, owner_id, review_date, status, created_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) returning id, rpn`, [docNo, d.title, d.processArea, d.failureMode, d.effect, d.severity, d.occurrence, d.detection, d.controls ?? null, d.ownerId, d.reviewDate, d.status, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qa.risk.created', entityType: 'qa.risk', entityId: row.id, after: { docNo, ...d } });
      return { id: row.id as string, docNo, rpn: row.rpn as number };
    });
    res.status(201).json(out);
  }));
  r.put('/risks/:id', requirePermission('qa.risk:manage'), asyncHandler(async (req, res) => {
    const d = parse(riskSchema, req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`update qa.risks set title=$2, process_area=$3, failure_mode=$4, effect=$5, severity=$6, occurrence=$7, detection=$8, controls=$9, owner_id=$10, review_date=$11, status=$12, updated_by=$13 where id = $1`,
        [req.params.id, d.title, d.processArea, d.failureMode, d.effect, d.severity, d.occurrence, d.detection, d.controls ?? null, d.ownerId, d.reviewDate, d.status, req.auth!.user.id])).rowCount;
      if (!n) throw Errors.notFound('Risk');
      await audit(tx, actorOf(req), { action: 'qa.risk.updated', entityType: 'qa.risk', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));

  // ================================================================ line clearance (QA-017)
  const checklistSchema = z.object({ previousMaterialRemoved: z.boolean(), lineCleaned: z.boolean(), labelsReconciled: z.boolean(), documentsInPlace: z.boolean(), equipmentReady: z.boolean() });
  r.get('/line-clearances', requirePermission('qa.clearance:view'), asyncHandler(async (req, res) => {
    const args: unknown[] = []; const where = ['true'];
    if (str(req.query.lineId)) { args.push(str(req.query.lineId)); where.push(`c.line_id = $${args.length}`); }
    res.json({ data: (await db.query(`select c.id, c.line_id as "lineId", ln.code as "lineCode", ln.name as "lineName", c.purpose, c.checklist, c.outcome, c.remarks, u.full_name as "clearedBy", c.cleared_at as "clearedAt",
      b.batch_no as "usedByBatch", p.doc_no as "usedByPacking" from mfg.line_clearances c join mfg.lines ln on ln.id = c.line_id join iam.users u on u.id = c.cleared_by
      left join mfg.batches b on b.id = c.used_by_batch left join mfg.packing_runs p on p.id = c.used_by_packing where ${where.join(' and ')} order by c.cleared_at desc limit 200`, args)).rows });
  }));
  r.post('/line-clearances', requirePermission('qa.clearance:record'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ lineId: z.string().uuid(), purpose: z.enum(['BATCH', 'PACKING']), checklist: checklistSchema, remarks: z.string().trim().max(1000).optional().nullable() }), req.body);
    const out = await withTx(db, async (tx) => {
      const ln = (await tx.query(`select status from mfg.lines where id = $1`, [d.lineId])).rows[0];
      if (ln?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active line.');
      const outcome = Object.values(d.checklist).every(Boolean) ? 'Cleared' : 'NotCleared';
      if (outcome === 'NotCleared' && !d.remarks) throw Errors.rule('REASON_REQUIRED', 'Say what is not ready.');
      const row = (await tx.query(`insert into mfg.line_clearances (line_id, purpose, checklist, outcome, remarks, cleared_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [d.lineId, d.purpose, JSON.stringify(d.checklist), outcome, d.remarks ?? null, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'mfg.line.clearance', entityType: 'mfg.line', entityId: d.lineId, after: { ...d, outcome } });
      return { id: row.id as string, outcome };
    });
    res.status(201).json(out);
  }));

  // ================================================================ QC and QA dashboards (QC-002, QA-002)
  r.get('/dashboard', requirePermission('qa.capa:view'), asyncHandler(async (_req, res) => {
    const today = todayIST();
    const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0];
    const qc = await one(`select
        (select count(*)::int from qc.inspections where status in ('Pending','Sampled','Tested','Hold')) as "openInspections",
        (select count(*)::int from qc.inspections where status in ('Pending','Sampled','Tested') and created_at < now() - interval '2 days') as "olderThan2Days",
        (select count(*)::int from qc.oos_cases where status <> 'Closed') as "openOos",
        (select count(*)::int from qc.instruments where status = 'Active' and (calibration_due is null or calibration_due < $1::date)) as "instrumentsOverdue",
        (select count(*)::int from qc.instruments where status = 'Active' and calibration_due between $1::date and $1::date + 15) as "instrumentsDueSoon",
        (select count(*)::int from qc.ipqc_tests where status = 'Pending') as "ipqcPending",
        (select round(avg(extract(epoch from decided_at - created_at) / 3600.0)::numeric, 1) from qc.inspections where decided_at > now() - interval '90 days') as "avgTurnaroundHours",
        (select round(100.0 * count(*) filter (where not exists (select 1 from qc.oos_cases o where o.inspection_id = q.id)) / nullif(count(*), 0), 1)
           from qc.inspections q where q.decided_at > now() - interval '90 days') as "firstTimeRightPct"`, [today]);
    const qa = await one(`select
        (select count(*)::int from qa.deviations where status = 'Open') as "openDeviations",
        (select count(*)::int from qa.capas where status in ('Open','EffectivenessCheck')) as "openCapa",
        (select count(*)::int from qa.capas where status in ('Open','EffectivenessCheck') and due_date < $1::date) as "overdueCapa",
        (select count(*)::int from qa.complaints where status <> 'Closed') as "openComplaints",
        (select count(*)::int from qa.non_conformances where status = 'Open') as "openNc",
        (select count(*)::int from qa.change_requests where status in ('Submitted','Approved','Implemented')) as "changesInFlight",
        (select count(*)::int from inv.lots where source_type = 'PRODUCTION' and qa_disposition is null and qc_status = 'Quarantine') as "awaitingRelease",
        (select count(*)::int from qa.recalls where initiated_at > date_trunc('year', now())) as "recallsThisYear",
        (select count(*)::int from qa.document_versions where status = 'Effective' and review_due <= $1::date + 30) as "reviewsDue",
        (select count(*)::int from qa.risks where status = 'Open' and rpn >= 100) as "highRisks"`, [today]);
    const gaps = Number((await db.query(`select count(*) from (
        select v.id, u.id from qa.controlled_documents d join qa.document_versions v on v.document_id = d.id and v.status = 'Effective' and v.training_required
          join qa.training_requirements tr on tr.document_id = d.id join iam.roles r on r.code = tr.role_code join iam.user_roles ur on ur.role_id = r.id and ur.status = 'Active'
          join iam.users u on u.id = ur.user_id and u.status = 'Active'
         where d.status = 'Active' and not exists (select 1 from qa.training_records t where t.user_id = u.id and t.document_version_id = v.id and t.assessment = 'Pass')
         group by v.id, u.id) x`)).rows[0].count);
    res.json({ qc, qa: { ...qa, trainingGaps: gaps } });
  }));

  return r;
}
