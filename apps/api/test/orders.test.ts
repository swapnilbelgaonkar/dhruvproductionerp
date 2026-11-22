import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db } from './helpers';
import { activePriceList, addLicence, approve, quote, setup, type F } from './sales-fixtures';

const plusDays = (n: number) => { const d = new Date(`${todayIST()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const creditTerms = (f: F, limit: number, days = 30) => db.query(`update mdm.dealer_profiles set credit_limit = $2, credit_days = $3 where party_id = $1`, [f.party, limit, days]);
const steps = async (f: F, orderId: string) => (await f.se.get(`/api/v1/sales-orders/${orderId}`).expect(200)).body.approval.steps as { label: string; status: string }[];

async function ready() {
  const f = await setup();
  await activePriceList(f);
  await addLicence(f);
  return f;
}

describe('Sales orders (SO-001…011, D01)', () => {
  it('converts an approved quotation with its prices locked, and routes it per D01 while D15 is pending', async () => {
    const f = await ready();
    await creditTerms(f, 100000);
    const q = await f.se.post('/api/v1/quotations', quote(f)).expect(201);
    expect((await f.se.post(`/api/v1/quotations/${q.body.id}/submit`).expect(200)).body.status).toBe('Approved');
    expect((await f.se.get(`/api/v1/quotations/${q.body.id}`).expect(200)).body.allowedActions).toContain('convert');

    // the price list changes after the quotation: the order keeps the quoted rate
    await db.query(`update sales.price_list_items set rate = 300 where item_pack_id = $1`, [f.packA]);
    await f.se.post(`/api/v1/sales-orders/from-quotation/${q.body.id}`, { requiredBy: plusDays(-1) }).expect(422);
    const so = await f.se.post(`/api/v1/sales-orders/from-quotation/${q.body.id}`, { dealerPoNo: 'PO/77', dealerPoDate: todayIST(), requiredBy: plusDays(5) }).expect(201);
    expect(so.body.docNo).toMatch(/^SO\/\d{4}-\d{2}\/\d{6}$/);
    let o = (await f.se.get(`/api/v1/sales-orders/${so.body.id}`).expect(200)).body;
    expect(o).toMatchObject({ status: 'Draft', quotationId: q.body.id, dealerPoNo: 'PO/77', grandTotal: '4898.00' });
    expect(o.lines[0]).toMatchObject({ listRate: '245.50', schemeDiscountPct: '5.00' });
    expect((await f.se.get(`/api/v1/quotations/${q.body.id}`).expect(200)).body.status).toBe('Converted');
    await f.se.post(`/api/v1/sales-orders/from-quotation/${q.body.id}`, {}).expect(422);

    // lines are locked; the header can change
    expect((await f.se.put(`/api/v1/sales-orders/${so.body.id}`, { ...quote(f), version: o.version }).expect(422)).body.error.code).toBe('LINES_LOCKED');
    await f.se.put(`/api/v1/sales-orders/${so.body.id}`, { paymentTerms: '45 days', deliveryTerms: 'Door delivery', dealerPoNo: 'PO/78', requiredBy: plusDays(7), version: o.version }).expect(200);

    // D01: tier limits are inactive (D15), so the reporting manager approves, then accounts
    const sub = await f.se.post(`/api/v1/sales-orders/${so.body.id}/submit`).expect(200);
    expect(sub.body).toMatchObject({ status: 'Submitted', overCreditLimit: false });
    const st = await steps(f, so.body.id);
    expect(st.map((s) => s.label)).toEqual([expect.stringContaining('reporting manager'), 'Accounts review (credit & stock)']);
    await f.se2.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(403);
    await approve(f.rsm, sub.body.approvalRequestId);
    await approve(f.accounts, sub.body.approvalRequestId);
    o = (await f.se.get(`/api/v1/sales-orders/${so.body.id}`).expect(200)).body;
    expect(o).toMatchObject({ status: 'Approved', dealerPoNo: 'PO/78', paymentTerms: '45 days', creditLimit: '100000.00' });
    expect(o.approvedAt).toBeTruthy();
    await f.se2.get(`/api/v1/sales-orders/${so.body.id}`).expect(404);

    // cancelling frees the quotation for a new conversion
    await f.se.post(`/api/v1/sales-orders/${so.body.id}/cancel`, { reason: '[TEST] dealer changed the delivery month' }).expect(200);
    expect((await f.se.get(`/api/v1/quotations/${q.body.id}`).expect(200)).body.status).toBe('Accepted');
    await f.se.post(`/api/v1/sales-orders/from-quotation/${q.body.id}`, {}).expect(201);
  });

  it('prices a direct order from the price list and adds a finance override above the credit limit', async () => {
    const f = await ready();
    await creditTerms(f, 6000);
    await f.se.post('/api/v1/sales-orders', { ...quote(f), orderDate: plusDays(1) }).expect(422);
    const a = await f.se.post('/api/v1/sales-orders', { ...quote(f), dealerPoNo: 'PO-1' }).expect(201);
    const b = await f.se.post('/api/v1/sales-orders', { ...quote(f), dealerPoNo: 'PO-2' }).expect(201);
    expect((await f.se.get(`/api/v1/sales-orders/${a.body.id}`).expect(200)).body.liveCredit).toMatchObject({ creditLimit: 6000, overCreditLimit: false });

    const sa = await f.se.post(`/api/v1/sales-orders/${a.body.id}/submit`).expect(200);
    expect(sa.body.overCreditLimit).toBe(false);
    // the first order is open, so the second takes the dealer to 9,796 against a 6,000 limit
    const sb = await f.se.post(`/api/v1/sales-orders/${b.body.id}/submit`).expect(200);
    expect(sb.body.overCreditLimit).toBe(true);
    const st = await steps(f, b.body.id);
    expect(st.map((s) => s.label)).toEqual([expect.stringContaining('reporting manager'), 'Accounts review (credit & stock)', 'Credit limit override (finance head)']);
    await approve(f.rsm, sb.body.approvalRequestId);
    await approve(f.accounts, sb.body.approvalRequestId);
    await approve(f.fh, sb.body.approvalRequestId);
    const o = (await f.se.get(`/api/v1/sales-orders/${b.body.id}`).expect(200)).body;
    expect(o).toMatchObject({ status: 'Approved', overCreditLimit: true, openOrderValue: '4898.00' });
    await f.se.put(`/api/v1/sales-orders/${b.body.id}`, { ...quote(f), version: o.version }).expect(422);

    // register, search and the advance-payment dealer
    const list = await f.se.get(`/api/v1/sales-orders?partyId=${f.party}`).expect(200);
    expect(list.body.total).toBe(2);
    await creditTerms(f, 0, 0);
    const c = await f.se.post('/api/v1/sales-orders', quote(f)).expect(201);
    const sc = await f.se.post(`/api/v1/sales-orders/${c.body.id}/submit`).expect(200);
    expect(sc.body.overCreditLimit).toBe(false);
  });

  it('counts unpaid invoices in the exposure and freezes order-taking once an invoice is past its credit days (D18)', async () => {
    const f = await ready();
    await creditTerms(f, 100000, 30);
    const a = await f.se.post('/api/v1/sales-orders', { ...quote(f), dealerPoNo: 'PO-A' }).expect(201);
    const sa = await f.se.post(`/api/v1/sales-orders/${a.body.id}/submit`).expect(200);
    await approve(f.rsm, sa.body.approvalRequestId);
    await approve(f.accounts, sa.body.approvalRequestId);
    // an invoice of 4,000 against the order, 5 days past due (shipment and invoice inserted directly: dispatch and invoicing have their own tests)
    const wh = (await db.query(`insert into org.warehouses (legal_entity_id, code, name, type, state_code, status) values ($1, 'FG-' || substr(md5(random()::text), 1, 6), '[TEST] FG', 'FG', '27', 'Active') returning id`, [f.le])).rows[0].id;
    const sh = (await db.query(`insert into logistics.shipments (doc_no, sales_order_id, legal_entity_id, party_id, ship_to_id, warehouse_id, planned_date, status)
      values ('DSP-T-' || substr(md5(random()::text), 1, 8), $1, $2, $3, $4, $5, $6, 'Planned') returning id`, [a.body.id, f.le, f.party, f.registered, wh, plusDays(-40)])).rows[0].id;
    await db.query(`insert into sales.invoices (doc_no, legal_entity_id, seller_state, party_id, bill_to_id, ship_to_id, place_of_supply, inter_state, sales_order_id, shipment_id, invoice_date, due_date,
      payment_terms, taxable_total, grand_total) values ('T' || substr(md5(random()::text), 1, 12), $1, '27', $2, $3, $3, '27', false, $4, $5, $6, $7, '30 days', 3810, 4000)`,
      [f.le, f.party, f.registered, a.body.id, sh, plusDays(-35), plusDays(-5)]);
    const b = await f.se.post('/api/v1/sales-orders', { ...quote(f), dealerPoNo: 'PO-B' }).expect(201);
    const live = (await f.se.get(`/api/v1/sales-orders/${b.body.id}`).expect(200)).body.liveCredit;
    expect(live).toMatchObject({ outstanding: 4000, overdue: 4000, frozen: true });
    const frozen = await f.se.post(`/api/v1/sales-orders/${b.body.id}/submit`).expect(422);
    expect(frozen.body.error.code).toBe('OVERDUE_FREEZE');
    expect(frozen.body.error.details.overdueInvoices[0]).toMatchObject({ outstanding: 4000, daysOverdue: 5 });
    // the grace setting (provisional) lifts it; the snapshot then records the receivables
    await db.query(`update sys.settings set value = '10' where key = 'sales.credit.overdueGraceDays'`);
    try {
      await f.se.post(`/api/v1/sales-orders/${b.body.id}/submit`).expect(200);
    } finally {
      await db.query(`update sys.settings set value = '0' where key = 'sales.credit.overdueGraceDays'`);
    }
    expect((await f.se.get(`/api/v1/sales-orders/${b.body.id}`).expect(200)).body).toMatchObject({ outstandingValue: '4000.00', overdueValue: '4000.00' });
  });
});
