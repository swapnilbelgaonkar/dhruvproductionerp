import { Router, type Request } from 'express';
import { z } from 'zod';
import { quotationSchema, reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, territoryScope } from '../../middleware/context';
import { dealerEligibility } from '../dealers/routes';
import { effectiveTaxRate } from '../mdm/routes';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';
import { amountInWords, calcLine, calcTotals, schemeFor, toRupees } from './calc';
import { priceFor } from './pricing';

type QuoteInput = z.infer<typeof quotationSchema>;
const SUBJECT = 'sales.quotation';

/** Today in India (quotation dates are business dates, not UTC dates). */
export const todayIST = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export async function scopeSql(dbx: Db | Tx, req: Request, perm: string, column: string, args: unknown[]) {
  const ids = await territoryScope(dbx, req, perm);
  if (ids === null) return 'true';
  args.push(ids);
  return `exists (select 1 from org.territories rt join org.territories ut on rt.path <@ ut.path where rt.id = ${column} and ut.id = any($${args.length}::uuid[]))`;
}

/**
 * Prices, taxes and checks a quotation (QUO-002…004) from master data only — the client sends packs, quantities and extra discount;
 * every rate, scheme, GST rate and state comes from the server. `strict` turns eligibility problems into errors (save/submit).
 */
export async function buildQuote(dbx: Db | Tx, req: Request, d: Omit<QuoteInput, 'quoteDate'>, quoteDate: string, strict: boolean, perm = 'sales.quotation:create',
  /** prices fixed by an approved quotation (pack → list rate and scheme %); GST is still taken on `quoteDate` */
  locked?: { priceListId: string | null; rates: Map<string, { listRate: number; schemePct: number }> }) {
  const dealer = (await dbx.query(
    `select p.id, p.code, p.legal_name, p.gstin, dp.status, dp.price_group, dp.territory_id, dp.sales_owner_id, dp.credit_days
       from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id where p.id = $1`, [d.partyId])).rows[0];
  if (!dealer) throw Errors.rule('NOT_A_DEALER', 'Quotations and orders are issued to registered dealers. Register the party as a dealer first.');
  const args: unknown[] = [dealer.territory_id];
  const inScope = (await dbx.query(`select 1 where ${await scopeSql(dbx, req, perm, '$1::uuid', args)}`, args)).rowCount;
  if (!inScope) throw Errors.forbidden(`${perm} in this dealer’s territory`);

  const le = (await dbx.query(`select id, name, state_code, status from org.legal_entities where id = $1`, [d.legalEntityId])).rows[0];
  if (!le || le.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active legal entity.');
  if (!le.state_code) throw Errors.rule('LEGAL_ENTITY_NO_STATE', `${le.name} has no state code, so GST cannot be split. Update the legal entity master.`);

  const addr = (await dbx.query(`select id, kind, state_code from mdm.party_addresses where party_id = $1 and status = 'Active' and id = any($2::uuid[])`,
    [d.partyId, [d.billToId, d.shipToId]])).rows;
  const billTo = addr.find((a) => a.id === d.billToId);
  const shipTo = addr.find((a) => a.id === d.shipToId);
  if (!billTo || !['REGISTERED', 'BILLING'].includes(billTo.kind)) throw Errors.rule('INVALID_ADDRESS', 'Bill-to must be the dealer’s registered or billing address.');
  if (!shipTo) throw Errors.rule('INVALID_ADDRESS', 'Ship-to must be one of the dealer’s active addresses.');
  if (!shipTo.state_code) throw Errors.rule('ADDRESS_NO_STATE', 'The ship-to address has no state, so GST cannot be worked out. Complete the dealer’s address first.');
  const interState = le.state_code !== shipTo.state_code;

  const warnings: string[] = [];
  const licenceTypes = new Set<string>();
  let priceListId: string | null = null;
  const lines = [];
  let lineNo = 0;
  for (const l of d.lines) {
    lineNo++;
    const p = (await dbx.query(
      `select p.id, p.pack_code, p.pack_size, p.pack_uom, p.container, p.status, i.id as item_id, i.code, i.name, i.item_type, i.status as item_status,
              i.hsn_id, h.code as hsn_code, c.licence_required
         from mdm.item_packs p join mdm.items i on i.id = p.item_id left join mdm.hsn_codes h on h.id = i.hsn_id
         left join mdm.product_categories c on c.id = i.category_id where p.id = $1`, [l.itemPackId])).rows[0];
    if (!p || p.status !== 'Active' || p.item_status !== 'Active' || p.item_type !== 'FG') throw Errors.rule('ITEM_NOT_SALEABLE', `Line ${lineNo}: choose an active finished-good pack.`);
    const label = `${Number(p.pack_size)} ${p.pack_uom}${p.container ? ` ${p.container}` : ''}`;
    const fixed = locked?.rates.get(p.id);
    if (locked && !fixed) throw Errors.rule('LINES_LOCKED', `Line ${lineNo}: ${p.code} is not on the quotation.`);
    const price = fixed ? { price_list_id: locked!.priceListId, rate: fixed.listRate, slabs: [] } : await priceFor(dbx, dealer.price_group, p.id, quoteDate);
    if (!price) throw Errors.rule('NO_PRICE', `Line ${lineNo}: ${p.code} ${label} has no active price for price group ${dealer.price_group} on ${quoteDate}.`, { line: lineNo });
    priceListId ??= price.price_list_id ?? null;
    if (!p.hsn_id) throw Errors.rule('NO_TAX_RATE', `Line ${lineNo}: ${p.code} has no HSN code. Update the item master.`, { line: lineNo });
    const tax = await effectiveTaxRate(dbx, p.hsn_id, quoteDate);
    if (!tax) throw Errors.rule('NO_TAX_RATE', `Line ${lineNo}: no GST rate is configured for HSN ${p.hsn_code} on ${quoteDate}. Finance must add it.`, { line: lineNo });
    if (p.licence_required && p.licence_required !== 'NONE') licenceTypes.add(p.licence_required);
    const schemePct = fixed ? fixed.schemePct : schemeFor(price.slabs, l.qty);
    const gstRate = Number(tax.gstRate);
    const c = calcLine({ qty: l.qty, listRate: price.rate, schemePct, extraPct: l.extraDiscountPct, gstRate }, interState);
    lines.push({ lineNo, itemPackId: p.id, itemCode: p.code, description: `${p.name} — ${label}`, hsnCode: p.hsn_code, packLabel: label, qty: l.qty,
      listRate: Number(price.rate), schemeDiscountPct: schemePct, extraDiscountPct: l.extraDiscountPct, gstRate, calc: c });
  }
  const eligibility = await dealerEligibility(dbx, d.partyId, [...licenceTypes], quoteDate);
  warnings.push(...(eligibility.warnings ?? []));
  if (!eligibility.eligible) {
    if (strict) throw Errors.rule('DEALER_NOT_ELIGIBLE', `${dealer.legal_name} cannot be sold these products: ${eligibility.reasons.join('; ')}.`, eligibility);
    warnings.push(...eligibility.reasons);
  }
  const totals = calcTotals(lines.map((l) => l.calc));
  const validityDays = Number(await getSetting(dbx, 'sales.quotation.validityDays', 7));
  return {
    dealer, sellerState: le.state_code as string, placeOfSupply: shipTo.state_code as string, interState, priceListId, quoteDate,
    validUntil: addDays(quoteDate, validityDays), maxExtraDiscount: Math.max(0, ...d.lines.map((l) => l.extraDiscountPct)), lines, totals, warnings, eligibility,
  };
}

/** Packs priced for a dealer's price group on a date — the product picker of quotations and orders. */
export async function pricedPacks(db: Db, partyId: string, date: string) {
  return (await db.query(
      `select p.id, i.code as "itemCode", i.name as "itemName", p.pack_code as "packCode", p.pack_size as "packSize", p.pack_uom as "packUom", p.container,
              x.rate, pl.code as "priceListCode",
              coalesce((select json_agg(json_build_object('minQty', s.min_qty, 'discountPct', s.discount_pct) order by s.min_qty) from sales.price_slabs s where s.price_list_item_id = x.id), '[]') as slabs
         from mdm.dealer_profiles dp
         join sales.price_lists pl on pl.price_group = dp.price_group and pl.status = 'Active' and pl.valid_from <= $2::date and (pl.valid_to is null or pl.valid_to >= $2::date)
         join sales.price_list_items x on x.price_list_id = pl.id join mdm.item_packs p on p.id = x.item_pack_id join mdm.items i on i.id = p.item_id
        where dp.party_id = $1 and p.status = 'Active' and i.status = 'Active' order by i.code, p.pack_size`, [partyId, date])).rows;
}

export type Built = Awaited<ReturnType<typeof buildQuote>>;
export const rupees = (b: Built) => ({
  subTotal: toRupees(b.totals.subTotal), discountTotal: toRupees(b.totals.discountTotal), taxableTotal: toRupees(b.totals.taxableTotal),
  cgstTotal: toRupees(b.totals.cgstTotal), sgstTotal: toRupees(b.totals.sgstTotal), igstTotal: toRupees(b.totals.igstTotal),
  roundOff: toRupees(b.totals.roundOff), grandTotal: toRupees(b.totals.grandTotal),
});
export const lineOut = (l: Built['lines'][number]) => ({
  lineNo: l.lineNo, itemPackId: l.itemPackId, itemCode: l.itemCode, description: l.description, hsnCode: l.hsnCode, packLabel: l.packLabel, qty: l.qty,
  listRate: l.listRate, schemeDiscountPct: l.schemeDiscountPct, extraDiscountPct: l.extraDiscountPct, rate: toRupees(l.calc.rate), taxable: toRupees(l.calc.taxable),
  gstRate: l.gstRate, cgst: toRupees(l.calc.cgst), sgst: toRupees(l.calc.sgst), igst: toRupees(l.calc.igst), lineTotal: toRupees(l.calc.lineTotal),
});

async function writeLines(tx: Tx, quotationId: string, b: Built) {
  await tx.query(`delete from sales.quotation_lines where quotation_id = $1`, [quotationId]);
  for (const l of b.lines) {
    await tx.query(
      `insert into sales.quotation_lines (quotation_id, line_no, item_pack_id, description, hsn_code, pack_label, qty, list_rate, scheme_discount_pct,
         extra_discount_pct, rate, taxable, gst_rate, cgst, sgst, igst, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [quotationId, l.lineNo, l.itemPackId, l.description, l.hsnCode, l.packLabel, l.qty, l.listRate, l.schemeDiscountPct, l.extraDiscountPct,
        toRupees(l.calc.rate), toRupees(l.calc.taxable), l.gstRate, toRupees(l.calc.cgst), toRupees(l.calc.sgst), toRupees(l.calc.igst), toRupees(l.calc.lineTotal)]);
  }
}

const headerValues = (b: Built) => {
  const t = rupees(b);
  return [b.sellerState, b.placeOfSupply, b.interState, b.quoteDate, b.validUntil, b.priceListId, b.maxExtraDiscount,
    t.subTotal, t.discountTotal, t.taxableTotal, t.cgstTotal, t.sgstTotal, t.igstTotal, t.roundOff, t.grandTotal];
};
const HEADER_COLS = ['seller_state', 'place_of_supply', 'inter_state', 'quote_date', 'valid_until', 'price_list_id', 'max_extra_discount',
  'sub_total', 'discount_total', 'taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'round_off', 'grand_total'];

export async function setQuotationStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null, extra: Record<string, unknown> = {}) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from sales.quotations where id = $1`, [id])).rows[0];
  await tx.query(`update sales.quotations set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status, ...extra }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/** Hourly: an approved or sent quotation past its validity date expires (BRD p.13 "validity 7 days"). */
export async function expireQuotations(db: Db): Promise<number> {
  return withTx(db, async (tx) => {
    const rows = (await tx.query(`select id from sales.quotations where status in ('Approved','Sent') and valid_until < $1::date for update`, [todayIST()])).rows;
    const system: Actor = { userId: null, label: 'system' };
    for (const r of rows) await setQuotationStatus(tx, system, r.id, 'Expired', 'Validity period ended');
    return rows.length;
  });
}

/** Facts for the quotation approval policy (D01 hybrid; D15 decides whether tier limits are live). */
async function approvalFacts(tx: Tx, req: Request, b: { maxExtraDiscount: number; grandTotal: number }) {
  const lim = (await tx.query(`select bool_and(active) as active from iam.authority_limits`)).rows[0];
  const limitsActive = !!lim?.active;
  let own: { tier: string | null; max: number | null } = { tier: null, max: 0 };
  if (req.auth!.user.employeeId) {
    const r = (await tx.query(`select e.sales_tier, l.max_discount_pct from org.employees e left join iam.authority_limits l on l.tier = e.sales_tier where e.id = $1`,
      [req.auth!.user.employeeId])).rows[0];
    if (r?.sales_tier) own = { tier: r.sales_tier, max: r.max_discount_pct === null ? null : Number(r.max_discount_pct) };
  }
  const withinOwnAuthority = limitsActive && !!own.tier && (own.max === null || b.maxExtraDiscount <= own.max);
  return { maxDiscountPct: b.maxExtraDiscount, ladderAmount: 0, quotationValue: b.grandTotal, limitsActive, withinOwnAuthority, initiatorTier: own.tier };
}

const quoteSelect = `select q.id, q.doc_no as "docNo", q.revision, q.party_id as "partyId", p.code as "partyCode", p.legal_name as "partyName", p.gstin as "partyGstin",
    q.legal_entity_id as "legalEntityId", le.name as "legalEntityName", q.seller_state as "sellerState", q.bill_to_id as "billToId", q.ship_to_id as "shipToId",
    q.place_of_supply as "placeOfSupply", q.inter_state as "interState", q.quote_date as "quoteDate", q.valid_until as "validUntil", q.price_list_id as "priceListId",
    pl.code as "priceListCode", q.contact_person as "contactPerson", q.payment_terms as "paymentTerms", q.delivery_terms as "deliveryTerms", q.notes,
    q.sales_owner_id as "salesOwnerId", e.full_name as "salesOwner", q.territory_id as "territoryId", t.name as territory, q.opportunity_id as "opportunityId",
    o.code as "opportunityCode", q.status, q.status_reason as "statusReason", q.needs_approval as "needsApproval", q.max_extra_discount as "maxExtraDiscount",
    q.sub_total as "subTotal", q.discount_total as "discountTotal", q.taxable_total as "taxableTotal", q.cgst_total as "cgstTotal", q.sgst_total as "sgstTotal",
    q.igst_total as "igstTotal", q.round_off as "roundOff", q.grand_total as "grandTotal", q.created_at as "createdAt", q.created_by as "createdBy",
    q.updated_at as "updatedAt", q.version
  from sales.quotations q join mdm.parties p on p.id = q.party_id join org.legal_entities le on le.id = q.legal_entity_id
  join org.employees e on e.id = q.sales_owner_id join org.territories t on t.id = q.territory_id
  left join sales.price_lists pl on pl.id = q.price_list_id left join sales.opportunities o on o.id = q.opportunity_id`;

function allowedActions(req: Request, status: string) {
  const out: string[] = [];
  const edit = can(req, 'sales.quotation:edit');
  if (['Draft', 'Rejected'].includes(status)) { if (edit) out.push('edit'); if (can(req, 'sales.quotation:submit')) out.push('submit'); }
  if (status === 'Approved' && can(req, 'sales.quotation:send')) out.push('send');
  if (['Approved', 'Sent'].includes(status) && can(req, 'sales.quotation:send')) out.push('accept');
  if (['Approved', 'Sent', 'Expired'].includes(status) && edit) out.push('revise');
  if (['Draft', 'Rejected', 'Approved', 'Sent'].includes(status) && can(req, 'sales.quotation:cancel')) out.push('cancel');
  if (['Approved', 'Sent', 'Accepted'].includes(status) && can(req, 'sales.order:create')) out.push('convert');
  if (can(req, 'sales.quotation:create')) out.push('duplicate');
  return out;
}

export function quotationRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, r, a) => setQuotationStatus(tx, a, r.subject_id, 'Approved'),
    onRejected: (tx, r, a) => setQuotationStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setQuotationStatus(tx, a, r.subject_id, 'Draft'),
    onCancelled: (tx, r, a) => setQuotationStatus(tx, a, r.subject_id, 'Draft'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, perm = 'sales.quotation:view', lock = false) {
    const args: unknown[] = [id];
    const s = await scopeSql(dbx, req, perm, 'q.territory_id', args);
    const row = (await dbx.query(`${quoteSelect} where q.id = $1 and ${s} ${lock ? 'for update of q' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Quotation');
    return row;
  }
  async function owner(tx: Tx, req: Request, dealer: Built['dealer']) {
    const emp = req.auth!.user.employeeId;
    if (emp) {
      const e = (await tx.query(`select id from org.employees where id = $1 and status = 'Active'`, [emp])).rows[0];
      if (e) return e.id as string;
    }
    return dealer.sales_owner_id as string;
  }
  async function checkOpportunity(tx: Tx, req: Request, oppId: string | null | undefined, partyId: string) {
    if (!oppId) return null;
    const args: unknown[] = [oppId];
    const o = (await tx.query(`select o.id, o.party_id, o.stage from sales.opportunities o where o.id = $1 and ${await scopeSql(tx, req, 'crm.opportunity:view', 'o.territory_id', args)}`, args)).rows[0];
    if (!o) throw Errors.notFound('Opportunity');
    if (o.party_id && o.party_id !== partyId) throw Errors.rule('OPPORTUNITY_MISMATCH', 'The opportunity belongs to a different dealer.');
    return o.id as string;
  }
  async function insertQuote(tx: Tx, req: Request, d: QuoteInput, b: Built, docNo: string, revision: number) {
    const cols = ['doc_no', 'revision', 'party_id', 'legal_entity_id', 'bill_to_id', 'ship_to_id', 'contact_person', 'payment_terms', 'delivery_terms', 'notes',
      'sales_owner_id', 'territory_id', 'opportunity_id', 'created_by', 'updated_by', ...HEADER_COLS];
    const vals = [docNo, revision, d.partyId, d.legalEntityId, d.billToId, d.shipToId, d.contactPerson ?? null, d.paymentTerms, d.deliveryTerms, d.notes ?? null,
      await owner(tx, req, b.dealer), b.dealer.territory_id, await checkOpportunity(tx, req, d.opportunityId, d.partyId), req.auth!.user.id, req.auth!.user.id, ...headerValues(b)];
    const q = (await tx.query(`insert into sales.quotations (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`, vals)).rows[0];
    await writeLines(tx, q.id, b);
    return q.id as string;
  }
  const inputOf = async (dbx: Db | Tx, id: string): Promise<QuoteInput> => {
    const q = (await dbx.query(`select * from sales.quotations where id = $1`, [id])).rows[0];
    const lines = (await dbx.query(`select item_pack_id, qty, extra_discount_pct from sales.quotation_lines where quotation_id = $1 order by line_no`, [id])).rows;
    return { partyId: q.party_id, legalEntityId: q.legal_entity_id, billToId: q.bill_to_id, shipToId: q.ship_to_id, contactPerson: q.contact_person ?? undefined,
      paymentTerms: q.payment_terms, deliveryTerms: q.delivery_terms, notes: q.notes ?? undefined, opportunityId: q.opportunity_id,
      lines: lines.map((l) => ({ itemPackId: l.item_pack_id, qty: Number(l.qty), extraDiscountPct: Number(l.extra_discount_pct) })) };
  };
  const quoteDateOf = (d: QuoteInput) => {
    const today = todayIST();
    if (d.quoteDate && d.quoteDate > today) throw Errors.rule('FUTURE_DATE', 'The quotation date cannot be in the future.');
    return d.quoteDate ?? today;
  };

  // ------------------------------------------------------------------ defaults for a new quotation
  r.get('/defaults', requirePermission('sales.quotation:create'), asyncHandler(async (_req, res) => {
    res.json({
      paymentTerms: await getSetting(db, 'sales.defaultPaymentTerms', ''), deliveryTerms: await getSetting(db, 'sales.defaultDeliveryTerms', ''),
      validityDays: Number(await getSetting(db, 'sales.quotation.validityDays', 7)), today: todayIST(),
    });
  }));

  // packs priced for this dealer's price group on the date (the product picker)
  r.get('/priced-packs', requirePermission('sales.quotation:create'), asyncHandler(async (req, res) => {
    const partyId = str(req.query.partyId);
    if (!partyId) throw Errors.validation([{ field: 'partyId', message: 'Choose a dealer' }]);
    res.json({ data: await pricedPacks(db, partyId, str(req.query.date) ?? todayIST()) });
  }));

  // ------------------------------------------------------------------ live preview (nothing saved)
  r.post('/calculate', requirePermission('sales.quotation:create'), asyncHandler(async (req, res) => {
    const d = parse(quotationSchema, req.body);
    const b = await buildQuote(db, req, d, quoteDateOf(d), false);
    res.json({ lines: b.lines.map(lineOut), totals: rupees(b), interState: b.interState, sellerState: b.sellerState, placeOfSupply: b.placeOfSupply,
      validUntil: b.validUntil, maxExtraDiscount: b.maxExtraDiscount, warnings: b.warnings, amountInWords: amountInWords(toRupees(b.totals.grandTotal)) });
  }));

  // ------------------------------------------------------------------ register
  r.get('/', requirePermission('sales.quotation:view'), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = [await scopeSql(db, req, 'sales.quotation:view', 'q.territory_id', args)];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(q.doc_no ilike $${args.length} or p.legal_name ilike $${args.length} or p.code ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`q.status = $${args.length}`); }
    else if (req.query.all !== 'true') where.push(`q.status <> 'Superseded'`);
    const party = str(req.query.partyId);
    if (party) { args.push(party); where.push(`q.party_id = $${args.length}`); }
    if (req.query.mine === 'true' && req.auth!.user.employeeId) { args.push(req.auth!.user.employeeId); where.push(`q.sales_owner_id = $${args.length}`); }
    const rows = await db.query(`${quoteSelect.replace('select q.id,', 'select count(*) over() as total, q.id,')} where ${where.join(' and ')}
      order by q.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission('sales.quotation:view'), asyncHandler(async (req, res) => {
    const q = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select l.line_no as "lineNo", l.item_pack_id as "itemPackId", i.code as "itemCode", l.description, l.hsn_code as "hsnCode", l.pack_label as "packLabel",
              l.qty, l.list_rate as "listRate", l.scheme_discount_pct as "schemeDiscountPct", l.extra_discount_pct as "extraDiscountPct", l.rate, l.taxable,
              l.gst_rate as "gstRate", l.cgst, l.sgst, l.igst, l.line_total as "lineTotal"
         from sales.quotation_lines l join mdm.item_packs p on p.id = l.item_pack_id join mdm.items i on i.id = p.item_id where l.quotation_id = $1 order by l.line_no`, [q.id])).rows;
    const revisions = (await db.query(`select id, revision, status, grand_total as "grandTotal", created_at as "createdAt" from sales.quotations where doc_no = $1 order by revision desc`, [q.docNo])).rows;
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, a.rule_name as "ruleName",
              (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'kind', s.step_kind, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, q.id])).rows[0] ?? null;
    const addresses = (await db.query(`select id, kind, label, line1, line2, city, district, state_code as "stateCode", pincode from mdm.party_addresses where id = any($1::uuid[])`,
      [[q.billToId, q.shipToId]])).rows;
    const salesOrder = (await db.query(`select id, doc_no as "docNo", status from sales.sales_orders where quotation_id = $1 order by created_at desc limit 1`, [q.id])).rows[0] ?? null;
    const seller = (await db.query(
      `select le.name, le.registered_address as address, le.pan, g.gstin from org.legal_entities le
         left join org.gst_registrations g on g.legal_entity_id = le.id and g.state_code = $2 and g.status = 'Active' where le.id = $1`, [q.legalEntityId, q.sellerState])).rows[0];
    res.json({
      ...q, lines, revisions, approval, salesOrder, allowedActions: allowedActions(req, q.status),
      billTo: addresses.find((a) => a.id === q.billToId) ?? null, shipTo: addresses.find((a) => a.id === q.shipToId) ?? null,
      print: { seller, bankDetails: await getSetting(db, 'company.bankDetails', ''), amountInWords: amountInWords(Number(q.grandTotal)) },
    });
  }));

  // ------------------------------------------------------------------ create / edit
  r.post('/', requirePermission('sales.quotation:create'), asyncHandler(async (req, res) => {
    const d = parse(quotationSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const b = await buildQuote(tx, req, d, quoteDateOf(d), true);
      const docNo = await nextDocNo(tx, 'QUOTATION');
      const id = await insertQuote(tx, req, d, b, docNo, 1);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: id, after: { docNo, grandTotal: toRupees(b.totals.grandTotal), lines: d.lines } });
      return { id, docNo };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission('sales.quotation:edit'), asyncHandler(async (req, res) => {
    const d = parse(quotationSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!, 'sales.quotation:edit', true);
      if (!['Draft', 'Rejected'].includes(q.status)) throw Errors.state(`A ${q.status} quotation cannot be edited. Revise it instead.`);
      if (q.version !== d.version) throw Errors.concurrent();
      if (d.partyId !== q.partyId) throw Errors.rule('PARTY_LOCKED', 'The dealer of a quotation cannot be changed. Create a new quotation.');
      const b = await buildQuote(tx, req, d, quoteDateOf(d), true);
      const cols = ['legal_entity_id', 'bill_to_id', 'ship_to_id', 'contact_person', 'payment_terms', 'delivery_terms', 'notes', 'opportunity_id', 'updated_by', ...HEADER_COLS];
      const vals = [d.legalEntityId, d.billToId, d.shipToId, d.contactPerson ?? null, d.paymentTerms, d.deliveryTerms, d.notes ?? null,
        await checkOpportunity(tx, req, d.opportunityId, d.partyId), req.auth!.user.id, ...headerValues(b)];
      await tx.query(`update sales.quotations set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [q.id, ...vals]);
      await writeLines(tx, q.id, b);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: q.id,
        before: { grandTotal: Number(q.grandTotal) }, after: { grandTotal: toRupees(b.totals.grandTotal), lines: d.lines } });
    });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ lifecycle
  r.post('/:id/submit', requirePermission('sales.quotation:submit'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!, 'sales.quotation:submit', true);
      if (!['Draft', 'Rejected'].includes(q.status)) throw Errors.state(`Only a Draft or Rejected quotation can be submitted (this one is ${q.status}).`);
      // re-price at submission so nothing stale is approved
      const d = await inputOf(tx, q.id);
      const b = await buildQuote(tx, req, d, day(q.quoteDate), true);
      await tx.query(`update sales.quotations set ${HEADER_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [q.id, ...headerValues(b)]);
      await writeLines(tx, q.id, b);
      if (day(q.validUntil) < todayIST()) throw Errors.rule('QUOTATION_EXPIRED', 'The validity date has passed. Change the quotation date to today and save before submitting.');
      const facts = await approvalFacts(tx, req, { maxExtraDiscount: b.maxExtraDiscount, grandTotal: toRupees(b.totals.grandTotal) });
      await setQuotationStatus(tx, actorOf(req), q.id, 'Submitted', null, facts);
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: q.id, subjectLabel: `${q.docNo} R${q.revision} — ${q.partyName}`,
        revision: q.revision, facts, legalEntityId: q.legalEntityId });
      await tx.query(`update sales.quotations set needs_approval = $2 where id = $1`, [q.id, ar.status !== 'Approved']);
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  r.post('/:id/send', requirePermission('sales.quotation:send'), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!, 'sales.quotation:send', true);
      if (q.status !== 'Approved') throw Errors.state('Only an approved quotation can be marked as sent.');
      if (day(q.validUntil) < todayIST()) throw Errors.rule('QUOTATION_EXPIRED', 'The quotation has expired. Revise it.');
      await setQuotationStatus(tx, actorOf(req), q.id, 'Sent');
    });
    res.json({ ok: true });
  }));

  r.post('/:id/accept', requirePermission('sales.quotation:send'), asyncHandler(async (req, res) => {
    const body = parse(z.object({ remarks: z.string().trim().max(500).optional() }), req.body ?? {});
    await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!, 'sales.quotation:send', true);
      if (!['Approved', 'Sent'].includes(q.status)) throw Errors.state('Only an approved or sent quotation can be accepted.');
      if (day(q.validUntil) < todayIST()) throw Errors.rule('QUOTATION_EXPIRED', 'The quotation has expired. Revise it.');
      await setQuotationStatus(tx, actorOf(req), q.id, 'Accepted', body.remarks ?? null);
    });
    res.json({ ok: true });
  }));

  r.post('/:id/cancel', requirePermission('sales.quotation:cancel'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!, 'sales.quotation:cancel', true);
      if (!['Draft', 'Rejected', 'Approved', 'Sent'].includes(q.status)) throw Errors.state(`A ${q.status} quotation cannot be cancelled.`);
      await setQuotationStatus(tx, actorOf(req), q.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  // New revision: same number, revision + 1, re-priced today; the previous revision is superseded (QUO-006).
  r.post('/:id/revise', requirePermission('sales.quotation:edit'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!, 'sales.quotation:edit', true);
      if (!['Approved', 'Sent', 'Expired'].includes(q.status)) throw Errors.state(`A ${q.status} quotation cannot be revised${['Draft', 'Rejected'].includes(q.status) ? '; edit it instead' : ''}.`);
      const latest = (await tx.query(`select max(revision) as r from sales.quotations where doc_no = $1`, [q.docNo])).rows[0].r;
      if (latest !== q.revision) throw Errors.state('Only the latest revision can be revised.');
      const d = await inputOf(tx, q.id);
      const b = await buildQuote(tx, req, d, todayIST(), true);
      const id = await insertQuote(tx, req, d, b, q.docNo, q.revision + 1);
      await setQuotationStatus(tx, actorOf(req), q.id, 'Superseded', `Revised as R${q.revision + 1}`);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.revised`, entityType: SUBJECT, entityId: id, after: { from: q.id, revision: q.revision + 1 } });
      return { id, revision: q.revision + 1 };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/duplicate', requirePermission('sales.quotation:create'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const q = await load(tx, req, req.params.id!);
      const d = { ...(await inputOf(tx, q.id)), opportunityId: null };
      const b = await buildQuote(tx, req, d, todayIST(), true);
      const docNo = await nextDocNo(tx, 'QUOTATION');
      const id = await insertQuote(tx, req, d, b, docNo, 1);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.duplicated`, entityType: SUBJECT, entityId: id, after: { from: q.id, docNo } });
      return { id, docNo };
    });
    res.status(201).json(out);
  }));

  return r;
}
