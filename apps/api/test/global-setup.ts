import pg from 'pg';
import { migrate } from '../src/db/migrate';

export const TEST_DB = process.env.DATABASE_URL_TEST ?? 'postgres://dhruv:dhruv_dev@localhost:5432/dhruv_erp_test';

export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query(`drop schema if exists sys, iam, org, wf, mdm, sales, purchase, inv, qc, mfg, qa, logistics cascade; drop table if exists public.schema_migrations;`);
  await c.end();
  await migrate(TEST_DB, () => undefined);
  // line clearance (QA-017) is exercised in qa-system.test.ts; other suites start batches without it
  const c2 = new pg.Client({ connectionString: TEST_DB });
  await c2.connect();
  await c2.query(`update sys.settings set value = 'false' where key = 'mfg.lineClearance.required'`);
  await c2.end();
}
