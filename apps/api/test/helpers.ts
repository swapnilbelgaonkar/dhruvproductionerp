import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import supertest from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { encrypt } from '../src/lib/crypto';
import { TEST_DB } from './global-setup';

export const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB, APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  STORAGE_DIR: mkdtempSync(join(tmpdir(), 'dhruv-files-')) } as NodeJS.ProcessEnv);
export const db = createPool(TEST_DB);
export const app = createApp(db, cfg);
export const PASSWORD = 'Test-password-2026';

let n = 0;
export const uniq = (p: string) => `${p}${Date.now().toString(36).toUpperCase()}${(n++).toString(36).toUpperCase()}`;

export interface Agent {
  userId: string;
  email: string;
  get: (url: string) => supertest.Test;
  post: (url: string, body?: object) => supertest.Test;
  put: (url: string, body?: object) => supertest.Test;
  patch: (url: string, body?: object) => supertest.Test;
  upload: (url: string, data: Buffer, mime: string) => supertest.Test;
  raw: supertest.Agent;
}

export async function makeUser(opts: { roles?: { code: string; scope?: object }[]; employeeId?: string; name?: string } = {}) {
  const email = `${uniq('u').toLowerCase()}@test.invalid`;
  const secret = authenticator.generateSecret();
  const needsMfa = (await db.query(`select bool_or(requires_mfa) as m from iam.roles where code = any($1)`, [(opts.roles ?? []).map((r) => r.code)])).rows[0].m;
  const u = await db.query(
    `insert into iam.users (email, full_name, password_hash, must_change_password, mfa_enabled, mfa_secret_enc, employee_id)
     values ($1,$2,$3,false,$4,$5,$6) returning id`,
    [email, opts.name ?? `[TEST] ${email}`, await hash(PASSWORD), !!needsMfa, needsMfa ? encrypt(secret, cfg.APP_ENCRYPTION_KEY) : null, opts.employeeId ?? null]);
  const userId = u.rows[0].id as string;
  for (const r of opts.roles ?? []) {
    await db.query(`insert into iam.user_roles (user_id, role_id, scope, status, granted_at) select $1, id, $2, 'Active', now() from iam.roles where code = $3`,
      [userId, JSON.stringify(r.scope ?? { all: true }), r.code]);
  }
  return { userId, email, secret, needsMfa: !!needsMfa };
}

export async function login(email: string, secret?: string): Promise<Agent & { csrf: string }> {
  const agent = supertest.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  const csrf = res.body.csrfToken as string;
  if (res.body.mfaRequired) {
    await agent.post('/api/v1/auth/mfa/verify').set('x-csrf-token', csrf).send({ code: authenticator.generate(secret!) }).expect(200);
  }
  const me = await agent.get('/api/v1/me').expect(200);
  const withCsrf = (t: supertest.Test, body?: object) => t.set('x-csrf-token', csrf).send(body ?? {});
  return {
    userId: me.body.user.id, email, csrf,
    get: (url) => agent.get(url),
    post: (url, body) => withCsrf(agent.post(url), body),
    put: (url, body) => withCsrf(agent.put(url), body),
    patch: (url, body) => withCsrf(agent.patch(url), body),
    upload: (url, data, mime) => agent.post(url).set('x-csrf-token', csrf).set('content-type', mime).send(data),
    raw: agent,
  };
}

export async function userAgent(roles: { code: string; scope?: object }[], extra: { employeeId?: string; name?: string } = {}) {
  const u = await makeUser({ roles, ...extra });
  return login(u.email, u.secret);
}
