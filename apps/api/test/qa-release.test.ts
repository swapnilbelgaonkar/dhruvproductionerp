import { describe, expect, it } from 'vitest';
import { db, userAgent } from './helpers';
import { approvedOrder, lotQty, prodSetup, stockLot } from './production-fixtures';
import { approve } from './purchase-fixtures';

describe('QA batch release and traceability (QA-003/004, TC-13, UAT-08/09, MFG-012)', () => {
  it('blocks release while a deviation is open or an input lot is untested, then releases; traces both ways; closes the order', async () => {
    const f = await prodSetup();
    const [analyst, qcManager, qaManager] = [await userAgent([{ code: 'QC_ANALYST' }]), await userAgent([{ code: 'QC_MANAGER' }]), await userAgent([{ code: 'QA_MANAGER' }])];
    const znLot = await stockLot(f.zn, f.rmWh, 450, { expiryDays: 100 });
    const edtaLot = await stockLot(f.edta, f.rmWh, 500, { expiryDays: 100 });
    const qLot = await stockLot(f.edta, f.rmWh, 200, { status: 'Quarantine' });
    const id = await approvedOrder(f, 1000);
    await f.planner.post(`/api/v1/production-orders/${id}/release`, { acceptShortage: true, reason: '[TEST]' }).expect(200);
    let o = (await f.planner.get(`/api/v1/production-orders/${id}`).expect(200)).body;
    const mEdta = o.materials.find((m: { itemId: string }) => m.itemId === f.edta).id;
    const ov = await f.supervisor.post(`/api/v1/production-orders/${id}/overrides`, { orderMaterialId: mEdta, lotId: qLot, qty: 100, reason: '[TEST] urgent' }).expect(201);
    await approve(f.qcHead, ov.body.approvalRequestId).expect(200);
    await approve(f.plantHead, ov.body.approvalRequestId).expect(200);
    o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
    await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: o.reservations.map((r: { id: string; qty: string }) => ({ reservationId: r.id, qty: Number(r.qty) })) }).expect(201);

    // one batch: dose everything (including 100 kg from the quarantined lot), pass IPQC, complete
    const s = await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['Ramesh Patil'] }).expect(201);
    const b = (await f.supervisor.get(`/api/v1/batches/${s.body.id}`).expect(200)).body;
    const mZn = b.materials.find((m: { itemId: string }) => m.itemId === f.zn).id;
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: mZn, entries: [{ lotId: znLot, qty: 450 }] }).expect(201);
    await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: mEdta, entries: [{ lotId: edtaLot, qty: 500 }, { lotId: qLot, qty: 100 }] }).expect(201);
    const t = await f.supervisor.post(`/api/v1/batches/${s.body.id}/ipqc`, { stage: 'After reaction' }).expect(201);
    await analyst.post(`/api/v1/batches/ipqc/${t.body.id}/results`, { results: [{ parameter: 'pH', specification: '6.0–6.5', result: '6.3', pass: true }] }).expect(200);
    const done = await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, { outputQty: 975 }).expect(200);
    const fgLot = (await db.query(`select id from inv.lots where lot_no = $1`, [done.body.fgLotNo])).rows[0].id as string;
    expect((await f.planner.get(`/api/v1/production-orders/${id}`).expect(200)).body.status).toBe('Completed');

    // QC tests the FG lot; "Release" by QC only approves the results — the lot stays in quarantine
    const ins = (await db.query(`select id from qc.inspections where lot_id = $1`, [fgLot])).rows[0].id;
    await analyst.post(`/api/v1/qc/inspections/${ins}/sample`, { sampleQty: 1 }).expect(200);
    await analyst.post(`/api/v1/qc/inspections/${ins}/results`, { results: [{ parameter: 'Zinc (Zn)', specification: '≥ 12.0%', result: '12.2%', pass: true }], coaReceived: false, recommendation: 'Release' }).expect(200);
    const qcd = await qcManager.post(`/api/v1/qc/inspections/${ins}/decide`, { decision: 'Release' }).expect(200);
    expect(qcd.body).toMatchObject({ lotStatus: 'Quarantine', qcApproved: true });
    expect(await lotQty(fgLot, 'QUARANTINE')).toBe(974);

    // TC-13: the open override deviation and the untested input lot block release, in the UI data and the API
    let rv = (await f.qaHead.get(`/api/v1/qa/releases/${fgLot}`).expect(200)).body;
    expect(rv.checklist).toMatchObject({ qcApproved: true, batchRecordComplete: true, deviationsClosed: false, inputLotsReleased: false });
    expect(rv.allowedDecisions).not.toContain('Released');
    const blocked = await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'Released', bmrReviewed: true }).expect(422);
    expect(blocked.body.error.code).toBe('QA_RELEASE_BLOCKED');
    expect(blocked.body.error.details.blockers.map((x: { code: string }) => x.code).sort()).toEqual(['INPUT_LOT_NOT_RELEASED', 'OPEN_DEVIATION']);
    await qaManager.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'Released', bmrReviewed: true }).expect(403);   // D04: the QA head
    expect((await f.qaHead.get('/api/v1/qa/releases').expect(200)).body.data.find((x: { id: string }) => x.id === fgLot)).toMatchObject({ openDeviations: 1 });

    // QC releases the input lot; QA closes the deviation; release needs the batch record reviewed
    await db.query(`update inv.lots set qc_status = 'Released' where id = $1`, [qLot]);
    const dev = (await db.query(`select id from qa.deviations where lot_id = $1`, [qLot])).rows[0].id;
    await f.qaHead.post(`/api/v1/qa/deviations/${dev}/close`, { note: '[TEST] lot passed QC' }).expect(200);
    expect((await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'Released' }).expect(422)).body.error.code).toBe('BMR_NOT_REVIEWED');
    const rel = await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'Released', bmrReviewed: true, remarks: '[TEST] BMR reviewed' }).expect(200);
    expect(rel.body).toMatchObject({ decision: 'Released', lotStatus: 'Released' });
    expect([await lotQty(fgLot, 'QUARANTINE'), await lotQty(fgLot, 'UNRESTRICTED')]).toEqual([0, 974]);
    await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'Rejected', remarks: 'x' }).expect(422);
    rv = (await f.qaHead.get(`/api/v1/qa/releases/${fgLot}`).expect(200)).body;
    expect(rv.history).toHaveLength(1);

    // MFG-012: backward from the FG lot to the three input lots; forward from the zinc lot to the FG lot
    const back = (await f.qaHead.get(`/api/v1/stock/lots/${fgLot}/trace`).expect(200)).body.backward;
    expect(back).toMatchObject({ batchNo: done.body.fgLotNo, sourceType: 'PRODUCTION' });
    expect(back.children.map((c: { lotId: string; qty: number }) => [c.lotId, c.qty]).sort()).toEqual([[znLot, 450], [edtaLot, 500], [qLot, 100]].sort());
    const fwd = (await f.qaHead.get(`/api/v1/stock/lots/${znLot}/trace`).expect(200)).body.forward;
    expect(fwd.children[0]).toMatchObject({ lotId: fgLot, qty: 450, qcStatus: 'Released' });

    // the order closes: nothing left with production
    await f.planner.post(`/api/v1/production-orders/${id}/close`).expect(200);
    expect((await f.planner.get(`/api/v1/production-orders/${id}`).expect(200)).body.status).toBe('Closed');
  });

  it('keeps the batch supervisor from releasing it, and records hold, rework and rejection with the stock moved (SOD-07)', async () => {
    const f = await prodSetup();
    const dual = await userAgent([{ code: 'PRODUCTION_SUPERVISOR' }, { code: 'QA_HEAD' }]);
    const analyst = await userAgent([{ code: 'QC_ANALYST' }]);
    await stockLot(f.zn, f.rmWh, 450); await stockLot(f.edta, f.rmWh, 600);
    const id = await approvedOrder(f, 1000);
    await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(200);
    const o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
    await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: o.reservations.map((r: { id: string; qty: string }) => ({ reservationId: r.id, qty: Number(r.qty) })) }).expect(201);
    const s = await dual.post('/api/v1/batches', { productionOrderId: id, operators: ['A'] }).expect(201);
    const b = (await dual.get(`/api/v1/batches/${s.body.id}`).expect(200)).body;
    for (const m of b.materials) await dual.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: m.id, entries: [{ lotId: b.lots[m.id][0].lotId, qty: m.planned }] }).expect(201);
    const t = await dual.post(`/api/v1/batches/${s.body.id}/ipqc`, { stage: 'x' }).expect(201);
    await analyst.post(`/api/v1/batches/ipqc/${t.body.id}/results`, { results: [{ parameter: 'pH', specification: '6–6.5', result: '6.2', pass: true }] }).expect(200);
    const done = await dual.post(`/api/v1/batches/${s.body.id}/complete`, { outputQty: 970 }).expect(200);
    const fgLot = (await db.query(`select id from inv.lots where lot_no = $1`, [done.body.fgLotNo])).rows[0].id as string;
    expect((await dual.get(`/api/v1/qa/releases/${fgLot}`).expect(200)).body.checklist.independentReleaser).toBe(false);
    await dual.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'OnHold', remarks: 'x' }).expect(403);
    await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'OnHold' }).expect(400);           // reason needed
    await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'OnHold', remarks: '[TEST] colour check' }).expect(200);
    expect(await lotQty(fgLot, 'BLOCKED')).toBe(970);
    await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'ReworkAuthorised', remarks: '[TEST] re-filter' }).expect(200);
    await f.qaHead.post(`/api/v1/qa/releases/${fgLot}/disposition`, { decision: 'Rejected', remarks: '[TEST] rework failed' }).expect(200);
    expect([await lotQty(fgLot, 'BLOCKED'), await lotQty(fgLot, 'REJECTED')]).toEqual([0, 970]);
    expect((await db.query(`select qc_status, qa_disposition from inv.lots where id = $1`, [fgLot])).rows[0]).toEqual({ qc_status: 'Rejected', qa_disposition: 'Rejected' });
  });
});
