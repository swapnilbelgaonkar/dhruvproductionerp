import { describe, expect, it } from 'vitest';
import { REPORT_IDS } from '../src/modules/mis/reports';
import { todayIST } from '../src/modules/sales/quotations';
import { db, userAgent } from './helpers';
import { dispatched } from './dispatch-fixtures';

describe('Management dashboard and reports (MIS-002, MIS-003, MIS-007, MIS-008)', () => {
  it('runs every report, scopes rows like the screens, filters the catalogue and exports CSV', async () => {
    const x = await dispatched();
    const admin = await userAgent([{ code: 'SUPER_ADMIN' }]);

    // the whole catalogue runs with its default filters (posting-reconciliation needs an entity)
    const cat = (await admin.get('/api/v1/reports').expect(200)).body;
    expect(cat.total).toBe(cat.catalogue);
    expect(cat.total).toBeGreaterThanOrEqual(45);
    for (const id of REPORT_IDS) {
      const q = id === 'posting-reconciliation' ? `?legalEntityId=${x.f.le}` : '';
      const r = await admin.get(`/api/v1/reports/${id}/run${q}`);
      expect([id, r.status]).toEqual([id, 200]);
      expect(Array.isArray(r.body.rows)).toBe(true);
    }

    // MIS-008 grid: filters by status, MT and value; the invoice register finds the dispatch invoice
    const grid = (await admin.get(`/api/v1/reports/sales-orders/run?status=Approved&minMt=0.01&maxValue=999999`).expect(200)).body;
    expect(grid.rows.find((r: { id: string }) => r.id === x.so)).toMatchObject({ packs: '30.0000', mt: '0.0300', status: 'Approved' });
    expect((await admin.get('/api/v1/reports/sales-orders/run?status=Nonsense').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    expect((await admin.get('/api/v1/reports/sales-orders/run?from=22-11-2026').expect(400)).body.error.code).toBe('VALIDATION_FAILED');
    const reg = (await admin.get(`/api/v1/reports/invoice-register/run?legalEntityId=${x.f.le}`).expect(200)).body;
    expect(reg.rows).toEqual([expect.objectContaining({ docNo: x.invoice.docNo, taxable: '4800.00' })]);
    expect(reg.totals).toMatchObject({ taxable: 4800, total: 5040 });

    // MIS-003: an accountant limited to another entity sees none of this entity's invoices
    const otherLe = (await db.query(`insert into org.legal_entities (code, name, pan, state_code, status) values ('LE-' || substr(md5(random()::text), 1, 6), '[TEST] Other', 'AAAAA0000A', '27', 'Active') returning id`)).rows[0].id;
    const scoped = await userAgent([{ code: 'ACCOUNTS_EXEC', scope: { legalEntityIds: [otherLe], plantIds: [], warehouseIds: [], territoryIds: [] } }]);
    expect((await scoped.get('/api/v1/reports/invoice-register/run').expect(200)).body.rows.find((r: { id: string }) => r.id === x.invoice.id)).toBeUndefined();
    expect((await x.accounts.get('/api/v1/reports/invoice-register/run').expect(200)).body.rows.find((r: { id: string }) => r.id === x.invoice.id)).toBeTruthy();

    // the catalogue shows only what the role may open; a report outside it is not found
    const keeperCat = (await x.keeper.get('/api/v1/reports').expect(200)).body.data.map((r: { id: string }) => r.id);
    expect(keeperCat).toContain('stock-summary');
    expect(keeperCat).not.toContain('payment-register');
    await x.keeper.get('/api/v1/reports/payment-register/run').expect(404);

    // CSV for Excel: BOM, header, rows and a total line
    const csv = await admin.get(`/api/v1/reports/invoice-register/export?legalEntityId=${x.f.le}`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toContain(`invoice-register-${todayIST()}.csv`);
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Invoice,Date,Dealer,GSTIN,POS,Taxable (₹),CGST (₹),SGST (₹),IGST (₹),Total (₹),Outstanding (₹),Status');
    expect(lines[1]).toContain(x.invoice.docNo);
    expect(lines.at(-1)).toMatch(/^Total,/);

    // posting reconciliation: the ledger agrees with the receivables sub-ledger
    const rec = (await admin.get(`/api/v1/reports/posting-reconciliation/run?legalEntityId=${x.f.le}`).expect(200)).body.rows;
    expect(rec[0]).toMatchObject({ area: 'Trade receivables (Dr)', ledger: 5040, subledger: 5040, difference: 0 });
  });

  it('computes the BRD KPI cards with thresholds and the trend panels', async () => {
    const x = await dispatched();
    const mgmt = await userAgent([{ code: 'MANAGEMENT_VIEWER' }]);
    const se = await userAgent([{ code: 'SALES_SE' }]);
    await se.get('/api/v1/dashboard/executive').expect(403);
    const d = (await mgmt.get('/api/v1/dashboard/executive').expect(200)).body;
    expect(d.kpis.map((k: { key: string }) => k.key)).toEqual(['pipeline', 'activeOrders', 'oee', 'quarantine', 'overdue', 'pendingDispatch']);
    for (const k of d.kpis) {
      expect(['green', 'amber', 'red', 'neutral']).toContain(k.rag);
      expect(k.formula.length).toBeGreaterThan(10);
      expect(k.owner).toBeTruthy();
    }
    expect(d.kpis.find((k: { key: string }) => k.key === 'activeOrders').value).toBeGreaterThanOrEqual(1);
    expect(d.months).toHaveLength(6);
    expect(Number(d.months.at(-1).sales)).toBeGreaterThanOrEqual(4800);

    // thresholds come from the setting (D23): lowering the overdue limit turns the card red
    await db.query(`update sales.invoices set invoice_date = $1::date - 40, due_date = $1::date - 10 where legal_entity_id = $2`, [todayIST(), x.f.le]);
    await db.query(`update sys.settings set value = jsonb_set(value, '{overdueRedAbove}', '100') where key = 'mis.kpiThresholds'`);
    try {
      expect((await mgmt.get('/api/v1/dashboard/executive').expect(200)).body.kpis.find((k: { key: string }) => k.key === 'overdue').rag).toBe('red');
    } finally {
      await db.query(`update sys.settings set value = jsonb_set(value, '{overdueRedAbove}', '1000000') where key = 'mis.kpiThresholds'`);
    }
  });
});
