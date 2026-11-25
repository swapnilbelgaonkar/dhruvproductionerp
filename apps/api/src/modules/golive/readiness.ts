import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../../config';
import { withTx, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { syncLedger } from '../finance/ledger';

/**
 * Go-live readiness (Stage 8). Automatic checks read the live data; manual items are signed off by a named person.
 * Nothing here switches anything on: each failing check says where it is fixed.
 */
type Status = 'ok' | 'todo' | 'warn';
interface Check { key: string; area: string; title: string; status: Status; detail: string; fix?: string }

const MANUAL = [
  { key: 'decisions', area: 'Decisions', title: 'Open decisions closed and provisional defaults confirmed', detail: 'D03, D08, D11, D22, D23, D27, D29, D31 decided; D04, D05, D15 un-parked; the provisional approval limits, cancel window, freight tolerance, overdue freeze and KPI formulas confirmed in writing.' },
  { key: 'sit', area: 'Testing', title: 'System integration test passed', detail: 'End-to-end runs of order-to-cash, procure-to-pay, plan-to-produce-to-release and record-to-report on the go-live build (docs/development/stage-8-go-live.md §4).' },
  { key: 'security', area: 'Testing', title: 'Security test passed', detail: 'External penetration test and the access review (who holds which role) with no open high findings.' },
  { key: 'performance', area: 'Testing', title: 'Performance test passed', detail: 'The load script at the expected users and volumes within the agreed response times.' },
  { key: 'uat', area: 'Testing', title: 'User acceptance signed by each department head', detail: 'Sales, purchase, stores, production, QC, QA, logistics, finance and management.' },
  { key: 'training', area: 'People', title: 'Users trained', detail: 'Every user has had role training and has signed in to the training copy.' },
  { key: 'backup', area: 'Operations', title: 'Backups run and a restore was rehearsed', detail: 'Nightly database backup with retention, file-store backup, and one full restore to a spare server timed and written up.' },
  { key: 'hosting', area: 'Operations', title: 'Production hosting accepted', detail: 'D21: server, domain, TLS certificate, monitoring and the support contract in place.' },
  { key: 'pilot', area: 'Rollout', title: 'Pilot completed', detail: 'One plant and its dealers ran on the ERP for the agreed period with no blocking issues.' },
  { key: 'cutover', area: 'Rollout', title: 'Cut-over plan agreed', detail: 'Freeze of the old system, the order of the opening loads, who checks each figure, and the fall-back.' },
];

export function goliveRoutes(db: Db, cfg: Config) {
  const r = Router();
  const V = 'sys.golive:view';

  async function checks(): Promise<Check[]> {
    const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0] ?? {};
    const out: Check[] = [];
    const add = (c: Check) => out.push(c);

    // ---- company set-up (D26)
    const le = await one(`select count(*) filter (where status = 'Active')::int as active, count(*) filter (where status = 'Active' and (pan is null or registered_address is null))::int as incomplete,
        count(*) filter (where status = 'Active' and name ilike any (array['%[SAMPLE]%','%[TEST]%']))::int as sample from org.legal_entities`);
    add({ key: 'company', area: 'Company', title: 'Legal entities set up', status: le.active && !le.incomplete && !le.sample ? 'ok' : 'todo',
      detail: le.active ? `${le.active} active; ${le.incomplete} without PAN or registered address; ${le.sample} marked as sample` : 'No active legal entity', fix: 'Masters → Organisation' });
    const g = await one(`select count(*)::int as n, count(*) filter (where addr_line1 is null or location is null or pincode is null)::int as incomplete from org.gst_registrations where status = 'Active'`);
    add({ key: 'gstins', area: 'Company', title: 'GST registrations with full address', status: g.n && !g.incomplete ? 'ok' : 'todo', detail: `${g.n} GSTINs; ${g.incomplete} missing address line, place or PIN (needed for e-invoice and e-way bill)`, fix: 'Administration → Integrations → GST addresses' });
    const w = await one(`select count(*)::int as n, count(*) filter (where pincode is null or city is null or address is null)::int as incomplete from org.warehouses where status = 'Active'`);
    add({ key: 'warehouses', area: 'Company', title: 'Warehouses with dispatch address', status: w.n && !w.incomplete ? 'ok' : 'todo', detail: `${w.n} warehouses; ${w.incomplete} without address, city or PIN`, fix: 'Administration → Integrations → GST addresses' });
    const bank = await one(`select count(*)::int as n from fin.bank_accounts where status = 'Active'`);
    const bankDetails = await getSetting<string>(db, 'company.bankDetails', '');
    add({ key: 'bank', area: 'Company', title: 'Company bank accounts', status: bank.n && bankDetails ? 'ok' : 'todo', detail: `${bank.n} accounts for payment files; ${bankDetails ? 'invoice bank details set' : 'no bank details printed on invoices'}`, fix: 'Finance → Payables → Bank files; Administration → Configuration (company.bankDetails)' });

    // ---- data
    const sample = await one(`select
        (select count(*) from mdm.parties where legal_name ilike any (array['%[SAMPLE]%','%[TEST]%']))::int as parties,
        (select count(*) from mdm.items where name ilike any (array['%[SAMPLE]%','%[TEST]%']))::int as items,
        (select count(*) from org.employees where status = 'Active' and full_name ilike any (array['%[SAMPLE]%','%[TEST]%']))::int as employees,
        (select count(*) from org.territories where name ilike any (array['%[SAMPLE]%','%[TEST]%']))::int as territories,
        (select count(*) from iam.users where status = 'Active' and (email like '%@demo.local' or full_name ilike '%[SAMPLE]%'))::int as users`);
    const nSample = Number(sample.parties) + Number(sample.items) + Number(sample.employees) + Number(sample.territories) + Number(sample.users);
    add({ key: 'sample', area: 'Data', title: 'No demo or test data', status: nSample ? 'todo' : 'ok',
      detail: nSample ? `${sample.parties} parties, ${sample.items} items, ${sample.employees} employees, ${sample.territories} territories and ${sample.users} active demo users are marked [SAMPLE]/[TEST]` : 'Nothing marked [SAMPLE] or [TEST]',
      fix: 'Go live on a fresh database (docs/development/stage-8-go-live.md §2); do not copy the demo database' });
    const masters = await one(`select (select count(*) from mdm.dealer_profiles where status = 'Active')::int as dealers, (select count(*) from mdm.vendor_profiles where status = 'Active')::int as vendors,
        (select count(*) from mdm.items where status = 'Active')::int as items, (select count(*) from org.employees where status = 'Active')::int as employees,
        (select count(*) from sales.price_lists where status = 'Active')::int as prices`);
    add({ key: 'masters', area: 'Data', title: 'Masters loaded and approved', status: masters.dealers && masters.vendors && masters.items && masters.prices ? 'ok' : 'todo',
      detail: `${masters.items} active items, ${masters.dealers} dealers, ${masters.vendors} vendors, ${masters.employees} employees, ${masters.prices} price lists`, fix: 'Administration → Import, then the normal approvals' });
    const pendingOk = (await getSetting<boolean>(db, 'parties.allowPendingKyc', false)) === true;
    const pend = await one(`select (select count(*) from mdm.dealer_profiles where status in ('Draft','Submitted'))::int as dealers, (select count(*) from mdm.vendor_profiles where status in ('Draft','Submitted'))::int as vendors`);
    add({ key: 'pendingKyc', area: 'Data', title: 'Only approved dealers and vendors can be traded with', status: pendingOk ? 'todo' : 'ok',
      detail: pendingOk ? `Switched on: ${pend.dealers} dealers and ${pend.vendors} vendors with KYC pending can be used in documents` : 'Dealers and vendors must be approved before documents are raised',
      fix: 'Complete their onboarding, then Administration → Settings → parties.allowPendingKyc = false' });
    const tds = await one(`select count(*) filter (where status = 'Active')::int as active from fin.tds_sections`);
    add({ key: 'tds', area: 'Data', title: 'TDS sections with rates', status: tds.active ? 'ok' : 'todo', detail: `${tds.active} sections active`, fix: 'Finance → TDS' });
    const gst = await one(`select count(*)::int as n from mdm.tax_rates`).catch(() => ({ n: 0 }));
    add({ key: 'gstrates', area: 'Data', title: 'GST rates entered for HSN codes', status: Number(gst.n) ? 'ok' : 'todo', detail: `${gst.n} effective-dated GST rates`, fix: 'Masters → Products → HSN and GST rates (D27)' });

    // ---- opening balances (D10)
    const cut = await getSetting<string | null>(db, 'golive.cutoverDate', null);
    add({ key: 'cutoverDate', area: 'Opening balances', title: 'Cut-over date set', status: cut ? 'ok' : 'todo', detail: cut ? `The ERP takes over on ${cut}` : 'Not set', fix: 'Go-live → Cut-over' });
    await syncLedger(db);
    const ob = (await db.query(`select le.id, le.code, le.name,
        exists (select 1 from fin.journals j where j.legal_entity_id = le.id and j.source_type = 'opening' and j.status = 'Posted') as tb,
        exists (select 1 from inv.stock_ledger sl join org.warehouses x on x.id = sl.warehouse_id where x.legal_entity_id = le.id and sl.txn_type = 'OPENING') as stock,
        coalesce((select sum(l.debit - l.credit) from fin.journal_lines l join fin.journals j on j.id = l.journal_id join fin.accounts a on a.id = l.account_id
          where j.legal_entity_id = le.id and j.status in ('Posted','Reversed') and a.system_key = 'OPENING_EQUITY'), 0)::float as plug,
        coalesce((select sum(grand_total - amount_settled) from sales.invoices i where i.legal_entity_id = le.id and i.is_opening and i.status = 'Posted'), 0)::float as ar_bills,
        coalesce((select sum(l.debit - l.credit) from fin.journal_lines l join fin.journals j on j.id = l.journal_id join fin.accounts a on a.id = l.account_id
          where j.legal_entity_id = le.id and j.source_type = 'opening' and j.status = 'Posted' and a.system_key = 'AR_TRADE'), 0)::float as ar_gl,
        coalesce((select sum(grand_total) from purchase.supplier_invoices s where s.legal_entity_id = le.id and s.is_opening and s.status <> 'Cancelled'), 0)::float as ap_bills,
        coalesce((select sum(l.credit - l.debit) from fin.journal_lines l join fin.journals j on j.id = l.journal_id join fin.accounts a on a.id = l.account_id
          where j.legal_entity_id = le.id and j.source_type = 'opening' and j.status = 'Posted' and a.system_key = 'AP_TRADE'), 0)::float as ap_gl
        from org.legal_entities le where le.status = 'Active' order by le.code`)).rows;
    for (const e of ob) {
      const ok = e.tb && e.stock && Math.abs(e.plug) < 1 && Math.abs(e.ar_bills - e.ar_gl) < 1 && Math.abs(e.ap_bills - e.ap_gl) < 1;
      add({ key: `opening:${e.code}`, area: 'Opening balances', title: `Opening balances agree — ${e.name}`, status: ok ? 'ok' : 'todo',
        detail: [`trial balance ${e.tb ? 'posted' : 'not loaded'}`, `stock ${e.stock ? 'loaded' : 'not loaded'}`, `opening balance equity left ₹${e.plug.toLocaleString('en-IN')} (should be 0)`,
          `open dealer invoices ₹${e.ar_bills.toLocaleString('en-IN')} vs ledger ₹${e.ar_gl.toLocaleString('en-IN')}`, `open vendor bills ₹${e.ap_bills.toLocaleString('en-IN')} vs ledger ₹${e.ap_gl.toLocaleString('en-IN')}`].join('; '),
        fix: 'Administration → Import → Opening balances' });
    }
    const tb = await one(`select coalesce(sum(debit), 0)::float as dr, coalesce(sum(credit), 0)::float as cr from fin.journal_lines l join fin.journals j on j.id = l.journal_id where j.status in ('Posted','Reversed')`);
    add({ key: 'ledger', area: 'Opening balances', title: 'Ledger balanced and every document posted', status: Math.abs(tb.dr - tb.cr) < 0.01 ? 'ok' : 'todo', detail: `Debits ₹${tb.dr.toLocaleString('en-IN')}, credits ₹${tb.cr.toLocaleString('en-IN')}`, fix: 'Finance → Ledger → Posting reconciliation' });

    // ---- security
    const mfaOn = (await getSetting<boolean>(db, 'auth.mfa.enforced', true)) !== false;
    const priv = await one(`select count(distinct u.id)::int as n, count(distinct u.id) filter (where u.mfa_enabled)::int as enrolled from iam.user_roles ur join iam.roles r on r.id = ur.role_id
        join iam.users u on u.id = ur.user_id where ur.status = 'Active' and u.status = 'Active' and r.requires_mfa`);
    add({ key: 'mfa', area: 'Security', title: 'Two-step verification switched on', status: mfaOn ? 'ok' : 'todo',
      detail: `${mfaOn ? 'On' : 'Off (built and ready, switched off before go-live as agreed)'}; ${priv.enrolled} of ${priv.n} administrators have enrolled an authenticator`,
      fix: 'Each administrator: My account → Two-step verification → Set up. Then Administration → Configuration → auth.mfa.enforced = true' });
    const boot = await one(`select count(*)::int as n from iam.users where status = 'Active' and must_change_password and last_login_at is not null`);
    add({ key: 'passwords', area: 'Security', title: 'Temporary passwords changed', status: boot.n ? 'todo' : 'ok', detail: `${boot.n} active users still on a temporary password` });
    add({ key: 'env', area: 'Security', title: 'Production configuration', status: cfg.isProd ? 'ok' : 'warn', detail: cfg.isProd ? 'Running with NODE_ENV=production (secure cookies, no demo seeding)' : `Running as ${cfg.NODE_ENV}`, fix: 'Deployment: NODE_ENV=production' });
    const url = await getSetting<string>(db, 'app.publicUrl', '');
    add({ key: 'url', area: 'Security', title: 'Public address set', status: /^https:\/\//.test(url) ? 'ok' : 'todo', detail: url || 'Not set (links in e-mails need it)', fix: 'Administration → Configuration (app.publicUrl)' });

    // ---- integrations
    const ints = (await db.query(`select code, name, mode from sys.integrations order by code`)).rows;
    const sim = ints.filter((i) => i.mode === 'SIMULATED');
    add({ key: 'simulated', area: 'Integrations', title: 'No simulated integrations', status: sim.length ? 'todo' : 'ok', detail: sim.length ? `${sim.map((i) => i.name).join(', ')} still simulated — results are not valid` : 'None simulated', fix: 'Administration → Integrations' });
    for (const code of ['EINVOICE', 'EWAYBILL', 'GST_RETURNS', 'EMAIL']) {
      const i = ints.find((x) => x.code === code);
      if (!i) continue;
      add({ key: `int:${code}`, area: 'Integrations', title: i.name, status: i.mode === 'OFF' ? 'todo' : i.mode === 'LIVE' || i.mode === 'MANUAL' ? 'ok' : 'todo',
        detail: i.mode === 'OFF' ? 'Switched off' : i.mode === 'MANUAL' ? 'Manual (portal upload) — live connection waits for the GST service provider (D27)' : i.mode === 'LIVE' ? 'Live' : 'Simulated', fix: 'Administration → Integrations' });
    }
    return out;
  }

  r.get('/', requirePermission(V), asyncHandler(async (req, res) => {
    const auto = await checks();
    const sign = await getSetting<Record<string, { by: string; at: string; note: string }>>(db, 'golive.signoff', {});
    const manual = MANUAL.map((m) => ({ ...m, status: (sign[m.key] ? 'ok' : 'todo') as Status, signedBy: sign[m.key]?.by ?? null, signedAt: sign[m.key]?.at ?? null, note: sign[m.key]?.note ?? null }));
    const all = [...auto, ...manual];
    res.json({ checks: auto, manual, ready: all.every((c) => c.status === 'ok'), done: all.filter((c) => c.status === 'ok').length, total: all.length,
      cutoverDate: await getSetting(db, 'golive.cutoverDate', null), canSignOff: can(req, 'sys.settings:configure') });
  }));

  r.put('/cutover', requirePermission('sys.settings:configure'), asyncHandler(async (req, res) => {
    const { date } = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }), req.body);
    await withTx(db, async (tx) => {
      const before = await getSetting(tx, 'golive.cutoverDate', null);
      if (before && date !== before && (await tx.query(`select 1 from fin.journals where source_type = 'opening' and status = 'Posted'`)).rowCount) {
        throw Errors.rule('OPENING_POSTED', 'Opening balances are posted at the current cut-over date; reverse the opening journals before changing it.');
      }
      await tx.query(`update sys.settings set value = $2, updated_at = now(), updated_by = $3 where key = $1`, ['golive.cutoverDate', JSON.stringify(date), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'sys.setting.updated', entityType: 'sys.setting', entityId: 'golive.cutoverDate', before: { value: before }, after: { value: date } });
    });
    res.json({ ok: true });
  }));

  r.post('/signoff/:key', requirePermission('sys.settings:configure'), asyncHandler(async (req, res) => {
    const { note, undo } = parse(z.object({ note: z.string().trim().min(3).max(500).optional(), undo: z.boolean().default(false) }), req.body);
    if (!MANUAL.some((m) => m.key === req.params.key)) throw Errors.notFound('Checklist item');
    if (!undo && !note) throw Errors.validation([{ field: 'note', message: 'Say what was checked (report, minutes, who signed)' }]);
    await withTx(db, async (tx) => {
      const cur = await getSetting<Record<string, unknown>>(tx, 'golive.signoff', {});
      const next = { ...cur };
      if (undo) delete next[req.params.key!]; else next[req.params.key!] = { by: req.auth!.user.fullName, at: new Date().toISOString(), note };
      await tx.query(`update sys.settings set value = $1, updated_at = now(), updated_by = $2 where key = 'golive.signoff'`, [JSON.stringify(next), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: undo ? 'golive.signoff.withdrawn' : 'golive.signoff', entityType: 'sys.setting', entityId: `golive.signoff/${req.params.key}`, after: { note } });
    });
    res.json({ ok: true });
  }));
  return r;
}
