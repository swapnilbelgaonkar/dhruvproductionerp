import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { changePasswordSchema, loginSchema, totpSchema } from '@dhruv/contracts';
import type { Config } from '../../config';
import { withTx, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto';
import { AppError, Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { getSetting } from '../../lib/settings';
import { CSRF_COOKIE, pendingGate, requireAuth, SESSION_COOKIE } from '../../middleware/auth';
import { actorOf } from '../../middleware/context';

authenticator.options = { window: 1 };

// Unknown emails are verified against a real dummy hash so they take as long as wrong passwords (no user enumeration).
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hash(randomToken()));

export function authRoutes(db: Db, cfg: Config) {
  const r = Router();
  const cookieOpts = { httpOnly: true, secure: cfg.isProd, sameSite: 'lax' as const, path: '/' };
  const limiter = rateLimit({ windowMs: 60_000, limit: cfg.NODE_ENV === 'test' ? 1000 : 10, standardHeaders: true, legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a minute.' } }) });

  r.post('/login', limiter, asyncHandler(async (req, res) => {
    const { email, password } = parse(loginSchema, req.body);
    const maxAttempts = await getSetting<number>(db, 'auth.lockout.maxAttempts', 5);
    const lockMinutes = await getSetting<number>(db, 'auth.lockout.minutes', 15);
    const idleMinutes = await getSetting<number>(db, 'auth.session.idleMinutes', 30);
    const absoluteHours = await getSetting<number>(db, 'auth.session.absoluteHours', 12);

    const u = (await db.query(`select * from iam.users where email = $1`, [email.toLowerCase()])).rows[0];
    const ok = await verify(u?.password_hash ?? (await getDummyHash()), password).catch(() => false);
    const actor = { ...actorOf(req), label: email.toLowerCase() };

    if (u && u.locked_until && new Date(u.locked_until) > new Date()) {
      await withTx(db, (tx) => audit(tx, { ...actor, userId: u.id }, { action: 'auth.login_blocked_locked', entityType: 'iam.user', entityId: u.id }));
      throw new AppError(423, 'AUTH_LOCKED', 'Account is temporarily locked after repeated failures.', { lockedUntil: u.locked_until });
    }
    if (!u || !ok) {
      await withTx(db, async (tx) => {
        if (u) {
          const upd = await tx.query(
            `update iam.users set failed_login_count = failed_login_count + 1,
               locked_until = case when failed_login_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
             where id = $1 returning failed_login_count, locked_until`, [u.id, maxAttempts, lockMinutes]);
          await audit(tx, { ...actor, userId: u.id }, { action: 'auth.login_failed', entityType: 'iam.user', entityId: u.id, after: upd.rows[0] });
        } else {
          await audit(tx, actor, { action: 'auth.login_failed_unknown', entityType: 'iam.user' });
        }
      });
      throw Errors.authInvalid();
    }
    if (u.status !== 'Active') throw new AppError(403, 'AUTH_SUSPENDED', 'This account is not active. Contact the administrator.');

    const token = randomToken();
    const csrf = randomToken(24);
    const mfaOn = (await getSetting<boolean>(db, 'auth.mfa.enforced', true)) !== false;
    const needMfa = mfaOn && !!u.mfa_enabled;
    await withTx(db, async (tx) => {
      await tx.query(`update iam.users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1`, [u.id]);
      await tx.query(
        `insert into iam.sessions (id, user_id, csrf_token, mfa_satisfied, idle_expires_at, absolute_expires_at, ip, user_agent)
         values ($1,$2,$3,$4, now() + make_interval(mins => $5), now() + make_interval(hours => $6), $7, $8)`,
        [sha256(token), u.id, csrf, !u.mfa_enabled, idleMinutes, absoluteHours, req.ip, req.get('user-agent') ?? null]);
      await audit(tx, { ...actor, userId: u.id }, { action: 'auth.login', entityType: 'iam.user', entityId: u.id });
    });
    res.cookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: absoluteHours * 3600_000 });
    res.cookie(CSRF_COOKIE, csrf, { ...cookieOpts, httpOnly: false, maxAge: absoluteHours * 3600_000 });
    res.json({ mfaRequired: needMfa, csrfToken: csrf });
  }));

  r.post('/logout', requireAuth, asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      await tx.query(`update iam.sessions set revoked_at = now() where id = $1`, [req.auth!.sessionId]);
      await audit(tx, actorOf(req), { action: 'auth.logout', entityType: 'iam.user', entityId: req.auth!.user.id });
    });
    res.clearCookie(SESSION_COOKIE, cookieOpts).clearCookie(CSRF_COOKIE, { ...cookieOpts, httpOnly: false }).json({ ok: true });
  }));

  r.post('/mfa/verify', limiter, requireAuth, asyncHandler(async (req, res) => {
    const { code } = parse(totpSchema, req.body);
    const u = (await db.query(`select mfa_secret_enc from iam.users where id = $1`, [req.auth!.user.id])).rows[0];
    if (!u?.mfa_secret_enc) throw Errors.state('MFA is not enrolled for this account.');
    const valid = authenticator.check(code, decrypt(u.mfa_secret_enc, cfg.APP_ENCRYPTION_KEY));
    await withTx(db, async (tx) => {
      if (valid) await tx.query(`update iam.sessions set mfa_satisfied = true where id = $1`, [req.auth!.sessionId]);
      await audit(tx, actorOf(req), { action: valid ? 'auth.mfa_verified' : 'auth.mfa_failed', entityType: 'iam.user', entityId: req.auth!.user.id });
    });
    if (!valid) throw new AppError(401, 'MFA_INVALID', 'The code is not valid. Check your authenticator app.');
    res.json({ ok: true });
  }));

  // Enrolment: start returns a secret + QR, confirm stores it once a valid code proves possession.
  r.post('/mfa/enrol', requireAuth, asyncHandler(async (req, res) => {
    if (req.auth!.user.mfaEnabled && !req.auth!.mfaSatisfied) throw Errors.state('Verify your current MFA first.');
    const secret = authenticator.generateSecret();
    await db.query(`update iam.sessions set mfa_pending_secret_enc = $2, mfa_pending_expires_at = now() + interval '10 minutes' where id = $1`,
      [req.auth!.sessionId, encrypt(secret, cfg.APP_ENCRYPTION_KEY)]);
    const otpauth = authenticator.keyuri(req.auth!.user.email, 'Dhruv Agro ERP', secret);
    res.json({ secret, otpauth, qrDataUrl: await QRCode.toDataURL(otpauth) });
  }));
  r.post('/mfa/enrol/confirm', requireAuth, asyncHandler(async (req, res) => {
    const { code } = parse(totpSchema, req.body);
    const row = (await db.query(`select mfa_pending_secret_enc, mfa_pending_expires_at from iam.sessions where id = $1`, [req.auth!.sessionId])).rows[0];
    if (!row?.mfa_pending_secret_enc || new Date(row.mfa_pending_expires_at) < new Date()) throw Errors.state('Enrolment expired. Start again.');
    const p = { secret: decrypt(row.mfa_pending_secret_enc, cfg.APP_ENCRYPTION_KEY) };
    if (!authenticator.check(code, p.secret)) throw new AppError(401, 'MFA_INVALID', 'The code is not valid.');
    await withTx(db, async (tx) => {
      await tx.query(`update iam.users set mfa_enabled = true, mfa_secret_enc = $2 where id = $1`, [req.auth!.user.id, encrypt(p.secret, cfg.APP_ENCRYPTION_KEY)]);
      await tx.query(`update iam.sessions set mfa_satisfied = true, mfa_pending_secret_enc = null, mfa_pending_expires_at = null where id = $1`, [req.auth!.sessionId]);
      await audit(tx, actorOf(req), { action: 'auth.mfa_enrolled', entityType: 'iam.user', entityId: req.auth!.user.id });
    });
    res.json({ ok: true });
  }));

  r.post('/password/change', requireAuth, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = parse(changePasswordSchema, req.body);
    const gate = pendingGate(req);
    if (gate === 'MFA_VERIFY' || gate === 'MFA_ENROL') throw Errors.conflict(gate === 'MFA_VERIFY' ? 'MFA_REQUIRED' : gate, 'Complete MFA first.');
    const u = (await db.query(`select password_hash, email from iam.users where id = $1`, [req.auth!.user.id])).rows[0];
    if (!(await verify(u.password_hash, currentPassword).catch(() => false))) throw new AppError(400, 'VALIDATION_FAILED', 'Current password is incorrect.', [{ field: 'currentPassword', message: 'Incorrect password' }]);
    if (newPassword.toLowerCase().includes(String(u.email).split('@')[0]!.toLowerCase())) throw Errors.validation([{ field: 'newPassword', message: 'Must not contain your email name' }]);
    if (await verify(u.password_hash, newPassword).catch(() => false)) throw Errors.validation([{ field: 'newPassword', message: 'Choose a different password' }]);
    await withTx(db, async (tx) => {
      await tx.query(`update iam.users set password_hash = $2, must_change_password = false where id = $1`, [req.auth!.user.id, await hash(newPassword)]);
      // all other sessions are revoked when the password changes
      await tx.query(`update iam.sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null`, [req.auth!.user.id, req.auth!.sessionId]);
      await audit(tx, actorOf(req), { action: 'auth.password_changed', entityType: 'iam.user', entityId: req.auth!.user.id });
    });
    res.json({ ok: true });
  }));

  return r;
}
