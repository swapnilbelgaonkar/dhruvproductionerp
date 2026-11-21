import { Router, type Request } from 'express';
import { z } from 'zod';
import { goodsReceiptSchema, reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';

type GrnInput = z.infer<typeof goodsReceiptSchema>;
const SUBJECT = 'purchase.goods_receipt';
const P = (a: string) => `purchase.grn:${a}`;
/** POs goods can be received against: issued (within the acceptance period), acknowledged, or partly received */
const RECEIVABLE = ['Issued', 'Acknowledged', 'PartiallyReceived'];
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update purchase.goods_receipts set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4,
                    posted_at = case when $2 = 'Posted' then now() else posted_at end, posted_by = case when $2 = 'Posted' then $4 else posted_by end where id = $1`,
  [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

async function notifyRoles(tx: Tx, roles: string[], title: string, body: string, link: string, dedupe: string) {
  const users = (await tx.query(`select distinct u.id from iam.user_roles ur join iam.roles r on r.id = ur.role_id join iam.users u on u.id = ur.user_id
                                   where r.code = any($1) and ur.status = 'Active' and u.status = 'Active'`, [roles])).rows;
  for (const u of users) {
    await tx.query(`insert into sys.notifications (user_id, kind, title, body, link, dedupe_key) values ($1,'info',$2,$3,$4,$5) on conflict (user_id, dedupe_key) do nothing`, [u.id, title, body, link, dedupe]);
  }
}

/**
 * Checks a receipt against its PO (PUR-008, TC-09): PO receivable, lines of this PO, cumulative receipts within the over-receipt tolerance
 * (D06 default +2%), lot details for lot-controlled items, expiry derived from the shelf life and never already past.
 */
async function validate(tx: Tx, req: Request, d: GrnInput, receiptDate: string, excludeGrnId: string | null) {
  const po = (await tx.query(`select id, doc_no, status, party_id, warehouse_id, legal_entity_id, po_date from purchase.purchase_orders where id = $1`, [d.purchaseOrderId])).rows[0];
  if (!po) throw Errors.notFound('Purchase order');
  const scope = legalEntityScope(req, P('create'));
  if (scope && !scope.includes(po.legal_entity_id)) throw Errors.notFound('Purchase order');
  if (!RECEIVABLE.includes(po.status)) {
    throw Errors.state(po.status === 'Lapsed' ? `${po.doc_no} lapsed without the vendor's acknowledgement. Purchase must re-issue it before goods can be received.`
      : `Goods cannot be received against a ${po.status} PO.`);
  }
  if (receiptDate > todayIST()) throw Errors.rule('FUTURE_DATE', 'The receipt date cannot be in the future.');
  if (receiptDate < String(po.po_date)) throw Errors.rule('INVALID_DATE', 'The receipt date cannot be before the PO date.');
  const tolerance = Number(await getSetting(tx, 'purchase.grn.overReceiptPct', 2));
  const lines = [];
  let n = 0;
  for (const l of d.lines) {
    n++;
    const pl = (await tx.query(
      `select pl.id, pl.item_id, pl.qty, pl.uom, pl.net_rate, i.code, i.lot_controlled, i.shelf_life_days,
              coalesce((select sum(gl.received_qty) from purchase.goods_receipt_lines gl join purchase.goods_receipts g on g.id = gl.goods_receipt_id
                         where gl.po_line_id = pl.id and g.status = 'Posted' and g.id is distinct from $3), 0) as received
         from purchase.purchase_order_lines pl join mdm.items i on i.id = pl.item_id where pl.id = $1 and pl.purchase_order_id = $2`, [l.poLineId, po.id, excludeGrnId])).rows[0];
    if (!pl) throw Errors.validation([{ field: 'lines', message: `Line ${n} does not belong to ${po.doc_no}` }]);
    const max = Number(pl.qty) * (1 + tolerance / 100) - Number(pl.received);
    if (l.receivedQty > max + 1e-9) {
      throw Errors.rule('GRN_QTY_EXCEEDED', `Line ${n} (${pl.code}): at most ${Math.max(0, Math.round(max * 10000) / 10000)} ${pl.uom} more can be received (ordered ${Number(pl.qty)}, already received ${Number(pl.received)}, tolerance +${tolerance}%).`, { line: n, max });
    }
    if (pl.lot_controlled && !l.vendorLotNo) throw Errors.validation([{ field: `lines.${n - 1}.vendorLotNo`, message: `Line ${n}: ${pl.code} is lot-controlled — enter the vendor's batch number` }]);
    let expiry = l.expiryDate ?? null;
    if (!expiry && l.mfgDate && pl.shelf_life_days) expiry = addDays(l.mfgDate, Number(pl.shelf_life_days));
    if (l.mfgDate && l.mfgDate > receiptDate) throw Errors.rule('INVALID_DATE', `Line ${n}: the manufacturing date cannot be after the receipt date.`);
    if (expiry && expiry <= receiptDate) throw Errors.rule('EXPIRED_ON_RECEIPT', `Line ${n}: the material has already expired (${expiry}). Do not receive it; return it to the vendor.`);
    lines.push({ ...l, lineNo: n, itemId: pl.item_id as string, uom: pl.uom as string, netRate: Number(pl.net_rate), expiryDate: expiry, code: pl.code as string });
  }
  return { po, lines };
}

const grnSelect = `select g.id, g.doc_no as "docNo", g.purchase_order_id as "purchaseOrderId", o.doc_no as "poNo", o.status as "poStatus", g.party_id as "partyId",
    p.code as "vendorCode", p.legal_name as "vendorName", g.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name as "warehouseName",
    g.receipt_date as "receiptDate", g.challan_no as "challanNo", g.challan_date as "challanDate", g.vendor_invoice_no as "vendorInvoiceNo", g.vehicle_no as "vehicleNo",
    g.remarks, g.status, g.status_reason as "statusReason", g.posted_at as "postedAt", pu.full_name as "postedBy", g.created_at as "createdAt", cu.full_name as "createdBy", g.version,
    o.legal_entity_id as "legalEntityId"
  from purchase.goods_receipts g join purchase.purchase_orders o on o.id = g.purchase_order_id join mdm.parties p on p.id = g.party_id
  join org.warehouses w on w.id = g.warehouse_id left join iam.users pu on pu.id = g.posted_by left join iam.users cu on cu.id = g.created_by`;

export function goodsReceiptRoutes(db: Db) {
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const scope = legalEntityScope(req, P('view'));
    let where = 'g.id = $1';
    if (scope) { args.push(scope); where += ' and o.legal_entity_id = any($2::uuid[])'; }
    const row = (await dbx.query(`${grnSelect} where ${where} ${lock ? 'for update of g' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Goods receipt');
    return row;
  }
  async function writeLines(tx: Tx, grnId: string, lines: Awaited<ReturnType<typeof validate>>['lines']) {
    await tx.query(`delete from purchase.goods_receipt_lines where goods_receipt_id = $1`, [grnId]);
    for (const l of lines) {
      await tx.query(`insert into purchase.goods_receipt_lines (goods_receipt_id, line_no, po_line_id, item_id, uom, challan_qty, received_qty, vendor_lot_no, mfg_date, expiry_date)
                      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [grnId, l.lineNo, l.poLineId, l.itemId, l.uom, l.challanQty, l.receivedQty, l.vendorLotNo, l.mfgDate ?? null, l.expiryDate]);
    }
  }

  // PO lines still to be received — the picker for a new receipt
  r.get('/open-po-lines', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const poId = str(req.query.purchaseOrderId);
    const args: unknown[] = [RECEIVABLE];
    let where = 'o.status = any($1::text[])';
    if (poId) { args.push(poId); where += ` and o.id = $${args.length}`; }
    const scope = legalEntityScope(req, P('create'));
    if (scope) { args.push(scope); where += ` and o.legal_entity_id = any($${args.length}::uuid[])`; }
    const tolerance = Number(await getSetting(db, 'purchase.grn.overReceiptPct', 2));
    const rows = await db.query(
      `select pl.id as "poLineId", o.id as "purchaseOrderId", o.doc_no as "poNo", o.status as "poStatus", p.legal_name as "vendorName", w.code as "warehouseCode",
              pl.line_no as "lineNo", pl.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.lot_controlled as "lotControlled", i.shelf_life_days as "shelfLifeDays",
              pl.uom, pl.qty as "orderedQty", pl.received_qty as "receivedQty", greatest(pl.qty - pl.received_qty, 0) as "pendingQty", coalesce(pl.delivery_date, o.delivery_date) as "dueDate"
         from purchase.purchase_order_lines pl join purchase.purchase_orders o on o.id = pl.purchase_order_id join mdm.parties p on p.id = o.party_id
         join org.warehouses w on w.id = o.warehouse_id join mdm.items i on i.id = pl.item_id
        where ${where} and pl.received_qty < pl.qty * (1 + ${tolerance} / 100.0) order by o.doc_no, pl.line_no`, args);
    res.json({ data: rows.rows, tolerancePct: tolerance });
  }));

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const scope = legalEntityScope(req, P('view'));
    if (scope) { args.push(scope); where.push(`o.legal_entity_id = any($${args.length}::uuid[])`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(g.doc_no ilike $${args.length} or o.doc_no ilike $${args.length} or p.legal_name ilike $${args.length} or g.challan_no ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`g.status = $${args.length}`); }
    const poId = str(req.query.purchaseOrderId);
    if (poId) { args.push(poId); where.push(`g.purchase_order_id = $${args.length}`); }
    const rows = await db.query(`${grnSelect.replace('select g.id,', 'select count(*) over() as total, g.id,')} where ${where.join(' and ')} order by g.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const g = await load(db, req, req.params.id!);
    const lines = (await db.query(
      `select gl.line_no as "lineNo", gl.po_line_id as "poLineId", gl.item_id as "itemId", i.code as "itemCode", i.name as "itemName", gl.uom, gl.challan_qty as "challanQty",
              gl.received_qty as "receivedQty", pl.qty as "orderedQty", gl.vendor_lot_no as "vendorLotNo", gl.mfg_date as "mfgDate", gl.expiry_date as "expiryDate",
              gl.lot_id as "lotId", lt.lot_no as "lotNo", lt.qc_status as "qcStatus", qi.id as "inspectionId", qi.doc_no as "inspectionNo", qi.status as "inspectionStatus"
         from purchase.goods_receipt_lines gl join mdm.items i on i.id = gl.item_id join purchase.purchase_order_lines pl on pl.id = gl.po_line_id
         left join inv.lots lt on lt.id = gl.lot_id left join qc.inspections qi on qi.lot_id = gl.lot_id
        where gl.goods_receipt_id = $1 order by gl.line_no`, [g.id])).rows;
    const actions: string[] = [];
    if (g.status === 'Draft' && can(req, P('create'))) actions.push('edit');
    if (g.status === 'Draft' && can(req, P('post'))) actions.push('post');
    if (g.status === 'Draft' && can(req, P('cancel'))) actions.push('cancel');
    res.json({ ...g, lines, allowedActions: actions });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(goodsReceiptSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const date = d.receiptDate ?? todayIST();
      const v = await validate(tx, req, d, date, null);
      const docNo = await nextDocNo(tx, 'GRN');
      const g = (await tx.query(
        `insert into purchase.goods_receipts (doc_no, purchase_order_id, party_id, warehouse_id, receipt_date, challan_no, challan_date, vendor_invoice_no, vehicle_no, remarks, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
        [docNo, v.po.id, v.po.party_id, v.po.warehouse_id, date, d.challanNo, d.challanDate ?? null, d.vendorInvoiceNo, d.vehicleNo, d.remarks, req.auth!.user.id])).rows[0];
      await writeLines(tx, g.id, v.lines);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: g.id, after: { docNo, po: v.po.doc_no, lines: d.lines } });
      return { id: g.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(goodsReceiptSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const g = await load(tx, req, req.params.id!, true);
      if (g.status !== 'Draft') throw Errors.state('Only a Draft receipt can be edited.');
      if (g.version !== d.version) throw Errors.concurrent();
      if (d.purchaseOrderId !== g.purchaseOrderId) throw Errors.rule('PO_LOCKED', 'The PO of a receipt cannot be changed.');
      const date = d.receiptDate ?? g.receiptDate;
      const v = await validate(tx, req, d, date, g.id);
      await tx.query(`update purchase.goods_receipts set receipt_date=$2, challan_no=$3, challan_date=$4, vendor_invoice_no=$5, vehicle_no=$6, remarks=$7, updated_by=$8 where id = $1`,
        [g.id, date, d.challanNo, d.challanDate ?? null, d.vendorInvoiceNo, d.vehicleNo, d.remarks, req.auth!.user.id]);
      await writeLines(tx, g.id, v.lines);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: g.id, after: d });
    });
    res.json({ ok: true });
  }));

  /**
   * Posting: every line becomes a lot in QUARANTINE (valued at the PO net rate) with a QC inspection waiting for sampling;
   * the PO's received quantities and status move on. Nothing can be used until QC releases the lot.
   */
  r.post('/:id/post', requirePermission(P('post')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const g = await load(tx, req, req.params.id!, true);
      if (g.status !== 'Draft') throw Errors.state('Only a Draft receipt can be posted.');
      await tx.query(`select id from purchase.purchase_orders where id = $1 for update`, [g.purchaseOrderId]);
      const lines = (await tx.query(`select * from purchase.goods_receipt_lines where goods_receipt_id = $1 order by line_no`, [g.id])).rows;
      const d: GrnInput = { purchaseOrderId: g.purchaseOrderId, challanNo: g.challanNo, lines: lines.map((l) => ({ poLineId: l.po_line_id, challanQty: Number(l.challan_qty),
        receivedQty: Number(l.received_qty), vendorLotNo: l.vendor_lot_no, mfgDate: l.mfg_date, expiryDate: l.expiry_date })), vendorInvoiceNo: null, vehicleNo: null, remarks: null };
      const v = await validate(tx, req, d, g.receiptDate, g.id);
      const lots = [];
      for (const l of v.lines) {
        const row = lines.find((x) => x.po_line_id === l.poLineId)!;
        const lotNo = await nextDocNo(tx, 'LOT');
        const lot = (await tx.query(
          `insert into inv.lots (lot_no, item_id, party_id, vendor_lot_no, mfg_date, expiry_date, source_type, source_id, created_by) values ($1,$2,$3,$4,$5,$6,'GRN',$7,$8) returning id`,
          [lotNo, l.itemId, g.partyId, l.vendorLotNo, l.mfgDate ?? null, l.expiryDate, g.id, req.auth!.user.id])).rows[0];
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,'QUARANTINE',$4,$5,'GRN',$6,$7,$8)`, [l.itemId, lot.id, g.warehouseId, l.receivedQty, l.netRate, SUBJECT, g.id, req.auth!.user.id]);
        await tx.query(`update purchase.goods_receipt_lines set lot_id = $2 where id = $1`, [row.id, lot.id]);
        await tx.query(`update purchase.purchase_order_lines set received_qty = received_qty + $2 where id = $1`, [l.poLineId, l.receivedQty]);
        const insNo = await nextDocNo(tx, 'QC_INSPECTION');
        await tx.query(`insert into qc.inspections (doc_no, lot_id, item_id, source_type, source_id) values ($1,$2,$3,'GRN',$4)`, [insNo, lot.id, l.itemId, g.id]);
        lots.push({ lotNo, item: l.code, qty: l.receivedQty });
      }
      // PO status: fully received (within tolerance) or partly received
      const pending = Number((await tx.query(`select count(*) from purchase.purchase_order_lines where purchase_order_id = $1 and received_qty < qty`, [g.purchaseOrderId])).rows[0].count);
      const poStatus = pending ? 'PartiallyReceived' : 'Received';
      await allowTransition(tx);
      await tx.query(`update purchase.purchase_orders set status = $2 where id = $1`, [g.purchaseOrderId, poStatus]);
      await audit(tx, actorOf(req), { action: 'purchase.order.status', entityType: 'purchase.order', entityId: g.purchaseOrderId, after: { status: poStatus, grn: g.docNo } });
      await setStatus(tx, actorOf(req), g.id, 'Posted');
      await audit(tx, actorOf(req), { action: `${SUBJECT}.posted`, entityType: SUBJECT, entityId: g.id, after: { lots } });
      await notifyRoles(tx, ['QC_ANALYST', 'QC_MANAGER'], `Lots to sample — ${g.docNo}`, `${lots.map((x) => `${x.lotNo} (${x.item})`).join(', ')} received from ${g.vendorName} and held in quarantine.`,
        '/qc/inspections', `grn-qc:${g.id}`);
      return { lots, poStatus };
    });
    res.json(out);
  }));

  // A posted receipt is corrected by a supplier return (part 4); only a draft can be cancelled.
  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const g = await load(tx, req, req.params.id!, true);
      if (g.status !== 'Draft') throw Errors.state('Only a Draft receipt can be cancelled. Return posted goods to the vendor instead.');
      await setStatus(tx, actorOf(req), g.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
