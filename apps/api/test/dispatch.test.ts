import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent } from './helpers';
import { completedBatch, lotQty, prodSetup } from './production-fixtures';
import { inDays } from './purchase-fixtures';

/** A completed batch packed into 1 L bottles (12 per box), an approved sales order for 30 of them, and the logistics people. */
async function ready() {
  const f = await prodSetup();
  const { fgLot } = await completedBatch(f);
  const pack = (await db.query(`insert into mdm.item_packs (item_id, pack_code, pack_size, pack_uom, container, units_per_box) values ($1,'1L',1,'L','Bottle',12) returning id`, [f.fg])).rows[0].id as string;
  const run = await f.supervisor.post('/api/v1/packing-runs', { lotId: fgLot, itemPackId: pack, packsFilled: 48, materials: [] }).expect(201);
  const boxes = (await db.query(`select serial, units from inv.boxes where packing_run_id = $1 order by serial`, [run.body.id])).rows as { serial: string; units: number }[];

  // sales order for the pack, approved (inserted directly: the order flow is covered by orders.test.ts)
  const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
  const terr = (await mdo.post('/api/v1/territories', { parentId: null, code: uniq('T'), name: '[TEST] State', level: 4 }).expect(201)).body.id as string;
  const emp = (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: '[TEST] RSM', salesTier: 'RSM', managerId: null, territoryId: terr }).expect(201)).body.id as string;
  const party = (await db.query(`insert into mdm.parties (code, legal_name, constitution, pan, gst_registered, contact_person, mobile) values ($1,'[TEST] Krishi Kendra','PROPRIETORSHIP','AAAAA0000A',false,'Owner','9876543210') returning id`,
    [uniq('DLR-T-')])).rows[0].id as string;
  const addr = (await db.query(`insert into mdm.party_addresses (party_id, kind, line1, city, district, state_code, pincode) values ($1,'REGISTERED','[TEST] Market yard','Baramati','Pune','27','413102') returning id`, [party])).rows[0].id as string;
  const so = (await db.query(`insert into sales.sales_orders (doc_no, party_id, legal_entity_id, seller_state, bill_to_id, ship_to_id, place_of_supply, inter_state, order_date, payment_terms, delivery_terms,
      sales_owner_id, territory_id, status, taxable_total, cgst_total, sgst_total, grand_total) values ($1,$2,$3,'27',$4,$4,'27',false,$5,'30 days','Ex-works',$6,$7,'Approved',6000,150,150,6300) returning id`,
    [uniq('SO-T-'), party, f.le, addr, todayIST(), emp, terr])).rows[0].id as string;
  const line = (await db.query(`insert into sales.sales_order_lines (sales_order_id, line_no, item_pack_id, description, hsn_code, pack_label, qty, list_rate, rate, taxable, gst_rate, cgst, sgst, line_total)
      values ($1,1,$2,'[TEST] Zinc EDTA 12%','31059090','1 L Bottle',30,200,200,6000,5,150,150,6300) returning id`, [so, pack])).rows[0].id as string;
  const logistics = await userAgent([{ code: 'LOGISTICS_HEAD' }]);
  const tr = await logistics.post('/api/v1/shipments/transporters', { code: uniq('TR').slice(0, 20), name: '[TEST] Sahyadri Roadways', gstin: null, phone: '9876500000' }).expect(201);
  return { f, fgLot, pack, boxes, so, line, logistics, transporterId: tr.body.id as string, keeper: f.keeper };
}

/** QA release of the FG lot (QA release itself is covered by qa-release.test.ts): status Released, stock moved to unrestricted. */
async function release(lotId: string, warehouseId: string) {
  const q = await lotQty(lotId, 'QUARANTINE');
  await db.query(`update inv.lots set qc_status = 'Released', qa_disposition = 'Released' where id = $1`, [lotId]);
  const item = (await db.query(`select item_id from inv.lots where id = $1`, [lotId])).rows[0].item_id;
  await db.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id) values
    ($1,$2,$3,'QUARANTINE',$4,100,'QA_RELEASE','test',$2), ($1,$2,$3,'UNRESTRICTED',$5,100,'QA_RELEASE','test',$2)`, [item, lotId, warehouseId, -q, q]);
}

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
