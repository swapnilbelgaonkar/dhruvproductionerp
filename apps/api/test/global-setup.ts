import pg from 'pg';
import { migrate } from '../src/db/migrate';

export const TEST_DB = process.env.DATABASE_URL_TEST ?? 'postgres://dhruv:dhruv_dev@localhost:5432/dhruv_erp_test';

export default async function setup() {
  const c = new pg.Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query(`drop schema if exists sys, iam, org, wf, mdm, sales, purchase, inv, qc, mfg cascade; drop table if exists public.schema_migrations;`);
  await c.end();
  await migrate(TEST_DB, () => undefined);
}
