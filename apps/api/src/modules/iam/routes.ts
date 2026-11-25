import { Router } from 'express';
import { hash } from '@node-rs/argon2';
import { createUserSchema, grantRoleSchema, reasonSchema, updateUserSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, diff } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { pendingGate, requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { registerSubjectHandler, submitForApproval, type ApprovalRequestRow } from '../workflow/engine';

async function setGrantStatus(tx: Tx, id: string, status: 'Active' | 'Rejected', actor: Actor) {
  await allowTransition(tx);
  const g = (await tx.query(
    `update iam.user_roles set status = $2, granted_by = case when $2 = 'Active' then $3::uuid end, granted_at = case when $2 = 'Active' then now() end
      where id = $1 and status = 'PendingApproval' returning *`, [id, status, actor.userId])).rows[0];
  if (g) await audit(tx, actor, { action: status === 'Active' ? 'iam.role_granted' : 'iam.role_grant_rejected', entityType: 'iam.user', entityId: g.user_id, after: { roleGrantId: id } });
}

export function meRoutes() {
  const r = Router();
  r.get('/', (req, res) => {
    const a = req.auth!;
    res.json({
      user: a.user, roles: a.roles, permissions: [...a.grants.keys()].sort(), gate: pendingGate(req),
      mfaRequiredByRole: a.mfaRequiredByRole, csrfToken: a.csrfToken,
    });
  });
  return r;
}

export function userRoutes(db: Db) {
  registerSubjectHandler('iam.role_grant', {
    onApproved: (tx, r: ApprovalRequestRow, a) => setGrantStatus(tx, r.subject_id, 'Active', a),
    onRejected: (tx, r, a) => setGrantStatus(tx, r.subject_id, 'Rejected', a),
    onReturned: (tx, r, a) => setGrantStatus(tx, r.subject_id, 'Rejected', a),
    onCancelled: (tx, r, a) => setGrantStatus(tx, r.subject_id, 'Rejected', a),
  });

  const r = Router();

  r.get('/', requirePermission('iam.user:view'), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where: string[] = [];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(u.email ilike $1 or u.full_name ilike $1)`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`u.status = $${args.length}`); }
    const rows = await db.query(
      `select u.id, u.email, u.full_name as "fullName", u.status, u.mfa_enabled as "mfaEnabled", u.last_login_at as "lastLoginAt",
              u.locked_until as "lockedUntil", e.emp_code as "empCode",
              coalesce((select json_agg(r.name order by r.name) from iam.user_roles ur join iam.roles r on r.id = ur.role_id where ur.user_id = u.id and ur.status = 'Active'), '[]') as roles,
              count(*) over() as total
         from iam.users u left join org.employees e on e.id = u.employee_id
         ${where.length ? 'where ' + where.join(' and ') : ''} order by u.full_name limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/:id', requirePermission('iam.user:view'), asyncHandler(async (req, res) => {
    const u = (await db.query(
      `select u.id, u.email, u.full_name as "fullName", u.status, u.mfa_enabled as "mfaEnabled", u.must_change_password as "mustChangePassword",
              u.last_login_at as "lastLoginAt", u.locked_until as "lockedUntil", u.failed_login_count as "failedLoginCount",
              u.employee_id as "employeeId", e.emp_code as "empCode", e.full_name as "employeeName", u.version, u.created_at as "createdAt"
         from iam.users u left join org.employees e on e.id = u.employee_id where u.id = $1`, [req.params.id])).rows[0];
    if (!u) throw Errors.notFound('User');
    const roles = (await db.query(
      `select ur.id, r.id as "roleId", r.code, r.name, r.privileged, ur.scope, ur.status, ur.reason, ur.granted_at as "grantedAt",
              g.full_name as "grantedBy", ur.created_at as "requestedAt",
              (select a.id from wf.approval_requests a where a.subject_type = 'iam.role_grant' and a.subject_id = ur.id order by a.submitted_at desc limit 1) as "approvalRequestId"
         from iam.user_roles ur join iam.roles r on r.id = ur.role_id left join iam.users g on g.id = ur.granted_by
        where ur.user_id = $1 order by ur.created_at desc`, [u.id])).rows;
    const sessions = can(req, 'iam.session:view')
      ? (await db.query(`select id, created_at as "createdAt", last_seen_at as "lastSeenAt", ip, user_agent as "userAgent" from iam.sessions
                          where user_id = $1 and revoked_at is null and idle_expires_at > now() order by last_seen_at desc`, [u.id])).rows.map((s) => ({ ...s, id: s.id.slice(0, 12) }))
      : [];
    const self = u.id === req.auth!.user.id;
    const actions: string[] = [];
    if (can(req, 'iam.user:edit')) actions.push('edit');
    if (can(req, 'iam.user:deactivate') && !self && u.status !== 'Deactivated') actions.push(u.status === 'Active' ? 'suspend' : 'reactivate', 'deactivate');
    if (can(req, 'iam.user_role:grant') && !self && u.status === 'Active') actions.push('grantRole');
    if (can(req, 'iam.user:edit') && !self && u.mfaEnabled) actions.push('resetMfa');
    if (can(req, 'iam.user:edit') && !self && u.lockedUntil) actions.push('unlock');
    if (can(req, 'iam.session:revoke') && !self) actions.push('revokeSessions');
    res.json({ ...u, roles, sessions, allowedActions: actions, canRevokeRoles: can(req, 'iam.user_role:revoke') && !self });
  }));

  r.post('/', requirePermission('iam.user:create'), asyncHandler(async (req, res) => {
    const d = parse(createUserSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const ins = await tx.query(
        `insert into iam.users (email, full_name, password_hash, must_change_password, employee_id, created_by, updated_by)
         values ($1,$2,$3,true,$4,$5,$5) returning id, email, full_name, employee_id`,
        [d.email, d.fullName, await hash(d.initialPassword), d.employeeId ?? null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'iam.user.created', entityType: 'iam.user', entityId: ins.rows[0].id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));

  r.put('/:id', requirePermission('iam.user:edit'), asyncHandler(async (req, res) => {
    const d = parse(updateUserSchema, req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select id, full_name, employee_id, version from iam.users where id = $1 for update`, [req.params.id])).rows[0];
      if (!before) throw Errors.notFound('User');
      if (before.version !== d.version) throw Errors.concurrent();
      const after = (await tx.query(`update iam.users set full_name = $2, employee_id = $3, updated_by = $4 where id = $1 returning id, full_name, employee_id, version`,
        [before.id, d.fullName, d.employeeId ?? null, req.auth!.user.id])).rows[0];
      const df = diff(before, after);
      await audit(tx, actorOf(req), { action: 'iam.user.updated', entityType: 'iam.user', entityId: before.id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));

  const statusChange = (action: string, from: string[], to: string) => asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    if (req.params.id === req.auth!.user.id) throw Errors.sod('You cannot change the status of your own account.');
    await withTx(db, async (tx) => {
      const u = (await tx.query(`select id, status from iam.users where id = $1 for update`, [req.params.id])).rows[0];
      if (!u) throw Errors.notFound('User');
      if (!from.includes(u.status)) throw Errors.state(`A ${u.status} user cannot be ${action}.`);
      await tx.query(`update iam.users set status = $2, updated_by = $3 where id = $1`, [u.id, to, req.auth!.user.id]);
      if (to !== 'Active') await tx.query(`update iam.sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [u.id]);
      if (to === 'Deactivated') {
        await allowTransition(tx);
        await tx.query(`update iam.user_roles set status = 'Revoked', revoked_at = now(), revoked_by = $2 where user_id = $1 and status in ('Active','PendingApproval')`, [u.id, req.auth!.user.id]);
      }
      await audit(tx, actorOf(req), { action: `iam.user.${action}`, entityType: 'iam.user', entityId: u.id, before: { status: u.status }, after: { status: to }, reason });
    });
    res.json({ ok: true });
  });
  r.post('/:id/suspend', requirePermission('iam.user:deactivate'), statusChange('suspended', ['Active'], 'Suspended'));
  r.post('/:id/reactivate', requirePermission('iam.user:deactivate'), statusChange('reactivated', ['Suspended'], 'Active'));
  r.post('/:id/deactivate', requirePermission('iam.user:deactivate'), statusChange('deactivated', ['Active', 'Suspended'], 'Deactivated'));

  r.post('/:id/reset-mfa', requirePermission('iam.user:edit'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    if (req.params.id === req.auth!.user.id) throw Errors.sod('Ask another administrator to reset your MFA.');
    await withTx(db, async (tx) => {
      const u = (await tx.query(`update iam.users set mfa_enabled = false, mfa_secret_enc = null where id = $1 returning id`, [req.params.id])).rows[0];
      await tx.query(`delete from iam.mfa_recovery_codes where user_id = $1`, [req.params.id]);
      if (!u) throw Errors.notFound('User');
      await tx.query(`update iam.sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [u.id]);
      await audit(tx, actorOf(req), { action: 'iam.user.mfa_reset', entityType: 'iam.user', entityId: u.id, reason });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/unlock', requirePermission('iam.user:edit'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const u = (await tx.query(`update iam.users set locked_until = null, failed_login_count = 0 where id = $1 returning id`, [req.params.id])).rows[0];
      if (!u) throw Errors.notFound('User');
      await audit(tx, actorOf(req), { action: 'iam.user.unlocked', entityType: 'iam.user', entityId: u.id, reason });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/revoke-sessions', requirePermission('iam.session:revoke'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const n = await tx.query(`update iam.sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [req.params.id]);
      await audit(tx, actorOf(req), { action: 'iam.user.sessions_revoked', entityType: 'iam.user', entityId: req.params.id, after: { count: n.rowCount }, reason });
    });
    res.json({ ok: true });
  }));

  // Role grants. Privileged roles need executive approval before they take effect (SEC-018, SOD-06).
  r.post('/:id/roles', requirePermission('iam.user_role:grant'), asyncHandler(async (req, res) => {
    const d = parse(grantRoleSchema, req.body);
    if (req.params.id === req.auth!.user.id) throw Errors.sod('You cannot grant roles to yourself.');
    const out = await withTx(db, async (tx) => {
      const u = (await tx.query(`select id, full_name, status from iam.users where id = $1`, [req.params.id])).rows[0];
      if (!u) throw Errors.notFound('User');
      if (u.status !== 'Active') throw Errors.state('Roles can be granted only to active users.');
      const role = (await tx.query(`select id, code, name, privileged from iam.roles where id = $1`, [d.roleId])).rows[0];
      if (!role) throw Errors.rule('REFERENCE_INVALID', 'Role does not exist.');
      await allowTransition(tx);
      const g = (await tx.query(
        `insert into iam.user_roles (user_id, role_id, scope, status, reason, created_by, granted_by, granted_at)
         values ($1,$2,$3,$4,$5,$6, case when $4 = 'Active' then $6::uuid end, case when $4 = 'Active' then now() end) returning id`,
        [u.id, role.id, JSON.stringify(d.scope), role.privileged ? 'PendingApproval' : 'Active', d.reason, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: role.privileged ? 'iam.role_grant_requested' : 'iam.role_granted', entityType: 'iam.user', entityId: u.id,
        after: { role: role.code, scope: d.scope }, reason: d.reason });
      if (!role.privileged) return { status: 'Active' };
      const a = await submitForApproval(tx, actorOf(req), {
        subjectType: 'iam.role_grant', subjectId: g.id, subjectLabel: `Grant ${role.name} to ${u.full_name}`, facts: { role: role.code },
      });
      return { status: 'PendingApproval', approvalRequestId: a.id, approvalDocNo: a.doc_no };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/roles/:grantId/revoke', requirePermission('iam.user_role:revoke'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    if (req.params.id === req.auth!.user.id) throw Errors.sod('You cannot revoke your own roles.');
    await withTx(db, async (tx) => {
      const g = (await tx.query(`select ur.id, ur.status, r.code from iam.user_roles ur join iam.roles r on r.id = ur.role_id where ur.id = $1 and ur.user_id = $2 for update of ur`,
        [req.params.grantId, req.params.id])).rows[0];
      if (!g) throw Errors.notFound('Role assignment');
      if (g.status !== 'Active') throw Errors.state('Only an active role can be revoked. Pending grants are decided in the approval inbox.');
      if (g.code === 'SUPER_ADMIN') {
        const left = await tx.query(`select count(*) as n from iam.user_roles ur join iam.roles r on r.id = ur.role_id join iam.users u on u.id = ur.user_id
                                      where r.code = 'SUPER_ADMIN' and ur.status = 'Active' and u.status = 'Active' and ur.id <> $1`, [g.id]);
        if (Number(left.rows[0].n) === 0) throw Errors.rule('LAST_SUPER_ADMIN', 'The last active Super Administrator cannot be removed.');
      }
      await allowTransition(tx);
      await tx.query(`update iam.user_roles set status = 'Revoked', revoked_at = now(), revoked_by = $2 where id = $1`, [g.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'iam.role_revoked', entityType: 'iam.user', entityId: req.params.id, after: { role: g.code }, reason });
    });
    res.json({ ok: true });
  }));

  return r;
}

export function roleRoutes(db: Db) {
  const r = Router();
  r.get('/', requirePermission('iam.role:view'), asyncHandler(async (_req, res) => {
    const roles = await db.query(
      `select r.id, r.code, r.name, r.description, r.department, r.privileged, r.requires_mfa as "requiresMfa",
              (select count(*) from iam.role_permissions rp where rp.role_id = r.id) as permissions,
              (select count(*) from iam.user_roles ur where ur.role_id = r.id and ur.status = 'Active') as users
         from iam.roles r order by r.department, r.name`);
    res.json({ data: roles.rows });
  }));
  r.get('/matrix', requirePermission('iam.role:view'), asyncHandler(async (_req, res) => {
    const perms = await db.query(`select code, module, resource, action, description from iam.permissions order by module, resource, action`);
    const grants = await db.query(`select r.code as role, rp.permission_code as permission from iam.role_permissions rp join iam.roles r on r.id = rp.role_id`);
    res.json({ permissions: perms.rows, grants: grants.rows });
  }));
  return r;
}
