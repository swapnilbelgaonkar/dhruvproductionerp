import { describe, expect, it } from 'vitest';
import { lapseUnacknowledged } from '../src/modules/purchase/orders';
import { todayIST } from '../src/modules/sales/quotations';
import { db } from './helpers';
import { activeVendor, approve, approvedRequisition, inDays, setup, type F } from './purchase-fixtures';

const steps = async (f: F, id: string) => ((await f.pe.get(`/api/v1/purchase-orders/${id}`).expect(200)).body.approval.steps as { label: string }[]).map((s) => s.label);
const po = (f: F, partyId: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
  partyId, legalEntityId: f.le, warehouseId: f.wh, deliveryDate: inDays(10), paymentTermsDays: 30, deliveryTerms: 'Delivered to the RM store', lines, ...over,
});
const prStatus = async (id: string) => (await db.query(`select r.status, l.ordered_qty from purchase.requisitions r join purchase.requisition_lines l on l.requisition_id = r.id where r.id = $1`, [id])).rows[0];

describe('Purchase orders (PUR-006, PUR-013, D06)', () => {
  it('orders an approved requisition, routes ₹1–10 lakh to purchase and finance heads, issues, acknowledges and cancels', async () => {
    const f = await setup();
    const pr = await approvedRequisition(f);
    const vendor = await activeVendor(f, [f.rm]);
    const open = (await f.pe.get(`/api/v1/purchase-orders/open-requisition-lines?legalEntityId=${f.le}`).expect(200)).body.data;
    expect(open.find((x: { id: string }) => x.id === pr.lineId)).toMatchObject({ remaining: '2500.0000' });

    const over = await f.pe.post('/api/v1/purchase-orders', po(f, vendor, [{ itemId: f.rm, qty: 3000, rate: 62.4375, discountPct: 2, requisitionLineId: pr.lineId }])).expect(422);
    expect(over.body.error.code).toBe('PR_QTY_EXCEEDED');
    expect((await f.pe.post('/api/v1/purchase-orders', po(f, vendor, [{ itemId: f.pm, qty: 100, rate: 2 }])).expect(422)).body.error.code).toBe('VENDOR_NOT_ELIGIBLE');
    const o = await f.pe.post('/api/v1/purchase-orders', po(f, vendor, [{ itemId: f.rm, qty: 2500, rate: 62.4375, discountPct: 2, requisitionLineId: pr.lineId }])).expect(201);
    expect(o.body.docNo).toMatch(/^PO\/\d{4}-\d{2}\/\d{6}$/);
    let d = (await f.pe.get(`/api/v1/purchase-orders/${o.body.id}`).expect(200)).body;
    // 2,500 kg × 61.1888 = 1,52,972.00 + 9% CGST + 9% SGST, rounded to the rupee
    expect(d).toMatchObject({ interState: false, taxableTotal: '152972.00', cgstTotal: '13767.48', sgstTotal: '13767.48', grandTotal: '180507.00', roundOff: '0.04' });
    expect(d.lines[0]).toMatchObject({ netRate: '61.1888', requisitionNo: pr.docNo });
    expect(await prStatus(pr.id)).toMatchObject({ status: 'Closed', ordered_qty: '2500.0000' });

    const sub = await f.pe.post(`/api/v1/purchase-orders/${o.body.id}/submit`).expect(200);
    expect(await steps(f, o.body.id)).toEqual(['Purchase head approval', 'Finance head approval']);
    await approve(f.pe, sub.body.approvalRequestId).expect(403);
    await approve(f.ph, sub.body.approvalRequestId).expect(200);
    await approve(f.fh, sub.body.approvalRequestId).expect(200);
    await f.pe.post(`/api/v1/purchase-orders/${o.body.id}/acknowledge`, { vendorAckRef: 'x' }).expect(422);
    const issued = await f.pe.post(`/api/v1/purchase-orders/${o.body.id}/issue`).expect(200);
    expect(issued.body.ackDue).toBe(inDays(7));
    await f.pe.post(`/api/v1/purchase-orders/${o.body.id}/acknowledge`, { vendorAckRef: 'Mail of 21 Nov, ref SO-4471' }).expect(200);
    d = (await f.storesHead.get(`/api/v1/purchase-orders/${o.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'Acknowledged', vendorAckRef: 'Mail of 21 Nov, ref SO-4471' });
    expect(d.allowedActions).toEqual([]);

    await f.pe.post(`/api/v1/purchase-orders/${o.body.id}/cancel`, { reason: '[TEST] plan dropped' }).expect(200);
    expect(await prStatus(pr.id)).toMatchObject({ status: 'Approved', ordered_qty: '0.0000' });
  });

  it('applies the other value bands, IGST for an out-of-state vendor, lapsing and emergencies', async () => {
    const f = await setup();
    const ka = await activeVendor(f, [f.rm, f.pm], { state: '29' });
    // up to ₹1 lakh: purchase head only; Karnataka vendor → IGST
    const small = await f.pe.post('/api/v1/purchase-orders', po(f, ka, [{ itemId: f.pm, qty: 10000, rate: 1.85 }])).expect(201);
    let d = (await f.pe.get(`/api/v1/purchase-orders/${small.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ interState: true, igstTotal: '3330.00', cgstTotal: '0.00' });
    const s1 = await f.pe.post(`/api/v1/purchase-orders/${small.body.id}/submit`).expect(200);
    expect(await steps(f, small.body.id)).toEqual(['Purchase head approval']);
    await approve(f.ph, s1.body.approvalRequestId).expect(200);
    await f.pe.post(`/api/v1/purchase-orders/${small.body.id}/issue`).expect(200);
    // not acknowledged in time → lapsed → must be re-issued
    await db.query(`update purchase.purchase_orders set ack_due = $2 where id = $1`, [small.body.id, inDays(-1)]);
    expect(await lapseUnacknowledged(db)).toBeGreaterThanOrEqual(1);
    await f.pe.post(`/api/v1/purchase-orders/${small.body.id}/acknowledge`, { vendorAckRef: 'late' }).expect(422);
    await f.pe.post(`/api/v1/purchase-orders/${small.body.id}/reissue`).expect(200);
    d = (await f.pe.get(`/api/v1/purchase-orders/${small.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'Issued', ackDue: inDays(7) });

    // above ₹10 lakh: + executive director
    const big = await f.pe.post('/api/v1/purchase-orders', po(f, ka, [{ itemId: f.rm, qty: 20000, rate: 62.5 }])).expect(201);
    const s2 = await f.pe.post(`/api/v1/purchase-orders/${big.body.id}/submit`).expect(200);
    expect(await steps(f, big.body.id)).toEqual(['Purchase head approval', 'Finance head approval', 'Executive director approval (above ₹10 lakh)']);
    for (const a of [f.ph, f.fh, f.exec]) await approve(a, s2.body.approvalRequestId).expect(200);
    expect((await f.pe.get(`/api/v1/purchase-orders/${big.body.id}`).expect(200)).body.status).toBe('Approved');

    // emergency: purchase head now, the finance head is told to review it afterwards
    const em = await f.pe.post('/api/v1/purchase-orders', po(f, ka, [{ itemId: f.rm, qty: 20000, rate: 62.5 }], { emergency: true })).expect(201);
    const s3 = await f.pe.post(`/api/v1/purchase-orders/${em.body.id}/submit`).expect(200);
    expect(await steps(f, em.body.id)).toEqual(['Emergency approval (purchase head)']);
    await approve(f.ph, s3.body.approvalRequestId).expect(200);
    const notes = (await f.fh.get('/api/v1/notifications').expect(200)).body.data.map((n: { link: string }) => n.link);
    expect(notes).toContain(`/purchase/orders/${em.body.id}`);
    expect(todayIST()).toBeTruthy();
  });
});

describe('RFQ and comparative statement (PUR-004/005/014)', () => {
  it('ranks bids on landed cost, lead time and rating, and needs a reason to override the top-ranked bid', async () => {
    const f = await setup();
    const pr = await approvedRequisition(f);
    const a = await activeVendor(f, [f.rm]);                 // new vendor, no rating yet
    const b = await activeVendor(f, [f.rm], { rating: 4.5 });
    const c = await activeVendor(f, [f.pm]);                 // not approved for the item
    const body = { legalEntityId: f.le, warehouseId: f.wh, responseDue: inDays(5), lines: [{ itemId: f.rm, qty: 2500, specification: 'Zn ≥ 33%, moisture ≤ 1%', requisitionLineId: pr.lineId }] };
    expect((await f.pe.post('/api/v1/rfqs', { ...body, vendorIds: [a, b, c] }).expect(422)).body.error.code).toBe('VENDOR_NOT_APPROVED');
    const rfq = await f.pe.post('/api/v1/rfqs', { ...body, vendorIds: [a, b] }).expect(201);
    expect(rfq.body.docNo).toMatch(/^RFQ\/\d{4}-\d{2}\/\d{6}$/);
    await f.pe.post(`/api/v1/rfqs/${rfq.body.id}/issue`).expect(200);
    const line = (await f.pe.get(`/api/v1/rfqs/${rfq.body.id}`).expect(200)).body.lines[0].id;
    const quote = (party: string, rate: number, lead: number, freight: number) => ({ partyId: party, quoteRef: `Q-${rate}`, quoteDate: todayIST(), validUntil: inDays(15),
      paymentTermsDays: 30, deliveryDays: lead, freight, lines: [{ rfqLineId: line, rate, discountPct: 0, compliant: true }] });
    await f.pe.post(`/api/v1/rfqs/${rfq.body.id}/quotes`, quote(c, 50, 3, 0)).expect(422);
    await f.pe.post(`/api/v1/rfqs/${rfq.body.id}/quotes`, quote(a, 60, 15, 0)).expect(201);
    await f.pe.post(`/api/v1/rfqs/${rfq.body.id}/quotes`, quote(b, 62, 5, 1000)).expect(201);

    // A: landed 60.00, score 60 + 7.5 (lead) + 12 (unrated = 3/5) = 79.5; B: landed 62.40, score 57.69 + 20 + 18 = 95.69 → B is ranked first
    const cmp = (await f.pe.get(`/api/v1/rfqs/${rfq.body.id}/comparison`).expect(200)).body.lines[0];
    const [first, second] = cmp.bids;
    expect(first).toMatchObject({ partyId: b, landedRate: 62.4, rank: 1, score: 95.69 });
    expect(second).toMatchObject({ partyId: a, landedRate: 60, rank: 2, score: 79.5 });
    expect(cmp.recommended).toBe(first.vendorQuoteId);

    const award = (reason?: string) => f.pe.post(`/api/v1/rfqs/${rfq.body.id}/award`, { lines: [{ rfqLineId: line, vendorQuoteId: second.vendorQuoteId, overrideReason: reason }] });
    expect((await award().expect(422)).body.error.code).toBe('OVERRIDE_REASON_REQUIRED');
    const done = await award('Cheapest landed cost; B lead time not needed for this plan').expect(200);
    expect(done.body.purchaseOrders).toHaveLength(1);
    const d = (await f.pe.get(`/api/v1/purchase-orders/${done.body.purchaseOrders[0].id}`).expect(200)).body;
    expect(d).toMatchObject({ partyId: a, status: 'Draft', rfqNo: rfq.body.docNo, taxableTotal: '150000.00' });
    expect(d.lines[0]).toMatchObject({ rate: '60.0000', requisitionNo: pr.docNo });
    expect((await f.pe.get(`/api/v1/rfqs/${rfq.body.id}`).expect(200)).body).toMatchObject({ status: 'Awarded' });
    await award('again').expect(422);
  });
});
