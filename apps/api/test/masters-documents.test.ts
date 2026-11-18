import { describe, expect, it } from 'vitest';
import { relayOutbox } from '../src/modules/notifications/relay';
import { db, uniq, userAgent } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function activeCategory(mdo: Awaited<ReturnType<typeof userAgent>>, licence = 'FERTILIZER') {
  const c = await mdo.post('/api/v1/product-categories', { code: uniq('CAT'), name: '[TEST] Micronutrient', licenceRequired: licence }).expect(201);
  return c.body.id as string;
}
async function hsn(mdo: Awaited<ReturnType<typeof userAgent>>) {
  const code = String(Math.floor(10000000 + Math.random() * 89999999));
  const h = await mdo.post('/api/v1/hsn-codes', { code, description: '[TEST] chelated micronutrient' }).expect(201);
  return h.body.id as string;
}

describe('Product masters (MDM-008…010)', () => {
  it('a finished-goods item needs HSN, category, shelf life and a pack before approval; then becomes Active', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const mda = await userAgent([{ code: 'MASTER_DATA_APPROVER' }]);
    const code = uniq('PRD');
    const item = await mdo.post('/api/v1/items', { code, name: '[TEST] Chelated Zinc 12%', itemType: 'FG', baseUom: 'KG' }).expect(201);
    const missing = await mdo.post(`/api/v1/items/${item.body.id}/submit`).expect(422);
    expect(missing.body.error.code).toBe('FIELD_REQUIRED');
    expect(missing.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['hsnId', 'categoryId', 'shelfLifeDays']));

    const categoryId = await activeCategory(mdo);
    const hsnId = await hsn(mdo);
    const v = (await mdo.get(`/api/v1/items/${item.body.id}`).expect(200)).body.version;
    await mdo.put(`/api/v1/items/${item.body.id}`, { code, name: '[TEST] Chelated Zinc 12%', itemType: 'FG', baseUom: 'KG', categoryId, hsnId, shelfLifeDays: 730, version: v }).expect(200);
    const noPack = await mdo.post(`/api/v1/items/${item.body.id}/submit`).expect(422);
    expect(noPack.body.error.code).toBe('PACK_REQUIRED');
    await mdo.post(`/api/v1/items/${item.body.id}/packs`, { packCode: '1KG', packSize: 1, packUom: 'KG', container: 'Pouch', unitsPerBox: 20 }).expect(201);
    const sub = await mdo.post(`/api/v1/items/${item.body.id}/submit`).expect(200);
    await mda.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
    const active = await mdo.get(`/api/v1/items/${item.body.id}`).expect(200);
    expect(active.body.status).toBe('Active');
    expect(active.body.packs).toHaveLength(1);
    // packs are frozen once the item is active
    await mdo.post(`/api/v1/items/${item.body.id}/packs`, { packCode: '25KG', packSize: 25, packUom: 'KG', container: 'Bag' }).expect(422);
  });

  it('GST rates are effective-dated: a new rate closes the previous one and lookups honour the date', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const fh = await userAgent([{ code: 'FINANCE_HEAD' }]);
    const hsnId = await hsn(mdo);
    await mdo.post(`/api/v1/hsn-codes/${hsnId}/rates`, { gstRate: 5, validFrom: '2025-01-01', notes: 'x' }).expect(403);
    await fh.post(`/api/v1/hsn-codes/${hsnId}/rates`, { gstRate: 12, validFrom: '2024-04-01', notes: '[TEST] earlier rate' }).expect(201);
    await fh.post(`/api/v1/hsn-codes/${hsnId}/rates`, { gstRate: 5, validFrom: '2025-09-22', notes: '[TEST] revised rate' }).expect(201);
    const bad = await fh.post(`/api/v1/hsn-codes/${hsnId}/rates`, { gstRate: 18, validFrom: '2025-01-01', notes: 'backdated' }).expect(422);
    expect(bad.body.error.code).toBe('RATE_DATE_INVALID');
    expect((await fh.get(`/api/v1/tax-rates/effective?hsnId=${hsnId}&date=2025-06-30`).expect(200)).body.gstRate).toBe('12.00');
    expect((await fh.get(`/api/v1/tax-rates/effective?hsnId=${hsnId}&date=2025-09-22`).expect(200)).body.gstRate).toBe('5.00');
    const detail = await fh.get(`/api/v1/hsn-codes/${hsnId}`).expect(200);
    expect(detail.body.rates[1].validTo).toBeTruthy();
  });

  it('mass↔volume conversion needs an item (density differs by product)', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const res = await mdo.post('/api/v1/uom/conversions', { fromUom: 'L', toUom: 'KG', factor: 1.2 }).expect(422);
    expect(res.body.error.code).toBe('ITEM_REQUIRED');
  });
});

describe('Document vault (DMS-001/002)', () => {
  it('stores a PDF against a record, versions it, and serves it only through a signed short-lived link', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const viewer = await userAgent([{ code: 'AUDITOR' }]);
    const le = await mdo.post('/api/v1/legal-entities', { code: uniq('LE'), name: '[TEST] docs', pan: 'AAAAA0000A' }).expect(201);
    const q = (extra = '') => `entityType=org.legal_entity&entityId=${le.body.id}&title=Factory%20licence&fileName=licence.pdf${extra}`;

    const noExpiry = await mdo.upload(`/api/v1/documents?documentType=FACTORY_LICENCE&${q()}`, PDF, 'application/pdf').expect(400);
    expect(noExpiry.body.error.code).toBe('VALIDATION_FAILED');
    const exe = await mdo.upload(`/api/v1/documents?documentType=OTHER&${q()}`, Buffer.from('MZ fake exe'), 'application/pdf').expect(422);
    expect(exe.body.error.code).toBe('FILE_TYPE_NOT_ALLOWED');
    const doc = await mdo.upload(`/api/v1/documents?documentType=FACTORY_LICENCE&${q('&validUntil=2027-03-31')}`, PDF, 'application/pdf').expect(201);
    await mdo.upload(`/api/v1/documents/${doc.body.id}/versions?validUntil=2028-03-31&note=renewed`, PDF, 'application/pdf').expect(201);

    await viewer.upload(`/api/v1/documents?documentType=OTHER&${q()}`, PDF, 'application/pdf').expect(403);
    const list = await viewer.get(`/api/v1/documents?entityType=org.legal_entity&entityId=${le.body.id}`).expect(200);
    expect(list.body.data[0].currentVersion).toBe(2);
    expect(list.body.data[0].versions).toHaveLength(2);
    expect(list.body.canUpload).toBe(false);

    const link = await viewer.post(`/api/v1/documents/versions/${list.body.data[0].versions[0].id}/link`).expect(200);
    const file = await viewer.raw.get(link.body.url).buffer(true).expect(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(file.body).subarray(0, 5).toString()).toBe('%PDF-');
    // tampered or foreign links fail
    await viewer.raw.get(link.body.url.replace(/sig=[^&]+/, 'sig=bad')).expect(403);
    await mdo.raw.get(link.body.url).expect(403);
    await expect(db.query(`delete from sys.document_versions`)).rejects.toThrow(/APPEND_ONLY/);
  });
});

describe('Notifications & idempotency (NTF-001/004, PLT-004)', () => {
  it('turns approval events into in-app notifications exactly once', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const mda = await userAgent([{ code: 'MASTER_DATA_APPROVER' }]);
    const le = await mdo.post('/api/v1/legal-entities', { code: uniq('LE'), name: '[TEST] notify', pan: 'AAAAA0000A' }).expect(201);
    const sub = await mdo.post(`/api/v1/legal-entities/${le.body.id}/submit`).expect(200);
    await relayOutbox(db);
    await relayOutbox(db); // second run must not duplicate
    const inbox = await mda.get('/api/v1/notifications').expect(200);
    const mine = inbox.body.data.filter((n: { link: string }) => n.link === `/approvals/${sub.body.approvalRequestId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe('action');
    await mda.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
    await relayOutbox(db);
    const back = await mdo.get('/api/v1/notifications').expect(200);
    expect(back.body.data.some((n: { title: string }) => n.title.startsWith('Approved'))).toBe(true);
    await mdo.post('/api/v1/notifications/read-all').expect(200);
    expect((await mdo.get('/api/v1/notifications').expect(200)).body.unread).toBe(0);
  });

  it('replays a retried request instead of running it twice', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const code = uniq('D');
    const key = `test-${code}`;
    const first = await mdo.post('/api/v1/departments', { code, name: '[TEST] idem' }).set('Idempotency-Key', key).expect(201);
    const again = await mdo.post('/api/v1/departments', { code, name: '[TEST] idem' }).set('Idempotency-Key', key).expect(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.id).toBe(first.body.id);
    const other = await mdo.post('/api/v1/departments', { code: uniq('D'), name: 'different' }).set('Idempotency-Key', key).expect(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(Number((await db.query(`select count(*) from org.departments where code = $1`, [code])).rows[0].count)).toBe(1);
  });
});
