import { Router, type Request } from 'express';
import { z } from 'zod';
import { invoiceExceptionSchema, reasonSchema, supplierInvoiceSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

type InvInput = z.infer<typeof supplierInvoiceSchema>;
const SUBJECT = 'purchase.supplier_invoice';
const P = (a: string) => `purchase.invoice:${a}`;
const INVOICED = ['Matched', 'Exception', 'Submitted', 'Approved'];
const half = (x: number) => Math.round(x + (x >= 0 ? 1e-9 : -1e-9));
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update purchase.supplier_invoices set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    matched_at = case when $2 in ('Matched','Exception') then now() else matched_at end where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/**
 * QC-accepted quantity of a PO line (the basis for paying): everything received in lots QC released, less what was returned from them.
 * Quantities still in quarantine or on hold are reported as pending; rejected lots are never billable.
 */
async function acceptedQty(tx: Db | Tx, poLineId: string) {
  return (await tx.query(
    `select coalesce(sum(case when l.qc_status = 'Released' then gl.received_qty - coalesce(ret.q, 0) else 0 end), 0) as accepted,
            coalesce(sum(case when l.qc_status in ('Quarantine','Hold') then gl.received_qty else 0 end), 0) as pending
       from purchase.goods_receipt_lines gl join purchase.goods_receipts g on g.id = gl.goods_receipt_id and g.status = 'Posted'
       join inv.lots l on l.id = gl.lot_id
       left join (select srl.lot_id, sum(srl.qty) as q from purchase.supplier_return_lines srl join purchase.supplier_returns sr on sr.id = srl.supplier_return_id
                   where sr.status = 'Posted' group by srl.lot_id) ret on ret.lot_id = l.id
      where gl.po_line_id = $1`, [poLineId])).rows[0] as { accepted: string; pending: string };
}

/**
 * Three-way match (PUR-009, TC-10): each invoice line against the PO line (rate, GST rate) and the QC-accepted receipts not yet invoiced,
 * with the tolerances in `purchase.match.tolerances` (D06 defaults: quantity +0%, price ±0.5%, GST ±₹1 per line).
 */
async function match(tx: Tx, invoiceId: string) {
  const tol = await getSetting<{ qtyPct: number; pricePct: number; taxAbs: number }>(tx, 'purchase.match.tolerances', { qtyPct: 0, pricePct: 0.5, taxAbs: 1 });
  const lines = (await tx.query(
    `select il.*, pl.net_rate, pl.gst_rate as po_gst_rate, i.code from purchase.supplier_invoice_lines il join purchase.purchase_order_lines pl on pl.id = il.po_line_id
       join mdm.items i on i.id = il.item_id where il.supplier_invoice_id = $1 order by il.line_no`, [invoiceId])).rows;
  let ok = true;
  for (const l of lines) {
    const acc = await acceptedQty(tx, l.po_line_id);
    const invoicedElsewhere = Number((await tx.query(
      `select coalesce(sum(il.qty), 0) as q from purchase.supplier_invoice_lines il join purchase.supplier_invoices si on si.id = il.supplier_invoice_id
        where il.po_line_id = $1 and si.id <> $2 and si.status = any($3::text[])`, [l.po_line_id, invoiceId, INVOICED])).rows[0].q);
    const billable = Math.max(0, Number(acc.accepted) - invoicedElsewhere);
    const qtyVar = Number(l.qty) - billable;
    const priceVar = ((Number(l.rate) - Number(l.net_rate)) / Number(l.net_rate)) * 100;
    const expectedTax = half(Number(l.taxable) * 100 * Number(l.po_gst_rate) / 100) / 100;
    const taxVar = Math.round((Number(l.tax) - expectedTax) * 100) / 100;
    const notes: string[] = [];
    if (qtyVar > billable * (tol.qtyPct / 100) + 1e-9) {
      notes.push(`Quantity ${Number(l.qty)} exceeds the QC-accepted quantity not yet invoiced (${billable})${Number(acc.pending) ? `; ${Number(acc.pending)} still awaiting QC` : ''}`);
    }
    if (Math.abs(priceVar) > tol.pricePct + 1e-9) notes.push(`Rate ${Number(l.rate)} is ${priceVar > 0 ? '+' : ''}${priceVar.toFixed(2)}% against the PO rate ${Number(l.net_rate)} (tolerance ±${tol.pricePct}%)`);
    if (Number(l.gst_rate) !== Number(l.po_gst_rate)) notes.push(`GST rate ${Number(l.gst_rate)}% differs from the PO's ${Number(l.po_gst_rate)}%`);
    else if (Math.abs(taxVar) > tol.taxAbs) notes.push(`GST charged differs by ₹${taxVar.toFixed(2)} (tolerance ₹${tol.taxAbs})`);
    const within = notes.length === 0;
    ok &&= within;
    await tx.query(
      `update purchase.supplier_invoice_lines set po_rate = $2, po_gst_rate = $3, billable_qty = $4, qty_variance = $5, price_variance_pct = $6, tax_variance = $7,
         within_tolerance = $8, match_notes = $9 where id = $1`,
      [l.id, l.net_rate, l.po_gst_rate, billable, Math.round(qtyVar * 10000) / 10000, Math.round(priceVar * 10000) / 10000, taxVar, within, notes.join('; ') || null]);
  }
  return ok;
}

const invSelect = `select si.id, si.doc_no as "docNo", si.party_id as "partyId", p.legal_name as "vendorName", p.gstin as "vendorGstin", si.purchase_order_id as "purchaseOrderId",
    o.doc_no as "poNo", si.invoice_no as "invoiceNo", si.invoice_date as "invoiceDate", si.due_date as "dueDate", si.document_id as "documentId", si.inter_state as "interState",
    si.taxable_total as "taxableTotal", si.tax_total as "taxTotal", si.round_off as "roundOff", si.grand_total as "grandTotal", si.status, si.status_reason as "statusReason",
    si.matched_at as "matchedAt", si.exception_note as "exceptionNote", si.created_at as "createdAt", cu.full_name as "createdBy", si.version, o.legal_entity_id as "legalEntityId"
  from purchase.supplier_invoices si join mdm.parties p on p.id = si.party_id join purchase.purchase_orders o on o.id = si.purchase_order_id left join iam.users cu on cu.id = si.created_by`;

export function supplierInvoiceRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Approved', 'Variance accepted'),
    onRejected: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Rejected', 'Variance not accepted — take it up with the vendor'),
    onReturned: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Exception', 'Returned for a better justification'),
    onCancelled: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Exception'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const scope = legalEntityScope(req, P('view'));
    let where = 'si.id = $1';
    if (scope) { args.push(scope); where += ' and o.legal_entity_id = any($2::uuid[])'; }
    const row = (await dbx.query(`${invSelect} where ${where} ${lock ? 'for update of si' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Supplier invoice');
    return row;
  }

  async function build(tx: Tx, req: Request, d: InvInput, excludeId: string | null) {
    const po = (await tx.query(`select id, doc_no, status, party_id, legal_entity_id, inter_state, payment_terms_days, po_date from purchase.purchase_orders where id = $1`, [d.purchaseOrderId])).rows[0];
    if (!po) throw Errors.notFound('Purchase order');
    const scope = legalEntityScope(req, P('create'));
    if (scope && !scope.includes(po.legal_entity_id)) throw Errors.notFound('Purchase order');
    if (!['Acknowledged', 'PartiallyReceived', 'Received', 'Closed', 'Issued'].includes(po.status)) throw Errors.state(`An invoice cannot be booked against a ${po.status} PO.`);
    if (d.invoiceDate > todayIST()) throw Errors.rule('FUTURE_DATE', 'The invoice date cannot be in the future.');
    const dup = (await tx.query(`select doc_no from purchase.supplier_invoices where party_id = $1 and lower(invoice_no) = lower($2) and status <> 'Cancelled' and id is distinct from $3`,
      [po.party_id, d.invoiceNo, excludeId])).rows[0];
    if (dup) throw Errors.conflict('DUPLICATE_INVOICE', `Invoice ${d.invoiceNo} from this vendor is already booked as ${dup.doc_no}.`);
    if (d.documentId) {
      const doc = (await tx.query(`select entity_type from sys.documents where id = $1 and status = 'Active'`, [d.documentId])).rows[0];
      if (doc?.entity_type !== SUBJECT) throw Errors.rule('DOCUMENT_INVALID', 'Attach the invoice scan to this invoice.');
    }
    const lines = [];
    let n = 0;
    for (const l of d.lines) {
      n++;
      const pl = (await tx.query(`select item_id from purchase.purchase_order_lines where id = $1 and purchase_order_id = $2`, [l.poLineId, po.id])).rows[0];
      if (!pl) throw Errors.validation([{ field: 'lines', message: `Line ${n} does not belong to ${po.doc_no}` }]);
      const taxable = half(l.qty * l.rate * 100);
      const tax = l.tax === null || l.tax === undefined ? half((taxable * l.gstRate) / 100) : half(l.tax * 100);
      lines.push({ ...l, lineNo: n, itemId: pl.item_id as string, taxable, tax });
    }
    const taxable = lines.reduce((a, l) => a + l.taxable, 0);
    const tax = lines.reduce((a, l) => a + l.tax, 0);
    const grand = half((taxable + tax) / 100) * 100;
    return { po, lines, taxable, tax, roundOff: grand - taxable - tax, grand, dueDate: d.dueDate ?? addDays(d.invoiceDate, Number(po.payment_terms_days)) };
  }
  async function write(tx: Tx, id: string, b: Awaited<ReturnType<typeof build>>) {
    await tx.query(`delete from purchase.supplier_invoice_lines where supplier_invoice_id = $1`, [id]);
    for (const l of b.lines) {
      await tx.query(`insert into purchase.supplier_invoice_lines (supplier_invoice_id, line_no, po_line_id, item_id, qty, rate, gst_rate, taxable, tax) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, l.lineNo, l.poLineId, l.itemId, l.qty, l.rate, l.gstRate, l.taxable / 100, l.tax / 100]);
    }
  }
  /** Books (or re-books) the invoice and runs the match: Matched → ready for payment; Exception → justification and approval. */
  async function rematch(tx: Tx, req: Request, id: string) {
    const ok = await match(tx, id);
    await setStatus(tx, actorOf(req), id, ok ? 'Matched' : 'Exception');
    return ok;
  }

  // open POs with what is billable per line — the picker for booking an invoice
  r.get('/billable', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const poId = str(req.query.purchaseOrderId);
    if (!poId) throw Errors.validation([{ field: 'purchaseOrderId', message: 'Choose a PO' }]);
    const lines = (await db.query(
      `select pl.id as "poLineId", pl.line_no as "lineNo", pl.item_id as "itemId", i.code as "itemCode", i.name as "itemName", pl.uom, pl.qty as "orderedQty", pl.net_rate as rate,
              pl.gst_rate as "gstRate" from purchase.purchase_order_lines pl join mdm.items i on i.id = pl.item_id where pl.purchase_order_id = $1 order by pl.line_no`, [poId])).rows;
    for (const l of lines) {
      const acc = await acceptedQty(db, l.poLineId);
      const inv = Number((await db.query(`select coalesce(sum(il.qty), 0) as q from purchase.supplier_invoice_lines il join purchase.supplier_invoices si on si.id = il.supplier_invoice_id
                                           where il.po_line_id = $1 and si.status = any($2::text[])`, [l.poLineId, INVOICED])).rows[0].q);
      Object.assign(l, { acceptedQty: Number(acc.accepted), pendingQcQty: Number(acc.pending), invoicedQty: inv, billableQty: Math.max(0, Number(acc.accepted) - inv) });
    }
    res.json({ data: lines });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const scope = legalEntityScope(req, P('view'));
    if (scope) { args.push(scope); where.push(`o.legal_entity_id = any($${args.length}::uuid[])`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(si.doc_no ilike $${args.length} or si.invoice_no ilike $${args.length} or p.legal_name ilike $${args.length} or o.doc_no ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`si.status = $${args.length}`); }
    const rows = await db.query(`${invSelect.replace('select si.id,', 'select count(*) over() as total, si.id,')} where ${where.join(' and ')}
      order by case si.status when 'Exception' then 0 when 'Submitted' then 1 else 2 end, si.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const si = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select il.line_no as "lineNo", il.po_line_id as "poLineId", il.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, il.qty, il.rate,
              il.gst_rate as "gstRate", il.taxable, il.tax, il.po_rate as "poRate", il.po_gst_rate as "poGstRate", il.billable_qty as "billableQty", il.qty_variance as "qtyVariance",
              il.price_variance_pct as "priceVariancePct", il.tax_variance as "taxVariance", il.within_tolerance as "withinTolerance", il.match_notes as "matchNotes"
         from purchase.supplier_invoice_lines il join mdm.items i on i.id = il.item_id where il.supplier_invoice_id = $1 order by il.line_no`, [si.id])).rows;
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, si.id])).rows[0] ?? null;
    const tolerances = await getSetting(db, 'purchase.match.tolerances', { qtyPct: 0, pricePct: 0.5, taxAbs: 1 });
    const actions: string[] = [];
    if (['Matched', 'Exception'].includes(si.status) && can(req, P('create'))) actions.push('rematch');
    if (si.status === 'Exception' && can(req, P('submit'))) actions.push('submit');
    if (['Matched', 'Exception', 'Rejected'].includes(si.status) && can(req, P('cancel'))) actions.push('cancel');
    res.json({ ...si, lines, approval, tolerances, allowedActions: actions });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(supplierInvoiceSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const b = await build(tx, req, d, null);
      const docNo = await nextDocNo(tx, 'SUPPLIER_INVOICE');
      const si = (await tx.query(
        `insert into purchase.supplier_invoices (doc_no, party_id, purchase_order_id, invoice_no, invoice_date, due_date, document_id, inter_state, taxable_total, tax_total, round_off, grand_total, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) returning id`,
        [docNo, b.po.party_id, b.po.id, d.invoiceNo, d.invoiceDate, b.dueDate, d.documentId ?? null, b.po.inter_state, b.taxable / 100, b.tax / 100, b.roundOff / 100, b.grand / 100, req.auth!.user.id])).rows[0];
      await write(tx, si.id, b);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: si.id, after: { docNo, ...d } });
      const ok = await rematch(tx, req, si.id);
      return { id: si.id as string, docNo, status: ok ? 'Matched' : 'Exception' };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(supplierInvoiceSchema.and(z.object({ version: z.number().int() })), req.body);
    const out = await withTx(db, async (tx) => {
      const si = await load(tx, req, req.params.id!, true);
      if (!['Matched', 'Exception'].includes(si.status)) throw Errors.state(`A ${si.status} invoice cannot be changed.`);
      if (si.version !== d.version) throw Errors.concurrent();
      if (d.purchaseOrderId !== si.purchaseOrderId) throw Errors.rule('PO_LOCKED', 'The PO of an invoice cannot be changed. Cancel it and book it again.');
      const b = await build(tx, req, d, si.id);
      await tx.query(`update purchase.supplier_invoices set invoice_no=$2, invoice_date=$3, due_date=$4, document_id=$5, taxable_total=$6, tax_total=$7, round_off=$8, grand_total=$9, updated_by=$10 where id = $1`,
        [si.id, d.invoiceNo, d.invoiceDate, b.dueDate, d.documentId ?? null, b.taxable / 100, b.tax / 100, b.roundOff / 100, b.grand / 100, req.auth!.user.id]);
      await write(tx, si.id, b);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: si.id, after: d });
      return { status: (await rematch(tx, req, si.id)) ? 'Matched' : 'Exception' };
    });
    res.json(out);
  }));

  // re-run the match after receipts, QC decisions or returns have changed
  r.post('/:id/rematch', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const si = await load(tx, req, req.params.id!, true);
      if (!['Matched', 'Exception'].includes(si.status)) throw Errors.state(`A ${si.status} invoice is not re-matched.`);
      return { status: (await rematch(tx, req, si.id)) ? 'Matched' : 'Exception' };
    });
    res.json(out);
  }));

  // Exception: purchase justifies the variance; the purchase head and then the finance head decide (doc 07 §6)
  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const { note } = parse(invoiceExceptionSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const si = await load(tx, req, req.params.id!, true);
      if (si.status !== 'Exception') throw Errors.state('Only an invoice outside tolerance goes for approval.');
      await tx.query(`update purchase.supplier_invoices set exception_note = $2 where id = $1`, [si.id, note]);
      const variance = (await tx.query(`select coalesce(sum(abs(tax_variance)), 0) as tax, max(abs(price_variance_pct)) as price from purchase.supplier_invoice_lines where supplier_invoice_id = $1`, [si.id])).rows[0];
      await setStatus(tx, actorOf(req), si.id, 'Submitted', note);
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: si.id, subjectLabel: `${si.docNo} — ${si.vendorName} invoice ${si.invoiceNo}`,
        facts: { amount: Number(si.grandTotal), maxPriceVariancePct: Number(variance.price ?? 0) }, legalEntityId: si.legalEntityId });
      return { approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const si = await load(tx, req, req.params.id!, true);
      if (!['Matched', 'Exception', 'Rejected'].includes(si.status)) throw Errors.state(`A ${si.status} invoice cannot be cancelled.`);
      await setStatus(tx, actorOf(req), si.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
