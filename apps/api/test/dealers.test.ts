import { gstinCheckDigit } from '@dhruv/contracts';
import { describe, expect, it } from 'vitest';
import { dealerEligibility } from '../src/modules/dealers/routes';
import { scanLicenceExpiry } from '../src/modules/notifications/relay';
import { db, uniq, userAgent, type Agent } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const randomPan = () => Array.from({ length: 5 }, () => L[Math.floor(Math.random() * 26)]).join('') + String(Math.floor(1000 + Math.random() * 8999)) + L[Math.floor(Math.random() * 26)];
const gstinFor = (pan: string, state = '27') => { const b = `${state}${pan}1Z`; return b + gstinCheckDigit(b); };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type Fixture = Awaited<ReturnType<typeof setup>>;

/** A small hierarchy: RSM ← TSM ← SE, each with a user; plus a verifier and a credit controller. */
async function setup() {
  const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
  const terr = async (parentId: string | null, level: number) =>
    (await mdo.post('/api/v1/territories', { parentId, code: uniq('T'), name: `[TEST] T${level}`, level }).expect(201)).body.id as string;
  const state = await terr(null, 4);
  const taluka = await terr(state, 7);
  const otherTaluka = await terr(state, 7);
  const emp = async (tier: string, managerId: string | null, territoryId: string) =>
    (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: `[TEST] ${tier}`, salesTier: tier, managerId, territoryId }).expect(201)).body.id as string;
  const rsmE = await emp('RSM', null, state);
  const tsmE = await emp('TSM', rsmE, taluka);
  const seE = await emp('SE', tsmE, taluka);
  const se2E = await emp('SE', tsmE, otherTaluka);
  const territoryOnly = { legalEntityIds: [], plantIds: [], warehouseIds: [], territoryIds: [] };
  const rsm = await userAgent([{ code: 'SALES_RSM', scope: territoryOnly }], { employeeId: rsmE });
  const tsm = await userAgent([{ code: 'SALES_TSM', scope: territoryOnly }], { employeeId: tsmE });
  const se = await userAgent([{ code: 'SALES_SE', scope: territoryOnly }], { employeeId: seE });
  const se2 = await userAgent([{ code: 'SALES_SE', scope: territoryOnly }], { employeeId: se2E });
  const verifier = await userAgent([{ code: 'DOC_VERIFIER' }]);
  const credit = await userAgent([{ code: 'CREDIT_CONTROLLER' }]);
  return { mdo, taluka, seE, rsm, tsm, se, se2, verifier, credit };
}

async function upload(a: Agent, partyId: string, type: string, extra = '') {
  const r = await a.upload(`/api/v1/documents?documentType=${type}&entityType=mdm.party&entityId=${partyId}&title=${type}&fileName=${type}.pdf${extra}`, PDF, 'application/pdf').expect(201);
  return r.body.id as string;
}

async function createDealer(f: Fixture, over: Record<string, unknown> = {}) {
  const pan = randomPan();
  const body = {
    legalName: `[TEST] ${uniq('Agro Traders ')}`, constitution: 'PROPRIETORSHIP', pan, gstRegistered: true, gstin: gstinFor(pan),
    contactPerson: '[TEST] Proprietor', mobile: `9${String(Math.floor(100000000 + Math.random() * 899999999))}`, dealerCategory: 'DEALER',
    territoryId: f.taluka, salesOwnerId: f.seE, licenceTypes: ['FERTILIZER', 'PESTICIDE'], creditDays: 45, creditLimit: 200000, ...over,
  };
  const r = await f.se.post('/api/v1/dealers', body).expect(201);
  return { id: r.body.id as string, code: r.body.code as string, body };
}

async function completeKyc(f: Fixture, id: string) {
  for (const kind of ['REGISTERED', 'BILLING', 'SHIPPING']) {
    await f.se.post(`/api/v1/dealers/${id}/addresses`, { kind, line1: '[TEST] Market Yard', city: 'Nashik', district: 'Nashik', stateCode: '27', pincode: '422001' }).expect(201);
  }
  for (const t of ['PAN_CARD', 'GST_CERTIFICATE', 'LETTERHEAD', 'CANCELLED_CHEQUE', 'SECURITY_CHEQUE', 'SECURITY_CHEQUE', 'SECURITY_CHEQUE']) await upload(f.se, id, t);
  const idDoc = await upload(f.se, id, 'SIGNATORY_ID');
  await f.se.post(`/api/v1/dealers/${id}/signatories`, { fullName: '[TEST] Proprietor', designation: 'Proprietor', idType: 'AADHAAR', idLast4: '1234', documentId: idDoc }).expect(201);
  for (const [type, doc] of [['FERTILIZER', 'FERTILIZER_LICENCE'], ['PESTICIDE', 'PESTICIDE_LICENCE']] as const) {
    const docId = await upload(f.se, id, doc, `&validUntil=${inDays(400)}`);
    await f.se.post(`/api/v1/dealers/${id}/licences`, { licenceType: type, number: `${type.slice(0, 2)}-MH-${uniq('')}`, issuer: '[TEST] Agriculture Commissioner',
      validFrom: inDays(-30), validTo: inDays(400), documentId: docId }).expect(201);
  }
}

describe('Dealer onboarding (BRD §3.1, MP §6, DLR-001…015)', () => {
  it('runs the full chain: checklist → verification → commercial → finance → final → Active', async () => {
    const f = await setup();
    const d = await createDealer(f);
    expect(d.code).toMatch(/^DLR-\d{4}-\d{4}$/);

    const blocked = await f.se.post(`/api/v1/dealers/${d.id}/submit`).expect(422);
    expect(blocked.body.error.code).toBe('NOT_READY');
    await completeKyc(f, d.id);
    const ready = await f.se.get(`/api/v1/dealers/${d.id}`).expect(200);
    expect(ready.body.readiness.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);

    const sub = await f.se.post(`/api/v1/dealers/${d.id}/submit`).expect(200);
    const appr = sub.body.approvalRequestId;

    // verifier cannot pass the step until both licences are verified
    const early = await f.verifier.post(`/api/v1/approvals/${appr}/decisions`, { decision: 'Approve' }).expect(422);
    expect(early.body.error.code).toBe('LICENCES_NOT_VERIFIED');
    const detail = await f.verifier.get(`/api/v1/dealers/${d.id}`).expect(200);
    expect(detail.body.canVerify).toBe(true);
    for (const l of detail.body.licences) await f.verifier.post(`/api/v1/dealers/${d.id}/licences/${l.id}/verify`, { verification: 'Verified' }).expect(200);
    await f.verifier.post(`/api/v1/approvals/${appr}/decisions`, { decision: 'Approve' }).expect(200);

    // commercial review goes to the initiator's reporting manager (TSM), not to the RSM
    await f.rsm.post(`/api/v1/approvals/${appr}/decisions`, { decision: 'Approve' }).expect(403);
    await f.tsm.post(`/api/v1/approvals/${appr}/decisions`, { decision: 'Approve' }).expect(200);
    await f.credit.post(`/api/v1/approvals/${appr}/decisions`, { decision: 'Approve' }).expect(200);
    await f.rsm.post(`/api/v1/approvals/${appr}/decisions`, { decision: 'Approve' }).expect(200);

    const active = await f.se.get(`/api/v1/dealers/${d.id}`).expect(200);
    expect(active.body.status).toBe('Active');
    expect(active.body.allowedActions).not.toContain('edit');
    const elig = await dealerEligibility(db, d.id, ['FERTILIZER', 'PESTICIDE'], inDays(0));
    expect(elig).toEqual({ eligible: true, reasons: [] });
    const noBio = await dealerEligibility(db, d.id, ['BIOSTIMULANT'], inDays(0));
    expect(noBio.reasons).toContain('No biostimulant licence');
    const later = await dealerEligibility(db, d.id, ['FERTILIZER'], inDays(500));
    expect(later.reasons).toContain('fertilizer licence expired');

    // suspension blocks eligibility immediately (DLR-007)
    await f.credit.post(`/api/v1/dealers/${d.id}/suspend`, { reason: 'Overdue beyond credit days' }).expect(200);
    expect((await dealerEligibility(db, d.id, ['FERTILIZER'], inDays(0))).reasons).toContain('Dealer is Suspended');
  });

  it('blocks duplicates and inconsistent tax identity (TC-02)', async () => {
    const f = await setup();
    const d = await createDealer(f);
    const dup = await f.se.post('/api/v1/dealers', { ...d.body, legalName: '[TEST] Copy', mobile: '9876500000' }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PARTY');
    const wrongPan = await f.se.post('/api/v1/dealers', { ...d.body, pan: randomPan(), mobile: '9876500001' }).expect(400);
    expect(wrongPan.body.error.details.some((x: { field: string }) => x.field === 'gstin')).toBe(true);
  });

  it('flags a GSTIN state that differs from the registered address', async () => {
    const f = await setup();
    const pan = randomPan();
    const d = await createDealer(f, { pan, gstin: gstinFor(pan, '36') });
    await f.se.post(`/api/v1/dealers/${d.id}/addresses`, { kind: 'REGISTERED', line1: 'x', city: 'Pune', district: 'Pune', stateCode: '27', pincode: '411001' }).expect(201);
    const r = await f.se.get(`/api/v1/dealers/${d.id}`).expect(200);
    expect(r.body.readiness.checks.find((c: { key: string }) => c.key === 'gst.state').ok).toBe(false);
  });

  it('limits sales users to their territory and protects sensitive KYC documents', async () => {
    const f = await setup();
    const d = await createDealer(f);
    await f.se2.get(`/api/v1/dealers/${d.id}`).expect(404);
    const list = await f.se2.get('/api/v1/dealers?limit=100').expect(200);
    expect(list.body.data.some((x: { id: string }) => x.id === d.id)).toBe(false);
    await f.tsm.get(`/api/v1/dealers/${d.id}`).expect(200); // manager of the area sees it

    await upload(f.se, d.id, 'SECURITY_CHEQUE');
    const docs = await f.se.get(`/api/v1/documents?entityType=mdm.party&entityId=${d.id}`).expect(200);
    const cheque = docs.body.data.find((x: { documentType: string }) => x.documentType === 'SECURITY_CHEQUE');
    await f.se.post(`/api/v1/documents/versions/${cheque.versions[0].id}/link`).expect(403);
    await f.verifier.post(`/api/v1/documents/versions/${cheque.versions[0].id}/link`).expect(200);
  });

  it('switching dealer.kyc.policy to BRD_STRICT demands 5 signatories and 3 cheques from everyone (D07)', async () => {
    const f = await setup();
    const d = await createDealer(f, { creditLimit: 0, creditDays: 0 });
    let r = await f.se.get(`/api/v1/dealers/${d.id}`).expect(200);
    expect(r.body.readiness.checks.some((c: { key: string }) => c.key === 'kyc.SECURITY_CHEQUE')).toBe(false);
    await db.query(`update sys.settings set value = '"BRD_STRICT"' where key = 'dealer.kyc.policy'`);
    try {
      r = await f.se.get(`/api/v1/dealers/${d.id}`).expect(200);
      const keys = r.body.readiness.checks.map((c: { key: string; detail?: string }) => `${c.key}:${c.detail ?? ''}`);
      expect(keys).toContain('kyc.SECURITY_CHEQUE:0 of 3 uploaded');
      expect(keys).toContain('kyc.SIGNATORY:0 of 5 uploaded');
    } finally {
      await db.query(`update sys.settings set value = '"CONDITIONAL"' where key = 'dealer.kyc.policy'`);
    }
  });

  it('a licence approaching expiry alerts the sales owner and verifiers once (DLR-008)', async () => {
    const f = await setup();
    const d = await createDealer(f);
    await completeKyc(f, d.id);
    await db.query(`update mdm.party_licences set valid_to = current_date + 20 where party_id = $1 and licence_type = 'FERTILIZER' and status = 'Active'`, [d.id]);
    await f.se.post(`/api/v1/dealers/${d.id}/submit`).expect(200);
    const first = await scanLicenceExpiry(db);
    expect(first).toBeGreaterThan(0);
    expect(await scanLicenceExpiry(db)).toBe(0);
    const notes = await f.se.get('/api/v1/notifications').expect(200);
    expect(notes.body.data.some((n: { title: string }) => n.title.startsWith('Licence expires in 20 days'))).toBe(true);
  });
});
