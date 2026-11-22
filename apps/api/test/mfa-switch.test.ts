import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, db, makeUser, PASSWORD } from './helpers';

const signIn = async (email: string) => {
  const agent = supertest.agent(app);
  const res = await agent.post('/api/v1/auth/login').send({ email, password: PASSWORD }).expect(200);
  return { agent, res };
};

describe('Two-factor switch for the pre-go-live demo (auth.mfa.enforced)', () => {
  it('asks for the authenticator code only while the switch is on', async () => {
    const u = await makeUser({ roles: [{ code: 'SUPER_ADMIN' }] });                 // enrolled, privileged role
    let s = await signIn(u.email);
    expect(s.res.body.mfaRequired).toBe(true);
    await s.agent.get('/api/v1/users').expect(409);                                  // gate: code first

    await db.query(`update sys.settings set value = 'false' where key = 'auth.mfa.enforced'`);
    try {
      s = await signIn(u.email);
      expect(s.res.body.mfaRequired).toBe(false);
      await s.agent.get('/api/v1/users').expect(200);
      expect((await s.agent.get('/api/v1/me').expect(200)).body.gate ?? null).toBeNull();
    } finally {
      await db.query(`update sys.settings set value = 'true' where key = 'auth.mfa.enforced'`);
    }
    // back on: the same session is held at the gate again
    await s.agent.get('/api/v1/users').expect(409);
  });
});
