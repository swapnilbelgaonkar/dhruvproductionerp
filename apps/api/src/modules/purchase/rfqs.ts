import { Router, type Request } from 'express';
import { z } from 'zod';
import { reasonSchema, rfqAwardSchema, rfqSchema, vendorQuoteSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, inLegalEntityScope, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { vendorEligibility } from '../vendors/routes';
import { createPurchaseOrder } from './orders';

const SUBJECT = 'purchase.rfq';
const P = (a: string) => `${SUBJECT}:${a}`;
type RfqInput = z.infer<typeof rfqSchema>;
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update purchase.rfqs set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    issued_at = case when $2 = 'Issued' then now() else issued_at end, awarded_at = case when $2 = 'Awarded' then now() else awarded_at end where id = $1`,
  [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

export interface CmpLine {
  id: string; lineNo: number; itemId: string; itemCode: string; itemName: string; uom: string; qty: string; requiredBy: string | null; specification: string | null;
  bids: Bid[]; recommended: string | null; award: { vendorQuoteId: string; rank: number; score: number; overrideReason: string | null } | null;
}
export interface Bid {
  vendorQuoteId: string; partyId: string; vendorCode: string; vendorName: string; quoteRef: string; rate: number; discountPct: number; netRate: number;
  freightPerUnit: number; landedRate: number; leadDays: number; paymentTermsDays: number; rating: number | null; compliant: boolean; validQuote: boolean;
  eligible: boolean; reasons: string[]; qualified: boolean; scores: { price: number; leadTime: number; quality: number }; score: number; rank: number;
}

/**
 * Comparative statement (MP §10.3, PUR-005/014, D34 provisional): per line, every bid's landed rate (net rate plus its share of freight, spread by value),
 * lead time and the vendor's quality rating are scored with the weights in `purchase.rfq.weights`. Only qualified bids (technically compliant, quote still
 * valid, vendor eligible for the item) are ranked; the top one is pre-selected — purchase confirms, with a reason when choosing another.
 */
export async function comparison(dbx: Db | Tx, rfqId: string) {
  const w = await getSetting<{ price: number; leadTime: number; quality: number }>(dbx, 'purchase.rfq.weights', { price: 60, leadTime: 20, quality: 20 });
  const lines = (await dbx.query(
    `select l.id, l.line_no as "lineNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", l.uom, l.qty, l.required_by as "requiredBy", l.specification
       from purchase.rfq_lines l join mdm.items i on i.id = l.item_id where l.rfq_id = $1 order by l.line_no`, [rfqId])).rows;
  const quotes = (await dbx.query(
    `select q.id, q.party_id, p.code, p.legal_name, q.quote_ref, q.valid_until, q.payment_terms_days, q.delivery_days, q.freight, vp.rating,
            coalesce(sum(ql.rate * (1 - ql.discount_pct / 100) * rl.qty), 0) as quote_value
       from purchase.vendor_quotes q join mdm.parties p on p.id = q.party_id join mdm.vendor_profiles vp on vp.party_id = q.party_id
       left join purchase.vendor_quote_lines ql on ql.vendor_quote_id = q.id left join purchase.rfq_lines rl on rl.id = ql.rfq_line_id
      where q.rfq_id = $1 group by q.id, p.code, p.legal_name, vp.rating`, [rfqId])).rows;
  const qlines = (await dbx.query(
    `select ql.* from purchase.vendor_quote_lines ql join purchase.vendor_quotes q on q.id = ql.vendor_quote_id where q.rfq_id = $1`, [rfqId])).rows;
  const awards = new Map((await dbx.query(`select a.* from purchase.rfq_awards a join purchase.rfq_lines l on l.id = a.rfq_line_id where l.rfq_id = $1`, [rfqId])).rows.map((a) => [a.rfq_line_id, a]));
  const today = todayIST();
  const out: CmpLine[] = [];
  for (const l of lines) {
    const bids: Bid[] = [];
    for (const q of quotes) {
      const ql = qlines.find((x) => x.vendor_quote_id === q.id && x.rfq_line_id === l.id);
      if (!ql) continue;
      const netRate = Number(ql.rate) * (1 - Number(ql.discount_pct) / 100);
      const share = Number(q.quote_value) > 0 ? (Number(q.freight) * (netRate * Number(l.qty)) / Number(q.quote_value)) / Number(l.qty) : 0;
      const elig = await vendorEligibility(dbx, q.party_id, [l.itemId], today);
      const validQuote = String(q.valid_until) >= today;
      bids.push({
        vendorQuoteId: q.id, partyId: q.party_id, vendorCode: q.code, vendorName: q.legal_name, quoteRef: q.quote_ref, rate: Number(ql.rate), discountPct: Number(ql.discount_pct),
        netRate: Math.round(netRate * 10000) / 10000, freightPerUnit: Math.round(share * 10000) / 10000, landedRate: Math.round((netRate + share) * 10000) / 10000,
        leadDays: Number(q.delivery_days), paymentTermsDays: Number(q.payment_terms_days), rating: q.rating === null ? null : Number(q.rating), compliant: ql.compliant,
        validQuote, eligible: elig.eligible, reasons: [...(ql.compliant ? [] : ['Not technically compliant']), ...(validQuote ? [] : ['Quote validity expired']), ...elig.reasons],
        qualified: ql.compliant && validQuote && elig.eligible, scores: { price: 0, leadTime: 0, quality: 0 }, score: 0, rank: 0,
      });
    }
    const ok = bids.filter((b) => b.qualified);
    const minLanded = Math.min(...ok.map((b) => b.landedRate));
    const minLead = Math.min(...ok.map((b) => b.leadDays));
    for (const b of ok) {
      // an unrated (new) vendor is scored as average (3 of 5) until receipts and QC build its rating
      b.scores = { price: (minLanded / b.landedRate) * w.price, leadTime: ((minLead + 1) / (b.leadDays + 1)) * w.leadTime, quality: ((b.rating ?? 3) / 5) * w.quality };
      b.score = Math.round((b.scores.price + b.scores.leadTime + b.scores.quality) * 100) / 100;
    }
    bids.sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.score - a.score || a.landedRate - b.landedRate);
    let rank = 0;
    for (const b of bids) b.rank = b.qualified ? ++rank : 0;
    const a = awards.get(l.id);
    out.push({ ...l, bids, recommended: bids.find((b) => b.rank === 1)?.vendorQuoteId ?? null,
      award: a ? { vendorQuoteId: a.vendor_quote_id, rank: a.rank, score: Number(a.score), overrideReason: a.override_reason } : null });
  }
  return { weights: w, lines: out };
}

export function rfqRoutes(db: Db) {
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const scope = legalEntityScope(req, P('view'));
    let where = 'r.id = $1';
    if (scope) { args.push(scope); where += ' and r.legal_entity_id = any($2::uuid[])'; }
    const row = (await dbx.query(
      `select r.id, r.doc_no as "docNo", r.legal_entity_id as "legalEntityId", le.name as "legalEntityName", r.warehouse_id as "warehouseId", w.code as "warehouseCode",
              w.name as "warehouseName", r.response_due as "responseDue", r.notes, r.status, r.status_reason as "statusReason", r.issued_at as "issuedAt", r.awarded_at as "awardedAt",
              r.created_at as "createdAt", u.full_name as "createdBy", r.version
         from purchase.rfqs r join org.legal_entities le on le.id = r.legal_entity_id join org.warehouses w on w.id = r.warehouse_id left join iam.users u on u.id = r.created_by
        where ${where} ${lock ? 'for update of r' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('RFQ');
    return row;
  }

  async function validate(tx: Tx, req: Request, d: RfqInput) {
    if (!inLegalEntityScope(req, P('manage'), d.legalEntityId)) throw Errors.forbidden(`${P('manage')} for this legal entity`);
    const wh = (await tx.query(`select status, legal_entity_id from org.warehouses where id = $1`, [d.warehouseId])).rows[0];
    if (wh?.status !== 'Active' || wh.legal_entity_id !== d.legalEntityId) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active warehouse of the same legal entity.');
    if (d.responseDue < todayIST()) throw Errors.rule('INVALID_DATE', 'The response deadline cannot be in the past.');
    const lines = [];
    let n = 0;
    for (const l of d.lines) {
      n++;
      const it = (await tx.query(`select status, base_uom from mdm.items where id = $1`, [l.itemId])).rows[0];
      if (it?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', `Line ${n}: only approved items can be quoted for.`);
      if (l.requisitionLineId) {
        const pr = (await tx.query(`select l.item_id, r.status, r.legal_entity_id from purchase.requisition_lines l join purchase.requisitions r on r.id = l.requisition_id where l.id = $1`, [l.requisitionLineId])).rows[0];
        if (!pr || pr.status !== 'Approved' || pr.item_id !== l.itemId || pr.legal_entity_id !== d.legalEntityId) throw Errors.rule('REQUISITION_INVALID', `Line ${n}: link it to an approved requisition line for the same item.`);
      }
      lines.push({ ...l, lineNo: n, uom: it.base_uom as string });
    }
    for (const v of d.vendorIds) {
      const vp = (await tx.query(`select p.code, vp.status, (select count(*)::int from mdm.vendor_items vi where vi.party_id = p.id and vi.status = 'Active' and vi.item_id = any($2::uuid[])) as approved
                                    from mdm.parties p join mdm.vendor_profiles vp on vp.party_id = p.id where p.id = $1`, [v, d.lines.map((l) => l.itemId)])).rows[0];
      if (vp?.status !== 'Active') throw Errors.rule('VENDOR_NOT_ACTIVE', 'Only active vendors can be invited.');
      if (!vp.approved) throw Errors.rule('VENDOR_NOT_APPROVED', `${vp.code} is not approved for any of these items.`);
    }
    return lines;
  }
  async function write(tx: Tx, id: string, lines: Awaited<ReturnType<typeof validate>>, vendorIds: string[]) {
    await tx.query(`delete from purchase.rfq_vendors where rfq_id = $1`, [id]);
    await tx.query(`delete from purchase.rfq_lines where rfq_id = $1`, [id]);
    for (const l of lines) {
      await tx.query(`insert into purchase.rfq_lines (rfq_id, line_no, item_id, uom, qty, required_by, specification, requisition_line_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, l.lineNo, l.itemId, l.uom, l.qty, l.requiredBy ?? null, l.specification, l.requisitionLineId ?? null]);
    }
    for (const v of vendorIds) await tx.query(`insert into purchase.rfq_vendors (rfq_id, party_id) values ($1,$2)`, [id, v]);
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const scope = legalEntityScope(req, P('view'));
    if (scope) { args.push(scope); where.push(`r.legal_entity_id = any($${args.length}::uuid[])`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`r.doc_no ilike $${args.length}`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`r.status = $${args.length}`); }
    const rows = await db.query(
      `select r.id, r.doc_no as "docNo", r.response_due as "responseDue", r.status, w.code as "warehouseCode", r.created_at as "createdAt",
              (select count(*)::int from purchase.rfq_lines l where l.rfq_id = r.id) as "lineCount",
              (select count(*)::int from purchase.rfq_vendors v where v.rfq_id = r.id) as "vendorCount",
              (select count(*)::int from purchase.vendor_quotes q where q.rfq_id = r.id) as "quoteCount", count(*) over() as total
         from purchase.rfqs r join org.warehouses w on w.id = r.warehouse_id where ${where.join(' and ')} order by r.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const rfq = await load(db, req, req.params.id!);
    const vendors = (await db.query(
      `select p.id, p.code, p.legal_name as "legalName", vp.rating, q.id as "quoteId", q.quote_ref as "quoteRef", q.quote_date as "quoteDate", q.valid_until as "validUntil",
              q.payment_terms_days as "paymentTermsDays", q.delivery_days as "deliveryDays", q.freight, q.remarks, q.document_id as "documentId"
         from purchase.rfq_vendors v join mdm.parties p on p.id = v.party_id join mdm.vendor_profiles vp on vp.party_id = p.id
         left join purchase.vendor_quotes q on q.rfq_id = v.rfq_id and q.party_id = v.party_id where v.rfq_id = $1 order by p.legal_name`, [rfq.id])).rows;
    const pos = (await db.query(`select o.id, o.doc_no as "docNo", o.status, p.legal_name as "vendorName", o.grand_total as "grandTotal" from purchase.purchase_orders o
                                   join mdm.parties p on p.id = o.party_id where o.rfq_id = $1 order by o.doc_no`, [rfq.id])).rows;
    const cmp = await comparison(db, rfq.id);
    const manage = can(req, P('manage'));
    const actions: string[] = [];
    if (rfq.status === 'Draft' && manage) actions.push('edit', 'issue');
    if (rfq.status === 'Issued' && manage) actions.push('record_quote', 'award');
    if (['Draft', 'Issued'].includes(rfq.status) && manage) actions.push('cancel');
    res.json({ ...rfq, vendors, ...cmp, purchaseOrders: pos, allowedActions: actions });
  }));

  r.post('/', requirePermission(P('manage')), asyncHandler(async (req, res) => {
    const d = parse(rfqSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const lines = await validate(tx, req, d);
      const docNo = await nextDocNo(tx, 'RFQ');
      const row = (await tx.query(`insert into purchase.rfqs (doc_no, legal_entity_id, warehouse_id, response_due, notes, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id`,
        [docNo, d.legalEntityId, d.warehouseId, d.responseDue, d.notes ?? null, req.auth!.user.id])).rows[0];
      await write(tx, row.id, lines, d.vendorIds);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: row.id, after: { docNo, ...d } });
      return { id: row.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('manage')), asyncHandler(async (req, res) => {
    const d = parse(rfqSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const rfq = await load(tx, req, req.params.id!, true);
      if (rfq.status !== 'Draft') throw Errors.state('Only a Draft RFQ can be edited.');
      if (rfq.version !== d.version) throw Errors.concurrent();
      const lines = await validate(tx, req, d);
      await tx.query(`update purchase.rfqs set legal_entity_id = $2, warehouse_id = $3, response_due = $4, notes = $5, updated_by = $6 where id = $1`,
        [rfq.id, d.legalEntityId, d.warehouseId, d.responseDue, d.notes ?? null, req.auth!.user.id]);
      await write(tx, rfq.id, lines, d.vendorIds);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: rfq.id, after: d });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/issue', requirePermission(P('manage')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const rfq = await load(tx, req, req.params.id!, true);
      if (rfq.status !== 'Draft') throw Errors.state('Only a Draft RFQ can be issued.');
      if (String(rfq.responseDue) < todayIST()) throw Errors.rule('INVALID_DATE', 'The response deadline has passed. Edit it first.');
      await setStatus(tx, actorOf(req), rfq.id, 'Issued');
    });
    res.json({ ok: true });
  }));

  // the vendor's quotation, keyed in by purchase (one per vendor; recording again replaces it until award)
  r.post('/:id/quotes', requirePermission(P('manage')), asyncHandler(async (req, res) => {
    const q = parse(vendorQuoteSchema, req.body);
    await withTx(db, async (tx) => {
      const rfq = await load(tx, req, req.params.id!, true);
      if (rfq.status !== 'Issued') throw Errors.state('Quotes are recorded while the RFQ is issued.');
      if (!(await tx.query(`select 1 from purchase.rfq_vendors where rfq_id = $1 and party_id = $2`, [rfq.id, q.partyId])).rowCount) throw Errors.rule('VENDOR_NOT_INVITED', 'This vendor was not invited to the RFQ.');
      const lineIds = new Set((await tx.query(`select id from purchase.rfq_lines where rfq_id = $1`, [rfq.id])).rows.map((x) => x.id));
      if (q.lines.some((l) => !lineIds.has(l.rfqLineId))) throw Errors.validation([{ field: 'lines', message: 'A quoted line does not belong to this RFQ' }]);
      if (q.documentId) {
        const doc = (await tx.query(`select entity_id from sys.documents where id = $1 and status = 'Active'`, [q.documentId])).rows[0];
        if (doc?.entity_id !== q.partyId) throw Errors.rule('DOCUMENT_INVALID', 'Attach the quotation document to the vendor first.');
      }
      await tx.query(`delete from purchase.vendor_quotes where rfq_id = $1 and party_id = $2`, [rfq.id, q.partyId]);
      const vq = (await tx.query(
        `insert into purchase.vendor_quotes (rfq_id, party_id, quote_ref, quote_date, valid_until, payment_terms_days, delivery_days, freight, document_id, remarks, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [rfq.id, q.partyId, q.quoteRef, q.quoteDate, q.validUntil, q.paymentTermsDays, q.deliveryDays, q.freight, q.documentId ?? null, q.remarks, req.auth!.user.id])).rows[0];
      for (const l of q.lines) {
        await tx.query(`insert into purchase.vendor_quote_lines (vendor_quote_id, rfq_line_id, rate, discount_pct, compliant, remarks) values ($1,$2,$3,$4,$5,$6)`,
          [vq.id, l.rfqLineId, l.rate, l.discountPct, l.compliant, l.remarks]);
      }
      await audit(tx, actorOf(req), { action: `${SUBJECT}.quote_recorded`, entityType: SUBJECT, entityId: rfq.id, after: q });
    });
    res.status(201).json({ ok: true });
  }));

  r.get('/:id/comparison', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const rfq = await load(db, req, req.params.id!);
    res.json(await comparison(db, rfq.id));
  }));

  // Award per line; the awarded lines become Draft POs, one per vendor, at the quoted rates (PUR-005/014)
  r.post('/:id/award', requirePermission(P('manage')), asyncHandler(async (req, res) => {
    const a = parse(rfqAwardSchema, req.body);
    if (!can(req, 'purchase.order:create')) throw Errors.forbidden('purchase.order:create');
    const out = await withTx(db, async (tx) => {
      const rfq = await load(tx, req, req.params.id!, true);
      if (rfq.status !== 'Issued') throw Errors.state('Only an issued RFQ can be awarded.');
      const cmp = await comparison(tx, rfq.id);
      if (new Set(a.lines.map((l) => l.rfqLineId)).size !== a.lines.length) throw Errors.validation([{ field: 'lines', message: 'Award each line once' }]);
      type AwardLine = { rfqLineId: string; itemId: string; qty: number; rate: number; discountPct: number; requisitionLineId: string | null };
      const byVendor = new Map<string, { quoteId: string; lines: AwardLine[] }>();
      for (const choice of a.lines) {
        const line = cmp.lines.find((l) => l.id === choice.rfqLineId);
        if (!line) throw Errors.validation([{ field: 'lines', message: 'A line does not belong to this RFQ' }]);
        const bid = line.bids.find((b) => b.vendorQuoteId === choice.vendorQuoteId);
        if (!bid) throw Errors.rule('NO_BID', `Line ${line.lineNo}: that vendor did not quote for ${line.itemCode}.`);
        if (!bid.qualified) throw Errors.rule('BID_NOT_QUALIFIED', `Line ${line.lineNo}: ${bid.vendorName} cannot be awarded — ${bid.reasons.join('; ')}.`);
        if (bid.rank !== 1 && !choice.overrideReason) throw Errors.rule('OVERRIDE_REASON_REQUIRED', `Line ${line.lineNo}: ${bid.vendorName} is ranked ${bid.rank}. Give the reason for not choosing the top-ranked bid.`);
        await tx.query(`insert into purchase.rfq_awards (rfq_line_id, vendor_quote_id, rank, score, override_reason, awarded_by) values ($1,$2,$3,$4,$5,$6)`,
          [line.id, bid.vendorQuoteId, bid.rank, bid.score, bid.rank === 1 ? null : choice.overrideReason, req.auth!.user.id]);
        const rl = (await tx.query(`select requisition_line_id from purchase.rfq_lines where id = $1`, [line.id])).rows[0];
        const g = byVendor.get(bid.partyId) ?? { quoteId: bid.vendorQuoteId, lines: [] as AwardLine[] };
        g.lines.push({ rfqLineId: line.id, itemId: line.itemId, qty: Number(line.qty), rate: bid.rate, discountPct: bid.discountPct, requisitionLineId: rl.requisition_line_id });
        byVendor.set(bid.partyId, g);
      }
      const defaults = await getSetting(tx, 'purchase.defaultDeliveryTerms', 'As agreed');
      const pos = [];
      for (const [partyId, g] of byVendor) {
        const q = (await tx.query(`select quote_ref, payment_terms_days, delivery_days, freight from purchase.vendor_quotes where id = $1`, [g.quoteId])).rows[0];
        const po = await createPurchaseOrder(tx, req, {
          partyId, legalEntityId: rfq.legalEntityId, warehouseId: rfq.warehouseId, deliveryDate: addDays(todayIST(), Number(q.delivery_days)), paymentTermsDays: Number(q.payment_terms_days),
          deliveryTerms: Number(q.freight) > 0 ? `${defaults}. Freight ₹${Number(q.freight).toLocaleString('en-IN')} as quoted` : defaults,
          notes: `Against ${rfq.docNo}, vendor quotation ${q.quote_ref}`, emergency: false,
          lines: g.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, rate: l.rate, discountPct: l.discountPct, requisitionLineId: l.requisitionLineId })),
        }, { rfqId: rfq.id, rfqLines: new Map(g.lines.map((l) => [l.itemId, l.rfqLineId])) });
        pos.push(po);
      }
      await setStatus(tx, actorOf(req), rfq.id, 'Awarded', `${pos.length} purchase order(s) drafted`);
      return { purchaseOrders: pos };
    });
    res.json(out);
  }));

  r.post('/:id/cancel', requirePermission(P('manage')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const rfq = await load(tx, req, req.params.id!, true);
      if (!['Draft', 'Issued'].includes(rfq.status)) throw Errors.state(`A ${rfq.status} RFQ cannot be cancelled.`);
      await setStatus(tx, actorOf(req), rfq.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
