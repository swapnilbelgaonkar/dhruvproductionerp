import { Router, type Request } from 'express';
import { z } from 'zod';
import { reasonSchema, supplierReturnSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { amountInWords, calcPurchaseLine, calcTotals, toRupees } from '../sales/calc';
import { todayIST } from '../sales/quotations';

type ReturnInput = z.infer<typeof supplierReturnSchema>;
const SUBJECT = 'purchase.supplier_return';
const P = (a: string) => `purchase.return:${a}`;

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update purchase.supplier_returns set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    posted_at = case when $2 = 'Posted' then now() else posted_at end, posted_by = case when $2 = 'Posted' then $4 else posted_by end where id = $1`,
  [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/** Lots of a posted receipt with what is left of each, by bucket — what can be returned. */
async function returnableLots(dbx: Db | Tx, grnId: string) {
  return (await dbx.query(
    `select gl.lot_id as "lotId", l.lot_no as "lotNo", l.vendor_lot_no as "vendorLotNo", l.qc_status as "qcStatus", gl.po_line_id as "poLineId", gl.item_id as "itemId",
            i.code as "itemCode", i.name as "itemName", gl.uom, gl.received_qty as "receivedQty", pl.net_rate as rate, pl.gst_rate as "gstRate",
            coalesce((select sum(s.qty) from inv.stock_ledger s where s.lot_id = gl.lot_id and s.bucket = 'REJECTED'), 0) as rejected,
            coalesce((select sum(s.qty) from inv.stock_ledger s where s.lot_id = gl.lot_id and s.bucket = 'UNRESTRICTED'), 0) as unrestricted,
            coalesce((select sum(s.qty) from inv.stock_ledger s where s.lot_id = gl.lot_id and s.bucket = 'BLOCKED'), 0) as blocked
       from purchase.goods_receipt_lines gl join inv.lots l on l.id = gl.lot_id join mdm.items i on i.id = gl.item_id
       join purchase.purchase_order_lines pl on pl.id = gl.po_line_id where gl.goods_receipt_id = $1 order by gl.line_no`, [grnId])).rows;
}

/**
 * Supplier return (PUR-010): goods go back against the original receipt and lot — normally QC-rejected stock, but released or blocked stock
 * can also be returned (damage found later). Posting takes the stock out, reduces the PO's received quantity (a replacement can then be received)
 * and raises a debit note on the vendor at the PO rate and GST.
 */
export function supplierReturnRoutes(db: Db) {
  const r = Router();

  async function validate(tx: Tx, req: Request, d: ReturnInput, date: string) {
    const g = (await tx.query(
      `select g.id, g.doc_no, g.status, g.party_id, g.warehouse_id, g.purchase_order_id, g.receipt_date, o.legal_entity_id, o.inter_state, o.vendor_gst_registered
         from purchase.goods_receipts g join purchase.purchase_orders o on o.id = g.purchase_order_id where g.id = $1`, [d.goodsReceiptId])).rows[0];
    if (!g) throw Errors.notFound('Goods receipt');
    const scope = legalEntityScope(req, P('create'));
    if (scope && !scope.includes(g.legal_entity_id)) throw Errors.notFound('Goods receipt');
    if (g.status !== 'Posted') throw Errors.state('Goods can only be returned against a posted receipt.');
    if (date > todayIST() || date < String(g.receipt_date)) throw Errors.rule('INVALID_DATE', 'The return date must be between the receipt date and today.');
    const lots = await returnableLots(tx, g.id);
    const lines = [];
    let n = 0;
    for (const l of d.lines) {
      n++;
      const lot = lots.find((x) => x.lotId === l.lotId);
      if (!lot) throw Errors.validation([{ field: 'lines', message: `Line ${n}: the lot is not from ${g.doc_no}` }]);
      const avail = Number(lot[l.bucket.toLowerCase() as 'rejected' | 'unrestricted' | 'blocked']);
      if (l.qty > avail + 1e-9) throw Errors.rule('RETURN_QTY_EXCEEDED', `Line ${n}: only ${avail} ${lot.uom} of ${lot.lotNo} is in ${l.bucket.toLowerCase()} stock.`);
      lines.push({ ...l, lineNo: n, poLineId: lot.poLineId as string, itemId: lot.itemId as string, rate: Number(lot.rate), gstRate: Number(lot.gstRate) });
    }
    return { g, lines };
  }

  const select = `select sr.id, sr.doc_no as "docNo", sr.party_id as "partyId", p.legal_name as "vendorName", p.gstin as "vendorGstin", sr.goods_receipt_id as "goodsReceiptId",
      g.doc_no as "grnNo", sr.purchase_order_id as "purchaseOrderId", o.doc_no as "poNo", sr.warehouse_id as "warehouseId", w.code as "warehouseCode", sr.return_date as "returnDate",
      sr.reason, sr.transporter, sr.vehicle_no as "vehicleNo", sr.status, sr.status_reason as "statusReason", sr.posted_at as "postedAt", pu.full_name as "postedBy",
      sr.created_at as "createdAt", cu.full_name as "createdBy", sr.version, o.legal_entity_id as "legalEntityId", o.inter_state as "interState"
    from purchase.supplier_returns sr join mdm.parties p on p.id = sr.party_id join purchase.goods_receipts g on g.id = sr.goods_receipt_id
    join purchase.purchase_orders o on o.id = sr.purchase_order_id join org.warehouses w on w.id = sr.warehouse_id
    left join iam.users pu on pu.id = sr.posted_by left join iam.users cu on cu.id = sr.created_by`;
  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const scope = legalEntityScope(req, P('view'));
    let where = 'sr.id = $1';
    if (scope) { args.push(scope); where += ' and o.legal_entity_id = any($2::uuid[])'; }
    const row = (await dbx.query(`${select} where ${where} ${lock ? 'for update of sr' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Supplier return');
    return row;
  }

  r.get('/returnable', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const grnId = str(req.query.goodsReceiptId);
    if (!grnId) {
      // posted receipts that still hold stock of their lots
      const rows = await db.query(
        `select g.id, g.doc_no as "docNo", p.legal_name as "vendorName", g.receipt_date as "receiptDate",
                (select count(*)::int from purchase.goods_receipt_lines gl join inv.lots l on l.id = gl.lot_id where gl.goods_receipt_id = g.id and l.qc_status = 'Rejected') as "rejectedLots"
           from purchase.goods_receipts g join mdm.parties p on p.id = g.party_id
          where g.status = 'Posted' and exists (select 1 from purchase.goods_receipt_lines gl join inv.stock_ledger s on s.lot_id = gl.lot_id
                                               where gl.goods_receipt_id = g.id and s.bucket in ('REJECTED','UNRESTRICTED','BLOCKED') group by gl.lot_id having sum(s.qty) > 0)
          order by "rejectedLots" desc, g.receipt_date desc limit 100`);
      res.json({ data: rows.rows });
      return;
    }
    res.json({ data: await returnableLots(db, grnId) });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const scope = legalEntityScope(req, P('view'));
    if (scope) { args.push(scope); where.push(`o.legal_entity_id = any($${args.length}::uuid[])`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(sr.doc_no ilike $${args.length} or g.doc_no ilike $${args.length} or p.legal_name ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`sr.status = $${args.length}`); }
    const rows = await db.query(`${select.replace('select sr.id,', 'select count(*) over() as total, sr.id,')} where ${where.join(' and ')} order by sr.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const sr = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select l.line_no as "lineNo", l.lot_id as "lotId", lt.lot_no as "lotNo", lt.vendor_lot_no as "vendorLotNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName",
              i.base_uom as uom, h.code as "hsnCode", l.bucket, l.qty, l.rate, l.gst_rate as "gstRate"
         from purchase.supplier_return_lines l join inv.lots lt on lt.id = l.lot_id join mdm.items i on i.id = l.item_id left join mdm.hsn_codes h on h.id = i.hsn_id
        where l.supplier_return_id = $1 order by l.line_no`, [sr.id])).rows;
    const debitNote = (await db.query(`select id, doc_no as "docNo", note_date as "noteDate", taxable_total as "taxableTotal", cgst_total as "cgstTotal", sgst_total as "sgstTotal",
                                         igst_total as "igstTotal", round_off as "roundOff", grand_total as "grandTotal", status from purchase.debit_notes where supplier_return_id = $1`, [sr.id])).rows[0] ?? null;
    const actions: string[] = [];
    if (sr.status === 'Draft' && can(req, P('post'))) actions.push('post');
    if (sr.status === 'Draft' && can(req, P('create'))) actions.push('cancel');
    res.json({ ...sr, lines, debitNote, allowedActions: actions, amountInWords: debitNote ? amountInWords(Number(debitNote.grandTotal)) : null });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(supplierReturnSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const date = d.returnDate ?? todayIST();
      const v = await validate(tx, req, d, date);
      const docNo = await nextDocNo(tx, 'SUPPLIER_RETURN');
      const sr = (await tx.query(
        `insert into purchase.supplier_returns (doc_no, party_id, goods_receipt_id, purchase_order_id, warehouse_id, return_date, reason, transporter, vehicle_no, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) returning id`,
        [docNo, v.g.party_id, v.g.id, v.g.purchase_order_id, v.g.warehouse_id, date, d.reason, d.transporter, d.vehicleNo, req.auth!.user.id])).rows[0];
      for (const l of v.lines) {
        await tx.query(`insert into purchase.supplier_return_lines (supplier_return_id, line_no, lot_id, po_line_id, item_id, bucket, qty, rate, gst_rate) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [sr.id, l.lineNo, l.lotId, l.poLineId, l.itemId, l.bucket, l.qty, l.rate, l.gstRate]);
      }
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: sr.id, after: { docNo, grn: v.g.doc_no, ...d } });
      return { id: sr.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/post', requirePermission(P('post')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const sr = await load(tx, req, req.params.id!, true);
      if (sr.status !== 'Draft') throw Errors.state('Only a Draft return can be posted.');
      const rows = (await tx.query(`select * from purchase.supplier_return_lines where supplier_return_id = $1 order by line_no`, [sr.id])).rows;
      const v = await validate(tx, req, { goodsReceiptId: sr.goodsReceiptId, reason: sr.reason, transporter: null, vehicleNo: null,
        lines: rows.map((l) => ({ lotId: l.lot_id, bucket: l.bucket, qty: Number(l.qty) })) }, sr.returnDate);
      const po = (await tx.query(`select id, status, inter_state, vendor_gst_registered from purchase.purchase_orders where id = $1 for update`, [sr.purchaseOrderId])).rows[0];
      const calcs = [];
      for (const l of v.lines) {
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,$4,$5,$6,'SUPPLIER_RETURN',$7,$8,$9)`, [l.itemId, l.lotId, sr.warehouseId, l.bucket, -l.qty, l.rate, SUBJECT, sr.id, req.auth!.user.id]);
        await tx.query(`update purchase.purchase_order_lines set received_qty = greatest(received_qty - $2, 0) where id = $1`, [l.poLineId, l.qty]);
        calcs.push(calcPurchaseLine({ qty: l.qty, rate: l.rate, discountPct: 0, gstRate: l.gstRate }, po.inter_state, po.vendor_gst_registered));
      }
      // a fully received PO reopens so the replacement can be received
      if (po.status === 'Received') {
        await allowTransition(tx);
        await tx.query(`update purchase.purchase_orders set status = 'PartiallyReceived', status_reason = $2 where id = $1`, [po.id, `Goods returned on ${sr.docNo}`]);
        await audit(tx, actorOf(req), { action: 'purchase.order.status', entityType: 'purchase.order', entityId: po.id, after: { status: 'PartiallyReceived', return: sr.docNo } });
      }
      const t = calcTotals(calcs);
      const dnNo = await nextDocNo(tx, 'DEBIT_NOTE');
      await tx.query(
        `insert into purchase.debit_notes (doc_no, party_id, supplier_return_id, note_date, reason, inter_state, taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [dnNo, sr.partyId, sr.id, sr.returnDate, `Goods returned: ${sr.reason}`, po.inter_state, toRupees(t.taxableTotal), toRupees(t.cgstTotal), toRupees(t.sgstTotal), toRupees(t.igstTotal),
          toRupees(t.roundOff), toRupees(t.grandTotal), req.auth!.user.id]);
      await setStatus(tx, actorOf(req), sr.id, 'Posted');
      await audit(tx, actorOf(req), { action: 'purchase.debit_note.created', entityType: SUBJECT, entityId: sr.id, after: { debitNote: dnNo, amount: toRupees(t.grandTotal) } });
      return { debitNote: dnNo, amount: toRupees(t.grandTotal) };
    });
    res.json(out);
  }));

  r.post('/:id/cancel', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const sr = await load(tx, req, req.params.id!, true);
      if (sr.status !== 'Draft') throw Errors.state('Only a Draft return can be cancelled.');
      await setStatus(tx, actorOf(req), sr.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
