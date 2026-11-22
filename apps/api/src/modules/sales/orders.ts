import { Router, type Request } from 'express';
import { z } from 'zod';
import { convertQuotationSchema, reasonSchema, salesOrderHeaderSchema, salesOrderSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { creditExposure } from '../finance/receivables';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';
import { amountInWords, toRupees } from './calc';
import { buildQuote, lineOut, pricedPacks, rupees, scopeSql, setQuotationStatus, todayIST, type Built } from './quotations';

type OrderInput = z.infer<typeof salesOrderSchema>;
const SUBJECT = 'sales.order';
const CONVERTIBLE = ['Approved', 'Sent', 'Accepted'];

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null, extra: Record<string, unknown> = {}) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from sales.sales_orders where id = $1`, [id])).rows[0];
  await tx.query(`update sales.sales_orders set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    approved_at = case when $2 = 'Approved' then now() else approved_at end where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status, ...extra }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/**
 * Credit position used for routing (SO-004, D18): exposure = unpaid invoices + other orders not yet invoiced − unapplied receipts, plus this order.
 * A dealer with no credit limit and no credit days is an advance-payment dealer: accounts confirm payment instead.
 */
async function creditPosition(tx: Tx, partyId: string, orderId: string | null, orderValue: number) {
  const e = await creditExposure(tx, partyId, orderId);
  const exposure = Math.round((e.exposure + orderValue) * 100) / 100;
  return { creditLimit: e.creditLimit, openOrderValue: e.uninvoicedOrders, outstanding: e.outstanding, overdue: e.overdue, onAccount: e.onAccount, exposure,
    advancePayment: e.advancePayment, overCreditLimit: !e.advancePayment && exposure > e.creditLimit, frozen: e.frozen, overdueInvoices: e.overdueInvoices };
}

const orderSelect = `select o.id, o.doc_no as "docNo", o.party_id as "partyId", p.code as "partyCode", p.legal_name as "partyName", p.gstin as "partyGstin",
    o.legal_entity_id as "legalEntityId", le.name as "legalEntityName", o.seller_state as "sellerState", o.bill_to_id as "billToId", o.ship_to_id as "shipToId",
    o.place_of_supply as "placeOfSupply", o.inter_state as "interState", o.order_date as "orderDate", o.required_by as "requiredBy",
    o.dealer_po_no as "dealerPoNo", o.dealer_po_date as "dealerPoDate", o.quotation_id as "quotationId", q.doc_no as "quotationNo", q.revision as "quotationRevision",
    o.price_list_id as "priceListId", pl.code as "priceListCode", o.contact_person as "contactPerson", o.payment_terms as "paymentTerms",
    o.delivery_terms as "deliveryTerms", o.notes, o.sales_owner_id as "salesOwnerId", e.full_name as "salesOwner", o.territory_id as "territoryId",
    t.name as territory, o.opportunity_id as "opportunityId", op.code as "opportunityCode", o.status, o.status_reason as "statusReason",
    o.max_extra_discount as "maxExtraDiscount", o.credit_limit as "creditLimit", o.open_order_value as "openOrderValue", o.outstanding_value as "outstandingValue", o.overdue_value as "overdueValue", o.on_account_value as "onAccountValue", o.over_credit_limit as "overCreditLimit",
    o.sub_total as "subTotal", o.discount_total as "discountTotal", o.taxable_total as "taxableTotal", o.cgst_total as "cgstTotal", o.sgst_total as "sgstTotal",
    o.igst_total as "igstTotal", o.round_off as "roundOff", o.grand_total as "grandTotal", o.approved_at as "approvedAt", o.created_at as "createdAt",
    o.updated_at as "updatedAt", o.version
  from sales.sales_orders o join mdm.parties p on p.id = o.party_id join org.legal_entities le on le.id = o.legal_entity_id
  join org.employees e on e.id = o.sales_owner_id join org.territories t on t.id = o.territory_id
  left join sales.quotations q on q.id = o.quotation_id left join sales.price_lists pl on pl.id = o.price_list_id left join sales.opportunities op on op.id = o.opportunity_id`;

const HEADER_COLS = ['seller_state', 'place_of_supply', 'inter_state', 'price_list_id', 'max_extra_discount',
  'sub_total', 'discount_total', 'taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'round_off', 'grand_total'];
const headerValues = (b: Built) => {
  const t = rupees(b);
  return [b.sellerState, b.placeOfSupply, b.interState, b.priceListId, b.maxExtraDiscount,
    t.subTotal, t.discountTotal, t.taxableTotal, t.cgstTotal, t.sgstTotal, t.igstTotal, t.roundOff, t.grandTotal];
};

async function writeLines(tx: Tx, orderId: string, b: Built) {
  await tx.query(`delete from sales.sales_order_lines where sales_order_id = $1`, [orderId]);
  for (const l of b.lines) {
    await tx.query(
      `insert into sales.sales_order_lines (sales_order_id, line_no, item_pack_id, description, hsn_code, pack_label, qty, list_rate, scheme_discount_pct,
         extra_discount_pct, rate, taxable, gst_rate, cgst, sgst, igst, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [orderId, l.lineNo, l.itemPackId, l.description, l.hsnCode, l.packLabel, l.qty, l.listRate, l.schemeDiscountPct, l.extraDiscountPct,
        toRupees(l.calc.rate), toRupees(l.calc.taxable), l.gstRate, toRupees(l.calc.cgst), toRupees(l.calc.sgst), toRupees(l.calc.igst), toRupees(l.calc.lineTotal)]);
  }
}

function allowedActions(req: Request, status: string) {
  const out: string[] = [];
  if (['Draft', 'Rejected'].includes(status)) {
    if (can(req, 'sales.order:edit')) out.push('edit');
    if (can(req, 'sales.order:submit')) out.push('submit');
  }
  // dispatch does not exist yet (Stage 5); once it does, an approved order with dispatches can only be short-closed
  if (['Draft', 'Rejected', 'Approved'].includes(status) && can(req, 'sales.order:cancel')) out.push('cancel');
  return out;
}

export function salesOrderRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Approved'),
    onRejected: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft'),
    onCancelled: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, perm = 'sales.order:view', lock = false) {
    const args: unknown[] = [id];
    const s = await scopeSql(dbx, req, perm, 'o.territory_id', args);
    const row = (await dbx.query(`${orderSelect} where o.id = $1 and ${s} ${lock ? 'for update of o' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Sales order');
    return row;
  }
  const orderDateOf = (d?: string | null) => {
    const today = todayIST();
    if (d && d > today) throw Errors.rule('FUTURE_DATE', 'The order date cannot be in the future.');
    return d ?? today;
  };
  async function owner(tx: Tx, req: Request, dealer: Built['dealer']) {
    const emp = req.auth!.user.employeeId;
    if (emp && (await tx.query(`select 1 from org.employees where id = $1 and status = 'Active'`, [emp])).rowCount) return emp;
    return dealer.sales_owner_id as string;
  }
  /** Lines of a converted order are locked to the quotation's rates and schemes. */
  async function lockedRates(tx: Tx, quotationId: string) {
    const q = (await tx.query(`select price_list_id from sales.quotations where id = $1`, [quotationId])).rows[0];
    const lines = (await tx.query(`select item_pack_id, list_rate, scheme_discount_pct from sales.quotation_lines where quotation_id = $1`, [quotationId])).rows;
    return { priceListId: q.price_list_id as string | null, rates: new Map(lines.map((l) => [l.item_pack_id as string, { listRate: Number(l.list_rate), schemePct: Number(l.scheme_discount_pct) }])) };
  }
  async function inputOf(tx: Tx, id: string): Promise<OrderInput> {
    const o = (await tx.query(`select * from sales.sales_orders where id = $1`, [id])).rows[0];
    const lines = (await tx.query(`select item_pack_id, qty, extra_discount_pct from sales.sales_order_lines where sales_order_id = $1 order by line_no`, [id])).rows;
    return { partyId: o.party_id, legalEntityId: o.legal_entity_id, billToId: o.bill_to_id, shipToId: o.ship_to_id, contactPerson: o.contact_person ?? undefined,
      paymentTerms: o.payment_terms, deliveryTerms: o.delivery_terms, notes: o.notes ?? undefined, opportunityId: o.opportunity_id,
      requiredBy: o.required_by, dealerPoNo: o.dealer_po_no, dealerPoDate: o.dealer_po_date,
      lines: lines.map((l) => ({ itemPackId: l.item_pack_id, qty: Number(l.qty), extraDiscountPct: Number(l.extra_discount_pct) })) };
  }
  async function insertOrder(tx: Tx, req: Request, d: OrderInput, b: Built, orderDate: string, quotationId: string | null) {
    const docNo = await nextDocNo(tx, 'SALES_ORDER');
    const cols = ['doc_no', 'party_id', 'legal_entity_id', 'bill_to_id', 'ship_to_id', 'order_date', 'required_by', 'dealer_po_no', 'dealer_po_date', 'quotation_id',
      'contact_person', 'payment_terms', 'delivery_terms', 'notes', 'sales_owner_id', 'territory_id', 'opportunity_id', 'created_by', 'updated_by', ...HEADER_COLS];
    const vals = [docNo, d.partyId, d.legalEntityId, d.billToId, d.shipToId, orderDate, d.requiredBy ?? null, d.dealerPoNo ?? null, d.dealerPoDate ?? null, quotationId,
      d.contactPerson ?? null, d.paymentTerms, d.deliveryTerms, d.notes ?? null, await owner(tx, req, b.dealer), b.dealer.territory_id, d.opportunityId ?? null,
      req.auth!.user.id, req.auth!.user.id, ...headerValues(b)];
    const o = (await tx.query(`insert into sales.sales_orders (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`, vals)).rows[0];
    await writeLines(tx, o.id, b);
    return { id: o.id as string, docNo };
  }
  const checkDates = (d: { requiredBy?: string | null; dealerPoDate?: string | null }, orderDate: string) => {
    if (d.requiredBy && d.requiredBy < orderDate) throw Errors.rule('INVALID_DATE', 'The required-by date cannot be before the order date.');
    if (d.dealerPoDate && d.dealerPoDate > todayIST()) throw Errors.rule('INVALID_DATE', 'The dealer PO date cannot be in the future.');
  };

  // ------------------------------------------------------------------ helpers for the editor
  r.get('/defaults', requirePermission('sales.order:create'), asyncHandler(async (_req, res) => {
    res.json({ paymentTerms: await getSetting(db, 'sales.defaultPaymentTerms', ''), deliveryTerms: await getSetting(db, 'sales.defaultDeliveryTerms', ''), today: todayIST() });
  }));
  r.get('/priced-packs', requirePermission('sales.order:create'), asyncHandler(async (req, res) => {
    const partyId = str(req.query.partyId);
    if (!partyId) throw Errors.validation([{ field: 'partyId', message: 'Choose a dealer' }]);
    res.json({ data: await pricedPacks(db, partyId, str(req.query.date) ?? todayIST()) });
  }));
  r.post('/calculate', requirePermission('sales.order:create'), asyncHandler(async (req, res) => {
    const d = parse(salesOrderSchema, req.body);
    const b = await buildQuote(db, req, d, orderDateOf(d.orderDate), false, 'sales.order:create');
    res.json({ lines: b.lines.map(lineOut), totals: rupees(b), interState: b.interState, sellerState: b.sellerState, placeOfSupply: b.placeOfSupply,
      maxExtraDiscount: b.maxExtraDiscount, warnings: b.warnings, amountInWords: amountInWords(toRupees(b.totals.grandTotal)) });
  }));

  // ------------------------------------------------------------------ register and detail
  r.get('/', requirePermission('sales.order:view'), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = [await scopeSql(db, req, 'sales.order:view', 'o.territory_id', args)];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(o.doc_no ilike $${args.length} or p.legal_name ilike $${args.length} or p.code ilike $${args.length} or o.dealer_po_no ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`o.status = $${args.length}`); }
    const party = str(req.query.partyId);
    if (party) { args.push(party); where.push(`o.party_id = $${args.length}`); }
    if (req.query.mine === 'true' && req.auth!.user.employeeId) { args.push(req.auth!.user.employeeId); where.push(`o.sales_owner_id = $${args.length}`); }
    const rows = await db.query(`${orderSelect.replace('select o.id,', 'select count(*) over() as total, o.id,')} where ${where.join(' and ')}
      order by o.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission('sales.order:view'), asyncHandler(async (req, res) => {
    const o = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select l.line_no as "lineNo", l.item_pack_id as "itemPackId", i.code as "itemCode", l.description, l.hsn_code as "hsnCode", l.pack_label as "packLabel",
              l.qty, l.list_rate as "listRate", l.scheme_discount_pct as "schemeDiscountPct", l.extra_discount_pct as "extraDiscountPct", l.rate, l.taxable,
              l.gst_rate as "gstRate", l.cgst, l.sgst, l.igst, l.line_total as "lineTotal", l.dispatched_qty as "dispatchedQty"
         from sales.sales_order_lines l join mdm.item_packs p on p.id = l.item_pack_id join mdm.items i on i.id = p.item_id where l.sales_order_id = $1 order by l.line_no`, [o.id])).rows;
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, a.rule_name as "ruleName",
              (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'kind', s.step_kind, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, o.id])).rows[0] ?? null;
    const addresses = (await db.query(`select id, kind, label, line1, line2, city, district, state_code as "stateCode", pincode from mdm.party_addresses where id = any($1::uuid[])`,
      [[o.billToId, o.shipToId]])).rows;
    const seller = (await db.query(
      `select le.name, le.registered_address as address, le.pan, g.gstin from org.legal_entities le
         left join org.gst_registrations g on g.legal_entity_id = le.id and g.state_code = $2 and g.status = 'Active' where le.id = $1`, [o.legalEntityId, o.sellerState])).rows[0];
    // live credit position for an order not yet decided; the snapshot taken at submission otherwise
    const credit = ['Draft', 'Rejected'].includes(o.status) ? await withTx(db, (tx) => creditPosition(tx, o.partyId, o.id, Number(o.grandTotal))) : null;
    res.json({
      ...o, lines, approval, allowedActions: allowedActions(req, o.status), liveCredit: credit,
      billTo: addresses.find((a) => a.id === o.billToId) ?? null, shipTo: addresses.find((a) => a.id === o.shipToId) ?? null,
      print: { seller, bankDetails: await getSetting(db, 'company.bankDetails', ''), amountInWords: amountInWords(Number(o.grandTotal)) },
    });
  }));

  // ------------------------------------------------------------------ create: direct, or from a quotation
  r.post('/', requirePermission('sales.order:create'), asyncHandler(async (req, res) => {
    const d = parse(salesOrderSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const orderDate = orderDateOf(d.orderDate);
      checkDates(d, orderDate);
      if (d.opportunityId) {
        const opp = (await tx.query(`select party_id from sales.opportunities where id = $1`, [d.opportunityId])).rows[0];
        if (!opp || (opp.party_id && opp.party_id !== d.partyId)) throw Errors.rule('OPPORTUNITY_MISMATCH', 'The opportunity belongs to a different dealer.');
      }
      const b = await buildQuote(tx, req, d, orderDate, true, 'sales.order:create');
      const o = await insertOrder(tx, req, d, b, orderDate, null);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: o.id, after: { docNo: o.docNo, grandTotal: toRupees(b.totals.grandTotal), lines: d.lines } });
      return o;
    });
    res.status(201).json(out);
  }));

  // SO-002: an approved, sent or accepted quotation that is still valid converts once; its rates and schemes carry over, GST is taken on the order date.
  r.post('/from-quotation/:quotationId', requirePermission('sales.order:create'), asyncHandler(async (req, res) => {
    const extras = parse(convertQuotationSchema, req.body ?? {});
    const out = await withTx(db, async (tx) => {
      const args: unknown[] = [req.params.quotationId];
      const q = (await tx.query(`select q.* from sales.quotations q where q.id = $1 and ${await scopeSql(tx, req, 'sales.order:create', 'q.territory_id', args)} for update`, args)).rows[0];
      if (!q) throw Errors.notFound('Quotation');
      if (!CONVERTIBLE.includes(q.status)) throw Errors.state(`Only an approved, sent or accepted quotation can be converted (this one is ${q.status}).`);
      const orderDate = todayIST();
      if (String(q.valid_until) < orderDate) throw Errors.rule('QUOTATION_EXPIRED', 'The quotation has expired. Revise it and get it approved again before converting.');
      checkDates(extras, orderDate);
      const lines = (await tx.query(`select item_pack_id, qty, extra_discount_pct from sales.quotation_lines where quotation_id = $1 order by line_no`, [q.id])).rows;
      const d: OrderInput = {
        partyId: q.party_id, legalEntityId: q.legal_entity_id, billToId: q.bill_to_id, shipToId: q.ship_to_id, contactPerson: q.contact_person ?? undefined,
        paymentTerms: q.payment_terms, deliveryTerms: q.delivery_terms, notes: q.notes ?? undefined, opportunityId: q.opportunity_id,
        ...extras,
        lines: lines.map((l) => ({ itemPackId: l.item_pack_id, qty: Number(l.qty), extraDiscountPct: Number(l.extra_discount_pct) })),
      };
      const b = await buildQuote(tx, req, d, orderDate, true, 'sales.order:create', await lockedRates(tx, q.id));
      const o = await insertOrder(tx, req, d, b, orderDate, q.id);
      await setQuotationStatus(tx, actorOf(req), q.id, 'Converted', `Converted to sales order ${o.docNo}`);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: o.id,
        after: { docNo: o.docNo, fromQuotation: `${q.doc_no} R${q.revision}`, grandTotal: toRupees(b.totals.grandTotal) } });
      return o;
    });
    res.status(201).json(out);
  }));

  // ------------------------------------------------------------------ edit (Draft / Rejected)
  r.put('/:id', requirePermission('sales.order:edit'), asyncHandler(async (req, res) => {
    const { version } = parse(z.object({ version: z.number().int() }), req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, 'sales.order:edit', true);
      if (!['Draft', 'Rejected'].includes(o.status)) throw Errors.state(`A ${o.status} sales order cannot be edited.`);
      if (o.version !== version) throw Errors.concurrent();
      let d: OrderInput;
      let b: Built;
      if (o.quotationId) {
        // lines, dealer and addresses come from the quotation; only the order header can change
        if ('lines' in req.body) throw Errors.rule('LINES_LOCKED', 'This order was converted from a quotation, so its products and prices are locked. Cancel it and revise the quotation to change them.');
        const h = parse(salesOrderHeaderSchema, req.body);
        checkDates(h, o.orderDate);
        d = { ...(await inputOf(tx, o.id)), ...h };
        b = await buildQuote(tx, req, d, o.orderDate, true, 'sales.order:edit', await lockedRates(tx, o.quotationId));
      } else {
        d = parse(salesOrderSchema, req.body);
        if (d.partyId !== o.partyId) throw Errors.rule('PARTY_LOCKED', 'The dealer of an order cannot be changed. Cancel it and create a new order.');
        checkDates(d, o.orderDate);
        b = await buildQuote(tx, req, d, o.orderDate, true, 'sales.order:edit');
      }
      const cols = ['legal_entity_id', 'bill_to_id', 'ship_to_id', 'required_by', 'dealer_po_no', 'dealer_po_date', 'contact_person', 'payment_terms', 'delivery_terms',
        'notes', 'updated_by', ...HEADER_COLS];
      const vals = [d.legalEntityId, d.billToId, d.shipToId, d.requiredBy ?? null, d.dealerPoNo ?? null, d.dealerPoDate ?? null, d.contactPerson ?? null,
        d.paymentTerms, d.deliveryTerms, d.notes ?? null, req.auth!.user.id, ...headerValues(b)];
      await tx.query(`update sales.sales_orders set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [o.id, ...vals]);
      await writeLines(tx, o.id, b);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: o.id,
        before: { grandTotal: Number(o.grandTotal) }, after: { grandTotal: toRupees(b.totals.grandTotal), lines: d.lines } });
    });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ submit (D01 hybrid) and cancel
  r.post('/:id/submit', requirePermission('sales.order:submit'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, 'sales.order:submit', true);
      if (!['Draft', 'Rejected'].includes(o.status)) throw Errors.state(`Only a Draft or Rejected order can be submitted (this one is ${o.status}).`);
      // re-check prices, tax and dealer eligibility at submission so nothing stale is approved
      const d = await inputOf(tx, o.id);
      const b = await buildQuote(tx, req, d, o.orderDate, true, 'sales.order:submit', o.quotationId ? await lockedRates(tx, o.quotationId) : undefined);
      const amount = toRupees(b.totals.grandTotal);
      const credit = await creditPosition(tx, o.partyId, o.id, amount);
      // D18 (BRD p.7, p.19): invoices unpaid beyond the credit days freeze order-taking
      if (credit.frozen) {
        throw Errors.rule('OVERDUE_FREEZE', `${o.partyName} has invoices unpaid beyond their credit days (${credit.overdueInvoices.map((x) => `${x.docNo}, ${x.daysOverdue} days`).join('; ')}). Collect them before taking a new order.`,
          { overdueInvoices: credit.overdueInvoices });
      }
      const H = HEADER_COLS.length;
      await tx.query(`update sales.sales_orders set ${HEADER_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')},
                        credit_limit = $${H + 2}, open_order_value = $${H + 3}, over_credit_limit = $${H + 4}, outstanding_value = $${H + 5}, overdue_value = $${H + 6}, on_account_value = $${H + 7} where id = $1`,
        [o.id, ...headerValues(b), credit.creditLimit, credit.openOrderValue, credit.overCreditLimit, credit.outstanding, credit.overdue, credit.onAccount]);
      await writeLines(tx, o.id, b);
      const facts = { amount, maxDiscountPct: b.maxExtraDiscount, overCreditLimit: credit.overCreditLimit, advancePayment: credit.advancePayment,
        creditLimit: credit.creditLimit, exposure: credit.exposure, fromQuotation: !!o.quotationId };
      await setStatus(tx, actorOf(req), o.id, 'Submitted', null, facts);
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: o.id, subjectLabel: `${o.docNo} — ${o.partyName}`, facts, legalEntityId: o.legalEntityId });
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalRequestId: ar.id, approvalDocNo: ar.doc_no, overCreditLimit: credit.overCreditLimit };
    });
    res.json(out);
  }));

  r.post('/:id/cancel', requirePermission('sales.order:cancel'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, 'sales.order:cancel', true);
      if (!['Draft', 'Rejected', 'Approved'].includes(o.status)) throw Errors.state(`A ${o.status} sales order cannot be cancelled${o.status === 'Submitted' ? '; withdraw the approval request first' : ''}.`);
      await setStatus(tx, actorOf(req), o.id, 'Cancelled', reason);
      // the quotation becomes convertible again (while it is still valid)
      if (o.quotationId) {
        const q = (await tx.query(`select status from sales.quotations where id = $1 for update`, [o.quotationId])).rows[0];
        if (q?.status === 'Converted') await setQuotationStatus(tx, actorOf(req), o.quotationId, 'Accepted', `Sales order ${o.docNo} cancelled`);
      }
    });
    res.json({ ok: true });
  }));

  return r;
}
