#!/usr/bin/env node
/**
 * Performance check for go-live (Stage 8). Signs in once and runs USERS concurrent virtual users for SECONDS, each looping through
 * the screens people open most, and reports latency percentiles per endpoint and overall. Read-only: it changes nothing.
 *   BASE=https://erp.example.in EMAIL=... PASSWORD=... USERS=50 SECONDS=120 node scripts/load-test.mjs
 * Exit code 1 if p95 exceeds P95_MS (default 800) or any request fails.
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:4000';
const USERS = Number(process.env.USERS ?? 20);
const SECONDS = Number(process.env.SECONDS ?? 30);
const P95_MS = Number(process.env.P95_MS ?? 800);
const PATHS = (process.env.PATHS ?? [
  '/api/v1/me', '/api/v1/dashboard/overview', '/api/v1/approvals?box=inbox', '/api/v1/sales-orders?limit=25', '/api/v1/sales-invoices', '/api/v1/stock/balances',
  '/api/v1/alerts', '/api/v1/receivables/ageing', '/api/v1/reports/sales-orders/run', '/api/v1/dashboard/executive', '/api/v1/notifications?limit=20',
].join(',')).split(',');

const login = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.EMAIL, password: process.env.PASSWORD }) });
if (!login.ok) { console.error('sign-in failed', login.status, await login.text()); process.exit(2); }
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

const times = new Map(PATHS.map((p) => [p, []]));
const failures = new Map();
const end = Date.now() + SECONDS * 1000;
async function user(n) {
  let i = n;
  while (Date.now() < end) {
    const path = PATHS[i++ % PATHS.length];
    const t = performance.now();
    try {
      const r = await fetch(`${BASE}${path}`, { headers: { cookie } });
      await r.arrayBuffer();
      if (!r.ok && r.status !== 403) failures.set(`${path} ${r.status}`, (failures.get(`${path} ${r.status}`) ?? 0) + 1);
    } catch (e) { failures.set(`${path} ${e.message}`, (failures.get(`${path} ${e.message}`) ?? 0) + 1); }
    times.get(path).push(performance.now() - t);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: USERS }, (_, n) => user(n)));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
const all = [...times.values()].flat();
console.log(`\n${USERS} users × ${SECONDS}s against ${BASE}: ${all.length} requests, ${(all.length / ((Date.now() - t0) / 1000)).toFixed(1)} req/s\n`);
console.log('endpoint'.padEnd(46), 'n'.padStart(6), 'p50'.padStart(7), 'p95'.padStart(7), 'p99'.padStart(7));
for (const [p, a] of times) console.log(p.padEnd(46), String(a.length).padStart(6), ...[50, 95, 99].map((q) => `${pct(a, q).toFixed(0)}ms`.padStart(7)));
const p95 = pct(all, 95);
console.log(`\noverall p50 ${pct(all, 50).toFixed(0)}ms · p95 ${p95.toFixed(0)}ms · p99 ${pct(all, 99).toFixed(0)}ms · failures ${[...failures.values()].reduce((a, b) => a + b, 0)}`);
for (const [k, v] of failures) console.log(`  failed ${v}× ${k}`);
process.exit(p95 > P95_MS || failures.size ? 1 : 0);
