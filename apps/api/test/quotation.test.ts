import { describe, expect, it } from 'vitest';
import { expireQuotations } from '../src/modules/sales/quotations';
import { db, uniq } from './helpers';
import { activePriceList, addLicence, approve, quote, setup } from './sales-fixtures';

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

    // a copy is the way to revise prices. It cannot start on or before the active list …
    const early = await f.ops.post(`/api/v1/price-lists/${id}/copy`, { code: uniq('PL-'), name: '[TEST] early', priceGroup: f.priceGroup, validFrom: '2026-01-01' }).expect(201);
    expect((await f.ops.post(`/api/v1/price-lists/${early.body.id}/submit`).expect(422)).body.error.code).toBe('PRICE_LIST_OVERLAP');
    // … and a later one supersedes it on approval: the old list closes the day before
    const copy = await f.ops.post(`/api/v1/price-lists/${id}/copy`, { code: uniq('PL-'), name: '[TEST] Rabi', priceGroup: f.priceGroup, validFrom: '2026-06-01' }).expect(201);
    const copied = (await f.ops.get(`/api/v1/price-lists/${copy.body.id}/items`).expect(200)).body.data;
    expect(copied).toHaveLength(1);
    await f.ops.post(`/api/v1/price-lists/${copy.body.id}/items`, { itemPackId: f.packA, rate: 260, slabs: [] }).expect(201);
    const sub = await f.ops.post(`/api/v1/price-lists/${copy.body.id}/submit`).expect(200);
    await approve(f.nsm, sub.body.approvalRequestId);
    await approve(f.fh, sub.body.approvalRequestId);
    expect((await f.ops.get(`/api/v1/price-lists/${id}`).expect(200)).body.validTo).toBe('2026-05-31');
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
