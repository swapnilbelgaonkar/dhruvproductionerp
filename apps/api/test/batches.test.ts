import { describe, expect, it } from 'vitest';
import { db, userAgent } from './helpers';
import { approvedOrder, lotQty, prodSetup, stockLot, type PF } from './production-fixtures';
import { approve } from './purchase-fixtures';

/** A released order of `qty` L with everything issued, and the people who run and test batches. */
async function running(qty = 2000) {
  const f = await prodSetup();
  // density of the product: 1 L = 1.25 kg, so the mass balance is in KG
  await db.query(`insert into mdm.uom_conversions (item_id, from_uom, to_uom, factor) values ($1,'L','KG',1.25)`, [f.fg]);
  await stockLot(f.zn, f.rmWh, 1000, { expiryDays: 100, cost: 60 });
  await stockLot(f.edta, f.rmWh, 1300, { expiryDays: 100, cost: 180 });
  const id = await approvedOrder(f, qty);
  await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(200);
  const o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
  await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: o.reservations.map((r: { id: string; qty: string }) => ({ reservationId: r.id, qty: Number(r.qty) })) }).expect(201);
  return { f, id, analyst: await userAgent([{ code: 'QC_ANALYST' }]), qa: await userAgent([{ code: 'QA_MANAGER' }]) };
}
const batch = (f: PF, id: string) => f.supervisor.get(`/api/v1/batches/${id}`).expect(200).then((r) => r.body);
interface M { itemId: string; id: string; planned: number; low: number; high: number }
const mat = (b: { materials: M[] }, itemId: string) => b.materials.find((m) => m.itemId === itemId)!;
const lotOf = (b: { lots: Record<string, { lotId: string }[]> }, mId: string) => b.lots[mId]![0]!.lotId;

describe('Batch execution (MFG-007, MFG-008, MFG-010, TC-11)', () => {
  it('doses issued lots within tolerance, needs a passed IPQC, checks yield and mass balance, and puts the FG lot in quarantine', async () => {
    const { f, id, analyst } = await running();
    await f.planner.post('/api/v1/batches', { productionOrderId: id, operators: ['Ramesh'] }).expect(403);
    const s = await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['Ramesh Patil', 'Sunil Jadhav'] }).expect(201);
    await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['x'] }).expect(422);          // one open batch at a time
    expect((await f.planner.get(`/api/v1/production-orders/${id}`).expect(200)).body.status).toBe('InProgress');
    let b = await batch(f, s.body.id);
    expect(b.plannedQty).toBe('1000.000');
    const zn = mat(b, f.zn), edta = mat(b, f.edta);
    expect([zn.planned, zn.low, zn.high]).toEqual([450, 441, 459]);

    // TC-11: 460 kg against 450 ±2% is blocked without a reason; a lot not issued to the order is refused
    const over = await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: zn.id, entries: [{ lotId: lotOf(b, zn.id), qty: 460 }] }).expect(422);
    expect(over.body.error).toMatchObject({ code: 'TOLERANCE_EXCEEDED', details: { planned: 450, total: 460, high: 459 } });
    const stray = await stockLot(f.zn, f.rmWh, 100);
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: zn.id, entries: [{ lotId: stray, qty: 10 }] }).expect(422)).body.error.code).toBe('LOT_NOT_ISSUED');
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: zn.id, entries: [{ lotId: lotOf(b, zn.id), qty: 445 }] }).expect(201);
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: edta.id, entries: [{ lotId: lotOf(b, edta.id), qty: 590 }] }).expect(201);   // −1.7%: under ±1%
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/readings`, { parameter: 'Reaction temperature', value: '81', unit: '°C', inLimits: true }).expect(201);
    b = await batch(f, s.body.id);
    expect(b.materials.map((m: { state: string }) => m.state)).toEqual(['Within', 'Under']);

    // IPQC: required, pending, failed (deviation), then passed
    const done = { outputQty: 800, processLossQty: 28, recoveredQty: 0, wasteQty: 0 };
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, done).expect(422)).body.error.code).toBe('IPQC_REQUIRED');
    const t1 = await f.supervisor.post(`/api/v1/batches/${s.body.id}/ipqc`, { stage: 'After reaction' }).expect(201);
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, done).expect(422)).body.error.code).toBe('IPQC_PENDING');
    expect((await analyst.get('/api/v1/batches/ipqc').expect(200)).body.data.some((x: { id: string }) => x.id === t1.body.id)).toBe(true);
    const fail = await analyst.post(`/api/v1/batches/ipqc/${t1.body.id}/results`, { results: [{ parameter: 'pH', specification: '6.0–6.5', result: '5.4', pass: false }] }).expect(200);
    expect(fail.body).toMatchObject({ status: 'Failed', deviationNo: expect.stringMatching(/^DEV\//) });
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, done).expect(422)).body.error.code).toBe('IPQC_FAILED');
    const t2 = await f.supervisor.post(`/api/v1/batches/${s.body.id}/ipqc`, { stage: 'After pH adjustment' }).expect(201);
    await analyst.post(`/api/v1/batches/ipqc/${t2.body.id}/results`, { results: [{ parameter: 'pH', specification: '6.0–6.5', result: '6.2', pass: true },
      { parameter: 'Zinc (Zn)', specification: '≥ 12.0%', result: '12.3%', pass: true }] }).expect(200);

    // under-dosed EDTA needs a reason; a mass balance gap (700 L = 875 kg of 1,035 kg in) needs a reason too
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, done).expect(422)).body.error.code).toBe('UNDER_DOSED');
    const gap = await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, { ...done, outputQty: 700, underDoseReason: '[TEST] last bag damp' }).expect(422);
    expect(gap.body.error).toMatchObject({ code: 'MASS_BALANCE_GAP', details: { basis: 'KG', input: 1035 } });
    const c = await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, { ...done, underDoseReason: '[TEST] last bag damp' }).expect(200);
    // 445 + 590 kg in = 800 L × 1.25 + 28 L × 1.25
    expect(c.body).toMatchObject({ yieldPct: 80, basis: 'KG', unaccounted: 0, orderCompleted: false });
    b = await batch(f, s.body.id);
    expect(b).toMatchObject({ status: 'Completed', fgLotNo: b.batchNo, fgLotStatus: 'Quarantine', materialCost: String(445 * 60 + 590 * 180) + '.00' });
    expect(await lotQty(b.fgLotId, 'QUARANTINE')).toBe(800);
    expect(b.deviations.map((d: { category: string }) => d.category).sort()).toEqual(['DOSING_TOLERANCE', 'IPQC_FAILURE']);
    const ins = (await db.query(`select source_type, status from qc.inspections where lot_id = $1`, [b.fgLotId])).rows[0];
    expect(ins).toEqual({ source_type: 'PRODUCTION', status: 'Pending' });
    // the dosed quantity is no longer returnable: 900 issued − 445 dosed
    const o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
    await f.keeper.post(`/api/v1/production-orders/${id}/return`, { lines: [{ orderMaterialId: zn.id, lotId: lotOf(b, zn.id) ?? o.reservations[0].lotId, qty: 456 }] }).expect(422);
    expect(o.batches).toHaveLength(1);
    expect(o.allowedActions).not.toContain('start_batch');
    expect((await f.supervisor.get(`/api/v1/production-orders/${id}`).expect(200)).body.allowedActions).toContain('start_batch');
  });

  it('lets a dose beyond tolerance continue only after production and QA approve its deviation; a rejection holds the batch (TC-11)', async () => {
    const { f, id, qa } = await running();
    const s = await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['Ramesh Patil'] }).expect(201);
    let b = await batch(f, s.body.id);
    const zn = mat(b, f.zn), edta = mat(b, f.edta);
    const d1 = await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: zn.id, entries: [{ lotId: lotOf(b, zn.id), qty: 460 }], deviationReason: '[TEST] scale reading drifted' }).expect(201);
    expect(d1.body).toMatchObject({ state: 'PendingApproval', deviationNo: expect.stringMatching(/^DEV\//) });
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: edta.id, entries: [{ lotId: lotOf(b, edta.id), qty: 600 }] }).expect(201);
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, { outputQty: 800 }).expect(422)).body.error.code).toBe('DOSING_APPROVAL_PENDING');
    const req1 = (await db.query(`select id from wf.approval_requests where subject_type = 'mfg.dosing_deviation' order by submitted_at desc limit 1`)).rows[0].id;
    await approve(f.supervisor, req1).expect(403);                       // the person who dosed cannot approve
    await approve(f.plantHead, req1).expect(200);
    await approve(qa, req1).expect(200);
    b = await batch(f, s.body.id);
    expect(b.consumptions.find((x: { orderMaterialId: string }) => x.orderMaterialId === zn.id).status).toBe('Approved');

    // another over-dose is rejected: the batch goes on hold and can only be scrapped
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: edta.id, entries: [{ lotId: lotOf(b, edta.id), qty: 10 }], deviationReason: '[TEST] extra charge' }).expect(201);
    const req2 = (await db.query(`select id from wf.approval_requests where subject_type = 'mfg.dosing_deviation' order by submitted_at desc limit 1`)).rows[0].id;
    await f.plantHead.post(`/api/v1/approvals/${req2}/decisions`, { decision: 'Reject', remarks: '[TEST] not justified' }).expect(200);
    b = await batch(f, s.body.id);
    expect(b.status).toBe('OnHold');
    expect((await f.supervisor.post(`/api/v1/batches/${s.body.id}/resume`, { reason: '[TEST]' }).expect(422)).body.error.code).toBe('DOSING_REJECTED');
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/scrap`, { reason: '[TEST]' }).expect(403);
    await f.plantHead.post(`/api/v1/batches/${s.body.id}/scrap`, { reason: '[TEST] off-spec, not recoverable' }).expect(200);
    expect((await batch(f, s.body.id)).status).toBe('Scrapped');
    // a scrapped batch does not count: the next batch can start
    await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['Ramesh Patil'] }).expect(201);
  });
});
