import { afterAll, describe, expect, it } from 'vitest';
import { encrypt } from '../src/lib/crypto';
import { syncLedger } from '../src/modules/finance/ledger';
import { tdsDueDate } from '../src/modules/finance/tds';
import { parseBankReply, renderBankFile } from '../src/modules/integrations/bank';
import { todayIST } from '../src/modules/sales/quotations';
import { cfg, db, userAgent } from './helpers';
import { activeVendor, approve, issuedPo, pass, qcUsers, receive, setup, coa } from './purchase-fixtures';

const section = { name: 'Payments to contractors', rateIndividual: 1, rateOther: 2, rateNoPan: 20, thresholdSingle: 30000, thresholdAnnual: 100000, deductOn: 'BASE', status: 'Active' };

describe('TDS from the master, bank payment files and the bank reply, TDS challans and 26Q (FIN-010)', () => {
  afterAll(async () => {
    await db.query(`update fin.tds_sections set status = 'Draft', rate_individual = null, rate_other = null, rate_no_pan = null, threshold_single = null, threshold_annual = null where code = '194C'`);
    await db.query(`update sys.integrations set mode = 'OFF' where code = 'BANK_PAYMENTS'`);
  });

  it('deducts by the master, pays by bank file, releases from the reply and deposits by challan', async () => {
    const f = await setup();
    const vendor = await activeVendor(f, [f.rm]);
    await db.query(`update mdm.parties set pan = 'ABCCD1234E' where id = $1`, [vendor]);
    await db.query(`update mdm.party_bank_accounts set account_no_enc = $2, account_holder = '[TEST] Mahalaxmi Minerals' where party_id = $1`, [vendor, encrypt('50100012341234', cfg.APP_ENCRYPTION_KEY)]);
    const po = await issuedPo(f, vendor, 1000);
    const qc = await qcUsers();
    const g = await receive(f, po.id, po.lineId, 1000);
    await qc.analyst.post(`/api/v1/qc/inspections/${g.inspectionId}/sample`, { sampleQty: 0 }).expect(200);
    await qc.analyst.post(`/api/v1/qc/inspections/${g.inspectionId}/results`, { results: pass, coaReceived: true, coaDocumentId: await coa(qc.analyst, g.inspectionId), recommendation: 'Release' }).expect(200);
    await qc.manager.post(`/api/v1/qc/inspections/${g.inspectionId}/decide`, { decision: 'Release', remarks: '' }).expect(200);
    const si = await f.acc.post('/api/v1/supplier-invoices', { purchaseOrderId: po.id, invoiceNo: 'MMPL/26/3001', invoiceDate: todayIST(), lines: [{ poLineId: po.lineId, qty: 1000, rate: 60, gstRate: 18 }] }).expect(201);
    // 60,000 + 18 % = 70,800

    // the section is master data: no rates, no deduction
    await f.fh.put(`/api/v1/tds/payees/vendor/${vendor}`, { section: '194C' }).expect(200);
    const compute = (amount: number) => f.acc.post('/api/v1/tds/compute', { payeeType: 'VENDOR', payeeId: vendor, lines: [{ docId: si.body.id, amount }] }).expect(200);
    expect((await compute(35400)).body).toMatchObject({ basis: 'NONE', amount: 0 });
    await f.acc.put('/api/v1/tds/sections/194C', section).expect(403);
    await f.fh.put('/api/v1/tds/sections/194C', { ...section, rateNoPan: null }).expect(400);
    await f.fh.put('/api/v1/tds/sections/194C', section).expect(200);
    // 35,400 paid = 30,000 before GST: not above the single-payment threshold, year within the annual one
    expect((await compute(35400)).body).toMatchObject({ basis: 'NONE', amount: 0 });
    // 47,200 paid = 40,000 base, company PAN → 2 % = 800
    expect((await compute(47200)).body).toMatchObject({ basis: 'AUTO', section: '194C', rate: 2, base: 40000, amount: 800 });
    await db.query(`update mdm.parties set pan = null where id = $1`, [vendor]);
    expect((await compute(47200)).body).toMatchObject({ rate: 20, amount: 8000 });                        // no PAN: s.206AA
    await db.query(`update mdm.parties set pan = 'ABCCD1234E' where id = $1`, [vendor]);

    const pay = (amount: number, extra: Record<string, unknown> = {}) => ({ legalEntityId: f.le, payeeType: 'VENDOR', payeeId: vendor, paymentDate: todayIST(), mode: 'NEFT', lines: [{ docId: si.body.id, amount }], ...extra });
    expect((await f.acc.post('/api/v1/payments', pay(47200, { tdsSection: '194C', tdsAmount: 500 })).expect(422)).body.error.code).toBe('TDS_DIFFERS');
    const p1 = (await f.acc.post('/api/v1/payments', pay(47200)).expect(201)).body;
    expect(p1).toMatchObject({ tdsAmount: 800, netAmount: 46400 });
    const p2 = (await f.acc.post('/api/v1/payments', pay(11800)).expect(201)).body;                         // 10,000 base; year 50,000 < 1 lakh
    expect(p2).toMatchObject({ tdsAmount: 0, netAmount: 11800 });
    for (const p of [p1, p2]) {
      const sub = await f.acc.post(`/api/v1/payments/${p.id}/submit`).expect(200);
      await approve(f.fh, sub.body.approvalRequestId).expect(200);
    }

    // bank file
    const acct = await f.fh.post('/api/v1/bank/bank-accounts', { legalEntityId: f.le, name: '[TEST] Current account', bankName: 'HDFC Bank', ifsc: 'HDFC0000123', accountNo: '50200099990001', clientCode: 'DHRUVAGRO', fileLayout: 'GENERIC_CSV' }).expect(201);
    const mk = { bankAccountId: acct.body.id, paymentIds: [p1.id, p2.id] };
    expect((await f.acc.post('/api/v1/bank/payment-batches', mk).expect(422)).body.error.code).toBe('INTEGRATION_OFF');
    await db.query(`update sys.integrations set mode = 'MANUAL' where code = 'BANK_PAYMENTS'`);
    const ready = (await f.acc.get('/api/v1/bank/payment-batches').expect(200)).body.ready.map((x: { id: string }) => x.id);
    expect(ready).toEqual(expect.arrayContaining([p1.id, p2.id]));
    const b = (await f.acc.post('/api/v1/bank/payment-batches', mk).expect(201)).body;
    expect(b).toMatchObject({ payments: 2, total: 58200 });
    await f.acc.post('/api/v1/bank/payment-batches', { ...mk, paymentIds: [p1.id] }).expect(409);
    expect((await f.acc.post(`/api/v1/payments/${p1.id}/release`, { reference: 'X12345678', paidOn: todayIST() }).expect(422)).body.error.code).toBe('IN_BANK_FILE');
    const file = await f.acc.get(`/api/v1/bank/payment-batches/${b.id}/file`).expect(200);
    expect(file.text.split('\r\n')[0]).toBe('Payment Ref,Txn Type,Amount,Value Date,Beneficiary Name,Beneficiary Account,IFSC,Debit Account,Narration');
    expect(file.text).toContain(`${p1.docNo},NEFT,46400.00,`);
    expect(file.text).toContain('50100012341234,SBIN0001234,50200099990001');
    // a changed account makes the old file invalid
    await db.query(`update mdm.party_bank_accounts set account_no_enc = $2 where party_id = $1`, [vendor, encrypt('50100099999999', cfg.APP_ENCRYPTION_KEY)]);
    expect((await f.acc.get(`/api/v1/bank/payment-batches/${b.id}/file`).expect(422)).body.error.code).toBe('FILE_CHANGED');
    await db.query(`update mdm.party_bank_accounts set account_no_enc = $2 where party_id = $1`, [vendor, encrypt('50100012341234', cfg.APP_ENCRYPTION_KEY)]);

    const d = todayIST();
    const reply = `Customer Ref,Amount,Status,UTR No,Value Date,Reason\n${p1.docNo},46400.00,SUCCESS,HDFCN52699887766,${d.slice(8)}/${d.slice(5, 7)}/${d.slice(0, 4)},\n${p2.docNo},11800.00,REJECTED,,,"Beneficiary account closed"\nPAY/X,1,SUCCESS,AAA,,\n`;
    await f.pe.post(`/api/v1/bank/payment-batches/${b.id}/reply`, { content: reply }).expect(403);
    const out = (await f.acc.post(`/api/v1/bank/payment-batches/${b.id}/reply`, { content: reply }).expect(200)).body;
    expect(out.result.map((x: { outcome: string }) => x.outcome)).toEqual(['paid', 'failed', 'unknown']);
    expect(out.closed).toBe(true);
    expect((await f.acc.get(`/api/v1/payments/${p1.id}`).expect(200)).body).toMatchObject({ status: 'Paid', reference: 'HDFCN52699887766' });
    const p2now = (await f.acc.get(`/api/v1/payments/${p2.id}`).expect(200)).body;
    expect(p2now).toMatchObject({ status: 'Approved', batchId: null });
    expect(p2now.statusReason).toContain('Beneficiary account closed');
    expect((await f.acc.get('/api/v1/bank/payment-batches').expect(200)).body.ready.map((x: { id: string }) => x.id)).toContain(p2.id);

    // challan and 26Q
    const period = d.slice(0, 7);
    const pending = (await f.acc.get('/api/v1/tds/payable').expect(200)).body.data.find((x: { legalEntityId: string; section: string }) => x.legalEntityId === f.le && x.section === '194C');
    expect(pending).toMatchObject({ deducted: 800, pending: 800, dueDate: tdsDueDate(period) });
    const ch = { legalEntityId: f.le, section: '194C', period, depositedOn: d, bsrCode: '0510308', challanSerial: '12345' };
    await f.pe.post('/api/v1/tds/challans', ch).expect(403);
    const c = (await f.acc.post('/api/v1/tds/challans', ch).expect(201)).body;
    expect(c).toMatchObject({ tdsAmount: 800, payments: 1, late: false });
    expect((await f.acc.post('/api/v1/tds/challans', ch).expect(422)).body.error.code).toBe('NOTHING_TO_DEPOSIT');
    await syncLedger(db);
    const j = (await db.query(`select a.system_key, l.debit::float, l.credit::float from fin.journals j join fin.journal_lines l on l.journal_id = j.id join fin.accounts a on a.id = l.account_id
        where j.source_type = 'fin.tds_challan' and j.source_id = $1 order by a.system_key`, [c.id])).rows;
    expect(j).toEqual([{ system_key: 'BANK', debit: 0, credit: 800 }, { system_key: 'TDS_PAYABLE', debit: 800, credit: 0 }]);
    const m = Number(d.slice(5, 7)); const fy = m >= 4 ? `${d.slice(0, 4)}-${String((Number(d.slice(0, 4)) + 1) % 100).padStart(2, '0')}` : `${Number(d.slice(0, 4)) - 1}-${d.slice(2, 4)}`;
    const quarter = m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
    const q26 = await f.acc.get(`/api/v1/tds/26q?legalEntityId=${f.le}&fy=${fy}&quarter=${quarter}`).expect(200);
    const row = q26.text.split('\r\n').find((l) => l.includes(p1.docNo))!;
    expect(row).toContain('194C,ABCCD1234E,');
    expect(row).toContain(',40000.00,');
    expect(row).toContain(',800.00,800.00,0510308,12345,');
    void userAgent;
  });

  it('renders the host-to-host layout and reads common reply wordings', () => {
    const body = renderBankFile('PIPE_H2H', { clientCode: 'DHRUV', debitAccount: '5020', date: '2026-11-25', batchNo: 'PBT/2026-27/00001' },
      [{ docNo: 'PAY/2026-27/000009', mode: 'RTGS', amount: 250000, name: 'Sai Packaging & Co.', account: '1234567890', ifsc: 'ICIC0000001', narration: 'PAY/2026-27/000009 Sai' }]);
    expect(body.split('\r\n')).toEqual(['H|DHRUV|PBT/2026-27/00001|25/11/2026|5020|1|250000.00', 'D|PAY/2026-27/000009|R|250000.00|Sai Packaging & Co.|1234567890|ICIC0000001|PAY/2026-27/000009 Sai', 'T|1|250000.00', '']);
    const rows = parseBankReply('Payment Reference|Transaction Status|Bank Reference|Txn Date\nPAY/1|Processed|ICIC9876543210|2026-11-25\nPAY/2|F||');
    expect(rows).toEqual([{ ref: 'PAY/1', ok: true, failed: false, utr: 'ICIC9876543210', date: '2026-11-25', reason: '' }, { ref: 'PAY/2', ok: false, failed: true, utr: '', date: null, reason: '' }]);
  });
});
