import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db, userAgent, type Agent } from './helpers';
import { dispatched } from './dispatch-fixtures';
import { activeVendor, approve, coa, inDays, issuedPo, pass, qcUsers, receive, setup } from './purchase-fixtures';

async function qcDecide(qc: { analyst: Agent; manager: Agent }, inspectionId: string, decision: 'Release' | 'Reject') {
  await qc.analyst.post(`/api/v1/qc/inspections/${inspectionId}/sample`, { sampleQty: 0 }).expect(200);
  const results = decision === 'Release' ? pass : [{ ...pass[0]!, result: '30.2%', pass: false }];
  await qc.analyst.post(`/api/v1/qc/inspections/${inspectionId}/results`, { results, coaReceived: true, coaDocumentId: await coa(qc.analyst, inspectionId), recommendation: decision }).expect(200);
  await qc.manager.post(`/api/v1/qc/inspections/${inspectionId}/decide`, { decision, remarks: decision === 'Reject' ? 'Zinc below specification' : '' }).expect(200);
}

describe('Payables: vendor payments, debit-note adjustment, freight bills, ageing and the vendor ledger (FIN-009…FIN-012)', () => {
  it('adjusts a debit note, pays only a verified vendor after approval, holds amounts in flight and settles on release', async () => {
    const f = await setup();
    const vendor = await activeVendor(f, [f.rm]);
    const po = await issuedPo(f, vendor, 1000);
    const qc = await qcUsers();
    const bad = await receive(f, po.id, po.lineId, 400);
    await qcDecide(qc, bad.inspectionId, 'Reject');
    const sr = await f.keeper.post('/api/v1/supplier-returns', { goodsReceiptId: bad.id, reason: 'QC rejected', vehicleNo: 'MH12AB1234', lines: [{ lotId: bad.lotId, bucket: 'REJECTED', qty: 400 }] }).expect(201);
    await f.pe.post(`/api/v1/supplier-returns/${sr.body.id}/post`).expect(200);                        // DN 28,320
    const good = await receive(f, po.id, po.lineId, 600);
    await qcDecide(qc, good.inspectionId, 'Release');
    const si = await f.acc.post('/api/v1/supplier-invoices', { purchaseOrderId: po.id, invoiceNo: 'MMPL/26/2001', invoiceDate: todayIST(), lines: [{ poLineId: po.lineId, qty: 600, rate: 60, gstRate: 18 }] }).expect(201);
    expect(si.body.status).toBe('Matched');                                                              // 36,000 + 18 % = 42,480

    const q = `/api/v1/payments/payables?legalEntityId=${f.le}&payeeType=VENDOR&payeeId=${vendor}`;
    let open = (await f.acc.get(q).expect(200)).body;
    expect(open.data).toEqual([expect.objectContaining({ id: si.body.id, outstanding: 42480 })]);
    expect(open.debitNotes).toEqual([expect.objectContaining({ grandTotal: '28320.00' })]);
    expect(open.bank).toMatchObject({ verification: 'Verified', accountLast4: '1234' });
    await f.pe.post(`/api/v1/payables/debit-notes/${open.debitNotes[0].id}/adjust`, { supplierInvoiceId: si.body.id }).expect(403);
    await f.acc.post(`/api/v1/payables/debit-notes/${open.debitNotes[0].id}/adjust`, { supplierInvoiceId: si.body.id }).expect(200);
    open = (await f.acc.get(q).expect(200)).body;
    expect(open.data[0].outstanding).toBe(14160);
    expect(open.debitNotes).toEqual([]);

    const pay = (amount: number, extra: Record<string, unknown> = {}) => ({ legalEntityId: f.le, payeeType: 'VENDOR', payeeId: vendor, paymentDate: todayIST(), mode: 'NEFT', lines: [{ docId: si.body.id, amount }], ...extra });
    expect((await f.acc.post('/api/v1/payments', pay(20000)).expect(422)).body.error.code).toBe('OVERPAYMENT');
    await f.acc.post('/api/v1/payments', pay(10000, { tdsAmount: 10 })).expect(400);                   // TDS needs its section
    const p = await f.acc.post('/api/v1/payments', pay(10000, { tdsSection: '194Q', tdsAmount: 10, fromAccount: 'HDFC ••4521' })).expect(201);
    expect(p.body).toMatchObject({ amount: 10000, netAmount: 9990 });
    // 10,000 is held while the payment is in flight
    expect((await f.acc.post('/api/v1/payments', pay(5000)).expect(422)).body.error.code).toBe('OVERPAYMENT');

    await db.query(`update mdm.party_bank_accounts set verification = 'Pending' where party_id = $1`, [vendor]);
    expect((await f.acc.post(`/api/v1/payments/${p.body.id}/submit`).expect(422)).body.error.code).toBe('BANK_NOT_VERIFIED');
    await db.query(`update mdm.party_bank_accounts set verification = 'Verified' where party_id = $1`, [vendor]);
    const sub = await f.acc.post(`/api/v1/payments/${p.body.id}/submit`).expect(200);
    await f.acc.post(`/api/v1/payments/${p.body.id}/release`, { reference: 'HDFCN52612345', paidOn: todayIST() }).expect(422);   // not approved yet
    await approve(f.acc, sub.body.approvalRequestId).expect(403);
    await approve(f.fh, sub.body.approvalRequestId).expect(200);
    await f.acc.post(`/api/v1/payments/${p.body.id}/release`, { reference: 'HDFCN52612345', paidOn: todayIST() }).expect(200);
    expect((await f.acc.get(`/api/v1/payments/${p.body.id}`).expect(200)).body).toMatchObject({ status: 'Paid', reference: 'HDFCN52612345' });
    expect((await f.acc.get(q).expect(200)).body.data[0].outstanding).toBe(4160);

    const ageing = (await f.acc.get('/api/v1/payables/ageing').expect(200)).body;
    expect(ageing.data.find((x: { id: string }) => x.id === vendor)).toMatchObject({ type: 'VENDOR', notDue: 4160, total: 4160, overdue: 0 });
    const st = (await f.acc.get(`/api/v1/payables/statement/vendor/${vendor}?from=${inDays(-1)}`).expect(200)).body;
    expect(st.lines.map((l: { kind: string; debit: number; credit: number; balance: number }) => [l.kind, l.debit, l.credit, l.balance])).toEqual([
      ['Debit note', 28320, 0, -28320], ['Supplier invoice', 0, 42480, 14160], ['Payment', 10000, 0, 4160]]);
  });

  it('checks a freight bill against the dispatched shipments, routes a variance to finance, and pays the transporter', async () => {
    const x = await dispatched();
    await db.query(`update logistics.shipments set freight_amount = 1800 where id = $1`, [x.shipmentId]);
    const logHead2 = await userAgent([{ code: 'LOGISTICS_HEAD' }]);
    const billable = (await x.logistics.get(`/api/v1/freight-bills/billable?transporterId=${x.transporterId}`).expect(200)).body.data;
    expect(billable).toEqual([expect.objectContaining({ id: x.shipmentId, freightAmount: '1800.00' })]);
    const bill = { transporterId: x.transporterId, legalEntityId: x.f.le, billNo: 'SRW/B/101', billDate: todayIST(), dueDate: inDays(15), gstRate: 5, reverseCharge: true, lines: [{ shipmentId: x.shipmentId, amount: 2000 }] };
    const fb = await x.logistics.post('/api/v1/freight-bills', bill).expect(201);
    expect(fb.body).toMatchObject({ variance: 200, status: 'Submitted' });
    expect((await x.logistics.post('/api/v1/freight-bills', bill).expect(409)).body.error.code).toBe('DUPLICATE_BILL');
    expect((await x.logistics.post('/api/v1/freight-bills', { ...bill, billNo: 'SRW/B/102' }).expect(409)).body.error.code).toBe('ALREADY_BILLED');
    const d = (await x.logistics.get(`/api/v1/freight-bills/${fb.body.id}`).expect(200)).body;
    expect(d).toMatchObject({ taxableTotal: '2000.00', gstAmount: '100.00', grandTotal: '2000.00', reverseCharge: true });   // RCM: the tax is ours, not the transporter's
    const steps = (await logHead2.get(`/api/v1/approvals/${fb.body.approvalRequestId}`).expect(200)).body.steps.map((s: { label: string }) => s.label);
    expect(steps).toEqual(['Logistics head approval', 'Finance head approval (freight above agreed)']);
    await approve(logHead2, fb.body.approvalRequestId).expect(200);
    await approve(x.fh, fb.body.approvalRequestId).expect(200);
    expect((await x.accounts.get(`/api/v1/freight-bills/${fb.body.id}`).expect(200)).body.status).toBe('Approved');

    const p = await x.accounts.post('/api/v1/payments', { legalEntityId: x.f.le, payeeType: 'TRANSPORTER', payeeId: x.transporterId, paymentDate: todayIST(), mode: 'IMPS',
      tdsSection: '194C', tdsAmount: 40, lines: [{ docId: fb.body.id, amount: 2000 }] }).expect(201);
    const sub = await x.accounts.post(`/api/v1/payments/${p.body.id}/submit`).expect(200);
    await approve(x.fh, sub.body.approvalRequestId).expect(200);
    await x.accounts.post(`/api/v1/payments/${p.body.id}/release`, { reference: 'IMPS771', paidOn: todayIST() }).expect(200);
    expect((await x.accounts.get(`/api/v1/freight-bills/${fb.body.id}`).expect(200)).body).toMatchObject({ amountSettled: '2000.00', outstanding: '0.00' });
  });
});
