import { Router, type Request } from 'express';
import { z } from 'zod';
import { poAcknowledgeSchema, purchaseOrderSchema, reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, inLegalEntityScope, legalEntityScope } from '../../middleware/context';
import { effectiveTaxRate } from '../mdm/routes';
import { amountInWords, calcPurchaseLine, calcTotals, toRupees } from '../sales/calc';
import { todayIST } from '../sales/quotations';
import { vendorEligibility } from '../vendors/routes';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

export type PoInput = z.infer<typeof purchaseOrderSchema>;
const SUBJECT = 'purchase.order';
const P = (a: string) => `${SUBJECT}:${a}`;
const EDITABLE = ['Draft', 'Rejected'];
/** a PO in these statuses holds quantity against its requisition lines */
const LIVE = ['Draft', 'Submitted', 'Approved', 'Issued', 'Lapsed', 'Acknowledged', 'PartiallyReceived', 'Received', 'Closed'];
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null, extra: Record<string, unknown> = {}) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from purchase.purchase_orders where id = $1`, [id])).rows[0];
  await tx.query(`update purchase.purchase_orders set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    approved_at = case when $2 = 'Approved' then now() else approved_at end where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status, ...extra }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/** Recomputes how much of each requisition line is on live POs; a fully ordered approved requisition closes (and reopens if a PO is cancelled). */
export async function refreshRequisitions(tx: Tx, actor: Actor, prLineIds: string[]) {
  const ids = [...new Set(prLineIds.filter(Boolean))];
  if (!ids.length) return;
  await tx.query(
    `update purchase.requisition_lines l set ordered_qty = coalesce((
        select sum(pl.qty) from purchase.purchase_order_lines pl join purchase.purchase_orders po on po.id = pl.purchase_order_id
         where pl.requisition_line_id = l.id and po.status = any($2::text[])), 0) where l.id = any($1::uuid[])`, [ids, LIVE]);
  const prs = (await tx.query(
    `select r.id, r.status, bool_and(l.ordered_qty >= l.qty) as full from purchase.requisitions r join purchase.requisition_lines l on l.requisition_id = r.id
      where r.id in (select requisition_id from purchase.requisition_lines where id = any($1::uuid[])) group by r.id, r.status`, [ids])).rows;
  for (const pr of prs) {
    const to = pr.status === 'Approved' && pr.full ? 'Closed' : pr.status === 'Closed' && !pr.full ? 'Approved' : null;
    if (!to) continue;
    await allowTransition(tx);
    await tx.query(`update purchase.requisitions set status = $2, status_reason = $3 where id = $1`, [pr.id, to, to === 'Closed' ? 'Fully ordered' : 'Reopened: an order was cancelled']);
    await audit(tx, actor, { action: 'purchase.requisition.status', entityType: 'purchase.requisition', entityId: pr.id, after: { status: to } });
  }
}

/**
 * Prices, taxes and checks a PO (PUR-006): vendor eligible for every item, requisition quantities not exceeded,
 * GST from the HSN rate on the PO date, CGST+SGST or IGST from the vendor's state against the ship-to warehouse.
 */
export async function buildPo(tx: Db | Tx, req: Request, d: PoInput, poDate: string, strict: boolean, excludePoId: string | null = null) {
  const v = (await tx.query(
    `select p.id, p.code, p.legal_name, p.gst_registered, p.gstin, (select state_code from mdm.party_addresses a where a.party_id = p.id and a.kind = 'REGISTERED' and a.status = 'Active' limit 1) as state
       from mdm.parties p join mdm.vendor_profiles vp on vp.party_id = p.id where p.id = $1`, [d.partyId])).rows[0];
  if (!v) throw Errors.rule('NOT_A_VENDOR', 'Purchase orders are placed on registered vendors.');
  if (!inLegalEntityScope(req, P('create'), d.legalEntityId)) throw Errors.forbidden(`${P('create')} for this legal entity`);
  const le = (await tx.query(`select status from org.legal_entities where id = $1`, [d.legalEntityId])).rows[0];
  if (le?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active legal entity.');
  const wh = (await tx.query(`select status, legal_entity_id, state_code, code from org.warehouses where id = $1`, [d.warehouseId])).rows[0];
  if (wh?.status !== 'Active' || wh.legal_entity_id !== d.legalEntityId) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active warehouse of the same legal entity to ship to.');
  if (!wh.state_code) throw Errors.rule('WAREHOUSE_NO_STATE', `Warehouse ${wh.code} has no state, so GST cannot be split. Update the warehouse master.`);
  const vendorState = (v.gstin ? String(v.gstin).slice(0, 2) : v.state) as string | null;
  if (!vendorState) throw Errors.rule('VENDOR_NO_STATE', 'The vendor has no registered address state.');
  if (d.deliveryDate < poDate) throw Errors.rule('INVALID_DATE', 'The delivery date cannot be before the PO date.');
  const interState = vendorState !== wh.state_code;
  const warnings: string[] = [];
  const elig = await vendorEligibility(tx, d.partyId, d.lines.map((l) => l.itemId), poDate);
  if (!elig.eligible) {
    if (strict) throw Errors.rule('VENDOR_NOT_ELIGIBLE', `${v.legal_name} cannot be ordered from: ${elig.reasons.join('; ')}.`, elig);
    warnings.push(...elig.reasons);
  }
  const lines = [];
  let n = 0;
  for (const l of d.lines) {
    n++;
    const it = (await tx.query(`select i.code, i.name, i.status, i.base_uom, i.hsn_id, h.code as hsn from mdm.items i left join mdm.hsn_codes h on h.id = i.hsn_id where i.id = $1`, [l.itemId])).rows[0];
    if (it?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', `Line ${n}: only approved items can be ordered.`);
    if (l.deliveryDate && l.deliveryDate < poDate) throw Errors.rule('INVALID_DATE', `Line ${n}: the delivery date cannot be before the PO date.`);
    let gstRate = 0;
    if (v.gst_registered) {
      if (!it.hsn_id) throw Errors.rule('NO_TAX_RATE', `Line ${n}: ${it.code} has no HSN code. Update the item master.`);
      const t = await effectiveTaxRate(tx, it.hsn_id, poDate);
      if (!t) throw Errors.rule('NO_TAX_RATE', `Line ${n}: no GST rate is configured for HSN ${it.hsn} on ${poDate}. Finance must add it.`);
      gstRate = Number(t.gstRate);
    }
    if (l.requisitionLineId) {
      const pr = (await tx.query(
        `select l.qty, l.item_id, r.status, r.legal_entity_id, r.doc_no,
                coalesce((select sum(pl.qty) from purchase.purchase_order_lines pl join purchase.purchase_orders po on po.id = pl.purchase_order_id
                           where pl.requisition_line_id = l.id and po.status = any($2::text[]) and po.id is distinct from $3), 0) as ordered
           from purchase.requisition_lines l join purchase.requisitions r on r.id = l.requisition_id where l.id = $1`, [l.requisitionLineId, LIVE, excludePoId])).rows[0];
      if (!pr || !['Approved', 'Closed'].includes(pr.status) || pr.item_id !== l.itemId || pr.legal_entity_id !== d.legalEntityId) {
        throw Errors.rule('REQUISITION_INVALID', `Line ${n}: link it to an approved requisition line for the same item and legal entity.`);
      }
      const left = Number(pr.qty) - Number(pr.ordered);
      if (l.qty > left + 1e-9) throw Errors.rule('PR_QTY_EXCEEDED', `Line ${n}: only ${left} ${it.base_uom} of ${pr.doc_no} is still to be ordered.`, { line: n, remaining: left });
    }
    const c = calcPurchaseLine({ qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate }, interState, v.gst_registered);
    lines.push({ ...l, lineNo: n, description: it.name as string, hsnCode: it.hsn as string | null, uom: it.base_uom as string, gstRate: v.gst_registered ? gstRate : 0, calc: c });
  }
  const totals = calcTotals(lines.map((l) => l.calc));
  return { vendor: v, vendorState, placeOfSupply: wh.state_code as string, interState, lines, totals, warnings, eligibility: elig };
}
type Built = Awaited<ReturnType<typeof buildPo>>;
const rupeeTotals = (b: Built) => Object.fromEntries(Object.entries(b.totals).map(([k, v]) => [k, toRupees(v)])) as Record<keyof Built['totals'], number>;
const HEADER_COLS = ['vendor_state', 'place_of_supply', 'inter_state', 'vendor_gst_registered', 'sub_total', 'discount_total', 'taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'round_off', 'grand_total'];
const headerValues = (b: Built) => { const t = rupeeTotals(b); return [b.vendorState, b.placeOfSupply, b.interState, b.vendor.gst_registered, t.subTotal, t.discountTotal, t.taxableTotal, t.cgstTotal, t.sgstTotal, t.igstTotal, t.roundOff, t.grandTotal]; };

async function writeLines(tx: Tx, poId: string, b: Built, rfqLines: Map<string, string> = new Map()) {
  await tx.query(`delete from purchase.purchase_order_lines where purchase_order_id = $1`, [poId]);
  for (const l of b.lines) {
    await tx.query(
      `insert into purchase.purchase_order_lines (purchase_order_id, line_no, item_id, description, hsn_code, uom, qty, rate, discount_pct, net_rate, taxable, gst_rate, cgst, sgst, igst,
         line_total, delivery_date, requisition_line_id, rfq_line_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [poId, l.lineNo, l.itemId, l.description, l.hsnCode, l.uom, l.qty, l.rate, l.discountPct, l.calc.netRate, toRupees(l.calc.taxable), l.gstRate,
        toRupees(l.calc.cgst), toRupees(l.calc.sgst), toRupees(l.calc.igst), toRupees(l.calc.lineTotal), l.deliveryDate ?? null, l.requisitionLineId ?? null, rfqLines.get(l.itemId) ?? null]);
  }
}

/** Creates a Draft PO (also used by the RFQ award). */
export async function createPurchaseOrder(tx: Tx, req: Request, d: PoInput, opts: { rfqId?: string; rfqLines?: Map<string, string> } = {}) {
  const poDate = d.poDate ?? todayIST();
  if (poDate > todayIST()) throw Errors.rule('FUTURE_DATE', 'The PO date cannot be in the future.');
  const b = await buildPo(tx, req, d, poDate, true);
  const docNo = await nextDocNo(tx, 'PURCHASE_ORDER');
  const cols = ['doc_no', 'party_id', 'legal_entity_id', 'warehouse_id', 'po_date', 'delivery_date', 'payment_terms_days', 'delivery_terms', 'notes', 'rfq_id', 'emergency', 'created_by', 'updated_by', ...HEADER_COLS];
  const vals = [docNo, d.partyId, d.legalEntityId, d.warehouseId, poDate, d.deliveryDate, d.paymentTermsDays, d.deliveryTerms, d.notes ?? null, opts.rfqId ?? null, d.emergency,
    req.auth!.user.id, req.auth!.user.id, ...headerValues(b)];
  const po = (await tx.query(`insert into purchase.purchase_orders (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id`, vals)).rows[0];
  await writeLines(tx, po.id, b, opts.rfqLines);
  await refreshRequisitions(tx, actorOf(req), d.lines.map((l) => l.requisitionLineId ?? ''));
  await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: po.id, after: { docNo, vendor: b.vendor.code, grandTotal: toRupees(b.totals.grandTotal), rfqId: opts.rfqId ?? null } });
  return { id: po.id as string, docNo };
}

/** PUR-013: an issued PO not acknowledged within the acceptance days lapses and must be re-issued. */
export async function lapseUnacknowledged(db: Db): Promise<number> {
  return withTx(db, async (tx) => {
    const rows = (await tx.query(`select id from purchase.purchase_orders where status = 'Issued' and ack_due < $1::date for update`, [todayIST()])).rows;
    for (const r of rows) await setStatus(tx, { userId: null, label: 'system' }, r.id, 'Lapsed', 'Not acknowledged by the vendor within the acceptance period');
    return rows.length;
  });
}

const poSelect = `select o.id, o.doc_no as "docNo", o.party_id as "partyId", p.code as "vendorCode", p.legal_name as "vendorName", p.gstin as "vendorGstin",
    o.legal_entity_id as "legalEntityId", le.name as "legalEntityName", o.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name as "warehouseName",
    o.vendor_state as "vendorState", o.place_of_supply as "placeOfSupply", o.inter_state as "interState", o.vendor_gst_registered as "vendorGstRegistered",
    o.po_date as "poDate", o.delivery_date as "deliveryDate", o.payment_terms_days as "paymentTermsDays", o.delivery_terms as "deliveryTerms", o.notes,
    o.rfq_id as "rfqId", rq.doc_no as "rfqNo", o.emergency, o.status, o.status_reason as "statusReason", o.issued_at as "issuedAt", o.ack_due as "ackDue",
    o.acknowledged_at as "acknowledgedAt", o.vendor_ack_ref as "vendorAckRef", o.sub_total as "subTotal", o.discount_total as "discountTotal",
    o.taxable_total as "taxableTotal", o.cgst_total as "cgstTotal", o.sgst_total as "sgstTotal", o.igst_total as "igstTotal", o.round_off as "roundOff",
    o.grand_total as "grandTotal", o.approved_at as "approvedAt", o.created_at as "createdAt", o.created_by as "createdBy", u.full_name as "createdByName",
    o.updated_at as "updatedAt", o.version
  from purchase.purchase_orders o join mdm.parties p on p.id = o.party_id join org.legal_entities le on le.id = o.legal_entity_id
  join org.warehouses w on w.id = o.warehouse_id left join purchase.rfqs rq on rq.id = o.rfq_id left join iam.users u on u.id = o.created_by`;

function allowedActions(req: Request, status: string, received: boolean) {
  const out: string[] = [];
  if (EDITABLE.includes(status)) { if (can(req, P('edit'))) out.push('edit'); if (can(req, P('submit'))) out.push('submit'); }
  if (status === 'Approved' && can(req, P('issue'))) out.push('issue');
  if (status === 'Lapsed' && can(req, P('issue'))) out.push('reissue');
  if (status === 'Issued' && can(req, P('issue'))) out.push('acknowledge');
  if (['Draft', 'Rejected', 'Approved', 'Issued', 'Lapsed', 'Acknowledged'].includes(status) && !received && can(req, P('cancel'))) out.push('cancel');
  return out;
}

export function purchaseOrderRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: async (tx, r, a) => {
      await setStatus(tx, a, r.subject_id, 'Approved');
      // D06 default: an emergency PO approved by the purchase head alone is reviewed by finance afterwards (within 3 days)
      const po = (await tx.query(`select doc_no, emergency, grand_total from purchase.purchase_orders where id = $1`, [r.subject_id])).rows[0];
      if (po.emergency) {
        const fh = (await tx.query(`select distinct u.id from iam.user_roles ur join iam.roles ro on ro.id = ur.role_id join iam.users u on u.id = ur.user_id
                                      where ro.code = 'FINANCE_HEAD' and ur.status = 'Active' and u.status = 'Active'`)).rows;
        for (const u of fh) {
          await tx.query(`insert into sys.notifications (user_id, kind, title, body, link, dedupe_key) values ($1,'warning',$2,$3,$4,$5) on conflict (user_id, dedupe_key) do nothing`,
            [u.id, `Emergency PO to review — ${po.doc_no}`, `Approved by the purchase head as an emergency (₹${Number(po.grand_total).toLocaleString('en-IN')}). Review within 3 days (D06).`,
              `/purchase/orders/${r.subject_id}`, `po-emergency:${r.subject_id}`]);
        }
      }
    },
    onRejected: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const scope = legalEntityScope(req, P('view'));
    let where = 'o.id = $1';
    if (scope) { args.push(scope); where += ` and o.legal_entity_id = any($2::uuid[])`; }
    const row = (await dbx.query(`${poSelect} where ${where} ${lock ? 'for update of o' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Purchase order');
    return row;
  }
  const inputOf = async (tx: Tx, id: string): Promise<PoInput> => {
    const o = (await tx.query(`select * from purchase.purchase_orders where id = $1`, [id])).rows[0];
    const lines = (await tx.query(`select item_id, qty, rate, discount_pct, delivery_date, requisition_line_id from purchase.purchase_order_lines where purchase_order_id = $1 order by line_no`, [id])).rows;
    return { partyId: o.party_id, legalEntityId: o.legal_entity_id, warehouseId: o.warehouse_id, poDate: o.po_date, deliveryDate: o.delivery_date,
      paymentTermsDays: o.payment_terms_days, deliveryTerms: o.delivery_terms, notes: o.notes, emergency: o.emergency,
      lines: lines.map((l) => ({ itemId: l.item_id, qty: Number(l.qty), rate: Number(l.rate), discountPct: Number(l.discount_pct), deliveryDate: l.delivery_date, requisitionLineId: l.requisition_line_id })) };
  };

  r.get('/defaults', requirePermission(P('create')), asyncHandler(async (_req, res) => {
    res.json({ deliveryTerms: await getSetting(db, 'purchase.defaultDeliveryTerms', ''), acceptanceDays: Number(await getSetting(db, 'purchase.po.acceptanceDays', 7)), today: todayIST() });
  }));

  // approved requisition lines still to be ordered — the picker for new POs
  r.get('/open-requisition-lines', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const args: unknown[] = [LIVE];
    let where = `r.status = 'Approved' and l.qty > l.ordered_qty`;
    const le = str(req.query.legalEntityId);
    if (le) { args.push(le); where += ` and r.legal_entity_id = $${args.length}`; }
    const scope = legalEntityScope(req, P('create'));
    if (scope) { args.push(scope); where += ` and r.legal_entity_id = any($${args.length}::uuid[])`; }
    const rows = await db.query(
      `select l.id, r.id as "requisitionId", r.doc_no as "requisitionNo", r.priority, r.warehouse_id as "warehouseId", r.legal_entity_id as "legalEntityId",
              l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", l.uom, l.qty, l.ordered_qty as "orderedQty", (l.qty - l.ordered_qty) as remaining,
              l.estimated_rate as "estimatedRate", coalesce(l.required_by, r.required_by) as "requiredBy", l.suggested_vendor_id as "suggestedVendorId", sv.legal_name as "suggestedVendor"
         from purchase.requisition_lines l join purchase.requisitions r on r.id = l.requisition_id join mdm.items i on i.id = l.item_id
         left join mdm.parties sv on sv.id = l.suggested_vendor_id
        where ${where} and $1::text[] is not null order by case r.priority when 'EMERGENCY' then 0 when 'URGENT' then 1 else 2 end, coalesce(l.required_by, r.required_by)`, args);
    res.json({ data: rows.rows });
  }));

  r.post('/calculate', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(purchaseOrderSchema, req.body);
    const excludeId = str(req.query.excludeId) ?? null;
    const b = await withTx(db, (tx) => buildPo(tx, req, d, d.poDate ?? todayIST(), false, excludeId));
    res.json({
      lines: b.lines.map((l) => ({ itemId: l.itemId, description: l.description, uom: l.uom, netRate: l.calc.netRate, taxable: toRupees(l.calc.taxable), gstRate: l.gstRate,
        cgst: toRupees(l.calc.cgst), sgst: toRupees(l.calc.sgst), igst: toRupees(l.calc.igst), lineTotal: toRupees(l.calc.lineTotal) })),
      totals: rupeeTotals(b), interState: b.interState, vendorState: b.vendorState, placeOfSupply: b.placeOfSupply, gstApplies: b.vendor.gst_registered,
      warnings: b.warnings, amountInWords: amountInWords(toRupees(b.totals.grandTotal)),
    });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where: string[] = ['true'];
    const scope = legalEntityScope(req, P('view'));
    if (scope) { args.push(scope); where.push(`o.legal_entity_id = any($${args.length}::uuid[])`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(o.doc_no ilike $${args.length} or p.legal_name ilike $${args.length} or p.code ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`o.status = $${args.length}`); }
    const party = str(req.query.partyId);
    if (party) { args.push(party); where.push(`o.party_id = $${args.length}`); }
    const rows = await db.query(`${poSelect.replace('select o.id,', 'select count(*) over() as total, o.id,')} where ${where.join(' and ')} order by o.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const o = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select l.line_no as "lineNo", l.item_id as "itemId", i.code as "itemCode", l.description, l.hsn_code as "hsnCode", l.uom, l.qty, l.rate, l.discount_pct as "discountPct",
              l.net_rate as "netRate", l.taxable, l.gst_rate as "gstRate", l.cgst, l.sgst, l.igst, l.line_total as "lineTotal", l.delivery_date as "deliveryDate",
              l.requisition_line_id as "requisitionLineId", r.id as "requisitionId", r.doc_no as "requisitionNo", l.received_qty as "receivedQty"
         from purchase.purchase_order_lines l join mdm.items i on i.id = l.item_id
         left join purchase.requisition_lines rl on rl.id = l.requisition_line_id left join purchase.requisitions r on r.id = rl.requisition_id
        where l.purchase_order_id = $1 order by l.line_no`, [o.id])).rows;
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, a.rule_name as "ruleName",
              (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'kind', s.step_kind, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, o.id])).rows[0] ?? null;
    const vendor = (await db.query(
      `select a.line1, a.line2, a.city, a.district, a.state_code as "stateCode", a.pincode, p.contact_person as "contactPerson", p.mobile, p.email
         from mdm.parties p left join mdm.party_addresses a on a.party_id = p.id and a.kind = 'REGISTERED' and a.status = 'Active' where p.id = $1`, [o.partyId])).rows[0];
    const buyer = (await db.query(
      `select le.name, le.registered_address as address, le.pan, g.gstin, w.address as "shipAddress"
         from org.legal_entities le join org.warehouses w on w.id = $2
         left join org.gst_registrations g on g.legal_entity_id = le.id and g.state_code = w.state_code and g.status = 'Active' where le.id = $1`, [o.legalEntityId, o.warehouseId])).rows[0];
    const eligibility = ['Draft', 'Rejected', 'Approved', 'Lapsed'].includes(o.status)
      ? await vendorEligibility(db, o.partyId, lines.map((l) => l.itemId), todayIST()) : null;
    const received = lines.some((l) => Number(l.receivedQty) > 0);
    res.json({ ...o, lines, approval, eligibility, allowedActions: allowedActions(req, o.status, received),
      print: { vendor, buyer, amountInWords: amountInWords(Number(o.grandTotal)), acceptanceDays: Number(await getSetting(db, 'purchase.po.acceptanceDays', 7)) } });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(purchaseOrderSchema, req.body);
    res.status(201).json(await withTx(db, (tx) => createPurchaseOrder(tx, req, d)));
  }));

  r.put('/:id', requirePermission(P('edit')), asyncHandler(async (req, res) => {
    const d = parse(purchaseOrderSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!EDITABLE.includes(o.status)) throw Errors.state(`A ${o.status} purchase order cannot be edited.`);
      if (o.version !== d.version) throw Errors.concurrent();
      if (d.partyId !== o.partyId) throw Errors.rule('VENDOR_LOCKED', 'The vendor of a PO cannot be changed. Cancel it and raise a new one.');
      const before = await tx.query(`select requisition_line_id from purchase.purchase_order_lines where purchase_order_id = $1`, [o.id]);
      const b = await buildPo(tx, req, d, o.poDate, true, o.id);
      const cols = ['legal_entity_id', 'warehouse_id', 'delivery_date', 'payment_terms_days', 'delivery_terms', 'notes', 'emergency', 'updated_by', ...HEADER_COLS];
      const vals = [d.legalEntityId, d.warehouseId, d.deliveryDate, d.paymentTermsDays, d.deliveryTerms, d.notes ?? null, d.emergency, req.auth!.user.id, ...headerValues(b)];
      await tx.query(`update purchase.purchase_orders set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [o.id, ...vals]);
      const rfqLines = new Map((await tx.query(`select item_id, rfq_line_id from purchase.purchase_order_lines where purchase_order_id = $1 and rfq_line_id is not null`, [o.id])).rows.map((x) => [x.item_id, x.rfq_line_id]));
      await writeLines(tx, o.id, b, rfqLines);
      await refreshRequisitions(tx, actorOf(req), [...before.rows.map((x) => x.requisition_line_id), ...d.lines.map((l) => l.requisitionLineId ?? '')]);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: o.id, before: { grandTotal: Number(o.grandTotal) }, after: { grandTotal: toRupees(b.totals.grandTotal), lines: d.lines } });
    });
    res.json({ ok: true });
  }));

  // D06 value bands: < ₹1 L purchase head; ₹1–10 L + finance head; > ₹10 L + executive director (BRD p.3); emergency: purchase head now, finance review after
  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!EDITABLE.includes(o.status)) throw Errors.state(`Only a Draft or Rejected PO can be submitted (this one is ${o.status}).`);
      const d = await inputOf(tx, o.id);
      const b = await buildPo(tx, req, d, o.poDate, true, o.id);
      await tx.query(`update purchase.purchase_orders set ${HEADER_COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [o.id, ...headerValues(b)]);
      const facts = { amount: toRupees(b.totals.grandTotal), emergency: o.emergency, vendorCategory: null, lineCount: b.lines.length };
      await setStatus(tx, actorOf(req), o.id, 'Submitted', null, facts);
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SUBJECT, subjectId: o.id, subjectLabel: `${o.docNo} — ${o.vendorName}`, facts, legalEntityId: o.legalEntityId });
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  const issue = (from: string) => asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (o.status !== from) throw Errors.state(from === 'Lapsed' ? 'Only a lapsed PO can be re-issued.' : 'Only an approved PO can be issued.');
      const lines = (await tx.query(`select item_id from purchase.purchase_order_lines where purchase_order_id = $1`, [o.id])).rows.map((x) => x.item_id);
      const elig = await vendorEligibility(tx, o.partyId, lines, todayIST());
      if (!elig.eligible) throw Errors.rule('VENDOR_NOT_ELIGIBLE', `The vendor cannot be ordered from now: ${elig.reasons.join('; ')}.`, elig);
      const days = Number(await getSetting(tx, 'purchase.po.acceptanceDays', 7));
      const due = addDays(todayIST(), days);
      await tx.query(`update purchase.purchase_orders set issued_at = now(), ack_due = $2 where id = $1`, [o.id, due]);
      await setStatus(tx, actorOf(req), o.id, 'Issued', from === 'Lapsed' ? 'Re-issued' : null, { ackDue: due });
      return { ackDue: due };
    });
    res.json(out);
  });
  r.post('/:id/issue', requirePermission(P('issue')), issue('Approved'));
  r.post('/:id/reissue', requirePermission(P('issue')), issue('Lapsed'));

  r.post('/:id/acknowledge', requirePermission(P('issue')), asyncHandler(async (req, res) => {
    const { vendorAckRef } = parse(poAcknowledgeSchema, req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (o.status !== 'Issued') throw Errors.state(o.status === 'Lapsed' ? 'The acceptance period has passed. Re-issue the PO first.' : 'Only an issued PO can be acknowledged.');
      await tx.query(`update purchase.purchase_orders set acknowledged_at = now(), vendor_ack_ref = $2 where id = $1`, [o.id, vendorAckRef]);
      await setStatus(tx, actorOf(req), o.id, 'Acknowledged', null, { vendorAckRef });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      const lines = (await tx.query(`select requisition_line_id, received_qty from purchase.purchase_order_lines where purchase_order_id = $1`, [o.id])).rows;
      if (!allowedActions(req, o.status, lines.some((l) => Number(l.received_qty) > 0)).includes('cancel')) throw Errors.state(`A ${o.status} purchase order cannot be cancelled.`);
      await setStatus(tx, actorOf(req), o.id, 'Cancelled', reason);
      await refreshRequisitions(tx, actorOf(req), lines.map((l) => l.requisition_line_id));
    });
    res.json({ ok: true });
  }));

  return r;
}
