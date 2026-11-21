import { describe, expect, it } from 'vitest';
import { db, userAgent } from './helpers';
import { completedBatch, lotQty, prodSetup } from './production-fixtures';
import { approve, inDays } from './purchase-fixtures';

const qaTeam = async () => ({
  exec: await userAgent([{ code: 'QA_EXECUTIVE' }]), manager: await userAgent([{ code: 'QA_MANAGER' }]), head: await userAgent([{ code: 'QA_HEAD' }]),
  analyst: await userAgent([{ code: 'QC_ANALYST' }]), director: await userAgent([{ code: 'EXEC_ADMIN' }]), se: await userAgent([{ code: 'SALES_SE' }]),
});
const uid = async (a: { get: (p: string) => { expect: (n: number) => Promise<{ body: { user?: { id: string }; id?: string } }> } }) => {
  const me = (await a.get('/api/v1/me').expect(200)).body; return (me.user?.id ?? me.id) as string;
};

describe('QA core: CAPA, NC, change control, complaints, recall (QA-007…009, QA-013, QA-016)', () => {
  it('runs a CAPA through actions and an independent effectiveness check; a critical NC and a justified complaint need one', async () => {
    const t = await qaTeam();
    const [execId, analystId] = [await uid(t.exec), await uid(t.analyst)];
    const nc = await t.analyst.post('/api/v1/qa/ncs', { kind: 'MATERIAL', title: '[TEST] caking in zinc sulphate', description: 'Lumps in 3 bags', severity: 'CRITICAL' }).expect(201);
    expect((await t.exec.post(`/api/v1/qa/ncs/${nc.body.id}/close`, { disposition: 'RETURN', note: 'x' }).expect(422)).body.error.code).toBe('CAPA_REQUIRED');
    const capa = await t.exec.post('/api/v1/qa/capas', { title: '[TEST] storage humidity', sourceType: 'NON_CONFORMANCE', sourceId: nc.body.id, problem: 'Caking from humid storage',
      ownerId: execId, dueDate: inDays(30), actions: [
        { kind: 'CORRECTION', description: 'Segregate affected bags', ownerId: analystId, dueDate: inDays(2) },
        { kind: 'PREVENTIVE', description: 'Install dehumidifier in RM store', ownerId: execId, dueDate: inDays(20) }] }).expect(201);
    await t.exec.post(`/api/v1/qa/ncs/${nc.body.id}/close`, { disposition: 'RETURN', note: '[TEST] returned to vendor' }).expect(200);
    let c = (await t.exec.get(`/api/v1/qa/capas/${capa.body.id}`).expect(200)).body;
    const [a1, a2] = [c.actions.find((a: { kind: string }) => a.kind === 'CORRECTION').id, c.actions.find((a: { kind: string }) => a.kind === 'PREVENTIVE').id];
    await t.analyst.post(`/api/v1/qa/capas/${capa.body.id}/actions/${a2}/complete`, { evidence: 'x' }).expect(403);      // not the analyst's action
    await t.analyst.post(`/api/v1/qa/capas/${capa.body.id}/actions/${a1}/complete`, { evidence: '[TEST] 3 bags segregated' }).expect(200);
    expect((await t.exec.post(`/api/v1/qa/capas/${capa.body.id}/actions/${a2}/complete`, { evidence: '[TEST] installed' }).expect(200)).body.capaStatus).toBe('EffectivenessCheck');
    await t.exec.post(`/api/v1/qa/capas/${capa.body.id}/verify`, { effective: true, note: 'x' }).expect(403);           // the owner (and an executive) cannot verify
    await t.manager.post(`/api/v1/qa/capas/${capa.body.id}/verify`, { effective: false, note: '[TEST] humidity still 72%' }).expect(200);
    c = (await t.exec.get(`/api/v1/qa/capas/${capa.body.id}`).expect(200)).body;
    expect(c.status).toBe('Open');
    await t.exec.post(`/api/v1/qa/capas/${capa.body.id}/actions`, { kind: 'CORRECTIVE', description: 'Seal the store door', ownerId: execId, dueDate: inDays(5) }).expect(201);
    const a3 = (await t.exec.get(`/api/v1/qa/capas/${capa.body.id}`).expect(200)).body.actions.find((a: { status: string }) => a.status === 'Open').id;
    await t.exec.post(`/api/v1/qa/capas/${capa.body.id}/actions/${a3}/complete`, { evidence: '[TEST] sealed; 48% RH' }).expect(200);
    await t.manager.post(`/api/v1/qa/capas/${capa.body.id}/verify`, { effective: true, note: '[TEST] 4 weeks below 50% RH' }).expect(200);
    expect((await t.exec.get(`/api/v1/qa/capas/${capa.body.id}`).expect(200)).body).toMatchObject({ status: 'Closed', effective: true });

    // change control: high risk needs the QA head and the executive director
    const cc = await t.analyst.post('/api/v1/qa/changes', { title: '[TEST] new AAS method', changeType: 'SPECIFICATION', description: 'd', justification: 'j', impact: 'i', risk: 'HIGH' }).expect(201);
    const sub = await t.analyst.post(`/api/v1/qa/changes/${cc.body.id}/submit`).expect(200);
    const reqId = (await db.query(`select id from wf.approval_requests where doc_no = $1`, [sub.body.approvalDocNo])).rows[0].id;
    await approve(t.head, reqId).expect(200);
    await approve(t.director, reqId).expect(200);
    await t.manager.post(`/api/v1/qa/changes/${cc.body.id}/implement`, { note: '[TEST] spec v2 issued' }).expect(200);
    await t.manager.post(`/api/v1/qa/changes/${cc.body.id}/close`, { note: '[TEST] verified' }).expect(200);
    expect((await t.exec.get(`/api/v1/qa/changes/${cc.body.id}`).expect(200)).body.status).toBe('Closed');
  });

  it('resolves a complaint from a box serial and recalls: a drill traces without touching stock, an actual recall locks every affected lot within the 2-hour target', async () => {
    const f = await prodSetup();
    const t = await qaTeam();
    const run = await completedBatch(f);
    const pack = (await db.query(`insert into mdm.item_packs (item_id, pack_code, pack_size, pack_uom, container, units_per_box) values ($1,'1L',1,'L','Bottle',12) returning id`, [f.fg])).rows[0].id;
    await f.supervisor.post('/api/v1/packing-runs', { lotId: run.fgLot, itemPackId: pack, packsFilled: 24 }).expect(201);
    const serial = (await db.query(`select serial from inv.boxes where lot_id = $1 order by serial limit 1`, [run.fgLot])).rows[0].serial;

    const cmp = await t.se.post('/api/v1/qa/complaints', { receivedOn: inDays(0), channel: 'FIELD_VISIT', boxSerial: serial, category: 'QUALITY', description: '[TEST] sediment in bottles', severity: 'MAJOR' }).expect(201);
    expect(cmp.body.lotId).toBe(run.fgLot);
    await t.se.post('/api/v1/qa/complaints', { receivedOn: inDays(0), channel: 'PHONE', boxSerial: 'BX-NOPE', category: 'QUALITY', description: 'x', severity: 'MINOR' }).expect(422);
    expect((await t.exec.post(`/api/v1/qa/complaints/${cmp.body.id}/close`, { conclusion: 'Justified', response: 'x' }).expect(422)).body.error.code).toBe('NOT_INVESTIGATED');
    await t.exec.post(`/api/v1/qa/complaints/${cmp.body.id}/investigate`, { findings: '[TEST] retained sample shows sediment' }).expect(200);
    expect((await t.exec.post(`/api/v1/qa/complaints/${cmp.body.id}/close`, { conclusion: 'Justified', response: 'x' }).expect(422)).body.error.code).toBe('CAPA_REQUIRED');

    // drill on the zinc lot: the FG lot made from it is found; no stock moves
    const before = await lotQty(run.fgLot, 'QUARANTINE');
    await t.exec.post('/api/v1/qa/recalls', { mode: 'DRILL', reason: 'x', sourceLotId: run.znLot }).expect(403);
    const drill = await t.manager.post('/api/v1/qa/recalls', { mode: 'DRILL', reason: '[TEST] mock recall', sourceLotId: run.znLot }).expect(201);
    expect(drill.body).toMatchObject({ lots: 2, lockedLots: 0 });
    expect(drill.body.traceSeconds).toBeLessThan(7200);
    const d = (await t.manager.get(`/api/v1/qa/recalls/${drill.body.id}`).expect(200)).body;
    expect(d.lots.map((l: { relation: string; lotId: string; boxes: number }) => [l.relation, l.lotId, l.boxes])).toEqual([['SOURCE', run.znLot, 0], ['MADE_FROM', run.fgLot, 2]]);
    expect(await lotQty(run.fgLot, 'QUARANTINE')).toBe(before);

    // actual recall from the complaint: only the QA head; every affected lot is locked
    await t.manager.post('/api/v1/qa/recalls', { mode: 'ACTUAL', reason: 'x', sourceLotId: run.fgLot }).expect(403);
    const act = await t.head.post('/api/v1/qa/recalls', { mode: 'ACTUAL', reason: '[TEST] sediment confirmed', sourceLotId: run.fgLot, complaintId: cmp.body.id }).expect(201);
    expect(act.body).toMatchObject({ lots: 1, lockedLots: 1 });
    expect([await lotQty(run.fgLot, 'QUARANTINE'), await lotQty(run.fgLot, 'BLOCKED')]).toEqual([0, before]);
    expect((await db.query(`select qc_status from inv.lots where id = $1`, [run.fgLot])).rows[0].qc_status).toBe('Hold');
    await t.head.post(`/api/v1/qa/recalls/${act.body.id}/close`, { note: '[TEST] all stock held; dealers informed' }).expect(200);
  });
});
