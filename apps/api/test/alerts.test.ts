import { describe, expect, it } from 'vitest';
import { scanAlerts } from '../src/modules/alerts/alerts';
import { todayIST } from '../src/modules/sales/quotations';
import { db, uniq, userAgent } from './helpers';
import { dispatched } from './dispatch-fixtures';

const notes = async (userId: string, like: string) => (await db.query(`select title from sys.notifications where user_id = $1 and title like $2 order by created_at`, [userId, like])).rows.map((x) => x.title as string);
const alertOf = async (rule: string, key: string) => (await db.query(`select * from sys.alerts where rule_code = $1 and subject_key = $2 order by raised_at desc limit 1`, [rule, key])).rows[0];
const inDays = (n: number) => { const d = new Date(`${todayIST()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

describe('Alerts and escalations (NOT-001…NOT-006, WF-008)', () => {
  it('raises, worsens, is acknowledged and resolves itself; routing follows the rule', async () => {
    const qcManager = await userAgent([{ code: 'QC_MANAGER' }]);
    const outsider = await userAgent([{ code: 'PURCHASE_EXEC' }]);
    const code = uniq('INS-').slice(0, 20);
    const ins = (await db.query(`insert into qc.instruments (code, name, technique, interval_days, last_calibrated, calibration_due, status) values ($1,'[TEST] pH meter','PH',180,$2,$3,'Active') returning id`,
      [code, inDays(-177), inDays(3)])).rows[0].id;

    const first = await scanAlerts(db);
    expect(first.failed).toEqual([]);                                  // every rule runs on the whole database
    let a = await alertOf('CALIBRATION_DUE', ins);
    expect(a).toMatchObject({ severity: 'warning', title: `Calibration due in 3 days — ${code}`, resolved_at: null });
    expect(await notes(qcManager.userId, `%${code}%`)).toEqual([`Calibration due in 3 days — ${code}`]);
    const mine = (await qcManager.get('/api/v1/alerts').expect(200)).body.data;
    expect(mine.find((x: { id: string }) => x.id === a.id)).toMatchObject({ ruleName: 'Instrument calibration due', area: 'QC' });
    expect((await outsider.get('/api/v1/alerts').expect(200)).body.data.find((x: { id: string }) => x.id === a.id)).toBeUndefined();
    await outsider.post(`/api/v1/alerts/${a.id}/acknowledge`, {}).expect(404);

    // a second scan does not repeat; overdue worsens it to critical and tells people again
    await scanAlerts(db);
    expect(await notes(qcManager.userId, `%${code}%`)).toHaveLength(1);
    await db.query(`update qc.instruments set calibration_due = $2 where id = $1`, [ins, inDays(-1)]);
    expect((await scanAlerts(db)).worsened).toBeGreaterThanOrEqual(1);
    a = await alertOf('CALIBRATION_DUE', ins);
    expect(a).toMatchObject({ severity: 'critical', title: `Calibration overdue — ${code}` });
    expect(await notes(qcManager.userId, `%${code}%`)).toEqual([`Calibration due in 3 days — ${code}`, `Calibration overdue — ${code}`]);

    // acknowledged alerts do not escalate; calibration resolves it
    await qcManager.post(`/api/v1/alerts/${a.id}/acknowledge`, { note: 'Agency booked for Monday' }).expect(200);
    await qcManager.post(`/api/v1/alerts/${a.id}/acknowledge`, {}).expect(422);
    await db.query(`update sys.alerts set raised_at = now() - interval '3 days' where id = $1`, [a.id]);
    await scanAlerts(db);
    expect((await alertOf('CALIBRATION_DUE', ins)).escalated_at).toBeNull();
    await db.query(`update qc.instruments set calibration_due = $2, last_calibrated = $3 where id = $1`, [ins, inDays(180), todayIST()]);
    await scanAlerts(db);
    expect((await alertOf('CALIBRATION_DUE', ins)).resolved_at).not.toBeNull();
  });

  it('escalates an overdue approval to the approver\'s manager, and lets the administrator tune the rules', async () => {
    const x = await dispatched();
    const il = (await x.accounts.get(`/api/v1/sales-invoices/${x.invoice.id}`).expect(200)).body.lines[0];
    const cn = await x.accounts.post('/api/v1/credit-notes', { invoiceId: x.invoice.id, reason: 'SHORTAGE', lines: [{ invoiceLineId: il.id, qty: 1 }] }).expect(201);
    const sub = await x.accounts.post(`/api/v1/credit-notes/${cn.body.id}/submit`).expect(200);
    // the finance head reports to a manager who has a login
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const boss = (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: '[TEST] Director', managerId: null }).expect(201)).body.id;
    const fhEmp = (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: '[TEST] Finance head', managerId: boss }).expect(201)).body.id;
    const bossUser = await userAgent([{ code: 'MANAGEMENT_VIEWER' }], { employeeId: boss });
    await db.query(`update iam.users set employee_id = $2 where id = $1`, [x.fh.userId, fhEmp]);
    const step = (await db.query(`select id from wf.approval_steps where request_id = $1 and status = 'Pending'`, [sub.body.approvalRequestId])).rows[0].id;
    await db.query(`update wf.approval_steps set due_at = now() - interval '30 hours' where id = $1`, [step]);

    await scanAlerts(db);
    let a = await alertOf('APPROVAL_OVERDUE', step);
    expect(a.severity).toBe('critical');
    expect(a.notified_user_ids).toContain(x.fh.userId);
    await db.query(`update sys.alerts set raised_at = now() - interval '25 hours' where id = $1`, [a.id]);
    expect((await scanAlerts(db)).escalated).toBeGreaterThanOrEqual(1);
    a = await alertOf('APPROVAL_OVERDUE', step);
    expect(a.escalated_user_ids).toContain(bossUser.userId);
    expect((await notes(bossUser.userId, 'Escalated: %'))[0]).toMatch(/^Escalated: Approval overdue — APR\//);
    expect((await bossUser.get('/api/v1/alerts').expect(200)).body.data.map((y: { id: string }) => y.id)).toContain(a.id);
    // deciding the approval clears it
    await x.fh.post(`/api/v1/approvals/${sub.body.approvalRequestId}/decisions`, { decision: 'Approve' }).expect(200);
    await scanAlerts(db);
    expect((await alertOf('APPROVAL_OVERDUE', step)).resolved_at).not.toBeNull();

    // the receivable rule names the invoice; rule settings are for the administrator only
    await db.query(`update sales.invoices set invoice_date = $2, due_date = $3 where id = $1`, [x.invoice.id, inDays(-40), inDays(-10)]);
    await scanAlerts(db);
    expect((await alertOf('RECEIVABLE_DUE', x.invoice.id))).toMatchObject({ severity: 'critical', title: `Payment overdue 10 days — ${x.invoice.docNo}` });
    expect(await alertOf('DEALER_FROZEN', x.party)).toMatchObject({ severity: 'critical' });
    const admin = await userAgent([{ code: 'EXEC_ADMIN' }]);
    await x.accounts.get('/api/v1/alerts/rules').expect(403);
    const rules = (await admin.get('/api/v1/alerts/rules').expect(200)).body.data;
    expect(rules).toHaveLength(10);
    const rule = { enabled: false, params: {}, recipientRoles: ['ACCOUNTS_EXEC'], escalateAfterHours: 72, escalateRoles: ['FINANCE_HEAD'], escalateToManager: false };
    expect((await admin.put('/api/v1/alerts/rules/RECEIVABLE_DUE', { ...rule, recipientRoles: ['NOPE'] }).expect(422)).body.error.code).toBe('UNKNOWN_ROLE');
    expect((await admin.put('/api/v1/alerts/rules/RECEIVABLE_DUE', { ...rule, params: { foo: 1 } }).expect(422)).body.error.code).toBe('UNKNOWN_PARAMETER');
    await admin.put('/api/v1/alerts/rules/RECEIVABLE_DUE', rule).expect(200);
    await admin.post('/api/v1/alerts/run').expect(200);
    expect((await alertOf('RECEIVABLE_DUE', x.invoice.id)).resolved_at).not.toBeNull();   // switching a rule off clears its alerts
    await admin.put('/api/v1/alerts/rules/RECEIVABLE_DUE', { ...rule, enabled: true, params: { daysBefore: 5 } }).expect(200);
    expect((await admin.get('/api/v1/alerts?scope=all').expect(200)).body.canConfigure).toBe(true);
  });
});
