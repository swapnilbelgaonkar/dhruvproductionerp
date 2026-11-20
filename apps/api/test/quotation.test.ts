import { describe, expect, it } from 'vitest';
import { expireQuotations } from '../src/modules/sales/quotations';
import { db, uniq, userAgent, type Agent } from './helpers';

const mobile = () => `9${String(Math.floor(100000000 + Math.random() * 899999999))}`;
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

/** Master data the quotation needs, inserted directly ([TEST] tagged): legal entity in Maharashtra, an HSN with 5% GST, a fertilizer item. */
async function masters() {
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

async function setup() {
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
    rsm: await userAgent([{ code: 'SALES_RSM', scope }], { employeeId: rsmE }),
    se: await userAgent([{ code: 'SALES_SE', scope }], { employeeId: seE }),
    se2: await userAgent([{ code: 'SALES_SE', scope }], { employeeId: se2E }),
  };
}
type F = Awaited<ReturnType<typeof setup>>;

async function activePriceList(f: F) {
  const pl = await f.ops.post('/api/v1/price-lists', { code: uniq('PL-'), name: '[TEST] Kharif 2026', priceGroup: f.priceGroup, validFrom: '2026-01-01' }).expect(201);
  await f.ops.post(`/api/v1/price-lists/${pl.body.id}/items`, { itemPackId: f.packA, rate: 245.5, slabs: [{ minQty: 20, discountPct: 5 }, { minQty: 100, discountPct: 8 }] }).expect(201);
  const sub = await f.ops.post(`/api/v1/price-lists/${pl.body.id}/submit`).expect(200);
  await f.nsm.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
  await f.fh.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
  return pl.body.id as string;
}

async function addLicence(f: F) {
  const docType = (await db.query(`select code from sys.document_types limit 1`)).rows[0].code;
  const doc = (await db.query(`insert into sys.documents (document_type, entity_type, entity_id, title) values ($1,'mdm.party',$2,'[TEST] licence') returning id`, [docType, f.party])).rows[0].id;
  await db.query(`insert into mdm.party_licences (party_id, licence_type, number, issuer, valid_from, valid_to, document_id, verification)
                  values ($1,'FERTILIZER','[TEST] FL-1','Agriculture Dept','2026-01-01','2029-12-31',$2,'Verified')`, [f.party, doc]);
}

const quote = (f: F, over: Record<string, unknown> = {}) => ({
  partyId: f.party, legalEntityId: f.le, billToId: f.registered, shipToId: f.registered, paymentTerms: '30 days', deliveryTerms: 'Ex-works',
  lines: [{ itemPackId: f.packA, qty: 20, extraDiscountPct: 0 }], ...over,
});
const approve = (a: Agent, id: string) => a.post(`/api/v1/approvals/${id}/decisions`, { decision: 'Approve' }).expect(200);

describe('Price lists (CRM-010)', () => {
  it('are maker-checker approved by sales head and finance, frozen once active, and may not overlap', async () => {
    const f = await setup();
    await f.se.post('/api/v1/price-lists', { code: uniq('PL-'), name: 'x', priceGroup: f.priceGroup, validFrom: '2026-01-01' }).expect(403);
    const empty = await f.ops.post('/api/v1/price-lists', { code: uniq('PL-'), name: '[TEST] empty', priceGroup: f.priceGroup, validFrom: '2026-01-01' }).expect(201);
    expect((await f.ops.post(`/api/v1/price-lists/${empty.body.id}/submit`).expect(422)).body.error.code).toBe('PRICE_LIST_EMPTY');

    const id = await activePriceList(f);
    const pl = await f.se.get(`/api/v1/price-lists/${id}`).expect(200);
    expect(pl.body.status).toBe('Active');
    const items = await f.se.get(`/api/v1/price-lists/${id}/items`).expect(200);
    expect(items.body.data[0].slabs).toHaveLength(2);
    await f.ops.post(`/api/v1/price-lists/${id}/items`, { itemPackId: f.packA, rate: 200, slabs: [] }).expect(422);

    // a copy is the way to revise prices; it may not overlap the active list once submitted
    const copy = await f.ops.post(`/api/v1/price-lists/${id}/copy`, { code: uniq('PL-'), name: '[TEST] Rabi', priceGroup: f.priceGroup, validFrom: '2026-06-01' }).expect(201);
    expect((await f.ops.get(`/api/v1/price-lists/${copy.body.id}/items`).expect(200)).body.data).toHaveLength(1);
    expect((await f.ops.post(`/api/v1/price-lists/${copy.body.id}/submit`).expect(422)).body.error.code).toBe('PRICE_LIST_OVERLAP');
  });
});

describe('Quotations (QUO-001…007)', () => {
  it('prices from master data, blocks ineligible dealers, splits GST and auto-approves without extra discount', async () => {
    const f = await setup();
    expect((await f.se.post('/api/v1/quotations/calculate', quote(f)).expect(422)).body.error.code).toBe('NO_PRICE');
    await activePriceList(f);

    // no licence yet: the preview warns, saving refuses
    const pre = await f.se.post('/api/v1/quotations/calculate', quote(f)).expect(200);
    expect(pre.body.warnings.join(' ')).toMatch(/fertilizer licence/);
    expect((await f.se.post('/api/v1/quotations', quote(f)).expect(422)).body.error.code).toBe('DEALER_NOT_ELIGIBLE');
    await addLicence(f);

    // unpriced pack
    expect((await f.se.post('/api/v1/quotations/calculate', quote(f, { lines: [{ itemPackId: f.packB, qty: 1 }] })).expect(422)).body.error.code).toBe('NO_PRICE');

    // intra-state: 20 × 245.50 less 5% slab = 233.23 net; 5% GST split equally
    const c = await f.se.post('/api/v1/quotations/calculate', quote(f)).expect(200);
    expect(c.body.interState).toBe(false);
    expect(c.body.lines[0]).toMatchObject({ schemeDiscountPct: 5, rate: 233.23, taxable: 4664.6, cgst: 116.62, sgst: 116.62, igst: 0 });
    expect(c.body.totals).toMatchObject({ subTotal: 4910, taxableTotal: 4664.6, grandTotal: 4898, roundOff: 0.16 });

    const q = await f.se.post('/api/v1/quotations', quote(f)).expect(201);
    expect(q.body.docNo).toMatch(/^QT\/\d{4}-\d{2}\/\d{6}$/);
    const sub = await f.se.post(`/api/v1/quotations/${q.body.id}/submit`).expect(200);
    expect(sub.body.status).toBe('Approved');
    await f.se.post(`/api/v1/quotations/${q.body.id}/send`).expect(200);
    await f.se.post(`/api/v1/quotations/${q.body.id}/accept`, {}).expect(200);
    const d = await f.se.get(`/api/v1/quotations/${q.body.id}`).expect(200);
    expect(d.body).toMatchObject({ status: 'Accepted', grandTotal: '4898.00', needsApproval: false });
    expect(d.body.print.amountInWords).toBe('Rupees Four Thousand Eight Hundred Ninety Eight Only');
    expect(d.body.print.seller.gstin).toMatch(/^27/);
    // other territory cannot see it; the RSM above can
    await f.se2.get(`/api/v1/quotations/${q.body.id}`).expect(404);
    await f.rsm.get(`/api/v1/quotations/${q.body.id}`).expect(200);
  });

  it('routes an extra discount for approval, revises, duplicates and expires', async () => {
    const f = await setup();
    await activePriceList(f);
    await addLicence(f);

    // inter-state ship-to (Karnataka): IGST, extra discount 2% needs the reporting manager while D15 is pending
    const q = await f.se.post('/api/v1/quotations', quote(f, { shipToId: f.shipKa, lines: [{ itemPackId: f.packA, qty: 10, extraDiscountPct: 2 }] })).expect(201);
    let d = await f.se.get(`/api/v1/quotations/${q.body.id}`).expect(200);
    expect(d.body).toMatchObject({ interState: true, placeOfSupply: '29', cgstTotal: '0.00' });
    expect(Number(d.body.igstTotal)).toBeGreaterThan(0);
    const v = d.body.version;
    await f.se.put(`/api/v1/quotations/${q.body.id}`, { ...quote(f, { shipToId: f.shipKa, lines: [{ itemPackId: f.packA, qty: 10, extraDiscountPct: 3 }] }), version: v }).expect(200);
    await f.se.put(`/api/v1/quotations/${q.body.id}`, { ...quote(f, { shipToId: f.shipKa }), version: v }).expect(409);

    const sub = await f.se.post(`/api/v1/quotations/${q.body.id}/submit`).expect(200);
    expect(sub.body.status).toBe('Submitted');
    await f.se.put(`/api/v1/quotations/${q.body.id}`, { ...quote(f), version: v + 2 }).expect(422);
    await f.se2.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(403);
    await approve(f.rsm, sub.body.approvalRequestId);
    d = await f.se.get(`/api/v1/quotations/${q.body.id}`).expect(200);
    expect(d.body).toMatchObject({ status: 'Approved', needsApproval: true, maxExtraDiscount: '3.00' });
    expect(d.body.allowedActions).toEqual(expect.arrayContaining(['send', 'revise', 'cancel']));

    // revision keeps the number, supersedes the old one, and starts as Draft
    const rev = await f.se.post(`/api/v1/quotations/${q.body.id}/revise`).expect(201);
    expect(rev.body.revision).toBe(2);
    const r2 = await f.se.get(`/api/v1/quotations/${rev.body.id}`).expect(200);
    expect(r2.body).toMatchObject({ docNo: d.body.docNo, status: 'Draft' });
    expect(r2.body.revisions.map((x: { status: string }) => x.status)).toEqual(['Draft', 'Superseded']);
    await f.se.post(`/api/v1/quotations/${q.body.id}/revise`).expect(422);
    const list = await f.se.get(`/api/v1/quotations?q=${encodeURIComponent(d.body.docNo)}`).expect(200);
    expect(list.body.data.map((x: { revision: number }) => x.revision)).toEqual([2]);

    // duplicate → new number; approved quotations past validity expire
    const dup = await f.se.post(`/api/v1/quotations/${rev.body.id}/duplicate`).expect(201);
    expect(dup.body.docNo).not.toBe(d.body.docNo);
    await f.se.post(`/api/v1/quotations/${dup.body.id}/cancel`, { reason: '[TEST] duplicate not needed' }).expect(200);
    const plain = await f.se.post('/api/v1/quotations', quote(f)).expect(201);
    await f.se.post(`/api/v1/quotations/${plain.body.id}/submit`).expect(200);
    await db.query(`update sales.quotations set quote_date = current_date - 10, valid_until = current_date - 3 where id = $1`, [plain.body.id]);
    expect(await expireQuotations(db)).toBeGreaterThanOrEqual(1);
    const exp = await f.se.get(`/api/v1/quotations/${plain.body.id}`).expect(200);
    expect(exp.body.status).toBe('Expired');
    await f.se.post(`/api/v1/quotations/${plain.body.id}/send`).expect(422);
    expect(exp.body.allowedActions).toContain('revise');
  });
});
