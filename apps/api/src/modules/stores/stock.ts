import { Router } from 'express';
import type { Db } from '../../db/pool';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';

const P = 'inv.stock:view';

/** Stock views over the append-only ledger (INV-001…): balances by bucket, lots with their history and origin. */
export function stockRoutes(db: Db) {
  const r = Router();

  // per item and warehouse: quarantine / unrestricted / rejected / blocked quantities and value
  r.get('/balances', requirePermission(P), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = ['true'];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(i.code ilike $${args.length} or i.name ilike $${args.length})`); }
    const wh = str(req.query.warehouseId);
    if (wh) { args.push(wh); where.push(`b.warehouse_id = $${args.length}`); }
    const rows = await db.query(
      `select b.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType", i.base_uom as uom, b.warehouse_id as "warehouseId", w.code as "warehouseCode",
              sum(b.qty) filter (where b.bucket = 'QUARANTINE') as quarantine, sum(b.qty) filter (where b.bucket = 'UNRESTRICTED') as unrestricted,
              sum(b.qty) filter (where b.bucket = 'REJECTED') as rejected, sum(b.qty) filter (where b.bucket = 'BLOCKED') as blocked,
              sum(b.value) filter (where b.bucket = 'UNRESTRICTED') as "unrestrictedValue", count(distinct b.lot_id)::int as lots,
              min(l.expiry_date) filter (where b.bucket = 'UNRESTRICTED') as "nearestExpiry"
         from inv.stock_balances b join mdm.items i on i.id = b.item_id join org.warehouses w on w.id = b.warehouse_id join inv.lots l on l.id = b.lot_id
        where ${where.join(' and ')} group by b.item_id, i.code, i.name, i.item_type, i.base_uom, b.warehouse_id, w.code order by i.code, w.code`, args);
    res.json({ data: rows.rows });
  }));

  r.get('/lots', requirePermission(P), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(l.lot_no ilike $${args.length} or l.vendor_lot_no ilike $${args.length} or i.code ilike $${args.length} or i.name ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`l.qc_status = $${args.length}`); }
    const item = str(req.query.itemId);
    if (item) { args.push(item); where.push(`l.item_id = $${args.length}`); }
    const rows = await db.query(
      `select l.id, l.lot_no as "lotNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, l.vendor_lot_no as "vendorLotNo",
              p.legal_name as "vendorName", l.mfg_date as "mfgDate", l.expiry_date as "expiryDate", l.qc_status as status, l.created_at as "createdAt",
              (select coalesce(sum(qty), 0) from inv.stock_ledger s where s.lot_id = l.id) as "onHand", count(*) over() as total
         from inv.lots l join mdm.items i on i.id = l.item_id left join mdm.parties p on p.id = l.party_id
        where ${where.join(' and ')} order by l.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  // lot genealogy: where it came from, what QC decided, every stock movement
  r.get('/lots/:id', requirePermission(P), asyncHandler(async (req, res) => {
    const lot = (await db.query(
      `select l.id, l.lot_no as "lotNo", l.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, l.vendor_lot_no as "vendorLotNo",
              l.party_id as "partyId", p.legal_name as "vendorName", l.mfg_date as "mfgDate", l.expiry_date as "expiryDate", l.qc_status as status, l.qc_decided_at as "decidedAt",
              du.full_name as "decidedBy", l.source_type as "sourceType", g.id as "grnId", g.doc_no as "grnNo", g.receipt_date as "receiptDate", o.id as "poId", o.doc_no as "poNo",
              qi.id as "inspectionId", qi.doc_no as "inspectionNo", qi.status as "inspectionStatus", l.created_at as "createdAt"
         from inv.lots l join mdm.items i on i.id = l.item_id left join mdm.parties p on p.id = l.party_id left join iam.users du on du.id = l.qc_decided_by
         left join purchase.goods_receipts g on g.id = l.source_id and l.source_type = 'GRN' left join purchase.purchase_orders o on o.id = g.purchase_order_id
         left join qc.inspections qi on qi.lot_id = l.id where l.id = $1`, [req.params.id])).rows[0];
    if (!lot) throw Errors.notFound('Lot');
    const ledger = (await db.query(
      `select s.id, s.posted_at as "postedAt", w.code as "warehouseCode", s.bucket, s.qty, s.unit_cost as "unitCost", s.txn_type as "txnType", u.full_name as "by"
         from inv.stock_ledger s join org.warehouses w on w.id = s.warehouse_id left join iam.users u on u.id = s.created_by where s.lot_id = $1 order by s.id`, [lot.id])).rows;
    const balances = (await db.query(`select bucket, sum(qty) as qty from inv.stock_ledger where lot_id = $1 group by bucket having sum(qty) <> 0`, [lot.id])).rows;
    res.json({ ...lot, ledger, balances });
  }));

  return r;
}
