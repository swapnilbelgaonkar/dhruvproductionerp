import { db, uniq, userAgent, type Agent } from './helpers';

const mobile = () => `9${String(Math.floor(100000000 + Math.random() * 899999999))}`;
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

/** Master data the quotation needs, inserted directly ([TEST] tagged): legal entity in Maharashtra, an HSN with 5% GST, a fertilizer item. */
export async function masters() {
  const le = (await db.query(`insert into org.legal_entities (code, name, pan, state_code, status) values ($1,'[TEST] Seller Pvt Ltd','AAAAA0000A','27','Active') returning id`,
    [uniq('LE')])).rows[0].id as string;
  await db.query(`insert into org.gst_registrations (legal_entity_id, state_code, gstin) values ($1,'27',$2)`, [le, `27AABCD${digits(4)}E1Z5`]);
  const hsn = (await db.query(`insert into mdm.hsn_codes (code, description) values ($1,'[TEST] micronutrient') returning id`, [`3105${digits(4)}`])).rows[0].id;
  await db.query(`insert into mdm.tax_rates (hsn_id, gst_rate, valid_from, notes) values ($1, 5, '2025-01-01', '[TEST]')`, [hsn]);
  const cat = (await db.query(`insert into mdm.product_categories (code, name, licence_required) values ($1,'[TEST] Fertilizer','FERTILIZER') returning id`, [uniq('CAT')])).rows[0].id;
  const pack = async (name: string) => {
    const item = (await db.query(`insert into mdm.items (code, name, item_type, category_id, base_uom, hsn_id, shelf_life_days, status) values ($1,$2,'FG',$3,'L',$4,730,'Active') returning id`,
      [uniq('FG'), name, cat, hsn])).rows[0].id;
    return (await db.query(`insert into mdm.item_packs (item_id, pack_code, pack_size, pack_uom, container) values ($1,'1L',1,'L','Bottle') returning id`, [item])).rows[0].id as string;
  };
  return { le, packA: await pack('[TEST] Zinc EDTA 12%'), packB: await pack('[TEST] Boron 20%') };
}

export async function setup() {
  const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
  const terr = async (parentId: string | null, level: number) =>
    (await mdo.post('/api/v1/territories', { parentId, code: uniq('T'), name: `[TEST] T${level}`, level }).expect(201)).body.id as string;
  const state = await terr(null, 4);
  const taluka = await terr(state, 7);
  const taluka2 = await terr(state, 7);
  const emp = async (tier: string, managerId: string | null, territoryId: string) =>
    (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: `[TEST] ${tier}`, salesTier: tier, managerId, territoryId }).expect(201)).body.id as string;
  const rsmE = await emp('RSM', null, state);
  const seE = await emp('SE', rsmE, taluka);
  const se2E = await emp('SE', rsmE, taluka2);
  const scope = { legalEntityIds: [], plantIds: [], warehouseIds: [], territoryIds: [] };
  const priceGroup = uniq('G');
  const party = (await db.query(
    `insert into mdm.parties (code, legal_name, constitution, pan, gst_registered, contact_person, mobile) values ($1,'[TEST] Krishi Kendra','PROPRIETORSHIP','AAAAA0000A',false,'Owner',$2) returning id`,
    [uniq('DLR-T-'), mobile()])).rows[0].id as string;
  await db.query(`insert into mdm.dealer_profiles (party_id, dealer_category, territory_id, sales_owner_id, licence_types, price_group, status) values ($1,'DEALER',$2,$3,'{FERTILIZER}',$4,'Active')`,
    [party, taluka, seE, priceGroup]);
  const addr = async (kind: string, state: string) => (await db.query(
    `insert into mdm.party_addresses (party_id, kind, line1, city, district, state_code, pincode) values ($1,$2,'[TEST] Market yard','Baramati','Pune',$3,'413102') returning id`,
    [party, kind, state])).rows[0].id as string;
  return {
    ...(await masters()), party, priceGroup, registered: await addr('REGISTERED', '27'), shipKa: await addr('SHIPPING', '29'),
    ops: await userAgent([{ code: 'SALES_OPS' }]),
    nsm: await userAgent([{ code: 'SALES_NSM' }]),
    fh: await userAgent([{ code: 'FINANCE_HEAD' }]),
    accounts: await userAgent([{ code: 'ACCOUNTS_EXEC' }]),
    rsm: await userAgent([{ code: 'SALES_RSM', scope }], { employeeId: rsmE }),
    se: await userAgent([{ code: 'SALES_SE', scope }], { employeeId: seE }),
    se2: await userAgent([{ code: 'SALES_SE', scope }], { employeeId: se2E }),
  };
}
export type F = Awaited<ReturnType<typeof setup>>;

export async function activePriceList(f: F) {
  const pl = await f.ops.post('/api/v1/price-lists', { code: uniq('PL-'), name: '[TEST] Kharif 2026', priceGroup: f.priceGroup, validFrom: '2026-01-01' }).expect(201);
  await f.ops.post(`/api/v1/price-lists/${pl.body.id}/items`, { itemPackId: f.packA, rate: 245.5, slabs: [{ minQty: 20, discountPct: 5 }, { minQty: 100, discountPct: 8 }] }).expect(201);
  const sub = await f.ops.post(`/api/v1/price-lists/${pl.body.id}/submit`).expect(200);
  await f.nsm.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
  await f.fh.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
  return pl.body.id as string;
}

export async function addLicence(f: F) {
  const docType = (await db.query(`select code from sys.document_types limit 1`)).rows[0].code;
  const doc = (await db.query(`insert into sys.documents (document_type, entity_type, entity_id, title) values ($1,'mdm.party',$2,'[TEST] licence') returning id`, [docType, f.party])).rows[0].id;
  await db.query(`insert into mdm.party_licences (party_id, licence_type, number, issuer, valid_from, valid_to, document_id, verification)
                  values ($1,'FERTILIZER','[TEST] FL-1','Agriculture Dept','2026-01-01','2029-12-31',$2,'Verified')`, [f.party, doc]);
}

export const quote = (f: F, over: Record<string, unknown> = {}) => ({
  partyId: f.party, legalEntityId: f.le, billToId: f.registered, shipToId: f.registered, paymentTerms: '30 days', deliveryTerms: 'Ex-works',
  lines: [{ itemPackId: f.packA, qty: 20, extraDiscountPct: 0 }], ...over,
});
export const approve = (a: Agent, id: string) => a.post(`/api/v1/approvals/${id}/decisions`, { decision: 'Approve' }).expect(200);

