import { Router, type Request } from 'express';
import { z } from 'zod';
import { bomSchema, bomVersionSchema, reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

/**
 * BOM / formulation master (BRD p.18 sub-module 5; MP §12.4; MFG-006, MFG-009).
 * A formulation belongs to one output item. Its versions carry the recipe per batch (kg/MT ratios, temperature, reaction time,
 * standard yield, dosing tolerance per ingredient and approved substitutes). A version is approved by the plant head and then QA,
 * and becomes effective on its date; approving it closes the previous version the day before. Approved versions never change.
 */
const SUBJECT = 'mfg.bom_version';
const P = (a: string) => `mfg.bom:${a}`;
const EDITABLE = ['Draft', 'Rejected'];
const INPUT_TYPES = ['RM', 'SEMI'];
type VersionInput = z.infer<typeof bomVersionSchema>;

const dayBefore = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/** The approved version in force for an item on a date (used when a production order is released). */
export async function effectiveBomVersion(dbx: Db | Tx, itemId: string, onDate: string) {
  return (await dbx.query(
    `select v.id, v.bom_id as "bomId", b.code as "bomCode", v.version_no as "versionNo", v.batch_size as "batchSize", v.batch_uom as "batchUom",
            v.standard_yield_pct as "standardYieldPct", v.effective_from as "effectiveFrom", v.effective_to as "effectiveTo"
       from mfg.bom_versions v join mfg.boms b on b.id = v.bom_id
      where b.item_id = $1 and b.status = 'Active' and v.status = 'Approved' and v.effective_from <= $2 and (v.effective_to is null or v.effective_to >= $2)`,
    [itemId, onDate])).rows[0] ?? null;
}

const stateSql = `case when v.status <> 'Approved' then v.status
    when v.effective_from > $TODAY then 'Scheduled' when v.effective_to is not null and v.effective_to < $TODAY then 'Superseded' else 'Current' end`;
const versionCols = (today: string) => `v.id, v.bom_id as "bomId", v.version_no as "versionNo", v.batch_size as "batchSize", v.batch_uom as "batchUom",
    v.standard_yield_pct as "standardYieldPct", v.reaction_temp_c as "reactionTempC", v.reaction_time_min as "reactionTimeMin", v.process_notes as "processNotes",
    v.effective_from as "effectiveFrom", v.effective_to as "effectiveTo", v.change_note as "changeNote", v.status, v.status_reason as "statusReason",
    ${stateSql.replaceAll('$TODAY', `'${today}'::date`)} as state, v.approved_at as "approvedAt", v.created_at as "createdAt", v.created_by as "createdById",
    cu.full_name as "createdBy", v.version`;

async function setVersionStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from mfg.bom_versions where id = $1`, [id])).rows[0];
  await tx.query(`update mfg.bom_versions set status = $2, status_reason = $3, updated_by = $4, approved_at = case when $2 = 'Approved' then now() else approved_at end where id = $1`,
    [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/** Approval: close the version currently open-ended on the day before this one starts, then approve this one. */
async function approveVersion(tx: Tx, actor: Actor, id: string) {
  const v = (await tx.query(`select bom_id, effective_from::text as "from" from mfg.bom_versions where id = $1 for update`, [id])).rows[0];
  const later = (await tx.query(`select version_no from mfg.bom_versions where bom_id = $1 and status = 'Approved' and effective_from >= $2`, [v.bom_id, v.from])).rows[0];
  if (later) throw Errors.rule('EFFECTIVE_DATE_OVERLAP', `Version ${later.version_no} already starts on or after this date. Change the effective date and resubmit.`);
  const open = (await tx.query(`select id, version_no from mfg.bom_versions where bom_id = $1 and status = 'Approved' and (effective_to is null or effective_to >= $2)`, [v.bom_id, v.from])).rows;
  for (const o of open) {
    await tx.query(`update mfg.bom_versions set effective_to = $2, updated_by = $3 where id = $1`, [o.id, dayBefore(v.from), actor.userId]);
    await audit(tx, actor, { action: `${SUBJECT}.superseded`, entityType: SUBJECT, entityId: o.id, after: { effectiveTo: dayBefore(v.from) }, reason: 'Superseded by a newer approved version' });
  }
  await setVersionStatus(tx, actor, id, 'Approved');
}

export function bomRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, r, a) => approveVersion(tx, a, r.subject_id),
    onRejected: (tx, r, a) => setVersionStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setVersionStatus(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setVersionStatus(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  const r = Router();

  async function loadBom(dbx: Db | Tx, id: string, lock = false) {
    const b = (await dbx.query(
      `select b.id, b.code, b.name, b.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType", i.base_uom as "itemUom",
              b.status, b.version from mfg.boms b join mdm.items i on i.id = b.item_id where b.id = $1 ${lock ? 'for update of b' : ''}`, [id])).rows[0];
    if (!b) throw Errors.notFound('Formulation');
    return b;
  }
  async function loadVersion(dbx: Db | Tx, bomId: string, vid: string, lock = false) {
    const v = (await dbx.query(`select ${versionCols(todayIST())} from mfg.bom_versions v join iam.users cu on cu.id = v.created_by
      where v.id = $1 and v.bom_id = $2 ${lock ? 'for update of v' : ''}`, [vid, bomId])).rows[0];
    if (!v) throw Errors.notFound('Formulation version');
    return v;
  }

  /** Checks ingredients and substitutes: approved raw or semi-finished materials, never the output item; units from the item. */
  async function validateLines(tx: Tx, outputItemId: string, d: VersionInput) {
    const ids = [...new Set(d.lines.flatMap((l) => [l.itemId, ...l.alternates.map((a) => a.itemId)]))];
    const items = new Map((await tx.query(`select id, code, item_type, status, base_uom from mdm.items where id = any($1::uuid[])`, [ids])).rows.map((i) => [i.id, i]));
    return d.lines.map((l, idx) => {
      const n = idx + 1;
      for (const id of [l.itemId, ...l.alternates.map((a) => a.itemId)]) {
        const it = items.get(id);
        if (id === outputItemId) throw Errors.rule('INVALID_INGREDIENT', `Line ${n}: a formulation cannot consume its own output item.`);
        if (it?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', `Line ${n}: only approved items can be used.`);
        if (!INPUT_TYPES.includes(it.item_type)) throw Errors.rule('INVALID_INGREDIENT', `Line ${n}: ${it.code} is ${it.item_type}; ingredients must be raw or semi-finished materials (packaging is planned with the packing run).`);
      }
      return { ...l, lineNo: n, uom: items.get(l.itemId)!.base_uom as string };
    });
  }
  async function writeLines(tx: Tx, vid: string, lines: Awaited<ReturnType<typeof validateLines>>) {
    await tx.query(`delete from mfg.bom_lines where bom_version_id = $1`, [vid]);
    for (const l of lines) {
      const row = (await tx.query(`insert into mfg.bom_lines (bom_version_id, line_no, step_no, item_id, qty, uom, tolerance_pct, notes) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [vid, l.lineNo, l.stepNo, l.itemId, l.qty, l.uom, l.tolerancePct, l.notes])).rows[0];
      for (const a of l.alternates) {
        await tx.query(`insert into mfg.bom_alternates (bom_line_id, item_id, factor, notes) values ($1,$2,$3,$4)`, [row.id, a.itemId, a.factor, a.notes]);
      }
    }
  }
  function actions(req: Request, v: { status: string; createdById: string }) {
    const out: string[] = [];
    if (EDITABLE.includes(v.status) && can(req, P('edit'))) out.push('edit');
    if (EDITABLE.includes(v.status) && can(req, P('submit'))) out.push('submit');
    if (EDITABLE.includes(v.status) && can(req, P('edit'))) out.push('withdraw');
    if (can(req, P('create'))) out.push('copy');
    return out;
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const today = todayIST();
    const args: unknown[] = [today];
    const where = ['true'];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(b.code ilike $${args.length} or b.name ilike $${args.length} or i.code ilike $${args.length} or i.name ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status === 'Pending') where.push(`exists (select 1 from mfg.bom_versions x where x.bom_id = b.id and x.status = 'Submitted')`);
    else if (status === 'No current version') where.push(`cur.id is null`);
    else if (status) { args.push(status); where.push(`b.status = $${args.length}`); }
    const rows = (await db.query(
      `select count(*) over() as total, b.id, b.code, b.name, b.status, i.code as "itemCode", i.name as "itemName", i.item_type as "itemType",
              cur.version_no as "currentVersion", cur.batch_size as "batchSize", cur.batch_uom as "batchUom", cur.standard_yield_pct as "standardYieldPct",
              cur.effective_from as "effectiveFrom",
              (select count(*)::int from mfg.bom_versions x where x.bom_id = b.id) as "versionCount",
              (select count(*)::int from mfg.bom_versions x where x.bom_id = b.id and x.status = 'Submitted') as "pendingCount",
              (select count(*)::int from mfg.bom_lines l where l.bom_version_id = cur.id) as "ingredientCount"
         from mfg.boms b join mdm.items i on i.id = b.item_id
         left join mfg.bom_versions cur on cur.bom_id = b.id and cur.status = 'Approved' and cur.effective_from <= $1 and (cur.effective_to is null or cur.effective_to >= $1)
        where ${where.join(' and ')} order by b.code limit ${limit} offset ${offset}`, args)).rows;
    res.json({ data: rows.map(({ total: _t, ...x }) => x), total: Number(rows[0]?.total ?? 0) });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(bomSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const item = (await tx.query(`select status, item_type from mdm.items where id = $1`, [d.itemId])).rows[0];
      if (item?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an approved item to produce.');
      if (!['FG', 'SEMI'].includes(item.item_type)) throw Errors.rule('INVALID_OUTPUT', 'Formulations produce finished goods or semi-finished materials.');
      if ((await tx.query(`select 1 from mfg.boms where item_id = $1`, [d.itemId])).rowCount) throw Errors.conflict('DUPLICATE', 'This item already has a formulation. Add a new version to it instead.');
      if ((await tx.query(`select 1 from mfg.boms where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Formulation code ${d.code} is already used.`);
      const row = (await tx.query(`insert into mfg.boms (item_id, code, name, created_by, updated_by) values ($1,$2,$3,$4,$4) returning id`,
        [d.itemId, d.code, d.name, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'mfg.bom.created', entityType: 'mfg.bom', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));

  /** Approval links carry only the version id; this finds its formulation. */
  r.get('/versions/:vid', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const v = (await db.query(`select bom_id as "bomId" from mfg.bom_versions where id = $1`, [req.params.vid])).rows[0];
    if (!v) throw Errors.notFound('Formulation version');
    res.json(v);
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const b = await loadBom(db, req.params.id!);
    const versions = (await db.query(`select ${versionCols(todayIST())},
        (select count(*)::int from mfg.bom_lines l where l.bom_version_id = v.id) as "ingredientCount"
      from mfg.bom_versions v join iam.users cu on cu.id = v.created_by where v.bom_id = $1 order by v.version_no desc`, [b.id])).rows;
    res.json({ ...b, versions, canCreateVersion: can(req, P('create')) });
  }));

  r.get('/:id/versions/:vid', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const b = await loadBom(db, req.params.id!);
    const v = await loadVersion(db, b.id, req.params.vid!);
    const lines = (await db.query(
      `select l.id, l.line_no as "lineNo", l.step_no as "stepNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType",
              l.qty, l.uom, l.tolerance_pct as "tolerancePct", l.notes,
              coalesce((select json_agg(json_build_object('itemId', a.item_id, 'itemCode', ai.code, 'itemName', ai.name, 'factor', a.factor, 'notes', a.notes) order by ai.code)
                from mfg.bom_alternates a join mdm.items ai on ai.id = a.item_id where a.bom_line_id = l.id), '[]'::json) as alternates
         from mfg.bom_lines l join mdm.items i on i.id = l.item_id where l.bom_version_id = $1 order by l.step_no, l.line_no`, [v.id])).rows;
    const inputTotal = lines.reduce((a, l) => a + (l.uom === v.batchUom ? Number(l.qty) : 0), 0);
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, a.rule_name as "ruleName",
              (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'kind', s.step_kind, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, v.id])).rows[0] ?? null;
    res.json({ bom: b, ...v, lines, inputTotal, approval, allowedActions: actions(req, v) });
  }));

  r.post('/:id/versions', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(bomVersionSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const b = await loadBom(tx, req.params.id!, true);
      if (b.status !== 'Active') throw Errors.state('This formulation is inactive.');
      if ((await tx.query(`select 1 from mfg.bom_versions where bom_id = $1 and status in ('Draft','Submitted','Rejected')`, [b.id])).rowCount) {
        throw Errors.state('Finish or withdraw the open draft of this formulation before starting another version.');
      }
      const lines = await validateLines(tx, b.itemId, d);
      const no = Number((await tx.query(`select coalesce(max(version_no), 0) + 1 as n from mfg.bom_versions where bom_id = $1`, [b.id])).rows[0].n);
      const v = (await tx.query(
        `insert into mfg.bom_versions (bom_id, version_no, batch_size, batch_uom, standard_yield_pct, reaction_temp_c, reaction_time_min, process_notes, effective_from, change_note, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
        [b.id, no, d.batchSize, b.itemUom, d.standardYieldPct, d.reactionTempC ?? null, d.reactionTimeMin ?? null, d.processNotes, d.effectiveFrom, d.changeNote, req.auth!.user.id])).rows[0];
      await writeLines(tx, v.id, lines);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: v.id, after: { bom: b.code, versionNo: no, ...d } });
      return { id: v.id as string, versionNo: no };
    });
    res.status(201).json(out);
  }));

  r.put('/:id/versions/:vid', requirePermission(P('edit')), asyncHandler(async (req, res) => {
    const d = parse(bomVersionSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const b = await loadBom(tx, req.params.id!);
      const v = await loadVersion(tx, b.id, req.params.vid!, true);
      if (!EDITABLE.includes(v.status)) throw Errors.state(`A ${v.status} version cannot be changed. Start a new version instead.`);
      if (v.version !== d.version) throw Errors.concurrent();
      const lines = await validateLines(tx, b.itemId, d);
      await tx.query(`update mfg.bom_versions set batch_size=$2, standard_yield_pct=$3, reaction_temp_c=$4, reaction_time_min=$5, process_notes=$6, effective_from=$7, change_note=$8, updated_by=$9 where id = $1`,
        [v.id, d.batchSize, d.standardYieldPct, d.reactionTempC ?? null, d.reactionTimeMin ?? null, d.processNotes, d.effectiveFrom, d.changeNote, req.auth!.user.id]);
      await writeLines(tx, v.id, lines);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: v.id, after: d });
    });
    res.json({ ok: true });
  }));

  // MFG-006: plant head, then QA (doc 07 §6). The date must be today or later and after the version in force.
  r.post('/:id/versions/:vid/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const b = await loadBom(tx, req.params.id!);
      const v = await loadVersion(tx, b.id, req.params.vid!, true);
      if (!EDITABLE.includes(v.status)) throw Errors.state(`Only a Draft or Rejected version can be submitted (this one is ${v.status}).`);
      if (String(v.effectiveFrom) < todayIST()) throw Errors.rule('INVALID_DATE', 'The effective date has passed. Edit the version and choose today or a later date.');
      const later = (await tx.query(`select version_no from mfg.bom_versions where bom_id = $1 and status = 'Approved' and effective_from >= $2`, [b.id, v.effectiveFrom])).rows[0];
      if (later) throw Errors.rule('EFFECTIVE_DATE_OVERLAP', `Version ${later.version_no} already starts on or after ${v.effectiveFrom}. Choose a later effective date.`);
      const stale = (await tx.query(`select i.code from mfg.bom_lines l join mdm.items i on i.id = l.item_id where l.bom_version_id = $1 and i.status <> 'Active'`, [v.id])).rows;
      if (stale.length) throw Errors.rule('REFERENCE_NOT_ACTIVE', `No longer active: ${stale.map((x) => x.code).join(', ')}. Edit the version.`);
      const count = Number((await tx.query(`select count(*) from mfg.bom_lines where bom_version_id = $1`, [v.id])).rows[0].count);
      await setVersionStatus(tx, actorOf(req), v.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), {
        subjectType: SUBJECT, subjectId: v.id, subjectLabel: `${b.code} v${v.versionNo} — ${b.itemName}`,
        facts: { ingredientCount: count, batchSize: Number(v.batchSize), firstVersion: v.versionNo === 1 }, legalEntityId: null,
      });
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  r.post('/:id/versions/:vid/withdraw', requirePermission(P('edit')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const b = await loadBom(tx, req.params.id!);
      const v = await loadVersion(tx, b.id, req.params.vid!, true);
      if (!EDITABLE.includes(v.status)) throw Errors.state(`A ${v.status} version cannot be withdrawn.`);
      await setVersionStatus(tx, actorOf(req), v.id, 'Withdrawn', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
