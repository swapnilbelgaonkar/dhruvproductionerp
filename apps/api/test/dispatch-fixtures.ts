import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent } from './helpers';
import { completedBatch, lotQty, prodSetup } from './production-fixtures';

/** A completed batch packed into 1 L bottles (12 per box), an approved sales order for 30 of them, and the logistics people. */
export async function ready() {
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
export async function release(lotId: string, warehouseId: string) {
  const q = await lotQty(lotId, 'QUARANTINE');
  await db.query(`update inv.lots set qc_status = 'Released', qa_disposition = 'Released' where id = $1`, [lotId]);
  const item = (await db.query(`select item_id from inv.lots where id = $1`, [lotId])).rows[0].item_id;
  await db.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id) values
    ($1,$2,$3,'QUARANTINE',$4,100,'QA_RELEASE','test',$2), ($1,$2,$3,'UNRESTRICTED',$5,100,'QA_RELEASE','test',$2)`, [item, lotId, warehouseId, -q, q]);
}

