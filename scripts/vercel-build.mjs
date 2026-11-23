#!/usr/bin/env node
/**
 * Builds the hosted demo in Vercel's Build Output API format (.vercel/output), for `vercel deploy --prebuilt`.
 *   static/            the web portal (Vite build), served with a single-page-app fallback
 *   functions/api/     the Express API as one Node function (src/vercel.ts), with the SQL migrations
 * An optional [SAMPLE] database snapshot at deploy/demo-snapshot.sql is bundled and loaded into an empty database.
 * Run from the repository root after `pnpm install`: node scripts/vercel-build.mjs
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = process.cwd();
const out = join(root, '.vercel/output');
const fn = join(out, 'functions/api/index.func');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

// 1. web portal
run('pnpm --filter @dhruv/web build');
cpSync(join(root, 'apps/web/dist'), join(out, 'static'), { recursive: true });

// 2. API function: one ESM bundle; the native password-hashing module ships beside it
const api = join(root, 'apps/api');
const req = createRequire(join(api, 'package.json'));
const esbuild = createRequire(realpathSync(req.resolve('tsup/package.json')))('esbuild');
esbuild.buildSync({
  entryPoints: [join(api, 'src/vercel.ts')], outfile: join(fn, 'vercel.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
  external: ['@node-rs/argon2', 'pg-native'],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
});
const argon = dirname(realpathSync(req.resolve('@node-rs/argon2/package.json')));
cpSync(argon, join(fn, 'node_modules/@node-rs/argon2'), { recursive: true, dereference: true });
const platformPkg = '@node-rs/argon2-linux-x64-gnu';
const platform = dirname(realpathSync(createRequire(join(argon, 'package.json')).resolve(`${platformPkg}/package.json`)));
cpSync(platform, join(fn, 'node_modules', platformPkg), { recursive: true, dereference: true });
cpSync(join(api, 'migrations'), join(fn, 'migrations'), { recursive: true });

const env = {};
const snapshot = join(root, 'deploy/demo-snapshot.sql');
if (existsSync(snapshot)) {
  cpSync(snapshot, join(fn, 'demo-snapshot.sql'));
  env.DEMO_SNAPSHOT = 'demo-snapshot.sql';
  env.DEMO_SNAPSHOT_ID = createHash('sha256').update(readFileSync(snapshot)).digest('hex').slice(0, 16);
  if (process.env.DEMO_REFRESH === '1') env.DEMO_REFRESH = '1';   // replace older demo data on the next cold start
}

writeFileSync(join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(join(fn, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x', handler: 'vercel.js', launcherType: 'Nodejs', shouldAddHelpersToRequest: false,
  maxDuration: 60, regions: ['sin1'], environment: env,
}, null, 2));

// 3. routing: API to the function, everything else to the portal
writeFileSync(join(out, 'config.json'), JSON.stringify({
  version: 3,
  routes: [
    { src: '^/api/(.*)$', dest: '/api/index' },
    { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { src: '^/sw\\.js$', headers: { 'cache-control': 'no-cache' }, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
  crons: [{ path: '/api/cron/scan', schedule: '30 0 * * *' }],
}, null, 2));
console.log('Build output written to .vercel/output');
