import { describe, expect, it } from 'vitest';
import { effectiveBomVersion } from '../src/modules/production/boms';
import { db, uniq, userAgent } from './helpers';
import { approve, inDays } from './purchase-fixtures';
import { todayIST } from '../src/modules/sales/quotations';

async function plantSetup() {
  const le = (await db.query(`insert into org.legal_entities (code, name, pan, state_code, status) values ($1,'[TEST] Maker Pvt Ltd','AAAAA0000A','27','Active') returning id`, [uniq('LE')])).rows[0].id as string;
  const plant = (await db.query(`insert into org.plants (legal_entity_id, code, name, state_code, status) values ($1,$2,'[TEST] Chakan plant','27','Active') returning id`, [le, uniq('PL')])).rows[0].id as string;
  const item = async (type: string, name: string, uom = 'KG') => (await db.query(
    `insert into mdm.items (code, name, item_type, base_uom, shelf_life_days, status) values ($1,$2,$3,$4,365,'Active') returning id`, [uniq(type), name, type, uom])).rows[0].id as string;
  return {
    plant, fg: await item('FG', '[TEST] Zinc EDTA 12%'), rm1: await item('RM', '[TEST] Zinc sulphate'), rm2: await item('RM', '[TEST] EDTA disodium'),
    rmAlt: await item('RM', '[TEST] Zinc oxide'), pm: await item('PM', '[TEST] 1 kg pouch'),
    planner: await userAgent([{ code: 'PRODUCTION_PLANNER' }]), plantHead: await userAgent([{ code: 'PLANT_HEAD' }]),
    qa: await userAgent([{ code: 'QA_MANAGER' }]), supervisor: await userAgent([{ code: 'PRODUCTION_SUPERVISOR' }]),
  };
}

describe('Plant & line settings (MFG-019)', () => {
  it('lets the plant head keep lines with machine parameters and shifts; others can only view', async () => {
    const f = await plantSetup();
    const code = uniq('RX-').slice(0, 20);
    const line = await f.plantHead.post('/api/v1/production/lines', { plantId: f.plant, code, name: '[TEST] Reactor 1', lineType: 'REACTOR',
      capacityPerShift: 5, capacityUom: 'MT', parameters: [{ name: 'Jacket temperature', value: '85', unit: '°C' }] }).expect(201);
    await f.plantHead.post('/api/v1/production/lines', { plantId: f.plant, code, name: 'dup', lineType: 'REACTOR' }).expect(409);
    await f.plantHead.post('/api/v1/production/lines', { plantId: f.plant, code: uniq('RX-').slice(0, 20), name: 'x', lineType: 'REACTOR', capacityPerShift: 5 }).expect(400);
    await f.planner.post('/api/v1/production/lines', { plantId: f.plant, code: uniq('RX-').slice(0, 20), name: 'x', lineType: 'BLENDER' }).expect(403);
    for (const [c, n, s, e] of [['A', 'Shift A', '06:00', '14:00'], ['B', 'Shift B', '14:00', '22:00'], ['N', 'Night', '22:00', '06:00']]) {
      await f.plantHead.post('/api/v1/production/shifts', { plantId: f.plant, code: c, name: n, startTime: s, endTime: e }).expect(201);
    }
    await f.plantHead.post('/api/v1/production/shifts', { plantId: f.plant, code: 'A', name: 'again', startTime: '07:00', endTime: '15:00' }).expect(409);
    const plants = (await f.supervisor.get('/api/v1/production/plants').expect(200)).body.data;
    const p = plants.find((x: { id: string }) => x.id === f.plant);
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0].parameters[0].name).toBe('Jacket temperature');
    expect(p.shifts.map((s: { code: string; endTime: string }) => `${s.code} ${s.endTime}`)).toEqual(['A 14:00', 'B 22:00', 'N 06:00']);
    await f.plantHead.post(`/api/v1/production/lines/${line.body.id}/status`, { status: 'Inactive', reason: '[TEST] under maintenance' }).expect(200);
    expect((await f.supervisor.get(`/api/v1/production/lines?plantId=${f.plant}&status=Inactive`).expect(200)).body.data).toHaveLength(1);
  });
});

describe('Formulation (BOM) master (MFG-006, MFG-009)', () => {
  it('versions a formulation: plant head then QA approve; the next version closes the previous one on its effective date', async () => {
    const f = await plantSetup();
    const code = uniq('F-').slice(0, 20);
    const bom = await f.planner.post('/api/v1/boms', { itemId: f.fg, code, name: '[TEST] Zinc EDTA 12% formulation' }).expect(201);
    await f.planner.post('/api/v1/boms', { itemId: f.fg, code: uniq('F-').slice(0, 20), name: 'second' }).expect(409);
    await f.planner.post('/api/v1/boms', { itemId: f.rm1, code: uniq('F-').slice(0, 20), name: 'not an output' }).expect(422);
    const v1 = {
      batchSize: 1000, standardYieldPct: 97.5, reactionTempC: 80, reactionTimeMin: 120, effectiveFrom: todayIST(), changeNote: '[TEST] first issue',
      lines: [
        { stepNo: 1, itemId: f.rm1, qty: 450, tolerancePct: 2, alternates: [{ itemId: f.rmAlt, factor: 0.56, notes: 'approved substitute' }] },
        { stepNo: 2, itemId: f.rm2, qty: 600, tolerancePct: 1 },
      ],
    };
    // packaging and the output item itself are not ingredients
    await f.planner.post(`/api/v1/boms/${bom.body.id}/versions`, { ...v1, lines: [...v1.lines, { itemId: f.pm, qty: 1, tolerancePct: 0 }] }).expect(422);
    await f.planner.post(`/api/v1/boms/${bom.body.id}/versions`, { ...v1, lines: [{ itemId: f.fg, qty: 1, tolerancePct: 0 }] }).expect(422);
    const c1 = await f.planner.post(`/api/v1/boms/${bom.body.id}/versions`, v1).expect(201);
    expect(c1.body.versionNo).toBe(1);
    await f.planner.post(`/api/v1/boms/${bom.body.id}/versions`, v1).expect(422); // one open draft at a time
    const s1 = await f.planner.post(`/api/v1/boms/${bom.body.id}/versions/${c1.body.id}/submit`).expect(200);
    await approve(f.qa, s1.body.approvalRequestId).expect(403);          // plant head first
    await approve(f.plantHead, s1.body.approvalRequestId).expect(200);
    await approve(f.qa, s1.body.approvalRequestId).expect(200);
    const d1 = (await f.supervisor.get(`/api/v1/boms/${bom.body.id}/versions/${c1.body.id}`).expect(200)).body;
    expect(d1.state).toBe('Current');
    expect(d1.lines[0].alternates[0].factor).toBe(0.56);
    expect(d1.allowedActions).toEqual([]);
    await f.planner.put(`/api/v1/boms/${bom.body.id}/versions/${c1.body.id}`, { ...v1, version: d1.version }).expect(422); // approved = frozen
    expect((await effectiveBomVersion(db, f.fg, todayIST()))?.versionNo).toBe(1);

    // v2 from in ten days: approving it ends v1 the day before
    const c2 = await f.planner.post(`/api/v1/boms/${bom.body.id}/versions`, { ...v1, standardYieldPct: 98, effectiveFrom: inDays(10), changeNote: '[TEST] better yield' }).expect(201);
    const s2 = await f.planner.post(`/api/v1/boms/${bom.body.id}/versions/${c2.body.id}/submit`).expect(200);
    await approve(f.plantHead, s2.body.approvalRequestId).expect(200);
    await approve(f.qa, s2.body.approvalRequestId).expect(200);
    const list = (await f.planner.get(`/api/v1/boms/${bom.body.id}`).expect(200)).body.versions;
    expect(list.map((v: { versionNo: number; state: string; effectiveTo: string | null }) => [v.versionNo, v.state, v.effectiveTo])).toEqual([[2, 'Scheduled', null], [1, 'Current', inDays(9)]]);
    expect((await effectiveBomVersion(db, f.fg, todayIST()))?.versionNo).toBe(1);
    expect((await effectiveBomVersion(db, f.fg, inDays(10)))?.versionNo).toBe(2);

    // a version dated before the scheduled one is refused at submission; it can be withdrawn
    const c3 = await f.planner.post(`/api/v1/boms/${bom.body.id}/versions`, { ...v1, effectiveFrom: inDays(5), changeNote: '[TEST] too early' }).expect(201);
    const bad = await f.planner.post(`/api/v1/boms/${bom.body.id}/versions/${c3.body.id}/submit`).expect(422);
    expect(bad.body.error.code).toBe('EFFECTIVE_DATE_OVERLAP');
    await f.planner.post(`/api/v1/boms/${bom.body.id}/versions/${c3.body.id}/withdraw`, { reason: '[TEST] wrong date' }).expect(200);
    const reg = (await f.qa.get(`/api/v1/boms?q=${code}`).expect(200)).body.data[0];
    expect([reg.currentVersion, reg.ingredientCount, reg.versionCount]).toEqual([1, 2, 3]);
  });
});
