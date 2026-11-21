import { describe, expect, it } from 'vitest';
import { relayOutbox } from '../src/modules/notifications/relay';
import { db } from './helpers';
import { approvedOrder, lotQty, order, prodSetup, stockLot } from './production-fixtures';
import { approve, inDays } from './purchase-fixtures';

const get = (f: Awaited<ReturnType<typeof prodSetup>>, id: string) => f.planner.get(`/api/v1/production-orders/${id}`).expect(200).then((r) => r.body);

describe('Production orders (MFG-005, MFG-007, MFG-013, INV-007)', () => {
  it('releases against the formulation in force, reserves FEFO with substitutes, and issues and returns material', async () => {
    const f = await prodSetup();
    // validation
    await f.planner.post('/api/v1/production-orders', order(f, 2000, { plannedStart: inDays(-1) })).expect(422);
    await f.planner.post('/api/v1/production-orders', order(f, 2000, { orderType: 'MTO' })).expect(400);
    await f.planner.post('/api/v1/production-orders', order(f, 2000, { fgWarehouseId: f.rmWh })).expect(422);
    await f.supervisor.post('/api/v1/production-orders', order(f, 2000)).expect(403);

    const lotLate = await stockLot(f.zn, f.rmWh, 500, { expiryDays: 200 });
    const lotEarly = await stockLot(f.zn, f.rmWh, 600, { expiryDays: 100 });
    const edtaLot = await stockLot(f.edta, f.rmWh, 1100, { expiryDays: 300 });
    const altLot = await stockLot(f.edtaAlt, f.rmWh, 30, { expiryDays: 300 });
    await stockLot(f.edta, f.rmWh, 900, { status: 'Quarantine' });          // never reserved without an override
    await stockLot(f.zn, f.rmWh, 999, { expiryDays: -1 });                  // expired: never reserved

    const created = await f.planner.post('/api/v1/production-orders', order(f, 2000)).expect(201);
    const id = created.body.id as string;
    expect((await get(f, id)).batchCount).toBe(2);
    const check = (await f.planner.get(`/api/v1/production-orders/material-check?itemId=${f.fg}&issueWarehouseId=${f.rmWh}&plannedQty=2000`).expect(200)).body;
    expect(check.lines.map((l: { required: string; available: string }) => [Number(l.required), Number(l.available)])).toEqual([[900, 1100], [1200, 1100]]);
    const sub = await f.planner.post(`/api/v1/production-orders/${id}/submit`).expect(200);
    await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(422);                // not approved yet
    await approve(f.plantHead, sub.body.approvalRequestId).expect(200);

    // EDTA needs 1,200: 1,100 released + 30 kg substitute at 0.5 (= 60) leaves 40 short → refused unless accepted, and nothing is kept
    const short = await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(422);
    expect(short.body.error.code).toBe('MATERIAL_SHORTAGE');
    expect(short.body.error.details.shortages).toEqual([{ itemCode: expect.any(String), required: 1200, covered: 1160, short: 40, uom: 'KG' }]);
    expect(Number((await db.query(`select count(*) from inv.reservations where source_id = $1`, [id])).rows[0].count)).toBe(0);
    await f.planner.post(`/api/v1/production-orders/${id}/release`, { acceptShortage: true }).expect(400);   // reason needed
    const rel = await f.planner.post(`/api/v1/production-orders/${id}/release`, { acceptShortage: true, reason: '[TEST] EDTA arriving tomorrow' }).expect(200);
    expect(rel.body.bomVersionNo).toBe(1);
    let o = await get(f, id);
    expect(o.status).toBe('Released');
    expect(o.materials.map((m: { requiredQty: string; coveredQty: string }) => [Number(m.requiredQty), Number(m.coveredQty)])).toEqual([[900, 900], [1200, 1160]]);
    // FEFO: the lot expiring first is reserved first; the substitute carries its factor
    const zres = o.reservations.filter((x: { itemId: string }) => x.itemId === f.zn);
    expect(zres.map((x: { lotId: string; qty: string }) => [x.lotId, Number(x.qty)])).toEqual([[lotEarly, 600], [lotLate, 300]]);
    expect(o.reservations.find((x: { itemId: string }) => x.itemId === f.edtaAlt)).toMatchObject({ lotId: altLot, factor: '0.500000' });

    // issue: stores only; over-issue refused; a lot put on hold after reserving cannot be issued
    const resOf = (lot: string) => o.reservations.find((x: { lotId: string }) => x.lotId === lot).id as string;
    await f.planner.post(`/api/v1/production-orders/${id}/issue`, { lines: [{ reservationId: resOf(lotEarly), qty: 600 }] }).expect(403);
    await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: [{ reservationId: resOf(lotEarly), qty: 601 }] }).expect(422);
    await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: [{ reservationId: resOf(lotEarly), qty: 600 }, { reservationId: resOf(edtaLot), qty: 1100 }] }).expect(201);
    await db.query(`update inv.lots set qc_status = 'Hold' where id = $1`, [lotLate]);
    const held = await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: [{ reservationId: resOf(lotLate), qty: 300 }] }).expect(422);
    expect(held.body.error.code).toBe('LOT_NOT_USABLE');
    await db.query(`update inv.lots set qc_status = 'Released' where id = $1`, [lotLate]);
    await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: [{ reservationId: resOf(lotLate), qty: 300 }] }).expect(201);
    expect([await lotQty(lotEarly), await lotQty(lotLate), await lotQty(edtaLot)]).toEqual([0, 200, 0]);

    // return 50 of the early lot; more than was issued is refused
    const mZn = o.materials.find((m: { itemId: string }) => m.itemId === f.zn).id;
    await f.keeper.post(`/api/v1/production-orders/${id}/return`, { lines: [{ orderMaterialId: mZn, lotId: lotEarly, qty: 601 }] }).expect(422);
    await f.keeper.post(`/api/v1/production-orders/${id}/return`, { lines: [{ orderMaterialId: mZn, lotId: lotEarly, qty: 50 }] }).expect(201);
    expect(await lotQty(lotEarly)).toBe(50);
    o = await get(f, id);
    expect(Number(o.materials.find((m: { id: string }) => m.id === mZn).netIssuedQty)).toBe(850);
    expect(o.movements.map((m: { direction: string }) => m.direction)).toEqual(['ISSUE', 'ISSUE', 'RETURN']);
    const cancel = await f.planner.post(`/api/v1/production-orders/${id}/cancel`, { reason: '[TEST]' }).expect(422);
    expect(cancel.body.error.code).toBe('MATERIAL_ISSUED');

    // a second order sees only what is free: 200 of the late lot and the 50 returned — never the stock reserved or issued to the first
    const id2 = await approvedOrder(f, 2000);
    const rel2 = await f.planner.post(`/api/v1/production-orders/${id2}/release`, { acceptShortage: true, reason: '[TEST] partial' }).expect(200);
    expect(rel2.body.shortages.find((s: { required: number }) => s.required === 900)).toMatchObject({ covered: 250, short: 650 });
    // hold and resume; cancel releases the reservations
    await f.planner.post(`/api/v1/production-orders/${id2}/hold`, { reason: '[TEST] reactor cleaning' }).expect(200);
    expect((await get(f, id2)).status).toBe('OnHold');
    await f.planner.post(`/api/v1/production-orders/${id2}/resume`, { reason: '[TEST] cleaned' }).expect(200);
    await f.planner.post(`/api/v1/production-orders/${id2}/cancel`, { reason: '[TEST] plan changed' }).expect(200);
    expect(Number((await db.query(`select count(*) from inv.reservations where source_id = $1 and status = 'Active'`, [id2])).rows[0].count)).toBe(0);
  });

  it('lets a quarantined lot be used only with QC head and plant head approval, raising a deviation QA must close after QC decides (D33)', async () => {
    const f = await prodSetup();
    await stockLot(f.zn, f.rmWh, 900, { expiryDays: 100 });
    await stockLot(f.edta, f.rmWh, 1150, { expiryDays: 100 });
    const qLot = await stockLot(f.edta, f.rmWh, 500, { status: 'Quarantine' });
    const id = await approvedOrder(f, 2000);
    await f.planner.post(`/api/v1/production-orders/${id}/release`, { acceptShortage: true, reason: '[TEST] waiting for QC' }).expect(200);
    const o = await get(f, id);
    const mEdta = o.materials.find((m: { itemId: string }) => m.itemId === f.edta).id;
    const lots = (await f.supervisor.get(`/api/v1/production-orders/${id}/quarantined-lots?orderMaterialId=${mEdta}`).expect(200)).body.data;
    expect(lots.map((l: { id: string; free: string }) => [l.id, Number(l.free)])).toEqual([[qLot, 500]]);
    const big = await f.supervisor.post(`/api/v1/production-orders/${id}/overrides`, { orderMaterialId: mEdta, lotId: qLot, qty: 60, reason: '[TEST] line stoppage' }).expect(422);
    expect(big.body.error.code).toBe('OVERRIDE_TOO_LARGE');
    await f.keeper.post(`/api/v1/production-orders/${id}/overrides`, { orderMaterialId: mEdta, lotId: qLot, qty: 50, reason: 'x' }).expect(403);
    const ov = await f.supervisor.post(`/api/v1/production-orders/${id}/overrides`, { orderMaterialId: mEdta, lotId: qLot, qty: 50, reason: '[TEST] line stoppage — vendor CoA conforms' }).expect(201);
    await approve(f.plantHead, ov.body.approvalRequestId).expect(403);          // QC head first
    await approve(f.qcHead, ov.body.approvalRequestId).expect(200);
    await approve(f.plantHead, ov.body.approvalRequestId).expect(200);
    const after = await get(f, id);
    expect(after.overrides[0]).toMatchObject({ status: 'Approved', deviationNo: expect.stringMatching(/^DEV\//) });
    expect(after.deviations[0]).toMatchObject({ category: 'QUARANTINE_OVERRIDE', status: 'Open', lotStatus: 'Quarantine' });
    expect(Number(after.materials.find((m: { id: string }) => m.id === mEdta).coveredQty)).toBe(1200);
    while ((await relayOutbox(db)) > 0);
    const notes = (await f.qaHead.get('/api/v1/notifications').expect(200)).body.data;
    expect(notes.some((n: { title: string }) => n.title.startsWith('Deviation raised'))).toBe(true);

    // stores issues it from quarantine
    const qRes = after.reservations.find((x: { lotId: string }) => x.lotId === qLot);
    expect(qRes.bucket).toBe('QUARANTINE');
    await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: [{ reservationId: qRes.id, qty: 50 }] }).expect(201);
    expect(await lotQty(qLot, 'QUARANTINE')).toBe(450);

    // QA cannot close the deviation while the lot is undecided; after QC releases it, QA closes it
    const devId = after.deviations[0].id;
    expect((await f.qaHead.get(`/api/v1/qa/deviations/${devId}`).expect(200)).body).toMatchObject({ waitingForQc: true, allowedActions: [] });
    const early = await f.qaHead.post(`/api/v1/qa/deviations/${devId}/close`, { note: '[TEST]' }).expect(422);
    expect(early.body.error.code).toBe('LOT_STILL_IN_QUARANTINE');
    await db.query(`update inv.lots set qc_status = 'Released' where id = $1`, [qLot]);
    await f.supervisor.post(`/api/v1/qa/deviations/${devId}/close`, { note: 'x' }).expect(403);
    await f.qaHead.post(`/api/v1/qa/deviations/${devId}/close`, { note: '[TEST] lot released by QC; no impact' }).expect(200);
    expect((await f.qaHead.get(`/api/v1/qa/deviations/${devId}`).expect(200)).body.status).toBe('Closed');

    // a pending override is withdrawn with its approval when the order is cancelled
    const qLot2 = await stockLot(f.edta, f.rmWh, 800, { status: 'Quarantine' });
    const id2 = await approvedOrder(f, 1000);
    await f.planner.post(`/api/v1/production-orders/${id2}/release`, { acceptShortage: true, reason: '[TEST]' }).expect(200);
    const o2 = await get(f, id2);
    const m2 = o2.materials.find((m: { itemId: string }) => m.itemId === f.edta);
    const ov2 = await f.supervisor.post(`/api/v1/production-orders/${id2}/overrides`, { orderMaterialId: m2.id, lotId: qLot2, qty: Number(m2.requiredQty) - Number(m2.coveredQty), reason: '[TEST]' });
    expect(ov2.status).toBe(201);
    await f.planner.post(`/api/v1/production-orders/${id2}/cancel`, { reason: '[TEST]' }).expect(200);
    expect((await db.query(`select status from wf.approval_requests where id = $1`, [ov2.body.approvalRequestId])).rows[0].status).toBe('Cancelled');
    expect((await db.query(`select status from mfg.quarantine_overrides where id = $1`, [ov2.body.id])).rows[0].status).toBe('Cancelled');
  });
});
