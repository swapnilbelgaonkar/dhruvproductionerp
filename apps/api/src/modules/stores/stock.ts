import { Router } from 'express';
import type { Db } from '../../db/pool';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { can } from '../../middleware/context';

const P = 'inv.stock:view';

/** Stock views over the append-only ledger (INV-001…): balances by bucket, lots with their history and origin. */
export function stockRoutes(db: Db) {
  const r = Router();

  /**
   * Scan lookup for the mobile scanner (D09): a box serial, the QR link printed on a box label, or a lot number.
   * Open to stores, dispatch and packing roles; returns what the code is, where it stands and what can be done with it.
   */
  r.get('/scan/:code', asyncHandler(async (req, res) => {
    if (!['inv.stock:view', 'logistics.shipment:view', 'mfg.packing:view'].some((p) => can(req, p))) throw Errors.forbidden(P);
    const raw = decodeURIComponent(req.params.code!).trim();
    const code = (/\/verify\/([^/?#\s]+)/.exec(raw)?.[1] ?? raw).trim();
    if (!code || code.length > 120) throw Errors.validation({ code: 'Scan a box or lot code' });
    const stock = async (lotId: string) => (await db.query(`select w.code as warehouse, sl.bucket, sum(sl.qty) as qty from inv.stock_ledger sl join org.warehouses w on w.id = sl.warehouse_id
        where sl.lot_id = $1 group by w.code, sl.bucket having sum(sl.qty) <> 0 order by w.code, sl.bucket`, [lotId])).rows;
    const box = (await db.query(`select b.id, b.serial, b.units, b.status, b.created_at as "packedAt", ip.pack_size as "packSize", ip.pack_uom as "packUom", ip.container,
        lt.id as "lotId", lt.lot_no as "lotNo", lt.qc_status as "qcStatus", lt.mfg_date as "mfgDate", lt.expiry_date as "expiryDate", i.code as "itemCode", i.name as "itemName",
        pr.doc_no as "packingRun", s.id as "shipmentId", s.doc_no as "shipmentNo", s.status as "shipmentStatus"
        from inv.boxes b join mdm.item_packs ip on ip.id = b.item_pack_id join inv.lots lt on lt.id = b.lot_id join mdm.items i on i.id = lt.item_id
        join mfg.packing_runs pr on pr.id = b.packing_run_id left join logistics.shipments s on s.id = b.shipment_id where upper(b.serial) = upper($1)`, [code])).rows[0];
    if (box) {
      const dispatchable = box.status === 'Packed' && !box.shipmentId && box.qcStatus === 'Released';
      return res.json({ kind: 'box', code, box, stock: await stock(box.lotId),
        verdict: dispatchable ? 'Ready to dispatch' : box.status === 'Dispatched' ? `Dispatched on ${box.shipmentNo}` : box.shipmentId ? `On shipment ${box.shipmentNo}`
          : box.qcStatus !== 'Released' ? `Lot ${box.qcStatus === 'Quarantine' ? 'not released by QA' : String(box.qcStatus).toLowerCase()} — do not dispatch` : box.status });
    }
    const lot = (await db.query(`select lt.id as "lotId", lt.lot_no as "lotNo", lt.qc_status as "qcStatus", lt.qa_disposition as "qaDisposition", lt.mfg_date as "mfgDate", lt.expiry_date as "expiryDate",
        lt.vendor_lot_no as "vendorLotNo", i.code as "itemCode", i.name as "itemName", i.base_uom as uom,
        (select count(*)::int from inv.boxes b where b.lot_id = lt.id and b.status = 'Packed' and b.shipment_id is null) as "boxesReady"
        from inv.lots lt join mdm.items i on i.id = lt.item_id where upper(lt.lot_no) = upper($1)`, [code])).rows[0];
    if (lot) return res.json({ kind: 'lot', code, lot, stock: await stock(lot.lotId),
      verdict: lot.qcStatus === 'Released' ? 'Released for use' : lot.qcStatus === 'Quarantine' ? 'In quarantine — awaiting QC/QA' : lot.qcStatus });
    throw Errors.notFound(`Box or lot ${code}`);
  }));

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

  /**
   * Traceability (MFG-012, QA recall UAT-15): backward to every lot that went into this one, with its supplier and receipt;
   * forward to every batch that used it and the lots those batches made. Dispatches join the forward side with logistics.
   */
  r.get('/lots/:id/trace', requirePermission(P), asyncHandler(async (req, res) => {
    interface Node { lotId: string; lotNo: string; itemCode: string; itemName: string; uom: string; qcStatus: string; sourceType: string; qty?: number;
      origin?: string; batchId?: string; batchNo?: string; orderNo?: string; children: Node[] }
    const lotInfo = async (id: string) => (await db.query(
      `select l.id as "lotId", l.lot_no as "lotNo", i.code as "itemCode", i.name as "itemName", i.base_uom as uom, l.qc_status as "qcStatus", l.source_type as "sourceType",
              case l.source_type when 'GRN' then concat(p.legal_name, ' · ', g.doc_no, ' · ', o.doc_no, coalesce(' · vendor lot ' || l.vendor_lot_no, ''))
                                 when 'OPENING' then 'Opening stock' else null end as origin,
              b.id as "batchId", b.batch_no as "batchNo", po.doc_no as "orderNo"
         from inv.lots l join mdm.items i on i.id = l.item_id left join mdm.parties p on p.id = l.party_id
         left join purchase.goods_receipts g on g.id = l.source_id and l.source_type = 'GRN' left join purchase.purchase_orders o on o.id = g.purchase_order_id
         left join mfg.batches b on b.id = l.source_id and l.source_type = 'PRODUCTION' left join mfg.production_orders po on po.id = b.production_order_id
        where l.id = $1`, [id])).rows[0] as Omit<Node, 'children'> | undefined;
    const seen = new Set<string>();
    const back = async (id: string, depth: number, qty?: number): Promise<Node | null> => {
      const n = await lotInfo(id);
      if (!n) return null;
      const node: Node = { ...n, qty, children: [] };
      if (depth >= 5 || seen.has(`b${id}`) || !n.batchId) return node;
      seen.add(`b${id}`);
      const ins = (await db.query(`select lot_id, sum(qty) as qty from mfg.batch_consumptions where batch_id = $1 group by lot_id order by min(dosed_at)`, [n.batchId])).rows;
      for (const x of ins) { const c = await back(x.lot_id, depth + 1, Number(x.qty)); if (c) node.children.push(c); }
      return node;
    };
    const fwd = async (id: string, depth: number): Promise<Node | null> => {
      const n = await lotInfo(id);
      if (!n) return null;
      const node: Node = { ...n, children: [] };
      if (depth >= 5 || seen.has(`f${id}`)) return node;
      seen.add(`f${id}`);
      const used = (await db.query(
        `select b.id, b.batch_no, po.doc_no as order_no, b.status, b.fg_lot_id, sum(c.qty) as qty from mfg.batch_consumptions c join mfg.batches b on b.id = c.batch_id
           join mfg.production_orders po on po.id = b.production_order_id where c.lot_id = $1 group by b.id, po.doc_no order by b.started_at`, [id])).rows;
      for (const u of used) {
        const child = u.fg_lot_id ? await fwd(u.fg_lot_id, depth + 1) : null;
        node.children.push(child ? { ...child, qty: Number(u.qty), batchNo: u.batch_no, orderNo: u.order_no }
          : { lotId: '', lotNo: `${u.batch_no} (${u.status === 'Scrapped' ? 'scrapped' : 'in progress'})`, itemCode: '', itemName: '', uom: n.uom, qcStatus: u.status, sourceType: 'BATCH', qty: Number(u.qty), batchId: u.id, batchNo: u.batch_no, orderNo: u.order_no, children: [] });
      }
      return node;
    };
    const backward = await back(req.params.id!, 0);
    if (!backward) throw Errors.notFound('Lot');
    res.json({ backward, forward: await fwd(req.params.id!, 0) });
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
