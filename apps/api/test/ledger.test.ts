import { describe, expect, it } from 'vitest';
import { todayIST } from '../src/modules/sales/quotations';
import { db, userAgent } from './helpers';
import { dispatched } from './dispatch-fixtures';

const nextMonthStart = () => { const d = new Date(`${todayIST().slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 10); };

describe('General ledger (D02): automatic postings, manual journals, period lock, statements and GST (FIN-013…FIN-020)', () => {
  it('posts documents and stock once, reverses cancellations, balances, and respects the period lock', async () => {
    const x = await dispatched();
    const le = x.f.le;
    const exec = await userAgent([{ code: 'EXEC_ADMIN' }]);
    const accounts = (await x.accounts.get('/api/v1/gl/accounts').expect(200)).body.data as { id: string; systemKey: string | null }[];
    const A = (k: string) => accounts.find((a) => a.systemKey === k)!.id;
    const tb = async () => (await x.accounts.get(`/api/v1/gl/trial-balance?legalEntityId=${le}`).expect(200)).body;
    const close = (t: { data: { id: string; closing: number }[] }, k: string) => t.data.find((r) => r.id === A(k))?.closing ?? 0;

    // receipt of 3,000 against the 5,040 invoice
    const rc = await x.accounts.post('/api/v1/receipts', { legalEntityId: le, partyId: x.party, receiptDate: todayIST(), mode: 'NEFT', reference: 'UTR-GL-1', amount: 3000 }).expect(201);
    let t = await tb();
    expect(t.balanced).toBe(true);
    expect([close(t, 'SALES'), close(t, 'OUTPUT_CGST'), close(t, 'OUTPUT_SGST'), close(t, 'AR_TRADE'), close(t, 'BANK')]).toEqual([-4800, -120, -120, 2040, 3000]);
    expect(close(t, 'COGS')).toBeGreaterThan(0);                 // the dispatch valued out of finished goods
    expect(close(t, 'INV_FG') + close(t, 'COGS') + close(t, 'WIP') + close(t, 'INV_RM') + close(t, 'GRNI') + close(t, 'PRODUCTION_LOSS') + close(t, 'PACKING_CONSUMED') + close(t, 'INVENTORY_ADJ'))
      .toBeCloseTo(0, 2);                                         // stock moves only between stock, WIP, GRNI and cost accounts

    // idempotent: syncing again posts nothing new, and the invoice has exactly one journal
    expect((await x.accounts.post('/api/v1/gl/sync').expect(200)).body.posted).toBe(0);
    expect(Number((await db.query(`select count(*) from fin.journals where source_type = 'sales.invoice' and source_id = $1`, [x.invoice.id])).rows[0].count)).toBe(1);
    const stockRows = Number((await db.query(`select count(*) from inv.stock_ledger sl join org.warehouses w on w.id = sl.warehouse_id where w.legal_entity_id = $1`, [le])).rows[0].count);
    expect(Number((await db.query(`select count(*) from fin.stock_postings sp join inv.stock_ledger sl on sl.id = sp.stock_ledger_id join org.warehouses w on w.id = sl.warehouse_id where w.legal_entity_id = $1`, [le])).rows[0].count)).toBe(stockRows);

    // a cancelled receipt is reversed, not edited
    await x.fh.post(`/api/v1/receipts/${rc.body.id}/cancel`, { reason: '[TEST] wrong dealer' }).expect(200);
    t = await tb();
    expect([close(t, 'AR_TRADE'), close(t, 'BANK')]).toEqual([5040, 0]);
    const arLedger = (await x.accounts.get(`/api/v1/gl/ledger?legalEntityId=${le}&accountId=${A('AR_TRADE')}&partyId=${x.party}&from=${todayIST()}`).expect(200)).body;
    expect(arLedger.lines.map((l: { debit: number; credit: number }) => [l.debit, l.credit])).toEqual([[5040, 0], [0, 3000], [3000, 0]]);
    expect(arLedger.closing).toBe(5040);

    // manual journals: balanced, party on control accounts, maker-checker
    const jv = (lines: unknown[]) => ({ legalEntityId: le, date: todayIST(), narration: '[TEST] freight paid in cash', lines });
    expect((await x.accounts.post('/api/v1/gl/journals', jv([{ accountId: A('FREIGHT_OUTWARD'), debit: 500 }, { accountId: A('CASH'), credit: 400 }])).expect(422)).body.error.code).toBe('JOURNAL_NOT_BALANCED');
    expect((await x.accounts.post('/api/v1/gl/journals', jv([{ accountId: A('AR_TRADE'), debit: 500 }, { accountId: A('CASH'), credit: 500 }])).expect(422)).body.error.code).toBe('PARTY_REQUIRED');
    const m = await x.accounts.post('/api/v1/gl/journals', jv([{ accountId: A('FREIGHT_OUTWARD'), debit: 500 }, { accountId: A('CASH'), credit: 500 }])).expect(201);
    await x.accounts.post(`/api/v1/gl/journals/${m.body.id}/post`).expect(403);
    const own = await x.fh.post('/api/v1/gl/journals', jv([{ accountId: A('FREIGHT_OUTWARD'), debit: 100 }, { accountId: A('CASH'), credit: 100 }])).expect(201);
    expect((await x.fh.post(`/api/v1/gl/journals/${own.body.id}/post`).expect(422)).body.error.code).toBe('MAKER_CHECKER');
    await x.accounts.post(`/api/v1/gl/journals/${own.body.id}/cancel`).expect(200);
    await x.fh.post(`/api/v1/gl/journals/${m.body.id}/post`).expect(200);
    expect(close(await tb(), 'CASH')).toBe(-500);

    // P&L and balance sheet agree
    const pl = (await x.accounts.get(`/api/v1/gl/profit-and-loss?legalEntityId=${le}&from=${todayIST()}`).expect(200)).body;
    expect(pl.totalIncome).toBe(4800);
    expect(pl.expenses.find((e: { code: string }) => e.code === '5200').amount).toBe(500);
    const bs = (await x.accounts.get(`/api/v1/gl/balance-sheet?legalEntityId=${le}`).expect(200)).body;
    expect(bs.balanced).toBe(true);
    expect(bs.profit).toBe(pl.netProfit);

    // period lock: posting into it is refused; a document dated in it moves to the next open period with its own date kept
    await x.accounts.post('/api/v1/gl/periods/lock', { legalEntityId: le, period: todayIST().slice(0, 7) }).expect(403);
    const d2 = await x.accounts.post('/api/v1/gl/journals', jv([{ accountId: A('FREIGHT_OUTWARD'), debit: 50 }, { accountId: A('CASH'), credit: 50 }])).expect(201);
    expect((await x.fh.post('/api/v1/gl/periods/lock', { legalEntityId: le, period: todayIST().slice(0, 7) }).expect(422)).body.error.code).toBe('DRAFT_JOURNALS');
    await x.accounts.post(`/api/v1/gl/journals/${d2.body.id}/cancel`).expect(200);
    await x.fh.post('/api/v1/gl/periods/lock', { legalEntityId: le, period: todayIST().slice(0, 7) }).expect(200);
    const late = await x.accounts.post('/api/v1/receipts', { legalEntityId: le, partyId: x.party, receiptDate: todayIST(), mode: 'UPI', reference: 'UPI-GL-2', amount: 1000 }).expect(201);
    await x.accounts.post('/api/v1/gl/sync').expect(200);
    const lj = (await db.query(`select journal_date::text as d, original_date::text as o from fin.journals where source_type = 'fin.receipt' and source_id = $1 and source_event = 'posted'`, [late.body.id])).rows[0];
    expect(lj).toEqual({ d: nextMonthStart(), o: todayIST() });
    const m2 = await x.accounts.post('/api/v1/gl/journals', jv([{ accountId: A('FREIGHT_OUTWARD'), debit: 50 }, { accountId: A('CASH'), credit: 50 }])).expect(201);
    expect((await x.fh.post(`/api/v1/gl/journals/${m2.body.id}/post`).expect(422)).body.error.code).toBe('PERIOD_LOCKED');
    await x.fh.post('/api/v1/gl/periods/unlock', { legalEntityId: le, period: todayIST().slice(0, 7), reason: '[TEST] correction' }).expect(403);
    await exec.post('/api/v1/gl/periods/unlock', { legalEntityId: le, period: todayIST().slice(0, 7), reason: '[TEST] correction' }).expect(200);
    await x.fh.post(`/api/v1/gl/journals/${m2.body.id}/post`).expect(200);

    // GST working for the month: one B2C invoice at 5 %
    const g = (await x.accounts.get(`/api/v1/gl/gst?legalEntityId=${le}&month=${todayIST().slice(0, 7)}`).expect(200)).body;
    expect(g.gstr1.b2c).toEqual([expect.objectContaining({ placeOfSupply: '27', gstRate: '5.00', taxable: '4800.00', cgst: '120.00', sgst: '120.00' })]);
    expect(g.gstr1.hsn[0]).toMatchObject({ hsnCode: '31059090', qty: '24.0000' });
    expect(g.gstr3b).toMatchObject({ outwardTaxable: 4800, output: { cgst: 120, sgst: 120, igst: 0, rcm: 0 } });
  });
});
