import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db, userAgent } from './helpers';
import { dispatched } from './dispatch-fixtures';
import { inDays } from './purchase-fixtures';

describe('Receivables: receipts, allocation, bounce, ageing, statement and exposure (FIN-005…FIN-008, D18)', () => {
  it('allocates receipts oldest first, reverses a bounced cheque, ages what is left and freezes the dealer once overdue', async () => {
    const { f, party: partyId, invoice, accounts, fh } = await dispatched();
    const sales = await userAgent([{ code: 'CREDIT_CONTROLLER' }]);

    // exposure: the 5,040 invoice + the 1,260 of the order not yet invoiced
    expect((await sales.get(`/api/v1/receivables/credit/${partyId}`).expect(200)).body).toMatchObject({ creditLimit: 100000, outstanding: 5040, uninvoicedOrders: 1260, onAccount: 0, exposure: 6300, frozen: false });

    const base = { legalEntityId: f.le, partyId, receiptDate: todayIST() };
    await sales.post('/api/v1/receipts', { ...base, mode: 'NEFT', reference: 'UTR001', amount: 3000 }).expect(403);
    await accounts.post('/api/v1/receipts', { ...base, mode: 'NEFT', amount: 3000 }).expect(400);                          // UTR required
    const neft = await accounts.post('/api/v1/receipts', { ...base, mode: 'NEFT', reference: 'UTR001', amount: 3000 }).expect(201);
    expect(neft.body).toMatchObject({ allocated: 3000, onAccount: 0 });
    expect((await accounts.post('/api/v1/receipts', { ...base, mode: 'NEFT', reference: 'UTR001', amount: 10 }).expect(409)).body.error.code).toBe('DUPLICATE_RECEIPT');
    expect((await accounts.post('/api/v1/receipts', { ...base, mode: 'CASH', amount: 250000 }).expect(422)).body.error.code).toBe('CASH_LIMIT');
    await accounts.post('/api/v1/receipts', { ...base, mode: 'CHEQUE', reference: '000123', amount: 3000 }).expect(400);    // cheque date required
    const chq = await accounts.post('/api/v1/receipts', { ...base, mode: 'CHEQUE', reference: '000123', instrumentDate: todayIST(), draweeBank: 'SBI Niphad', amount: 3000 }).expect(201);
    expect(chq.body).toMatchObject({ allocated: 2040, onAccount: 960 });
    expect((await accounts.get(`/api/v1/sales-invoices/${invoice.id}`).expect(200)).body).toMatchObject({ amountSettled: '5040.00', outstanding: '0.00' });
    expect((await sales.get(`/api/v1/receivables/credit/${partyId}`).expect(200)).body).toMatchObject({ outstanding: 0, onAccount: 960, exposure: 300 });

    // an electronic receipt cannot bounce; the cheque can, and the invoice falls due again
    expect((await accounts.post(`/api/v1/receipts/${neft.body.id}/bounce`, { bouncedOn: todayIST(), reason: 'x' }).expect(422)).body.error.code).toBe('NOT_AN_INSTRUMENT');
    await accounts.post(`/api/v1/receipts/${chq.body.id}/bounce`, { bouncedOn: todayIST(), reason: 'Funds insufficient' }).expect(200);
    const c = (await accounts.get(`/api/v1/receipts/${chq.body.id}`).expect(200)).body;
    expect(c).toMatchObject({ status: 'Bounced', allocated: '0.00' });
    expect(c.allocations[0]).toMatchObject({ status: 'Reversed', reversalReason: 'Bounced: Funds insufficient' });
    expect((await accounts.get(`/api/v1/sales-invoices/${invoice.id}`).expect(200)).body.outstanding).toBe('2040.00');

    // manual allocation and its reversal; the finance head alone can cancel a receipt
    const upi = await accounts.post('/api/v1/receipts', { ...base, mode: 'UPI', reference: 'UPI-77', amount: 500, allocation: 'none' }).expect(201);
    expect(upi.body.onAccount).toBe(500);
    expect((await accounts.post(`/api/v1/receipts/${upi.body.id}/allocate`, { allocation: [{ invoiceId: invoice.id, amount: 600 }] }).expect(422)).body.error.code).toBe('OVER_ALLOCATED');
    await accounts.post(`/api/v1/receipts/${upi.body.id}/allocate`, { allocation: [{ invoiceId: invoice.id, amount: 500 }] }).expect(200);
    await accounts.post(`/api/v1/receipts/${upi.body.id}/cancel`, { reason: 'x' }).expect(403);
    await fh.post(`/api/v1/receipts/${upi.body.id}/cancel`, { reason: '[TEST] posted to the wrong dealer' }).expect(200);
    expect((await accounts.get(`/api/v1/sales-invoices/${invoice.id}`).expect(200)).body.outstanding).toBe('2040.00');

    // five days past due: aged in 1–30, frozen, and the statement runs to the same balance
    await db.query(`update sales.invoices set invoice_date = $2, due_date = $3 where id = $1`, [invoice.id, inDays(-35), inDays(-5)]);
    const credit = (await sales.get(`/api/v1/receivables/credit/${partyId}`).expect(200)).body;
    expect(credit).toMatchObject({ outstanding: 2040, overdue: 2040, frozen: true });
    expect(credit.overdueInvoices[0]).toMatchObject({ docNo: invoice.docNo, daysOverdue: 5 });
    const ageing = (await sales.get('/api/v1/receivables/ageing').expect(200)).body;
    expect(ageing.data.find((x: { partyId: string }) => x.partyId === partyId)).toMatchObject({ notDue: 0, d1to30: 2040, total: 2040, overdue: 2040, oldestDays: 5 });
    const st = (await sales.get(`/api/v1/receivables/statement/${partyId}?from=${inDays(-40)}`).expect(200)).body;
    expect(st.lines.map((l: { kind: string; debit: number; credit: number }) => [l.kind, l.debit, l.credit])).toEqual([
      ['Invoice', 5040, 0], ['Receipt', 0, 3000], ['Receipt', 0, 3000], ['Cheque bounced', 3000, 0]]);
    expect(st).toMatchObject({ opening: 0, closing: 2040 });
  });
});
