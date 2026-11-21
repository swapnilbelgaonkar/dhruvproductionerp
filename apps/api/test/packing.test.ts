import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, db, uniq, userAgent } from './helpers';
import { approvedOrder, lotQty, prodSetup, stockLot } from './production-fixtures';

/** A completed batch of 1,000 L planned with its FG lot, a 1 L bottle pack (12 per box) and bottles in a packaging store. */
async function packed() {
  const f = await prodSetup();
  const analyst = await userAgent([{ code: 'QC_ANALYST' }]);
  await stockLot(f.zn, f.rmWh, 450, { cost: 60 }); await stockLot(f.edta, f.rmWh, 600, { cost: 180 });
  const id = await approvedOrder(f, 1000);
  await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(200);
  const o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
  await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: o.reservations.map((r: { id: string; qty: string }) => ({ reservationId: r.id, qty: Number(r.qty) })) }).expect(201);
  const s = await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['A'] }).expect(201);
  const b = (await f.supervisor.get(`/api/v1/batches/${s.body.id}`).expect(200)).body;
  for (const m of b.materials) await f.supervisor.post(`/api/v1/batches/${s.body.id}/dosing`, { orderMaterialId: m.id, entries: [{ lotId: b.lots[m.id][0].lotId, qty: m.planned }] }).expect(201);
  const t = await f.supervisor.post(`/api/v1/batches/${s.body.id}/ipqc`, { stage: 'x' }).expect(201);
  await analyst.post(`/api/v1/batches/ipqc/${t.body.id}/results`, { results: [{ parameter: 'pH', specification: '6–6.5', result: '6.2', pass: true }] }).expect(200);
  const done = await f.supervisor.post(`/api/v1/batches/${s.body.id}/complete`, { outputQty: 975 }).expect(200);
  const fgLot = (await db.query(`select id from inv.lots where lot_no = $1`, [done.body.fgLotNo])).rows[0].id as string;
  const pack = (await db.query(`insert into mdm.item_packs (item_id, pack_code, pack_size, pack_uom, container, units_per_box) values ($1,'1L',1,'L','Bottle',12) returning id`, [f.fg])).rows[0].id as string;
  const pmWh = (await db.query(`insert into org.warehouses (legal_entity_id, code, name, type, state_code, status) values ($1,$2,'[TEST] PM store','PM','27','Active') returning id`, [f.le, uniq('WH')])).rows[0].id as string;
  const bottle = (await db.query(`insert into mdm.items (code, name, item_type, base_uom, status) values ($1,'[TEST] 1 L bottle','PM','NOS','Active') returning id`, [uniq('PM')])).rows[0].id as string;
  await stockLot(bottle, pmWh, 80, { cost: 6 }); await stockLot(bottle, pmWh, 80, { cost: 6.5, expiryDays: 400 });
  return { f, batchId: s.body.id as string, fgLot, pack, pmWh, bottle };
}

describe('Packing, labels, cost sheet, downtime and dashboard (MFG-011, MFG-014, MFG-015, MFG-002, QR-001/002)', () => {
  it('packs a lot into boxes with signed labels, draws packaging FEFO, and books the loss', async () => {
    const { f, fgLot, pack, pmWh, bottle } = await packed();
    const run = { lotId: fgLot, itemPackId: pack, packsFilled: 100, packsRejected: 2, spillageQty: 0.5, pmWarehouseId: pmWh, materials: [{ itemId: bottle, qty: 102 }] };
    await f.planner.post('/api/v1/packing-runs', run).expect(403);
    await f.supervisor.post('/api/v1/packing-runs', { ...run, packsFilled: 2000 }).expect(422);                                 // more than the lot holds
    expect((await f.supervisor.post('/api/v1/packing-runs', { ...run, materials: [{ itemId: bottle, qty: 500 }] }).expect(422)).body.error.code).toBe('PACKAGING_SHORT');
    const p = await f.supervisor.post('/api/v1/packing-runs', run).expect(201);
    expect(p.body).toMatchObject({ packedQty: 100, loss: 2.5, boxes: 9, pmCost: 80 * 6.5 + 22 * 6 })   // FEFO: the lot with an expiry goes first;
    expect(await lotQty(fgLot, 'QUARANTINE')).toBe(972.5);
    const d = (await f.supervisor.get(`/api/v1/packing-runs/${p.body.id}?labels=1`).expect(200)).body;
    expect(d.boxes.map((x: { units: number }) => x.units)).toEqual([12, 12, 12, 12, 12, 12, 12, 12, 4]);
    expect(d.labels[0].svg).toContain('<svg');
    // public check: the signed link says genuine; a forged signature or serial says nothing else
    const url = new URL(d.labels[0].url);
    const ok = await request(app).get(`/api/v1/public${url.pathname}?s=${url.searchParams.get('s')}`).expect(200);
    expect(ok.body).toMatchObject({ genuine: true, serial: d.boxes[0].serial, units: 12, released: false });
    expect((await request(app).get(`/api/v1/public${url.pathname}?s=AAAAAAAAAAAAAAAA`).expect(200)).body).toEqual({ genuine: false });
    expect((await request(app).get(`/api/v1/public/verify/BX-NOPE?s=${url.searchParams.get('s')}`).expect(200)).body).toEqual({ genuine: false });
  });

  it('draws up the cost sheet, records downtime and fills the dashboard', async () => {
    const { f, batchId, fgLot, pack, pmWh, bottle } = await packed();
    await f.supervisor.post('/api/v1/packing-runs', { lotId: fgLot, itemPackId: pack, packsFilled: 24, pmWarehouseId: pmWh, materials: [{ itemId: bottle, qty: 24 }] }).expect(201);
    await db.query(`update mfg.batches set started_at = completed_at - interval '4 hours' where id = $1`, [batchId]);
    await db.query(`update sys.settings set value = '{"energyPerHour": 500, "labourPerHour": 750, "overheadPerHour": 250}' where key = 'mfg.conversionCost'`);
    const cs = (await f.planner.get(`/api/v1/production/cost-sheet/${batchId}`).expect(200)).body;
    expect(cs.lines.map((l: { amount: number }) => l.amount)).toEqual([450 * 60 + 600 * 180, 24 * 6.5, 2000, 3000, 1000]);
    expect(cs).toMatchObject({ hours: 4, total: 135000 + 156 + 6000, perUnit: Math.round(141156 / 975 * 100) / 100 });
    await db.query(`update sys.settings set value = '{"energyPerHour": 0, "labourPerHour": 0, "overheadPerHour": 0}' where key = 'mfg.conversionCost'`);

    const start = new Date(Date.now() - 3 * 3_600_000).toISOString(), mid = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await f.planner.post('/api/v1/production/downtime', { lineId: f.line, startedAt: start, endedAt: mid, reason: 'CLEANING_CIP' }).expect(403);
    await f.supervisor.post('/api/v1/production/downtime', { lineId: f.line, startedAt: start, endedAt: mid, reason: 'CLEANING_CIP', remarks: '[TEST] CIP after batch' }).expect(201);
    await f.supervisor.post('/api/v1/production/downtime', { lineId: f.line, startedAt: start, endedAt: mid, reason: 'BREAKDOWN' }).expect(409);
    const dash = (await f.planner.get('/api/v1/production/dashboard').expect(200)).body;
    expect(dash.output.some((o: { batches: number }) => o.batches >= 1)).toBe(true);
    expect(Number(dash.downtime.find((x: { reason: string }) => x.reason === 'CLEANING_CIP').hours)).toBeGreaterThanOrEqual(1);
    expect(dash.kpis).toHaveProperty('rightFirstTimePct');
    expect(dash.provisional).toMatch(/D23/);
  });
});
