import { describe, expect, it } from 'vitest';
import { scanLicenceExpiry } from '../src/modules/notifications/relay';
import { todayIST } from '../src/modules/sales/quotations';
import { vendorEligibility } from '../src/modules/vendors/routes';
import { db, uniq, userAgent } from './helpers';
import { approve, gstinFor, inDays, mobile, randomPan, setup, upload, type F } from './purchase-fixtures';

async function readyVendor(f: F) {
  const pan = randomPan();
  const v = await f.pe.post('/api/v1/vendors', {
    legalName: `[TEST] ${uniq('Chem Supplies ')}`, constitution: 'PROPRIETORSHIP', pan, gstRegistered: true, gstin: gstinFor(pan), contactPerson: '[TEST] Owner',
    mobile: mobile(), vendorCategory: 'RAW_MATERIAL', licenceTypes: ['CIB_REGISTRATION'], msmeRegistered: true, udyamNumber: 'UDYAM-MH-26-0012345', paymentTermsDays: 45,
  }).expect(201);
  const id = v.body.id as string;
  await f.pe.post(`/api/v1/vendors/${id}/addresses`, { kind: 'REGISTERED', line1: '[TEST] MIDC', city: 'Pune', district: 'Pune', stateCode: '27', pincode: '411019' }).expect(201);
  for (const t of ['PAN_CARD', 'GST_CERTIFICATE', 'LETTERHEAD']) await upload(f.pe, id, t);
  const sig = await upload(f.pe, id, 'SIGNATORY_ID');
  await f.pe.post(`/api/v1/vendors/${id}/signatories`, { fullName: '[TEST] Owner', designation: 'Proprietor', idType: 'PAN', idLast4: pan.slice(-4), documentId: sig }).expect(201);
  const cib = await upload(f.pe, id, 'CIB_REGISTRATION', `&validUntil=${inDays(400)}`);
  await f.pe.post(`/api/v1/vendors/${id}/licences`, { licenceType: 'CIB_REGISTRATION', number: uniq('CIR-'), issuer: '[TEST] CIB&RC Faridabad', validFrom: inDays(-30), validTo: inDays(400), documentId: cib }).expect(201);
  const cheque = await upload(f.pe, id, 'CANCELLED_CHEQUE');
  await f.pe.post(`/api/v1/vendors/${id}/bank-account`, { accountHolder: '[TEST] Chem Supplies', bankName: 'State Bank of India', ifsc: 'SBIN0001234', accountNumber: '123456789012', documentId: cheque }).expect(201);
  await f.pe.post(`/api/v1/vendors/${id}/items`, { itemId: f.rm, leadTimeDays: 10, minOrderQty: 500 }).expect(201);
  return { id, code: v.body.code as string };
}

describe('Vendor onboarding (BRD §3.2, MDM-011/016)', () => {
  it('runs checklist → document verification → purchase head → finance bank verification → Active', async () => {
    const f = await setup();
    const empty = await f.pe.post('/api/v1/vendors', { legalName: '[TEST] Incomplete', constitution: 'PROPRIETORSHIP', pan: randomPan(), gstRegistered: false,
      contactPerson: 'x', mobile: mobile(), vendorCategory: 'PACKAGING', paymentTermsDays: 30 }).expect(201);
    const blocked = await f.pe.post(`/api/v1/vendors/${empty.body.id}/submit`).expect(422);
    expect(blocked.body.error.details.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['addr.registered', 'bank', 'items', 'kyc.PAN_CARD']));
    await f.pe.post('/api/v1/vendors', { legalName: 'x', constitution: 'PROPRIETORSHIP', pan: randomPan(), gstRegistered: false, contactPerson: 'x', mobile: mobile(),
      vendorCategory: 'PACKAGING', paymentTermsDays: 30, msmeRegistered: true }).expect(400);

    const v = await readyVendor(f);
    expect(v.code).toMatch(/^VEN-\d{4}-\d{4}$/);
    let d = (await f.pe.get(`/api/v1/vendors/${v.id}`).expect(200)).body;
    expect(d.readiness.ready).toBe(true);
    // the account number is masked for purchase, visible to finance
    expect(d.bank).toMatchObject({ accountLast4: '9012', accountNumber: null, verification: 'Pending' });
    expect((await f.fh.get(`/api/v1/vendors/${v.id}`).expect(200)).body.bank.accountNumber).toBe('123456789012');
    // sales cannot see vendors or their documents
    await f.sales.get(`/api/v1/vendors/${v.id}`).expect(403);
    await f.sales.get(`/api/v1/documents?entityType=mdm.party&entityId=${v.id}`).expect(403);

    const sub = await f.pe.post(`/api/v1/vendors/${v.id}/submit`).expect(200);
    const appr = sub.body.approvalRequestId;
    expect((await approve(f.verifier, appr).expect(422)).body.error.code).toBe('LICENCES_NOT_VERIFIED');
    const lic = (await f.verifier.get(`/api/v1/vendors/${v.id}`).expect(200)).body.licences[0];
    await f.verifier.post(`/api/v1/vendors/${v.id}/licences/${lic.id}/verify`, { verification: 'Verified' }).expect(200);
    await approve(f.verifier, appr).expect(200);
    await approve(f.ph, appr).expect(200);
    expect((await approve(f.fh, appr).expect(422)).body.error.code).toBe('BANK_NOT_VERIFIED');
    // the person who entered the bank account cannot verify it; finance can
    await f.acc.post(`/api/v1/vendors/${v.id}/bank-account/verify`, { verification: 'Rejected' }).expect(400);
    await f.fh.post(`/api/v1/vendors/${v.id}/bank-account/verify`, { verification: 'Verified' }).expect(200);
    await approve(f.fh, appr).expect(200);
    d = (await f.pe.get(`/api/v1/vendors/${v.id}`).expect(200)).body;
    expect(d.status).toBe('Active');
    expect(await vendorEligibility(db, v.id, [f.rm], todayIST())).toEqual({ eligible: true, reasons: [], warnings: [] });
    expect((await vendorEligibility(db, v.id, [f.pm], todayIST())).reasons).toEqual(['Not approved for 1 of the items']);

    // a changed bank account must be verified again before the vendor can be paid or ordered from
    const cheque = await upload(f.pe, v.id, 'CANCELLED_CHEQUE');
    await f.pe.post(`/api/v1/vendors/${v.id}/bank-account`, { accountHolder: '[TEST] Chem Supplies', bankName: 'HDFC Bank', ifsc: 'HDFC0000123', accountNumber: '50100012345678', documentId: cheque }).expect(201);
    expect((await vendorEligibility(db, v.id, [], todayIST())).reasons).toEqual(['Bank account not verified']);

    // vendor licence alerts go to purchase heads
    await db.query(`update mdm.party_licences set valid_to = $2 where party_id = $1 and status = 'Active'`, [v.id, inDays(20)]);
    await scanLicenceExpiry(db);
    const notes = (await f.ph.get('/api/v1/notifications').expect(200)).body.data.map((n: { link: string }) => n.link);
    expect(notes).toContain(`/purchase/vendors/${v.id}`);
  });
});

describe('Purchase requisitions (PUR-001/002)', () => {
  it('routes to the department head, keeps requisitions private to the requester, and sends emergencies to the purchase head', async () => {
    const f = await setup();
    const base = { legalEntityId: f.le, warehouseId: f.wh, requiredBy: inDays(14), priority: 'NORMAL', purpose: '[TEST] Kharif production plan — zinc sulphate',
      lines: [{ itemId: f.rm, qty: 2000, estimatedRate: 62.5 }, { itemId: f.pm, qty: 5000, estimatedRate: 1.8, remarks: 'Printed, 1 kg' }] };
    await f.keeper.post('/api/v1/purchase-requisitions', { ...base, requiredBy: inDays(-1) }).expect(422);
    await f.keeper.post('/api/v1/purchase-requisitions', { ...base, lines: [base.lines[0], base.lines[0]] }).expect(400);
    const pr = await f.keeper.post('/api/v1/purchase-requisitions', base).expect(201);
    expect(pr.body.docNo).toMatch(/^PR\/\d{4}-\d{2}\/\d{6}$/);
    let d = (await f.keeper.get(`/api/v1/purchase-requisitions/${pr.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'Draft', estimatedTotal: '134000.00', lineCount: 2 });
    expect(d.lines[0]).toMatchObject({ uom: 'KG', approvedVendors: 0 });
    // purchase sees every requisition; another requester does not
    await f.pe.get(`/api/v1/purchase-requisitions/${pr.body.id}`).expect(200);
    const other = await userAgent([{ code: 'STOREKEEPER' }]);
    await other.get(`/api/v1/purchase-requisitions/${pr.body.id}`).expect(404);
    await f.pe.put(`/api/v1/purchase-requisitions/${pr.body.id}`, { ...base, version: d.version }).expect(403);

    const sub = await f.keeper.post(`/api/v1/purchase-requisitions/${pr.body.id}/submit`).expect(200);
    expect(sub.body.status).toBe('Submitted');
    await approve(f.pe, sub.body.approvalRequestId).expect(403);
    await approve(f.storesHead, sub.body.approvalRequestId).expect(200);
    d = (await f.keeper.get(`/api/v1/purchase-requisitions/${pr.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'Approved' });
    expect(d.approval.steps[0].label).toBe('Department head approval');
    expect(d.allowedActions).toEqual([]);
    await f.ph.post(`/api/v1/purchase-requisitions/${pr.body.id}/cancel`, { reason: '[TEST] plan changed' }).expect(200);

    const em = await f.keeper.post('/api/v1/purchase-requisitions', { ...base, priority: 'EMERGENCY', purpose: '[TEST] Line stopped — pouches' }).expect(201);
    const esub = await f.keeper.post(`/api/v1/purchase-requisitions/${em.body.id}/submit`).expect(200);
    await approve(f.storesHead, esub.body.approvalRequestId).expect(403);
    await approve(f.ph, esub.body.approvalRequestId).expect(200);
    const list = await f.pe.get('/api/v1/purchase-requisitions').expect(200);
    expect(list.body.data[0].priority).toBe('EMERGENCY');
  });
});
