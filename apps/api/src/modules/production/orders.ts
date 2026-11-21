import { Router, type Request } from 'express';
import { z } from 'zod';
import { materialIssueSchema, materialReturnSchema, productionOrderSchema, quarantineOverrideSchema, reasonSchema, releaseOrderSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, inLegalEntityScope, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval, withdrawOpenRequests } from '../workflow/engine';
import { effectiveBomVersion } from './boms';

/**
 * Production orders (BRD p.18 sub-module 3; MP §12.3; MFG-005, MFG-013) with reservation and issue of material (MP §11.6, §12.5; MFG-007, INV-007, INV-009)
 * and the quarantine-lock override (BRD p.15; D33 provisional: dual approval, automatic deviation, QA head notified, release blocked until the lot passes QC).
 *
 * Draft → Submitted → Approved (plant head) → Released (formulation fixed, lots reserved FEFO) → In progress (batch started, part 3) → Completed → Closed.
 * On hold and Cancelled are side states. Stock leaves the raw-material store only by an issue against a reservation.
 */
const SUBJECT = 'mfg.production_order';
const OVERRIDE = 'mfg.quarantine_override';
const P = (a: string) => `mfg.order:${a}`;
const EDITABLE = ['Draft', 'Rejected'];
const RUNNING = ['Released', 'InProgress'];
const BUCKET_OF: Record<string, string> = { Released: 'UNRESTRICTED', Quarantine: 'QUARANTINE', Rejected: 'REJECTED', Hold: 'BLOCKED' };
type OrderInput = z.infer<typeof productionOrderSchema>;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from mfg.production_orders where id = $1`, [id])).rows[0];
  await tx.query(`update mfg.production_orders set status = $2, status_reason = $3, updated_by = $4,
                    approved_at = case when $2 = 'Approved' then now() else approved_at end where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, before, after: { status }, reason });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/** Raises a deviation (QA-005); QA is told through the outbox relay. */
export async function raiseDeviation(tx: Tx, actor: Actor, d: { category: string; title: string; description: string; orderId?: string | null; lotId?: string | null; sourceType: string; sourceId: string }) {
  const docNo = await nextDocNo(tx, 'DEVIATION');
  const row = (await tx.query(
    `insert into qa.deviations (doc_no, category, title, description, production_order_id, lot_id, source_type, source_id, raised_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
    [docNo, d.category, d.title, d.description, d.orderId ?? null, d.lotId ?? null, d.sourceType, d.sourceId, actor.userId])).rows[0];
  await audit(tx, actor, { action: 'qa.deviation.raised', entityType: 'qa.deviation', entityId: row.id, after: { docNo, ...d } });
  await emit(tx, 'qa.deviation', row.id, 'qa.deviation.raised');
  return { id: row.id as string, docNo };
}

/** Stock of a lot in a warehouse bucket, less what is reserved and not yet issued. */
async function lotAvailability(tx: Tx, lotId: string, warehouseId: string, bucket: string) {
  const r = (await tx.query(
    `select coalesce((select sum(qty) from inv.stock_ledger where lot_id = $1 and warehouse_id = $2 and bucket = $3), 0) as on_hand,
            coalesce((select sum(qty - issued_qty) from inv.reservations where lot_id = $1 and warehouse_id = $2 and bucket = $3 and status = 'Active'), 0) as reserved`,
    [lotId, warehouseId, bucket])).rows[0];
  return { onHand: Number(r.on_hand), reserved: Number(r.reserved), available: r4(Number(r.on_hand) - Number(r.reserved)) };
}

/** Quantity already covered for a requirement, in the requirement's unit (substitutes divided by their factor). */
async function coveredQty(tx: Tx, orderMaterialId: string) {
  return Number((await tx.query(`select coalesce(sum(qty / factor), 0) as q from inv.reservations where source_line_id = $1 and status <> 'Cancelled'`, [orderMaterialId])).rows[0].q);
}

/**
 * Reserves released lots for every open requirement of the order: FEFO (earliest expiry first, then oldest lot) from the issue warehouse,
 * the formulation item first and then its approved substitutes. Candidate lots are locked first so concurrent reservations queue.
 * Returns the remaining shortages.
 */
async function reserve(tx: Tx, actor: Actor, order: { id: string; issueWarehouseId: string }) {
  const mats = (await tx.query(
    `select m.id, m.item_id, m.required_qty, m.uom, i.code as item_code, m.bom_line_id,
            coalesce((select json_agg(json_build_object('itemId', a.item_id, 'factor', a.factor) order by ai.code) from mfg.bom_alternates a join mdm.items ai on ai.id = a.item_id where a.bom_line_id = m.bom_line_id), '[]'::json) as alts
       from mfg.order_materials m join mdm.items i on i.id = m.item_id where m.production_order_id = $1 order by m.line_no`, [order.id])).rows;
  const shortages: { itemCode: string; required: number; covered: number; short: number; uom: string }[] = [];
  for (const m of mats) {
    let open = r4(Number(m.required_qty) - await coveredQty(tx, m.id));
    for (const src of [{ itemId: m.item_id as string, factor: 1 }, ...(m.alts as { itemId: string; factor: number }[])]) {
      if (open <= 0) break;
      const lots = (await tx.query(
        `select id from inv.lots where item_id = $1 and qc_status = 'Released' and (expiry_date is null or expiry_date >= $2)
          order by expiry_date nulls last, created_at, id for update`, [src.itemId, todayIST()])).rows;
      for (const l of lots) {
        if (open <= 0) break;
        const av = await lotAvailability(tx, l.id, order.issueWarehouseId, 'UNRESTRICTED');
        if (av.available <= 0) continue;
        const take = r4(Math.min(av.available, open * src.factor));
        await tx.query(`insert into inv.reservations (lot_id, item_id, warehouse_id, bucket, qty, factor, source_type, source_id, source_line_id, created_by, updated_by)
                        values ($1,$2,$3,'UNRESTRICTED',$4,$5,$6,$7,$8,$9,$9)`, [l.id, src.itemId, order.issueWarehouseId, take, src.factor, SUBJECT, order.id, m.id, actor.userId]);
        open = r4(open - take / src.factor);
      }
    }
    if (open > 0) shortages.push({ itemCode: m.item_code, required: Number(m.required_qty), covered: r4(Number(m.required_qty) - open), short: open, uom: m.uom });
  }
  await audit(tx, actor, { action: `${SUBJECT}.reserved`, entityType: SUBJECT, entityId: order.id, after: { shortages } });
  return shortages;
}

async function setOverrideStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update mfg.quarantine_overrides set status = $2, status_reason = $3, decided_at = now(), updated_by = $4 where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${OVERRIDE}.status`, entityType: OVERRIDE, entityId: id, after: { status }, reason });
}

/** D33 on approval: re-check the quarantined stock, reserve it, and raise the deviation that blocks the batch release until the lot passes QC. */
async function approveOverride(tx: Tx, actor: Actor, id: string) {
  const o = (await tx.query(
    `select o.*, po.issue_warehouse_id, po.doc_no as order_no, po.status as order_status, l.lot_no, l.qc_status, l.item_id, i.code as item_code
       from mfg.quarantine_overrides o join mfg.production_orders po on po.id = o.production_order_id join inv.lots l on l.id = o.lot_id join mdm.items i on i.id = l.item_id
      where o.id = $1 for update of o`, [id])).rows[0];
  if (!RUNNING.includes(o.order_status)) throw Errors.state(`Production order ${o.order_no} is ${o.order_status}; the override can no longer be used.`);
  await tx.query(`select id from inv.lots where id = $1 for update`, [o.lot_id]);
  const bucket = o.qc_status === 'Released' ? 'UNRESTRICTED' : 'QUARANTINE';
  if (!['Quarantine', 'Released'].includes(o.qc_status)) throw Errors.rule('LOT_NOT_USABLE', `Lot ${o.lot_no} is now ${o.qc_status}; it cannot be used.`);
  const av = await lotAvailability(tx, o.lot_id, o.issue_warehouse_id, bucket);
  if (av.available < Number(o.qty)) throw Errors.rule('INSUFFICIENT_STOCK', `Only ${av.available} of lot ${o.lot_no} is still free.`);
  const dev = bucket === 'QUARANTINE' ? await raiseDeviation(tx, actor, {
    category: 'QUARANTINE_OVERRIDE', title: `Quarantined lot ${o.lot_no} used before QC release`, orderId: o.production_order_id, lotId: o.lot_id, sourceType: OVERRIDE, sourceId: o.id,
    description: `${o.doc_no}: ${Number(o.qty)} of ${o.item_code} lot ${o.lot_no} approved for ${o.order_no} before QC release. Reason: ${o.reason}. The batch cannot be released until this lot passes QC.`,
  }) : null;
  await tx.query(`insert into inv.reservations (lot_id, item_id, warehouse_id, bucket, qty, factor, source_type, source_id, source_line_id, override_id, created_by, updated_by)
                  values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$10)`, [o.lot_id, o.item_id, o.issue_warehouse_id, bucket, o.qty, SUBJECT, o.production_order_id, o.order_material_id, o.id, actor.userId]);
  await tx.query(`update mfg.quarantine_overrides set deviation_id = $2 where id = $1`, [o.id, dev?.id ?? null]);
  await setOverrideStatus(tx, actor, id, 'Approved', dev ? `Deviation ${dev.docNo} raised` : 'The lot was released by QC meanwhile; reserved as released stock');
}

const orderSelect = `select o.id, o.doc_no as "docNo", o.legal_entity_id as "legalEntityId", o.plant_id as "plantId", pl.code as "plantCode", pl.name as "plantName",
    o.line_id as "lineId", ln.code as "lineCode", ln.name as "lineName", o.item_id as "itemId", i.code as "itemCode", i.name as "itemName", o.bom_id as "bomId", b.code as "bomCode",
    o.bom_version_id as "bomVersionId", bv.version_no as "bomVersionNo", o.planned_qty as "plannedQty", o.uom, o.batch_count as "batchCount", o.order_type as "orderType",
    o.sales_order_id as "salesOrderId", so.doc_no as "salesOrderNo", o.priority, o.planned_start as "plannedStart", o.due_date as "dueDate", o.shift_id as "shiftId", sh.code as "shiftCode",
    o.issue_warehouse_id as "issueWarehouseId", iw.code as "issueWarehouseCode", iw.name as "issueWarehouseName", o.fg_warehouse_id as "fgWarehouseId", fw.code as "fgWarehouseCode",
    fw.name as "fgWarehouseName", o.remarks, o.status, o.status_reason as "statusReason", o.shortage_accepted as "shortageAccepted", o.approved_at as "approvedAt",
    o.released_at as "releasedAt", ru.full_name as "releasedBy", o.created_at as "createdAt", o.created_by as "createdById", cu.full_name as "createdBy", o.version
  from mfg.production_orders o join org.plants pl on pl.id = o.plant_id join mfg.lines ln on ln.id = o.line_id join mdm.items i on i.id = o.item_id join mfg.boms b on b.id = o.bom_id
  left join mfg.bom_versions bv on bv.id = o.bom_version_id left join sales.sales_orders so on so.id = o.sales_order_id left join mfg.shifts sh on sh.id = o.shift_id
  join org.warehouses iw on iw.id = o.issue_warehouse_id join org.warehouses fw on fw.id = o.fg_warehouse_id left join iam.users ru on ru.id = o.released_by
  join iam.users cu on cu.id = o.created_by`;

function scoped(req: Request, args: unknown[]) {
  const scope = legalEntityScope(req, P('view'));
  if (!scope) return 'true';
  args.push(scope);
  return `o.legal_entity_id = any($${args.length}::uuid[])`;
}

export function productionOrderRoutes(db: Db) {
  registerSubjectHandler(SUBJECT, {
    onApproved: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Approved'),
    onRejected: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setStatus(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  registerSubjectHandler(OVERRIDE, {
    onApproved: (tx, r, a) => approveOverride(tx, a, r.subject_id),
    onRejected: (tx, r, a) => setOverrideStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setOverrideStatus(tx, a, r.subject_id, 'Rejected', 'Returned — raise a new request if still needed'),
    onCancelled: (tx, r, a) => setOverrideStatus(tx, a, r.subject_id, 'Cancelled', 'Request withdrawn'),
  });
  const r = Router();

  async function load(dbx: Db | Tx, req: Request, id: string, lock = false) {
    const args: unknown[] = [id];
    const row = (await dbx.query(`${orderSelect} where o.id = $1 and ${scoped(req, args)} ${lock ? 'for update of o' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Production order');
    return row;
  }

  async function validate(tx: Tx, req: Request, d: OrderInput, isNew: boolean) {
    const plant = (await tx.query(`select status, legal_entity_id from org.plants where id = $1`, [d.plantId])).rows[0];
    if (plant?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active plant.');
    if (!inLegalEntityScope(req, P('create'), plant.legal_entity_id)) throw Errors.forbidden(`${P('create')} for this plant`);
    const line = (await tx.query(`select status, plant_id from mfg.lines where id = $1`, [d.lineId])).rows[0];
    if (line?.status !== 'Active' || line.plant_id !== d.plantId) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active production line of this plant.');
    if (d.shiftId) {
      const sh = (await tx.query(`select status, plant_id from mfg.shifts where id = $1`, [d.shiftId])).rows[0];
      if (sh?.status !== 'Active' || sh.plant_id !== d.plantId) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active shift of this plant.');
    }
    const item = (await tx.query(`select status, item_type, base_uom from mdm.items where id = $1`, [d.itemId])).rows[0];
    if (item?.status !== 'Active' || !['FG', 'SEMI'].includes(item.item_type)) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an approved finished or semi-finished product.');
    const bom = (await tx.query(`select id from mfg.boms where item_id = $1 and status = 'Active'`, [d.itemId])).rows[0];
    if (!bom) throw Errors.rule('NO_FORMULATION', 'This product has no formulation. Create and approve one first.');
    const ver = await effectiveBomVersion(tx, d.itemId, d.plannedStart);
    if (!ver) throw Errors.rule('NO_EFFECTIVE_FORMULATION', `No approved formulation version is in force on ${d.plannedStart} for this product.`);
    for (const [wid, label, types] of [[d.issueWarehouseId, 'raw-material store', ['RM', 'GENERAL', 'PM']], [d.fgWarehouseId, 'finished-goods warehouse', ['FG', 'GENERAL']]] as const) {
      const w = (await tx.query(`select status, legal_entity_id, type from org.warehouses where id = $1`, [wid])).rows[0];
      if (w?.status !== 'Active' || w.legal_entity_id !== plant.legal_entity_id) throw Errors.rule('REFERENCE_NOT_ACTIVE', `Choose an active ${label} of the plant's legal entity.`);
      if (!(types as readonly string[]).includes(w.type)) throw Errors.rule('WRONG_WAREHOUSE_TYPE', `The ${label} must be of type ${types.join(' or ')} (this one is ${w.type}).`);
    }
    if (d.orderType === 'MTO') {
      const so = (await tx.query(
        `select s.status, exists (select 1 from sales.sales_order_lines sl join mdm.item_packs ip on ip.id = sl.item_pack_id where sl.sales_order_id = s.id and ip.item_id = $2) as has_item
           from sales.sales_orders s where s.id = $1`, [d.salesOrderId, d.itemId])).rows[0];
      if (so?.status !== 'Approved') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Make-to-order production needs an approved sales order.');
      if (!so.has_item) throw Errors.rule('ITEM_NOT_ON_ORDER', 'The sales order does not include this product.');
    }
    if (isNew && d.plannedStart < todayIST()) throw Errors.rule('INVALID_DATE', 'The planned start cannot be in the past.');
    return { legalEntityId: plant.legal_entity_id as string, bomId: bom.id as string, uom: item.base_uom as string, batchCount: Math.ceil(r4(d.plannedQty / Number(ver.batchSize))) };
  }

  function actions(req: Request, o: { status: string; createdById: string }, netIssued: number) {
    const out: string[] = [];
    if (EDITABLE.includes(o.status) && can(req, P('edit'))) out.push('edit');
    if (EDITABLE.includes(o.status) && can(req, P('submit'))) out.push('submit');
    if (o.status === 'Approved' && can(req, P('release'))) out.push('release');
    if (RUNNING.includes(o.status) && can(req, P('release'))) out.push('reserve', 'hold');
    if (o.status === 'OnHold' && can(req, P('release'))) out.push('resume');
    if (RUNNING.includes(o.status) && can(req, 'mfg.issue:post')) out.push('issue');
    if ([...RUNNING, 'OnHold', 'Completed'].includes(o.status) && can(req, 'mfg.issue:post') && netIssued > 0) out.push('return');
    if (RUNNING.includes(o.status) && can(req, 'mfg.override:request')) out.push('override');
    if (['Draft', 'Rejected', 'Approved', 'Released', 'OnHold'].includes(o.status) && can(req, P('cancel')) && netIssued === 0) out.push('cancel');
    if (o.status === 'Completed' && can(req, P('release'))) out.push('close');
    return out;
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = [scoped(req, args)];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(o.doc_no ilike $${args.length} or i.code ilike $${args.length} or i.name ilike $${args.length} or so.doc_no ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`o.status = $${args.length}`); }
    const plant = str(req.query.plantId);
    if (plant) { args.push(plant); where.push(`o.plant_id = $${args.length}`); }
    const rows = (await db.query(`${orderSelect.replace('select o.id,', 'select count(*) over() as total, o.id,')} where ${where.join(' and ')}
      order by case o.status when 'InProgress' then 0 when 'Released' then 1 when 'Approved' then 2 when 'Submitted' then 3 when 'Draft' then 4 else 5 end,
               case o.priority when 'URGENT' then 0 else 1 end, o.planned_start, o.created_at desc limit ${limit} offset ${offset}`, args)).rows;
    res.json({ data: rows.map(({ total: _t, ...x }) => x), total: Number(rows[0]?.total ?? 0) });
  }));

  /** Material check before release: the version in force on the planned start, scaled to the quantity, against free released stock in the store. */
  r.get('/material-check', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const itemId = str(req.query.itemId); const wh = str(req.query.issueWarehouseId); const qty = Number(req.query.plannedQty); const on = str(req.query.onDate) ?? todayIST();
    if (!itemId || !wh || !(qty > 0)) throw Errors.validation({ query: 'itemId, issueWarehouseId and plannedQty are required' });
    const ver = await effectiveBomVersion(db, itemId, on);
    if (!ver) { res.json({ version: null, lines: [] }); return; }
    const lines = (await db.query(
      `select l.line_no as "lineNo", l.step_no as "stepNo", i.code as "itemCode", i.name as "itemName", l.uom, round(l.qty * $2 / $3, 4) as required,
              coalesce((select sum(b.qty) from inv.stock_balances b join inv.lots lt on lt.id = b.lot_id where b.item_id = l.item_id and b.warehouse_id = $4 and b.bucket = 'UNRESTRICTED'
                         and (lt.expiry_date is null or lt.expiry_date >= $5)), 0)
                - coalesce((select sum(r.qty - r.issued_qty) from inv.reservations r where r.item_id = l.item_id and r.warehouse_id = $4 and r.bucket = 'UNRESTRICTED' and r.status = 'Active'), 0) as available,
              coalesce((select sum(b.qty) from inv.stock_balances b where b.item_id = l.item_id and b.warehouse_id = $4 and b.bucket = 'QUARANTINE'), 0) as quarantine,
              (select count(*)::int from mfg.bom_alternates a where a.bom_line_id = l.id) as substitutes
         from mfg.bom_lines l join mdm.items i on i.id = l.item_id where l.bom_version_id = $1 order by l.step_no, l.line_no`,
      [ver.id, qty, ver.batchSize, wh, todayIST()])).rows;
    res.json({ version: { ...ver, batches: Math.ceil(r4(qty / Number(ver.batchSize))) }, lines });
  }));

  /** Approval links carry only the override id; this finds its production order. */
  r.get('/overrides/:oid', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const o = (await db.query(`select production_order_id as "productionOrderId" from mfg.quarantine_overrides where id = $1`, [req.params.oid])).rows[0];
    if (!o) throw Errors.notFound('Override request');
    res.json(o);
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const o = await load(db, req, req.params.id!);
    const materials = (await db.query(
      `select m.id, m.line_no as "lineNo", m.step_no as "stepNo", m.item_id as "itemId", i.code as "itemCode", i.name as "itemName", m.required_qty as "requiredQty", m.uom, m.tolerance_pct as "tolerancePct",
              coalesce((select sum(r.qty / r.factor) from inv.reservations r where r.source_line_id = m.id and r.status <> 'Cancelled'), 0) as "coveredQty",
              coalesce((select sum(ml.qty / coalesce(rv.factor, 1)) filter (where mm.direction = 'ISSUE') - coalesce(sum(ml.qty / coalesce(rv.factor, 1)) filter (where mm.direction = 'RETURN'), 0)
                         from mfg.material_movement_lines ml join mfg.material_movements mm on mm.id = ml.movement_id left join inv.reservations rv on rv.id = ml.reservation_id
                        where ml.order_material_id = m.id), 0) as "netIssuedQty"
         from mfg.order_materials m join mdm.items i on i.id = m.item_id where m.production_order_id = $1 order by m.step_no, m.line_no`, [o.id])).rows;
    const reservations = (await db.query(
      `select r.id, r.source_line_id as "orderMaterialId", r.lot_id as "lotId", l.lot_no as "lotNo", l.vendor_lot_no as "vendorLotNo", l.expiry_date as "expiryDate", l.qc_status as "lotStatus",
              r.item_id as "itemId", i.code as "itemCode", i.base_uom as uom, r.bucket, r.qty, r.issued_qty as "issuedQty", r.factor, r.status, r.override_id as "overrideId",
              coalesce((select sum(s.qty) from inv.stock_ledger s where s.lot_id = r.lot_id and s.warehouse_id = r.warehouse_id and s.bucket = r.bucket), 0) as "lotOnHand"
         from inv.reservations r join inv.lots l on l.id = r.lot_id join mdm.items i on i.id = r.item_id
        where r.source_type = $1 and r.source_id = $2 and r.status <> 'Cancelled' order by r.created_at`, [SUBJECT, o.id])).rows;
    const movements = (await db.query(
      `select mm.id, mm.doc_no as "docNo", mm.direction, mm.posted_at as "postedAt", u.full_name as "postedBy", mm.remarks,
              json_agg(json_build_object('lotNo', l.lot_no, 'itemCode', i.code, 'qty', ml.qty, 'uom', i.base_uom, 'bucket', ml.bucket) order by i.code) as lines
         from mfg.material_movements mm join iam.users u on u.id = mm.posted_by join mfg.material_movement_lines ml on ml.movement_id = mm.id
         join inv.lots l on l.id = ml.lot_id join mdm.items i on i.id = ml.item_id
        where mm.production_order_id = $1 group by mm.id, u.full_name order by mm.posted_at`, [o.id])).rows;
    const overrides = (await db.query(
      `select ov.id, ov.doc_no as "docNo", ov.order_material_id as "orderMaterialId", l.lot_no as "lotNo", ov.qty, ov.reason, ov.status, ov.status_reason as "statusReason",
              u.full_name as "requestedBy", ov.created_at as "createdAt", d.doc_no as "deviationNo",
              (select a.id from wf.approval_requests a where a.subject_type = $2 and a.subject_id = ov.id order by a.submitted_at desc limit 1) as "approvalId"
         from mfg.quarantine_overrides ov join inv.lots l on l.id = ov.lot_id join iam.users u on u.id = ov.requested_by left join qa.deviations d on d.id = ov.deviation_id
        where ov.production_order_id = $1 order by ov.created_at`, [o.id, OVERRIDE])).rows;
    const deviations = (await db.query(
      `select d.id, d.doc_no as "docNo", d.category, d.title, d.status, d.created_at as "createdAt", l.lot_no as "lotNo", l.qc_status as "lotStatus"
         from qa.deviations d left join inv.lots l on l.id = d.lot_id where d.production_order_id = $1 order by d.created_at`, [o.id])).rows;
    const approval = (await db.query(
      `select a.id, a.doc_no as "docNo", a.status, a.rule_name as "ruleName",
              (select json_agg(json_build_object('seq', s.seq, 'label', s.label, 'kind', s.step_kind, 'status', s.status) order by s.seq) from wf.approval_steps s where s.request_id = a.id) as steps
         from wf.approval_requests a where a.subject_type = $1 and a.subject_id = $2 order by a.submitted_at desc limit 1`, [SUBJECT, o.id])).rows[0] ?? null;
    const batches = (await db.query(
      `select b.id, b.batch_no as "batchNo", b.seq, b.planned_qty as "plannedQty", b.status, b.started_at as "startedAt", b.completed_at as "completedAt", b.output_qty as "outputQty",
              b.yield_pct as "yieldPct", fl.lot_no as "fgLotNo", fl.qc_status as "fgLotStatus"
         from mfg.batches b left join inv.lots fl on fl.id = b.fg_lot_id where b.production_order_id = $1 order by b.seq`, [o.id])).rows;
    const netIssued = materials.reduce((a, m) => a + Number(m.netIssuedQty), 0);
    const acts = actions(req, o, r4(netIssued));
    const openBatch = batches.some((b) => ['InProgress', 'OnHold'].includes(b.status));
    if (RUNNING.includes(o.status) && can(req, 'mfg.batch:execute') && !openBatch && batches.filter((b) => b.status === 'Completed').length < o.batchCount && netIssued > 0) acts.push('start_batch');
    res.json({ ...o, materials, reservations, movements, overrides, deviations, approval, batches, allowedActions: acts });
  }));

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(productionOrderSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const v = await validate(tx, req, d, true);
      const docNo = await nextDocNo(tx, 'PRODUCTION_ORDER');
      const row = (await tx.query(
        `insert into mfg.production_orders (doc_no, legal_entity_id, plant_id, line_id, item_id, bom_id, planned_qty, uom, batch_count, order_type, sales_order_id, priority, planned_start, due_date,
                                            shift_id, issue_warehouse_id, fg_warehouse_id, remarks, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) returning id`,
        [docNo, v.legalEntityId, d.plantId, d.lineId, d.itemId, v.bomId, d.plannedQty, v.uom, v.batchCount, d.orderType, d.salesOrderId ?? null, d.priority, d.plannedStart, d.dueDate,
          d.shiftId ?? null, d.issueWarehouseId, d.fgWarehouseId, d.remarks, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: `${SUBJECT}.created`, entityType: SUBJECT, entityId: row.id, after: { docNo, ...d } });
      return { id: row.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('edit')), asyncHandler(async (req, res) => {
    const d = parse(productionOrderSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!EDITABLE.includes(o.status)) throw Errors.state(`A ${o.status} production order cannot be edited.`);
      if (o.version !== d.version) throw Errors.concurrent();
      const v = await validate(tx, req, d, String(d.plannedStart) !== String(o.plannedStart));
      await tx.query(`update mfg.production_orders set legal_entity_id=$2, plant_id=$3, line_id=$4, item_id=$5, bom_id=$6, planned_qty=$7, uom=$8, batch_count=$9, order_type=$10, sales_order_id=$11,
                        priority=$12, planned_start=$13, due_date=$14, shift_id=$15, issue_warehouse_id=$16, fg_warehouse_id=$17, remarks=$18, updated_by=$19 where id = $1`,
      [o.id, v.legalEntityId, d.plantId, d.lineId, d.itemId, v.bomId, d.plannedQty, v.uom, v.batchCount, d.orderType, d.salesOrderId ?? null, d.priority, d.plannedStart, d.dueDate,
        d.shiftId ?? null, d.issueWarehouseId, d.fgWarehouseId, d.remarks, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.edited`, entityType: SUBJECT, entityId: o.id, after: d });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!EDITABLE.includes(o.status)) throw Errors.state(`Only a Draft or Rejected production order can be submitted (this one is ${o.status}).`);
      if (String(o.plannedStart) < todayIST()) throw Errors.rule('INVALID_DATE', 'The planned start has passed. Edit the order first.');
      if (!(await effectiveBomVersion(tx, o.itemId, String(o.plannedStart)))) throw Errors.rule('NO_EFFECTIVE_FORMULATION', 'No approved formulation version is in force on the planned start.');
      await setStatus(tx, actorOf(req), o.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), {
        subjectType: SUBJECT, subjectId: o.id, subjectLabel: `${o.docNo} — ${Number(o.plannedQty)} ${o.uom} ${o.itemCode}`,
        facts: { orderType: o.orderType, priority: o.priority, plannedQty: Number(o.plannedQty), batchCount: o.batchCount }, legalEntityId: o.legalEntityId,
      });
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  // MFG-006/007: release fixes the formulation version in force today, scales its lines and reserves released lots FEFO.
  r.post('/:id/release', requirePermission(P('release')), asyncHandler(async (req, res) => {
    const d = parse(releaseOrderSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (o.status !== 'Approved') throw Errors.state(`Only an approved production order can be released (this one is ${o.status}).`);
      const today = todayIST();
      const ver = await effectiveBomVersion(tx, o.itemId, today);
      if (!ver) throw Errors.rule('NO_EFFECTIVE_FORMULATION', `No approved formulation version of ${o.itemCode} is in force today.`);
      const factor = Number(o.plannedQty) / Number(ver.batchSize);
      const lines = (await tx.query(`select id, line_no, step_no, item_id, qty, uom, tolerance_pct from mfg.bom_lines where bom_version_id = $1 order by line_no`, [ver.id])).rows;
      for (const l of lines) {
        await tx.query(`insert into mfg.order_materials (production_order_id, bom_line_id, line_no, step_no, item_id, required_qty, uom, tolerance_pct) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [o.id, l.id, l.line_no, l.step_no, l.item_id, r4(Number(l.qty) * factor), l.uom, l.tolerance_pct]);
      }
      const shortages = await reserve(tx, actorOf(req), o);
      if (shortages.length && !d.acceptShortage) {
        throw Errors.rule('MATERIAL_SHORTAGE', `Not enough released stock in ${o.issueWarehouseCode} for ${shortages.map((s) => s.itemCode).join(', ')}.`, { shortages });
      }
      await allowTransition(tx);
      await tx.query(`update mfg.production_orders set bom_version_id = $2, batch_count = $3, status = 'Released', status_reason = $4, shortage_accepted = $5,
                        released_at = now(), released_by = $6, updated_by = $6 where id = $1`,
        [o.id, ver.id, Math.ceil(r4(factor)), shortages.length ? d.reason : null, shortages.length > 0, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `${SUBJECT}.released`, entityType: SUBJECT, entityId: o.id, after: { bomVersion: ver.versionNo, shortages }, reason: d.reason });
      await emit(tx, SUBJECT, o.id, `${SUBJECT}.released`);
      return { status: 'Released', bomVersionNo: ver.versionNo, shortages };
    });
    res.json(out);
  }));

  // after more lots are released by QC, reserve what is still open
  r.post('/:id/reserve', requirePermission(P('release')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!RUNNING.includes(o.status)) throw Errors.state(`Material can be reserved only for a released order (this one is ${o.status}).`);
      return { shortages: await reserve(tx, actorOf(req), o) };
    });
    res.json(out);
  }));

  for (const [path, from, to] of [['hold', RUNNING, 'OnHold'], ['resume', ['OnHold'], null]] as const) {
    r.post(`/:id/${path}`, requirePermission(P('release')), asyncHandler(async (req, res) => {
      const { reason } = parse(reasonSchema, req.body);
      await withTx(db, async (tx) => {
        const o = await load(tx, req, req.params.id!, true);
        if (!(from as readonly string[]).includes(o.status)) throw Errors.state(`A ${o.status} order cannot be ${path === 'hold' ? 'put on hold' : 'resumed'}.`);
        // resume returns to In progress if a batch has started (part 3), otherwise to Released
        const started = (await tx.query(`select to_regclass('mfg.batches') is not null as t`)).rows[0].t
          && (await tx.query(`select 1 from mfg.batches where production_order_id = $1 limit 1`, [o.id])).rowCount;
        await setStatus(tx, actorOf(req), o.id, to ?? (started ? 'InProgress' : 'Released'), reason);
      });
      res.json({ ok: true });
    }));
  }

  // a completed order is closed once nothing issued to it is left unused with production
  r.post('/:id/close', requirePermission(P('release')), asyncHandler(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? String(req.body.reason).trim().slice(0, 500) : null;
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (o.status !== 'Completed') throw Errors.state(`Only a completed order can be closed (this one is ${o.status}).`);
      const left = (await tx.query(
        `select i.code, l.lot_no, sum(case mm.direction when 'ISSUE' then ml.qty else -ml.qty end)
                 - coalesce((select sum(c.qty) from mfg.batch_consumptions c join mfg.batches b on b.id = c.batch_id where b.production_order_id = $1 and c.lot_id = ml.lot_id), 0) as q
           from mfg.material_movement_lines ml join mfg.material_movements mm on mm.id = ml.movement_id join inv.lots l on l.id = ml.lot_id join mdm.items i on i.id = ml.item_id
          where mm.production_order_id = $1 group by i.code, l.lot_no, ml.lot_id`, [o.id])).rows.filter((x) => Number(x.q) > 0.00005);
      if (left.length) throw Errors.rule('MATERIAL_WITH_PRODUCTION', `Return the unused material to stores first: ${left.map((x) => `${x.code} ${x.lot_no} ${r4(Number(x.q))}`).join(', ')}.`);
      await tx.query(`update inv.reservations set status = 'Cancelled', updated_by = $2 where source_type = $3 and source_id = $1 and status = 'Active'`, [o.id, req.auth!.user.id, SUBJECT]);
      await setStatus(tx, actorOf(req), o.id, 'Closed', reason);
    });
    res.json({ ok: true });
  }));

  r.post('/:id/cancel', requirePermission(P('cancel')), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!['Draft', 'Rejected', 'Approved', 'Released', 'OnHold'].includes(o.status)) throw Errors.state(`A ${o.status} production order cannot be cancelled.`);
      const net = Number((await tx.query(
        `select coalesce(sum(case mm.direction when 'ISSUE' then ml.qty else -ml.qty end), 0) as q from mfg.material_movement_lines ml join mfg.material_movements mm on mm.id = ml.movement_id
          where mm.production_order_id = $1`, [o.id])).rows[0].q);
      if (net > 0) throw Errors.rule('MATERIAL_ISSUED', 'Material has been issued to this order. Return it to stores before cancelling (MFG-013).');
      await tx.query(`update inv.reservations set status = 'Cancelled', updated_by = $2 where source_type = $3 and source_id = $1 and status = 'Active'`, [o.id, req.auth!.user.id, SUBJECT]);
      await allowTransition(tx);
      const open = (await tx.query(`update mfg.quarantine_overrides set status = 'Cancelled', status_reason = 'Production order cancelled', updated_by = $2
                                     where production_order_id = $1 and status = 'Submitted' returning id`, [o.id, req.auth!.user.id])).rows.map((x) => x.id as string);
      await withdrawOpenRequests(tx, OVERRIDE, open);
      await setStatus(tx, actorOf(req), o.id, 'Cancelled', reason);
    });
    res.json({ ok: true });
  }));

  // MFG-007: stores issues reserved lots; stock leaves the store bucket. A lot must still be usable at the moment of issue.
  r.post('/:id/issue', requirePermission('mfg.issue:post'), asyncHandler(async (req, res) => {
    const d = parse(materialIssueSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!RUNNING.includes(o.status)) throw Errors.state(`Material can be issued only to a released order (this one is ${o.status}).`);
      const docNo = await nextDocNo(tx, 'MATERIAL_ISSUE');
      const mv = (await tx.query(`insert into mfg.material_movements (doc_no, production_order_id, direction, warehouse_id, remarks, posted_by) values ($1,$2,'ISSUE',$3,$4,$5) returning id`,
        [docNo, o.id, o.issueWarehouseId, d.remarks, req.auth!.user.id])).rows[0];
      for (const l of d.lines) {
        const rv = (await tx.query(`select r.*, l.lot_no, l.qc_status from inv.reservations r join inv.lots l on l.id = r.lot_id
                                     where r.id = $1 and r.source_type = $2 and r.source_id = $3 for update of r`, [l.reservationId, SUBJECT, o.id])).rows[0];
        if (!rv || rv.status !== 'Active') throw Errors.rule('RESERVATION_NOT_ACTIVE', 'A reservation is no longer open. Reload the order.');
        await tx.query(`select id from inv.lots where id = $1 for update`, [rv.lot_id]);
        const open = r4(Number(rv.qty) - Number(rv.issued_qty));
        if (l.qty > open) throw Errors.rule('OVER_ISSUE', `Lot ${rv.lot_no}: only ${open} is reserved and not yet issued.`);
        // the lot's QC status decides the bucket; quarantined stock only through an approved override (D33)
        let bucket: string;
        if (rv.qc_status === 'Released') bucket = 'UNRESTRICTED';
        else if (rv.qc_status === 'Quarantine' && rv.override_id) bucket = 'QUARANTINE';
        else throw Errors.rule('LOT_NOT_USABLE', `Lot ${rv.lot_no} is ${rv.qc_status === 'Quarantine' ? 'in quarantine' : rv.qc_status.toLowerCase()} and cannot be issued.`);
        const stock = (await tx.query(`select coalesce(sum(qty), 0) as q, coalesce(sum(qty * unit_cost) / nullif(sum(qty), 0), 0) as cost from inv.stock_ledger
                                        where lot_id = $1 and warehouse_id = $2 and bucket = $3`, [rv.lot_id, rv.warehouse_id, bucket])).rows[0];
        if (Number(stock.q) < l.qty) throw Errors.rule('INSUFFICIENT_STOCK', `Lot ${rv.lot_no}: only ${Number(stock.q)} is in the store.`);
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,$4,$5,$6,'ISSUE_TO_PROD','mfg.material_movement',$7,$8)`, [rv.item_id, rv.lot_id, rv.warehouse_id, bucket, -l.qty, Number(stock.cost), mv.id, req.auth!.user.id]);
        await tx.query(`insert into mfg.material_movement_lines (movement_id, order_material_id, reservation_id, lot_id, item_id, bucket, qty, unit_cost) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [mv.id, rv.source_line_id, rv.id, rv.lot_id, rv.item_id, bucket, l.qty, Number(stock.cost)]);
        await tx.query(`update inv.reservations set issued_qty = issued_qty + $2, status = case when issued_qty + $2 >= qty then 'Consumed' else status end, updated_by = $3 where id = $1`,
          [rv.id, l.qty, req.auth!.user.id]);
      }
      await audit(tx, actorOf(req), { action: 'mfg.material.issued', entityType: SUBJECT, entityId: o.id, after: { docNo, lines: d.lines } });
      return { id: mv.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  // unused material back to the store, into the bucket matching the lot's current QC status
  r.post('/:id/return', requirePermission('mfg.issue:post'), asyncHandler(async (req, res) => {
    const d = parse(materialReturnSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (![...RUNNING, 'OnHold', 'Completed'].includes(o.status)) throw Errors.state(`Material cannot be returned from a ${o.status} order.`);
      const docNo = await nextDocNo(tx, 'MATERIAL_RETURN');
      const mv = (await tx.query(`insert into mfg.material_movements (doc_no, production_order_id, direction, warehouse_id, remarks, posted_by) values ($1,$2,'RETURN',$3,$4,$5) returning id`,
        [docNo, o.id, o.issueWarehouseId, d.remarks, req.auth!.user.id])).rows[0];
      for (const l of d.lines) {
        const held = (await tx.query(
          `select l.lot_no, l.qc_status, l.item_id, max(ml.reservation_id::text) filter (where mm.direction = 'ISSUE') as reservation_id,
                  coalesce(sum(ml.qty) filter (where mm.direction = 'ISSUE'), 0) - coalesce(sum(ml.qty) filter (where mm.direction = 'RETURN'), 0) as net,
                  coalesce(sum(ml.qty * ml.unit_cost) filter (where mm.direction = 'ISSUE') / nullif(sum(ml.qty) filter (where mm.direction = 'ISSUE'), 0), 0) as cost
             from mfg.material_movement_lines ml join mfg.material_movements mm on mm.id = ml.movement_id join inv.lots l on l.id = ml.lot_id
            where mm.production_order_id = $1 and ml.order_material_id = $2 and ml.lot_id = $3 group by l.lot_no, l.qc_status, l.item_id`, [o.id, l.orderMaterialId, l.lotId])).rows[0];
        // part 3 subtracts what batches have consumed from the returnable quantity
        const consumed = (await tx.query(`select to_regclass('mfg.batch_consumptions') is not null as t`)).rows[0].t
          ? Number((await tx.query(`select coalesce(sum(c.qty), 0) as q from mfg.batch_consumptions c join mfg.batches b on b.id = c.batch_id
                                     where b.production_order_id = $1 and c.order_material_id = $2 and c.lot_id = $3`, [o.id, l.orderMaterialId, l.lotId])).rows[0].q) : 0;
        const returnable = held ? r4(Number(held.net) - consumed) : 0;
        if (!held || l.qty > returnable) throw Errors.rule('OVER_RETURN', `Only ${returnable} of ${held?.lot_no ?? 'this lot'} can be returned.`);
        const bucket = BUCKET_OF[held.qc_status]!;
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,$4,$5,$6,'RETURN_FROM_PROD','mfg.material_movement',$7,$8)`, [held.item_id, l.lotId, o.issueWarehouseId, bucket, l.qty, Number(held.cost), mv.id, req.auth!.user.id]);
        await tx.query(`insert into mfg.material_movement_lines (movement_id, order_material_id, reservation_id, lot_id, item_id, bucket, qty, unit_cost) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [mv.id, l.orderMaterialId, held.reservation_id, l.lotId, held.item_id, bucket, l.qty, Number(held.cost)]);
      }
      await audit(tx, actorOf(req), { action: 'mfg.material.returned', entityType: SUBJECT, entityId: o.id, after: { docNo, lines: d.lines } });
      return { id: mv.id as string, docNo };
    });
    res.status(201).json(out);
  }));

  /** Quarantined lots of a requirement's item in the store, with the quantity not yet reserved — the choices for an override request. */
  r.get('/:id/quarantined-lots', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const o = await load(db, req, req.params.id!);
    const m = str(req.query.orderMaterialId);
    const rows = (await db.query(
      `select l.id, l.lot_no as "lotNo", l.vendor_lot_no as "vendorLotNo", l.expiry_date as "expiryDate", p.legal_name as "vendorName", qi.status as "inspectionStatus",
              sum(s.qty) - coalesce((select sum(r.qty - r.issued_qty) from inv.reservations r where r.lot_id = l.id and r.bucket = 'QUARANTINE' and r.status = 'Active'), 0) as free
         from mfg.order_materials om join inv.lots l on l.item_id = om.item_id join inv.stock_ledger s on s.lot_id = l.id and s.warehouse_id = $2 and s.bucket = 'QUARANTINE'
         left join mdm.parties p on p.id = l.party_id left join qc.inspections qi on qi.lot_id = l.id
        where om.id = $1 and om.production_order_id = $3 and l.qc_status = 'Quarantine'
        group by l.id, p.legal_name, qi.status having sum(s.qty) > 0 order by l.created_at`, [m, o.issueWarehouseId, o.id])).rows;
    res.json({ data: rows.filter((x) => Number(x.free) > 0) });
  }));

  // D33 (provisional): QC head and plant head approve the use of a quarantined lot for a shortfall; see approveOverride for the safeguards.
  r.post('/:id/overrides', requirePermission('mfg.override:request'), asyncHandler(async (req, res) => {
    const d = parse(quarantineOverrideSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const o = await load(tx, req, req.params.id!, true);
      if (!RUNNING.includes(o.status)) throw Errors.state(`An override can be requested only for a released order (this one is ${o.status}).`);
      const m = (await tx.query(`select id, item_id, required_qty from mfg.order_materials where id = $1 and production_order_id = $2`, [d.orderMaterialId, o.id])).rows[0];
      if (!m) throw Errors.notFound('Material requirement');
      const lot = (await tx.query(`select id, lot_no, item_id, qc_status from inv.lots where id = $1 for update`, [d.lotId])).rows[0];
      if (!lot || lot.item_id !== m.item_id) throw Errors.rule('WRONG_LOT', 'Choose a lot of the required item.');
      if (lot.qc_status !== 'Quarantine') throw Errors.rule('NOT_QUARANTINED', `Lot ${lot.lot_no} is ${lot.qc_status}; an override is only for lots still in quarantine.`);
      const pending = Number((await tx.query(`select coalesce(sum(qty), 0) as q from mfg.quarantine_overrides where order_material_id = $1 and status = 'Submitted'`, [m.id])).rows[0].q);
      const shortfall = r4(Number(m.required_qty) - await coveredQty(tx, m.id) - pending);
      if (d.qty > shortfall) throw Errors.rule('OVERRIDE_TOO_LARGE', shortfall > 0 ? `Only ${shortfall} is still uncovered for this material.` : 'This material is already covered by reservations or pending requests.');
      const av = await lotAvailability(tx, lot.id, o.issueWarehouseId, 'QUARANTINE');
      if (d.qty > av.available) throw Errors.rule('INSUFFICIENT_STOCK', `Only ${av.available} of lot ${lot.lot_no} is in quarantine and free.`);
      const docNo = await nextDocNo(tx, 'QUARANTINE_OVERRIDE');
      const ov = (await tx.query(`insert into mfg.quarantine_overrides (doc_no, production_order_id, order_material_id, lot_id, qty, reason, requested_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id`,
        [docNo, o.id, m.id, lot.id, d.qty, d.reason, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: `${OVERRIDE}.requested`, entityType: OVERRIDE, entityId: ov.id, after: { docNo, order: o.docNo, lot: lot.lot_no, qty: d.qty }, reason: d.reason });
      const ar = await submitForApproval(tx, actorOf(req), {
        subjectType: OVERRIDE, subjectId: ov.id, subjectLabel: `${docNo} — use quarantined lot ${lot.lot_no} for ${o.docNo}`,
        facts: { qty: d.qty }, legalEntityId: o.legalEntityId,
      });
      return { id: ov.id as string, docNo, approvalRequestId: ar.id, approvalDocNo: ar.doc_no };
    });
    res.status(201).json(out);
  }));

  return r;
}
