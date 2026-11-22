import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db } from './helpers';
import { dispatched } from './dispatch-fixtures';
import { inDays } from './purchase-fixtures';
import { lotQty } from './production-fixtures';

describe('Sales invoicing: tax invoice at dispatch, cancellation, credit notes and customer returns (FIN-001…FIN-005, LOG-012)', () => {
  it('raises a GST invoice with the dispatch, priced from the order, and lets it be cancelled and raised again only inside the rules', async () => {
    const { shipmentId, invoice, accounts, logistics } = await dispatched();
    expect(invoice.docNo).toMatch(/^SI\/\d{4}-\d{2}\/\d{5}$/);
    expect(invoice.docNo.length).toBeLessThanOrEqual(16);
    const inv = (await accounts.get(`/api/v1/sales-invoices/${invoice.id}`).expect(200)).body;
    expect(inv).toMatchObject({ status: 'Posted', interState: false, taxableTotal: '4800.00', cgstTotal: '120.00', sgstTotal: '120.00', grandTotal: '5040.00', invoiceDate: todayIST(), dueDate: inDays(30),
      shipmentId, lrNo: 'LR-1', amountInWords: expect.stringMatching(/Five Thousand Forty/i) });
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0]).toMatchObject({ qty: '24.0000', rate: '200.00', taxable: '4800.00', gstRate: '5.00' });
    expect(inv.lines[0].lots).toEqual([expect.objectContaining({ packs: 24, qty: 24 })]);
    expect(inv.hsnSummary).toEqual([{ hsnCode: '31059090', gstRate: 5, taxable: 4800, cgst: 120, sgst: 120, igst: 0 }]);
    expect(inv.allowedActions).toEqual(expect.arrayContaining(['cancel', 'credit_note']));
    expect((await logistics.get(`/api/v1/shipments/${shipmentId}`).expect(200)).body.invoice).toMatchObject({ docNo: invoice.docNo });

    // a second invoice for the same shipment is refused; logistics cannot invoice or cancel
    expect((await accounts.post('/api/v1/sales-invoices', { shipmentId }).expect(409)).body.error.code).toBe('ALREADY_INVOICED');
    await logistics.post(`/api/v1/sales-invoices/${invoice.id}/cancel`, { reason: 'x' }).expect(403);
    await accounts.post(`/api/v1/sales-invoices/${invoice.id}/cancel`, { reason: '[TEST] wrong ship-to' }).expect(200);
    expect((await accounts.get('/api/v1/sales-invoices/to-invoice').expect(200)).body.data.map((x: { id: string }) => x.id)).toContain(shipmentId);
    const again = await accounts.post('/api/v1/sales-invoices', { shipmentId }).expect(201);
    expect(again.body.docNo).not.toBe(invoice.docNo);

    // outside the window it can no longer be cancelled
    await db.query(`update sales.invoices set created_at = now() - interval '25 hours' where id = $1`, [again.body.id]);
    expect((await accounts.post(`/api/v1/sales-invoices/${again.body.id}/cancel`, { reason: 'late' }).expect(422)).body.error.code).toBe('CANCEL_WINDOW_OVER');
  });

  it('credits a shortage after approval, takes goods back into quarantine with a draft credit note, and lets QA restock or reject them', async () => {
    const { f, fgLot, invoice, accounts, fh, qa, keeper, shipmentId, logistics, so, line } = await dispatched();
    const il = (await accounts.get(`/api/v1/sales-invoices/${invoice.id}`).expect(200)).body.lines[0];

    // shortage of 1 pack
    expect((await accounts.post('/api/v1/credit-notes', { invoiceId: invoice.id, reason: 'RETURN', lines: [{ invoiceLineId: il.id, qty: 1 }] }).expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await accounts.post('/api/v1/credit-notes', { invoiceId: invoice.id, reason: 'SHORTAGE', lines: [{ invoiceLineId: il.id, qty: 25 }] }).expect(422)).body.error.code).toBe('OVER_CREDIT');
    await accounts.post('/api/v1/credit-notes', { invoiceId: invoice.id, reason: 'RATE_DIFFERENCE', lines: [{ invoiceLineId: il.id, taxable: 100 }] }).expect(400);   // needs an explanation
    const cn = await accounts.post('/api/v1/credit-notes', { invoiceId: invoice.id, reason: 'SHORTAGE', shipmentId, remarks: '[TEST] one bottle leaked', lines: [{ invoiceLineId: il.id, qty: 1 }] }).expect(201);
    expect(cn.body.docNo.length).toBeLessThanOrEqual(16);
    expect(cn.body.grandTotal).toBe(210);
    const sub = await accounts.post(`/api/v1/credit-notes/${cn.body.id}/submit`).expect(200);
    expect(sub.body.status).toBe('Submitted');
    await accounts.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(403);
    await fh.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
    expect((await accounts.get(`/api/v1/credit-notes/${cn.body.id}`).expect(200)).body).toMatchObject({ status: 'Approved', taxableTotal: '200.00', cgstTotal: '5.00', sgstTotal: '5.00' });
    const inv = (await accounts.get(`/api/v1/sales-invoices/${invoice.id}`).expect(200)).body;
    expect(inv).toMatchObject({ amountSettled: '210.00', outstanding: '4830.00' });
    expect(inv.allowedActions).not.toContain('cancel');

    // a rate difference credit note on value
    const rd = await accounts.post('/api/v1/credit-notes', { invoiceId: invoice.id, reason: 'RATE_DIFFERENCE', remarks: '[TEST] Kharif scheme price', lines: [{ invoiceLineId: il.id, taxable: 100 }] }).expect(201);
    expect(rd.body.grandTotal).toBe(105);
    await accounts.post(`/api/v1/credit-notes/${rd.body.id}/cancel`, { reason: '[TEST] not agreed' }).expect(200);

    // customer return: 2 packs back, one restocked and one rejected
    const ret = { invoiceId: invoice.id, warehouseId: f.fgWh, receivedOn: todayIST(), reason: 'LEAKAGE', lines: [{ invoiceLineId: il.id, lotId: fgLot, packs: 1, condition: 'cap loose' }, { invoiceLineId: il.id, lotId: fgLot, packs: 1, condition: 'leaking' }] };
    await qa.post('/api/v1/customer-returns', ret).expect(403);
    expect((await keeper.post('/api/v1/customer-returns', { ...ret, lines: [{ invoiceLineId: il.id, lotId: fgLot, packs: 24 }] }).expect(422)).body.error.code).toBe('OVER_CREDIT');   // 1 already credited
    const before = await lotQty(fgLot, 'QUARANTINE');
    const r = await keeper.post('/api/v1/customer-returns', ret).expect(201);
    expect(r.body.creditNoteNo).toMatch(/^CN\//);
    expect(await lotQty(fgLot, 'QUARANTINE')).toBe(before + 2);
    const draft = (await accounts.get(`/api/v1/credit-notes/${r.body.creditNoteId}`).expect(200)).body;
    expect(draft).toMatchObject({ reason: 'RETURN', status: 'Draft', grandTotal: '420.00', customerReturnNo: r.body.docNo });

    const d = (await qa.get(`/api/v1/customer-returns/${r.body.id}`).expect(200)).body;
    expect(d.allowedActions).toEqual(['decide']);
    await keeper.post(`/api/v1/customer-returns/${r.body.id}/decide`, { lines: [{ lineId: d.lines[0].id, disposition: 'Restock' }] }).expect(403);
    const unrestricted = await lotQty(fgLot);
    expect((await qa.post(`/api/v1/customer-returns/${r.body.id}/decide`, { lines: [{ lineId: d.lines[0].id, disposition: 'Restock' }] }).expect(200)).body).toMatchObject({ status: 'AwaitingQa', open: 1 });
    await qa.post(`/api/v1/customer-returns/${r.body.id}/decide`, { lines: [{ lineId: d.lines[0].id, disposition: 'Reject' }] }).expect(422);
    expect((await qa.post(`/api/v1/customer-returns/${r.body.id}/decide`, { lines: [{ lineId: d.lines[1].id, disposition: 'Reject', remarks: '[TEST] leaking' }] }).expect(200)).body.status).toBe('Closed');
    expect([await lotQty(fgLot), await lotQty(fgLot, 'REJECTED'), await lotQty(fgLot, 'QUARANTINE')]).toEqual([unrestricted + 1, 1, before]);

    // the restocked pack ships again as a loose pack; bulk stock that was never packed is not offered
    const s2 = await logistics.post('/api/v1/shipments', { salesOrderId: so, warehouseId: f.fgWh, plannedDate: todayIST(), lines: [{ soLineId: line, packs: 2 }] }).expect(201);
    const loose = (await keeper.get(`/api/v1/shipments/${s2.body.id}/loose-lots`).expect(200)).body.data;
    expect(loose).toEqual([expect.objectContaining({ lotId: fgLot, packs: 1 })]);
    expect((await keeper.post(`/api/v1/shipments/${s2.body.id}/pick`, { shipmentLineId: loose[0].shipmentLineId, lotId: fgLot, packs: 2 }).expect(422)).body.error.code).toBe('NO_LOOSE_PACKS');
    await keeper.post(`/api/v1/shipments/${s2.body.id}/pick`, { shipmentLineId: loose[0].shipmentLineId, lotId: fgLot, packs: 1 }).expect(201);
    expect((await keeper.get(`/api/v1/shipments/${s2.body.id}/loose-lots`).expect(200)).body.data).toEqual([]);
  });
});
