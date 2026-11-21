import { describe, expect, it } from 'vitest';
import { db, uniq, userAgent } from './helpers';
import { approvedOrder, prodSetup, stockLot } from './production-fixtures';
import { approve, inDays, PDF } from './purchase-fixtures';
import { todayIST } from '../src/modules/sales/quotations';

const me = async (a: { get: (p: string) => { expect: (n: number) => Promise<{ body: { user: { id: string } } }> } }) => (await a.get('/api/v1/me').expect(200)).body.user.id;

describe('QA system: documents, training, audits, risks, line clearance, dashboard (QA-006, QA-010…012, QA-017, QA-018)', () => {
  it('approves a controlled document, tracks who must be trained, needs CAPA for major audit findings and scores risks', async () => {
    const [qam, qam2, qah, qae] = [await userAgent([{ code: 'QA_MANAGER' }]), await userAgent([{ code: 'QA_MANAGER' }]), await userAgent([{ code: 'QA_HEAD' }]), await userAgent([{ code: 'QA_EXECUTIVE' }])];
    const sup = await userAgent([{ code: 'PRODUCTION_SUPERVISOR' }]);
    const supId = await me(sup);
    const code = uniq('SOP-T-').slice(0, 30);
    const doc = await qam.post('/api/v1/qa/documents', { code, title: '[TEST] Batch dosing', docType: 'SOP', department: 'Production', ownerId: await me(qam), roles: ['PRODUCTION_SUPERVISOR'] }).expect(201);
    const v1 = await qam.post(`/api/v1/qa/documents/${doc.body.id}/versions`, { effectiveFrom: todayIST(), changeSummary: '[TEST] first issue' }).expect(201);
    expect((await qam.post(`/api/v1/qa/documents/${doc.body.id}/versions/${v1.body.id}/submit`).expect(422)).body.error.code).toBe('FILE_REQUIRED');
    const file = (await qam.upload(`/api/v1/documents?documentType=CONTROLLED_DOCUMENT&entityType=qa.controlled_document&entityId=${doc.body.id}&title=SOP&fileName=sop.pdf`, PDF, 'application/pdf').expect(201)).body.id;
    await db.query(`update qa.document_versions set file_id = $2 where id = $1`, [v1.body.id, file]);
    const sub = await qam.post(`/api/v1/qa/documents/${doc.body.id}/versions/${v1.body.id}/submit`).expect(200);
    const rid = (await db.query(`select id from wf.approval_requests where doc_no = $1`, [sub.body.approvalDocNo])).rows[0].id;
    await approve(qam, rid).expect(403);
    await approve(qam2, rid).expect(200);
    await approve(qah, rid).expect(200);
    const d = (await qae.get(`/api/v1/qa/documents/${doc.body.id}`).expect(200)).body;
    expect(d.versions[0]).toMatchObject({ status: 'Effective' });
    expect(d.reviewDue.slice(0, 4)).toBe(String(Number(todayIST().slice(0, 4)) + 2));          // biennial review (QA-018)
    // training: the supervisor must be trained on the effective version
    const gap = (await qae.get(`/api/v1/qa/training/matrix?userId=${supId}`).expect(200)).body;
    expect(gap.data.find((x: { code: string }) => x.code === code)).toMatchObject({ trainedOn: null });
    await sup.post('/api/v1/qa/training', { documentVersionId: v1.body.id, userIds: [supId], trainedOn: todayIST(), trainer: 'x', assessment: 'Pass' }).expect(403);
    await qae.post('/api/v1/qa/training', { documentVersionId: v1.body.id, userIds: [supId], trainedOn: todayIST(), trainer: '[TEST] QA', assessment: 'Pass', score: 90 }).expect(201);
    expect((await qae.get(`/api/v1/qa/training/matrix?userId=${supId}`).expect(200)).body.data.find((x: { code: string }) => x.code === code).trainedOn).not.toBeNull();

    // audits: a supplier audit needs the supplier; a major finding needs a CAPA before closing
    await qam.post('/api/v1/qa/audits', { auditType: 'SUPPLIER', title: 'x', scope: 'x', auditor: 'x', plannedDate: inDays(5) }).expect(400);
    const au = await qam.post('/api/v1/qa/audits', { auditType: 'INTERNAL', title: '[TEST] RM store', scope: 'Storage and FEFO', auditor: '[TEST] QA head', plannedDate: todayIST() }).expect(201);
    await qam.post(`/api/v1/qa/audits/${au.body.id}/findings`, { classification: 'MAJOR', clause: '7.5', description: '[TEST] humidity not logged' }).expect(201);
    expect((await qam.post(`/api/v1/qa/audits/${au.body.id}/close`, { summary: 'x' }).expect(422)).body.error.code).toBe('CAPA_REQUIRED');
    const capa = await qam.post('/api/v1/qa/capas', { title: '[TEST] humidity log', sourceType: 'AUDIT', sourceId: au.body.id, sourceRef: au.body.docNo, problem: 'p', ownerId: await me(qae), dueDate: inDays(10),
      actions: [{ kind: 'CORRECTIVE', description: 'Install logger', ownerId: await me(qae), dueDate: inDays(10) }] }).expect(201);
    const fid = (await qam.get(`/api/v1/qa/audits/${au.body.id}`).expect(200)).body.findingList[0].id;
    await qam.post(`/api/v1/qa/audits/${au.body.id}/findings/${fid}/capa`, { capaId: capa.body.id }).expect(200);
    await qam.post(`/api/v1/qa/audits/${au.body.id}/close`, { summary: '[TEST] one major finding, CAPA raised' }).expect(200);

    // risk register: RPN = S × O × D; the dashboard counts open risks of 100 or more
    const risk = await qam.post('/api/v1/qa/risks', { title: '[TEST] caking', processArea: 'RM storage', failureMode: 'Moisture pickup', effect: 'Dosing error', severity: 5, occurrence: 4, detection: 6,
      ownerId: await me(qam), reviewDate: inDays(90) }).expect(201);
    expect(risk.body.rpn).toBe(120);
    const dash = (await qam.get('/api/v1/qa/dashboard').expect(200)).body;
    expect(dash.qa.highRisks).toBeGreaterThanOrEqual(1);
    expect(dash.qc).toHaveProperty('instrumentsOverdue');
  });

  it('needs a QA line clearance before a batch starts on a line (QA-017)', async () => {
    await db.query(`update sys.settings set value = 'true' where key = 'mfg.lineClearance.required'`);
    try {
      const f = await prodSetup();
      const qae = await userAgent([{ code: 'QA_EXECUTIVE' }]);
      await stockLot(f.zn, f.rmWh, 450); await stockLot(f.edta, f.rmWh, 600);
      const id = await approvedOrder(f, 1000);
      await f.planner.post(`/api/v1/production-orders/${id}/release`, {}).expect(200);
      const o = (await f.keeper.get(`/api/v1/production-orders/${id}`).expect(200)).body;
      await f.keeper.post(`/api/v1/production-orders/${id}/issue`, { lines: o.reservations.map((r: { id: string; qty: string }) => ({ reservationId: r.id, qty: Number(r.qty) })) }).expect(201);
      expect((await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['A'] }).expect(422)).body.error.code).toBe('LINE_NOT_CLEARED');
      const ok = { previousMaterialRemoved: true, lineCleaned: true, labelsReconciled: true, documentsInPlace: true, equipmentReady: true };
      await f.supervisor.post('/api/v1/qa/line-clearances', { lineId: f.line, purpose: 'BATCH', checklist: ok }).expect(403);
      expect((await qae.post('/api/v1/qa/line-clearances', { lineId: f.line, purpose: 'BATCH', checklist: { ...ok, lineCleaned: false } }).expect(422)).body.error.code).toBe('REASON_REQUIRED');
      expect((await qae.post('/api/v1/qa/line-clearances', { lineId: f.line, purpose: 'BATCH', checklist: { ...ok, lineCleaned: false }, remarks: '[TEST] residue in reactor' }).expect(201)).body.outcome).toBe('NotCleared');
      await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['A'] }).expect(422);      // a "not cleared" record does not count
      await qae.post('/api/v1/qa/line-clearances', { lineId: f.line, purpose: 'BATCH', checklist: ok }).expect(201);
      const b = await f.supervisor.post('/api/v1/batches', { productionOrderId: id, operators: ['A'] }).expect(201);
      const used = (await qae.get(`/api/v1/qa/line-clearances?lineId=${f.line}`).expect(200)).body.data.find((c: { outcome: string }) => c.outcome === 'Cleared');
      expect(used.usedByBatch).toBe(b.body.batchNo);
    } finally {
      await db.query(`update sys.settings set value = 'false' where key = 'mfg.lineClearance.required'`);
    }
  });
});
