import { createHmac } from 'node:crypto';
import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Config } from '../../config';
import { withTx, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { convertQty } from './batches';
import { takeLineClearance } from '../quality/qasystem';

/**
 * Packing runs (BRD p.17–18 sub-module 10; MP §12.7; MFG-011): a finished-goods lot is filled into packs; packaging material is drawn
 * FEFO from the packaging store; rejected packs and spillage leave the lot as packing loss; boxes get serials and a signed QR (D24 box level,
 * QR-002: the server verifies the signature). Also: the batch cost sheet (D32), downtime (MFG-014) and the production dashboard (MFG-002, D23).
 */
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

const packingSchema = z.object({
  lotId: z.string().uuid(), itemPackId: z.string().uuid(), lineId: z.string().uuid().optional().nullable(),
  packsFilled: z.number().int().positive(), packsRejected: z.number().int().min(0).default(0), spillageQty: z.number().min(0).default(0),
  pmWarehouseId: z.string().uuid().optional().nullable(),
  materials: z.array(z.object({ itemId: z.string().uuid(), qty: z.number().positive() })).max(20).default([]),
  remarks: z.string().trim().max(500).optional().nullable(),
}).refine((p) => !p.materials.length || !!p.pmWarehouseId, { message: 'Choose the packaging store the material comes from', path: ['pmWarehouseId'] });
const downtimeSchema = z.object({
  lineId: z.string().uuid(), startedAt: z.string().datetime({ offset: true }), endedAt: z.string().datetime({ offset: true }),
  reason: z.enum(['BREAKDOWN', 'CLEANING_CIP', 'CHANGEOVER', 'NO_MATERIAL', 'POWER', 'PLANNED_MAINTENANCE', 'QUALITY_HOLD', 'OTHER']),
  remarks: z.string().trim().max(500).optional().nullable(), batchId: z.string().uuid().optional().nullable(),
}).refine((d) => d.endedAt > d.startedAt, { message: 'The end must be after the start', path: ['endedAt'] });

/** Signature of a box label: HMAC-SHA256 over the serial and lot, keyed from the application key; 16 url-safe characters. */
export function boxSignature(cfg: Config, serial: string, lotNo: string) {
  const key = createHmac('sha256', Buffer.from(cfg.APP_ENCRYPTION_KEY, 'base64')).update('box-qr-v1').digest();
  return createHmac('sha256', key).update(`${serial}|${lotNo}`).digest('base64url').slice(0, 16);
}

export function packingRoutes(db: Db, cfg: Config) {
  const r = Router();

  r.get('/', requirePermission('mfg.packing:view'), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = ['true'];
    const lot = str(req.query.lotId);
    if (lot) { args.push(lot); where.push(`p.lot_id = $${args.length}`); }
    const rows = (await db.query(
      `select p.id, p.doc_no as "docNo", l.id as "lotId", l.lot_no as "lotNo", i.code as "itemCode", i.name as "itemName", ip.pack_code as "packCode", ip.pack_size as "packSize", ip.pack_uom as "packUom",
              ip.container, p.packs_filled as "packsFilled", p.packs_rejected as "packsRejected", p.spillage_qty as "spillageQty", p.packed_qty as "packedQty", p.box_count as "boxCount",
              p.pm_cost as "pmCost", p.posted_at as "postedAt", u.full_name as "postedBy"
         from mfg.packing_runs p join inv.lots l on l.id = p.lot_id join mdm.items i on i.id = l.item_id join mdm.item_packs ip on ip.id = p.item_pack_id join iam.users u on u.id = p.posted_by
        where ${where.join(' and ')} order by p.posted_at desc limit 200`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  /** What can be packed: produced lots not rejected, with stock and what is already packed, and the item's packs. */
  r.get('/packable-lots', requirePermission('mfg.packing:post'), asyncHandler(async (_req, res) => {
    const rows = (await db.query(
      `select l.id, l.lot_no as "lotNo", l.qc_status as "qcStatus", i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.base_uom as uom,
              coalesce((select sum(qty) from inv.stock_ledger s where s.lot_id = l.id), 0) as "onHand",
              coalesce((select sum(packed_qty) from mfg.packing_runs p where p.lot_id = l.id), 0) as packed,
              coalesce((select json_agg(json_build_object('id', ip.id, 'packCode', ip.pack_code, 'packSize', ip.pack_size, 'packUom', ip.pack_uom, 'container', ip.container, 'unitsPerBox', ip.units_per_box) order by ip.pack_size)
                 from mdm.item_packs ip where ip.item_id = l.item_id and ip.status = 'Active'), '[]'::json) as packs
         from inv.lots l join mdm.items i on i.id = l.item_id where l.source_type = 'PRODUCTION' and l.qc_status <> 'Rejected' order by l.created_at desc limit 100`)).rows;
    res.json({ data: rows.filter((x) => Number(x.onHand) - Number(x.packed) > 0) });
  }));

  r.post('/', requirePermission('mfg.packing:post'), asyncHandler(async (req, res) => {
    const d = parse(packingSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const lot = (await tx.query(`select l.id, l.lot_no, l.item_id, l.qc_status, l.source_type, i.base_uom as uom from inv.lots l join mdm.items i on i.id = l.item_id where l.id = $1 for update of l`, [d.lotId])).rows[0];
      if (!lot || lot.source_type !== 'PRODUCTION') throw Errors.rule('NOT_A_PRODUCED_LOT', 'Choose a lot made in production.');
      if (lot.qc_status === 'Rejected') throw Errors.rule('LOT_REJECTED', `Lot ${lot.lot_no} is rejected and cannot be packed.`);
      const pack = (await tx.query(`select id, pack_code, pack_size, pack_uom, units_per_box, status, item_id from mdm.item_packs where id = $1`, [d.itemPackId])).rows[0];
      if (!pack || pack.item_id !== lot.item_id || pack.status !== 'Active') throw Errors.rule('WRONG_PACK', 'Choose an active pack size of this product.');
      const per = await convertQty(tx, lot.item_id, Number(pack.pack_size), pack.pack_uom, lot.uom);
      if (per === null) throw Errors.rule('NO_CONVERSION', `No conversion from ${pack.pack_uom} to ${lot.uom} for this product.`);
      const packedQty = r3(per * d.packsFilled);
      const loss = r3(per * d.packsRejected + d.spillageQty);
      const stock = (await tx.query(`select warehouse_id, bucket, sum(qty) as qty, sum(qty * unit_cost) / nullif(sum(qty), 0) as cost from inv.stock_ledger
                                      where lot_id = $1 group by warehouse_id, bucket having sum(qty) > 0 order by sum(qty) desc`, [lot.id])).rows;
      const onHand = stock.reduce((a, s) => a + Number(s.qty), 0);
      const packed = Number((await tx.query(`select coalesce(sum(packed_qty), 0) as q from mfg.packing_runs where lot_id = $1`, [lot.id])).rows[0].q);
      if (packed + packedQty + loss > onHand + 1e-6) throw Errors.rule('NOT_ENOUGH_BULK', `Lot ${lot.lot_no}: ${r3(onHand - packed)} ${lot.uom} is left to pack; this run needs ${r3(packedQty + loss)}.`);
      const clearanceId = d.lineId ? await takeLineClearance(tx, d.lineId, 'PACKING') : null;      // QA-017
      const docNo = await nextDocNo(tx, 'PACKING_RUN');
      const run = (await tx.query(
        `insert into mfg.packing_runs (doc_no, lot_id, item_pack_id, line_id, packs_filled, packs_rejected, spillage_qty, packed_qty, box_count, remarks, posted_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [docNo, lot.id, pack.id, d.lineId ?? null, d.packsFilled, d.packsRejected, d.spillageQty, packedQty, Math.ceil(d.packsFilled / pack.units_per_box), d.remarks ?? null, req.auth!.user.id])).rows[0];
      if (clearanceId) await tx.query(`update mfg.line_clearances set used_by_packing = $2 where id = $1`, [clearanceId, run.id]);
      // packing loss leaves the lot from its largest holding
      if (loss > 0) {
        const s = stock[0];
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,$4,$5,$6,'PACKING_LOSS','mfg.packing_run',$7,$8)`, [lot.item_id, lot.id, s.warehouse_id, s.bucket, -loss, Number(s.cost ?? 0), run.id, req.auth!.user.id]);
      }
      // packaging material: released lots, earliest expiry first, from the packaging store
      let pmCost = 0;
      for (const m of d.materials) {
        let need = m.qty;
        const lots = (await tx.query(`select l.id, l.lot_no from inv.lots l where l.item_id = $1 and l.qc_status = 'Released' and (l.expiry_date is null or l.expiry_date >= $2)
                                       order by l.expiry_date nulls last, l.created_at for update`, [m.itemId, todayIST()])).rows;
        for (const pl of lots) {
          if (need <= 0) break;
          const b = (await tx.query(`select coalesce(sum(qty), 0) as q, coalesce(sum(qty * unit_cost) / nullif(sum(qty), 0), 0) as cost from inv.stock_ledger
                                      where lot_id = $1 and warehouse_id = $2 and bucket = 'UNRESTRICTED'`, [pl.id, d.pmWarehouseId])).rows[0];
          const reserved = Number((await tx.query(`select coalesce(sum(qty - issued_qty), 0) as q from inv.reservations where lot_id = $1 and status = 'Active' and bucket = 'UNRESTRICTED'`, [pl.id])).rows[0].q);
          const free = Number(b.q) - reserved;
          if (free <= 0) continue;
          const take = Math.min(free, need);
          await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                          values ($1,$2,$3,'UNRESTRICTED',$4,$5,'PACKING_ISSUE','mfg.packing_run',$6,$7)`, [m.itemId, pl.id, d.pmWarehouseId, -take, Number(b.cost), run.id, req.auth!.user.id]);
          await tx.query(`insert into mfg.packing_materials (packing_run_id, lot_id, item_id, warehouse_id, qty, unit_cost) values ($1,$2,$3,$4,$5,$6)`, [run.id, pl.id, m.itemId, d.pmWarehouseId, take, Number(b.cost)]);
          pmCost += take * Number(b.cost);
          need = r3(need - take);
        }
        if (need > 0) {
          const code = (await tx.query(`select code from mdm.items where id = $1`, [m.itemId])).rows[0]?.code ?? 'material';
          throw Errors.rule('PACKAGING_SHORT', `Not enough released ${code} in the packaging store: ${need} short.`);
        }
      }
      await tx.query(`update mfg.packing_runs set pm_cost = $2 where id = $1`, [run.id, r2(pmCost)]);
      // boxes: full boxes of units_per_box, the last one holds the rest
      for (let i = 0, left = d.packsFilled; left > 0; i++, left -= pack.units_per_box) {
        const serial = (await nextDocNo(tx, 'BOX')).replaceAll('/', '-');
        await tx.query(`insert into inv.boxes (serial, lot_id, item_pack_id, packing_run_id, units, signature) values ($1,$2,$3,$4,$5,$6)`,
          [serial, lot.id, pack.id, run.id, Math.min(pack.units_per_box, left), boxSignature(cfg, serial, lot.lot_no)]);
      }
      await audit(tx, actorOf(req), { action: 'mfg.packing.posted', entityType: 'inv.lot', entityId: lot.id, after: { docNo, pack: pack.pack_code, ...d, packedQty, loss, pmCost: r2(pmCost) } });
      return { id: run.id as string, docNo, packedQty, loss, boxes: Math.ceil(d.packsFilled / pack.units_per_box), pmCost: r2(pmCost) };
    });
    res.status(201).json(out);
  }));

  r.get('/:id', requirePermission('mfg.packing:view'), asyncHandler(async (req: Request, res) => {
    const run = (await db.query(
      `select p.id, p.doc_no as "docNo", l.id as "lotId", l.lot_no as "lotNo", l.qc_status as "lotStatus", l.mfg_date as "mfgDate", l.expiry_date as "expiryDate", i.code as "itemCode", i.name as "itemName",
              i.base_uom as uom, ip.pack_code as "packCode", ip.pack_size as "packSize", ip.pack_uom as "packUom", ip.container, ip.units_per_box as "unitsPerBox", p.packs_filled as "packsFilled",
              p.packs_rejected as "packsRejected", p.spillage_qty as "spillageQty", p.packed_qty as "packedQty", p.box_count as "boxCount", p.pm_cost as "pmCost", p.remarks,
              ln.code as "lineCode", p.posted_at as "postedAt", u.full_name as "postedBy"
         from mfg.packing_runs p join inv.lots l on l.id = p.lot_id join mdm.items i on i.id = l.item_id join mdm.item_packs ip on ip.id = p.item_pack_id
         join iam.users u on u.id = p.posted_by left join mfg.lines ln on ln.id = p.line_id where p.id = $1`, [req.params.id])).rows[0];
    if (!run) throw Errors.notFound('Packing run');
    const materials = (await db.query(`select pm.qty, pm.unit_cost as "unitCost", l.lot_no as "lotNo", i.code as "itemCode", i.base_uom as uom
      from mfg.packing_materials pm join inv.lots l on l.id = pm.lot_id join mdm.items i on i.id = pm.item_id where pm.packing_run_id = $1 order by i.code`, [run.id])).rows;
    const boxes = (await db.query(`select serial, units, status, signature from inv.boxes where packing_run_id = $1 order by serial`, [run.id])).rows;
    // labels carry a verification link with the signature; the QR images are drawn here so print needs no other service
    const origin = `${req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;
    const labels = str(req.query.labels) === '1' ? await Promise.all(boxes.map(async (b) => {
      const url = `${origin}/verify/${encodeURIComponent(b.serial)}?s=${b.signature}`;
      return { serial: b.serial, units: b.units, url, svg: await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }) };
    })) : undefined;
    res.json({ ...run, materials, boxes: boxes.map(({ signature: _s, ...b }) => b), labels });
  }));

  return r;
}

/** Public label check (QR-001/002): no sign-in; a wrong or missing signature says "not genuine" and nothing else. */
export function publicVerifyRoutes(db: Db, cfg: Config) {
  const r = Router();
  r.get('/verify/:serial', asyncHandler(async (req, res) => {
    const b = (await db.query(
      `select b.serial, b.signature, b.status, b.units, l.lot_no, l.mfg_date, l.expiry_date, l.qc_status, i.name as item_name, ip.pack_size, ip.pack_uom, ip.container
         from inv.boxes b join inv.lots l on l.id = b.lot_id join mdm.items i on i.id = l.item_id join mdm.item_packs ip on ip.id = b.item_pack_id where b.serial = $1`, [req.params.serial])).rows[0];
    const sig = str(req.query.s) ?? '';
    if (!b || sig !== b.signature || sig !== boxSignature(cfg, b.serial, b.lot_no)) { res.json({ genuine: false }); return; }
    res.json({ genuine: true, serial: b.serial, product: b.item_name, pack: `${Number(b.pack_size)} ${b.pack_uom}${b.container ? ` ${b.container}` : ''}`, units: b.units, lotNo: b.lot_no,
      mfgDate: b.mfg_date, expiryDate: b.expiry_date, released: b.qc_status === 'Released', status: b.status });
  }));
  return r;
}

export function productionInsightRoutes(db: Db) {
  const r = Router();

  // D32 (provisional): actual cost = material dosed + packaging used on its lot + conversion (energy, labour, overhead) per batch hour
  r.get('/cost-sheet/:batchId', requirePermission('mfg.batch:view'), asyncHandler(async (req, res) => {
    const b = (await db.query(`select b.id, b.batch_no, b.status, b.output_qty, b.uom, b.material_cost, b.started_at, b.completed_at, b.fg_lot_id, o.item_id
      from mfg.batches b join mfg.production_orders o on o.id = b.production_order_id where b.id = $1`, [req.params.batchId])).rows[0];
    if (!b) throw Errors.notFound('Batch');
    if (b.status !== 'Completed') { res.json({ available: false, reason: 'The cost sheet is drawn up when the batch is completed.' }); return; }
    const rates = (await db.query(`select value from sys.settings where key = 'mfg.conversionCost'`)).rows[0]?.value ?? {};
    const hours = r2((new Date(b.completed_at).getTime() - new Date(b.started_at).getTime()) / 3_600_000);
    const packaging = Number((await db.query(`select coalesce(sum(pm_cost), 0) as c from mfg.packing_runs where lot_id = $1`, [b.fg_lot_id])).rows[0].c);
    const lines = [
      { element: 'Raw material (lots dosed)', amount: Number(b.material_cost) },
      { element: 'Packaging material', amount: packaging },
      { element: `Energy (${hours} h × ₹${rates.energyPerHour ?? 0})`, amount: r2(hours * Number(rates.energyPerHour ?? 0)) },
      { element: `Labour (${hours} h × ₹${rates.labourPerHour ?? 0})`, amount: r2(hours * Number(rates.labourPerHour ?? 0)) },
      { element: `Overhead (${hours} h × ₹${rates.overheadPerHour ?? 0})`, amount: r2(hours * Number(rates.overheadPerHour ?? 0)) },
    ];
    const total = r2(lines.reduce((a, l) => a + l.amount, 0));
    const kg = await convertQty(db, b.item_id, Number(b.output_qty), b.uom, 'KG');
    res.json({ available: true, batchNo: b.batch_no, hours, output: Number(b.output_qty), uom: b.uom, lines, total, perUnit: r2(total / Number(b.output_qty)),
      perMt: kg ? r2(total / (kg / 1000)) : null, ratesConfigured: ['energyPerHour', 'labourPerHour', 'overheadPerHour'].some((k) => Number(rates[k] ?? 0) > 0) });
  }));

  r.get('/downtime', requirePermission('mfg.batch:view'), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = ['true'];
    const line = str(req.query.lineId);
    if (line) { args.push(line); where.push(`d.line_id = $${args.length}`); }
    const rows = (await db.query(
      `select d.id, d.line_id as "lineId", ln.code as "lineCode", ln.name as "lineName", d.started_at as "startedAt", d.ended_at as "endedAt", d.reason, d.remarks,
              round(extract(epoch from d.ended_at - d.started_at) / 3600.0, 2) as hours, b.batch_no as "batchNo", u.full_name as "recordedBy"
         from mfg.downtime_events d join mfg.lines ln on ln.id = d.line_id left join mfg.batches b on b.id = d.batch_id join iam.users u on u.id = d.recorded_by
        where ${where.join(' and ')} order by d.started_at desc limit 200`, args)).rows;
    res.json({ data: rows, total: rows.length });
  }));

  r.post('/downtime', requirePermission('mfg.batch:execute'), asyncHandler(async (req, res) => {
    const d = parse(downtimeSchema, req.body);
    const out = await withTx(db, async (tx) => {
      if (!(await tx.query(`select 1 from mfg.lines where id = $1`, [d.lineId])).rowCount) throw Errors.notFound('Production line');
      if (new Date(d.endedAt) > new Date(Date.now() + 5 * 60_000)) throw Errors.rule('INVALID_DATE', 'Downtime is recorded after it ends.');
      const overlap = (await tx.query(`select 1 from mfg.downtime_events where line_id = $1 and tstzrange(started_at, ended_at) && tstzrange($2::timestamptz, $3::timestamptz)`, [d.lineId, d.startedAt, d.endedAt])).rowCount;
      if (overlap) throw Errors.conflict('OVERLAP', 'This overlaps downtime already recorded for the line.');
      const row = (await tx.query(`insert into mfg.downtime_events (line_id, started_at, ended_at, reason, remarks, batch_id, recorded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [d.lineId, d.startedAt, d.endedAt, d.reason, d.remarks ?? null, d.batchId ?? null, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'mfg.downtime.recorded', entityType: 'mfg.line', entityId: d.lineId, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));

  /**
   * Production dashboard (MFG-002). KPI formulas are provisional until the KPI workshop (D23): availability = 1 − downtime ÷ scheduled shift hours;
   * quality rate = QA-released output ÷ completed output; right first time = completed batches without any deviation. OEE is not shown until D23 fixes performance.
   */
  r.get('/dashboard', requirePermission('mfg.order:view'), asyncHandler(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(str(req.query.month) ?? '') ? str(req.query.month)! : todayIST().slice(0, 7);
    const from = `${month}-01`;
    const q = async (sql: string, args: unknown[] = []) => (await db.query(sql, [from, ...args])).rows;
    const range = `b.completed_at >= $1::date and b.completed_at < ($1::date + interval '1 month')`;
    const output = await q(`select i.code as "itemCode", i.name as "itemName", o.uom, sum(b.output_qty) as output, count(*)::int as batches, round(avg(b.yield_pct), 2) as "avgYield",
        round(avg(bv.standard_yield_pct), 2) as "stdYield" from mfg.batches b join mfg.production_orders o on o.id = b.production_order_id join mdm.items i on i.id = o.item_id
        left join mfg.bom_versions bv on bv.id = o.bom_version_id where b.status = 'Completed' and ${range} group by i.code, i.name, o.uom order by i.code`);
    const plan = await q(`select i.code as "itemCode", o.uom, sum(o.planned_qty) as planned,
        coalesce(sum((select sum(b.output_qty) from mfg.batches b where b.production_order_id = o.id and b.status = 'Completed')), 0) as produced
        from mfg.production_orders o join mdm.items i on i.id = o.item_id where o.due_date >= $1::date and o.due_date < ($1::date + interval '1 month')
         and o.status not in ('Cancelled','Rejected','Draft') group by i.code, o.uom order by i.code`);
    const rft = (await q(`select count(*)::int as total, count(*) filter (where not exists (select 1 from qa.deviations d where (d.source_type = 'mfg.batch' and d.source_id = b.id)
        or d.id in (select deviation_id from mfg.batch_consumptions c where c.batch_id = b.id) or d.id in (select deviation_id from qc.ipqc_tests t where t.batch_id = b.id)))::int as clean
        from mfg.batches b where b.status = 'Completed' and ${range}`))[0];
    const quality = (await q(`select coalesce(sum(b.output_qty), 0) as completed, coalesce(sum(b.output_qty) filter (where l.qa_disposition = 'Released'), 0) as released
        from mfg.batches b left join inv.lots l on l.id = b.fg_lot_id where b.status = 'Completed' and ${range}`))[0];
    const downtime = await q(`select reason, round(sum(extract(epoch from least(ended_at, $1::date + interval '1 month') - greatest(started_at, $1::date)) / 3600.0), 2) as hours, count(*)::int as events
        from mfg.downtime_events where ended_at > $1::date and started_at < ($1::date + interval '1 month') group by reason order by 2 desc`);
    // scheduled hours: each active line runs its plant's active shifts on every day of the month so far
    const days = Math.max(1, Math.min(new Date(`${from}T00:00:00Z`).getUTCMonth() === new Date(`${todayIST()}T00:00:00Z`).getUTCMonth() && from.slice(0, 4) === todayIST().slice(0, 4)
      ? Number(todayIST().slice(8, 10)) : new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate(), 31));
    const sched = (await q(`select coalesce(sum(h), 0) as h from (select ln.id, (select coalesce(sum(case when s.end_time > s.start_time then extract(epoch from s.end_time - s.start_time)
        else extract(epoch from s.end_time - s.start_time) + 86400 end) / 3600.0, 0) from mfg.shifts s where s.plant_id = ln.plant_id and s.status = 'Active') as h
        from mfg.lines ln where ln.status = 'Active' and ln.line_type <> 'PACKING' and $1::date is not null) x`))[0];
    const scheduledHours = r2(Number(sched.h) * days);
    const downHours = r2(downtime.reduce((a, d) => a + Number(d.hours), 0));
    const counts = (await q(`select (select count(*)::int from mfg.batches where status in ('InProgress','OnHold') and $1::date is not null) as "inProgress",
        (select count(*)::int from inv.lots l where l.source_type = 'PRODUCTION' and l.qa_disposition is null and l.qc_status = 'Quarantine' and $1::date is not null) as "awaitingQa",
        (select count(*)::int from qa.deviations where status = 'Open' and $1::date is not null) as "openDeviations",
        (select count(*)::int from mfg.production_orders where status in ('Approved','Released','InProgress') and $1::date is not null) as "activeOrders"`))[0];
    res.json({
      month, output, plan, counts, downtime,
      kpis: {
        rightFirstTimePct: rft.total ? r2(rft.clean / rft.total * 100) : null, completedBatches: rft.total,
        qualityRatePct: Number(quality.completed) ? r2(Number(quality.released) / Number(quality.completed) * 100) : null,
        availabilityPct: scheduledHours ? r2((1 - downHours / scheduledHours) * 100) : null, scheduledHours, downtimeHours: downHours,
      },
      provisional: 'KPI formulas are provisional until the KPI workshop (D23). OEE needs the performance formula and is not shown yet.',
    });
  }));

  return r;
}
