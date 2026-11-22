import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db } from './helpers';
import { ready, release } from './dispatch-fixtures';
import { lotQty } from './production-fixtures';
import { inDays } from './purchase-fixtures';

describe('Dispatch: plan, pick by box scan, load with LR and e-way bill, proof of delivery (LOG-001…LOG-011)', () => {
  it('only scans boxes of released lots, posts exactly what was scanned and closes the order when fully shipped', async () => {
    const { f, fgLot, pack, boxes, so, line, logistics, transporterId, keeper } = await ready();
    expect(boxes.map((b) => b.units)).toEqual([12, 12, 12, 12]);

    // the queue shows the order with its open packs
    const q = (await logistics.get('/api/v1/shipments/queue').expect(200)).body.data.find((x: { id: string }) => x.id === so);
    expect(q.lines[0]).toMatchObject({ open: 30 });

    await keeper.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 24 }] }).expect(403);
    expect((await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.rmWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 24 }] }).expect(422)).body.error.code).toBe('WRONG_WAREHOUSE');
    expect((await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 31 }] }).expect(422)).body.error.code).toBe('OVER_PLANNED');
    const s = await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 24 }] }).expect(201);
    expect(s.body.docNo).toMatch(/^DSP\//);
    // a second shipment can only plan what is left
    expect((await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 7 }] }).expect(422)).body.error.code).toBe('OVER_PLANNED');

    // LOG-003: the lot is still in QA quarantine
    await logistics.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[0]!.serial }).expect(403);
    expect((await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[0]!.serial }).expect(422)).body.error.code).toBe('LOT_NOT_RELEASED');
    await release(fgLot, f.fgWh);
    expect((await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: 'BX-NOPE' }).expect(422)).body.error.code).toBe('UNKNOWN_BOX');
    await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[0]!.serial }).expect(201);
    expect((await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[0]!.serial }).expect(422)).body.error.code).toBe('BOX_NOT_AVAILABLE');
    const second = await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[1]!.serial }).expect(201);
    expect(second.body).toMatchObject({ packs: 12, line: 1 });
    expect((await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[2]!.serial }).expect(422)).body.error.code).toBe('OVER_PICK');

    // un-pick and re-pick
    let d = (await logistics.get(`/api/v1/shipments/${s.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'Picked', pickedValue: 5040, ewbRequired: false });
    expect(d.allowedActions).toEqual(expect.arrayContaining(['dispatch', 'cancel']));
    await keeper.delete(`/api/v1/shipments/${s.body.id}/picks/${d.lines[0].picks[1].id}`).expect(200);
    await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[1]!.serial }).expect(201);

    // LOG-005: above the e-way bill threshold the number is required
    await db.query(`update sys.settings set value = '5000' where key = 'logistics.ewb.thresholdValue'`);
    const load = { transporterId, vehicleNo: 'MH12AB1234', driverName: '[TEST] Ramesh', freightTerms: 'PAID', freightAmount: 1800, lrNo: 'LR-1001', lrDate: todayIST() };
    try {
      expect((await logistics.post(`/api/v1/shipments/${s.body.id}/dispatch`, load).expect(422)).body.error.code).toBe('EWB_REQUIRED');
      await logistics.post(`/api/v1/shipments/${s.body.id}/dispatch`, { ...load, vehicleNo: 'bad' }).expect(400);
      await logistics.post(`/api/v1/shipments/${s.body.id}/dispatch`, { ...load, ewbNo: '123456789012' }).expect(400);   // validity missing
      const out = await logistics.post(`/api/v1/shipments/${s.body.id}/dispatch`, { ...load, ewbNo: '123456789012', ewbValidUntil: inDays(2) }).expect(200);
      expect(out.body).toMatchObject({ status: 'Dispatched', value: 5040, orderClosed: false });
    } finally {
      await db.query(`update sys.settings set value = '50000' where key = 'logistics.ewb.thresholdValue'`);
    }
    expect(await lotQty(fgLot)).toBe(975 - 24);   // packed boxes stay in the lot's stock; 24 L left with the truck
    expect((await db.query(`select status, shipment_id is not null as on from inv.boxes where serial = $1`, [boxes[0]!.serial])).rows[0]).toEqual({ status: 'Dispatched', on: true });
    expect(Number((await db.query(`select dispatched_qty from sales.sales_order_lines where id = $1`, [line])).rows[0].dispatched_qty)).toBe(24);
    await keeper.post(`/api/v1/shipments/${s.body.id}/pick`, { boxSerial: boxes[2]!.serial }).expect(422);

    // POD with a shortage needs remarks
    d = (await logistics.get(`/api/v1/shipments/${s.body.id}`).expect(200)).body;
    expect(d.allowedActions).toEqual(['pod']);
    const pod = { receivedOn: todayIST(), receivedBy: '[TEST] Dealer', lines: [{ shipmentLineId: d.lines[0].id, deliveredPacks: 23 }] };
    expect((await logistics.post(`/api/v1/shipments/${s.body.id}/pod`, { ...pod, lines: [{ shipmentLineId: d.lines[0].id, deliveredPacks: 25 }] }).expect(422)).body.error.code).toBe('OVER_DELIVERED');
    expect((await logistics.post(`/api/v1/shipments/${s.body.id}/pod`, pod).expect(422)).body.error.code).toBe('REMARKS_REQUIRED');
    await logistics.post(`/api/v1/shipments/${s.body.id}/pod`, { ...pod, remarks: '[TEST] one bottle broken' }).expect(200);
    expect((await logistics.get(`/api/v1/shipments/${s.body.id}`).expect(200)).body).toMatchObject({ status: 'Delivered', statusReason: 'Delivered short' });

    // the rest: 6 packs left, boxes hold 12 → plan 6 fails on over-pick; plan the remainder, cancel, then the order stays open
    const s2 = await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 6 }] }).expect(201);
    expect((await keeper.post(`/api/v1/shipments/${s2.body.id}/pick`, { boxSerial: boxes[2]!.serial }).expect(422)).body.error.code).toBe('OVER_PICK');
    await logistics.post(`/api/v1/shipments/${s2.body.id}/cancel`, { reason: '[TEST] dealer will take full boxes next week' }).expect(200);
    expect((await db.query(`select status from sales.sales_orders where id = $1`, [so])).rows[0].status).toBe('Approved');

    // a sales order fully dispatched closes
    await db.query(`update sales.sales_order_lines set qty = 36 where id = $1`, [line]);
    const s3 = await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 12 }] }).expect(201);
    await keeper.post(`/api/v1/shipments/${s3.body.id}/pick`, { boxSerial: boxes[3]!.serial }).expect(201);
    const fin = await logistics.post(`/api/v1/shipments/${s3.body.id}/dispatch`, load).expect(200);
    expect(fin.body.orderClosed).toBe(true);
    expect((await db.query(`select status from sales.sales_orders where id = $1`, [so])).rows[0].status).toBe('Closed');
    void pack;
  });
});
