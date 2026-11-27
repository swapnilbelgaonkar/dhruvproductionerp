import type pg from 'pg';
import type { Actor } from './pool';
import { audit } from '../lib/audit';

const SYSTEM: Actor = { userId: null, label: 'system:deployment' };

/**
 * A further super administrator whose password the company has chosen (e.g. for demonstrating the system), given as an
 * argon2 hash so the plain password is never stored in configuration. An existing user with that e-mail is left unchanged.
 */
export async function ensureSuperAdmin(tx: Pick<pg.PoolClient, 'query'>, email: string, name: string, passwordHash: string, reason: string) {
  const existing = await tx.query(`select id from iam.users where lower(email) = lower($1)`, [email]);
  if (existing.rowCount) return { id: existing.rows[0].id as string, created: false };
  const userId = (await tx.query<{ id: string }>(
    `insert into iam.users (email, full_name, password_hash, must_change_password) values (lower($1),$2,$3,false) returning id`, [email, name, passwordHash])).rows[0]!.id;
  await tx.query(
    `insert into iam.user_roles (user_id, role_id, scope, status, reason, granted_at)
     select $1, id, '{"all":true}', 'Active', $2, now() from iam.roles where code = 'SUPER_ADMIN'`, [userId, reason]);
  await audit(tx as pg.PoolClient, SYSTEM, { action: 'user.bootstrap_admin', entityType: 'iam.user', entityId: userId, after: { email }, reason });
  return { id: userId, created: true };
}
