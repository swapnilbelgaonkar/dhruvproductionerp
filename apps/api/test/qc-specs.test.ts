import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, db, uniq, userAgent } from './helpers';
import { approve, inDays } from './purchase-fixtures';
import { stockLot } from './production-fixtures';
import { todayIST } from '../src/modules/sales/quotations';

async function lab() {
  const [manager, head, analyst, qa] = [await userAgent([{ code: 'QC_MANAGER' }]), await userAgent([{ code: 'QC_HEAD' }]), await userAgent([{ code: 'QC_ANALYST' }]), await userAgent([{ code: 'QA_MANAGER' }])];
  const item = (await db.query(`insert into mdm.items (code, name, item_type, base_uom, status) values ($1,'[TEST] Zinc sulphate','RM','KG','Active') returning id`, [uniq('RM')])).rows[0].id as string;
  const wh = (await db.query(`insert into org.warehouses (legal_entity_id, code, name, type, status) select id, $1, '[TEST] RM', 'RM', 'Active' from org.legal_entities limit 1 returning id`, [uniq('WH')])).rows[0]?.id
    ?? (await db.query(`with le as (insert into org.legal_entities (code, name, pan, state_code, status) values ($2,'[TEST] LE','AAAAA0000A','27','Active') returning id)
        insert into org.warehouses (legal_entity_id, code, name, type, status) select id, $1, '[TEST] RM', 'RM', 'Active' from le returning id`, [uniq('WH'), uniq('LE')])).rows[0].id;
  const m = async (code: string, technique: string) => (await manager.post('/api/v1/qc/master/methods', { code, name: `[TEST] ${code}`, technique }).expect(201)).body.id as string;
  const ph = await m(uniq('PH-').slice(0, 20), 'PH_METER'), aas = await m(uniq('AAS-').slice(0, 20), 'AAS');
  const inst = async (code: string, technique: string) => (await manager.post('/api/v1/qc/master/instruments', { code, name: `[TEST] ${code}`, technique, intervalDays: 180 }).expect(201)).body.id as string;
  const phMeter = await inst(uniq('PHM-').slice(0, 20), 'PH_METER'), aasUnit = await inst(uniq('AASU-').slice(0, 20), 'AAS');
  await manager.post(`/api/v1/qc/master/instruments/${phMeter}/calibrations`, { calibratedOn: todayIST(), result: 'Pass', agency: '[TEST] NABL lab', certificateNo: 'C-1' }).expect(201);
  const spec = await manager.post('/api/v1/qc/master/specs', { itemId: item, code: uniq('SP-').slice(0, 20), title: '[TEST] Zinc sulphate monohydrate' }).expect(201);
  const v = await manager.post(`/api/v1/qc/master/specs/${spec.body.id}/versions`, { effectiveFrom: todayIST(), changeNote: '[TEST] first', parameters: [
    { parameter: 'pH (5% solution)', category: 'CHEMICAL', limitType: 'RANGE', minValue: 6.0, maxValue: 7.5, methodId: ph },
    { parameter: 'Zinc (Zn)', category: 'CHEMICAL', unit: '%', limitType: 'MIN', minValue: 33, methodId: aas },
    { parameter: 'Appearance', category: 'PHYSICAL', limitType: 'TEXT', expectedText: 'White crystalline powder' },
  ] }).expect(201);
  const sub = await manager.post(`/api/v1/qc/master/specs/${spec.body.id}/versions/${v.body.id}/submit`).expect(200);
  const reqId = (await db.query(`select id from wf.approval_requests where doc_no = $1`, [sub.body.approvalDocNo])).rows[0].id;
  await approve(manager, reqId).expect(403);                        // the author cannot approve
  await approve(head, reqId).expect(200);
  await approve(qa, reqId).expect(200);
  const params = (await manager.get(`/api/v1/qc/master/specs/${spec.body.id}`).expect(200)).body.versions[0].parameters as { id: string; parameter: string }[];
  const inspection = async () => {
    const lot = await stockLot(item, wh, 1000, { status: 'Quarantine' });
    const ins = (await db.query(`insert into qc.inspections (doc_no, lot_id, item_id, source_type, source_id) values ($1,$2,$3,'OPENING',$4) returning id`, [uniq('QCI-T-'), lot, item, randomUUID()])).rows[0].id as string;
    await analyst.post(`/api/v1/qc/inspections/${ins}/sample`, { sampleQty: 0.5 }).expect(200);
    return { lot, ins };
  };
  const results = (phValue: string) => ({ coaReceived: true, recommendation: 'Release', results: [
    { specParameterId: params[0]!.id, value: phValue, instrumentId: phMeter }, { specParameterId: params[1]!.id, value: '33.4%', instrumentId: aasUnit },
    { specParameterId: params[2]!.id, value: 'white crystalline powder' }] });
  return { manager, head, analyst, qa, aasUnit, params, inspection, results };
}

describe('QC specifications, instruments, OOS and CoA (QC-004…008, QC-013, TC-12)', () => {
  it('locks an uncalibrated instrument, opens an OOS on pH 8.1, needs an authorised retest, keeps the original, then releases and issues a verifiable CoA', async () => {
    const L = await lab();
    const { ins } = await L.inspection();
    // free-text results are refused once a specification is in force
    await L.analyst.post(`/api/v1/qc/inspections/${ins}/results`, { results: [{ parameter: 'x', specification: 'y', result: 'z', pass: true }], coaReceived: true, recommendation: 'Release' }).expect(422);
    expect((await L.analyst.post(`/api/v1/qc/inspections/${ins}/spec-results`, L.results('8.1')).expect(422)).body.error.code).toBe('INSTRUMENT_OVERDUE');   // QC-008
    await L.manager.post(`/api/v1/qc/master/instruments/${L.aasUnit}/calibrations`, { calibratedOn: inDays(-1), result: 'Pass' }).expect(201);
    expect((await L.analyst.get('/api/v1/qc/master/instruments?usable=1').expect(200)).body.data.some((i: { id: string }) => i.id === L.aasUnit)).toBe(true);

    // TC-12: pH 8.1 against 6.0–7.5 → OOS opened, recommendation held, results frozen, release refused
    const r1 = await L.analyst.post(`/api/v1/qc/inspections/${ins}/spec-results`, L.results('8.1')).expect(200);
    expect(r1.body).toMatchObject({ passed: false, recommendation: 'Hold', oosNo: expect.stringMatching(/^OOS\//) });
    expect((await L.analyst.post(`/api/v1/qc/inspections/${ins}/spec-results`, L.results('7.0')).expect(422)).body.error.code).toBe('RESULTS_FROZEN');
    expect((await L.manager.post(`/api/v1/qc/inspections/${ins}/decide`, { decision: 'Release' }).expect(422)).body.error.code).toBe('OOS_OPEN');
    const oosId = (await db.query(`select id from qc.oos_cases where inspection_id = $1`, [ins])).rows[0].id;
    const retest = { results: [{ specParameterId: L.params[0]!.id, value: '7.1', instrumentId: (await db.query(`select instrument_id from qc.inspection_results where inspection_id = $1 and seq = 1`, [ins])).rows[0].instrument_id }] };
    expect((await L.analyst.post(`/api/v1/qc/oos/${oosId}/retest`, retest).expect(422)).body.error.code).toBe('RETEST_NOT_AUTHORISED');
    await L.analyst.post(`/api/v1/qc/oos/${oosId}/investigate`, { phase1Findings: 'x', authoriseRetest: true }).expect(403);
    await L.manager.post(`/api/v1/qc/oos/${oosId}/investigate`, { phase1Findings: '[TEST] pH electrode buffer expired; recalibrated', authoriseRetest: true }).expect(200);
    expect((await L.analyst.post(`/api/v1/qc/oos/${oosId}/retest`, retest).expect(201)).body.allPass).toBe(true);
    await L.manager.post(`/api/v1/qc/oos/${oosId}/close`, { conclusion: 'Invalidated', rootCause: '[TEST] laboratory error: expired buffer' }).expect(200);
    // the original result is kept beside the retest
    const rows = (await db.query(`select result, pass, attempt from qc.inspection_results where inspection_id = $1 and seq = 1 order by attempt`, [ins])).rows;
    expect(rows).toEqual([{ result: '8.1', pass: false, attempt: 1 }, { result: '7.1', pass: true, attempt: 2 }]);
    await L.manager.post(`/api/v1/qc/inspections/${ins}/decide`, { decision: 'Release' }).expect(200);

    // CoA: the analyst cannot sign as approver; the manager issues it; its QR verifies publicly
    await L.analyst.post(`/api/v1/qc/inspections/${ins}/coa`).expect(403);
    const coa = await L.manager.post(`/api/v1/qc/inspections/${ins}/coa`).expect(201);
    const c = (await L.manager.get(`/api/v1/qc/inspections/${ins}/coa`).expect(200)).body;
    expect(c.content.results.find((x: { seq: number }) => x.seq === 1).result).toBe('7.1');
    expect(c.content.conclusion).toBe('Complies with the specification');
    expect(c.qrSvg).toContain('<svg');
    const u = new URL(c.url);
    const pub = await request(app).get(`/api/v1/public/coa/${encodeURIComponent(coa.body.docNo)}${u.search}`).expect(200);
    expect(pub.body).toMatchObject({ genuine: true, docNo: coa.body.docNo, current: true });
    expect((await request(app).get(`/api/v1/public/coa/${encodeURIComponent(coa.body.docNo)}?v=1&s=forged`).expect(200)).body).toEqual({ genuine: false });
  });

  it('a confirmed OOS can only be rejected; a failed calibration takes the instrument out of service', async () => {
    const L = await lab();
    await L.manager.post(`/api/v1/qc/master/instruments/${L.aasUnit}/calibrations`, { calibratedOn: todayIST(), result: 'Pass' }).expect(201);
    const { ins } = await L.inspection();
    await L.analyst.post(`/api/v1/qc/inspections/${ins}/spec-results`, L.results('8.5')).expect(200);
    const oosId = (await db.query(`select id from qc.oos_cases where inspection_id = $1`, [ins])).rows[0].id;
    expect((await L.manager.post(`/api/v1/qc/oos/${oosId}/close`, { conclusion: 'Invalidated', rootCause: 'x' }).expect(422)).body.error.code).toBe('RETEST_NOT_PASSED');
    await L.manager.post(`/api/v1/qc/oos/${oosId}/close`, { conclusion: 'Confirmed', rootCause: '[TEST] the material is alkaline' }).expect(200);
    expect((await L.manager.post(`/api/v1/qc/inspections/${ins}/decide`, { decision: 'Release' }).expect(422)).body.error.code).toBe('OOS_CONFIRMED');
    await L.manager.post(`/api/v1/qc/inspections/${ins}/decide`, { decision: 'Reject', remarks: '[TEST] OOS confirmed' }).expect(200);
    await L.manager.post(`/api/v1/qc/master/instruments/${L.aasUnit}/calibrations`, { calibratedOn: todayIST(), result: 'Fail', remarks: '[TEST] lamp drift' }).expect(201);
    const i = (await L.manager.get(`/api/v1/qc/master/instruments/${L.aasUnit}`).expect(200)).body;
    expect([i.status, i.state, i.calibrations.length]).toEqual(['OutOfService', 'OutOfService', 2]);
  });
});
