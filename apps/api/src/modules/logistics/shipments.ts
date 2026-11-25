import { getIntegration } from '../integrations/registry';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope } from '../../middleware/context';
import { getSetting } from '../../lib/settings';
import { raiseInvoice } from '../sales/invoices';
import { todayIST } from '../sales/quotations';

/**
 * Dispatch (BRD p.17; MP §15; LOG-001…LOG-011, FIN-015). A shipment is planned against an approved sales order; stores picks it by scanning
 * box serials — only boxes of QA-released lots (LOG-003); logistics loads it with transporter, vehicle, driver, LR and e-way bill, and only then
 * is the scanned quantity posted as dispatched (LOG-009). The POD records what arrived, with shortages and damage.
 */
const P = (a: string) => `logistics.shipment:${a}`;
const text = (n: number) => z.string().trim().min(1, 'Required').max(n);
const opt = (n: number) => z.string().trim().max(n).optional().nullable().transform((v) => v || null);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const r4 = (n: number) => Math.round(n * 10000) / 10000;

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update logistics.shipments set status = $2, status_reason = coalesce($3, status_reason), updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: 'logistics.shipment.status', entityType: 'logistics.shipment', entityId: id, after: { status }, reason });
  await emit(tx, 'logistics.shipment', id, `logistics.shipment.${status.toLowerCase()}`);
}

/** Packs of each sales order line still to be shipped: ordered − dispatched − planned on other open shipments. */
async function openPacks(dbx: Db | Tx, salesOrderId: string, exceptShipmentId: string | null = null) {
  return (await dbx.query(
    `select sl.id, sl.line_no as "lineNo", sl.item_pack_id as "itemPackId", sl.description, sl.pack_label as "packLabel", sl.qty, sl.dispatched_qty as "dispatchedQty",
            ip.item_id as "itemId", ip.units_per_box as "unitsPerBox", sl.line_total as "lineTotal",
            coalesce((select sum(l.planned_packs) from logistics.shipment_lines l join logistics.shipments s on s.id = l.shipment_id
                       where l.so_line_id = sl.id and s.status in ('Planned','Picked') and s.id is distinct from $2), 0) as "onOpenShipments"
       from sales.sales_order_lines sl join mdm.item_packs ip on ip.id = sl.item_pack_id where sl.sales_order_id = $1 order by sl.line_no`, [salesOrderId, exceptShipmentId])).rows
    .map((l) => ({ ...l, open: r4(Number(l.qty) - Number(l.dispatchedQty) - Number(l.onOpenShipments)) }));
}

const shipSel = `select s.id, s.doc_no as "docNo", s.sales_order_id as "salesOrderId", so.doc_no as "salesOrderNo", so.dealer_po_no as "dealerPoNo", s.legal_entity_id as "legalEntityId",
    le.name as "legalEntityName", s.party_id as "partyId", p.legal_name as "partyName", p.code as "partyCode", p.gstin as "partyGstin", s.ship_to_id as "shipToId",
    concat_ws(', ', a.line1, a.line2, a.city, a.district, a.pincode) as "shipToAddress", a.state_code as "shipToState", s.warehouse_id as "warehouseId", w.code as "warehouseCode", w.name as "warehouseName",
    s.planned_date as "plannedDate", s.status, s.status_reason as "statusReason", s.transporter_id as "transporterId", t.name as "transporterName", t.gstin as "transporterGstin",
    s.vehicle_no as "vehicleNo", s.driver_name as "driverName", s.driver_phone as "driverPhone", s.freight_terms as "freightTerms", s.freight_amount as "freightAmount",
    s.lr_no as "lrNo", s.lr_date as "lrDate", s.ewb_no as "ewbNo", s.ewb_valid_until as "ewbValidUntil", s.dispatched_at as "dispatchedAt", du.full_name as "dispatchedBy",
    s.pod_received_on as "podReceivedOn", s.pod_received_by as "podReceivedBy", s.pod_document_id as "podDocumentId", s.pod_remarks as "podRemarks", s.remarks, s.created_at as "createdAt", s.version,
    (select i.doc_no from sales.invoices i where i.shipment_id = s.id and i.status <> 'Cancelled') as "invoiceNo"
  from logistics.shipments s join sales.sales_orders so on so.id = s.sales_order_id join org.legal_entities le on le.id = s.legal_entity_id join mdm.parties p on p.id = s.party_id
  join mdm.party_addresses a on a.id = s.ship_to_id join org.warehouses w on w.id = s.warehouse_id left join logistics.transporters t on t.id = s.transporter_id
  left join iam.users du on du.id = s.dispatched_by`;

export function shipmentRoutes(db: Db) {
  const r = Router();
  const scoped = (req: Request, args: unknown[]) => {
    const scope = legalEntityScope(req, P('view'));
    if (!scope) return 'true';
    args.push(scope);
    return `s.legal_entity_id = any($${args.length}::uuid[])`;
  };

  // ================================================================ transporters (LOG-004)
  r.get('/transporters', requirePermission(P('view')), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select id, code, name, gstin, pan, contact, phone, status, version from logistics.transporters order by name`)).rows });
  }));
  r.post('/transporters', requirePermission('logistics.transporter:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/), name: text(150), gstin: opt(15), pan: opt(10), contact: opt(120), phone: opt(15) }), req.body);
    const out = await withTx(db, async (tx) => {
      if ((await tx.query(`select 1 from logistics.transporters where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `${d.code} exists.`);
      const row = (await tx.query(`insert into logistics.transporters (code, name, gstin, pan, contact, phone, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id`,
        [d.code, d.name, d.gstin, d.pan, d.contact, d.phone, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'logistics.transporter.created', entityType: 'logistics.transporter', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));

  // ================================================================ dispatch planning queue (LOG-001)
  r.get('/queue', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const scope = legalEntityScope(req, P('view'));
    if (scope) args.push(scope);
    const orders = (await db.query(
      `select so.id, so.doc_no as "docNo", so.order_date as "orderDate", so.required_by as "requiredBy", so.legal_entity_id as "legalEntityId", p.legal_name as "partyName", p.code as "partyCode",
              a.city as "shipToCity", a.state_code as "shipToState", so.grand_total as "grandTotal"
         from sales.sales_orders so join mdm.parties p on p.id = so.party_id join mdm.party_addresses a on a.id = so.ship_to_id
        where so.status = 'Approved' ${scope ? 'and so.legal_entity_id = any($1::uuid[])' : ''}
          and exists (select 1 from sales.sales_order_lines sl where sl.sales_order_id = so.id and sl.dispatched_qty < sl.qty)
        order by coalesce(so.required_by, so.order_date), so.doc_no`, args)).rows;
    const out = [];
    for (const o of orders) {
      const lines = await openPacks(db, o.id);
      // released boxes of each pack in the entity's warehouses, not yet on a shipment
      for (const l of lines) {
        l.availablePacks = Number((await db.query(`select coalesce(sum(b.units), 0) as u from inv.boxes b join inv.lots lt on lt.id = b.lot_id
          where b.item_pack_id = $1 and b.status = 'Packed' and b.shipment_id is null and lt.qc_status = 'Released'`, [l.itemPackId])).rows[0].u);
      }
      if (lines.some((l) => l.open > 0)) out.push({ ...o, lines });
    }
    res.json({ data: out });
  }));

  // ================================================================ shipments
  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scoped(req, args)];
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`s.status = $${args.length}`); }
    const so = str(req.query.salesOrderId);
    if (so) { args.push(so); where.push(`s.sales_order_id = $${args.length}`); }
    const rows = (await db.query(`${shipSel} where ${where.join(' and ')} order by case s.status when 'Planned' then 0 when 'Picked' then 1 when 'Dispatched' then 2 else 3 end, s.planned_date desc, s.doc_no desc limit 300`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const s = (await dbx.query(`${shipSel} where s.id = $1 and ${scoped(req, args)} ${lock ? 'for update of s' : ''}`, args)).rows[0];
    if (!s) throw Errors.notFound('Shipment');
    return s;
  }
  async function lines(dbx: Db | Tx, shipmentId: string) {
    return (await dbx.query(
      `select l.id, l.so_line_id as "soLineId", sl.line_no as "lineNo", sl.description, sl.pack_label as "packLabel", sl.hsn_code as "hsnCode", l.item_pack_id as "itemPackId", ip.pack_size as "packSize",
              ip.pack_uom as "packUom", ip.units_per_box as "unitsPerBox", l.planned_packs as "plannedPacks", l.delivered_packs as "deliveredPacks", sl.qty as "orderedPacks", sl.line_total as "lineTotal",
              coalesce((select sum(pk.packs) from logistics.shipment_picks pk where pk.shipment_line_id = l.id), 0) as "pickedPacks",
              coalesce((select json_agg(json_build_object('id', pk.id, 'lotId', pk.lot_id, 'lotNo', lt.lot_no, 'expiryDate', lt.expiry_date, 'boxSerial', b.serial, 'packs', pk.packs, 'qty', pk.qty) order by b.serial)
                 from logistics.shipment_picks pk join inv.lots lt on lt.id = pk.lot_id left join inv.boxes b on b.id = pk.box_id where pk.shipment_line_id = l.id), '[]'::json) as picks
         from logistics.shipment_lines l join sales.sales_order_lines sl on sl.id = l.so_line_id join mdm.item_packs ip on ip.id = l.item_pack_id
        where l.shipment_id = $1 order by sl.line_no`, [shipmentId])).rows;
  }
  function actions(req: Request, s: { status: string }, picked: number) {
    const out: string[] = [];
    if (['Planned', 'Picked'].includes(s.status) && can(req, P('pick'))) out.push('pick');
    if (['Planned', 'Picked'].includes(s.status) && picked > 0 && can(req, P('dispatch'))) out.push('dispatch');
    if (['Planned', 'Picked'].includes(s.status) && can(req, P('create'))) out.push('cancel');
    if (s.status === 'Dispatched' && can(req, P('pod'))) out.push('pod');
    return out;
  }

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const s = await load(db, req, req.params.id!);
    const ls = await lines(db, s.id);
    const picked = ls.reduce((a, l) => a + Number(l.pickedPacks), 0);
    const value = Math.round(ls.reduce((a, l) => a + Number(l.pickedPacks) * Number(l.lineTotal) / Number(l.orderedPacks), 0) * 100) / 100;
    const ewbThreshold = Number((await db.query(`select value from sys.settings where key = 'logistics.ewb.thresholdValue'`)).rows[0]?.value ?? 50000);
    const seller = (await db.query(`select le.name, le.registered_address as address, le.pan, g.gstin from org.legal_entities le join sales.sales_orders so on so.id = $2
        left join org.gst_registrations g on g.legal_entity_id = le.id and g.state_code = so.seller_state and g.status = 'Active' where le.id = $1`, [s.legalEntityId, s.salesOrderId])).rows[0];
    const invoice = (await db.query(`select id, doc_no as "docNo", grand_total as "grandTotal", status from sales.invoices where shipment_id = $1 and status <> 'Cancelled'`, [s.id])).rows[0] ?? null;
    const credit = (await db.query(`select id, doc_no as "docNo", status from sales.credit_notes where shipment_id = $1 and status <> 'Cancelled' order by created_at desc limit 1`, [s.id])).rows[0] ?? null;
    res.json({ ...s, lines: ls, invoice, shortageCreditNote: credit, pickedValue: value, ewbRequired: value > ewbThreshold, ewbThreshold, seller, allowedActions: actions(req, s, picked) });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ salesOrderId: z.string().uuid(), warehouseId: z.string().uuid(), plannedDate: day, remarks: opt(500),
      lines: z.array(z.object({ soLineId: z.string().uuid(), packs: z.number().positive() })).min(1).max(100) }), req.body);
    const out = await withTx(db, async (tx) => {
      const so = (await tx.query(`select id, status, legal_entity_id, party_id, ship_to_id, doc_no from sales.sales_orders where id = $1 for update`, [d.salesOrderId])).rows[0];
      if (so?.status !== 'Approved') throw Errors.state('Only an approved sales order can be dispatched.');
      const wh = (await tx.query(`select status, legal_entity_id, type from org.warehouses where id = $1`, [d.warehouseId])).rows[0];
      if (wh?.status !== 'Active' || wh.legal_entity_id !== so.legal_entity_id || !['FG', 'GENERAL'].includes(wh.type)) throw Errors.rule('WRONG_WAREHOUSE', 'Dispatch from an active finished-goods warehouse of the order’s legal entity.');
      if (d.plannedDate < todayIST()) throw Errors.rule('INVALID_DATE', 'The planned date cannot be in the past.');
      const open = await openPacks(tx, so.id);
      const docNo = await nextDocNo(tx, 'SHIPMENT');
      const s = (await tx.query(`insert into logistics.shipments (doc_no, sales_order_id, legal_entity_id, party_id, ship_to_id, warehouse_id, planned_date, remarks, created_by, updated_by)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`, [docNo, so.id, so.legal_entity_id, so.party_id, so.ship_to_id, d.warehouseId, d.plannedDate, d.remarks, req.auth!.user.id])).rows[0];
      for (const l of d.lines) {
        const o = open.find((x) => x.id === l.soLineId);
        if (!o) throw Errors.rule('NOT_ON_ORDER', 'A line is not on this sales order.');
        if (l.packs > o.open) throw Errors.rule('OVER_PLANNED', `Line ${o.lineNo}: only ${Number(o.open)} pack(s) are still to be shipped.`);
        await tx.query(`insert into logistics.shipment_lines (shipment_id, so_line_id, item_pack_id, planned_packs) values ($1,$2,$3,$4)`, [s.id, o.id, o.itemPackId, l.packs]);
      }
      await audit(tx, actorOf(req), { action: 'logistics.shipment.planned', entityType: 'logistics.shipment', entityId: s.id, after: { docNo, order: so.doc_no, ...d } });
      return { id: s.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  /** Stock of a lot free in the warehouse: unrestricted, less what open shipments have picked. */
  async function freeQty(tx: Tx, lotId: string, warehouseId: string) {
    const q = (await tx.query(`select
        (select coalesce(sum(qty), 0) from inv.stock_ledger where lot_id = $1 and warehouse_id = $2 and bucket = 'UNRESTRICTED') as stock,
        (select coalesce(sum(pk.qty), 0) from logistics.shipment_picks pk join logistics.shipment_lines l on l.id = pk.shipment_line_id join logistics.shipments x on x.id = l.shipment_id
          where pk.lot_id = $1 and x.status in ('Planned','Picked') and x.warehouse_id = $2) as picked`, [lotId, warehouseId])).rows[0];
    return r4(Number(q.stock) - Number(q.picked));
  }
  /** Loose packs outside boxes: packs returned by customers and restocked by QA, less loose packs already picked from that store. Bulk stock not yet packed is not a pack. */
  async function loosePacks(dbx: Db | Tx, lotId: string, itemPackId: string, warehouseId: string) {
    const q = (await dbx.query(`select
        (select coalesce(sum(rl.packs), 0) from sales.customer_return_lines rl join sales.customer_returns r on r.id = rl.return_id join sales.invoice_lines il on il.id = rl.invoice_line_id
          where rl.lot_id = $1 and il.item_pack_id = $2 and r.warehouse_id = $3 and rl.disposition = 'Restock') as back,
        (select coalesce(sum(pk.packs), 0) from logistics.shipment_picks pk join logistics.shipment_lines l on l.id = pk.shipment_line_id join logistics.shipments x on x.id = l.shipment_id
          where pk.lot_id = $1 and pk.box_id is null and l.item_pack_id = $2 and x.warehouse_id = $3 and x.status <> 'Cancelled') as gone`, [lotId, itemPackId, warehouseId])).rows[0];
    return Number(q.back) - Number(q.gone);
  }
  async function pickLine(tx: Tx, req: Request, s: { id: string; status: string }, line: { id: string; lineNo: number }, lotId: string, boxId: string | null, packs: number, qty: number) {
    await tx.query(`insert into logistics.shipment_picks (shipment_line_id, lot_id, box_id, packs, qty, picked_by) values ($1,$2,$3,$4,$5,$6)`, [line.id, lotId, boxId, packs, qty, req.auth!.user.id]);
    if (boxId) await tx.query(`update inv.boxes set shipment_id = $2 where id = $1`, [boxId, s.id]);
    if (s.status === 'Planned') await setStatus(tx, actorOf(req), s.id, 'Picked');
  }

  // loose packs (returned by a customer and restocked by QA) that can be picked for each line
  r.get('/:id/loose-lots', requirePermission(P('pick')), asyncHandler(async (req, res) => {
    const s = await load(db, req, req.params.id!);
    const rows = [];
    for (const l of await lines(db, s.id)) {
      const lots = (await db.query(`select distinct lt.id, lt.lot_no as "lotNo", lt.expiry_date as "expiryDate" from sales.customer_return_lines rl join sales.customer_returns r on r.id = rl.return_id
          join sales.invoice_lines il on il.id = rl.invoice_line_id join inv.lots lt on lt.id = rl.lot_id
          where il.item_pack_id = $1 and r.warehouse_id = $2 and rl.disposition = 'Restock' and lt.qc_status = 'Released' order by lt.expiry_date nulls last, lt.lot_no`, [l.itemPackId, s.warehouseId])).rows;
      for (const lt of lots) {
        const packs = await loosePacks(db, lt.id, l.itemPackId, s.warehouseId);
        if (packs > 0) rows.push({ shipmentLineId: l.id, lineNo: l.lineNo, lotId: lt.id, lotNo: lt.lotNo, expiryDate: lt.expiryDate, packs });
      }
    }
    res.json({ data: rows });
  }));

  // LOG-002/003: scan a box (it must be packed, unshipped, of a QA-released lot, of a pack on the shipment, and in the dispatch warehouse) or pick loose packs of a released lot
  r.post('/:id/pick', requirePermission(P('pick')), asyncHandler(async (req, res) => {
    const d = parse(z.union([z.object({ boxSerial: text(40) }), z.object({ shipmentLineId: z.string().uuid(), lotId: z.string().uuid(), packs: z.number().int().positive() })]), req.body);
    const out = await withTx(db, async (tx) => {
      const s = await load(tx, req, req.params.id!, true);
      if (!['Planned', 'Picked'].includes(s.status)) throw Errors.state(`This shipment is ${s.status}.`);
      const ls = await lines(tx, s.id);
      if ('boxSerial' in d) {
        const b = (await tx.query(`select b.id, b.serial, b.units, b.status, b.shipment_id, b.item_pack_id, b.lot_id, lt.lot_no, lt.qc_status, ip.pack_size, ip.pack_uom, i.base_uom, lt.item_id
            from inv.boxes b join inv.lots lt on lt.id = b.lot_id join mdm.item_packs ip on ip.id = b.item_pack_id join mdm.items i on i.id = lt.item_id where b.serial = $1 for update of b`, [d.boxSerial.trim()])).rows[0];
        if (!b) throw Errors.rule('UNKNOWN_BOX', `No box ${d.boxSerial}.`);
        if (b.status !== 'Packed' || b.shipment_id) throw Errors.rule('BOX_NOT_AVAILABLE', `Box ${b.serial} is already ${b.shipment_id ? 'on a shipment' : b.status.toLowerCase()}.`);
        if (b.qc_status !== 'Released') throw Errors.rule('LOT_NOT_RELEASED', `Lot ${b.lot_no} is ${b.qc_status === 'Quarantine' ? 'not released by QA' : b.qc_status.toLowerCase()}; it cannot be dispatched (LOG-003).`);
        const line = ls.find((l) => l.itemPackId === b.item_pack_id);
        if (!line) throw Errors.rule('WRONG_PACK', `Box ${b.serial} holds a pack that is not on this shipment.`);
        if (Number(line.pickedPacks) + b.units > Number(line.plannedPacks)) throw Errors.rule('OVER_PICK', `Line ${line.lineNo}: ${Number(line.plannedPacks)} planned, ${Number(line.pickedPacks)} already scanned — this box of ${b.units} is too many.`);
        if (b.pack_uom !== b.base_uom) throw Errors.rule('NO_CONVERSION', 'The pack unit differs from the stock unit; set up the conversion first.');
        const qty = r4(Number(b.pack_size) * b.units);
        const free = await freeQty(tx, b.lot_id, s.warehouseId);
        if (qty > free + 1e-6) throw Errors.rule('NOT_IN_WAREHOUSE', `Lot ${b.lot_no}: only ${free} is free in ${s.warehouseCode}.`);
        await pickLine(tx, req, s, line, b.lot_id, b.id, b.units, qty);
        return { box: b.serial as string, lotNo: b.lot_no as string, packs: b.units as number, line: line.lineNo as number };
      }
      const line = ls.find((l) => l.id === d.shipmentLineId);
      if (!line) throw Errors.notFound('Shipment line');
      const lot = (await tx.query(`select lt.lot_no, lt.qc_status, lt.item_id, i.base_uom, ip.item_id as pack_item, ip.pack_uom from inv.lots lt join mdm.items i on i.id = lt.item_id
          join mdm.item_packs ip on ip.id = $2 where lt.id = $1 for update of lt`, [d.lotId, line.itemPackId])).rows[0];
      if (!lot || lot.item_id !== lot.pack_item) throw Errors.rule('WRONG_PACK', 'That lot is not of the product on this line.');
      if (lot.qc_status !== 'Released') throw Errors.rule('LOT_NOT_RELEASED', `Lot ${lot.lot_no} is not released; it cannot be dispatched (LOG-003).`);
      if (lot.pack_uom !== lot.base_uom) throw Errors.rule('NO_CONVERSION', 'The pack unit differs from the stock unit; set up the conversion first.');
      if (Number(line.pickedPacks) + d.packs > Number(line.plannedPacks)) throw Errors.rule('OVER_PICK', `Line ${line.lineNo}: ${Number(line.plannedPacks)} planned, ${Number(line.pickedPacks)} already picked.`);
      const qty = r4(Number(line.packSize) * d.packs);
      const loose = await loosePacks(tx, d.lotId, line.itemPackId, s.warehouseId);
      if (d.packs > loose) throw Errors.rule('NO_LOOSE_PACKS', `Lot ${lot.lot_no}: only ${Math.max(0, loose)} loose pack(s) outside boxes in ${s.warehouseCode}; scan boxes for the rest.`);
      if (qty > (await freeQty(tx, d.lotId, s.warehouseId)) + 1e-6) throw Errors.rule('NOT_IN_WAREHOUSE', `Lot ${lot.lot_no} has not enough free stock in ${s.warehouseCode}.`);
      await pickLine(tx, req, s, line, d.lotId, null, d.packs, qty);
      return { box: null, lotNo: lot.lot_no as string, packs: d.packs, line: line.lineNo as number };
    });
    res.status(201).json(out);
  }));

  r.delete('/:id/picks/:pickId', requirePermission(P('pick')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const s = await load(tx, req, req.params.id!, true);
      if (!['Planned', 'Picked'].includes(s.status)) throw Errors.state(`This shipment is ${s.status}.`);
      const pk = (await tx.query(`delete from logistics.shipment_picks pk using logistics.shipment_lines l where pk.id = $1 and l.id = pk.shipment_line_id and l.shipment_id = $2 returning pk.box_id`, [req.params.pickId, s.id])).rows[0];
      if (!pk) throw Errors.notFound('Pick');
      if (pk.box_id) await tx.query(`update inv.boxes set shipment_id = null where id = $1`, [pk.box_id]);
      await audit(tx, actorOf(req), { action: 'logistics.shipment.unpicked', entityType: 'logistics.shipment', entityId: s.id, after: { pick: req.params.pickId } });
    });
    res.json({ ok: true });
  }));

  // LOG-004/005/009/011, FIN-015: loading confirmation posts only what was scanned; the e-way bill is required above the threshold (D08 provisional)
  r.post('/:id/dispatch', requirePermission(P('dispatch')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ transporterId: z.string().uuid(), vehicleNo: z.string().trim().toUpperCase().regex(/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{1,4}$/, 'Vehicle number like MH12AB1234'),
      driverName: text(80), driverPhone: opt(15), freightTerms: z.enum(['PAID', 'TO_PAY', 'TBB']), freightAmount: z.number().min(0).optional().nullable(),
      lrNo: text(30), lrDate: day, ewbNo: z.string().regex(/^[0-9]{12}$/, 'The e-way bill number has 12 digits').optional().nullable(), ewbValidUntil: day.optional().nullable() })
      .refine((x) => !x.ewbNo || !!x.ewbValidUntil, { message: 'Give the e-way bill validity', path: ['ewbValidUntil'] }), req.body);
    const out = await withTx(db, async (tx) => {
      const s = await load(tx, req, req.params.id!, true);
      if (!['Planned', 'Picked'].includes(s.status)) throw Errors.state(`This shipment is ${s.status}.`);
      const tr = (await tx.query(`select status from logistics.transporters where id = $1`, [d.transporterId])).rows[0];
      if (tr?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active transporter.');
      const ls = await lines(tx, s.id);
      const picks = ls.flatMap((l) => (l.picks as { id: string; lotId: string; lotNo: string; packs: number; qty: number }[]).map((p) => ({ ...p, line: l })));
      if (!picks.length) throw Errors.rule('NOTHING_PICKED', 'Nothing has been scanned for this shipment.');
      const value = ls.reduce((a, l) => a + Number(l.pickedPacks) * Number(l.lineTotal) / Number(l.orderedPacks), 0);
      const threshold = Number((await tx.query(`select value from sys.settings where key = 'logistics.ewb.thresholdValue'`)).rows[0]?.value ?? 50000);
      // with the e-way bill integration on, it is generated from the invoice right after dispatch (before the vehicle leaves); otherwise it is typed here
      const ewbLater = (await getIntegration(tx, 'EWAYBILL')).mode !== 'OFF';
      if (value > threshold && !d.ewbNo && !ewbLater) throw Errors.rule('EWB_REQUIRED', `The consignment value ${Math.round(value)} is above ₹${threshold}: enter the e-way bill number.`);
      if (d.ewbValidUntil && d.ewbValidUntil < todayIST()) throw Errors.rule('EWB_EXPIRED', 'The e-way bill has expired.');
      for (const p of picks) {
        const lot = (await tx.query(`select lot_no, qc_status, item_id from inv.lots where id = $1 for update`, [p.lotId])).rows[0];
        if (lot.qc_status !== 'Released') throw Errors.rule('LOT_NOT_RELEASED', `Lot ${lot.lot_no} is no longer released; remove its boxes before dispatch.`);
        const st = (await tx.query(`select coalesce(sum(qty), 0) as q, coalesce(sum(qty * unit_cost) / nullif(sum(qty), 0), 0) as cost from inv.stock_ledger where lot_id = $1 and warehouse_id = $2 and bucket = 'UNRESTRICTED'`, [p.lotId, s.warehouseId])).rows[0];
        if (Number(st.q) + 1e-6 < Number(p.qty)) throw Errors.rule('INSUFFICIENT_STOCK', `Lot ${lot.lot_no}: only ${Number(st.q)} in stock.`);
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,'UNRESTRICTED',$4,$5,'DISPATCH','logistics.shipment',$6,$7)`, [lot.item_id, p.lotId, s.warehouseId, -Number(p.qty), Number(st.cost), s.id, req.auth!.user.id]);
      }
      await tx.query(`update inv.boxes set status = 'Dispatched' where shipment_id = $1`, [s.id]);
      for (const l of ls) if (Number(l.pickedPacks) > 0) await tx.query(`update sales.sales_order_lines set dispatched_qty = dispatched_qty + $2 where id = $1`, [l.soLineId, Number(l.pickedPacks)]);
      await tx.query(`update logistics.shipments set transporter_id=$2, vehicle_no=$3, driver_name=$4, driver_phone=$5, freight_terms=$6, freight_amount=$7, lr_no=$8, lr_date=$9, ewb_no=$10, ewb_valid_until=$11,
                        dispatched_at = now(), dispatched_by = $12, updated_by = $12 where id = $1`,
        [s.id, d.transporterId, d.vehicleNo, d.driverName, d.driverPhone, d.freightTerms, d.freightAmount ?? null, d.lrNo, d.lrDate, d.ewbNo ?? null, d.ewbValidUntil ?? null, req.auth!.user.id]);
      await setStatus(tx, actorOf(req), s.id, 'Dispatched');
      // the order closes when every line is fully dispatched
      const left = Number((await tx.query(`select count(*) from sales.sales_order_lines where sales_order_id = $1 and dispatched_qty < qty`, [s.salesOrderId])).rows[0].count);
      if (!left) {
        await allowTransition(tx);
        await tx.query(`update sales.sales_orders set status = 'Closed', status_reason = 'Fully dispatched', updated_by = $2 where id = $1`, [s.salesOrderId, req.auth!.user.id]);
      }
      // FIN-001: the tax invoice travels with the goods
      const invoice = (await getSetting(tx, 'sales.invoice.autoOnDispatch', true)) === true ? await raiseInvoice(tx, actorOf(req), s.id) : null;
      return { status: 'Dispatched', value: Math.round(value * 100) / 100, orderClosed: !left, invoice };
    });
    res.json(out);
  }));

  // LOG-006: POD — what arrived, who received it, the signed LR/challan, shortages and damage
  r.post('/:id/pod', requirePermission(P('pod')), asyncHandler(async (req, res) => {
    const d = parse(z.object({ receivedOn: day, receivedBy: text(120), documentId: z.string().uuid().optional().nullable(), remarks: opt(1000),
      lines: z.array(z.object({ shipmentLineId: z.string().uuid(), deliveredPacks: z.number().min(0) })).min(1) }), req.body);
    await withTx(db, async (tx) => {
      const s = await load(tx, req, req.params.id!, true);
      if (s.status !== 'Dispatched') throw Errors.state(`Only a dispatched shipment can be delivered (this one is ${s.status}).`);
      if (d.receivedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'The delivery date cannot be in the future.');
      if ((await getIntegration(tx, 'EWAYBILL')).mode !== 'OFF') {
        const inv = (await tx.query(`select grand_total from sales.invoices where shipment_id = $1 and status = 'Posted'`, [s.id])).rows[0];
        const threshold = Number(await getSetting(tx, 'logistics.ewb.thresholdValue', 50000));
        const ewb = (await tx.query(`select ewb_no from logistics.shipments where id = $1`, [s.id])).rows[0]?.ewb_no;
        if (inv && Number(inv.grand_total) > threshold && !ewb) throw Errors.rule('EWB_MISSING', `The consignment was above ₹${threshold} and has no e-way bill. Generate it (or record it) before closing the delivery.`);
      }
      const ls = await lines(tx, s.id);
      let short = false;
      for (const x of d.lines) {
        const l = ls.find((y) => y.id === x.shipmentLineId);
        if (!l) throw Errors.notFound('Shipment line');
        if (x.deliveredPacks > Number(l.pickedPacks)) throw Errors.rule('OVER_DELIVERED', `Line ${l.lineNo}: only ${Number(l.pickedPacks)} were dispatched.`);
        if (x.deliveredPacks < Number(l.pickedPacks)) short = true;
        await tx.query(`update logistics.shipment_lines set delivered_packs = $2 where id = $1`, [l.id, x.deliveredPacks]);
      }
      if (short && !d.remarks) throw Errors.rule('REMARKS_REQUIRED', 'Record the shortage or damage.');
      await tx.query(`update logistics.shipments set pod_received_on = $2, pod_received_by = $3, pod_document_id = $4, pod_remarks = $5, updated_by = $6 where id = $1`,
        [s.id, d.receivedOn, d.receivedBy, d.documentId ?? null, d.remarks, req.auth!.user.id]);
      await setStatus(tx, actorOf(req), s.id, 'Delivered', short ? 'Delivered short' : null);
    });
    res.json({ ok: true });
  }));

  r.post('/:id/cancel', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: text(500) }), req.body);
    await withTx(db, async (tx) => {
      const s = await load(tx, req, req.params.id!, true);
      if (!['Planned', 'Picked'].includes(s.status)) throw Errors.state(`A ${s.status} shipment cannot be cancelled.`);
      await tx.query(`update inv.boxes set shipment_id = null where shipment_id = $1 and status = 'Packed'`, [s.id]);
      await tx.query(`delete from logistics.shipment_picks pk using logistics.shipment_lines l where l.id = pk.shipment_line_id and l.shipment_id = $1`, [s.id]);
      await setStatus(tx, actorOf(req), s.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  return r;
}
