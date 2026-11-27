/**
 * Serverless entry for the hosted demo (Vercel). The long-running server (server.ts) and worker (worker.ts)
 * stay the production shape; here the same Express app answers each request, and:
 *  - on a cold start the database is prepared once (advisory lock): an empty database is loaded from the
 *    bundled [SAMPLE] demo snapshot when DEMO_SNAPSHOT is set, then pending migrations are applied;
 *  - files live in Postgres (no persistent disk);
 *  - the outbox relay runs before notification reads, and the hourly checks run from a scheduled call.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import { ensureSuperAdmin } from './db/admins';
import { DbStorage } from './modules/documents/storage';
import { relayOutbox, runScheduledScans } from './modules/notifications/relay';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL);
const app = createApp(db, cfg, new DbStorage(db));

async function prepare(): Promise<void> {
  process.env.MIGRATIONS_DIR ??= join(here, 'migrations');
  // session-level lock and multi-statement restore need a direct (unpooled) connection
  const url = process.env.DATABASE_URL_UNPOOLED ?? cfg.DATABASE_URL;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
    let fresh = !(await client.query(`select to_regclass('public.schema_migrations') as t`)).rows[0].t;
    // demo only: a build carrying a different snapshot (DEMO_SNAPSHOT_ID) replaces the demo data once, when DEMO_REFRESH=1
    const snapshotId = process.env.DEMO_SNAPSHOT_ID;
    if (!fresh && process.env.DEMO_SNAPSHOT && snapshotId && process.env.DEMO_REFRESH === '1') {
      const loaded = (await client.query(`select to_regclass('public.demo_snapshot') is not null as t`)).rows[0].t
        ? (await client.query(`select id from public.demo_snapshot limit 1`)).rows[0]?.id : null;
      if (loaded !== snapshotId) {
        await client.query(`drop schema if exists sys, iam, org, wf, mdm, sales, purchase, inv, qc, mfg, qa, logistics, fin, gst cascade;
                            drop table if exists public.schema_migrations, public.demo_snapshot`);
        fresh = true;
        console.log('demo data replaced by snapshot', snapshotId);
      }
    }
    if (fresh && process.env.DEMO_SNAPSHOT) {
      const sql = (await readFile(join(here, process.env.DEMO_SNAPSHOT), 'utf8'))
        .split('\n').filter((l) => !l.startsWith('\\')).join('\n'); // drop psql meta-commands
      await client.query(sql);
      await client.query(`reset search_path`);
      if (snapshotId) await client.query(`create table if not exists public.demo_snapshot (id text primary key); insert into public.demo_snapshot (id) values ('${snapshotId.replace(/[^a-f0-9]/g, '')}')`);
      console.log('demo snapshot loaded');
    }
    await migrate(url, () => undefined);
    // demo only: super administrators the company asked for, as [{ email, name, hash }] (argon2 hash, never a plain password)
    if (process.env.DEMO_ADMINS) {
      for (const a of JSON.parse(process.env.DEMO_ADMINS) as { email: string; name: string; hash: string }[]) {
        const r = await ensureSuperAdmin(client, a.email, a.name, a.hash, 'Super administrator for demonstrating the system (company request)');
        if (r.created) console.log('demo super administrator added');
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
}

// A dropped connection on a cold start (the database waking up, a TLS reset) is retried, and a failure is not kept:
// the next request tries again instead of the instance answering "not ready" until it is recycled.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function prepareWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { return await prepare(); } catch (e) {
      console.error(`database preparation failed (attempt ${attempt})`, e);
      if (attempt >= 4) throw e;
      await sleep(500 * 2 ** attempt);
    }
  }
}
let ready: Promise<void> | null = null;
const ensureReady = () => (ready ??= prepareWithRetry().catch((e) => { ready = null; throw e; }));
void ensureReady().catch(() => undefined);

const relay = async () => { try { while ((await relayOutbox(db)) > 0); } catch (e) { console.error('relay failed', e); } };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await ensureReady();
  } catch {
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'NOT_READY', message: 'The database is not ready. Try again shortly.' } }));
    return;
  }
  const url = req.url ?? '';
  if (url.startsWith('/api/cron/scan')) {
    if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) { res.statusCode = 401; res.end(); return; }
    await runScheduledScans(db).catch((e) => console.error('scheduled scan failed', e));
    await relay();
    res.statusCode = 204; res.end();
    return;
  }
  if (req.method === 'GET' && (url.startsWith('/api/v1/notifications') || url.startsWith('/api/v1/dashboard'))) await relay();
  (app as unknown as (rq: IncomingMessage, rs: ServerResponse) => void)(req, res);
}
