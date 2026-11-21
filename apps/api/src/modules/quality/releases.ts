import { Router, type Request } from 'express';
import { z } from 'zod';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';

/**
 * QA batch review and finished-goods release (BRD p.4, p.16; MP §14.2; QA-003, QA-004; TC-13; D04 provisional: the QA head only).
 * Release needs: QC results approved → batch record complete (latest IPQC passed) → no open deviation of the batch →
 * every dosed lot released by QC (quarantine override, D33) → the releaser did not run the batch (SOD-07).
 * Dispositions: Released (saleable), On hold, Rejected, Rework authorised.
 */
const P = (a: string) => `qa.release:${a}`;
const DECISIONS = ['Released', 'OnHold', 'Rejected', 'ReworkAuthorised'] as const;
const dispositionSchema = z.object({ decision: z.enum(DECISIONS), remarks: z.string().trim().max(1000).optional().default(''), bmrReviewed: z.boolean().default(false) })
  .refine((d) => d.decision === 'Released' || d.remarks.length > 0, { message: 'Give the reason for this disposition', path: ['remarks'] });
const MOVE: Record<string, { bucket: string; txn: string; lot: string }> = {
  Released: { bucket: 'UNRESTRICTED', txn: 'QA_RELEASE', lot: 'Released' },
  OnHold: { bucket: 'BLOCKED', txn: 'QA_HOLD', lot: 'Hold' },
  ReworkAuthorised: { bucket: 'BLOCKED', txn: 'QA_HOLD', lot: 'Hold' },
  Rejected: { bucket: 'REJECTED', txn: 'QA_REJECT', lot: 'Rejected' },
};

/** Everything QA reviews for one finished-goods lot, with the blockers to release. */
export async function batchReview(dbx: Db | Tx, lotId: string, userId?: string) {
  const lot = (await dbx.query(
    `select l.id, l.lot_no as "lotNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, l.mfg_date as "mfgDate", l.expiry_date as "expiryDate",
            l.qc_status as "qcStatus", l.qa_disposition as "qaDisposition", b.id as "batchId", b.batch_no as "batchNo", b.status as "batchStatus", b.planned_qty as "plannedQty",
            b.output_qty as "outputQty", b.yield_pct as "yieldPct", b.started_by as "startedById", b.completed_by as "completedById", su.full_name as "startedBy", cu.full_name as "completedBy",
            b.started_at as "startedAt", b.completed_at as "completedAt", b.unaccounted_qty as "unaccountedQty", b.balance_basis as "balanceBasis", b.operators,
            o.id as "orderId", o.doc_no as "orderNo", bv.standard_yield_pct as "standardYieldPct", bm.code as "bomCode", bv.version_no as "bomVersionNo",
            qi.id as "inspectionId", qi.doc_no as "inspectionNo", qi.status as "inspectionStatus", tu.full_name as "testedBy", du.full_name as "qcDecidedBy",
            coalesce((select sum(qty) from inv.stock_ledger s where s.lot_id = l.id), 0) as "onHand"
       from inv.lots l join mdm.items i on i.id = l.item_id join mfg.batches b on b.id = l.source_id and l.source_type = 'PRODUCTION'
       join mfg.production_orders o on o.id = b.production_order_id left join mfg.bom_versions bv on bv.id = o.bom_version_id left join mfg.boms bm on bm.id = bv.bom_id
       join iam.users su on su.id = b.started_by left join iam.users cu on cu.id = b.completed_by
       left join qc.inspections qi on qi.lot_id = l.id left join iam.users tu on tu.id = qi.tested_by left join iam.users du on du.id = qi.decided_by
      where l.id = $1`, [lotId])).rows[0];
  if (!lot) throw Errors.notFound('Finished-goods lot');
  const results = lot.inspectionId ? (await dbx.query(`select parameter, specification, result, pass from qc.inspection_results where inspection_id = $1 order by seq`, [lot.inspectionId])).rows : [];
  const ipqc = (await dbx.query(`select doc_no as "docNo", stage, status from qc.ipqc_tests where batch_id = $1 and status <> 'Cancelled' order by requested_at`, [lot.batchId])).rows;
  const inputs = (await dbx.query(
    `select l.id as "lotId", l.lot_no as "lotNo", i.code as "itemCode", i.base_uom as uom, sum(c.qty) as qty, l.qc_status as "qcStatus", l.source_type as "sourceType"
       from mfg.batch_consumptions c join inv.lots l on l.id = c.lot_id join mdm.items i on i.id = c.item_id where c.batch_id = $1
      group by l.id, i.code, i.base_uom order by i.code`, [lot.batchId])).rows;
  const deviations = (await dbx.query(
    `select d.id, d.doc_no as "docNo", d.category, d.title, d.status from qa.deviations d
      where (d.source_type = 'mfg.batch' and d.source_id = $1)
         or d.id in (select deviation_id from mfg.batch_consumptions where batch_id = $1 and deviation_id is not null)
         or d.id in (select deviation_id from qc.ipqc_tests where batch_id = $1 and deviation_id is not null)
         or (d.category = 'QUARANTINE_OVERRIDE' and d.lot_id in (select lot_id from mfg.batch_consumptions where batch_id = $1))
      order by d.created_at`, [lot.batchId])).rows;
  const history = (await dbx.query(
    `select d.decision, d.remarks, d.decided_at as "decidedAt", u.full_name as "decidedBy" from qa.batch_dispositions d join iam.users u on u.id = d.decided_by where d.lot_id = $1 order by d.decided_at`,
    [lotId])).rows;
  const lastIpqc = ipqc[ipqc.length - 1];
  const checklist = {
    qcApproved: lot.inspectionStatus === 'QcApproved',
    batchRecordComplete: lot.batchStatus === 'Completed' && lastIpqc?.status === 'Passed',
    deviationsClosed: deviations.every((d) => d.status === 'Closed'),
    inputLotsReleased: inputs.every((x) => x.qcStatus === 'Released'),
    independentReleaser: !userId || (userId !== lot.startedById && userId !== lot.completedById),
  };
  const blockers: { code: string; message: string }[] = [];
  if (!checklist.qcApproved) blockers.push({ code: 'QC_NOT_APPROVED', message: `QC has not approved the results (${lot.inspectionNo ?? 'no inspection'} is ${lot.inspectionStatus ?? '—'}).` });
  if (!checklist.batchRecordComplete) blockers.push({ code: 'BATCH_RECORD_INCOMPLETE', message: 'The batch record is incomplete: the batch must be completed with a passed in-process test.' });
  for (const d of deviations.filter((x) => x.status !== 'Closed')) blockers.push({ code: 'OPEN_DEVIATION', message: `Deviation ${d.docNo} is open: ${d.title}.` });
  for (const x of inputs.filter((i) => i.qcStatus !== 'Released')) blockers.push({ code: 'INPUT_LOT_NOT_RELEASED', message: `Input lot ${x.lotNo} (${x.itemCode}) is ${x.qcStatus === 'Quarantine' ? 'still in quarantine' : x.qcStatus.toLowerCase()}.` });
  if (!checklist.independentReleaser) blockers.push({ code: 'SOD', message: 'You ran this batch; another QA authority must release it (SOD-07).' });
  return { ...lot, results, ipqc, inputs, deviations, history, checklist, blockers };
}

async function moveLot(tx: Tx, actor: Actor, lotId: string, itemId: string, to: string, txn: string, sourceId: string) {
  const held = (await tx.query(`select warehouse_id, bucket, sum(qty) as qty, sum(qty * unit_cost) / nullif(sum(qty), 0) as cost from inv.stock_ledger
                                  where lot_id = $1 group by warehouse_id, bucket having sum(qty) > 0`, [lotId])).rows;
  for (const h of held) {
    if (h.bucket === to) continue;
    await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by) values
                    ($1,$2,$3,$4,$5,$6,$7,'qa.batch_disposition',$8,$9), ($1,$2,$3,$10,$11,$6,$7,'qa.batch_disposition',$8,$9)`,
    [itemId, lotId, h.warehouse_id, h.bucket, -Number(h.qty), Number(h.cost ?? 0), txn, sourceId, actor.userId, to, Number(h.qty)]);
  }
}

export function qaReleaseRoutes(db: Db) {
  const r = Router();

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const view = str(req.query.status) ?? 'pending';
    const rows = (await db.query(
      `select l.id, l.lot_no as "lotNo", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, l.qc_status as "qcStatus", l.qa_disposition as "qaDisposition",
              b.id as "batchId", b.output_qty as "outputQty", b.yield_pct as "yieldPct", b.completed_at as "completedAt", o.doc_no as "orderNo", qi.status as "inspectionStatus",
              (select count(*)::int from qa.deviations d where d.status = 'Open' and ((d.source_type = 'mfg.batch' and d.source_id = b.id)
                 or d.id in (select deviation_id from mfg.batch_consumptions where batch_id = b.id) or d.id in (select deviation_id from qc.ipqc_tests where batch_id = b.id)
                 or (d.category = 'QUARANTINE_OVERRIDE' and d.lot_id in (select lot_id from mfg.batch_consumptions where batch_id = b.id)))) as "openDeviations"
         from inv.lots l join mdm.items i on i.id = l.item_id join mfg.batches b on b.id = l.source_id and l.source_type = 'PRODUCTION'
         join mfg.production_orders o on o.id = b.production_order_id left join qc.inspections qi on qi.lot_id = l.id
        where ${view === 'pending' ? `coalesce(l.qa_disposition, 'OnHold') in ('OnHold','ReworkAuthorised') and l.qc_status <> 'Rejected'` : `l.qa_disposition is not null`}
        order by b.completed_at desc nulls last limit 200`)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.get('/:lotId', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const rv = await batchReview(db, req.params.lotId!, req.auth!.user.id);
    const decided = ['Released', 'Rejected'].includes(rv.qaDisposition ?? '');
    res.json({ ...rv, allowedDecisions: can(req, P('decide')) && !decided ? DECISIONS.filter((d) => d !== 'Released' || rv.blockers.length === 0) : [] });
  }));

  // TC-13: "Released" with any blocker returns QA_RELEASE_BLOCKED listing them; the other dispositions need a reason
  r.post('/:lotId/disposition', requirePermission(P('decide')), asyncHandler(async (req: Request, res) => {
    const d = parse(dispositionSchema, req.body);
    const out = await withTx(db, async (tx) => {
      await tx.query(`select id from inv.lots where id = $1 for update`, [req.params.lotId]);
      const rv = await batchReview(tx, req.params.lotId!, req.auth!.user.id);
      if (['Released', 'Rejected'].includes(rv.qaDisposition ?? '')) throw Errors.state(`This lot is already ${rv.qaDisposition}.`);
      if (!rv.checklist.independentReleaser) throw Errors.sod('You ran this batch; another QA authority must decide it (SOD-07).');
      if (d.decision === 'Released') {
        if (rv.blockers.length) throw Errors.rule('QA_RELEASE_BLOCKED', `The batch cannot be released: ${rv.blockers.map((b: { message: string }) => b.message).join(' ')}`, { blockers: rv.blockers });
        if (!d.bmrReviewed) throw Errors.rule('BMR_NOT_REVIEWED', 'Confirm that you reviewed the batch record.');
      }
      const m = MOVE[d.decision]!;
      const disp = (await tx.query(`insert into qa.batch_dispositions (lot_id, batch_id, decision, remarks, checklist, decided_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [rv.id, rv.batchId, d.decision, d.remarks || null, JSON.stringify({ ...rv.checklist, bmrReviewed: d.bmrReviewed, blockers: rv.blockers }), req.auth!.user.id])).rows[0];
      await moveLot(tx, actorOf(req), rv.id, rv.itemId, m.bucket, m.txn, disp.id);
      await allowTransition(tx);
      await tx.query(`update inv.lots set qc_status = $2, qa_disposition = $3, qc_decided_by = $4, qc_decided_at = now() where id = $1`, [rv.id, m.lot, d.decision, req.auth!.user.id]);
      if (rv.inspectionId && d.decision === 'Rejected') {
        await tx.query(`update qc.inspections set status = 'Rejected', decision = 'Reject', decision_remarks = coalesce(decision_remarks, $2) where id = $1`, [rv.inspectionId, `QA: ${d.remarks}`]);
      }
      if (rv.inspectionId && d.decision === 'Released') await tx.query(`update qc.inspections set status = 'Released' where id = $1`, [rv.inspectionId]);
      await audit(tx, actorOf(req), { action: 'qa.batch.disposition', entityType: 'inv.lot', entityId: rv.id, before: { qcStatus: rv.qcStatus, qaDisposition: rv.qaDisposition },
        after: { decision: d.decision, checklist: rv.checklist }, reason: d.remarks || null });
      await emit(tx, 'inv.lot', rv.id, `qa.batch.${d.decision.toLowerCase()}`);
      return { lotNo: rv.lotNo as string, decision: d.decision, lotStatus: m.lot };
    });
    res.json(out);
  }));

  return r;
}
