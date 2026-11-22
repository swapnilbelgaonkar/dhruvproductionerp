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
import { registerSubjectHandler, submitForApproval, withdrawOpenRequests } from '../workflow/engine';
import { amountInWords, calcLine, calcTotals, toPaise, toRupees, type LineOut } from './calc';
import { todayIST } from './quotations';

/**
 * Sales invoicing (BRD p.18; MP §16; FIN-001…FIN-006, FIN-014, LOG-012).
 * One GST tax invoice per dispatched shipment, priced from the approved sales order line (rate, scheme and extra discount, GST rate as resolved
 * from the tax master when the order was made — never re-keyed). Credit notes reduce an invoice after approval; customer returns bring goods back
 * into quarantine for QA to restock or reject, and draft the credit note for them.
 */
const half = (x: number) => Math.round(x + (x >= 0 ? 1e-9 : -1e-9));
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const opt = (n: number) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const rs = (o: LineOut) => ({ rate: toRupees(o.rate), taxable: toRupees(o.taxable), cgst: toRupees(o.cgst), sgst: toRupees(o.sgst), igst: toRupees(o.igst), lineTotal: toRupees(o.lineTotal) });

async function setStatus(tx: Tx, actor: Actor, table: 'invoices' | 'credit_notes', entityType: string, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  const extra = status === 'Cancelled' && table === 'invoices' ? ', cancelled_at = now()' : status === 'Approved' && table === 'credit_notes' ? ', approved_at = now()' : '';
  await tx.query(`update sales.${table} set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4${extra} where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${entityType}.status`, entityType, entityId: id, after: { status }, reason });
  await emit(tx, entityType, id, `${entityType}.${status.toLowerCase()}`);
}

// ================================================================ invoice from a dispatched shipment (FIN-001, FIN-002)
/** Raises the tax invoice of a dispatched shipment. Idempotent: an existing live invoice is returned. */
export async function raiseInvoice(tx: Tx, actor: Actor, shipmentId: string): Promise<{ id: string; docNo: string; grandTotal: number }> {
  const live = (await tx.query(`select id, doc_no, grand_total from sales.invoices where shipment_id = $1 and status <> 'Cancelled'`, [shipmentId])).rows[0];
  if (live) return { id: live.id, docNo: live.doc_no, grandTotal: Number(live.grand_total) };
  const s = (await tx.query(`select s.id, s.status, s.doc_no, s.dispatched_at, so.id as so_id, so.legal_entity_id, so.seller_state, so.party_id, so.bill_to_id, so.ship_to_id, so.place_of_supply,
      so.inter_state, so.payment_terms, p.gstin as party_gstin, coalesce(d.credit_days, 0) as credit_days
      from logistics.shipments s join sales.sales_orders so on so.id = s.sales_order_id join mdm.parties p on p.id = so.party_id
      left join mdm.dealer_profiles d on d.party_id = so.party_id where s.id = $1 for update of s`, [shipmentId])).rows[0];
  if (!s) throw Errors.notFound('Shipment');
  if (!['Dispatched', 'Delivered'].includes(s.status)) throw Errors.state('Only a dispatched shipment can be invoiced.');
  const gstin = (await tx.query(`select gstin from org.gst_registrations where legal_entity_id = $1 and state_code = $2 and status = 'Active'`, [s.legal_entity_id, s.seller_state])).rows[0]?.gstin ?? null;
  const lines = (await tx.query(
    `select l.id as shipment_line_id, sl.id as so_line_id, sl.item_pack_id, sl.description, sl.hsn_code, sl.pack_label, sl.list_rate, sl.scheme_discount_pct, sl.extra_discount_pct, sl.gst_rate,
            coalesce((select sum(pk.packs) from logistics.shipment_picks pk where pk.shipment_line_id = l.id), 0) as packs,
            coalesce((select json_agg(json_build_object('lotId', x.lot_id, 'lotNo', lt.lot_no, 'expiryDate', lt.expiry_date, 'packs', x.packs, 'qty', x.qty,
                       'unitCost', coalesce((select sum(-sl2.qty * sl2.unit_cost) / nullif(sum(-sl2.qty), 0) from inv.stock_ledger sl2 where sl2.lot_id = x.lot_id and sl2.source_id = l.shipment_id and sl2.txn_type = 'DISPATCH'), 0))
                       order by lt.lot_no)
                 from (select pk.lot_id, sum(pk.packs) as packs, sum(pk.qty) as qty from logistics.shipment_picks pk where pk.shipment_line_id = l.id group by pk.lot_id) x join inv.lots lt on lt.id = x.lot_id), '[]'::json) as lots
       from logistics.shipment_lines l join sales.sales_order_lines sl on sl.id = l.so_line_id where l.shipment_id = $1 order by sl.line_no`, [shipmentId])).rows.filter((l) => Number(l.packs) > 0);
  if (!lines.length) throw Errors.rule('NOTHING_DISPATCHED', 'Nothing was dispatched on this shipment.');
  const outs = lines.map((l) => calcLine({ qty: Number(l.packs), listRate: l.list_rate, schemePct: Number(l.scheme_discount_pct), extraPct: Number(l.extra_discount_pct), gstRate: Number(l.gst_rate) }, s.inter_state));
  const t = calcTotals(outs);
  const date = todayIST();
  const docNo = await nextDocNo(tx, 'SALES_INVOICE');
  const inv = (await tx.query(`insert into sales.invoices (doc_no, legal_entity_id, seller_state, seller_gstin, party_id, party_gstin, bill_to_id, ship_to_id, place_of_supply, inter_state, sales_order_id,
      shipment_id, invoice_date, due_date, payment_terms, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$22) returning id`,
    [docNo, s.legal_entity_id, s.seller_state, gstin, s.party_id, s.party_gstin, s.bill_to_id, s.ship_to_id, s.place_of_supply, s.inter_state, s.so_id, s.id, date, addDays(date, Number(s.credit_days)),
      s.payment_terms, toRupees(t.taxableTotal), toRupees(t.cgstTotal), toRupees(t.sgstTotal), toRupees(t.igstTotal), toRupees(t.roundOff), toRupees(t.grandTotal), actor.userId])).rows[0];
  for (const [i, l] of lines.entries()) {
    const o = rs(outs[i]!);
    await tx.query(`insert into sales.invoice_lines (invoice_id, line_no, so_line_id, shipment_line_id, item_pack_id, description, hsn_code, pack_label, qty, list_rate, scheme_discount_pct, extra_discount_pct,
        rate, taxable, gst_rate, cgst, sgst, igst, line_total, lots) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [inv.id, i + 1, l.so_line_id, l.shipment_line_id, l.item_pack_id, l.description, l.hsn_code, l.pack_label, Number(l.packs), l.list_rate, l.scheme_discount_pct, l.extra_discount_pct,
        o.rate, o.taxable, l.gst_rate, o.cgst, o.sgst, o.igst, o.lineTotal, JSON.stringify(l.lots)]);
  }
  await audit(tx, actor, { action: 'sales.invoice.posted', entityType: 'sales.invoice', entityId: inv.id, after: { docNo, shipment: s.doc_no, grandTotal: toRupees(t.grandTotal) } });
  await emit(tx, 'sales.invoice', inv.id, 'sales.invoice.posted');
  return { id: inv.id as string, docNo, grandTotal: toRupees(t.grandTotal) };
}

/** Taxable amount already credited (approved or in flight) per invoice line, and quantity. */
async function credited(dbx: Db | Tx, invoiceId: string, exceptNoteId: string | null = null) {
  return (await dbx.query(`select cl.invoice_line_id as id, coalesce(sum(cl.qty), 0) as qty, sum(cl.taxable) as taxable from sales.credit_note_lines cl join sales.credit_notes c on c.id = cl.credit_note_id
      where c.invoice_id = $1 and c.status in ('Draft','Submitted','Approved') and c.id is distinct from $2 group by cl.invoice_line_id`, [invoiceId, exceptNoteId])).rows as { id: string; qty: string; taxable: string }[];
}

const CN_REASONS = ['RETURN', 'SHORTAGE', 'DAMAGE', 'RATE_DIFFERENCE', 'SCHEME', 'OTHER'] as const;
const QTY_REASONS = ['RETURN', 'SHORTAGE', 'DAMAGE'];

/** Creates a draft credit note; quantity lines are valued at the invoice line's net rate, value lines at the taxable amount given. GST follows the invoice line. */
async function draftCreditNote(tx: Tx, actor: Actor, d: { invoiceId: string; reason: string; remarks: string | null; customerReturnId?: string | null; shipmentId?: string | null;
  lines: { invoiceLineId: string; qty?: number | null; taxable?: number | null }[] }) {
  const inv = (await tx.query(`select id, doc_no, status, legal_entity_id, party_id, inter_state from sales.invoices where id = $1 for update`, [d.invoiceId])).rows[0];
  if (!inv) throw Errors.notFound('Invoice');
  if (inv.status !== 'Posted') throw Errors.state('Only a posted invoice can be credited.');
  const ils = (await tx.query(`select id, line_no, qty, rate, taxable, gst_rate from sales.invoice_lines where invoice_id = $1`, [inv.id])).rows;
  const done = await credited(tx, inv.id);
  const byQty = QTY_REASONS.includes(d.reason);
  const outs: { il: (typeof ils)[number]; qty: number | null; o: LineOut }[] = [];
  for (const x of d.lines) {
    const il = ils.find((y) => y.id === x.invoiceLineId);
    if (!il) throw Errors.rule('NOT_ON_INVOICE', 'A line is not on this invoice.');
    const prev = done.find((y) => y.id === il.id);
    let o: LineOut; let qty: number | null = null;
    if (byQty) {
      qty = Number(x.qty);
      if (!(qty > 0)) throw Errors.rule('QTY_REQUIRED', `Line ${il.line_no}: give the quantity credited.`);
      if (qty + Number(prev?.qty ?? 0) > Number(il.qty) + 1e-9) throw Errors.rule('OVER_CREDIT', `Line ${il.line_no}: ${Number(il.qty)} invoiced, ${Number(prev?.qty ?? 0)} already credited.`);
      o = calcLine({ qty, listRate: il.rate, schemePct: 0, extraPct: 0, gstRate: Number(il.gst_rate) }, inv.inter_state);
    } else {
      const tp = toPaise(Number(x.taxable));
      if (!(tp > 0)) throw Errors.rule('AMOUNT_REQUIRED', `Line ${il.line_no}: give the taxable amount credited.`);
      let cgst = 0; let sgst = 0; let igst = 0;
      if (inv.inter_state) igst = half((tp * Number(il.gst_rate)) / 100); else { cgst = half((tp * Number(il.gst_rate)) / 200); sgst = cgst; }
      o = { rate: 0, listAmount: tp, taxable: tp, cgst, sgst, igst, lineTotal: tp + cgst + sgst + igst };
    }
    if (toRupees(o.taxable) + Number(prev?.taxable ?? 0) > Number(il.taxable) + 0.005) throw Errors.rule('OVER_CREDIT', `Line ${il.line_no}: the credit exceeds the taxable value invoiced.`);
    outs.push({ il, qty, o });
  }
  const t = calcTotals(outs.map((x) => x.o));
  const docNo = await nextDocNo(tx, 'CREDIT_NOTE');
  const cn = (await tx.query(`insert into sales.credit_notes (doc_no, invoice_id, legal_entity_id, party_id, inter_state, note_date, reason, remarks, customer_return_id, shipment_id,
      taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17) returning id`,
    [docNo, inv.id, inv.legal_entity_id, inv.party_id, inv.inter_state, todayIST(), d.reason, d.remarks, d.customerReturnId ?? null, d.shipmentId ?? null,
      toRupees(t.taxableTotal), toRupees(t.cgstTotal), toRupees(t.sgstTotal), toRupees(t.igstTotal), toRupees(t.roundOff), toRupees(t.grandTotal), actor.userId])).rows[0];
  for (const x of outs) {
    const o = rs(x.o);
    await tx.query(`insert into sales.credit_note_lines (credit_note_id, invoice_line_id, qty, taxable, gst_rate, cgst, sgst, igst, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [cn.id, x.il.id, x.qty, o.taxable, x.il.gst_rate, o.cgst, o.sgst, o.igst, o.lineTotal]);
  }
  await audit(tx, actor, { action: 'sales.credit_note.drafted', entityType: 'sales.credit_note', entityId: cn.id, after: { docNo, invoice: inv.doc_no, reason: d.reason, grandTotal: toRupees(t.grandTotal) } });
  return { id: cn.id as string, docNo, grandTotal: toRupees(t.grandTotal) };
}

const invSel = `select i.id, i.doc_no as "docNo", i.legal_entity_id as "legalEntityId", le.name as "legalEntityName", le.registered_address as "sellerAddress", le.pan as "sellerPan", i.seller_state as "sellerState",
    i.seller_gstin as "sellerGstin", i.party_id as "partyId", p.legal_name as "partyName", p.code as "partyCode", i.party_gstin as "partyGstin", i.bill_to_id as "billToId", i.ship_to_id as "shipToId",
    i.place_of_supply as "placeOfSupply", i.inter_state as "interState", i.sales_order_id as "salesOrderId", so.doc_no as "salesOrderNo", so.dealer_po_no as "dealerPoNo", so.dealer_po_date as "dealerPoDate",
    i.shipment_id as "shipmentId", s.doc_no as "shipmentNo", s.vehicle_no as "vehicleNo", s.lr_no as "lrNo", s.lr_date as "lrDate", s.ewb_no as "ewbNo", t.name as "transporterName",
    i.invoice_date as "invoiceDate", i.due_date as "dueDate", i.payment_terms as "paymentTerms", i.status, i.status_reason as "statusReason", i.taxable_total as "taxableTotal", i.cgst_total as "cgstTotal",
    i.sgst_total as "sgstTotal", i.igst_total as "igstTotal", i.round_off as "roundOff", i.grand_total as "grandTotal", i.amount_settled as "amountSettled", i.grand_total - i.amount_settled as outstanding,
    i.irn, i.created_at as "createdAt", cu.full_name as "createdBy", i.cancelled_at as "cancelledAt", i.version
  from sales.invoices i join org.legal_entities le on le.id = i.legal_entity_id join mdm.parties p on p.id = i.party_id join sales.sales_orders so on so.id = i.sales_order_id
  join logistics.shipments s on s.id = i.shipment_id left join logistics.transporters t on t.id = s.transporter_id left join iam.users cu on cu.id = i.created_by`;
const cnSel = `select c.id, c.doc_no as "docNo", c.invoice_id as "invoiceId", i.doc_no as "invoiceNo", i.invoice_date as "invoiceDate", c.legal_entity_id as "legalEntityId", c.party_id as "partyId",
    p.legal_name as "partyName", p.code as "partyCode", i.party_gstin as "partyGstin", c.inter_state as "interState", c.note_date as "noteDate", c.reason, c.remarks, c.customer_return_id as "customerReturnId",
    r.doc_no as "customerReturnNo", c.shipment_id as "shipmentId", c.status, c.status_reason as "statusReason", c.taxable_total as "taxableTotal", c.cgst_total as "cgstTotal", c.sgst_total as "sgstTotal",
    c.igst_total as "igstTotal", c.round_off as "roundOff", c.grand_total as "grandTotal", c.approved_at as "approvedAt", c.created_at as "createdAt", cu.full_name as "createdBy", c.version
  from sales.credit_notes c join sales.invoices i on i.id = c.invoice_id join mdm.parties p on p.id = c.party_id left join sales.customer_returns r on r.id = c.customer_return_id
  left join iam.users cu on cu.id = c.created_by`;

function scopeSql(req: Request, perm: string, col: string, args: unknown[]) {
  const scope = legalEntityScope(req, perm);
  if (!scope) return 'true';
  args.push(scope);
  return `${col} = any($${args.length}::uuid[])`;
}

export function salesInvoiceRoutes(db: Db) {
  const r = Router();
  const P = (a: string) => `sales.invoice:${a}`;

  // shipments dispatched but not invoiced (when invoices are not raised at dispatch, or after a cancellation)
  r.get('/to-invoice', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const rows = (await db.query(`select s.id, s.doc_no as "docNo", s.dispatched_at as "dispatchedAt", so.doc_no as "salesOrderNo", p.legal_name as "partyName", s.status
        from logistics.shipments s join sales.sales_orders so on so.id = s.sales_order_id join mdm.parties p on p.id = s.party_id
       where s.status in ('Dispatched','Delivered') and ${scopeSql(req, P('view'), 's.legal_entity_id', args)}
         and not exists (select 1 from sales.invoices i where i.shipment_id = s.id and i.status <> 'Cancelled') order by s.dispatched_at`, args)).rows;
    res.json({ data: rows });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, P('view'), 'i.legal_entity_id', args)];
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`i.status = $${args.length}`); }
    const party = str(req.query.partyId);
    if (party) { args.push(party); where.push(`i.party_id = $${args.length}`); }
    const so = str(req.query.salesOrderId);
    if (so) { args.push(so); where.push(`i.sales_order_id = $${args.length}`); }
    const sh = str(req.query.shipmentId);
    if (sh) { args.push(sh); where.push(`i.shipment_id = $${args.length}`); }
    const qq = str(req.query.q);
    if (qq) { args.push(`%${qq}%`); where.push(`(i.doc_no ilike $${args.length} or p.legal_name ilike $${args.length} or so.doc_no ilike $${args.length})`); }
    const rows = (await db.query(`${invSel} where ${where.join(' and ')} order by i.invoice_date desc, i.doc_no desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [req.params.id];
    const inv = (await db.query(`${invSel} where i.id = $1 and ${scopeSql(req, P('view'), 'i.legal_entity_id', args)}`, args)).rows[0];
    if (!inv) throw Errors.notFound('Invoice');
    const lines = (await db.query(`select id, line_no as "lineNo", item_pack_id as "itemPackId", description, hsn_code as "hsnCode", pack_label as "packLabel", qty, list_rate as "listRate",
        scheme_discount_pct as "schemeDiscountPct", extra_discount_pct as "extraDiscountPct", rate, taxable, gst_rate as "gstRate", cgst, sgst, igst, line_total as "lineTotal", lots
        from sales.invoice_lines where invoice_id = $1 order by line_no`, [inv.id])).rows;
    const addresses = (await db.query(`select id, kind, label, line1, line2, city, district, state_code as "stateCode", pincode from mdm.party_addresses where id = any($1::uuid[])`, [[inv.billToId, inv.shipToId]])).rows;
    const notes = (await db.query(`select id, doc_no as "docNo", note_date as "noteDate", reason, status, grand_total as "grandTotal" from sales.credit_notes where invoice_id = $1 order by created_at`, [inv.id])).rows;
    const returns = (await db.query(`select id, doc_no as "docNo", received_on as "receivedOn", reason, status from sales.customer_returns where invoice_id = $1 order by created_at`, [inv.id])).rows;
    const done = await credited(db, inv.id);
    const hsn = Object.values(lines.reduce<Record<string, { hsnCode: string; gstRate: number; taxable: number; cgst: number; sgst: number; igst: number }>>((a, l) => {
      const k = `${l.hsnCode}|${l.gstRate}`;
      const x = (a[k] ??= { hsnCode: l.hsnCode, gstRate: Number(l.gstRate), taxable: 0, cgst: 0, sgst: 0, igst: 0 });
      x.taxable += Number(l.taxable); x.cgst += Number(l.cgst); x.sgst += Number(l.sgst); x.igst += Number(l.igst); return a;
    }, {})).map((x) => ({ ...x, taxable: Math.round(x.taxable * 100) / 100, cgst: Math.round(x.cgst * 100) / 100, sgst: Math.round(x.sgst * 100) / 100, igst: Math.round(x.igst * 100) / 100 }));
    const windowH = Number(await getSetting(db, 'sales.invoice.cancelWindowHours', 24));
    const cancellable = inv.status === 'Posted' && Number(inv.amountSettled) === 0 && !notes.some((n) => n.status !== 'Cancelled' && n.status !== 'Rejected')
      && Date.now() - new Date(inv.createdAt).getTime() < windowH * 3_600_000;
    const allowed: string[] = [];
    if (cancellable && can(req, P('cancel'))) allowed.push('cancel');
    if (inv.status === 'Posted' && can(req, 'sales.credit_note:create')) allowed.push('credit_note');
    if (inv.status === 'Posted' && can(req, 'sales.return:receive')) allowed.push('return');
    res.json({ ...inv, lines: lines.map((l) => ({ ...l, creditedQty: Number(done.find((d) => d.id === l.id)?.qty ?? 0), creditedTaxable: Number(done.find((d) => d.id === l.id)?.taxable ?? 0) })),
      billTo: addresses.find((a) => a.id === inv.billToId) ?? null, shipTo: addresses.find((a) => a.id === inv.shipToId) ?? null, creditNotes: notes, returns, hsnSummary: hsn,
      amountInWords: amountInWords(Number(inv.grandTotal)), bankDetails: await getSetting(db, 'company.bankDetails', ''), cancelWindowHours: windowH, allowedActions: allowed });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const { shipmentId } = parse(z.object({ shipmentId: z.string().uuid() }), req.body);
    const out = await withTx(db, async (tx) => {
      const s = (await tx.query(`select legal_entity_id from logistics.shipments where id = $1`, [shipmentId])).rows[0];
      const scope = legalEntityScope(req, P('create'));
      if (!s || (scope && !scope.includes(s.legal_entity_id))) throw Errors.notFound('Shipment');
      if ((await tx.query(`select 1 from sales.invoices where shipment_id = $1 and status <> 'Cancelled'`, [shipmentId])).rowCount) throw Errors.conflict('ALREADY_INVOICED', 'This shipment is already invoiced.');
      return raiseInvoice(tx, actorOf(req), shipmentId);
    });
    res.status(201).json(out);
  }));

  // FIN-003: cancellation only inside the window and before anything is settled or credited; the shipment can then be invoiced again
  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const inv = (await tx.query(`select id, status, amount_settled, created_at, legal_entity_id from sales.invoices where id = $1 for update`, [req.params.id])).rows[0];
      const scope = legalEntityScope(req, P('cancel'));
      if (!inv || (scope && !scope.includes(inv.legal_entity_id))) throw Errors.notFound('Invoice');
      if (inv.status !== 'Posted') throw Errors.state('This invoice is already cancelled.');
      const windowH = Number(await getSetting(tx, 'sales.invoice.cancelWindowHours', 24));
      if (Date.now() - new Date(inv.created_at).getTime() >= windowH * 3_600_000) throw Errors.rule('CANCEL_WINDOW_OVER', `An invoice can be cancelled only within ${windowH} hours; issue a credit note instead.`);
      if (Number(inv.amount_settled) !== 0) throw Errors.rule('INVOICE_SETTLED', 'Something is already settled against this invoice; issue a credit note instead.');
      if ((await tx.query(`select 1 from sales.credit_notes where invoice_id = $1 and status not in ('Cancelled','Rejected')`, [inv.id])).rowCount) throw Errors.rule('HAS_CREDIT_NOTES', 'Cancel its credit notes first.');
      if ((await tx.query(`select 1 from sales.customer_returns where invoice_id = $1`, [inv.id])).rowCount) throw Errors.rule('HAS_RETURNS', 'Goods were returned against this invoice; issue a credit note instead.');
      await setStatus(tx, actorOf(req), 'invoices', 'sales.invoice', inv.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));
  return r;
}

// ================================================================ credit notes (FIN-004)
export function creditNoteRoutes(db: Db) {
  const SUBJECT = 'sales.credit_note';
  const P = (a: string) => `sales.credit_note:${a}`;
  registerSubjectHandler(SUBJECT, {
    onApproved: async (tx, rq, a) => {
      await setStatus(tx, a, 'credit_notes', SUBJECT, rq.subject_id, 'Approved');
      await tx.query(`update sales.invoices i set amount_settled = amount_settled + c.grand_total from sales.credit_notes c where c.id = $1 and i.id = c.invoice_id`, [rq.subject_id]);
    },
    onRejected: (tx, rq, a) => setStatus(tx, a, 'credit_notes', SUBJECT, rq.subject_id, 'Rejected', 'Not approved'),
    onReturned: (tx, rq, a) => setStatus(tx, a, 'credit_notes', SUBJECT, rq.subject_id, 'Draft', 'Returned for changes'),
    onCancelled: (tx, rq, a) => setStatus(tx, a, 'credit_notes', SUBJECT, rq.subject_id, 'Draft'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const c = (await dbx.query(`${cnSel} where c.id = $1 and ${scopeSql(req, P('view'), 'c.legal_entity_id', args)} ${lock ? 'for update of c' : ''}`, args)).rows[0];
    if (!c) throw Errors.notFound('Credit note');
    return c;
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, P('view'), 'c.legal_entity_id', args)];
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`c.status = $${args.length}`); }
    const inv = str(req.query.invoiceId);
    if (inv) { args.push(inv); where.push(`c.invoice_id = $${args.length}`); }
    const rows = (await db.query(`${cnSel} where ${where.join(' and ')} order by c.created_at desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const c = await load(db, req, req.params.id!);
    const lines = (await db.query(`select cl.id, cl.invoice_line_id as "invoiceLineId", il.line_no as "lineNo", il.description, il.hsn_code as "hsnCode", il.pack_label as "packLabel", il.rate,
        cl.qty, cl.taxable, cl.gst_rate as "gstRate", cl.cgst, cl.sgst, cl.igst, cl.line_total as "lineTotal"
        from sales.credit_note_lines cl join sales.invoice_lines il on il.id = cl.invoice_line_id where cl.credit_note_id = $1 order by il.line_no`, [c.id])).rows;
    const approval = (await db.query(`select id, doc_no as "docNo", status from wf.approval_requests where subject_type = $1 and subject_id = $2 order by submitted_at desc limit 1`, [SUBJECT, c.id])).rows[0] ?? null;
    const seller = (await db.query(`select le.name, le.registered_address as address, le.pan, i.seller_gstin as gstin from sales.invoices i join org.legal_entities le on le.id = i.legal_entity_id where i.id = $1`, [c.invoiceId])).rows[0];
    const allowed: string[] = [];
    if (c.status === 'Draft' && can(req, P('submit'))) allowed.push('submit');
    if (['Draft', 'Rejected'].includes(c.status) && can(req, P('cancel'))) allowed.push('cancel');
    res.json({ ...c, lines, approval, seller, amountInWords: amountInWords(Number(c.grandTotal)), allowedActions: allowed });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ invoiceId: z.string().uuid(), reason: z.enum(CN_REASONS), remarks: opt(1000), shipmentId: z.string().uuid().optional().nullable(),
      lines: z.array(z.object({ invoiceLineId: z.string().uuid(), qty: z.number().positive().optional().nullable(), taxable: z.number().positive().optional().nullable() })).min(1).max(100) })
      .refine((x) => x.reason !== 'RETURN', { message: 'A return credit note is drafted when the goods are received back', path: ['reason'] })
      .refine((x) => QTY_REASONS.includes(x.reason) || !!x.remarks, { message: 'Explain the rate difference or scheme', path: ['remarks'] }), req.body);
    const out = await withTx(db, async (tx) => {
      const inv = (await tx.query(`select legal_entity_id from sales.invoices where id = $1`, [d.invoiceId])).rows[0];
      const scope = legalEntityScope(req, P('create'));
      if (!inv || (scope && !scope.includes(inv.legal_entity_id))) throw Errors.notFound('Invoice');
      return draftCreditNote(tx, actorOf(req), { ...d, shipmentId: d.shipmentId ?? null });
    });
    res.status(201).json(out);
  }));

  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const c = await load(tx, req, req.params.id!, true);
      if (c.status !== 'Draft') throw Errors.state(`A ${c.status} credit note cannot be submitted.`);
      await setStatus(tx, actorOf(req), 'credit_notes', SUBJECT, c.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: c.id, subjectLabel: `${c.docNo} — ${c.partyName} against ${c.invoiceNo}`,
        facts: { amount: Number(c.grandTotal), reason: c.reason }, legalEntityId: c.legalEntityId });
      return { approvalRequestId: ar.id as string, approvalDocNo: ar.doc_no as string, status: ar.status === 'Approved' ? 'Approved' : 'Submitted' };
    });
    res.json(out);
  }));

  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const c = await load(tx, req, req.params.id!, true);
      if (!['Draft', 'Rejected'].includes(c.status)) throw Errors.state(`A ${c.status} credit note cannot be cancelled.`);
      await withdrawOpenRequests(tx, SUBJECT, [c.id]);
      await setStatus(tx, actorOf(req), 'credit_notes', SUBJECT, c.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));
  return r;
}

// ================================================================ customer returns (LOG-012, FIN-005)
export function customerReturnRoutes(db: Db) {
  const r = Router();
  const P = (a: string) => `sales.return:${a}`;
  const sel = `select r.id, r.doc_no as "docNo", r.invoice_id as "invoiceId", i.doc_no as "invoiceNo", r.legal_entity_id as "legalEntityId", r.party_id as "partyId", p.legal_name as "partyName",
      r.warehouse_id as "warehouseId", w.code as "warehouseCode", r.received_on as "receivedOn", r.reason, r.remarks, r.transport_ref as "transportRef", r.status, r.complaint_id as "complaintId",
      r.created_at as "createdAt", cu.full_name as "createdBy",
      (select c.id from sales.credit_notes c where c.customer_return_id = r.id and c.status <> 'Cancelled' order by c.created_at desc limit 1) as "creditNoteId",
      (select c.doc_no from sales.credit_notes c where c.customer_return_id = r.id and c.status <> 'Cancelled' order by c.created_at desc limit 1) as "creditNoteNo"
    from sales.customer_returns r join sales.invoices i on i.id = r.invoice_id join mdm.parties p on p.id = r.party_id join org.warehouses w on w.id = r.warehouse_id
    left join iam.users cu on cu.id = r.created_by`;

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scopeSql(req, P('view'), 'r.legal_entity_id', args)];
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`r.status = $${args.length}`); }
    const rows = (await db.query(`${sel} where ${where.join(' and ')} order by r.created_at desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const x = (await dbx.query(`${sel} where r.id = $1 and ${scopeSql(req, P('view'), 'r.legal_entity_id', args)} ${lock ? 'for update of r' : ''}`, args)).rows[0];
    if (!x) throw Errors.notFound('Customer return');
    return x;
  }
  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const x = await load(db, req, req.params.id!);
    const lines = (await db.query(`select l.id, l.invoice_line_id as "invoiceLineId", il.line_no as "lineNo", il.description, il.pack_label as "packLabel", l.lot_id as "lotId", lt.lot_no as "lotNo",
        l.packs, l.qty, i.base_uom as uom, l.unit_cost as "unitCost", l.condition, l.disposition, du.full_name as "decidedBy", l.decided_at as "decidedAt", l.decision_remarks as "decisionRemarks"
        from sales.customer_return_lines l join sales.invoice_lines il on il.id = l.invoice_line_id join inv.lots lt on lt.id = l.lot_id join mdm.items i on i.id = lt.item_id
        left join iam.users du on du.id = l.decided_by where l.return_id = $1 order by il.line_no, lt.lot_no`, [x.id])).rows;
    res.json({ ...x, lines, allowedActions: x.status === 'AwaitingQa' && can(req, P('decide')) ? ['decide'] : [] });
  }));

  // receive goods back against an invoice: into quarantine at the cost they left with, and a draft credit note for accounts
  r.post('/', requirePermission(P('receive')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ invoiceId: z.string().uuid(), warehouseId: z.string().uuid(), receivedOn: day, reason: z.enum(['DAMAGED', 'LEAKAGE', 'EXPIRED', 'WRONG_PRODUCT', 'QUALITY_COMPLAINT', 'EXCESS', 'OTHER']),
      remarks: opt(1000), transportRef: opt(60), complaintId: z.string().uuid().optional().nullable(),
      lines: z.array(z.object({ invoiceLineId: z.string().uuid(), lotId: z.string().uuid(), packs: z.number().positive(), condition: opt(300) })).min(1).max(100) }), req.body);
    const out = await withTx(db, async (tx) => {
      const inv = (await tx.query(`select id, doc_no, status, legal_entity_id, party_id from sales.invoices where id = $1 for update`, [d.invoiceId])).rows[0];
      const scope = legalEntityScope(req, P('receive'));
      if (!inv || (scope && !scope.includes(inv.legal_entity_id))) throw Errors.notFound('Invoice');
      if (inv.status !== 'Posted') throw Errors.state('Goods can be returned only against a posted invoice.');
      if (d.receivedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'The date received cannot be in the future.');
      const wh = (await tx.query(`select status, legal_entity_id, type from org.warehouses where id = $1`, [d.warehouseId])).rows[0];
      if (wh?.status !== 'Active' || wh.legal_entity_id !== inv.legal_entity_id || !['FG', 'GENERAL', 'QUARANTINE'].includes(wh.type)) throw Errors.rule('WRONG_WAREHOUSE', 'Receive returns into an active finished-goods or quarantine store of the invoicing entity.');
      const ils = (await tx.query(`select il.id, il.line_no, il.qty, il.lots, ip.pack_size, ip.pack_uom from sales.invoice_lines il join mdm.item_packs ip on ip.id = il.item_pack_id where il.invoice_id = $1`, [inv.id])).rows;
      const back = (await tx.query(`select l.invoice_line_id, l.lot_id, sum(l.packs) as packs from sales.customer_return_lines l join sales.customer_returns r on r.id = l.return_id
          where r.invoice_id = $1 group by 1, 2`, [inv.id])).rows;
      const docNo = await nextDocNo(tx, 'CUSTOMER_RETURN');
      const ret = (await tx.query(`insert into sales.customer_returns (doc_no, invoice_id, legal_entity_id, party_id, warehouse_id, received_on, reason, remarks, transport_ref, complaint_id, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
        [docNo, inv.id, inv.legal_entity_id, inv.party_id, d.warehouseId, d.receivedOn, d.reason, d.remarks, d.transportRef, d.complaintId ?? null, req.auth!.user.id])).rows[0];
      const perLine = new Map<string, number>();
      for (const x of d.lines) {
        const il = ils.find((y) => y.id === x.invoiceLineId);
        if (!il) throw Errors.rule('NOT_ON_INVOICE', 'A line is not on this invoice.');
        const lot = (il.lots as { lotId: string; lotNo: string; packs: number; unitCost: number }[]).find((y) => y.lotId === x.lotId);
        if (!lot) throw Errors.rule('LOT_NOT_INVOICED', `Line ${il.line_no}: that lot did not go out on this invoice.`);
        const before = Number(back.find((y) => y.invoice_line_id === il.id && y.lot_id === x.lotId)?.packs ?? 0);
        if (x.packs + before > Number(lot.packs) + 1e-9) throw Errors.rule('OVER_RETURN', `Line ${il.line_no}, lot ${lot.lotNo}: ${Number(lot.packs)} sent, ${before} already returned.`);
        if (il.pack_uom !== (await tx.query(`select i.base_uom from inv.lots l join mdm.items i on i.id = l.item_id where l.id = $1`, [x.lotId])).rows[0].base_uom) throw Errors.rule('NO_CONVERSION', 'The pack unit differs from the stock unit.');
        const qty = Math.round(x.packs * Number(il.pack_size) * 10000) / 10000;
        await tx.query(`insert into sales.customer_return_lines (return_id, invoice_line_id, lot_id, packs, qty, unit_cost, condition) values ($1,$2,$3,$4,$5,$6,$7)`,
          [ret.id, il.id, x.lotId, x.packs, qty, Number(lot.unitCost), x.condition]);
        const item = (await tx.query(`select item_id from inv.lots where id = $1`, [x.lotId])).rows[0].item_id;
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,'QUARANTINE',$4,$5,'CUSTOMER_RETURN','sales.customer_return',$6,$7)`, [item, x.lotId, d.warehouseId, qty, Number(lot.unitCost), ret.id, req.auth!.user.id]);
        perLine.set(il.id, (perLine.get(il.id) ?? 0) + x.packs);
      }
      const cn = await draftCreditNote(tx, actorOf(req), { invoiceId: inv.id, reason: 'RETURN', remarks: `Goods returned on ${docNo}`, customerReturnId: ret.id,
        lines: [...perLine.entries()].map(([invoiceLineId, qty]) => ({ invoiceLineId, qty })) });
      await audit(tx, actorOf(req), { action: 'sales.customer_return.received', entityType: 'sales.customer_return', entityId: ret.id, after: { docNo, invoice: inv.doc_no, creditNote: cn.docNo, lines: d.lines } });
      await emit(tx, 'sales.customer_return', ret.id, 'sales.customer_return.received');
      return { id: ret.id as string, docNo, creditNoteId: cn.id, creditNoteNo: cn.docNo };
    });
    res.status(201).json(out);
  }));

  // QA decides each line: restock to unrestricted stock, or reject to the rejected bucket
  r.post('/:id/decide', requirePermission(P('decide')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), disposition: z.enum(['Restock', 'Reject']), remarks: opt(500) })).min(1) }), req.body);
    const out = await withTx(db, async (tx) => {
      const x = await load(tx, req, req.params.id!, true);
      if (x.status !== 'AwaitingQa') throw Errors.state('This return is already closed.');
      for (const l of d.lines) {
        const rl = (await tx.query(`select l.id, l.lot_id, l.qty, l.unit_cost, l.disposition, lt.item_id, lt.qc_status, lt.lot_no from sales.customer_return_lines l join inv.lots lt on lt.id = l.lot_id
            where l.id = $1 and l.return_id = $2 for update of l`, [l.lineId, x.id])).rows[0];
        if (!rl) throw Errors.notFound('Return line');
        if (rl.disposition) throw Errors.state(`Lot ${rl.lot_no} on this return is already decided.`);
        if (l.disposition === 'Restock' && rl.qc_status !== 'Released') throw Errors.rule('LOT_NOT_RELEASED', `Lot ${rl.lot_no} is ${String(rl.qc_status).toLowerCase()}; it cannot go back to saleable stock.`);
        const to = l.disposition === 'Restock' ? 'UNRESTRICTED' : 'REJECTED';
        const txn = l.disposition === 'Restock' ? 'QA_RELEASE' : 'QA_REJECT';
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by) values
          ($1,$2,$3,'QUARANTINE',$4,$5,$6,'sales.customer_return',$7,$8), ($1,$2,$3,$9,$10,$5,$6,'sales.customer_return',$7,$8)`,
          [rl.item_id, rl.lot_id, x.warehouseId, -Number(rl.qty), Number(rl.unit_cost), txn, x.id, req.auth!.user.id, to, Number(rl.qty)]);
        await tx.query(`update sales.customer_return_lines set disposition = $2, decided_by = $3, decided_at = now(), decision_remarks = $4 where id = $1`, [rl.id, l.disposition, req.auth!.user.id, l.remarks]);
      }
      const open = Number((await tx.query(`select count(*) from sales.customer_return_lines where return_id = $1 and disposition is null`, [x.id])).rows[0].count);
      await audit(tx, actorOf(req), { action: 'sales.customer_return.decided', entityType: 'sales.customer_return', entityId: x.id, after: d });
      if (!open) {
        await allowTransition(tx);
        await tx.query(`update sales.customer_returns set status = 'Closed', updated_by = $2 where id = $1`, [x.id, req.auth!.user.id]);
        await emit(tx, 'sales.customer_return', x.id, 'sales.customer_return.closed');
      }
      return { status: open ? 'AwaitingQa' : 'Closed', open };
    });
    res.json(out);
  }));
  return r;
}
