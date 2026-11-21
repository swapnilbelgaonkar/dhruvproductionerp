import { gstinCheckDigit } from '@dhruv/contracts';
import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent, type Agent } from './helpers';

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const randomPan = () => Array.from({ length: 5 }, () => L[Math.floor(Math.random() * 26)]).join('') + String(Math.floor(1000 + Math.random() * 8999)) + L[Math.floor(Math.random() * 26)];
export const gstinFor = (pan: string, state = '27') => { const b = `${state}${pan}1Z`; return b + gstinCheckDigit(b); };
export const mobile = () => `9${String(Math.floor(100000000 + Math.random() * 899999999))}`;
export const inDays = (n: number) => { const d = new Date(`${todayIST()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export async function setup() {
  const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
  const emp = async (name: string, managerId: string | null) =>
    (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: `[TEST] ${name}`, managerId }).expect(201)).body.id as string;
  const storesHeadE = await emp('Stores head', null);
  const keeperE = await emp('Storekeeper', storesHeadE);
  const le = (await db.query(`insert into org.legal_entities (code, name, pan, state_code, status) values ($1,'[TEST] Buyer Pvt Ltd','AAAAA0000A','27','Active') returning id`, [uniq('LE')])).rows[0].id as string;
  const wh = (await db.query(`insert into org.warehouses (legal_entity_id, code, name, type, state_code, status) values ($1,$2,'[TEST] RM store','RM','27','Active') returning id`, [le, uniq('WH')])).rows[0].id as string;
  const hsn = (await db.query(`insert into mdm.hsn_codes (code, description) values ($1,'[TEST] zinc sulphate') returning id`, [`2833${String(Math.floor(1000 + Math.random() * 8999))}`])).rows[0].id;
  await db.query(`insert into mdm.tax_rates (hsn_id, gst_rate, valid_from, notes) values ($1, 18, '2025-01-01', '[TEST]')`, [hsn]);
  const item = async (type: string, name: string) => (await db.query(
    `insert into mdm.items (code, name, item_type, base_uom, hsn_id, shelf_life_days, status) values ($1,$2,$3,'KG',$4,365,'Active') returning id`, [uniq('RM'), name, type, hsn])).rows[0].id as string;
  return {
    le, wh, rm: await item('RM', '[TEST] Zinc sulphate'), pm: await item('PM', '[TEST] 1 kg pouch'),
    pe: await userAgent([{ code: 'PURCHASE_EXEC' }]), ph: await userAgent([{ code: 'PURCHASE_HEAD' }]),
    verifier: await userAgent([{ code: 'DOC_VERIFIER' }]), fh: await userAgent([{ code: 'FINANCE_HEAD' }]), acc: await userAgent([{ code: 'ACCOUNTS_EXEC' }]),
    keeper: await userAgent([{ code: 'STOREKEEPER' }], { employeeId: keeperE }), storesHead: await userAgent([{ code: 'STORES_HEAD' }], { employeeId: storesHeadE }),
    sales: await userAgent([{ code: 'SALES_SE' }]),
    exec: await userAgent([{ code: 'EXEC_ADMIN' }]),
  };
}
export type F = Awaited<ReturnType<typeof setup>>;

export const upload = async (a: Agent, partyId: string, type: string, extra = '') =>
  (await a.upload(`/api/v1/documents?documentType=${type}&entityType=mdm.party&entityId=${partyId}&title=${type}&fileName=${type}.pdf${extra}`, PDF, 'application/pdf').expect(201)).body.id as string;
export const approve = (a: Agent, id: string) => a.post(`/api/v1/approvals/${id}/decisions`, { decision: 'Approve' });


/** An already-approved vendor (onboarding itself is covered in purchase.test.ts): active, bank verified, approved for the items. */
export async function activeVendor(f: F, itemIds: string[], opts: { state?: string; rating?: number; gstRegistered?: boolean } = {}) {
  const pan = randomPan();
  const state = opts.state ?? '27';
  const gst = opts.gstRegistered ?? true;
  const p = (await db.query(
    `insert into mdm.parties (code, legal_name, constitution, pan, gst_registered, gstin, contact_person, mobile) values ($1,$2,'PVT_LTD',$3,$4,$5,'[TEST] Sales',$6) returning id`,
    [uniq('VEN-T-'), `[TEST] ${uniq('Supplier ')}`, pan, gst, gst ? gstinFor(pan, state) : null, mobile()])).rows[0].id as string;
  await db.query(`insert into mdm.vendor_profiles (party_id, vendor_category, payment_terms_days, rating, status, activated_at) values ($1,'RAW_MATERIAL',30,$2,'Active',now())`, [p, opts.rating ?? null]);
  await db.query(`insert into mdm.party_addresses (party_id, kind, line1, city, district, state_code, pincode) values ($1,'REGISTERED','[TEST] Works','City','District',$2,'411001')`, [p, state]);
  const docType = 'CANCELLED_CHEQUE';
  const doc = (await db.query(`insert into sys.documents (document_type, entity_type, entity_id, title) values ($1,'mdm.party',$2,'[TEST] cheque') returning id`, [docType, p])).rows[0].id;
  await db.query(`insert into mdm.party_bank_accounts (party_id, account_holder, bank_name, ifsc, account_no_enc, account_last4, document_id, verification, verified_at)
                  values ($1,'[TEST]','[TEST] Bank','SBIN0001234','x','1234',$2,'Verified',now())`, [p, doc]);
  for (const i of itemIds) await db.query(`insert into mdm.vendor_items (party_id, item_id, lead_time_days) values ($1,$2,7)`, [p, i]);
  return p;
}

/** An approved requisition for the raw material. */
export async function approvedRequisition(f: F, qty = 2500, priority = 'NORMAL') {
  const pr = await f.keeper.post('/api/v1/purchase-requisitions', { legalEntityId: f.le, warehouseId: f.wh, requiredBy: inDays(14), priority, purpose: '[TEST] production plan',
    lines: [{ itemId: f.rm, qty, estimatedRate: 62 }] }).expect(201);
  const sub = await f.keeper.post(`/api/v1/purchase-requisitions/${pr.body.id}/submit`).expect(200);
  await approve(priority === 'EMERGENCY' ? f.ph : f.storesHead, sub.body.approvalRequestId).expect(200);
  const d = (await f.pe.get(`/api/v1/purchase-requisitions/${pr.body.id}`).expect(200)).body;
  return { id: pr.body.id as string, docNo: d.docNo as string, lineId: (await db.query(`select id from purchase.requisition_lines where requisition_id = $1`, [pr.body.id])).rows[0].id as string };
}

// ---------- receipt and QC helpers (shared by the receipt, return and invoice tests)
/** An approved, issued PO for the raw material. */
export async function issuedPo(f: F, vendor: string, qty: number, prLineId?: string) {
  const po = await f.pe.post('/api/v1/purchase-orders', { partyId: vendor, legalEntityId: f.le, warehouseId: f.wh, deliveryDate: inDays(10), paymentTermsDays: 30,
    deliveryTerms: 'Delivered', lines: [{ itemId: f.rm, qty, rate: 60, requisitionLineId: prLineId ?? null }] }).expect(201);
  const sub = await f.pe.post(`/api/v1/purchase-orders/${po.body.id}/submit`).expect(200);
  await approve(f.ph, sub.body.approvalRequestId).expect(200);
  if (qty * 60 * 1.18 > 100000) await approve(f.fh, sub.body.approvalRequestId).expect(200);
  await f.pe.post(`/api/v1/purchase-orders/${po.body.id}/issue`).expect(200);
  const lineId = (await db.query(`select id from purchase.purchase_order_lines where purchase_order_id = $1`, [po.body.id])).rows[0].id as string;
  return { id: po.body.id as string, lineId };
}
export const grn = (poId: string, poLineId: string, qty: number, over: Record<string, unknown> = {}) => ({
  purchaseOrderId: poId, challanNo: `DC-${qty}`, lines: [{ poLineId, challanQty: qty, receivedQty: qty, vendorLotNo: 'ZN-2611-01', mfgDate: inDays(-10), ...over }],
});
export const receive = async (f: F, poId: string, lineId: string, qty: number) => {
  const g = await f.keeper.post('/api/v1/goods-receipts', grn(poId, lineId, qty)).expect(201);
  const posted = await f.keeper.post(`/api/v1/goods-receipts/${g.body.id}/post`).expect(200);
  const d = (await f.keeper.get(`/api/v1/goods-receipts/${g.body.id}`).expect(200)).body;
  return { id: g.body.id as string, posted: posted.body, inspectionId: d.lines[0].inspectionId as string, lotId: d.lines[0].lotId as string };
};
export const lotStock = async (lotId: string) => Object.fromEntries((await db.query(`select bucket, sum(qty)::float as q from inv.stock_ledger where lot_id = $1 group by bucket`, [lotId])).rows.map((r) => [r.bucket, r.q]));
export const pass = [{ parameter: 'Zinc (Zn)', specification: '≥ 33.0%', result: '33.4%', pass: true }, { parameter: 'Moisture', specification: '≤ 1.0%', result: '0.6%', pass: true }];

export async function qcUsers() {
  return { analyst: await userAgent([{ code: 'QC_ANALYST' }]), manager: await userAgent([{ code: 'QC_MANAGER' }]) };
}
export async function coa(a: Agent, inspectionId: string) {
  return (await a.upload(`/api/v1/documents?documentType=COA&entityType=qc.inspection&entityId=${inspectionId}&title=CoA&fileName=coa.pdf`, PDF, 'application/pdf').expect(201)).body.id as string;
}

