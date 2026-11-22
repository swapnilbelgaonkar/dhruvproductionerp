import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';

/**
 * Native general ledger (D02; BRD p.19; MP §18; FIN-013…FIN-020).
 * Journals are generated from the documents themselves — invoices, credit notes, receipts, supplier invoices, debit notes, freight bills,
 * payments — and from every valued stock movement. Posting is idempotent (one journal per document event, one valuation per stock row), so
 * the sync can run any number of times, including over documents raised before the ledger existed. A document dated in a locked period is
 * posted on the first day of the next open period, with its own date kept. Corrections are reversals, never edits.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

type Line = { key?: string; accountId?: string; debit?: number; credit?: number; partyId?: string | null; transporterId?: string | null; narration?: string | null };
interface JournalIn { le: string; date: string; sourceType: string; sourceId: string | null; sourceEvent: string; sourceRef: string | null; narration: string; lines: Line[]; userId?: string | null }

const keyCache = new Map<string, string>();
async function acct(tx: Tx, key: string) {
  const hit = keyCache.get(key);
  if (hit) return hit;
  const id = (await tx.query(`select id from fin.accounts where system_key = $1`, [key])).rows[0]?.id as string | undefined;
  if (!id) throw Errors.rule('ACCOUNT_MISSING', `No account is mapped to ${key}.`);
  keyCache.set(key, id);
  return id;
}

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
const monthEnd = (d: string) => { const x = new Date(`${monthStart(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10); };
async function ensurePeriod(tx: Tx, le: string, date: string) {
  await tx.query(`insert into fin.periods (legal_entity_id, period_start, period_end) values ($1,$2,$3) on conflict (legal_entity_id, period_start) do nothing`, [le, monthStart(date), monthEnd(date)]);
}
/** The date a journal can be posted on: its own, or the first day of the next open period when its month is locked. */
async function postingDate(tx: Tx, le: string, date: string) {
  let d = date;
  for (let i = 0; i < 240; i++) {
    await ensurePeriod(tx, le, d);
    const locked = (await tx.query(`select 1 from fin.periods where legal_entity_id = $1 and period_start = $2 and status = 'Locked'`, [le, monthStart(d)])).rowCount;
    if (!locked) return d;
    const x = new Date(`${monthStart(d)}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); d = x.toISOString().slice(0, 10);
  }
  throw Errors.rule('NO_OPEN_PERIOD', 'No open accounting period.');
}

/** Posts a balanced journal once per (source, event). Returns the journal id, or null when it already existed or had no value. */
export async function postJournal(tx: Tx, j: JournalIn): Promise<string | null> {
  const merged = new Map<string, { accountId: string; debit: number; credit: number; partyId: string | null; transporterId: string | null; narration: string | null }>();
  for (const l of j.lines) {
    const accountId = l.accountId ?? await acct(tx, l.key!);
    const k = `${accountId}|${l.partyId ?? ''}|${l.transporterId ?? ''}`;
    const m = merged.get(k) ?? { accountId, debit: 0, credit: 0, partyId: l.partyId ?? null, transporterId: l.transporterId ?? null, narration: l.narration ?? null };
    m.debit = r2(m.debit + (l.debit ?? 0)); m.credit = r2(m.credit + (l.credit ?? 0));
    merged.set(k, m);
  }
  const lines = [...merged.values()].map((m) => { const net = r2(m.debit - m.credit); return { ...m, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }; }).filter((m) => m.debit || m.credit);
  if (!lines.length) return null;
  const dr = r2(lines.reduce((a, l) => a + l.debit, 0)); const cr = r2(lines.reduce((a, l) => a + l.credit, 0));
  if (dr !== cr) throw Errors.rule('JOURNAL_NOT_BALANCED', `${j.sourceRef ?? j.sourceType}: debits ${dr} ≠ credits ${cr}.`);
  if (j.sourceType !== 'manual' && (await tx.query(`select 1 from fin.journals where source_type = $1 and source_id is not distinct from $2 and source_event = $3`, [j.sourceType, j.sourceId, j.sourceEvent])).rowCount) return null;
  const date = await postingDate(tx, j.le, j.date);
  const docNo = await nextDocNo(tx, 'JOURNAL', { date: new Date(`${date}T00:00:00Z`) });
  const row = (await tx.query(`insert into fin.journals (doc_no, legal_entity_id, journal_date, source_type, source_id, source_event, source_ref, narration, status, original_date, created_by, posted_at, posted_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'Posted',$9,$10,now(),$10,$10) returning id`,
    [docNo, j.le, date, j.sourceType, j.sourceId, j.sourceEvent, j.sourceRef, j.narration, date !== j.date ? j.date : null, j.userId ?? null])).rows[0];
  for (const l of lines) await tx.query(`insert into fin.journal_lines (journal_id, account_id, debit, credit, party_id, transporter_id, narration) values ($1,$2,$3,$4,$5,$6,$7)`,
    [row.id, l.accountId, l.debit, l.credit, l.partyId, l.transporterId, l.narration]);
  return row.id as string;
}

/** The mirror image of an existing journal, as a new journal for `event`. */
async function reverse(tx: Tx, sourceType: string, sourceId: string, ofEvent: string, event: string, date: string, narration: string) {
  const j = (await tx.query(`select id, legal_entity_id, source_ref from fin.journals where source_type = $1 and source_id = $2 and source_event = $3`, [sourceType, sourceId, ofEvent])).rows[0];
  if (!j) return null;
  const lines = (await tx.query(`select account_id, debit, credit, party_id, transporter_id from fin.journal_lines where journal_id = $1`, [j.id])).rows;
  return postJournal(tx, { le: j.legal_entity_id, date, sourceType, sourceId, sourceEvent: event, sourceRef: j.source_ref, narration,
    lines: lines.map((l) => ({ accountId: l.account_id, debit: Number(l.credit), credit: Number(l.debit), partyId: l.party_id, transporterId: l.transporter_id })) });
}

const roundLine = (r: number, side: 'income' | 'expense'): Line[] => (!r ? [] : side === 'income' ? [r > 0 ? { key: 'ROUND_OFF', credit: r } : { key: 'ROUND_OFF', debit: -r }] : [r > 0 ? { key: 'ROUND_OFF', debit: r } : { key: 'ROUND_OFF', credit: -r }]);
const ist = (col: string) => `(${col} at time zone 'Asia/Kolkata')::date::text`;
const none = (type: string, event: string, idCol = 'x.id') => `not exists (select 1 from fin.journals j where j.source_type = '${type}' and j.source_id = ${idCol} and j.source_event = '${event}')`;
const INV_KEY: Record<string, string> = { RM: 'INV_RM', PM: 'INV_PM', FG: 'INV_FG', SEMI: 'INV_FG' };
const COUNTER: Record<string, string> = {
  GRN: 'GRNI', GRN_REVERSAL: 'GRNI', SUPPLIER_RETURN: 'GRNI', OPENING: 'OPENING_EQUITY', SAMPLE: 'QC_SAMPLES',
  ISSUE_TO_PROD: 'WIP', RETURN_FROM_PROD: 'WIP', PRODUCTION_OUTPUT: 'WIP', PACKING_LOSS: 'PRODUCTION_LOSS', PACKING_ISSUE: 'PACKING_CONSUMED',
  DISPATCH: 'COGS', CUSTOMER_RETURN: 'COGS',
};

/** Posts everything not yet posted. Each document is its own transaction, so one bad document cannot block the rest. */
export async function syncLedger(db: Db): Promise<{ posted: number; failed: { ref: string; error: string }[] }> {
  let posted = 0;
  const failed: { ref: string; error: string }[] = [];
  const run = async (ref: string, fn: (tx: Tx) => Promise<unknown>) => {
    try { await withTx(db, async (tx) => { const r = await fn(tx); if (r) posted++; }); } catch (e) { failed.push({ ref, error: e instanceof Error ? e.message : String(e) }); }
  };
  const rows = async (sql: string) => (await db.query(sql)).rows;

  // ---------------------------------------------------------------- sales invoices
  for (const x of await rows(`select x.* from sales.invoices x where ${none('sales.invoice', 'posted')}`)) {
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: new Date(x.invoice_date).toISOString().slice(0, 10), sourceType: 'sales.invoice', sourceId: x.id, sourceEvent: 'posted', sourceRef: x.doc_no,
      narration: `Sales invoice ${x.doc_no}`, lines: [
        { key: 'AR_TRADE', debit: Number(x.grand_total), partyId: x.party_id }, { key: 'SALES', credit: Number(x.taxable_total) },
        { key: 'OUTPUT_CGST', credit: Number(x.cgst_total) }, { key: 'OUTPUT_SGST', credit: Number(x.sgst_total) }, { key: 'OUTPUT_IGST', credit: Number(x.igst_total) },
        ...roundLine(Number(x.round_off), 'income')] }));
  }
  for (const x of await rows(`select x.id, x.doc_no, ${ist('x.cancelled_at')} as d from sales.invoices x where x.status = 'Cancelled' and ${none('sales.invoice', 'cancelled')}`)) {
    await run(x.doc_no, (tx) => reverse(tx, 'sales.invoice', x.id, 'posted', 'cancelled', x.d, `Cancellation of ${x.doc_no}`));
  }
  // ---------------------------------------------------------------- credit notes
  for (const x of await rows(`select x.*, ${ist('x.approved_at')} as d from sales.credit_notes x where x.status = 'Approved' and ${none('sales.credit_note', 'approved')}`)) {
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: x.d, sourceType: 'sales.credit_note', sourceId: x.id, sourceEvent: 'approved', sourceRef: x.doc_no,
      narration: `Credit note ${x.doc_no} (${String(x.reason).toLowerCase()})`, lines: [
        { key: 'AR_TRADE', credit: Number(x.grand_total), partyId: x.party_id }, { key: 'SALES_RETURNS', debit: Number(x.taxable_total) },
        { key: 'OUTPUT_CGST', debit: Number(x.cgst_total) }, { key: 'OUTPUT_SGST', debit: Number(x.sgst_total) }, { key: 'OUTPUT_IGST', debit: Number(x.igst_total) },
        ...roundLine(Number(x.round_off), 'expense')] }));
  }
  // ---------------------------------------------------------------- receipts
  for (const x of await rows(`select x.* from fin.receipts x where ${none('fin.receipt', 'posted')}`)) {
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: new Date(x.receipt_date).toISOString().slice(0, 10), sourceType: 'fin.receipt', sourceId: x.id, sourceEvent: 'posted', sourceRef: x.doc_no,
      narration: `Receipt ${x.doc_no} ${x.mode}${x.reference ? ` ${x.reference}` : ''}`, lines: [
        { key: x.mode === 'CASH' ? 'CASH' : 'BANK', debit: Number(x.amount) }, { key: 'AR_TRADE', credit: Number(x.amount), partyId: x.party_id }] }));
  }
  for (const x of await rows(`select x.id, x.doc_no, x.bounced_on::text as d from fin.receipts x where x.status = 'Bounced' and ${none('fin.receipt', 'bounced')}`)) {
    await run(x.doc_no, (tx) => reverse(tx, 'fin.receipt', x.id, 'posted', 'bounced', x.d, `Cheque returned — ${x.doc_no}`));
  }
  for (const x of await rows(`select x.id, x.doc_no, ${ist('x.updated_at')} as d from fin.receipts x where x.status = 'Cancelled' and ${none('fin.receipt', 'cancelled')}`)) {
    await run(x.doc_no, (tx) => reverse(tx, 'fin.receipt', x.id, 'posted', 'cancelled', x.d, `Cancellation of ${x.doc_no}`));
  }
  // ---------------------------------------------------------------- supplier invoices and debit notes
  for (const x of await rows(`select x.*, po.legal_entity_id from purchase.supplier_invoices x join purchase.purchase_orders po on po.id = x.purchase_order_id
      where x.status in ('Matched','Approved') and ${none('purchase.supplier_invoice', 'booked')}`)) {
    const tax = Number(x.tax_total); const half = r2(tax / 2);
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: new Date(x.invoice_date).toISOString().slice(0, 10), sourceType: 'purchase.supplier_invoice', sourceId: x.id, sourceEvent: 'booked',
      sourceRef: x.doc_no, narration: `Supplier invoice ${x.doc_no} (bill ${x.invoice_no})`, lines: [
        { key: 'AP_TRADE', credit: Number(x.grand_total), partyId: x.party_id }, { key: 'GRNI', debit: Number(x.taxable_total) },
        ...(x.inter_state ? [{ key: 'INPUT_IGST', debit: tax }] : [{ key: 'INPUT_CGST', debit: half }, { key: 'INPUT_SGST', debit: r2(tax - half) }]),
        ...roundLine(Number(x.round_off), 'expense')] }));
  }
  for (const x of await rows(`select x.id, x.doc_no, ${ist('x.updated_at')} as d from purchase.supplier_invoices x where x.status = 'Cancelled' and ${none('purchase.supplier_invoice', 'cancelled')}`)) {
    await run(x.doc_no, (tx) => reverse(tx, 'purchase.supplier_invoice', x.id, 'booked', 'cancelled', x.d, `Cancellation of ${x.doc_no}`));
  }
  for (const x of await rows(`select x.*, coalesce(po1.legal_entity_id, po2.legal_entity_id) as legal_entity_id from purchase.debit_notes x
      left join purchase.supplier_returns sr on sr.id = x.supplier_return_id left join purchase.purchase_orders po1 on po1.id = sr.purchase_order_id
      left join purchase.supplier_invoices si on si.id = x.supplier_invoice_id left join purchase.purchase_orders po2 on po2.id = si.purchase_order_id
      where x.status in ('Open','Adjusted') and ${none('purchase.debit_note', 'raised')}`)) {
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: new Date(x.note_date).toISOString().slice(0, 10), sourceType: 'purchase.debit_note', sourceId: x.id, sourceEvent: 'raised', sourceRef: x.doc_no,
      narration: `Debit note ${x.doc_no}`, lines: [
        { key: 'AP_TRADE', debit: Number(x.grand_total), partyId: x.party_id }, { key: 'GRNI', credit: Number(x.taxable_total) },
        { key: 'INPUT_CGST', credit: Number(x.cgst_total) }, { key: 'INPUT_SGST', credit: Number(x.sgst_total) }, { key: 'INPUT_IGST', credit: Number(x.igst_total) },
        ...roundLine(Number(x.round_off), 'income')] }));
  }
  // ---------------------------------------------------------------- freight bills and payments
  for (const x of await rows(`select x.*, ${ist('x.updated_at')} as d from logistics.freight_bills x where x.status = 'Approved' and ${none('logistics.freight_bill', 'approved')}`)) {
    const gst = Number(x.gst_amount);
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: new Date(x.bill_date).toISOString().slice(0, 10), sourceType: 'logistics.freight_bill', sourceId: x.id, sourceEvent: 'approved',
      sourceRef: x.doc_no, narration: `Freight bill ${x.doc_no} (bill ${x.bill_no})${x.reverse_charge ? ', GST under reverse charge' : ''}`, lines: [
        { key: 'FREIGHT_OUTWARD', debit: Number(x.taxable_total) }, { key: 'AP_TRANSPORT', credit: Number(x.grand_total), transporterId: x.transporter_id },
        ...(x.reverse_charge ? [{ key: 'INPUT_GST_RCM', debit: gst }, { key: 'RCM_PAYABLE', credit: gst }] : [{ key: 'INPUT_GST_OTHER', debit: gst }])] }));
  }
  for (const x of await rows(`select x.* from fin.payments x where x.status = 'Paid' and ${none('fin.payment', 'paid')}`)) {
    await run(x.doc_no, (tx) => postJournal(tx, { le: x.legal_entity_id, date: new Date(x.paid_on).toISOString().slice(0, 10), sourceType: 'fin.payment', sourceId: x.id, sourceEvent: 'paid', sourceRef: x.doc_no,
      narration: `Payment ${x.doc_no} ${x.mode} ${x.reference}`, lines: [
        x.payee_type === 'VENDOR' ? { key: 'AP_TRADE', debit: Number(x.amount), partyId: x.party_id } : { key: 'AP_TRANSPORT', debit: Number(x.amount), transporterId: x.transporter_id },
        { key: 'BANK', credit: Number(x.net_amount) }, { key: 'TDS_PAYABLE', credit: Number(x.tds_amount) }] }));
  }
  // ---------------------------------------------------------------- stock movements valued into inventory
  const groups = await rows(`select w.legal_entity_id as le, ${ist('sl.posted_at')} as d, sl.source_type, sl.source_id, sl.txn_type, array_agg(sl.id order by sl.id) as ids
      from inv.stock_ledger sl join org.warehouses w on w.id = sl.warehouse_id where not exists (select 1 from fin.stock_postings sp where sp.stock_ledger_id = sl.id)
      group by 1, 2, 3, 4, 5 order by min(sl.id)`);
  for (const g of groups) {
    const ids = (g.ids as (string | number)[]).map(Number);
    await run(`${g.txn_type} ${g.source_type}`, async (tx) => {
      const val = (await tx.query(`select i.item_type, sum(sl.qty * sl.unit_cost) as v from inv.stock_ledger sl join mdm.items i on i.id = sl.item_id where sl.id = any($1::bigint[]) group by 1`, [ids])).rows;
      const counter = COUNTER[g.txn_type] ?? 'INVENTORY_ADJ';
      const lines: Line[] = [];
      for (const v of val) {
        const amt = r2(Number(v.v));
        if (!amt) continue;
        const inv = INV_KEY[v.item_type] ?? 'INV_OTHER';
        lines.push(amt > 0 ? { key: inv, debit: amt } : { key: inv, credit: -amt });
        lines.push(amt > 0 ? { key: counter, credit: amt } : { key: counter, debit: -amt });
      }
      const ref = (await tx.query(`select coalesce(
          (select doc_no from purchase.goods_receipts where id = $1), (select doc_no from logistics.shipments where id = $1), (select batch_no from mfg.batches where id = $1),
          (select doc_no from mfg.production_orders where id = $1), (select doc_no from mfg.packing_runs where id = $1), (select doc_no from purchase.supplier_returns where id = $1),
          (select doc_no from sales.customer_returns where id = $1), (select lot_no from inv.lots where id = $1)) as ref`, [g.source_id])).rows[0]?.ref ?? null;
      const jid = await postJournal(tx, { le: g.le, date: g.d, sourceType: 'stock', sourceId: g.source_id, sourceEvent: `${g.source_type}|${g.txn_type}|${ids[0]}`, sourceRef: ref,
        narration: `Stock ${String(g.txn_type).toLowerCase().replace(/_/g, ' ')}${ref ? ` — ${ref}` : ''}`, lines });
      await tx.query(`insert into fin.stock_postings (stock_ledger_id, journal_id) select unnest($1::bigint[]), $2 on conflict do nothing`, [ids, jid]);
      return jid;
    });
  }
  return { posted, failed };
}

// ================================================================ routes
function scopeSql(req: Request, perm: string, col: string, args: unknown[]) {
  const scope = legalEntityScope(req, perm);
  if (!scope) return 'true';
  args.push(scope);
  return `${col} = any($${args.length}::uuid[])`;
}
const POSTED = `('Posted','Reversed')`;

export function ledgerRoutes(db: Db) {
  const r = Router();
  const V = 'finance.gl:view';
  const leParam = (req: Request) => {
    const le = str(req.query.legalEntityId);
    if (!le) throw Errors.validation({ legalEntityId: 'Required' });
    const s = legalEntityScope(req, V);
    if (s && !s.includes(le)) throw Errors.forbidden(V);
    return le;
  };

  r.post('/sync', requirePermission(V), asyncHandler(async (_req, res) => { res.json(await syncLedger(db)); }));

  // ---------------------------------------------------------------- chart of accounts
  r.get('/accounts', requirePermission(V), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select id, code, name, type, grp, system_key as "systemKey", party_ledger as "partyLedger", status from fin.accounts order by code`)).rows });
  }));
  r.post('/accounts', requirePermission('finance.coa:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ code: z.string().regex(/^[0-9]{4,6}$/), name: z.string().trim().min(2).max(120), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']), grp: z.string().trim().min(2).max(80),
      partyLedger: z.boolean().default(false) }), req.body);
    const out = await withTx(db, async (tx) => {
      if ((await tx.query(`select 1 from fin.accounts where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Account ${d.code} exists.`);
      const row = (await tx.query(`insert into fin.accounts (code, name, type, grp, party_ledger, created_by) values ($1,$2,$3,$4,$5,$6) returning id`, [d.code, d.name, d.type, d.grp, d.partyLedger, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'fin.account.created', entityType: 'fin.account', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));
  r.patch('/accounts/:id', requirePermission('finance.coa:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ name: z.string().trim().min(2).max(120).optional(), grp: z.string().trim().min(2).max(80).optional(), status: z.enum(['Active', 'Inactive']).optional() }), req.body);
    await withTx(db, async (tx) => {
      const a = (await tx.query(`select system_key from fin.accounts where id = $1`, [req.params.id])).rows[0];
      if (!a) throw Errors.notFound('Account');
      if (a.system_key && d.status === 'Inactive') throw Errors.rule('SYSTEM_ACCOUNT', 'Automatic postings use this account; it cannot be deactivated.');
      await tx.query(`update fin.accounts set name = coalesce($2, name), grp = coalesce($3, grp), status = coalesce($4, status) where id = $1`, [req.params.id, d.name ?? null, d.grp ?? null, d.status ?? null]);
      await audit(tx, actorOf(req), { action: 'fin.account.updated', entityType: 'fin.account', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- journals
  r.get('/journals', requirePermission(V), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, V, 'j.legal_entity_id', args)];
    for (const [k, col] of [['legalEntityId', 'j.legal_entity_id'], ['sourceType', 'j.source_type'], ['status', 'j.status']] as const) {
      const v = str(req.query[k]); if (v) { args.push(v); where.push(`${col} = $${args.length}`); }
    }
    const from = str(req.query.from); if (from) { args.push(from); where.push(`j.journal_date >= $${args.length}`); }
    const to = str(req.query.to); if (to) { args.push(to); where.push(`j.journal_date <= $${args.length}`); }
    const q = str(req.query.q); if (q) { args.push(`%${q}%`); where.push(`(j.doc_no ilike $${args.length} or j.source_ref ilike $${args.length} or j.narration ilike $${args.length})`); }
    const rows = (await db.query(`select j.id, j.doc_no as "docNo", j.journal_date as "journalDate", j.original_date as "originalDate", j.source_type as "sourceType", j.source_id as "sourceId", j.source_ref as "sourceRef",
        j.narration, j.status, (select sum(debit) from fin.journal_lines l where l.journal_id = j.id) as amount from fin.journals j where ${where.join(' and ')} order by j.journal_date desc, j.doc_no desc limit 500`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.get('/journals/:id', requirePermission(V), asyncHandler(async (req, res) => {
    const args: unknown[] = [req.params.id];
    const j = (await db.query(`select j.id, j.doc_no as "docNo", j.legal_entity_id as "legalEntityId", le.name as "legalEntityName", j.journal_date as "journalDate", j.original_date as "originalDate",
        j.source_type as "sourceType", j.source_id as "sourceId", j.source_event as "sourceEvent", j.source_ref as "sourceRef", j.narration, j.status, j.reversal_of as "reversalOf",
        j.created_at as "createdAt", cu.full_name as "createdBy", j.posted_at as "postedAt", pu.full_name as "postedBy"
        from fin.journals j join org.legal_entities le on le.id = j.legal_entity_id left join iam.users cu on cu.id = j.created_by left join iam.users pu on pu.id = j.posted_by
        where j.id = $1 and ${scopeSql(req, V, 'j.legal_entity_id', args)}`, args)).rows[0];
    if (!j) throw Errors.notFound('Journal');
    const lines = (await db.query(`select l.id, a.code, a.name as "accountName", l.account_id as "accountId", l.debit, l.credit, coalesce(p.legal_name, t.name) as party, l.narration
        from fin.journal_lines l join fin.accounts a on a.id = l.account_id left join mdm.parties p on p.id = l.party_id left join logistics.transporters t on t.id = l.transporter_id
        where l.journal_id = $1 order by l.debit desc, a.code`, [j.id])).rows;
    const reversedBy = (await db.query(`select id, doc_no as "docNo" from fin.journals where reversal_of = $1`, [j.id])).rows[0] ?? null;
    const allowed: string[] = [];
    if (j.sourceType === 'manual' && j.status === 'Draft' && can(req, 'finance.gl:post')) allowed.push('post');
    if (j.sourceType === 'manual' && j.status === 'Draft' && can(req, 'finance.gl:journal')) allowed.push('cancel');
    if (j.sourceType === 'manual' && j.status === 'Posted' && !j.reversalOf && can(req, 'finance.gl:post')) allowed.push('reverse');
    res.json({ ...j, lines, reversedBy, allowedActions: allowed });
  }));

  const jLine = z.object({ accountId: z.string().uuid(), debit: z.number().min(0).default(0), credit: z.number().min(0).default(0), partyId: z.string().uuid().optional().nullable(), narration: z.string().max(200).optional().nullable() })
    .refine((l) => (l.debit > 0) !== (l.credit > 0), { message: 'Each line is either a debit or a credit' });
  r.post('/journals', requirePermission('finance.gl:journal'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), date: day, narration: z.string().trim().min(5).max(500), lines: z.array(jLine).min(2).max(50) }), req.body);
    const out = await withTx(db, async (tx) => {
      const s = legalEntityScope(req, 'finance.gl:journal');
      if (s && !s.includes(d.legalEntityId)) throw Errors.forbidden('finance.gl:journal');
      const dr = r2(d.lines.reduce((a, l) => a + l.debit, 0)); const cr = r2(d.lines.reduce((a, l) => a + l.credit, 0));
      if (dr !== cr) throw Errors.rule('JOURNAL_NOT_BALANCED', `Debits ₹${dr} and credits ₹${cr} must be equal.`);
      for (const l of d.lines) {
        const a = (await tx.query(`select code, name, status, party_ledger from fin.accounts where id = $1`, [l.accountId])).rows[0];
        if (!a || a.status !== 'Active') throw Errors.rule('ACCOUNT_NOT_ACTIVE', 'Every line needs an active account.');
        if (a.party_ledger && !l.partyId) throw Errors.rule('PARTY_REQUIRED', `${a.code} ${a.name} is a party ledger: name the dealer or vendor.`);
      }
      const docNo = await nextDocNo(tx, 'JOURNAL', { date: new Date(`${d.date}T00:00:00Z`) });
      const j = (await tx.query(`insert into fin.journals (doc_no, legal_entity_id, journal_date, source_type, source_event, narration, status, created_by, updated_by) values ($1,$2,$3,'manual','manual',$4,'Draft',$5,$5) returning id`,
        [docNo, d.legalEntityId, d.date, d.narration, req.auth!.user.id])).rows[0];
      for (const l of d.lines) await tx.query(`insert into fin.journal_lines (journal_id, account_id, debit, credit, party_id, narration) values ($1,$2,$3,$4,$5,$6)`, [j.id, l.accountId, l.debit, l.credit, l.partyId ?? null, l.narration ?? null]);
      await audit(tx, actorOf(req), { action: 'fin.journal.drafted', entityType: 'fin.journal', entityId: j.id, after: { docNo, ...d } });
      return { id: j.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  // maker-checker: the person who drafted a manual journal cannot post it
  r.post('/journals/:id/post', requirePermission('finance.gl:post'), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const j = (await tx.query(`select id, doc_no, legal_entity_id, journal_date::text as d, status, source_type, created_by from fin.journals where id = $1 for update`, [req.params.id])).rows[0];
      if (!j || j.source_type !== 'manual') throw Errors.notFound('Journal');
      if (j.status !== 'Draft') throw Errors.state(`This journal is ${j.status.toLowerCase()}.`);
      if (j.created_by === req.auth!.user.id) throw Errors.rule('MAKER_CHECKER', 'Another person must post a journal you drafted.');
      await ensurePeriod(tx, j.legal_entity_id, j.d);
      if ((await tx.query(`select 1 from fin.periods where legal_entity_id = $1 and period_start = $2 and status = 'Locked'`, [j.legal_entity_id, monthStart(j.d)])).rowCount) throw Errors.rule('PERIOD_LOCKED', `${j.d} is in a locked period.`);
      await tx.query(`update fin.journals set status = 'Posted', posted_at = now(), posted_by = $2, updated_by = $2 where id = $1`, [j.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'fin.journal.posted', entityType: 'fin.journal', entityId: j.id, after: { docNo: j.doc_no } });
    });
    res.json({ ok: true });
  }));
  r.post('/journals/:id/cancel', requirePermission('finance.gl:journal'), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const j = (await tx.query(`select id, status, source_type from fin.journals where id = $1 for update`, [req.params.id])).rows[0];
      if (!j || j.source_type !== 'manual') throw Errors.notFound('Journal');
      if (j.status !== 'Draft') throw Errors.state('Only a draft journal can be cancelled; reverse a posted one.');
      await tx.query(`update fin.journals set status = 'Cancelled', updated_by = $2 where id = $1`, [j.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'fin.journal.cancelled', entityType: 'fin.journal', entityId: j.id });
    });
    res.json({ ok: true });
  }));
  r.post('/journals/:id/reverse', requirePermission('finance.gl:post'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ date: day, reason: z.string().trim().min(3).max(300) }), req.body);
    const out = await withTx(db, async (tx) => {
      const j = (await tx.query(`select id, doc_no, legal_entity_id, status, source_type, reversal_of from fin.journals where id = $1 for update`, [req.params.id])).rows[0];
      if (!j || j.source_type !== 'manual') throw Errors.notFound('Journal');
      if (j.status !== 'Posted' || j.reversal_of) throw Errors.state('Only a posted journal can be reversed, once.');
      const lines = (await tx.query(`select account_id, debit, credit, party_id from fin.journal_lines where journal_id = $1`, [j.id])).rows;
      const date = await postingDate(tx, j.legal_entity_id, d.date);
      const docNo = await nextDocNo(tx, 'JOURNAL', { date: new Date(`${date}T00:00:00Z`) });
      const rv = (await tx.query(`insert into fin.journals (doc_no, legal_entity_id, journal_date, source_type, source_event, narration, status, reversal_of, created_by, posted_at, posted_by, updated_by)
          values ($1,$2,$3,'manual','reversal',$4,'Posted',$5,$6,now(),$6,$6) returning id`, [docNo, j.legal_entity_id, date, `Reversal of ${j.doc_no}: ${d.reason}`, j.id, req.auth!.user.id])).rows[0];
      for (const l of lines) await tx.query(`insert into fin.journal_lines (journal_id, account_id, debit, credit, party_id) values ($1,$2,$3,$4,$5)`, [rv.id, l.account_id, Number(l.credit), Number(l.debit), l.party_id]);
      await tx.query(`update fin.journals set status = 'Reversed', updated_by = $2 where id = $1`, [j.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'fin.journal.reversed', entityType: 'fin.journal', entityId: j.id, after: { reversal: docNo }, reason: d.reason });
      return { id: rv.id as string, docNo };
    });
    res.json(out);
  }));

  // ---------------------------------------------------------------- periods (FIN-018)
  r.get('/periods', requirePermission(V), asyncHandler(async (req, res) => {
    const le = leParam(req);
    await withTx(db, (tx) => ensurePeriod(tx, le, todayIST()));
    const rows = (await db.query(`select p.id, p.period_start as "periodStart", p.period_end as "periodEnd", p.status, p.locked_at as "lockedAt", u.full_name as "lockedBy",
        (select count(*) from fin.journals j where j.legal_entity_id = p.legal_entity_id and j.status in ${POSTED} and j.journal_date between p.period_start and p.period_end)::int as journals
        from fin.periods p left join iam.users u on u.id = p.locked_by where p.legal_entity_id = $1 order by p.period_start desc`, [le])).rows;
    res.json({ data: rows });
  }));
  r.post('/periods/lock', requirePermission('finance.gl:lock'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), period: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    const start = `${d.period}-01`;
    if (start > monthStart(todayIST())) throw Errors.rule('FUTURE_PERIOD', 'A future period cannot be locked.');
    // everything dated in the period is posted before it closes
    const sync = await syncLedger(db);
    await withTx(db, async (tx) => {
      await ensurePeriod(tx, d.legalEntityId, start);
      if ((await tx.query(`select 1 from fin.periods where legal_entity_id = $1 and period_start < $2 and status = 'Open'
           and exists (select 1 from fin.journals j where j.legal_entity_id = $1 and j.journal_date between fin.periods.period_start and fin.periods.period_end)`, [d.legalEntityId, start])).rowCount)
        throw Errors.rule('EARLIER_PERIOD_OPEN', 'Lock the earlier periods first.');
      if ((await tx.query(`select 1 from fin.journals where legal_entity_id = $1 and status = 'Draft' and journal_date between $2 and $3`, [d.legalEntityId, start, monthEnd(start)])).rowCount)
        throw Errors.rule('DRAFT_JOURNALS', 'Post or cancel the draft journals of this period first.');
      await tx.query(`update fin.periods set status = 'Locked', locked_at = now(), locked_by = $3 where legal_entity_id = $1 and period_start = $2`, [d.legalEntityId, start, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'fin.period.locked', entityType: 'fin.period', entityId: d.legalEntityId, after: { period: d.period } });
    });
    res.json({ ok: true, posted: sync.posted, failed: sync.failed });
  }));
  r.post('/periods/unlock', requirePermission('finance.gl:unlock'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), period: z.string().regex(/^\d{4}-\d{2}$/), reason: z.string().trim().min(5).max(300) }), req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`update fin.periods set status = 'Open', locked_at = null, locked_by = null where legal_entity_id = $1 and period_start = $2 and status = 'Locked'`, [d.legalEntityId, `${d.period}-01`])).rowCount;
      if (!n) throw Errors.state('That period is not locked.');
      await audit(tx, actorOf(req), { action: 'fin.period.unlocked', entityType: 'fin.period', entityId: d.legalEntityId, after: { period: d.period }, reason: d.reason });
    });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- reports (FIN-016, FIN-017, FIN-019)
  const balances = async (le: string, from: string | null, to: string) => (await db.query(`
      select a.id, a.code, a.name, a.type, a.grp,
        coalesce(sum(l.debit) filter (where $2::date is not null and j.journal_date < $2::date), 0) as "openingDr",
        coalesce(sum(l.credit) filter (where $2::date is not null and j.journal_date < $2::date), 0) as "openingCr",
        coalesce(sum(l.debit) filter (where ($2::date is null or j.journal_date >= $2::date)), 0) as "periodDr",
        coalesce(sum(l.credit) filter (where ($2::date is null or j.journal_date >= $2::date)), 0) as "periodCr"
      from fin.accounts a left join fin.journal_lines l on l.account_id = a.id
        left join fin.journals j on j.id = l.journal_id and j.legal_entity_id = $1 and j.status in ${POSTED} and j.journal_date <= $3::date
      where j.id is not null or l.id is null group by a.id order by a.code`, [le, from, to])).rows
    .map((x) => ({ ...x, openingDr: Number(x.openingDr), openingCr: Number(x.openingCr), periodDr: Number(x.periodDr), periodCr: Number(x.periodCr) }));

  r.get('/trial-balance', requirePermission(V), asyncHandler(async (req, res) => {
    const le = leParam(req);
    await syncLedger(db);
    const from = str(req.query.from) ?? null; const to = str(req.query.to) ?? todayIST();
    const rows = (await balances(le, from, to)).map((x) => {
      const opening = r2(x.openingDr - x.openingCr); const closing = r2(opening + x.periodDr - x.periodCr);
      return { ...x, opening, closing, closingDr: closing > 0 ? closing : 0, closingCr: closing < 0 ? -closing : 0 };
    }).filter((x) => x.opening || x.periodDr || x.periodCr);
    const totals = { periodDr: r2(rows.reduce((a, x) => a + x.periodDr, 0)), periodCr: r2(rows.reduce((a, x) => a + x.periodCr, 0)),
      closingDr: r2(rows.reduce((a, x) => a + x.closingDr, 0)), closingCr: r2(rows.reduce((a, x) => a + x.closingCr, 0)) };
    res.json({ from, to, data: rows, totals, balanced: totals.closingDr === totals.closingCr });
  }));

  r.get('/ledger', requirePermission(V), asyncHandler(async (req, res) => {
    const le = leParam(req);
    const accountId = str(req.query.accountId);
    if (!accountId) throw Errors.validation({ accountId: 'Required' });
    await syncLedger(db);
    const from = str(req.query.from) ?? `${todayIST().slice(0, 4)}-04-01`; const to = str(req.query.to) ?? todayIST();
    const party = str(req.query.partyId) ?? null;
    const acc = (await db.query(`select id, code, name, type, party_ledger as "partyLedger" from fin.accounts where id = $1`, [accountId])).rows[0];
    if (!acc) throw Errors.notFound('Account');
    const opening = Number((await db.query(`select coalesce(sum(l.debit - l.credit), 0) as v from fin.journal_lines l join fin.journals j on j.id = l.journal_id
        where l.account_id = $1 and j.legal_entity_id = $2 and j.status in ${POSTED} and j.journal_date < $3 and ($4::uuid is null or l.party_id = $4 or l.transporter_id = $4)`, [accountId, le, from, party])).rows[0].v);
    const entries = (await db.query(`select j.id as "journalId", j.doc_no as "docNo", j.journal_date as date, j.source_type as "sourceType", j.source_id as "sourceId", j.source_ref as "sourceRef", j.narration,
        l.debit, l.credit, coalesce(p.legal_name, t.name) as party
        from fin.journal_lines l join fin.journals j on j.id = l.journal_id left join mdm.parties p on p.id = l.party_id left join logistics.transporters t on t.id = l.transporter_id
        where l.account_id = $1 and j.legal_entity_id = $2 and j.status in ${POSTED} and j.journal_date between $3 and $4 and ($5::uuid is null or l.party_id = $5 or l.transporter_id = $5)
        order by j.journal_date, j.created_at, j.doc_no`, [accountId, le, from, to, party])).rows;
    let bal = r2(opening);
    const lines = entries.map((e) => { bal = r2(bal + Number(e.debit) - Number(e.credit)); return { ...e, debit: Number(e.debit), credit: Number(e.credit), balance: bal }; });
    res.json({ account: acc, from, to, opening: r2(opening), closing: bal, lines });
  }));

  r.get('/profit-and-loss', requirePermission(V), asyncHandler(async (req, res) => {
    const le = leParam(req);
    await syncLedger(db);
    const from = str(req.query.from) ?? `${todayIST().slice(0, 4)}-04-01`; const to = str(req.query.to) ?? todayIST();
    const rows = (await balances(le, from, to)).filter((x) => ['INCOME', 'EXPENSE'].includes(x.type))
      .map((x) => ({ code: x.code, name: x.name, type: x.type, grp: x.grp, amount: r2(x.type === 'INCOME' ? x.periodCr - x.periodDr : x.periodDr - x.periodCr) })).filter((x) => x.amount);
    const income = r2(rows.filter((x) => x.type === 'INCOME').reduce((a, x) => a + x.amount, 0));
    const expense = r2(rows.filter((x) => x.type === 'EXPENSE').reduce((a, x) => a + x.amount, 0));
    res.json({ from, to, income: rows.filter((x) => x.type === 'INCOME'), expenses: rows.filter((x) => x.type === 'EXPENSE'), totalIncome: income, totalExpenses: expense, netProfit: r2(income - expense) });
  }));

  r.get('/balance-sheet', requirePermission(V), asyncHandler(async (req, res) => {
    const le = leParam(req);
    await syncLedger(db);
    const asOf = str(req.query.asOf) ?? todayIST();
    const all = await balances(le, null, asOf);
    const bal = (x: (typeof all)[number]) => r2(x.periodDr - x.periodCr);
    const assets = all.filter((x) => x.type === 'ASSET').map((x) => ({ code: x.code, name: x.name, grp: x.grp, amount: bal(x) })).filter((x) => x.amount);
    const liabilities = all.filter((x) => x.type === 'LIABILITY').map((x) => ({ code: x.code, name: x.name, grp: x.grp, amount: -bal(x) })).filter((x) => x.amount);
    const equity = all.filter((x) => x.type === 'EQUITY').map((x) => ({ code: x.code, name: x.name, grp: x.grp, amount: -bal(x) })).filter((x) => x.amount);
    const profit = r2(-all.filter((x) => ['INCOME', 'EXPENSE'].includes(x.type)).reduce((a, x) => a + bal(x), 0));
    const totalAssets = r2(assets.reduce((a, x) => a + x.amount, 0));
    const totalLiabEq = r2(liabilities.reduce((a, x) => a + x.amount, 0) + equity.reduce((a, x) => a + x.amount, 0) + profit);
    res.json({ asOf, assets, liabilities, equity, profit, totalAssets, totalLiabilitiesAndEquity: totalLiabEq, balanced: totalAssets === totalLiabEq });
  }));

  // GSTR-1 (outward supplies) and a GSTR-3B style summary for a month (FIN-019). Filing goes through the GSP in Stage 7.
  r.get('/gst', requirePermission('finance.gst:view'), asyncHandler(async (req, res) => {
    const le = leParam(req);
    const month = str(req.query.month) ?? todayIST().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw Errors.validation({ month: 'YYYY-MM' });
    await syncLedger(db);
    const from = `${month}-01`; const to = monthEnd(from);
    const b2b = (await db.query(`select i.id, i.doc_no as "docNo", i.invoice_date as "invoiceDate", i.party_gstin as gstin, p.legal_name as "partyName", i.place_of_supply as "placeOfSupply",
        i.taxable_total as taxable, i.cgst_total as cgst, i.sgst_total as sgst, i.igst_total as igst, i.grand_total as total from sales.invoices i join mdm.parties p on p.id = i.party_id
        where i.legal_entity_id = $1 and i.status = 'Posted' and i.invoice_date between $2 and $3 and i.party_gstin is not null order by i.doc_no`, [le, from, to])).rows;
    const b2c = (await db.query(`select i.place_of_supply as "placeOfSupply", l.gst_rate as "gstRate", sum(l.taxable) as taxable, sum(l.cgst) as cgst, sum(l.sgst) as sgst, sum(l.igst) as igst
        from sales.invoices i join sales.invoice_lines l on l.invoice_id = i.id where i.legal_entity_id = $1 and i.status = 'Posted' and i.invoice_date between $2 and $3 and i.party_gstin is null
        group by 1, 2 order by 1, 2`, [le, from, to])).rows;
    const cdn = (await db.query(`select c.id, c.doc_no as "docNo", c.note_date as "noteDate", i.doc_no as "invoiceNo", i.party_gstin as gstin, p.legal_name as "partyName", c.reason,
        c.taxable_total as taxable, c.cgst_total as cgst, c.sgst_total as sgst, c.igst_total as igst, c.grand_total as total from sales.credit_notes c join sales.invoices i on i.id = c.invoice_id
        join mdm.parties p on p.id = c.party_id where c.legal_entity_id = $1 and c.status = 'Approved' and c.note_date between $2 and $3 order by c.doc_no`, [le, from, to])).rows;
    const hsn = (await db.query(`select l.hsn_code as "hsnCode", l.gst_rate as "gstRate", sum(l.qty) as qty, sum(l.taxable) as taxable, sum(l.cgst) as cgst, sum(l.sgst) as sgst, sum(l.igst) as igst
        from sales.invoices i join sales.invoice_lines l on l.invoice_id = i.id where i.legal_entity_id = $1 and i.status = 'Posted' and i.invoice_date between $2 and $3 group by 1, 2 order by 1, 2`, [le, from, to])).rows;
    const cancelled = (await db.query(`select doc_no as "docNo", invoice_date as "invoiceDate" from sales.invoices where legal_entity_id = $1 and status = 'Cancelled' and invoice_date between $2 and $3 order by doc_no`, [le, from, to])).rows;
    // 3B from the ledger: tax accounts' movement in the month
    const mv = (await db.query(`select a.system_key as k, coalesce(sum(l.credit - l.debit), 0) as cr from fin.accounts a join fin.journal_lines l on l.account_id = a.id join fin.journals j on j.id = l.journal_id
        where j.legal_entity_id = $1 and j.status in ${POSTED} and j.journal_date between $2 and $3 and a.system_key in ('OUTPUT_CGST','OUTPUT_SGST','OUTPUT_IGST','RCM_PAYABLE','INPUT_CGST','INPUT_SGST','INPUT_IGST','INPUT_GST_RCM','INPUT_GST_OTHER')
        group by 1`, [le, from, to])).rows;
    const v = (k: string) => r2(Number(mv.find((x) => x.k === k)?.cr ?? 0));
    const output = { cgst: v('OUTPUT_CGST'), sgst: v('OUTPUT_SGST'), igst: v('OUTPUT_IGST'), rcm: v('RCM_PAYABLE') };
    const itc = { cgst: -v('INPUT_CGST'), sgst: -v('INPUT_SGST'), igst: -v('INPUT_IGST'), rcm: -v('INPUT_GST_RCM'), other: -v('INPUT_GST_OTHER') };
    const outward = r2(b2b.reduce((a, x) => a + Number(x.taxable), 0) + b2c.reduce((a, x) => a + Number(x.taxable), 0) - cdn.reduce((a, x) => a + Number(x.taxable), 0));
    res.json({ month, from, to, gstr1: { b2b, b2c, cdn, hsn, cancelled }, gstr3b: { outwardTaxable: outward, output, itc,
      totalOutput: r2(output.cgst + output.sgst + output.igst + output.rcm), totalItc: r2(itc.cgst + itc.sgst + itc.igst + itc.rcm + itc.other) } });
  }));
  return r;
}

/** Background posting from the worker loop: everything business-dated is posted within a minute. */
export function startLedgerSync(db: Db, intervalMs = 60_000, onError: (e: unknown) => void = console.error) {
  const t = setInterval(() => { syncLedger(db).catch(onError); }, intervalMs);
  return () => clearInterval(t);
}
