import { authenticator } from 'otplib';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { seedBootstrapAdmin } from '../src/db/seed';
import { app, db, login, makeUser, PASSWORD, uniq, userAgent } from './helpers';

async function activeLegalEntity(maker: Awaited<ReturnType<typeof userAgent>>, checker: Awaited<ReturnType<typeof userAgent>>) {
  const code = uniq('LE');
  const { body } = await maker.post('/api/v1/legal-entities', { code, name: `[TEST] ${code}`, pan: 'AAAAA0000A', stateCode: '27' }).expect(201);
  const sub = await maker.post(`/api/v1/legal-entities/${body.id}/submit`).expect(200);
  await checker.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
  return body.id as string;
}

describe('Authentication & sessions (SEC-004…009)', () => {
  it('rejects bad credentials with a generic message and locks after repeated failures', async () => {
    const u = await makeUser();
    const res = await supertest(app).post('/api/v1/auth/login').send({ email: 'nobody@test.invalid', password: 'x' }).expect(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
    for (let i = 0; i < 5; i++) await supertest(app).post('/api/v1/auth/login').send({ email: u.email, password: 'wrong' }).expect(401);
    const locked = await supertest(app).post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(423);
    expect(locked.body.error.code).toBe('AUTH_LOCKED');
    const events = await db.query(`select action from sys.audit_events where entity_id = $1 order by seq`, [u.userId]);
    expect(events.rows.filter((e) => e.action === 'auth.login_failed')).toHaveLength(5);
  });

  it('bootstrap admin must enrol MFA and change password before using the system', async () => {
    const email = `${uniq('boot').toLowerCase()}@test.invalid`;
    const client = await db.connect();
    await client.query('begin'); await seedBootstrapAdmin(client, email, '[TEST] Bootstrap', PASSWORD); await client.query('commit'); client.release();

    const agent = supertest.agent(app);
    const { body } = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
    const csrf = body.csrfToken;
    const blocked = await agent.get('/api/v1/users').expect(409);
    expect(blocked.body.error.code).toBe('MFA_ENROL');
    const enrol = await agent.post('/api/v1/auth/mfa/enrol').set('x-csrf-token', csrf).expect(200);
    await agent.post('/api/v1/auth/mfa/enrol/confirm').set('x-csrf-token', csrf).send({ code: authenticator.generate(enrol.body.secret) }).expect(200);
    const gate2 = await agent.get('/api/v1/users').expect(409);
    expect(gate2.body.error.code).toBe('PASSWORD_CHANGE');
    await agent.post('/api/v1/auth/password/change').set('x-csrf-token', csrf).send({ currentPassword: PASSWORD, newPassword: 'Another-strong-pass-9' }).expect(200);
    await agent.get('/api/v1/users').expect(200);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    const u = await makeUser({ roles: [{ code: 'MASTER_DATA_OWNER' }] });
    const agent = supertest.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: u.email, password: PASSWORD }).expect(200);
    const res = await agent.post('/api/v1/departments').send({ code: uniq('D'), name: 'x' }).expect(403);
    expect(res.body.error.details.permission).toBe('csrf');
  });
});

describe('Permissions & scope (SEC-010/011, TC-01)', () => {
  it('denies an action without permission', async () => {
    const viewer = await userAgent([{ code: 'AUDITOR' }]);
    const res = await viewer.post('/api/v1/departments', { code: uniq('D'), name: '[TEST]' }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('hides records outside the user’s legal-entity scope', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const mda = await userAgent([{ code: 'MASTER_DATA_APPROVER' }]);
    const leA = await activeLegalEntity(mdo, mda);
    const leB = await activeLegalEntity(mdo, mda);
    const pB = await mdo.post('/api/v1/plants', { legalEntityId: leB, code: uniq('P'), name: '[TEST] plant B' }).expect(201);
    const scoped = await userAgent([{ code: 'SALES_ASM', scope: { legalEntityIds: [leA], plantIds: [], warehouseIds: [], territoryIds: [] } }]);
    await scoped.get(`/api/v1/plants/${pB.body.id}`).expect(404);
    const list = await scoped.get('/api/v1/plants?limit=100').expect(200);
    expect(list.body.data.every((p: { legalEntityId: string }) => p.legalEntityId === leA)).toBe(true);
  });
});

describe('Master lifecycle with maker-checker (MDM-002, MDM-005, APR-007)', () => {
  it('activates a legal entity only after an independent approval', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const mda = await userAgent([{ code: 'MASTER_DATA_APPROVER' }]);
    const code = uniq('LE');
    const { body } = await mdo.post('/api/v1/legal-entities', { code, name: `[TEST] ${code}`, stateCode: '27' }).expect(201);
    const noPan = await mdo.post(`/api/v1/legal-entities/${body.id}/submit`).expect(422);
    expect(noPan.body.error.code).toBe('FIELD_REQUIRED');
    const le = await mdo.get(`/api/v1/legal-entities/${body.id}`).expect(200);
    await mdo.put(`/api/v1/legal-entities/${body.id}`, { code, name: `[TEST] ${code}`, pan: 'AAAAA0000A', stateCode: '27', version: le.body.version }).expect(200);
    const sub = await mdo.post(`/api/v1/legal-entities/${body.id}/submit`).expect(200);
    expect(sub.body.approvalDocNo).toMatch(/^APR\/\d{4}-\d{2}\/\d{6}$/);

    // maker cannot decide; the approver's inbox shows it
    const own = await mdo.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(403);
    expect(own.body.error.code).toBe('SOD_VIOLATION');
    const inbox = await mda.get('/api/v1/approvals?view=inbox').expect(200);
    expect(inbox.body.data.some((a: { id: string }) => a.id === sub.body.approvalRequestId)).toBe(true);
    const detail = await mda.get(`/api/v1/approvals/${sub.body.approvalRequestId}`).expect(200);
    expect(detail.body.allowedDecisions).toEqual(expect.arrayContaining(['Approve', 'Reject', 'Return', 'Hold']));

    await mda.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
    const active = await mdo.get(`/api/v1/legal-entities/${body.id}`).expect(200);
    expect(active.body.status).toBe('Active');
    expect(active.body.allowedActions).toContain('deactivate');
    // an active master is no longer editable
    await mdo.put(`/api/v1/legal-entities/${body.id}`, { code, name: 'changed', version: active.body.version }).expect(422);
  });

  it('rejection requires remarks and returns the record for correction', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const mda = await userAgent([{ code: 'MASTER_DATA_APPROVER' }]);
    const code = uniq('LE');
    const { body } = await mdo.post('/api/v1/legal-entities', { code, name: `[TEST] ${code}`, pan: 'AAAAA0000A' }).expect(201);
    const sub = await mdo.post(`/api/v1/legal-entities/${body.id}/submit`).expect(200);
    await mda.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Reject' }).expect(400);
    await mda.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Reject', remarks: 'CIN missing' }).expect(200);
    const le = await mdo.get(`/api/v1/legal-entities/${body.id}`).expect(200);
    expect(le.body.status).toBe('Rejected');
    expect(le.body.allowedActions).toEqual(expect.arrayContaining(['edit', 'submit']));
  });

  it('blocks status changes that bypass the workflow, even in SQL', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const { body } = await mdo.post('/api/v1/legal-entities', { code: uniq('LE'), name: '[TEST] bypass' }).expect(201);
    await expect(db.query(`update org.legal_entities set status = 'Active' where id = $1`, [body.id])).rejects.toThrow(/STATUS_CHANGE_FORBIDDEN/);
  });

  it('does not let an inactive legal entity be used by a plant', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const le = await mdo.post('/api/v1/legal-entities', { code: uniq('LE'), name: '[TEST] draft LE', pan: 'AAAAA0000A' }).expect(201);
    const p = await mdo.post('/api/v1/plants', { legalEntityId: le.body.id, code: uniq('P'), name: '[TEST] plant' }).expect(201);
    const res = await mdo.post(`/api/v1/plants/${p.body.id}/submit`).expect(422);
    expect(res.body.error.code).toBe('REFERENCE_NOT_ACTIVE');
  });

  it('rejects a stale update (optimistic locking)', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const code = uniq('LE');
    const { body } = await mdo.post('/api/v1/legal-entities', { code, name: '[TEST] v1' }).expect(201);
    await mdo.put(`/api/v1/legal-entities/${body.id}`, { code, name: '[TEST] v2', version: 1 }).expect(200);
    const stale = await mdo.put(`/api/v1/legal-entities/${body.id}`, { code, name: '[TEST] v3', version: 1 }).expect(409);
    expect(stale.body.error.code).toBe('CONCURRENT_MODIFICATION');
  });

  it('validates GSTIN check digit and PAN match', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const le = await mdo.post('/api/v1/legal-entities', { code: uniq('LE'), name: '[TEST] gst', pan: 'AAAAA0000A' }).expect(201);
    const bad = await mdo.post(`/api/v1/legal-entities/${le.body.id}/gst-registrations`, { gstin: '27AAAAA0000A1Z0' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const { gstinCheckDigit } = await import('@dhruv/contracts');
    const other = '27BBBBB1111B1Z';
    const mismatch = await mdo.post(`/api/v1/legal-entities/${le.body.id}/gst-registrations`, { gstin: other + gstinCheckDigit(other) }).expect(422);
    expect(mismatch.body.error.code).toBe('GSTIN_PAN_MISMATCH');
    const ok = '27AAAAA0000A1Z';
    await mdo.post(`/api/v1/legal-entities/${le.body.id}/gst-registrations`, { gstin: ok + gstinCheckDigit(ok) }).expect(201);
  });
});

describe('Privileged role grants (SEC-018, SOD-06)', () => {
  it('a privileged role takes effect only after executive approval', async () => {
    const secAdmin = await userAgent([{ code: 'SECURITY_ADMIN' }]);
    const exec = await userAgent([{ code: 'EXEC_ADMIN' }]);
    const target = await makeUser();
    const role = (await db.query(`select id from iam.roles where code = 'SECURITY_ADMIN'`)).rows[0].id;
    await secAdmin.post(`/api/v1/users/${secAdmin.userId}/roles`, { roleId: role, scope: { all: true }, reason: 'self' }).expect(403);
    const g = await secAdmin.post(`/api/v1/users/${target.userId}/roles`, { roleId: role, scope: { all: true }, reason: 'Backup security admin' }).expect(201);
    expect(g.body.status).toBe('PendingApproval');
    let roles = (await db.query(`select status from iam.user_roles where user_id = $1`, [target.userId])).rows;
    expect(roles[0].status).toBe('PendingApproval');
    await exec.post(`/api/v1/approvals/${g.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
    roles = (await db.query(`select status from iam.user_roles where user_id = $1`, [target.userId])).rows;
    expect(roles[0].status).toBe('Active');
  });

  it('a non-privileged role is granted immediately', async () => {
    const secAdmin = await userAgent([{ code: 'SECURITY_ADMIN' }]);
    const target = await makeUser();
    const role = (await db.query(`select id from iam.roles where code = 'QC_ANALYST'`)).rows[0].id;
    const g = await secAdmin.post(`/api/v1/users/${target.userId}/roles`, { roleId: role, scope: { all: true }, reason: 'Lab joiner' }).expect(201);
    expect(g.body.status).toBe('Active');
  });
});

describe('Audit trail (SEC-013)', () => {
  it('is append-only and its hash chain verifies', async () => {
    const auditor = await userAgent([{ code: 'AUDITOR' }]);
    const v = await auditor.post('/api/v1/audit/verify').expect(200);
    expect(v.body.intact).toBe(true);
    expect(v.body.checked).toBeGreaterThan(10);
    await expect(db.query(`update sys.audit_events set action = 'x' where seq = 1`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(db.query(`delete from sys.audit_events where seq = 1`)).rejects.toThrow(/APPEND_ONLY/);
  });
});

describe('Employees & hierarchy', () => {
  it('rejects a reporting loop', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const a = await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: '[TEST] A', salesTier: 'ZSM' }).expect(201);
    const b = await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: '[TEST] B', salesTier: 'RSM', managerId: a.body.id }).expect(201);
    const aRow = await mdo.get(`/api/v1/employees/${a.body.id}`).expect(200);
    const res = await mdo.put(`/api/v1/employees/${a.body.id}`, { empCode: aRow.body.empCode, fullName: '[TEST] A', salesTier: 'ZSM', managerId: b.body.id, version: aRow.body.version }).expect(422);
    expect(res.body.error.code).toBe('MANAGER_CYCLE');
  });
});
