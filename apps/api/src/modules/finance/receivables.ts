import { Router, type Request } from 'express';
import { z } from 'zod';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';

/**
 * Receivables (BRD p.7, p.19; MP §17; FIN-005…FIN-008; D18).
 * Receipts are allocated to invoices (oldest due first unless accounts choose); what is not allocated stays on account. A bounced cheque or a
 * cancelled receipt reverses its allocations, so the invoices fall due again. Exposure and the overdue freeze feed the sales-order credit check.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const opt = (n: number) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface Exposure {
  creditLimit: number; creditDays: number; advancePayment: boolean;
  outstanding: number; overdue: number; uninvoicedOrders: number; onAccount: number; exposure: number; headroom: number;
  frozen: boolean; overdueInvoices: { id: string; docNo: string; dueDate: string; outstanding: number; daysOverdue: number }[];
}

/**
 * D18 exposure (doc 04 §4.10) = unpaid invoices + order value not yet invoiced (submitted, approved or closed orders) − unapplied receipts.
 * `frozen` is the BRD rule: an invoice unpaid beyond its credit days (plus the grace setting) freezes order-taking.
 */
export async function creditExposure(dbx: Db | Tx, partyId: string, excludeOrderId: string | null = null): Promise<Exposure> {
  const d = (await dbx.query(`select credit_limit, credit_days from mdm.dealer_profiles where party_id = $1`, [partyId])).rows[0] ?? { credit_limit: 0, credit_days: 0 };
  const today = todayIST();
  const grace = Number(await getSetting(dbx, 'sales.credit.overdueGraceDays', 0));
  const freezeOn = (await getSetting(dbx, 'sales.credit.overdueFreeze', true)) === true;
  const inv = (await dbx.query(`select id, doc_no, due_date::text as due, grand_total - amount_settled as o from sales.invoices where party_id = $1 and status = 'Posted' and grand_total - amount_settled > 0.004`, [partyId])).rows;
  const outstanding = r2(inv.reduce((a, x) => a + Number(x.o), 0));
  const overdueInvoices = inv.filter((x) => x.due < today).map((x) => ({ id: x.id as string, docNo: x.doc_no as string, dueDate: x.due as string, outstanding: Number(x.o), daysOverdue: daysBetween(x.due, today) }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const overdue = r2(overdueInvoices.reduce((a, x) => a + x.outstanding, 0));
  const uninvoicedOrders = Number((await dbx.query(`select coalesce(sum(greatest(so.grand_total - coalesce((select sum(i.grand_total) from sales.invoices i where i.sales_order_id = so.id and i.status = 'Posted'), 0), 0)), 0) as v
      from sales.sales_orders so where so.party_id = $1 and so.status in ('Submitted','Approved','Closed') and so.id is distinct from $2`, [partyId, excludeOrderId])).rows[0].v);
  const onAccount = Number((await dbx.query(`select coalesce(sum(amount - allocated), 0) as v from fin.receipts where party_id = $1 and status = 'Posted'`, [partyId])).rows[0].v);
  const limit = Number(d.credit_limit);
  const exposure = r2(outstanding + uninvoicedOrders - onAccount);
  return { creditLimit: limit, creditDays: Number(d.credit_days), advancePayment: limit === 0 && Number(d.credit_days) === 0, outstanding, overdue, uninvoicedOrders: r2(uninvoicedOrders), onAccount: r2(onAccount),
    exposure, headroom: r2(limit - exposure), frozen: freezeOn && overdueInvoices.some((x) => x.daysOverdue > grace), overdueInvoices };
}

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null) {
  await allowTransition(tx);
  await tx.query(`update fin.receipts set status = $2, status_reason = $3, updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: 'fin.receipt.status', entityType: 'fin.receipt', entityId: id, after: { status }, reason });
  await emit(tx, 'fin.receipt', id, `fin.receipt.${status.toLowerCase()}`);
}

/** Allocates part of a receipt to invoices: the given split, or oldest due first. Returns what was allocated. */
async function allocate(tx: Tx, actor: Actor, receiptId: string, split: { invoiceId: string; amount: number }[] | 'auto') {
  const rc = (await tx.query(`select id, doc_no, party_id, legal_entity_id, amount, allocated, status from fin.receipts where id = $1 for update`, [receiptId])).rows[0];
  if (rc.status !== 'Posted') throw Errors.state(`A ${rc.status.toLowerCase()} receipt cannot be allocated.`);
  let free = r2(Number(rc.amount) - Number(rc.allocated));
  const open = (await tx.query(`select id, doc_no, grand_total - amount_settled as o from sales.invoices where party_id = $1 and legal_entity_id = $2 and status = 'Posted'
      and grand_total - amount_settled > 0.004 order by due_date, invoice_date, doc_no for update`, [rc.party_id, rc.legal_entity_id])).rows;
  const plan = split === 'auto'
    ? open.map((i) => { const a = r2(Math.min(free, Number(i.o))); free = r2(free - a); return { invoiceId: i.id as string, amount: a }; }).filter((x) => x.amount > 0)
    : split;
  if (split !== 'auto') {
    const total = r2(split.reduce((a, x) => a + x.amount, 0));
    if (total > free + 0.004) throw Errors.rule('OVER_ALLOCATED', `Only ₹${free} of this receipt is unallocated.`);
    for (const x of split) {
      const i = open.find((y) => y.id === x.invoiceId);
      if (!i) throw Errors.rule('INVOICE_NOT_OPEN', 'An invoice is not an open invoice of this dealer and entity.');
      if (x.amount > Number(i.o) + 0.004) throw Errors.rule('OVER_ALLOCATED', `${i.doc_no} has only ₹${Number(i.o)} outstanding.`);
    }
  }
  for (const x of plan) {
    await tx.query(`insert into fin.receipt_allocations (receipt_id, invoice_id, amount, allocated_by) values ($1,$2,$3,$4)`, [rc.id, x.invoiceId, x.amount, actor.userId]);
    await tx.query(`update sales.invoices set amount_settled = amount_settled + $2, updated_by = $3 where id = $1`, [x.invoiceId, x.amount, actor.userId]);
  }
  const sum = r2(plan.reduce((a, x) => a + x.amount, 0));
  if (sum > 0) {
    await tx.query(`update fin.receipts set allocated = allocated + $2, updated_by = $3 where id = $1`, [rc.id, sum, actor.userId]);
    await audit(tx, actor, { action: 'fin.receipt.allocated', entityType: 'fin.receipt', entityId: rc.id, after: { allocations: plan } });
  }
  return { allocated: sum, plan };
}

async function reverseAllocations(tx: Tx, actor: Actor, receiptId: string, reason: string, onlyId: string | null = null) {
  const al = (await tx.query(`update fin.receipt_allocations set status = 'Reversed', reversed_at = now(), reversed_by = $3, reversal_reason = $4
      where receipt_id = $1 and status = 'Active' and ($2::uuid is null or id = $2) returning invoice_id, amount`, [receiptId, onlyId, actor.userId, reason])).rows;
  for (const a of al) await tx.query(`update sales.invoices set amount_settled = amount_settled - $2, updated_by = $3 where id = $1`, [a.invoice_id, Number(a.amount), actor.userId]);
  const sum = r2(al.reduce((a, x) => a + Number(x.amount), 0));
  if (sum) await tx.query(`update fin.receipts set allocated = allocated - $2, updated_by = $3 where id = $1`, [receiptId, sum, actor.userId]);
  return sum;
}

const sel = `select r.id, r.doc_no as "docNo", r.legal_entity_id as "legalEntityId", le.name as "legalEntityName", r.party_id as "partyId", p.legal_name as "partyName", p.code as "partyCode",
    r.receipt_date as "receiptDate", r.mode, r.reference, r.instrument_date as "instrumentDate", r.drawee_bank as "draweeBank", r.deposit_account as "depositAccount", r.amount, r.allocated,
    r.amount - r.allocated as "onAccount", r.status, r.status_reason as "statusReason", r.bounced_on as "bouncedOn", r.remarks, r.created_at as "createdAt", cu.full_name as "createdBy", r.version
  from fin.receipts r join org.legal_entities le on le.id = r.legal_entity_id join mdm.parties p on p.id = r.party_id left join iam.users cu on cu.id = r.created_by`;

function scopeSql(req: Request, perm: string, col: string, args: unknown[]) {
  const scope = legalEntityScope(req, perm);
  if (!scope) return 'true';
  args.push(scope);
  return `${col} = any($${args.length}::uuid[])`;
}

export function receiptRoutes(db: Db) {
  const r = Router();
  const P = (a: string) => `finance.receipt:${a}`;

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, P('view'), 'r.legal_entity_id', args)];
    for (const [k, col] of [['status', 'r.status'], ['partyId', 'r.party_id']] as const) {
      const v = str(req.query[k]);
      if (v) { args.push(v); where.push(`${col} = $${args.length}`); }
    }
    if (req.query.unallocated === '1') where.push(`r.status = 'Posted' and r.amount > r.allocated`);
    const rows = (await db.query(`${sel} where ${where.join(' and ')} order by r.receipt_date desc, r.doc_no desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  // open invoices of a dealer in an entity, oldest due first — for entering and allocating receipts
  r.get('/open-invoices', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const partyId = str(req.query.partyId);
    const le = str(req.query.legalEntityId);
    if (!partyId || !le) throw Errors.validation({ partyId: 'Required', legalEntityId: 'Required' });
    const rows = (await db.query(`select id, doc_no as "docNo", invoice_date as "invoiceDate", due_date as "dueDate", grand_total as "grandTotal", grand_total - amount_settled as outstanding,
        greatest(($3::date - due_date), 0) as "daysOverdue" from sales.invoices where party_id = $1 and legal_entity_id = $2 and status = 'Posted' and grand_total - amount_settled > 0.004
        order by due_date, invoice_date, doc_no`, [partyId, le, todayIST()])).rows;
    res.json({ data: rows });
  }));

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const x = (await dbx.query(`${sel} where r.id = $1 and ${scopeSql(req, P('view'), 'r.legal_entity_id', args)} ${lock ? 'for update of r' : ''}`, args)).rows[0];
    if (!x) throw Errors.notFound('Receipt');
    return x;
  }
  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const x = await load(db, req, req.params.id!);
    const allocations = (await db.query(`select a.id, a.invoice_id as "invoiceId", i.doc_no as "invoiceNo", i.invoice_date as "invoiceDate", a.amount, a.status, a.allocated_at as "allocatedAt",
        au.full_name as "allocatedBy", a.reversed_at as "reversedAt", a.reversal_reason as "reversalReason" from fin.receipt_allocations a join sales.invoices i on i.id = a.invoice_id
        left join iam.users au on au.id = a.allocated_by where a.receipt_id = $1 order by a.allocated_at`, [x.id])).rows;
    const allowed: string[] = [];
    if (x.status === 'Posted' && Number(x.onAccount) > 0 && can(req, P('allocate'))) allowed.push('allocate');
    if (x.status === 'Posted' && allocations.some((a) => a.status === 'Active') && can(req, P('allocate'))) allowed.push('unallocate');
    if (x.status === 'Posted' && ['CHEQUE', 'DD'].includes(x.mode) && can(req, P('bounce'))) allowed.push('bounce');
    if (x.status === 'Posted' && can(req, P('cancel'))) allowed.push('cancel');
    res.json({ ...x, allocations, allowedActions: allowed });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), partyId: z.string().uuid(), receiptDate: day, mode: z.enum(['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD', 'CASH']),
      reference: opt(40), instrumentDate: day.optional().nullable(), draweeBank: opt(80), depositAccount: opt(80), amount: z.number().positive().max(1e11), remarks: opt(500),
      allocation: z.union([z.literal('auto'), z.literal('none'), z.array(z.object({ invoiceId: z.string().uuid(), amount: z.number().positive() })).max(100)]).default('auto') })
      .refine((x) => x.mode === 'CASH' || !!x.reference, { message: 'Give the UTR, cheque or DD number', path: ['reference'] })
      .refine((x) => !['CHEQUE', 'DD'].includes(x.mode) || !!x.instrumentDate, { message: 'Give the cheque or DD date', path: ['instrumentDate'] }), req.body);
    const out = await withTx(db, async (tx) => {
      const scope = legalEntityScope(req, P('create'));
      if (scope && !scope.includes(d.legalEntityId)) throw Errors.forbidden(P('create'));
      if (d.receiptDate > todayIST()) throw Errors.rule('INVALID_DATE', 'The receipt date cannot be in the future.');
      if (!(await tx.query(`select 1 from mdm.dealer_profiles where party_id = $1`, [d.partyId])).rowCount) throw Errors.rule('NOT_A_DEALER', 'Receipts are recorded against dealers.');
      if (d.mode === 'CASH') {
        const limit = Number(await getSetting(tx, 'finance.receipt.cashLimitPerDay', 199999));
        const already = Number((await tx.query(`select coalesce(sum(amount), 0) as v from fin.receipts where party_id = $1 and mode = 'CASH' and receipt_date = $2 and status <> 'Cancelled'`, [d.partyId, d.receiptDate])).rows[0].v);
        if (already + d.amount > limit) throw Errors.rule('CASH_LIMIT', `Cash from one dealer in a day must stay within ₹${limit} (s.269ST); ₹${already} already received.`);
      }
      if (d.reference && (await tx.query(`select 1 from fin.receipts where legal_entity_id = $1 and party_id = $2 and mode = $3 and reference = $4 and status <> 'Cancelled'`,
        [d.legalEntityId, d.partyId, d.mode, d.reference])).rowCount) throw Errors.conflict('DUPLICATE_RECEIPT', `${d.mode} ${d.reference} is already recorded for this dealer.`);
      const docNo = await nextDocNo(tx, 'RECEIPT');
      const rc = (await tx.query(`insert into fin.receipts (doc_no, legal_entity_id, party_id, receipt_date, mode, reference, instrument_date, drawee_bank, deposit_account, amount, remarks, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning id`,
        [docNo, d.legalEntityId, d.partyId, d.receiptDate, d.mode, d.reference, d.instrumentDate ?? null, d.draweeBank, d.depositAccount, d.amount, d.remarks, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'fin.receipt.posted', entityType: 'fin.receipt', entityId: rc.id, after: { docNo, ...d } });
      await emit(tx, 'fin.receipt', rc.id, 'fin.receipt.posted');
      const a = d.allocation === 'none' ? { allocated: 0 } : await allocate(tx, actorOf(req), rc.id, d.allocation);
      return { id: rc.id as string, docNo, allocated: a.allocated, onAccount: r2(d.amount - a.allocated) };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/allocate', requirePermission(P('allocate')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ allocation: z.union([z.literal('auto'), z.array(z.object({ invoiceId: z.string().uuid(), amount: z.number().positive() })).min(1).max(100)]) }), req.body);
    const out = await withTx(db, async (tx) => { await load(tx, req, req.params.id!); return allocate(tx, actorOf(req), req.params.id!, d.allocation); });
    res.json(out);
  }));

  r.post('/:id/allocations/:aid/reverse', requirePermission(P('allocate')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (x.status !== 'Posted') throw Errors.state(`This receipt is ${x.status.toLowerCase()}.`);
      if (!(await reverseAllocations(tx, actorOf(req), x.id, reason, req.params.aid!))) throw Errors.notFound('Allocation');
      await audit(tx, actorOf(req), { action: 'fin.receipt.unallocated', entityType: 'fin.receipt', entityId: x.id, after: { allocation: req.params.aid }, reason });
    });
    res.json({ ok: true });
  }));

  // FIN-007: a dishonoured cheque or DD: its allocations are reversed and the invoices fall due again
  r.post('/:id/bounce', requirePermission(P('bounce')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ bouncedOn: day, reason: text(300) }), req.body);
    await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (x.status !== 'Posted') throw Errors.state(`This receipt is ${x.status.toLowerCase()}.`);
      if (!['CHEQUE', 'DD'].includes(x.mode)) throw Errors.rule('NOT_AN_INSTRUMENT', 'Only a cheque or DD can bounce; cancel a wrong electronic entry instead.');
      if (d.bouncedOn < x.receiptDate || d.bouncedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'The bounce date must be between the receipt date and today.');
      await reverseAllocations(tx, actorOf(req), x.id, `Bounced: ${d.reason}`);
      await tx.query(`update fin.receipts set bounced_on = $2 where id = $1`, [x.id, d.bouncedOn]);
      await setStatus(tx, actorOf(req), x.id, 'Bounced', d.reason);
    });
    res.json({ ok: true });
  }));

  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (x.status !== 'Posted') throw Errors.state(`This receipt is ${x.status.toLowerCase()}.`);
      await reverseAllocations(tx, actorOf(req), x.id, `Receipt cancelled: ${reason}`);
      await setStatus(tx, actorOf(req), x.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));
  return r;
}

// ================================================================ ageing, statement and credit (FIN-005, FIN-008)
export function receivableRoutes(db: Db) {
  const r = Router();
  const V = 'finance.receivable:view';
  const BUCKETS = [['notDue', null, 0], ['d1to30', 1, 30], ['d31to60', 31, 60], ['d61to90', 61, 90], ['d91to180', 91, 180], ['over180', 181, null]] as const;

  r.get('/ageing', requirePermission(V), asyncHandler(async (req, res) => {
    const asOf = str(req.query.asOf) ?? todayIST();
    const args: unknown[] = [asOf];
    const scope = scopeSql(req, V, 'i.legal_entity_id', args);
    const rows = (await db.query(`select i.party_id as "partyId", p.code as "partyCode", p.legal_name as "partyName", t.name as territory, coalesce(dp.credit_limit, 0) as "creditLimit",
        coalesce(dp.credit_days, 0) as "creditDays", ($1::date - i.due_date) as days, i.grand_total - i.amount_settled as o
        from sales.invoices i join mdm.parties p on p.id = i.party_id left join mdm.dealer_profiles dp on dp.party_id = i.party_id left join org.territories t on t.id = dp.territory_id
        where i.status = 'Posted' and i.grand_total - i.amount_settled > 0.004 and i.invoice_date <= $1 and ${scope}`, args)).rows;
    const byParty = new Map<string, Record<string, unknown> & { total: number; overdue: number }>();
    for (const x of rows) {
      const row = byParty.get(x.partyId) ?? { partyId: x.partyId, partyCode: x.partyCode, partyName: x.partyName, territory: x.territory, creditLimit: Number(x.creditLimit), creditDays: Number(x.creditDays),
        notDue: 0, d1to30: 0, d31to60: 0, d61to90: 0, d91to180: 0, over180: 0, total: 0, overdue: 0, oldestDays: 0 };
      const days = Number(x.days);
      const b = BUCKETS.find(([, lo, hi]) => (lo === null ? days <= 0 : days >= lo) && (hi === null || days <= hi))!;
      row[b[0]] = r2(Number(row[b[0]]) + Number(x.o));
      row.total = r2(row.total + Number(x.o));
      if (days > 0) { row.overdue = r2(row.overdue + Number(x.o)); row.oldestDays = Math.max(Number(row.oldestDays), days); }
      byParty.set(x.partyId, row);
    }
    const onAccArgs: unknown[] = [];
    const onAcc = (await db.query(`select r.party_id, sum(r.amount - r.allocated) as v from fin.receipts r where r.status = 'Posted' and r.amount > r.allocated and ${scopeSql(req, V, 'r.legal_entity_id', onAccArgs)} group by 1`, onAccArgs)).rows;
    const data = [...byParty.values()].map((x) => ({ ...x, onAccount: Number(onAcc.find((o) => o.party_id === x.partyId)?.v ?? 0) })).sort((a, b) => b.overdue - a.overdue || b.total - a.total);
    const totals = Object.fromEntries(['notDue', 'd1to30', 'd31to60', 'd61to90', 'd91to180', 'over180', 'total', 'overdue', 'onAccount'].map((k) => [k, r2(data.reduce((a, x) => a + Number((x as Record<string, unknown>)[k]), 0))]));
    const redAbove = Number(await getSetting(db, 'finance.overdueAlertValue', 1000000));
    res.json({ asOf, data, totals, overdueAlert: totals.overdue! > redAbove, overdueAlertValue: redAbove });
  }));

  // dealer statement: invoices and bounced cheques debit; approved credit notes and receipts credit; running balance
  r.get('/statement/:partyId', requirePermission(V), asyncHandler(async (req, res) => {
    const from = str(req.query.from) ?? `${todayIST().slice(0, 4)}-04-01`;
    const to = str(req.query.to) ?? todayIST();
    const args: unknown[] = [req.params.partyId];
    const scopeI = scopeSql(req, V, 'legal_entity_id', args);
    const party = (await db.query(`select p.id, p.code, p.legal_name as name, p.gstin, coalesce(dp.credit_limit, 0) as "creditLimit", coalesce(dp.credit_days, 0) as "creditDays"
        from mdm.parties p left join mdm.dealer_profiles dp on dp.party_id = p.id where p.id = $1`, [req.params.partyId])).rows[0];
    if (!party) throw Errors.notFound('Dealer');
    const entries = (await db.query(`
      select invoice_date as date, created_at as ts, 'Invoice' as kind, doc_no as ref, id, grand_total as debit, 0 as credit, 'Due ' || to_char(due_date, 'DD Mon YYYY') as note from sales.invoices where party_id = $1 and status = 'Posted' and ${scopeI}
      union all select c.note_date, coalesce(c.approved_at, c.created_at), 'Credit note', c.doc_no, c.id, 0, c.grand_total, 'Against ' || i.doc_no from sales.credit_notes c join sales.invoices i on i.id = c.invoice_id
        where c.party_id = $1 and c.status = 'Approved' and ${scopeI.replace('legal_entity_id', 'c.legal_entity_id')}
      union all select receipt_date, created_at, 'Receipt', doc_no, id, 0, amount, mode || coalesce(' ' || reference, '') from fin.receipts where party_id = $1 and status in ('Posted','Bounced') and ${scopeI}
      union all select bounced_on, updated_at, 'Cheque bounced', doc_no, id, amount, 0, coalesce(status_reason, '') from fin.receipts where party_id = $1 and status = 'Bounced' and ${scopeI}
      order by 1, 2, 4`, args)).rows;
    let opening = 0; let bal = 0;
    const lines = [];
    for (const e of entries) {
      const dt = new Date(e.date).toISOString().slice(0, 10);
      const delta = Number(e.debit) - Number(e.credit);
      if (dt < from) { opening = r2(opening + delta); continue; }
      if (dt > to) continue;
      if (!lines.length) bal = opening;
      bal = r2(bal + delta);
      lines.push({ date: dt, kind: e.kind, ref: e.ref, id: e.id, note: e.note, debit: Number(e.debit), credit: Number(e.credit), balance: bal });
    }
    const exposure = await creditExposure(db, party.id);
    res.json({ party, from, to, opening, closing: lines.length ? bal : opening, lines, exposure });
  }));

  r.get('/credit/:partyId', requirePermission(V), asyncHandler(async (req, res) => {
    res.json(await creditExposure(db, req.params.partyId!));
  }));
  return r;
}
