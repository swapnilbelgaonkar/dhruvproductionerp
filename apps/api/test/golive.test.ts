import { authenticator } from 'otplib';
import supertest from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app, db, PASSWORD, uniq, userAgent } from './helpers';

const csv = (rows: (string | number)[][]) => rows.map((r) => r.join(',')).join('\n');
const acct = async (key: string) => (await db.query(`select code from fin.accounts where system_key = $1`, [key])).rows[0].code as string;

describe('Go-live: bulk import, opening balances, readiness and two-step verification provision (Stage 8, D10, D22)', () => {
  afterAll(async () => {
    await db.query(`update sys.settings set value = 'null' where key = 'golive.cutoverDate'`);
    await db.query(`update sys.settings set value = 'true' where key = 'auth.mfa.enforced'`);
  });

  it('checks a file row by row, saves nothing on error, then imports masters in one go', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const outsider = await userAgent([{ code: 'SALES_SE' }]);
    const e1 = uniq('E'); const e2 = uniq('E');
    const bad = csv([['emp_code', 'full_name', 'mobile', 'manager_emp_code', 'sales_tier'], [e1, 'Sunita Jadhav', '9822000001', '', 'ASM'], [e1, '', '12345', '', 'XYZ']]);
    await outsider.post('/api/v1/imports/employees/validate', { content: bad }).expect(403);
    const v = (await mdo.post('/api/v1/imports/employees/validate', { content: bad, fileName: 'staff.csv' }).expect(200)).body;
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(expect.arrayContaining([{ row: 3, field: 'emp_code', message: 'Same as row 2' }, { row: 3, field: 'full_name', message: 'Required' },
      { row: 3, field: 'mobile', message: '10-digit mobile' }, { row: 3, field: 'sales_tier', message: expect.stringContaining('One of') }]));
    expect((await mdo.post('/api/v1/imports/employees/commit', { content: bad }).expect(422)).body.error.code).toBe('IMPORT_INVALID');
    expect((await db.query(`select 1 from org.employees where emp_code = $1`, [e1])).rowCount).toBe(0);

    const good = csv([['emp_code', 'full_name', 'mobile', 'manager_emp_code', 'sales_tier'], [e1, '[TEST] Sunita Jadhav', '9822000001', '', 'ASM'], [e2, '[TEST] Amol Shinde', '9822000002', e1, 'TSM']]);
    expect((await mdo.post('/api/v1/imports/employees/validate', { content: good }).expect(200)).body).toMatchObject({ ok: true, rows: 2 });
    await mdo.post('/api/v1/imports/employees/commit', { content: good, fileName: 'staff.csv' }).expect(200);
    const emp = (await db.query(`select e.emp_code, m.emp_code as mgr from org.employees e left join org.employees m on m.id = e.manager_id where e.emp_code = any($1) order by e.emp_code`, [[e1, e2]])).rows;
    expect(emp).toEqual(expect.arrayContaining([{ emp_code: e2, mgr: e1 }]));
    // a column that is not in the template is pointed out
    expect((await mdo.post('/api/v1/imports/hsn/validate', { content: csv([['code', 'description', 'rate'], ['31059099', 'x', '5']]) }).expect(200)).body.errors[0]).toMatchObject({ row: 1, field: 'rate' });
    const tpl = await mdo.get('/api/v1/imports/items/template').expect(200);
    expect(tpl.text).toContain('code,name,item_type,category_code,base_uom,hsn_code');
    const out = await mdo.get('/api/v1/imports/export/employees').expect(200);
    expect(out.text).toContain(`${e2},[TEST] Amol Shinde`);
    const runs = (await mdo.get('/api/v1/imports').expect(200)).body;
    expect(runs.kinds.map((k: { id: string }) => k.id)).not.toContain('opening-ledger');           // masters only for this role
    expect(runs.runs.find((x: { kind: string; status: string }) => x.kind === 'employees' && x.status === 'Committed')).toBeTruthy();
  });

  it('loads opening balances that agree with each other, and carries them into collections and payments', async () => {
    const fh = await userAgent([{ code: 'FINANCE_HEAD' }]);
    const admin = await userAgent([{ code: 'EXEC_ADMIN' }]);
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const leCode = uniq('LE').slice(0, 12);
    const le = (await db.query(`insert into org.legal_entities (code, name, pan, registered_address, state_code, status) values ($1,'[TEST] Opening Co','AAAAA0000A','Pune','27','Active') returning id`, [leCode])).rows[0].id;
    const wh = (await db.query(`insert into org.warehouses (legal_entity_id, code, name, type, state_code, status) values ($1,$2,'[TEST] FG','FG','27','Active') returning code`, [le, uniq('WH').slice(0, 12)])).rows[0].code;
    const item = (await db.query(`insert into mdm.items (code, name, item_type, base_uom, status) values ($1,'[TEST] Zinc EDTA','FG','L','Active') returning code`, [uniq('IT')])).rows[0].code;
    const terr = (await db.query(`insert into org.territories (code, name, level, path) values ($1,'[TEST] Area',1,$2::ltree) returning code`, [uniq('T'), uniq('t').toLowerCase()])).rows[0].code;
    const owner = uniq('E');
    await db.query(`insert into org.employees (emp_code, full_name) values ($1,'[TEST] Owner')`, [owner]);

    // a dealer and a vendor through the importer (Draft — KYC and approval follow as usual)
    const party = ['legal_name', 'constitution', 'pan', 'contact_person', 'mobile', 'address_line1', 'city', 'district', 'state_code', 'pincode'];
    await mdo.post('/api/v1/imports/dealers/commit', { content: csv([[...party, 'dealer_category', 'territory_code', 'sales_owner_emp_code', 'credit_days'],
      ['[TEST] Krishi Seva', 'PROPRIETORSHIP', 'ABCPK1234D', 'Rajesh', '9822012345', 'Market Yard', 'Niphad', 'Nashik', '27', '422303', 'DEALER', terr, owner, '30']]) }).expect(200);
    await mdo.post('/api/v1/imports/vendors/commit', { content: csv([[...party, 'vendor_category'], ['[TEST] Mahalaxmi Minerals', 'PVT_LTD', 'AABCM1234E', 'Sales', '9822012346', 'MIDC', 'Jalna', 'Jalna', '27', '431203', 'RAW_MATERIAL']]) }).expect(200);
    const dealer = (await db.query(`select p.id, p.code, d.status from mdm.parties p join mdm.dealer_profiles d on d.party_id = p.id where p.legal_name = '[TEST] Krishi Seva' order by p.created_at desc limit 1`)).rows[0];
    const vendor = (await db.query(`select p.id, p.code from mdm.parties p join mdm.vendor_profiles v on v.party_id = p.id where p.legal_name = '[TEST] Mahalaxmi Minerals' order by p.created_at desc limit 1`)).rows[0];
    expect(dealer.status).toBe('Draft');

    const ar = csv([['legal_entity_code', 'dealer_code', 'invoice_no', 'invoice_date', 'due_date', 'outstanding'], [leCode, dealer.code, 'T/2526/1187', '11/02/2026', '13/03/2026', '"48,500"']]);
    expect((await fh.post('/api/v1/imports/opening-receivables/validate', { content: ar }).expect(422)).body.error.code).toBe('NO_CUTOVER_DATE');
    await fh.put('/api/v1/golive/cutover', { date: '2026-04-01' }).expect(403);
    await admin.put('/api/v1/golive/cutover', { date: '2026-04-01' }).expect(200);
    await mdo.post('/api/v1/imports/opening-receivables/validate', { content: ar }).expect(403);
    await fh.post('/api/v1/imports/opening-receivables/commit', { content: ar }).expect(200);
    await fh.post('/api/v1/imports/opening-payables/commit', { content: csv([['legal_entity_code', 'vendor_code', 'bill_no', 'bill_date', 'due_date', 'outstanding'], [leCode, vendor.code, 'MMPL/25-26/0931', '2026-03-02', '2026-04-01', '126000']]) }).expect(200);
    // the same invoice twice is refused
    expect((await fh.post('/api/v1/imports/opening-receivables/validate', { content: ar }).expect(200)).body.errors[0]).toMatchObject({ field: 'invoice_no', message: 'Already brought forward' });

    const [AR, AP, BANK, CAP, INV] = (await Promise.all(['AR_TRADE', 'AP_TRADE', 'BANK', 'CAPITAL', 'INV_FG'].map(acct))) as [string, string, string, string, string];
    const tb = csv([['legal_entity_code', 'account_code', 'party_code', 'debit', 'credit'], [leCode, AR, dealer.code, '48500', ''], [leCode, AP, vendor.code, '', '126000'],
      [leCode, BANK, '', '250000', ''], [leCode, CAP, '', '', '343500']]);
    const v = (await fh.post('/api/v1/imports/opening-ledger/validate', { content: csv([['legal_entity_code', 'account_code', 'party_code', 'debit', 'credit'], [leCode, INV, '', '1', ''], [leCode, AR, '', '5', '']]) }).expect(200)).body;
    expect(v.errors.map((e: { field: string }) => e.field)).toEqual(['account_code', 'party_code']);
    const t = (await fh.post('/api/v1/imports/opening-ledger/commit', { content: tb }).expect(200)).body;
    expect(t.summary[leCode]).toMatchObject({ debit: 298500, credit: 469500, toOpeningEquity: -171000 });
    // stock worth exactly the difference: 1,200 L × ₹142.50
    await fh.post('/api/v1/imports/opening-stock/commit', { content: csv([['warehouse_code', 'item_code', 'lot_no', 'mfg_date', 'expiry_date', 'qty', 'unit_cost', 'qc_status'],
      [wh, item, uniq('OB-'), '2026-01-10', '2028-01-09', '1200', '142.50', 'Released']]) }).expect(200);

    const r = (await admin.get('/api/v1/golive').expect(200)).body;
    const c = r.checks.find((x: { key: string }) => x.key === `opening:${leCode}`);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('opening balance equity left ₹0');
    expect(r.checks.find((x: { key: string }) => x.key === 'mfa')).toMatchObject({ status: 'ok' });            // the test run switches it on
    expect(r.ready).toBe(false);

    // collections and payments carry on from the brought-forward items
    const stmt = (await fh.get(`/api/v1/receivables/credit/${dealer.id}`).expect(200)).body;
    expect(JSON.stringify(stmt)).toContain('48500');
    const open = (await fh.get(`/api/v1/payments/payables?legalEntityId=${le}&payeeType=VENDOR&payeeId=${vendor.id}`).expect(200)).body;
    expect(open.data).toEqual([expect.objectContaining({ outstanding: 126000 })]);
    // the cut-over date is fixed once the opening journal is posted
    expect((await admin.put('/api/v1/golive/cutover', { date: '2026-05-01' }).expect(422)).body.error.code).toBe('OPENING_POSTED');

    await admin.post('/api/v1/golive/signoff/uat', {}).expect(400);
    await admin.post('/api/v1/golive/signoff/uat', { note: 'UAT minutes 2026-03-20, all heads signed' }).expect(200);
    expect((await admin.get('/api/v1/golive').expect(200)).body.manual.find((m: { key: string }) => m.key === 'uat')).toMatchObject({ status: 'ok', note: 'UAT minutes 2026-03-20, all heads signed' });
    await admin.post('/api/v1/golive/signoff/uat', { undo: true }).expect(200);
  });

  it('lets anyone set up two-step verification while it is off, and accepts a single-use recovery code once it is on', async () => {
    await db.query(`update sys.settings set value = 'false' where key = 'auth.mfa.enforced'`);
    const u = await userAgent([{ code: 'ACCOUNTS_EXEC' }]);
    const en = (await u.post('/api/v1/auth/mfa/enrol').expect(200)).body;
    const done = (await u.post('/api/v1/auth/mfa/enrol/confirm', { code: authenticator.generate(en.secret) }).expect(200)).body;
    expect(done.recoveryCodes).toHaveLength(10);
    expect(done.recoveryCodes[0]).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // with the switch off an enrolled user is still not asked
    const login = async () => { const a = supertest.agent(app); const r = await a.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200); return { a, r: r.body as { mfaRequired: boolean; csrfToken: string } }; };
    expect((await login()).r.mfaRequired).toBe(false);
    await db.query(`update sys.settings set value = 'true' where key = 'auth.mfa.enforced'`);
    const { a, r } = await login();
    expect(r.mfaRequired).toBe(true);
    await a.get('/api/v1/sales-invoices').expect(409);
    const code = done.recoveryCodes[3].toLowerCase().replace('-', ' ');
    expect((await a.post('/api/v1/auth/mfa/verify').set('x-csrf-token', r.csrfToken).send({ recoveryCode: code }).expect(200)).body.recoveryCodesLeft).toBe(9);
    await a.get('/api/v1/sales-invoices').expect(200);
    const again = await login();
    await again.a.post('/api/v1/auth/mfa/verify').set('x-csrf-token', again.r.csrfToken).send({ recoveryCode: code }).expect(401);
    // new codes void the old ones
    const fresh = (await a.post('/api/v1/auth/mfa/recovery-codes').set('x-csrf-token', r.csrfToken).expect(200)).body.codes;
    expect(fresh).toHaveLength(10);
    await again.a.post('/api/v1/auth/mfa/verify').set('x-csrf-token', again.r.csrfToken).send({ recoveryCode: done.recoveryCodes[0] }).expect(401);
    await again.a.post('/api/v1/auth/mfa/verify').set('x-csrf-token', again.r.csrfToken).send({ recoveryCode: fresh[0] }).expect(200);
  });
});

describe('Company product list loader', () => {
  it('reads pack sizes and category names the way the brochure writes them', async () => {
    const { parsePacking } = await import('../src/modules/golive/imports');
    const { categoryCode } = await import('../src/db/load-products');
    expect(parsePacking('100gm, 250gm, 500gm & 1Kg')).toEqual({ packs: [{ code: '100G', size: 100, uom: 'G', base: 'KG' }, { code: '250G', size: 250, uom: 'G', base: 'KG' },
      { code: '500G', size: 500, uom: 'G', base: 'KG' }, { code: '1KG', size: 1, uom: 'KG', base: 'KG' }] });
    expect(parsePacking('250ml, 1Ltr & 5Ltr')).toMatchObject({ packs: [{ code: '250ML', uom: 'ML', base: 'L' }, { code: '1L', uom: 'L' }, { code: '5L', uom: 'L' }] });
    expect(parsePacking('1600ml')).toMatchObject({ packs: [{ code: '1600ML', size: 1600 }] });
    expect(parsePacking('a few bottles')).toEqual({ error: expect.stringContaining('not understood') });
    const taken = new Set<string>();
    expect(categoryCode('Chelated Micronutrient Fertilizers', taken)).toBe('CHELATED');
    expect(categoryCode('CIB Reg. Insecticide Series', taken)).toBe('CIB-INSECTICIDE');
    expect(categoryCode('100% Water Soluble Mixture Fertilizers', taken)).toBe('100-WATER-SOLUBLE');
    expect(categoryCode('Chelated Micronutrient Fertilizers', taken)).toBe('CHELATED-2');
  });

  it('loads every column of a product row into a Draft item, leaving what the list does not give empty', async () => {
    const { loadProducts } = await import('../src/db/load-products');
    const name = uniq('[TEST] NEOFERT Zn-EDTA ');
    const sr = String(900 + Math.floor(Math.random() * 99));
    const csv = `Sr No,Category,Product Name,Active Ingredient / Type,Composition / Technical Content,Key Benefits / Uses,Advisory Dosage,Packing Available,FCO Grade (as marked in brochure),Brochure Page
${sr},[TEST] Chelated Micronutrient Fertilizers,${name},"Zinc (Zn) 12%, EDTA chelated",Zn 12%,Reduces zinc deficiency.,Foliar: 0.5-1 g/L water,"100gm, 250gm & 1Kg",Not marked,7`;
    await db.query(`delete from mdm.item_packs where item_id in (select id from mdm.items where code = $1)`, [`FG-${sr}`]);
    await db.query(`delete from mdm.items where code = $1`, [`FG-${sr}`]);
    const r = await loadProducts(db, csv, { userId: null, label: 'test' });
    expect(r).toMatchObject({ ok: true, rows: 1 });
    const it = (await db.query(`select i.*, c.name as cat from mdm.items i join mdm.product_categories c on c.id = i.category_id where i.code = $1`, [`FG-${sr}`])).rows[0];
    expect(it).toMatchObject({ name, cat: '[TEST] Chelated Micronutrient Fertilizers', item_type: 'FG', status: 'Draft', base_uom: 'KG', active_ingredient: 'Zinc (Zn) 12%, EDTA chelated',
      composition: 'Zn 12%', key_benefits: 'Reduces zinc deficiency.', advisory_dosage: 'Foliar: 0.5-1 g/L water', fco_grade: null, brochure_page: 7, hsn_id: null, shelf_life_days: null });
    const packs = (await db.query(`select pack_code, container, units_per_box from mdm.item_packs where item_id = $1 order by pack_code`, [it.id])).rows;
    expect(packs).toEqual([{ pack_code: '100G', container: null, units_per_box: 1 }, { pack_code: '1KG', container: null, units_per_box: 1 }, { pack_code: '250G', container: null, units_per_box: 1 }]);
    // an incomplete product cannot be submitted for approval
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const sub = await mdo.post(`/api/v1/items/${it.id}/submit`, { version: it.version }).expect(422);
    expect(sub.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['hsnId', 'shelfLifeDays']));
  });
});

describe('Purchased-material list loader', () => {
  it('puts each group in its category with the right item type, codes in name order, and skips names already present', async () => {
    const { loadMaterials } = await import('../src/db/load-materials');
    const a = uniq('[TEST] Zinc Sulphate '); const b = uniq('[TEST] 1 Ltr HDPE Bottle '); const c = uniq('[TEST] Hand Gloves ');
    const csv = `name,group,quantity,rate,value\n${a},Raw Material,100,10,1000\n${b},Packing Material,5,2,10\n${c},Labour Consumables,,,\n`;
    expect(await loadMaterials(db, csv, { userId: null, label: 'test' })).toMatchObject({ ok: true, rows: 3 });
    const got = (await db.query(`select i.name, i.item_type, i.status, i.base_uom, i.code, c.code as cat from mdm.items i join mdm.product_categories c on c.id = i.category_id where i.name = any($1) order by i.item_type, i.name`, [[a, b, c]])).rows;
    expect(got.map((x) => [x.name, x.item_type, x.cat, x.status, x.base_uom])).toEqual([[b, 'PM', 'PACKING-MATERIAL', 'Draft', null], [c, 'RM', 'LABOUR-CONSUMABLES', 'Draft', null], [a, 'RM', 'RAW-MATERIAL', 'Draft', null]]);
    expect(got.find((x) => x.name === c).code).toMatch(/^LC-\d{3}$/);
    expect(await loadMaterials(db, csv, { userId: null, label: 'test' })).toMatchObject({ ok: true, rows: 0 });
  });
});

describe('Vendor list loader', () => {
  it('reads messy cells as written in the list and leaves the rest of KYC empty', async () => {
    const { parseVendorRow } = await import('../src/db/load-vendors');
    expect(parseVendorRow({ group: 'Packing Material Creditors', name: 'SAMPLE  CHEMICALS', address: 'B-1/1, MIDC AREA,, NASHIK - 422010, EXAMPLE BANK LTD, A/C NO - 00000000000000, IFSC CODE - ABCD0000000',
      state: 'Maharashtra', pin_code: '', mobile_number: '9000000001', mail_id: 'Sales@Example.com', gstin: '27ABCDE1234F1Z5' }))
      .toMatchObject({ name: 'SAMPLE CHEMICALS', category: 'PACKAGING', address: 'B-1/1, MIDC AREA,, NASHIK - 422010', stateCode: '27', pincode: '422010', mobile: '9000000001', phoneNumbers: null,
        email: 'sales@example.com', gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', notes: ['bank details removed from the address'] });
    expect(parseVendorRow({ group: 'Factory other creditors', name: 'X', address: '', state: '', pin_code: '', mobile_number: '0253-1234567, 9000000002/9000000003', mail_id: 'N/A', gstin: 'N/A' }))
      .toMatchObject({ category: 'OTHER', mobile: '9000000002', phoneNumbers: '0253-1234567, 9000000002/9000000003', email: null, gstin: null, pan: null, stateCode: null, pincode: null });
    expect(parseVendorRow({ group: 'Factory other creditors', name: 'Y', mobile_number: '90000 00004', state: 'Dadra & Nagar Haveli and Daman & Diu' }))
      .toMatchObject({ mobile: '9000000004', phoneNumbers: null, stateCode: '26' });
  });

  it('creates Draft vendors that cannot be submitted until KYC is complete, and skips ones already present', async () => {
    const { loadVendors } = await import('../src/db/load-vendors');
    const name = uniq('[TEST] Sample Packaging ');
    const csv = `group,name,address,state,pin_code,mobile_number,mail_id,gstin\nPacking Material Creditors,${name},"Plot A-1, MIDC Area, Nashik",Maharashtra,422010,9000000005,a@b.in,\n`;
    const r = await loadVendors(db, csv, { userId: null, label: 'test' });
    expect(r.created).toHaveLength(1);
    expect((await loadVendors(db, csv, { userId: null, label: 'test' })).skipped).toHaveLength(1);
    const p = (await db.query(`select p.id, p.constitution, p.contact_person, p.pan, vp.status, vp.vendor_category, a.city, a.pincode from mdm.parties p join mdm.vendor_profiles vp on vp.party_id = p.id
        left join mdm.party_addresses a on a.party_id = p.id where p.legal_name = $1`, [name])).rows[0];
    expect(p).toMatchObject({ constitution: null, contact_person: null, pan: null, status: 'Draft', vendor_category: 'PACKAGING', city: null, pincode: '422010' });
    const pe = await userAgent([{ code: 'PURCHASE_EXEC' }]);
    const ready = (await pe.get(`/api/v1/vendors/${p.id}`).expect(200)).body;
    expect(JSON.stringify(ready)).toContain('Missing: constitution, PAN, contact person');
    const sub = await pe.post(`/api/v1/vendors/${p.id}/submit`, {}).expect(422);
    expect(sub.body.error.code).toBe('NOT_READY');
    expect(sub.body.error.details.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['kyc.details', 'addr.complete']));
  });
});

describe('Dealer list loader', () => {
  it('reads the dealer columns, takes PAN from the GSTIN when the PAN cell is empty, and keeps a shared GSTIN on the first branch only', async () => {
    const { parseDealerRow, loadDealers } = await import('../src/db/load-dealers');
    expect(parseDealerRow({ company: 'Sample  Krushi Kendra', address: 'Main Road, Taluka X, 425001', pincode: '', state: 'Maharashtra', mobile_no: 'N/A', e_mail: 'Info@Example.com', gstin_uin: '27ABCDE1234F1Z5', pan_no: '' }))
      .toMatchObject({ name: 'Sample Krushi Kendra', stateCode: '27', pincode: '425001', mobile: null, email: 'info@example.com', gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', notes: [] });
    expect(parseDealerRow({ company: 'Y', pan_no: 'ZZZZZ9999Z', gstin_uin: '27ABCDE1234F1Z5', state: 'Madhya Pradesh' }).notes)
      .toEqual(['PAN ZZZZZ9999Z is not the one in GSTIN 27ABCDE1234F1Z5', 'GSTIN state 27 differs from the address state 23']);
    const a = uniq('[TEST] Agro Branch A '); const b = uniq('[TEST] Agro Branch B ');
    const g = `27${String.fromCharCode(65 + Math.floor(Math.random() * 26))}BCDE${String(Math.floor(1000 + Math.random() * 8999))}F1Z5`;
    const csv = `sr_no,company,address,pincode,state,mobile_no,e_mail,gstin_uin,pan_no\n1,${a},Market Yard,422003,Maharashtra,9000000006,,${g},\n2,${b},Panchavati,422003,Maharashtra,,,${g},\n`;
    const r = await loadDealers(db, csv, { userId: null, label: 'test' });
    expect(r.created.map((x) => x.notes.length)).toEqual([0, 1]);
    const rows = (await db.query(`select p.legal_name, p.gstin, p.pan, d.status, d.territory_id, d.dealer_category from mdm.parties p join mdm.dealer_profiles d on d.party_id = p.id where p.legal_name = any($1) order by p.legal_name`, [[a, b]])).rows;
    expect(rows).toEqual([{ legal_name: a, gstin: g, pan: g.slice(2, 12), status: 'Draft', territory_id: null, dealer_category: null }, { legal_name: b, gstin: null, pan: g.slice(2, 12), status: 'Draft', territory_id: null, dealer_category: null }]);
    const ops = await userAgent([{ code: 'SALES_OPS' }]);
    const id = (await db.query(`select id from mdm.parties where legal_name = $1`, [a])).rows[0].id;
    const sub = await ops.post(`/api/v1/dealers/${id}/submit`, {}).expect(422);
    expect(sub.body.error.details.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['kyc.details', 'profile', 'addr.complete']));
  });
});

describe('Staff list loader', () => {
  it('reads the staff columns, links reporting lines by name, makes no sign-ins, and shows personal details only to those allowed', async () => {
    const { parseEmployeeRow, loadEmployees } = await import('../src/db/load-employees');
    expect(parseEmployeeRow({ team: 'Nagpur A', emp_code: 'dapl emp 9', sr: '3', employee_name: 'Test  Person', headquarters: 'Nagpur', district: 'Nagpur', area: 'Vidarbha', reporting_to: 'Some One Sir',
      designation: 'Sr. ASM', mobile_number: '9000000007/ 9000000008', educational_details: 'B.Sc Agri', date_of_joining: '01.07.2026', email: 'a@x.in/ b@x.in', id_card: 'DAPLEMP9', blood_group: 'o+ve' }))
      .toMatchObject({ code: 'DAPLEMP9', name: 'Test Person', salesTier: 'SASM', mobile: '9000000007', phoneNumbers: '9000000007/ 9000000008', email: 'a@x.in', dateOfJoining: '2026-07-01', bloodGroup: 'O+', serialNo: 3 });
    expect(parseEmployeeRow({ emp_code: 'X1', employee_name: 'Y', designation: 'MDO', date_of_joining: '-', blood_group: 'N/A', mobile_number: '-' }))
      .toMatchObject({ salesTier: null, dateOfJoining: null, dateOfJoiningText: null, bloodGroup: null, mobile: null });
    const boss = uniq('TB'); const rep = uniq('TR');
    const bossName = `${uniq('Bossa')} Vijay ${uniq('Sharma')}`;
    const parts = bossName.split(' ');
    const csv = `team,emp_code,sr,employee_name,headquarters,district,area,reporting_to,designation,mobile_number,educational_details,date_of_joining,email,id_card,blood_group
OFFICE,${boss},1,${bossName},Nashik,Nashik,Office,-,Director,9000000009,MBA,2020-01-15,,${boss},B+VE
OFFICE,${rep},2,${uniq('Rep')} Person,Nashik,Nashik,Office,${parts[0]} ${parts[2]} Sir / Other Person,Accounts Executive,,BCom,2023-04-18,,${rep},A+ve
`;
    const r = await loadEmployees(db, csv, { userId: null, label: 'test' });
    expect(r.created).toHaveLength(2);
    const e = (await db.query(`select e.id, e.team, e.blood_group, e.date_of_joining::text as doj, m.emp_code as mgr from org.employees e left join org.employees m on m.id = e.manager_id where e.emp_code = $1`, [rep])).rows[0];
    expect(e).toMatchObject({ team: 'OFFICE', blood_group: 'A+', doj: '2023-04-18', mgr: boss });
    expect((await db.query(`select count(*)::int as n from iam.users u join org.employees x on x.id = u.employee_id where x.emp_code = any($1)`, [[boss, rep]])).rows[0].n).toBe(0);
    const viewer = await userAgent([{ code: 'SALES_OPS' }]);
    const plain = (await viewer.get(`/api/v1/employees/${e.id}`).expect(200)).body;
    expect(plain).toMatchObject({ team: 'OFFICE', canViewPersonal: false });
    expect(plain.bloodGroup).toBeUndefined();
    const sec = await userAgent([{ code: 'SECURITY_ADMIN' }]);
    expect((await sec.get(`/api/v1/employees/${e.id}`).expect(200)).body).toMatchObject({ bloodGroup: 'A+', education: 'BCom', canViewPersonal: true });
    // someone who cannot see personal details does not wipe them when editing
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const cur = (await mdo.get(`/api/v1/employees/${e.id}`).expect(200)).body;
    await mdo.put(`/api/v1/employees/${e.id}`, { empCode: rep, fullName: cur.fullName, designation: 'Senior Accounts Executive', managerId: cur.managerId, team: 'OFFICE', version: cur.version }).expect(200);
    expect((await db.query(`select blood_group, education, designation from org.employees where id = $1`, [e.id])).rows[0]).toEqual({ blood_group: 'A+', education: 'BCom', designation: 'Senior Accounts Executive' });
  });
});

describe('Trading with dealers and vendors whose KYC is pending', () => {
  afterAll(async () => { await db.query(`update sys.settings set value = 'false' where key = 'parties.allowPendingKyc'`); });
  it('lets a Draft dealer or vendor be used while the switch is on, with a warning, and never a rejected one', async () => {
    const { dealerEligibility } = await import('../src/modules/dealers/routes');
    const { vendorEligibility } = await import('../src/modules/vendors/routes');
    const { loadDealers } = await import('../src/db/load-dealers');
    const { loadVendors } = await import('../src/db/load-vendors');
    const dn = uniq('[TEST] Pending Dealer '); const vn = uniq('[TEST] Pending Vendor ');
    await loadDealers(db, `sr_no,company,address,pincode,state,mobile_no,e_mail,gstin_uin,pan_no\n1,${dn},Market Yard,422003,Maharashtra,,,,\n`, { userId: null, label: 'test' });
    await loadVendors(db, `group,name,address,state,pin_code,mobile_number,mail_id,gstin\nPacking Material Creditors,${vn},MIDC,Maharashtra,422010,,,\n`, { userId: null, label: 'test' });
    const dealer = (await db.query(`select id from mdm.parties where legal_name = $1`, [dn])).rows[0].id;
    const vendor = (await db.query(`select id from mdm.parties where legal_name = $1`, [vn])).rows[0].id;
    const today = new Date().toISOString().slice(0, 10);
    // switched off (the go-live setting): pending parties are refused
    expect((await dealerEligibility(db, dealer, [], today)).reasons).toEqual(['Dealer is Draft']);
    expect((await vendorEligibility(db, vendor, [], today)).reasons).toEqual(['Vendor is Draft', 'Bank account not verified']);
    const ops = await userAgent([{ code: 'SALES_OPS' }]);
    expect((await ops.get('/api/v1/dealers?usable=1&limit=100').expect(200)).body.data.map((x: { id: string }) => x.id)).not.toContain(dealer);
    // switched on: usable, with a warning; ordering does not need the bank account yet
    await db.query(`update sys.settings set value = 'true' where key = 'parties.allowPendingKyc'`);
    expect(await dealerEligibility(db, dealer, [], today)).toEqual({ eligible: true, reasons: [], warnings: ['Dealer KYC pending (Draft)'] });
    expect(await vendorEligibility(db, vendor, [], today)).toEqual({ eligible: true, reasons: [], warnings: ['Vendor KYC pending (Draft)', 'Bank account not verified'] });
    expect((await ops.get(`/api/v1/dealers?usable=1&q=${encodeURIComponent(dn)}`).expect(200)).body.data.map((x: { id: string }) => x.id)).toEqual([dealer]);
    // a rejected party stays out
    await db.query(`select set_config('app.transition', 'on', false)`);
    const c = await db.connect();
    try { await c.query(`select set_config('app.transition', 'on', false)`); await c.query(`update mdm.dealer_profiles set status = 'Rejected' where party_id = $1`, [dealer]); } finally { c.release(); }
    expect((await dealerEligibility(db, dealer, [], today)).reasons).toEqual(['Dealer is Rejected']);
    const admin = await userAgent([{ code: 'EXEC_ADMIN' }]);
    expect((await admin.get('/api/v1/golive').expect(200)).body.checks.find((x: { key: string }) => x.key === 'pendingKyc')).toMatchObject({ status: 'todo' });
  });
});
