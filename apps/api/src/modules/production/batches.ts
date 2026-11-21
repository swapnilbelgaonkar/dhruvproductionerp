import { Router, type Request } from 'express';
import { z } from 'zod';
import { batchCompleteSchema, batchStartSchema, dosingSchema, ipqcRequestSchema, ipqcResultsSchema, readingSchema, reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';
import { raiseDeviation } from './orders';

/**
 * Batch execution (BRD p.18 sub-modules 6–8 and 13; MP §12.5–12.6; MFG-007, MFG-008, MFG-010; TC-11).
 * Start → dosing of issued lots (tolerance per ingredient) → process readings → IPQC → completion with yield and mass balance.
 * Completion creates the finished-goods lot (number = batch number) in quarantine in the order's FG warehouse and queues it for QC;
 * QA releases it (part 4). Every lot dosed is recorded, so the lot's genealogy runs supplier lot → batch → FG lot.
 */
const SUBJECT = 'mfg.batch';
const DOSING = 'mfg.dosing_deviation';
const P = (a: string) => `mfg.batch:${a}`;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Converts a quantity between units: same unit, the item's own conversion (e.g. density), then a universal one; either direction. */
export async function convertQty(dbx: Db | Tx, itemId: string, qty: number, from: string, to: string): Promise<number | null> {
  if (from === to) return qty;
  const c = (await dbx.query(
    `select from_uom, factor, item_id from mdm.uom_conversions where (item_id = $1 or item_id is null) and ((from_uom = $2 and to_uom = $3) or (from_uom = $3 and to_uom = $2))
      order by item_id nulls last limit 1`, [itemId, from, to])).rows[0];
  if (!c) return null;
  return c.from_uom === from ? qty * Number(c.factor) : qty / Number(c.factor);
}

async function setBatchStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from mfg.batches where id = $1`, [id])).rows[0];
  await tx.query(`update mfg.batches set status = $2, status_reason = $3, updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}
async function setOrderStatus(tx: Tx, actor: Actor, id: string, status: string) {
  await allowTransition(tx);
  await tx.query(`update mfg.production_orders set status = $2, updated_by = $3 where id = $1`, [id, status, actor.userId]);
  await audit(tx, actor, { action: 'mfg.production_order.status', entityType: 'mfg.production_order', entityId: id, after: { status } });
  await emit(tx, 'mfg.production_order', id, `mfg.production_order.${status.toLowerCase()}`);
}

/** Dosing outside tolerance (TC-11): the approval of its deviation lets the batch continue; a rejection holds the batch for QA. */
async function decideDosing(tx: Tx, actor: Actor, deviationId: string, approved: boolean) {
  await tx.query(`update mfg.batch_consumptions set status = $2 where deviation_id = $1 and status = 'PendingApproval'`, [deviationId, approved ? 'Approved' : 'Rejected']);
  if (!approved) {
    const b = (await tx.query(`select distinct batch_id from mfg.batch_consumptions where deviation_id = $1`, [deviationId])).rows[0];
    if (b) await setBatchStatus(tx, actor, b.batch_id, 'OnHold', 'Dosing outside tolerance was not approved — QA decides the batch');
  }
}

/** Lot quantity with production for a requirement: issued − returned − already dosed (all batches). */
async function heldForDosing(tx: Db | Tx, orderId: string, orderMaterialId: string) {
  return (await tx.query(
    `with mv as (
       select ml.lot_id, ml.item_id, coalesce(max(rv.factor), 1) as factor,
              sum(case mm.direction when 'ISSUE' then ml.qty else -ml.qty end) as net,
              sum(ml.qty * ml.unit_cost) filter (where mm.direction = 'ISSUE') / nullif(sum(ml.qty) filter (where mm.direction = 'ISSUE'), 0) as cost
         from mfg.material_movement_lines ml join mfg.material_movements mm on mm.id = ml.movement_id left join inv.reservations rv on rv.id = ml.reservation_id
        where mm.production_order_id = $1 and ml.order_material_id = $2 group by ml.lot_id, ml.item_id)
     select mv.lot_id as "lotId", l.lot_no as "lotNo", l.qc_status as "lotStatus", mv.item_id as "itemId", i.code as "itemCode", i.base_uom as uom, mv.factor, coalesce(mv.cost, 0) as cost,
            mv.net - coalesce((select sum(c.qty) from mfg.batch_consumptions c join mfg.batches b on b.id = c.batch_id
                                where b.production_order_id = $1 and c.order_material_id = $2 and c.lot_id = mv.lot_id), 0) as available
       from mv join inv.lots l on l.id = mv.lot_id join mdm.items i on i.id = mv.item_id order by l.lot_no`, [orderId, orderMaterialId])).rows
    .map((x) => ({ ...x, factor: Number(x.factor), cost: Number(x.cost), available: r4(Number(x.available)) }));
}

const batchSelect = `select b.id, b.batch_no as "batchNo", b.production_order_id as "productionOrderId", o.doc_no as "orderNo", o.status as "orderStatus", o.planned_qty as "orderQty",
    o.item_id as "itemId", i.code as "itemCode", i.name as "itemName", b.seq, o.batch_count as "batchCount", b.planned_qty as "plannedQty", b.uom,
    b.line_id as "lineId", ln.code as "lineCode", ln.name as "lineName", b.shift_id as "shiftId", sh.code as "shiftCode", b.operators, b.status, b.status_reason as "statusReason",
    b.started_at as "startedAt", su.full_name as "startedBy", b.completed_at as "completedAt", cu.full_name as "completedBy", b.output_qty as "outputQty", b.process_loss_qty as "processLossQty",
    b.recovered_qty as "recoveredQty", b.waste_qty as "wasteQty", b.balance_basis as "balanceBasis", b.input_basis_qty as "inputBasisQty", b.unaccounted_qty as "unaccountedQty",
    b.yield_pct as "yieldPct", b.material_cost as "materialCost", b.fg_lot_id as "fgLotId", fl.lot_no as "fgLotNo", fl.qc_status as "fgLotStatus", b.completion_remarks as "completionRemarks",
    bv.standard_yield_pct as "standardYieldPct", bv.reaction_temp_c as "reactionTempC", bv.reaction_time_min as "reactionTimeMin", bv.process_notes as "processNotes",
    o.legal_entity_id as "legalEntityId", o.fg_warehouse_id as "fgWarehouseId", b.version
  from mfg.batches b join mfg.production_orders o on o.id = b.production_order_id join mdm.items i on i.id = o.item_id join mfg.lines ln on ln.id = b.line_id
  left join mfg.shifts sh on sh.id = b.shift_id join iam.users su on su.id = b.started_by left join iam.users cu on cu.id = b.completed_by
  left join inv.lots fl on fl.id = b.fg_lot_id left join mfg.bom_versions bv on bv.id = o.bom_version_id`;

export function batchRoutes(db: Db) {
  registerSubjectHandler(DOSING, {
    onApproved: (tx, r, a) => decideDosing(tx, a, r.subject_id, true),
    onRejected: (tx, r, a) => decideDosing(tx, a, r.subject_id, false),
    onReturned: (tx, r, a) => decideDosing(tx, a, r.subject_id, false),
    onCancelled: (tx, r, a) => decideDosing(tx, a, r.subject_id, false),
  });
  const r = Router();

  async function load(dbx: Db | Tx, id: string, lock = false) {
    const b = (await dbx.query(`${batchSelect} where b.id = $1 ${lock ? 'for update of b' : ''}`, [id])).rows[0];
    if (!b) throw Errors.notFound('Batch');
    return b;
  }
  /** Requirements with this batch's share, what has been dosed (requirement-equivalent) and the tolerance band. */
  async function materials(dbx: Db | Tx, b: { id: string; productionOrderId: string; plannedQty: string; orderQty: string }) {
    const share = Number(b.plannedQty) / Number(b.orderQty);
    return (await dbx.query(
      `select m.id, m.step_no as "stepNo", m.item_id as "itemId", i.code as "itemCode", i.name as "itemName", m.uom, m.tolerance_pct as "tolerancePct",
              round(m.required_qty * $2, 4) as planned,
              coalesce((select sum(c.qty / c.factor) from mfg.batch_consumptions c where c.batch_id = $1 and c.order_material_id = m.id), 0) as dosed,
              exists (select 1 from mfg.batch_consumptions c where c.batch_id = $1 and c.order_material_id = m.id and c.status in ('PendingApproval','Rejected')) as "awaitingApproval"
         from mfg.order_materials m join mdm.items i on i.id = m.item_id where m.production_order_id = $3 order by m.step_no, m.line_no`,
      [b.id, share, b.productionOrderId])).rows.map((m) => {
      const planned = Number(m.planned), dosed = r4(Number(m.dosed)), tol = Number(m.tolerancePct);
      const variancePct = planned ? r3((dosed - planned) / planned * 100) : 0;
      return { ...m, planned, dosed, variancePct, low: r4(planned * (1 - tol / 100)), high: r4(planned * (1 + tol / 100)),
        state: dosed === 0 ? 'Pending' : dosed > planned * (1 + tol / 100) + 1e-9 ? 'Over' : dosed < planned * (1 - tol / 100) - 1e-9 ? 'Under' : 'Within' };
    });
  }
  function actions(req: Request, b: { status: string }, pendingIpqc: boolean) {
    const out: string[] = [];
    if (b.status === 'InProgress' && can(req, P('execute'))) out.push('dose', 'reading', ...(pendingIpqc ? [] : ['ipqc']), 'complete', 'hold');
    if (b.status === 'OnHold' && can(req, P('execute'))) out.push('resume');
    if (['InProgress', 'OnHold'].includes(b.status) && can(req, P('scrap'))) out.push('scrap');
    return out;
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const order = str(req.query.productionOrderId);
    if (order) { args.push(order); where.push(`b.production_order_id = $${args.length}`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`b.status = $${args.length}`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(b.batch_no ilike $${args.length} or o.doc_no ilike $${args.length} or i.code ilike $${args.length})`); }
    const rows = (await db.query(`${batchSelect.replace('select b.id,', 'select count(*) over() as total, b.id,')} where ${where.join(' and ')}
      order by case b.status when 'InProgress' then 0 when 'OnHold' then 1 else 2 end, b.started_at desc limit ${limit} offset ${offset}`, args)).rows;
    res.json({ data: rows.map(({ total: _t, ...x }) => x), total: Number(rows[0]?.total ?? 0) });
  }));

  // ---------------------------------------------------------------- IPQC worklist and results (QC)
  r.get('/ipqc', requirePermission('qc.ipqc:record'), asyncHandler(async (req, res) => {
    const status = str(req.query.status) ?? 'Pending';
    const rows = (await db.query(
      `select t.id, t.doc_no as "docNo", t.stage, t.status, t.requested_at as "requestedAt", ru.full_name as "requestedBy", b.id as "batchId", b.batch_no as "batchNo",
              i.code as "itemCode", i.name as "itemName", o.doc_no as "orderNo"
         from qc.ipqc_tests t join mfg.batches b on b.id = t.batch_id join mfg.production_orders o on o.id = b.production_order_id join mdm.items i on i.id = o.item_id
         join iam.users ru on ru.id = t.requested_by where t.status = $1 order by t.requested_at`, [status])).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.post('/ipqc/:tid/results', requirePermission('qc.ipqc:record'), asyncHandler(async (req, res) => {
    const d = parse(ipqcResultsSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const t = (await tx.query(`select t.*, b.batch_no, b.production_order_id, b.status as batch_status from qc.ipqc_tests t join mfg.batches b on b.id = t.batch_id where t.id = $1 for update of t`, [req.params.tid])).rows[0];
      if (!t) throw Errors.notFound('IPQC test');
      if (t.status !== 'Pending') throw Errors.state(`This test is already ${t.status}.`);
      if (t.requested_by === req.auth!.user.id) throw Errors.sod('The person who asked for the test cannot record its results.');
      for (const [i, x] of d.results.entries()) {
        await tx.query(`insert into qc.ipqc_results (ipqc_test_id, seq, parameter, specification, result, pass) values ($1,$2,$3,$4,$5,$6)`, [t.id, i + 1, x.parameter, x.specification, x.result, x.pass]);
      }
      const passed = d.results.every((x) => x.pass);
      const dev = passed ? null : await raiseDeviation(tx, actorOf(req), {
        category: 'IPQC_FAILURE', title: `In-process QC failed — batch ${t.batch_no} (${t.stage})`, orderId: t.production_order_id, sourceType: 'qc.ipqc_test', sourceId: t.id,
        description: `${t.doc_no}: ${d.results.filter((x) => !x.pass).map((x) => `${x.parameter} ${x.result} (spec ${x.specification})`).join('; ')}.${d.remarks ? ` ${d.remarks}` : ''}`,
      });
      await allowTransition(tx);
      await tx.query(`update qc.ipqc_tests set status = $2, tested_at = now(), tested_by = $3, remarks = $4, deviation_id = $5, updated_by = $3 where id = $1`,
        [t.id, passed ? 'Passed' : 'Failed', req.auth!.user.id, d.remarks, dev?.id ?? null]);
      await audit(tx, actorOf(req), { action: 'qc.ipqc.recorded', entityType: 'qc.ipqc_test', entityId: t.id, after: { passed, results: d.results } });
      await emit(tx, SUBJECT, t.batch_id, `qc.ipqc.${passed ? 'passed' : 'failed'}`);
      return { status: passed ? 'Passed' : 'Failed', deviationNo: dev?.docNo ?? null };
    });
    res.json(out);
  }));

  // ---------------------------------------------------------------- batches
  r.post('/', requirePermission(P('execute')), asyncHandler(async (req, res) => {
    const d = parse(batchStartSchema.and(z.object({ productionOrderId: z.string().uuid() })), req.body);
    const out = await withTx(db, async (tx) => {
      const o = (await tx.query(`select o.*, ln.status as line_status from mfg.production_orders o join mfg.lines ln on ln.id = o.line_id where o.id = $1 for update of o`, [d.productionOrderId])).rows[0];
      if (!o) throw Errors.notFound('Production order');
      if (!['Released', 'InProgress'].includes(o.status)) throw Errors.state(`A batch can be started only on a released order (this one is ${o.status}).`);
      if (o.line_status !== 'Active') throw Errors.rule('LINE_INACTIVE', 'The production line is inactive.');
      if (d.shiftId && !(await tx.query(`select 1 from mfg.shifts where id = $1 and plant_id = $2 and status = 'Active'`, [d.shiftId, o.plant_id])).rowCount) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active shift of the plant.');
      const open = (await tx.query(`select batch_no from mfg.batches where production_order_id = $1 and status in ('InProgress','OnHold')`, [o.id])).rows[0];
      if (open) throw Errors.state(`Batch ${open.batch_no} of this order is still open. Complete it first.`);
      const used = (await tx.query(`select coalesce(sum(planned_qty) filter (where status = 'Completed'), 0) as done, count(*) filter (where status = 'Completed')::int as n,
                                     coalesce(max(seq), 0) as seq from mfg.batches where production_order_id = $1`, [o.id])).rows[0];
      if (used.n >= o.batch_count) throw Errors.state('All batches of this order are complete.');
      const ver = (await tx.query(`select batch_size from mfg.bom_versions where id = $1`, [o.bom_version_id])).rows[0];
      const planned = r3(Math.min(Number(ver.batch_size), Number(o.planned_qty) - Number(used.done)));
      if (planned <= 0) throw Errors.state('The order quantity is already produced.');
      const batchNo = await nextDocNo(tx, 'BATCH');
      const row = (await tx.query(`insert into mfg.batches (batch_no, production_order_id, seq, planned_qty, uom, line_id, shift_id, operators, started_by, updated_by)
                                   values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
        [batchNo, o.id, Number(used.seq) + 1, planned, o.uom, o.line_id, d.shiftId ?? o.shift_id, d.operators, req.auth!.user.id])).rows[0];
      if (o.status === 'Released') await setOrderStatus(tx, actorOf(req), o.id, 'InProgress');
      await audit(tx, actorOf(req), { action: `${SUBJECT}.started`, entityType: SUBJECT, entityId: row.id, after: { batchNo, order: o.doc_no, planned, operators: d.operators } });
      return { id: row.id as string, batchNo };
    });
    res.status(201).json(out);
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const b = await load(db, req.params.id!);
    const mats = await materials(db, b);
    const lots = Object.fromEntries(await Promise.all(mats.map(async (m) => [m.id, (await heldForDosing(db, b.productionOrderId, m.id)).filter((x) => x.available > 0)])));
    const consumptions = (await db.query(
      `select c.id, c.order_material_id as "orderMaterialId", l.lot_no as "lotNo", c.lot_id as "lotId", i.code as "itemCode", i.base_uom as uom, c.qty, c.factor, c.status,
              d.doc_no as "deviationNo", c.deviation_id as "deviationId", u.full_name as "dosedBy", c.dosed_at as "dosedAt",
              (select a.id from wf.approval_requests a where a.subject_type = $2 and a.subject_id = c.deviation_id order by a.submitted_at desc limit 1) as "approvalId"
         from mfg.batch_consumptions c join inv.lots l on l.id = c.lot_id join mdm.items i on i.id = c.item_id join iam.users u on u.id = c.dosed_by left join qa.deviations d on d.id = c.deviation_id
        where c.batch_id = $1 order by c.dosed_at`, [b.id, DOSING])).rows;
    const readings = (await db.query(`select r.id, r.parameter, r.value, r.unit, r.in_limits as "inLimits", r.remarks, r.recorded_at as "recordedAt", u.full_name as "recordedBy"
      from mfg.process_readings r join iam.users u on u.id = r.recorded_by where r.batch_id = $1 order by r.recorded_at`, [b.id])).rows;
    const ipqc = (await db.query(
      `select t.id, t.doc_no as "docNo", t.stage, t.status, t.requested_at as "requestedAt", ru.full_name as "requestedBy", t.tested_at as "testedAt", tu.full_name as "testedBy", t.remarks,
              d.doc_no as "deviationNo",
              coalesce((select json_agg(json_build_object('parameter', x.parameter, 'specification', x.specification, 'result', x.result, 'pass', x.pass) order by x.seq)
                from qc.ipqc_results x where x.ipqc_test_id = t.id), '[]'::json) as results
         from qc.ipqc_tests t join iam.users ru on ru.id = t.requested_by left join iam.users tu on tu.id = t.tested_by left join qa.deviations d on d.id = t.deviation_id
        where t.batch_id = $1 order by t.requested_at`, [b.id])).rows;
    const deviations = (await db.query(
      `select d.id, d.doc_no as "docNo", d.category, d.title, d.status from qa.deviations d
        where d.id in (select deviation_id from mfg.batch_consumptions where batch_id = $1 union select deviation_id from qc.ipqc_tests where batch_id = $1)
           or (d.source_type = 'mfg.batch' and d.source_id = $1) order by d.created_at`, [b.id])).rows;
    const pendingIpqc = ipqc.some((t) => t.status === 'Pending');
    res.json({ ...b, materials: mats, lots, consumptions, readings, ipqc, deviations, allowedActions: actions(req, b, pendingIpqc) });
  }));

  // MFG-008 / TC-11: lots issued to the order only; beyond the tolerance the dose is blocked unless a deviation is raised for approval
  r.post('/:id/dosing', requirePermission(P('execute')), asyncHandler(async (req, res) => {
    const d = parse(dosingSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const b = await load(tx, req.params.id!, true);
      if (b.status !== 'InProgress') throw Errors.state(`Dosing is possible only while the batch is in progress (it is ${b.status}).`);
      const m = (await materials(tx, b)).find((x) => x.id === d.orderMaterialId);
      if (!m) throw Errors.notFound('Material requirement');
      const held = await heldForDosing(tx, b.productionOrderId, m.id);
      let add = 0;
      const entries = d.entries.map((e) => {
        const h = held.find((x) => x.lotId === e.lotId);
        if (!h) throw Errors.rule('LOT_NOT_ISSUED', 'Only lots issued to this order for this material can be dosed.');
        if (e.qty > h.available) throw Errors.rule('NOT_ENOUGH_ISSUED', `Lot ${h.lotNo}: only ${h.available} ${h.uom} is with production. Ask stores to issue more.`);
        add += e.qty / h.factor;
        return { ...e, h };
      });
      const total = r4(m.dosed + add);
      const over = total > m.high + 1e-9;
      if (over && !d.deviationReason) {
        throw Errors.rule('TOLERANCE_EXCEEDED', `${m.itemCode}: ${total} ${m.uom} is beyond the ±${Number(m.tolerancePct)}% tolerance (allowed up to ${m.high}). Reduce the dose, or give the reason to raise a deviation for approval.`,
          { planned: m.planned, total, high: m.high, variancePct: r3((total - m.planned) / m.planned * 100) });
      }
      const dev = over ? await raiseDeviation(tx, actorOf(req), {
        category: 'DOSING_TOLERANCE', title: `${m.itemCode} dosed beyond tolerance — batch ${b.batchNo}`, orderId: b.productionOrderId, sourceType: SUBJECT, sourceId: b.id,
        description: `Planned ${m.planned} ${m.uom} ±${Number(m.tolerancePct)}%; dosed ${total} ${m.uom} (${r3((total - m.planned) / m.planned * 100)}%). Reason: ${d.deviationReason}`,
      }) : null;
      for (const e of entries) {
        await tx.query(`insert into mfg.batch_consumptions (batch_id, order_material_id, lot_id, item_id, qty, factor, unit_cost, status, deviation_id, dosed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [b.id, m.id, e.lotId, e.h.itemId, e.qty, e.h.factor, e.h.cost, dev ? 'PendingApproval' : 'Accepted', dev?.id ?? null, req.auth!.user.id]);
      }
      const ar = dev ? await submitForApproval(tx, actorOf(req), {
        subjectType: DOSING, subjectId: dev.id, subjectLabel: `${dev.docNo} — ${m.itemCode} beyond tolerance in batch ${b.batchNo}`,
        facts: { variancePct: r3((total - m.planned) / m.planned * 100) }, legalEntityId: b.legalEntityId,
      }) : null;
      await audit(tx, actorOf(req), { action: `${SUBJECT}.dosed`, entityType: SUBJECT, entityId: b.id, after: { material: m.itemCode, entries: d.entries, total, deviation: dev?.docNo } });
      return { total, state: over ? 'PendingApproval' : 'Accepted', deviationNo: dev?.docNo ?? null, approvalDocNo: ar?.doc_no ?? null };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/readings', requirePermission(P('execute')), asyncHandler(async (req, res) => {
    const d = parse(readingSchema, req.body);
    await withTx(db, async (tx) => {
      const b = await load(tx, req.params.id!, true);
      if (b.status !== 'InProgress') throw Errors.state('Readings are recorded while the batch is in progress.');
      await tx.query(`insert into mfg.process_readings (batch_id, parameter, value, unit, in_limits, remarks, recorded_by) values ($1,$2,$3,$4,$5,$6,$7)`,
        [b.id, d.parameter, d.value, d.unit, d.inLimits ?? null, d.remarks, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.reading`, entityType: SUBJECT, entityId: b.id, after: d });
    });
    res.status(201).json({ ok: true });
  }));

  r.post('/:id/ipqc', requirePermission(P('execute')), asyncHandler(async (req, res) => {
    const d = parse(ipqcRequestSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const b = await load(tx, req.params.id!, true);
      if (b.status !== 'InProgress') throw Errors.state('In-process QC can be requested while the batch is in progress.');
      if ((await tx.query(`select 1 from qc.ipqc_tests where batch_id = $1 and status = 'Pending'`, [b.id])).rowCount) throw Errors.state('A test is already waiting for QC.');
      const docNo = await nextDocNo(tx, 'IPQC');
      const t = (await tx.query(`insert into qc.ipqc_tests (doc_no, batch_id, stage, requested_by, updated_by) values ($1,$2,$3,$4,$4) returning id`, [docNo, b.id, d.stage, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qc.ipqc.requested', entityType: 'qc.ipqc_test', entityId: t.id, after: { docNo, batch: b.batchNo, stage: d.stage } });
      return { id: t.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  for (const [path, from, to] of [['hold', 'InProgress', 'OnHold'], ['resume', 'OnHold', 'InProgress']] as const) {
    r.post(`/:id/${path}`, requirePermission(P('execute')), asyncHandler(async (req, res) => {
      const { reason } = parse(reasonSchema, req.body);
      await withTx(db, async (tx) => {
        const b = await load(tx, req.params.id!, true);
        if (b.status !== from) throw Errors.state(`A ${b.status} batch cannot be ${path === 'hold' ? 'put on hold' : 'resumed'}.`);
        if (path === 'resume' && (await tx.query(`select 1 from mfg.batch_consumptions where batch_id = $1 and status = 'Rejected'`, [b.id])).rowCount) {
          throw Errors.rule('DOSING_REJECTED', 'A dose outside tolerance was not approved. The batch can only be scrapped, or kept on hold for QA.');
        }
        await setBatchStatus(tx, actorOf(req), b.id, to, reason);
      });
      res.json({ ok: true });
    }));
  }

  r.post('/:id/scrap', requirePermission(P('scrap')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const b = await load(tx, req.params.id!, true);
      if (!['InProgress', 'OnHold'].includes(b.status)) throw Errors.state(`A ${b.status} batch cannot be scrapped.`);
      await setBatchStatus(tx, actorOf(req), b.id, 'Scrapped', reason);
      await raiseDeviation(tx, actorOf(req), { category: 'PROCESS', title: `Batch ${b.batchNo} scrapped`, description: reason, orderId: b.productionOrderId, sourceType: SUBJECT, sourceId: b.id });
    });
    res.json({ ok: true });
  }));

  // MFG-010: yield against standard, mass balance, the FG lot into quarantine and the QC queue
  r.post('/:id/complete', requirePermission(P('execute')), asyncHandler(async (req, res) => {
    const d = parse(batchCompleteSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const b = await load(tx, req.params.id!, true);
      if (b.status !== 'InProgress') throw Errors.state(`Only a batch in progress can be completed (this one is ${b.status}).`);
      if ((await tx.query(`select 1 from mfg.batch_consumptions where batch_id = $1 and status in ('PendingApproval','Rejected')`, [b.id])).rowCount) {
        throw Errors.rule('DOSING_APPROVAL_PENDING', 'A dose outside tolerance is still waiting for approval.');
      }
      const tests = (await tx.query(`select status from qc.ipqc_tests where batch_id = $1 and status <> 'Cancelled' order by requested_at desc`, [b.id])).rows;
      if (!tests.length) throw Errors.rule('IPQC_REQUIRED', 'Ask QC for the in-process test before completing the batch.');
      if (tests[0].status === 'Pending') throw Errors.rule('IPQC_PENDING', 'The in-process test is still with QC.');
      if (tests[0].status !== 'Passed') throw Errors.rule('IPQC_FAILED', 'The last in-process test failed. Correct the batch and ask QC to test again.');
      const mats = await materials(tx, b);
      const notDosed = mats.filter((m) => m.state === 'Pending');
      if (notDosed.length) throw Errors.rule('NOT_DOSED', `Not dosed yet: ${notDosed.map((m) => m.itemCode).join(', ')}.`);
      const actor = actorOf(req);
      const under = mats.filter((m) => m.state === 'Under');
      if (under.length && !d.underDoseReason) {
        throw Errors.rule('UNDER_DOSED', `Below the tolerance: ${under.map((m) => `${m.itemCode} ${m.dosed}/${m.planned} ${m.uom}`).join(', ')}. Give the reason to complete with a deviation.`, { under });
      }
      // mass balance in KG when every quantity converts to it, else in the batch unit; otherwise not computed
      const cons = (await tx.query(`select c.item_id, i.base_uom as uom, c.qty, c.unit_cost from mfg.batch_consumptions c join mdm.items i on i.id = c.item_id where c.batch_id = $1`, [b.id])).rows;
      let basis: string | null = null; let input = 0;
      for (const candidate of ['KG', b.uom]) {
        let sum = 0; let ok = (await convertQty(tx, b.itemId, 1, b.uom, candidate)) !== null;
        for (const c of cons) { if (!ok) break; const v = await convertQty(tx, c.item_id, Number(c.qty), c.uom, candidate); if (v === null) ok = false; else sum += v; }
        if (ok) { basis = candidate; input = sum; break; }
      }
      const outParts = basis ? await Promise.all([d.outputQty, d.processLossQty, d.recoveredQty, d.wasteQty].map((q) => convertQty(tx, b.itemId, q, b.uom, basis!))) : [];
      const unaccounted = basis ? r3(input - outParts.reduce((a: number, x) => a + (x ?? 0), 0)) : null;
      const tolPct = Number((await tx.query(`select value from sys.settings where key = 'mfg.massBalance.tolerancePct'`)).rows[0]?.value ?? 2);
      const gap = basis !== null && input > 0 && Math.abs(unaccounted!) > input * tolPct / 100;
      if (gap && !d.balanceReason) {
        throw Errors.rule('MASS_BALANCE_GAP', `Mass balance: ${r3(Math.abs(unaccounted!))} ${basis} unaccounted (${r3(Math.abs(unaccounted!) / input * 100)}% of the input; allowed ${tolPct}%). Check the figures, or give the reason to complete with a deviation.`,
          { basis, input: r3(input), unaccounted });
      }
      if (under.length) await raiseDeviation(tx, actor, { category: 'DOSING_TOLERANCE', title: `Under-dosed in batch ${b.batchNo}`, orderId: b.productionOrderId, sourceType: SUBJECT, sourceId: b.id,
        description: `${under.map((m) => `${m.itemCode} ${m.dosed} of ${m.planned} ${m.uom} (${m.variancePct}%)`).join('; ')}. Reason: ${d.underDoseReason}` });
      if (gap) await raiseDeviation(tx, actor, { category: 'PROCESS', title: `Mass balance gap in batch ${b.batchNo}`, orderId: b.productionOrderId, sourceType: SUBJECT, sourceId: b.id,
        description: `${r3(Math.abs(unaccounted!))} ${basis} unaccounted of ${r3(input)} ${basis} input. Reason: ${d.balanceReason}` });

      const materialCost = Math.round(cons.reduce((a, c) => a + Number(c.qty) * Number(c.unit_cost), 0) * 100) / 100;
      const item = (await tx.query(`select shelf_life_days from mdm.items where id = $1`, [b.itemId])).rows[0];
      const today = todayIST();
      const lot = (await tx.query(
        `insert into inv.lots (lot_no, item_id, mfg_date, expiry_date, source_type, source_id, qc_status, created_by)
         values ($1,$2,$3::date, case when $4::int is null then null else $3::date + $4::int end,'PRODUCTION',$5,'Quarantine',$6) returning id`,
        [b.batchNo, b.itemId, today, item.shelf_life_days, b.id, req.auth!.user.id])).rows[0];
      await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                      values ($1,$2,$3,'QUARANTINE',$4,$5,'PRODUCTION_OUTPUT','mfg.batch',$6,$7)`,
        [b.itemId, lot.id, b.fgWarehouseId, d.outputQty, r4(materialCost / d.outputQty), b.id, req.auth!.user.id]);
      const insNo = await nextDocNo(tx, 'QC_INSPECTION');
      await tx.query(`insert into qc.inspections (doc_no, lot_id, item_id, source_type, source_id) values ($1,$2,$3,'PRODUCTION',$4)`, [insNo, lot.id, b.itemId, b.id]);
      const yieldPct = r3(d.outputQty / Number(b.plannedQty) * 100);
      await allowTransition(tx);
      await tx.query(`update mfg.batches set status = 'Completed', completed_at = now(), completed_by = $2, output_qty = $3, process_loss_qty = $4, recovered_qty = $5, waste_qty = $6,
                        balance_basis = $7, input_basis_qty = $8, unaccounted_qty = $9, yield_pct = $10, material_cost = $11, fg_lot_id = $12, completion_remarks = $13, updated_by = $2 where id = $1`,
        [b.id, req.auth!.user.id, d.outputQty, d.processLossQty, d.recoveredQty, d.wasteQty, basis, basis ? r3(input) : null, unaccounted, yieldPct, materialCost, lot.id, d.remarks]);
      await audit(tx, actor, { action: `${SUBJECT}.completed`, entityType: SUBJECT, entityId: b.id, after: { output: d.outputQty, yieldPct, basis, input, unaccounted, fgLot: b.batchNo, qc: insNo } });
      await emit(tx, SUBJECT, b.id, `${SUBJECT}.completed`);
      const done = Number((await tx.query(`select count(*) from mfg.batches where production_order_id = $1 and status = 'Completed'`, [b.productionOrderId])).rows[0].count);
      if (done >= b.batchCount) await setOrderStatus(tx, actor, b.productionOrderId, 'Completed');
      return { fgLotNo: b.batchNo as string, inspectionNo: insNo, yieldPct, basis, unaccounted, orderCompleted: done >= b.batchCount };
    });
    res.json(out);
  }));

  return r;
}
