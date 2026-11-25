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
import { registerSubjectHandler, submitForApproval, withdrawOpenRequests } from '../workflow/engine';
import { computeTds } from './tds';

/**
 * Payables (BRD p.19; MP §17.4–17.6; FIN-009…FIN-012).
 * What we owe: supplier invoices that passed the three-way match (Matched, or Approved after an exception) and approved transporter freight bills.
 * Debit notes from supplier returns are adjusted against an invoice. A payment settles bills only when it is released with its UTR, after approval;
 * amounts on payments in flight are held so nothing is paid twice.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const opt = (n: number) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const PAYABLE_SI = `('Matched','Approved')`;
const IN_FLIGHT = `('Draft','Submitted','Approved')`;

function scopeSql(req: Request, perm: string, col: string, args: unknown[]) {
  const scope = legalEntityScope(req, perm);
  if (!scope) return 'true';
  args.push(scope);
  return `${col} = any($${args.length}::uuid[])`;
}
const inScope = (req: Request, perm: string, le: string) => { const s = legalEntityScope(req, perm); return !s || s.includes(le); };

/** Open payable documents of a payee in an entity: outstanding = total − settled − held on payments in flight (except `exceptPaymentId`). */
async function openDocs(dbx: Db | Tx, payee: { type: 'VENDOR' | 'TRANSPORTER'; id: string }, legalEntityId: string, exceptPaymentId: string | null = null) {
  if (payee.type === 'VENDOR') {
    return (await dbx.query(`select si.id, 'SUPPLIER_INVOICE' as kind, si.doc_no as "docNo", si.invoice_no as "billNo", si.invoice_date as "billDate", si.due_date as "dueDate", si.grand_total as total,
        si.amount_settled as settled, coalesce((select sum(pl.amount) from fin.payment_lines pl join fin.payments p on p.id = pl.payment_id where pl.supplier_invoice_id = si.id and p.status in ${IN_FLIGHT}
          and p.id is distinct from $3), 0) as held
        from purchase.supplier_invoices si left join purchase.purchase_orders po on po.id = si.purchase_order_id
       where si.party_id = $1 and coalesce(si.legal_entity_id, po.legal_entity_id) = $2 and si.status in ${PAYABLE_SI} order by si.due_date, si.invoice_date`, [payee.id, legalEntityId, exceptPaymentId])).rows
      .map((x) => ({ ...x, outstanding: r2(Number(x.total) - Number(x.settled) - Number(x.held)) })).filter((x) => x.outstanding > 0.004);
  }
  return (await dbx.query(`select fb.id, 'FREIGHT_BILL' as kind, fb.doc_no as "docNo", fb.bill_no as "billNo", fb.bill_date as "billDate", fb.due_date as "dueDate", fb.grand_total as total,
      fb.amount_settled as settled, coalesce((select sum(pl.amount) from fin.payment_lines pl join fin.payments p on p.id = pl.payment_id where pl.freight_bill_id = fb.id and p.status in ${IN_FLIGHT}
        and p.id is distinct from $3), 0) as held
      from logistics.freight_bills fb where fb.transporter_id = $1 and fb.legal_entity_id = $2 and fb.status = 'Approved' order by fb.due_date, fb.bill_date`, [payee.id, legalEntityId, exceptPaymentId])).rows
    .map((x) => ({ ...x, outstanding: r2(Number(x.total) - Number(x.settled) - Number(x.held)) })).filter((x) => x.outstanding > 0.004);
}

// ================================================================ freight bills (FIN-012)
export function freightBillRoutes(db: Db) {
  const SUBJECT = 'logistics.freight_bill';
  const P = (a: string) => `logistics.freight_bill:${a}`;
  async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
    await allowTransition(tx);
    await tx.query(`update logistics.freight_bills set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
    await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status }, reason });
    await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
  }
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Approved'),
    onRejected: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Rejected', 'Not approved'),
    onReturned: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Rejected', 'Returned — correct and enter it again'),
    onCancelled: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Cancelled'),
  });
  const r = Router();
  const sel = `select fb.id, fb.doc_no as "docNo", fb.transporter_id as "transporterId", t.name as "transporterName", t.gstin as "transporterGstin", fb.legal_entity_id as "legalEntityId",
      fb.bill_no as "billNo", fb.bill_date as "billDate", fb.due_date as "dueDate", fb.taxable_total as "taxableTotal", fb.gst_rate as "gstRate", fb.reverse_charge as "reverseCharge",
      fb.gst_amount as "gstAmount", fb.grand_total as "grandTotal", fb.amount_settled as "amountSettled", fb.grand_total - fb.amount_settled as outstanding, fb.variance, fb.status,
      fb.status_reason as "statusReason", fb.remarks, fb.created_at as "createdAt", cu.full_name as "createdBy"
    from logistics.freight_bills fb join logistics.transporters t on t.id = fb.transporter_id left join iam.users cu on cu.id = fb.created_by`;

  // shipments of a transporter whose freight we pay and that are not yet billed
  r.get('/billable', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const tr = str(req.query.transporterId);
    if (!tr) throw Errors.validation({ transporterId: 'Required' });
    const args: unknown[] = [tr];
    const rows = (await db.query(`select s.id, s.doc_no as "docNo", s.dispatched_at as "dispatchedAt", s.legal_entity_id as "legalEntityId", s.freight_terms as "freightTerms", s.freight_amount as "freightAmount",
        s.lr_no as "lrNo", p.legal_name as "partyName", a.city from logistics.shipments s join mdm.parties p on p.id = s.party_id join mdm.party_addresses a on a.id = s.ship_to_id
       where s.transporter_id = $1 and s.status in ('Dispatched','Delivered') and s.freight_terms in ('PAID','TBB') and ${scopeSql(req, P('create'), 's.legal_entity_id', args)}
         and not exists (select 1 from logistics.freight_bill_lines l join logistics.freight_bills b on b.id = l.freight_bill_id where l.shipment_id = s.id and b.status not in ('Cancelled','Rejected'))
       order by s.dispatched_at`, args)).rows;
    res.json({ data: rows });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, P('view'), 'fb.legal_entity_id', args)];
    const st = str(req.query.status);
    if (st) { args.push(st); where.push(`fb.status = $${args.length}`); }
    const rows = (await db.query(`${sel} where ${where.join(' and ')} order by fb.created_at desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [req.params.id];
    const fb = (await db.query(`${sel} where fb.id = $1 and ${scopeSql(req, P('view'), 'fb.legal_entity_id', args)}`, args)).rows[0];
    if (!fb) throw Errors.notFound('Freight bill');
    const lines = (await db.query(`select l.id, l.shipment_id as "shipmentId", s.doc_no as "shipmentNo", s.lr_no as "lrNo", s.dispatched_at as "dispatchedAt", p.legal_name as "partyName", l.amount, l.agreed
        from logistics.freight_bill_lines l join logistics.shipments s on s.id = l.shipment_id join mdm.parties p on p.id = s.party_id where l.freight_bill_id = $1 order by s.dispatched_at`, [fb.id])).rows;
    const approval = (await db.query(`select id, doc_no as "docNo", status from wf.approval_requests where subject_type = $1 and subject_id = $2 order by submitted_at desc limit 1`, [SUBJECT, fb.id])).rows[0] ?? null;
    res.json({ ...fb, lines, approval, allowedActions: ['Submitted', 'Rejected'].includes(fb.status) && can(req, P('create')) ? ['cancel'] : [] });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ transporterId: z.string().uuid(), legalEntityId: z.string().uuid(), billNo: text(40), billDate: day, dueDate: day, gstRate: z.number().min(0).max(28), reverseCharge: z.boolean(),
      remarks: opt(500), lines: z.array(z.object({ shipmentId: z.string().uuid(), amount: z.number().positive() })).min(1).max(200) })
      .refine((x) => x.dueDate >= x.billDate, { message: 'The due date cannot be before the bill date', path: ['dueDate'] }), req.body);
    const out = await withTx(db, async (tx) => {
      if (!inScope(req, P('create'), d.legalEntityId)) throw Errors.forbidden(P('create'));
      if (d.billDate > todayIST()) throw Errors.rule('INVALID_DATE', 'The bill date cannot be in the future.');
      if ((await tx.query(`select 1 from logistics.freight_bills where transporter_id = $1 and bill_no = $2 and status <> 'Cancelled'`, [d.transporterId, d.billNo])).rowCount) throw Errors.conflict('DUPLICATE_BILL', `Bill ${d.billNo} of this transporter is already entered.`);
      let agreed = 0;
      const lines = [];
      for (const l of d.lines) {
        const s = (await tx.query(`select id, doc_no, status, transporter_id, legal_entity_id, freight_terms, freight_amount from logistics.shipments where id = $1 for update`, [l.shipmentId])).rows[0];
        if (!s || s.transporter_id !== d.transporterId || s.legal_entity_id !== d.legalEntityId) throw Errors.rule('WRONG_SHIPMENT', 'A shipment was not carried by this transporter for this entity.');
        if (!['Dispatched', 'Delivered'].includes(s.status)) throw Errors.rule('NOT_DISPATCHED', `${s.doc_no} has not been dispatched.`);
        if (s.freight_terms === 'TO_PAY') throw Errors.rule('FREIGHT_TO_PAY', `${s.doc_no} went freight to-pay: the consignee pays the transporter.`);
        if ((await tx.query(`select 1 from logistics.freight_bill_lines l join logistics.freight_bills b on b.id = l.freight_bill_id where l.shipment_id = $1 and b.status not in ('Cancelled','Rejected')`, [s.id])).rowCount)
          throw Errors.conflict('ALREADY_BILLED', `${s.doc_no} is already on a freight bill.`);
        agreed += Number(s.freight_amount ?? 0);
        lines.push({ ...l, agreed: s.freight_amount === null ? null : Number(s.freight_amount) });
      }
      const taxable = r2(d.lines.reduce((a, l) => a + l.amount, 0));
      const gst = r2(taxable * d.gstRate / 100);
      const total = d.reverseCharge ? taxable : r2(taxable + gst);
      const variance = r2(taxable - agreed);
      const tol = Number(await getSetting(tx, 'logistics.freight.varianceTolerancePct', 5));
      const variancePct = agreed > 0 ? r2(variance / agreed * 100) : 100;
      const docNo = await nextDocNo(tx, 'FREIGHT_BILL');
      const fb = (await tx.query(`insert into logistics.freight_bills (doc_no, transporter_id, legal_entity_id, bill_no, bill_date, due_date, taxable_total, gst_rate, reverse_charge, gst_amount, grand_total, variance, remarks, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) returning id`,
        [docNo, d.transporterId, d.legalEntityId, d.billNo, d.billDate, d.dueDate, taxable, d.gstRate, d.reverseCharge, gst, total, variance, d.remarks, req.auth!.user.id])).rows[0];
      for (const l of lines) await tx.query(`insert into logistics.freight_bill_lines (freight_bill_id, shipment_id, amount, agreed) values ($1,$2,$3,$4)`, [fb.id, l.shipmentId, l.amount, l.agreed]);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.entered`, entityType: SUBJECT, entityId: fb.id, after: { docNo, ...d, variance } });
      const tr = (await tx.query(`select name from logistics.transporters where id = $1`, [d.transporterId])).rows[0];
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: fb.id, subjectLabel: `${docNo} — ${tr.name} bill ${d.billNo}`,
        facts: { amount: total, variancePct, overTolerance: variance > 0.004 && variancePct > tol }, legalEntityId: d.legalEntityId });
      return { id: fb.id as string, docNo, variance, approvalRequestId: ar.id as string, status: ar.status === 'Approved' ? 'Approved' : 'Submitted' };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/cancel', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const fb = (await tx.query(`select id, status, legal_entity_id from logistics.freight_bills where id = $1 for update`, [req.params.id])).rows[0];
      if (!fb || !inScope(req, P('create'), fb.legal_entity_id)) throw Errors.notFound('Freight bill');
      if (!['Submitted', 'Rejected'].includes(fb.status)) throw Errors.state(`A ${fb.status.toLowerCase()} freight bill cannot be cancelled.`);
      await withdrawOpenRequests(tx, SUBJECT, [fb.id]);
      await setStatus(tx, actorOf(req), fb.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));
  return r;
}

// ================================================================ payments (FIN-009, FIN-010)
/** The bank transfer has gone: record the UTR, settle the bills and mark the payment paid (from the payment screen or the bank's reply file). */
export async function releasePayment(tx: Tx, actor: Actor, id: string, reference: string, paidOn: string) {
  const x = (await tx.query(`select id, status from fin.payments where id = $1 for update`, [id])).rows[0];
  if (x?.status !== 'Approved') throw Errors.state('Only an approved payment can be released.');
  if (paidOn > todayIST()) throw Errors.rule('INVALID_DATE', 'The payment date cannot be in the future.');
  for (const l of (await tx.query(`select supplier_invoice_id, freight_bill_id, amount from fin.payment_lines where payment_id = $1`, [id])).rows) {
    if (l.supplier_invoice_id) await tx.query(`update purchase.supplier_invoices set amount_settled = amount_settled + $2 where id = $1`, [l.supplier_invoice_id, Number(l.amount)]);
    else await tx.query(`update logistics.freight_bills set amount_settled = amount_settled + $2 where id = $1`, [l.freight_bill_id, Number(l.amount)]);
  }
  await tx.query(`update fin.payments set reference = $2, paid_on = $3 where id = $1`, [id, reference, paidOn]);
  await allowTransition(tx);
  await tx.query(`update fin.payments set status = 'Paid', updated_by = $2 where id = $1`, [id, actor.userId]);
  await audit(tx, actor, { action: 'fin.payment.status', entityType: 'fin.payment', entityId: id, after: { status: 'Paid', reference } });
  await emit(tx, 'fin.payment', id, 'fin.payment.paid');
}

export function paymentRoutes(db: Db) {
  const SUBJECT = 'fin.payment';
  const P = (a: string) => `finance.payment:${a}`;
  async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
    await allowTransition(tx);
    await tx.query(`update fin.payments set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
    await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status }, reason });
    await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
  }
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Approved'),
    onRejected: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Rejected', 'Not approved'),
    onReturned: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Draft', 'Returned for changes'),
    onCancelled: (tx, rq, a) => setStatus(tx, a, rq.subject_id, 'Draft'),
  });
  const r = Router();
  const sel = `select p.id, p.doc_no as "docNo", p.legal_entity_id as "legalEntityId", le.name as "legalEntityName", p.payee_type as "payeeType", p.party_id as "partyId", p.transporter_id as "transporterId",
      coalesce(pt.legal_name, t.name) as "payeeName", coalesce(pt.code, t.code) as "payeeCode", p.payment_date as "paymentDate", p.mode, p.from_account as "fromAccount", p.amount,
      p.tds_section as "tdsSection", p.tds_amount as "tdsAmount", p.net_amount as "netAmount", p.reference, p.status, p.status_reason as "statusReason", p.paid_on as "paidOn", p.remarks,
      p.created_at as "createdAt", cu.full_name as "createdBy", p.version, p.tds_rate as "tdsRate", p.tds_base as "tdsBase", p.tds_basis as "tdsBasis",
      p.batch_id as "batchId", pb.doc_no as "batchNo", pb.status as "batchStatus", p.tds_challan_id as "tdsChallanId"
    from fin.payments p join org.legal_entities le on le.id = p.legal_entity_id left join mdm.parties pt on pt.id = p.party_id left join logistics.transporters t on t.id = p.transporter_id
    left join iam.users cu on cu.id = p.created_by left join fin.payment_batches pb on pb.id = p.batch_id`;

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const x = (await dbx.query(`${sel} where p.id = $1 and ${scopeSql(req, P('view'), 'p.legal_entity_id', args)} ${lock ? 'for update of p' : ''}`, args)).rows[0];
    if (!x) throw Errors.notFound('Payment');
    return x;
  }

  r.get('/payables', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const le = str(req.query.legalEntityId);
    const type = str(req.query.payeeType) as 'VENDOR' | 'TRANSPORTER' | undefined;
    const id = str(req.query.payeeId);
    if (!le || !id || !['VENDOR', 'TRANSPORTER'].includes(type ?? '')) throw Errors.validation({ legalEntityId: 'Required', payeeType: 'VENDOR or TRANSPORTER', payeeId: 'Required' });
    const docs = await openDocs(db, { type: type!, id }, le);
    const debitNotes = type === 'VENDOR' ? (await db.query(`select id, doc_no as "docNo", note_date as "noteDate", reason, grand_total as "grandTotal" from purchase.debit_notes where party_id = $1 and status = 'Open' order by note_date`, [id])).rows : [];
    const bank = type === 'VENDOR' ? (await db.query(`select bank_name as "bankName", ifsc, account_last4 as "accountLast4", verification from mdm.party_bank_accounts where party_id = $1 and status = 'Active'`, [id])).rows[0] ?? null : null;
    res.json({ data: docs, debitNotes, bank });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, P('view'), 'p.legal_entity_id', args)];
    const st = str(req.query.status);
    if (st) { args.push(st); where.push(`p.status = $${args.length}`); }
    const rows = (await db.query(`${sel} where ${where.join(' and ')} order by p.created_at desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const x = await load(db, req, req.params.id!);
    const lines = (await db.query(`select pl.id, pl.supplier_invoice_id as "supplierInvoiceId", pl.freight_bill_id as "freightBillId", coalesce(si.doc_no, fb.doc_no) as "docNo",
        coalesce(si.invoice_no, fb.bill_no) as "billNo", coalesce(si.due_date, fb.due_date) as "dueDate", coalesce(si.grand_total, fb.grand_total) as "billTotal", pl.amount
        from fin.payment_lines pl left join purchase.supplier_invoices si on si.id = pl.supplier_invoice_id left join logistics.freight_bills fb on fb.id = pl.freight_bill_id where pl.payment_id = $1`, [x.id])).rows;
    const approval = (await db.query(`select id, doc_no as "docNo", status from wf.approval_requests where subject_type = $1 and subject_id = $2 order by submitted_at desc limit 1`, [SUBJECT, x.id])).rows[0] ?? null;
    const bank = x.partyId ? (await db.query(`select bank_name as "bankName", ifsc, account_last4 as "accountLast4", verification from mdm.party_bank_accounts where party_id = $1 and status = 'Active'`, [x.partyId])).rows[0] ?? null : null;
    const allowed: string[] = [];
    if (x.status === 'Draft' && can(req, P('submit'))) allowed.push('submit');
    if (x.status === 'Approved' && can(req, P('release'))) allowed.push('release');
    if (['Draft', 'Rejected', 'Approved'].includes(x.status) && can(req, P('create'))) allowed.push('cancel');
    res.json({ ...x, lines, approval, bank, allowedActions: allowed });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), payeeType: z.enum(['VENDOR', 'TRANSPORTER']), payeeId: z.string().uuid(), paymentDate: day,
      mode: z.enum(['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE']), fromAccount: opt(80), tdsSection: z.string().regex(/^[0-9]{3}[A-Z]{0,2}$/).optional().nullable(), tdsAmount: z.number().min(0).optional(), tdsReason: opt(300),
      remarks: opt(500), lines: z.array(z.object({ docId: z.string().uuid(), amount: z.number().positive() })).min(1).max(100) })
      .refine((x) => !x.tdsAmount || !!x.tdsSection, { message: 'Give the TDS section', path: ['tdsSection'] }), req.body);
    const out = await withTx(db, async (tx) => {
      if (!inScope(req, P('create'), d.legalEntityId)) throw Errors.forbidden(P('create'));
      const docs = await openDocs(tx, { type: d.payeeType, id: d.payeeId }, d.legalEntityId);
      for (const l of d.lines) {
        const doc = docs.find((x) => x.id === l.docId);
        if (!doc) throw Errors.rule('NOT_PAYABLE', 'A bill is not an open, approved bill of this payee and entity.');
        if (l.amount > doc.outstanding + 0.004) throw Errors.rule('OVERPAYMENT', `${doc.docNo}: only ₹${doc.outstanding} is still payable.`);
      }
      const amount = r2(d.lines.reduce((a, l) => a + l.amount, 0));
      // TDS: worked out from the TDS master unless the accountant enters it (then it is recorded as a manual figure)
      const auto = await computeTds(tx, { payeeType: d.payeeType, payeeId: d.payeeId, date: d.paymentDate, lines: d.lines });
      const manual = d.tdsAmount !== undefined || !!d.tdsSection;
      const tds = manual ? { section: d.tdsSection ?? null, amount: d.tdsAmount ?? 0, rate: null as number | null, base: null as number | null, basis: 'MANUAL' as const }
        : { section: auto.amount > 0 ? auto.section : null, amount: auto.amount, rate: auto.amount > 0 ? auto.rate : null, base: auto.amount > 0 ? auto.base : null, basis: auto.basis };
      if (manual && auto.basis === 'AUTO' && Math.abs(auto.amount - tds.amount) >= 1 && !d.tdsReason) {
        throw Errors.rule('TDS_DIFFERS', `The TDS master gives ₹${auto.amount} (${auto.reason}). Give the reason for deducting ₹${tds.amount} instead.`, { computed: auto });
      }
      if (tds.section && !(await tx.query(`select 1 from fin.tds_sections where code = $1`, [tds.section])).rowCount) throw Errors.rule('UNKNOWN_TDS_SECTION', `No TDS section ${tds.section}.`);
      if (tds.amount >= amount) throw Errors.rule('TDS_TOO_HIGH', 'TDS cannot be the whole payment.');
      const docNo = await nextDocNo(tx, 'PAYMENT');
      const p = (await tx.query(`insert into fin.payments (doc_no, legal_entity_id, payee_type, party_id, transporter_id, payment_date, mode, from_account, amount, tds_section, tds_amount, net_amount, remarks, created_by, updated_by,
            tds_rate, tds_base, tds_basis)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17) returning id`,
        [docNo, d.legalEntityId, d.payeeType, d.payeeType === 'VENDOR' ? d.payeeId : null, d.payeeType === 'TRANSPORTER' ? d.payeeId : null, d.paymentDate, d.mode, d.fromAccount, amount,
          tds.section, tds.amount, r2(amount - tds.amount), [d.remarks, manual && d.tdsReason ? `TDS: ${d.tdsReason}` : null].filter(Boolean).join(' · ') || null, req.auth!.user.id, tds.rate, tds.base, tds.basis])).rows[0];
      for (const l of d.lines) {
        const doc = docs.find((x) => x.id === l.docId)!;
        await tx.query(`insert into fin.payment_lines (payment_id, supplier_invoice_id, freight_bill_id, amount) values ($1,$2,$3,$4)`,
          [p.id, doc.kind === 'SUPPLIER_INVOICE' ? doc.id : null, doc.kind === 'FREIGHT_BILL' ? doc.id : null, l.amount]);
      }
      await audit(tx, actorOf(req), { action: `${SUBJECT}.drafted`, entityType: SUBJECT, entityId: p.id, after: { docNo, ...d } });
      return { id: p.id as string, docNo, amount, tdsAmount: tds.amount, netAmount: r2(amount - tds.amount), tds: auto };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (x.status !== 'Draft') throw Errors.state(`A ${x.status.toLowerCase()} payment cannot be submitted.`);
      // MDM-011: a vendor is paid only into a verified bank account
      if (x.payeeType === 'VENDOR') {
        const bank = (await tx.query(`select verification from mdm.party_bank_accounts where party_id = $1 and status = 'Active'`, [x.partyId])).rows[0];
        if (bank?.verification !== 'Verified') throw Errors.rule('BANK_NOT_VERIFIED', `${x.payeeName}'s bank account is not verified by finance; it cannot be paid.`);
      }
      // still payable now? (another payment may have been released meanwhile)
      const docs = await openDocs(tx, { type: x.payeeType, id: x.partyId ?? x.transporterId }, x.legalEntityId, x.id);
      for (const l of (await tx.query(`select coalesce(supplier_invoice_id, freight_bill_id) as doc, amount from fin.payment_lines where payment_id = $1`, [x.id])).rows) {
        const doc = docs.find((y) => y.id === l.doc);
        if (!doc || Number(l.amount) > doc.outstanding + 0.004) throw Errors.rule('OVERPAYMENT', 'A bill on this payment is no longer payable for that amount; cancel it and draft again.');
      }
      await setStatus(tx, actorOf(req), x.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: x.id, subjectLabel: `${x.docNo} — ${x.payeeName} ₹${x.netAmount}`,
        facts: { amount: Number(x.amount), payeeType: x.payeeType }, legalEntityId: x.legalEntityId });
      return { approvalRequestId: ar.id as string, approvalDocNo: ar.doc_no as string, status: ar.status === 'Approved' ? 'Approved' : 'Submitted' };
    });
    res.json(out);
  }));

  // the bank transfer has gone: record the UTR, and only now are the bills settled
  r.post('/:id/release', requirePermission(P('release')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ reference: text(40), paidOn: day }), req.body);
    await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (x.batchId && x.batchStatus === 'Generated') throw Errors.rule('IN_BANK_FILE', 'This payment is in a bank file; it is released by the bank’s reply file.');
      await releasePayment(tx, actorOf(req), x.id, d.reference, d.paidOn);
    });
    res.json({ ok: true });
  }));

  r.post('/:id/cancel', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (!['Draft', 'Rejected', 'Approved'].includes(x.status)) throw Errors.state(`A ${x.status.toLowerCase()} payment cannot be cancelled.`);
      await withdrawOpenRequests(tx, SUBJECT, [x.id]);
      await setStatus(tx, actorOf(req), x.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));
  return r;
}

// ================================================================ debit notes, ageing and the vendor ledger (FIN-011)
export function payableRoutes(db: Db) {
  const r = Router();
  const V = 'finance.payable:view';

  // a debit note from a supplier return reduces what we owe on one of that vendor's invoices
  r.post('/debit-notes/:id/adjust', requirePermission('finance.payment:create'), asyncHandler(async (req, res) => {
    const { supplierInvoiceId } = parse(z.object({ supplierInvoiceId: z.string().uuid() }), req.body);
    await withTx(db, async (tx) => {
      const dn = (await tx.query(`select id, doc_no, party_id, status, grand_total from purchase.debit_notes where id = $1 for update`, [req.params.id])).rows[0];
      if (!dn) throw Errors.notFound('Debit note');
      if (dn.status !== 'Open') throw Errors.state(`This debit note is ${dn.status.toLowerCase()}.`);
      const si = (await tx.query(`select si.id, si.doc_no, si.party_id, si.status, coalesce(si.legal_entity_id, po.legal_entity_id) as legal_entity_id from purchase.supplier_invoices si left join purchase.purchase_orders po on po.id = si.purchase_order_id where si.id = $1 for update of si`, [supplierInvoiceId])).rows[0];
      if (!si || si.party_id !== dn.party_id) throw Errors.rule('WRONG_INVOICE', 'Adjust a debit note against an invoice of the same vendor.');
      if (!inScope(req, 'finance.payment:create', si.legal_entity_id)) throw Errors.notFound('Supplier invoice');
      const doc = (await openDocs(tx, { type: 'VENDOR', id: si.party_id }, si.legal_entity_id)).find((x) => x.id === si.id);
      if (!doc) throw Errors.rule('NOT_PAYABLE', `${si.doc_no} is not an open, approved invoice.`);
      if (Number(dn.grand_total) > doc.outstanding + 0.004) throw Errors.rule('OVER_ADJUSTED', `${si.doc_no} has only ₹${doc.outstanding} payable.`);
      await tx.query(`update purchase.debit_notes set status = 'Adjusted', supplier_invoice_id = $2, adjusted_at = now(), adjusted_by = $3 where id = $1`, [dn.id, si.id, req.auth!.user.id]);
      await tx.query(`update purchase.supplier_invoices set amount_settled = amount_settled + $2 where id = $1`, [si.id, Number(dn.grand_total)]);
      await audit(tx, actorOf(req), { action: 'purchase.debit_note.adjusted', entityType: 'purchase.debit_note', entityId: dn.id, after: { invoice: si.doc_no, amount: Number(dn.grand_total) } });
    });
    res.json({ ok: true });
  }));

  r.get('/ageing', requirePermission(V), asyncHandler(async (req, res) => {
    const today = todayIST();
    const a1: unknown[] = [today];
    const si = (await db.query(`select 'VENDOR' as type, si.party_id as id, p.code, p.legal_name as name, ($1::date - si.due_date) as days, si.grand_total - si.amount_settled as o
        from purchase.supplier_invoices si left join purchase.purchase_orders po on po.id = si.purchase_order_id join mdm.parties p on p.id = si.party_id
        where si.status in ${PAYABLE_SI} and si.grand_total - si.amount_settled > 0.004 and ${scopeSql(req, V, 'coalesce(si.legal_entity_id, po.legal_entity_id)', a1)}`, a1)).rows;
    const a2: unknown[] = [today];
    const fb = (await db.query(`select 'TRANSPORTER' as type, fb.transporter_id as id, t.code, t.name, ($1::date - fb.due_date) as days, fb.grand_total - fb.amount_settled as o
        from logistics.freight_bills fb join logistics.transporters t on t.id = fb.transporter_id where fb.status = 'Approved' and fb.grand_total - fb.amount_settled > 0.004 and ${scopeSql(req, V, 'fb.legal_entity_id', a2)}`, a2)).rows;
    const map = new Map<string, { type: string; id: string; code: string; name: string; notDue: number; d1to30: number; d31to60: number; over60: number; total: number; overdue: number; debitNotes: number }>();
    for (const x of [...si, ...fb]) {
      const k = `${x.type}|${x.id}`;
      const row = map.get(k) ?? { type: x.type, id: x.id, code: x.code, name: x.name, notDue: 0, d1to30: 0, d31to60: 0, over60: 0, total: 0, overdue: 0, debitNotes: 0 };
      const days = Number(x.days); const o = Number(x.o);
      const b = days <= 0 ? 'notDue' : days <= 30 ? 'd1to30' : days <= 60 ? 'd31to60' : 'over60';
      row[b] = r2(row[b] + o); row.total = r2(row.total + o); if (days > 0) row.overdue = r2(row.overdue + o);
      map.set(k, row);
    }
    const dns = (await db.query(`select party_id, sum(grand_total) as v from purchase.debit_notes where status = 'Open' group by 1`)).rows;
    const data = [...map.values()].map((x) => ({ ...x, debitNotes: x.type === 'VENDOR' ? Number(dns.find((d) => d.party_id === x.id)?.v ?? 0) : 0 })).sort((a, b) => b.overdue - a.overdue || b.total - a.total);
    const totals = Object.fromEntries(['notDue', 'd1to30', 'd31to60', 'over60', 'total', 'overdue', 'debitNotes'].map((k) => [k, r2(data.reduce((a, x) => a + Number((x as Record<string, unknown>)[k]), 0))]));
    res.json({ asOf: today, data, totals });
  }));

  // vendor ledger: invoices credit the vendor; debit notes and released payments debit
  r.get('/statement/vendor/:partyId', requirePermission(V), asyncHandler(async (req, res) => {
    const from = str(req.query.from) ?? `${todayIST().slice(0, 4)}-04-01`;
    const to = str(req.query.to) ?? todayIST();
    const party = (await db.query(`select id, code, legal_name as name, gstin from mdm.parties where id = $1`, [req.params.partyId])).rows[0];
    if (!party) throw Errors.notFound('Vendor');
    const args: unknown[] = [party.id];
    const sc = scopeSql(req, V, 'coalesce(si.legal_entity_id, po.legal_entity_id)', args);
    const sp = sc.replace('coalesce(si.legal_entity_id, po.legal_entity_id)', 'p.legal_entity_id');
    const entries = (await db.query(`
      select si.invoice_date as date, si.created_at as ts, 'Supplier invoice' as kind, si.doc_no as ref, si.id, 0 as debit, si.grand_total as credit, 'Bill ' || si.invoice_no as note
        from purchase.supplier_invoices si left join purchase.purchase_orders po on po.id = si.purchase_order_id where si.party_id = $1 and si.status in ${PAYABLE_SI} and ${sc}
      union all select dn.note_date, dn.created_at, 'Debit note', dn.doc_no, dn.id, dn.grand_total, 0, dn.reason from purchase.debit_notes dn where dn.party_id = $1 and dn.status in ('Open','Adjusted')
      union all select p.paid_on, p.updated_at, 'Payment', p.doc_no, p.id, p.amount, 0, p.mode || ' ' || p.reference || case when p.tds_amount > 0 then ' (TDS ' || p.tds_amount || ')' else '' end
        from fin.payments p where p.party_id = $1 and p.status = 'Paid' and ${sp}
      order by 1, 2`, args)).rows;
    let opening = 0; let bal = 0;
    const lines = [];
    for (const e of entries) {
      const dt = new Date(e.date).toISOString().slice(0, 10);
      const delta = Number(e.credit) - Number(e.debit);       // positive = we owe more
      if (dt < from) { opening = r2(opening + delta); continue; }
      if (dt > to) continue;
      if (!lines.length) bal = opening;
      bal = r2(bal + delta);
      lines.push({ date: dt, kind: e.kind, ref: e.ref, id: e.id, note: e.note, debit: Number(e.debit), credit: Number(e.credit), balance: bal });
    }
    res.json({ party, from, to, opening, closing: lines.length ? bal : opening, lines });
  }));
  return r;
}
