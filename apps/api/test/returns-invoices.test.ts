import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { type Agent } from './helpers';
import { activeVendor, approve, coa, issuedPo, lotStock, pass, qcUsers, receive, setup, type F } from './purchase-fixtures';

/** Sample, test and decide a received lot. */
async function qcDecide(qc: { analyst: Agent; manager: Agent }, inspectionId: string, decision: 'Release' | 'Reject') {
  await qc.analyst.post(`/api/v1/qc/inspections/${inspectionId}/sample`, { sampleQty: 0 }).expect(200);
  const results = decision === 'Release' ? pass : [{ ...pass[0]!, result: '30.2%', pass: false }];
  await qc.analyst.post(`/api/v1/qc/inspections/${inspectionId}/results`, { results, coaReceived: true, coaDocumentId: await coa(qc.analyst, inspectionId), recommendation: decision }).expect(200);
  await qc.manager.post(`/api/v1/qc/inspections/${inspectionId}/decide`, { decision, remarks: decision === 'Reject' ? 'Zinc below specification' : '' }).expect(200);
}
const invoice = (poId: string, poLineId: string, invoiceNo: string, qty: number, rate: number, extra: Record<string, unknown> = {}) => ({
  purchaseOrderId: poId, invoiceNo, invoiceDate: todayIST(), lines: [{ poLineId, qty, rate, gstRate: 18, ...extra }],
});

describe('Supplier returns and debit notes (PUR-010)', () => {
  it('returns a rejected lot against its receipt, raises a debit note and reopens the PO for a replacement', async () => {
    const f = await setup();
    const vendor = await activeVendor(f, [f.rm]);
    const po = await issuedPo(f, vendor, 1000);
    const qc = await qcUsers();
    const bad = await receive(f, po.id, po.lineId, 400);
    await qcDecide(qc, bad.inspectionId, 'Reject');
    const good = await receive(f, po.id, po.lineId, 600);
    await qcDecide(qc, good.inspectionId, 'Release');
    expect((await f.pe.get(`/api/v1/purchase-orders/${po.id}`).expect(200)).body.status).toBe('Received');

    const lots = (await f.keeper.get(`/api/v1/supplier-returns/returnable?goodsReceiptId=${bad.id}`).expect(200)).body.data;
    expect(lots[0]).toMatchObject({ lotId: bad.lotId, rejected: '400.0000' });
    const body = { goodsReceiptId: bad.id, reason: 'QC rejected: zinc 30.2% against ≥ 33%', vehicleNo: 'MH12AB1234', lines: [{ lotId: bad.lotId, bucket: 'REJECTED', qty: 400 }] };
    expect((await f.keeper.post('/api/v1/supplier-returns', { ...body, lines: [{ lotId: bad.lotId, bucket: 'REJECTED', qty: 401 }] }).expect(422)).body.error.code).toBe('RETURN_QTY_EXCEEDED');
    const sr = await f.keeper.post('/api/v1/supplier-returns', body).expect(201);
    expect(sr.body.docNo).toMatch(/^SRN\/\d{4}-\d{2}\/\d{6}$/);
    await f.keeper.post(`/api/v1/supplier-returns/${sr.body.id}/post`).expect(403);   // stores raise it; purchase posts it (it creates a debit note)
    const posted = await f.pe.post(`/api/v1/supplier-returns/${sr.body.id}/post`).expect(200);
    // 400 kg × ₹60 = ₹24,000 + 9% CGST + 9% SGST
    expect(posted.body).toMatchObject({ debitNote: expect.stringMatching(/^DN\//), amount: 28320 });
    const d = (await f.pe.get(`/api/v1/supplier-returns/${sr.body.id}`).expect(200)).body;
    expect(d.debitNote).toMatchObject({ taxableTotal: '24000.00', cgstTotal: '2160.00', sgstTotal: '2160.00', grandTotal: '28320.00', status: 'Open' });
    expect(await lotStock(bad.lotId)).toMatchObject({ REJECTED: 0 });
    const p = (await f.pe.get(`/api/v1/purchase-orders/${po.id}`).expect(200)).body;
    expect(p).toMatchObject({ status: 'PartiallyReceived' });
    expect(p.lines[0].receivedQty).toBe('600.0000');
    await f.pe.post(`/api/v1/supplier-returns/${sr.body.id}/post`).expect(422);
  });
});

describe('Supplier invoice three-way match (PUR-009, TC-10)', () => {
  it('matches within tolerance, refuses duplicates, and routes a variance to the purchase and finance heads', async () => {
    const f = await setup();
    const accounts = f.acc;
    const vendor = await activeVendor(f, [f.rm]);
    const po = await issuedPo(f, vendor, 1000);
    const qc = await qcUsers();
    const r1 = await receive(f, po.id, po.lineId, 600);

    // before QC release nothing is billable: the invoice is an exception
    const early = await accounts.post('/api/v1/supplier-invoices', invoice(po.id, po.lineId, 'MMPL/26/0981', 600, 60.25)).expect(201);
    expect(early.body.status).toBe('Exception');
    let d = (await accounts.get(`/api/v1/supplier-invoices/${early.body.id}`).expect(200)).body;
    expect(d.lines[0].matchNotes).toContain('600 still awaiting QC');
    await qcDecide(qc, r1.inspectionId, 'Release');
    // +0.42% on rate is within ±0.5%; after release the re-match passes
    expect((await accounts.post(`/api/v1/supplier-invoices/${early.body.id}/rematch`).expect(200)).body.status).toBe('Matched');
    d = (await accounts.get(`/api/v1/supplier-invoices/${early.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'Matched', taxableTotal: '36150.00', taxTotal: '6507.00', grandTotal: '42657.00' });
    expect(d.lines[0]).toMatchObject({ withinTolerance: true, billableQty: '600.0000', poRate: '60.0000' });
    expect((await accounts.post('/api/v1/supplier-invoices', invoice(po.id, po.lineId, 'mmpl/26/0981', 1, 60)).expect(409)).body.error.code).toBe('DUPLICATE_INVOICE');
    const bill = (await accounts.get(`/api/v1/supplier-invoices/billable?purchaseOrderId=${po.id}`).expect(200)).body.data[0];
    expect(bill).toMatchObject({ acceptedQty: 600, invoicedQty: 600, billableQty: 0 });

    // a second invoice: more than accepted, a higher rate and wrong GST → exception → justified → approved
    const r2 = await receive(f, po.id, po.lineId, 400);
    await qcDecide(qc, r2.inspectionId, 'Release');
    const second = await accounts.post('/api/v1/supplier-invoices', invoice(po.id, po.lineId, 'MMPL/26/1002', 410, 61.5, { tax: 4600 })).expect(201);
    expect(second.body.status).toBe('Exception');
    d = (await accounts.get(`/api/v1/supplier-invoices/${second.body.id}`).expect(200)).body;
    expect(d.lines[0].matchNotes).toMatch(/exceeds the QC-accepted quantity not yet invoiced \(400\).*\+2\.50% against the PO rate 60.*GST charged differs/);
    const sub = await accounts.post(`/api/v1/supplier-invoices/${second.body.id}/submit`, { note: 'Vendor added 10 kg free replacement and a freight surcharge agreed by phone; to be confirmed' }).expect(200);
    await approve(f.ph, sub.body.approvalRequestId).expect(200);
    await approve(f.fh, sub.body.approvalRequestId).expect(200);
    expect((await accounts.get(`/api/v1/supplier-invoices/${second.body.id}`).expect(200)).body).toMatchObject({ status: 'Approved', statusReason: 'Variance accepted' });
    await f.sales.get('/api/v1/supplier-invoices').expect(403);
  });
});
