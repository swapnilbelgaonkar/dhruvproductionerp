import { randomUUID } from 'node:crypto';
import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent } from './helpers';
import { inDays } from './purchase-fixtures';

/** A plant with a line and shifts, raw-material and FG stores, an approved formulation and the people of the plant. */
export async function prodSetup() {
  const le = (await db.query(`insert into org.legal_entities (code, name, pan, state_code, status) values ($1,'[TEST] Maker Pvt Ltd','AAAAA0000A','27','Active') returning id`, [uniq('LE')])).rows[0].id as string;
  const plant = (await db.query(`insert into org.plants (legal_entity_id, code, name, state_code, status) values ($1,$2,'[TEST] Chakan plant','27','Active') returning id`, [le, uniq('PL')])).rows[0].id as string;
  const line = (await db.query(`insert into mfg.lines (plant_id, code, name, line_type) values ($1,$2,'[TEST] Reactor 1','REACTOR') returning id`, [plant, uniq('RX-').slice(0, 20)])).rows[0].id as string;
  const wh = async (type: string) => (await db.query(`insert into org.warehouses (legal_entity_id, plant_id, code, name, type, state_code, status) values ($1,$2,$3,$4,$5,'27','Active') returning id`,
    [le, plant, uniq('WH'), `[TEST] ${type} store`, type])).rows[0].id as string;
  const item = async (type: string, name: string, uom = 'KG') => (await db.query(
    `insert into mdm.items (code, name, item_type, base_uom, shelf_life_days, status) values ($1,$2,$3,$4,365,'Active') returning id`, [uniq(type), name, type, uom])).rows[0].id as string;
  const fg = await item('FG', '[TEST] Zinc EDTA 12%', 'L');
  const zn = await item('RM', '[TEST] Zinc sulphate');
  const edta = await item('RM', '[TEST] EDTA disodium');
  const edtaAlt = await item('RM', '[TEST] EDTA tetrasodium');
  const bom = (await db.query(`insert into mfg.boms (item_id, code, name) values ($1,$2,'[TEST] formulation') returning id`, [fg, uniq('F-').slice(0, 20)])).rows[0].id as string;
  const ver = (await db.query(`insert into mfg.bom_versions (bom_id, version_no, batch_size, batch_uom, standard_yield_pct, effective_from, change_note, status, approved_at)
                               values ($1,1,1000,'L',97.5,$2,'[TEST]','Approved',now()) returning id`, [bom, inDays(-30)])).rows[0].id as string;
  const zl = (await db.query(`insert into mfg.bom_lines (bom_version_id, line_no, step_no, item_id, qty, uom, tolerance_pct) values ($1,1,1,$2,450,'KG',2) returning id`, [ver, zn])).rows[0].id;
  const el = (await db.query(`insert into mfg.bom_lines (bom_version_id, line_no, step_no, item_id, qty, uom, tolerance_pct) values ($1,2,2,$2,600,'KG',1) returning id`, [ver, edta])).rows[0].id;
  await db.query(`insert into mfg.bom_alternates (bom_line_id, item_id, factor) values ($1,$2,0.5)`, [el, edtaAlt]);
  void zl;
  return {
    le, plant, line, rmWh: await wh('RM'), fgWh: await wh('FG'), fg, zn, edta, edtaAlt, bom,
    planner: await userAgent([{ code: 'PRODUCTION_PLANNER' }]), plantHead: await userAgent([{ code: 'PLANT_HEAD' }]), supervisor: await userAgent([{ code: 'PRODUCTION_SUPERVISOR' }]),
    keeper: await userAgent([{ code: 'STOREKEEPER' }]), qcHead: await userAgent([{ code: 'QC_HEAD' }]), qaHead: await userAgent([{ code: 'QA_HEAD' }]),
  };
}
export type PF = Awaited<ReturnType<typeof prodSetup>>;

/** Opening stock as a lot in a bucket (QC status follows the bucket). */
export async function stockLot(itemId: string, warehouseId: string, qty: number, opts: { status?: 'Released' | 'Quarantine'; expiryDays?: number; cost?: number } = {}) {
  const status = opts.status ?? 'Released';
  const lot = (await db.query(`insert into inv.lots (lot_no, item_id, expiry_date, source_type, source_id, qc_status) values ($1,$2,$3,'OPENING',$4,$5) returning id`,
    [uniq('LOT-T-'), itemId, opts.expiryDays === undefined ? null : inDays(opts.expiryDays), randomUUID(), status])).rows[0].id as string;
  await db.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id) values ($1,$2,$3,$4,$5,$6,'GRN','opening',$2)`,
    [itemId, lot, warehouseId, status === 'Released' ? 'UNRESTRICTED' : 'QUARANTINE', qty, opts.cost ?? 50]);
  return lot;
}
export const lotQty = async (lotId: string, bucket = 'UNRESTRICTED') => Number((await db.query(`select coalesce(sum(qty), 0) as q from inv.stock_ledger where lot_id = $1 and bucket = $2`, [lotId, bucket])).rows[0].q);

export const order = (f: PF, qty: number, over: Record<string, unknown> = {}) => ({
  plantId: f.plant, lineId: f.line, itemId: f.fg, plannedQty: qty, orderType: 'MTS', priority: 'NORMAL', plannedStart: todayIST(), dueDate: inDays(3),
  issueWarehouseId: f.rmWh, fgWarehouseId: f.fgWh, ...over,
});

/** Draft → submitted → approved by the plant head. */
export async function approvedOrder(f: PF, qty: number) {
  const o = await f.planner.post('/api/v1/production-orders', order(f, qty)).expect(201);
  const s = await f.planner.post(`/api/v1/production-orders/${o.body.id}/submit`).expect(200);
  await f.plantHead.post(`/api/v1/approvals/${s.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
  return o.body.id as string;
}

/** A completed 1,000 L batch (zinc and EDTA lots fully dosed, IPQC passed) with its FG lot in quarantine. */
export async function completedBatch(f: PF) {
  const analyst = await userAgent([{ code: 'QC_ANALYST' }]);
  const znLot = await stockLot(f.zn, f.rmWh, 450, { cost: 60 });
  const edtaLot = await stockLot(f.edta, f.rmWh, 600, { cost: 180 });
  const id = await approvedOrder(f, 1000);
  await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(200);
  const o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
  await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: o.reservations.map((r: { id: string; qty: string }) => ({ reservationId: r.id, qty: Number(r.qty) })) }).expect(201);
  const s = await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['A'] }).expect(201);
  const b = (await f.supervisor.get(`/api/v1/batches/${s.body.id}`).expect(200)).body;
  for (const m of b.materials) await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: m.id, entries: [{ lotId: b.lots[m.id][0].lotId, qty: m.planned }] }).expect(201);
  const t = await f.supervisor.post(`/api/v1/batches/${s.body.id}/ipqc`, { stage: 'x' }).expect(201);
  await analyst.post(`/api/v1/batches/ipqc/${t.body.id}/results`, { results: [{ parameter: 'pH', specification: '6–6.5', result: '6.2', pass: true }] }).expect(200);
  const done = await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, { outputQty: 975 }).expect(200);
  const fgLot = (await db.query(`select id from inv.lots where lot_no = $1`, [done.body.fgLotNo])).rows[0].id as string;
  return { orderId: id, batchId: s.body.id as string, fgLot, fgLotNo: done.body.fgLotNo as string, znLot, edtaLot };
}
