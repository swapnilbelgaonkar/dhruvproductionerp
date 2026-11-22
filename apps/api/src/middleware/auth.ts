import type { NextFunction, Request, Response } from 'express';
import type { Scope } from '@dhruv/contracts';
import type { Db } from '../db/pool';
import { Errors } from '../lib/errors';
import { safeEqual, sha256 } from '../lib/crypto';
import { getSetting } from '../lib/settings';
import { can } from './context';

export const SESSION_COOKIE = 'dsid';
export const CSRF_COOKIE = 'dcsrf';

/** Routes a partially-authenticated session may still use (MFA / password-change gates). */
const GATE_ALLOW = ['/api/v1/me', '/api/v1/auth/logout', '/api/v1/auth/mfa/verify', '/api/v1/auth/mfa/enrol', '/api/v1/auth/mfa/enrol/confirm', '/api/v1/auth/password/change'];

export function loadSession(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (!token) return next();
      const id = sha256(token);
      const s = await db.query(
        `select s.id, s.csrf_token, s.mfa_satisfied, s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
                u.id as user_id, u.email, u.full_name, u.status, u.must_change_password, u.mfa_enabled, u.employee_id
           from iam.sessions s join iam.users u on u.id = s.user_id where s.id = $1`, [id]);
      const row = s.rows[0];
      if (!row || row.revoked_at || new Date(row.idle_expires_at) < new Date() || new Date(row.absolute_expires_at) < new Date() || row.status !== 'Active') {
        return next();
      }
      const idleMinutes = await getSetting<number>(db, 'auth.session.idleMinutes', 30);
      await db.query(`update iam.sessions set last_seen_at = now(), idle_expires_at = least(absolute_expires_at, now() + make_interval(mins => $2)) where id = $1`, [id, idleMinutes]);

      const g = await db.query<{ code: string; name: string; requires_mfa: boolean; scope: Scope; permission_code: string | null }>(
        `select r.code, r.name, r.requires_mfa, ur.scope, rp.permission_code
           from iam.user_roles ur join iam.roles r on r.id = ur.role_id
           left join iam.role_permissions rp on rp.role_id = r.id
          where ur.user_id = $1 and ur.status = 'Active'`, [row.user_id]);
      const grants = new Map<string, Scope[]>();
      const roles = new Map<string, string>();
      let mfaRequiredByRole = false;
      for (const r of g.rows) {
        roles.set(r.code, r.name);
        if (r.requires_mfa) mfaRequiredByRole = true;
        if (r.permission_code) grants.set(r.permission_code, [...(grants.get(r.permission_code) ?? []), r.scope]);
      }
      // pre-go-live switch: with two-factor off, nobody is asked to enrol or verify
      const mfaOn = (await getSetting<boolean>(db, 'auth.mfa.enforced', true)) !== false;
      req.auth = {
        sessionId: id, csrfToken: row.csrf_token, mfaSatisfied: mfaOn ? row.mfa_satisfied : true, mfaRequiredByRole: mfaOn && mfaRequiredByRole,
        user: { id: row.user_id, email: row.email, fullName: row.full_name, status: row.status, mustChangePassword: row.must_change_password, mfaEnabled: row.mfa_enabled, employeeId: row.employee_id },
        roles: [...roles].map(([code, name]) => ({ code, name })),
        grants,
      };
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** True when the session must finish MFA or change its password before using the system. */
export function pendingGate(req: Request): null | 'MFA_VERIFY' | 'MFA_ENROL' | 'PASSWORD_CHANGE' {
  const a = req.auth;
  if (!a) return null;
  if (a.user.mfaEnabled && !a.mfaSatisfied) return 'MFA_VERIFY';
  if (a.mfaRequiredByRole && !a.user.mfaEnabled) return 'MFA_ENROL';
  if (a.user.mustChangePassword) return 'PASSWORD_CHANGE';
  return null;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(Errors.authRequired());
  const gate = pendingGate(req);
  if (gate && !GATE_ALLOW.includes(req.baseUrl + req.path) && !GATE_ALLOW.includes(req.originalUrl.split('?')[0]!)) {
    return next(Errors.conflict(gate === 'MFA_VERIFY' ? 'MFA_REQUIRED' : gate, 'Complete sign-in before continuing.', { gate }));
  }
  // CSRF: double-submit token on every state-changing request
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const header = req.get('x-csrf-token') ?? '';
    if (!safeEqual(header, req.auth.csrfToken)) return next(Errors.forbidden('csrf'));
  }
  next();
}

export const requirePermission = (permission: string) => (req: Request, _res: Response, next: NextFunction) =>
  can(req, permission) ? next() : next(Errors.forbidden(permission));
