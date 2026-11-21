/**
 * Seeds:
 *  1. The bootstrap Super Admin from BOOTSTRAP_ADMIN_* env vars (no names are hardcoded — MP Rule 3).
 *  2. Optionally (--org-from-brd) the plants and warehouses listed in BRD v2.4 p.14/p.18 as PROVISIONAL
 *     configuration (D26 deferred). They are created as Active with an audit reason so they can be corrected later.
 *  3. Optionally (--sample) clearly marked [SAMPLE] demo data for development only (MP Part 28).
 */
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { passwordPolicy } from '@dhruv/contracts';
import { allowTransition, type Actor } from './pool';
import { audit } from '../lib/audit';

const SYSTEM: Actor = { userId: null, label: 'system:seed' };

export async function seedBootstrapAdmin(tx: pg.PoolClient, email: string, name: string, password: string) {
  passwordPolicy.parse(password);
  const existing = await tx.query(`select id from iam.users where email = $1`, [email]);
  if (existing.rowCount) return existing.rows[0].id as string;
  const pw = await hash(password);
  const u = await tx.query<{ id: string }>(
    `insert into iam.users (email, full_name, password_hash, must_change_password) values ($1,$2,$3,true) returning id`, [email, name, pw]);
  const userId = u.rows[0]!.id;
  // Bootstrap grant: the only role grant that bypasses approval, performed by the deployment process and audited.
  await tx.query(
    `insert into iam.user_roles (user_id, role_id, scope, status, reason, granted_at)
     select $1, id, '{"all":true}', 'Active', 'Bootstrap super administrator (deployment)', now() from iam.roles where code = 'SUPER_ADMIN'`, [userId]);
  await audit(tx, SYSTEM, { action: 'user.bootstrap_admin', entityType: 'iam.user', entityId: userId, after: { email }, reason: 'Initial deployment' });
  return userId;
}

async function seedOrgFromBrd(tx: pg.PoolClient) {
  const reason = 'PROVISIONAL from BRD v2.4 p.14/p.18 — D26 deferred; confirm legal name and GST registrations';
  await allowTransition(tx);
  const le = await tx.query<{ id: string }>(
    `insert into org.legal_entities (code, name, state_code, status) values ('DAT', 'Dhruv Agro Technologies Pvt. Ltd.', '27', 'Active')
     on conflict (code) do update set name = excluded.name returning id`);
  const leId = le.rows[0]!.id;
  const plant = async (code: string, name: string) =>
    (await tx.query<{ id: string }>(
      `insert into org.plants (legal_entity_id, code, name, state_code, status) values ($1,$2,$3,'27','Active')
       on conflict (code) do update set name = excluded.name returning id`, [leId, code, name])).rows[0]!.id;
  const chakan = await plant('PLT-CHAKAN-1', 'Chakan Plant 1');
  await plant('PLT-BARAMATI-2', 'Baramati Unit 2');
  const wh = [
    ['WH-01', 'Finished Goods Godown — Chakan', 'FG', chakan, '27'],
    ['WH-02', 'Raw Materials Godown — Chakan', 'RM', chakan, '27'],
    ['WH-03', 'Packaging Materials Godown — Chakan', 'PM', chakan, '27'],
    ['WH-04', 'Central Lab Chemicals — Hyderabad', 'LAB', null, '36'],
  ] as const;
  for (const [code, name, type, plantId, state] of wh) {
    await tx.query(
      `insert into org.warehouses (legal_entity_id, plant_id, code, name, type, state_code, status) values ($1,$2,$3,$4,$5,$6,'Active')
       on conflict (code) do nothing`, [leId, plantId, code, name, type, state]);
  }
  await audit(tx, SYSTEM, { action: 'org.seed_from_brd', entityType: 'org.legal_entity', entityId: leId, reason });
}

async function seedProductsFromBrd(tx: pg.PoolClient) {
  // BRD p.9 categories and HSN codes. Licence mapping and GST rates are NOT seeded as facts: D08 / D27 need adviser confirmation.
  const cats: [string, string, string][] = [['MICRONUTRIENT', 'Micronutrient', 'FERTILIZER'], ['SOIL-NUTRITION', 'Soil Nutrition', 'FERTILIZER'],
    ['BIOSTIMULANT', 'Marine Biostimulant', 'BIOSTIMULANT'], ['ORGANIC-ADDITIVE', 'Organic Soil Additive', 'NONE'], ['TECHNICAL', 'Raw Material Active (technical)', 'PESTICIDE']];
  for (const [code, name, lic] of cats) {
    await tx.query(`insert into mdm.product_categories (code, name, licence_required) values ($1,$2,$3) on conflict (code) do nothing`, [code, name, lic]);
  }
  const hsn: [string, string][] = [['29224990', 'Zinc EDTA chelate (BRD PRD-CHEL-01)'], ['31059090', 'Micronutrient fertilizer mixtures (BRD PRD-MICR-02)'],
    ['31010099', 'Seaweed / marine biostimulant (BRD PRD-BIOZ-03)'], ['38249900', 'Potassium humate preparations (BRD PRD-HUMA-04)'], ['29269090', 'Cypermethrin technical (BRD PRD-CYPE-05)']];
  for (const [code, d] of hsn) {
    await tx.query(`insert into mdm.hsn_codes (code, description) values ($1,$2) on conflict (code) do nothing`, [code, `[PROVISIONAL] ${d}`]);
  }
  await audit(tx, SYSTEM, { action: 'mdm.seed_from_brd', entityType: 'mdm.product_category', reason: 'PROVISIONAL from BRD v2.4 p.9 — confirm licence mapping (D08) and add GST rates (D27)' });
}

/**
 * Demo sales hierarchy and users for UAT and demonstrations (development/staging only).
 * Every record is tagged [SAMPLE]; role grants here bypass approval, so this refuses to run in production.
 */
async function seedDemoUsers(tx: pg.PoolClient, password: string) {
  if (process.env.NODE_ENV === 'production') throw new Error('--demo-users is not allowed in production');
  passwordPolicy.parse(password);
  const terr = async (code: string) => (await tx.query<{ id: string }>(`select id from org.territories where code = $1`, [code])).rows[0]?.id;
  const state = await terr('ST-MH');
  if (!state) throw new Error('Run with --sample first (territories)');
  const node = async (parent: string, code: string, name: string, level: number) => {
    const p = (await tx.query<{ path: string }>(`select path::text from org.territories where id = $1`, [parent])).rows[0]!.path;
    return (await tx.query<{ id: string }>(`insert into org.territories (parent_id, code, name, level, path) values ($1,$2,$3,$4,$5::ltree)
      on conflict (code) do update set name = excluded.name returning id`, [parent, code, name, level, `${p}.${code.replace(/-/g, '_')}`])).rows[0]!.id;
  };
  const district = await node(state, 'DT-NASHIK', '[SAMPLE] Nashik District', 6);
  const taluka = await node(district, 'TK-NIPHAD', '[SAMPLE] Niphad Taluka', 7);
  const pw = await hash(password);
  const person = async (code: string, name: string, tier: string | null, manager: string | null, territory: string, email: string, roles: string[]) => {
    const e = (await tx.query<{ id: string }>(`insert into org.employees (emp_code, full_name, sales_tier, manager_id, territory_id) values ($1,$2,$3,$4,$5)
      on conflict (emp_code) do update set full_name = excluded.full_name returning id`, [code, name, tier, manager, territory])).rows[0]!.id;
    const u = (await tx.query<{ id: string }>(`insert into iam.users (email, full_name, password_hash, must_change_password, employee_id) values ($1,$2,$3,false,$4)
      on conflict (email) do update set full_name = excluded.full_name returning id`, [email, name, pw, e])).rows[0]!.id;
    const scope = tier ? { legalEntityIds: [], plantIds: [], warehouseIds: [], territoryIds: [] } : { all: true };
    for (const r of roles) {
      await tx.query(`insert into iam.user_roles (user_id, role_id, scope, status, reason, granted_at) select $1, id, $2, 'Active', '[SAMPLE] demo seed', now() from iam.roles where code = $3
        and not exists (select 1 from iam.user_roles ur where ur.user_id = $1 and ur.role_id = iam.roles.id and ur.status = 'Active')`, [u, JSON.stringify(scope), r]);
    }
    return e;
  };
  const rsm = await person('SMP-RSM', '[SAMPLE] Regional Manager MH', 'RSM', null, state, 'rsm@demo.local', ['SALES_RSM']);
  const tsm = await person('SMP-TSM', '[SAMPLE] Territory Manager Niphad', 'TSM', rsm, taluka, 'tsm@demo.local', ['SALES_TSM']);
  await person('SMP-SE', '[SAMPLE] Sales Executive Niphad', 'SE', tsm, taluka, 'se@demo.local', ['SALES_SE']);
  await person('SMP-DOC', '[SAMPLE] Document Verifier', null, null, state, 'verifier@demo.local', ['DOC_VERIFIER']);
  await person('SMP-CRD', '[SAMPLE] Credit Controller', null, null, state, 'credit@demo.local', ['CREDIT_CONTROLLER']);
  // pricing and quotation approvals (Stage 2 part 3)
  await person('SMP-NSM', '[SAMPLE] National Sales Manager', 'NSM', null, state, 'nsm@demo.local', ['SALES_NSM']);
  await person('SMP-OPS', '[SAMPLE] Sales Operations', null, null, state, 'ops@demo.local', ['SALES_OPS']);
  await person('SMP-FIN', '[SAMPLE] Finance Head', null, null, state, 'finance@demo.local', ['FINANCE_HEAD']);
  // purchase (Stage 3): a storekeeper raises requisitions, the stores head approves them as department head
  await person('SMP-PH', '[SAMPLE] Purchase Head', null, null, state, 'purchase-head@demo.local', ['PURCHASE_HEAD']);
  await person('SMP-PE', '[SAMPLE] Purchase Executive', null, null, state, 'purchase@demo.local', ['PURCHASE_EXEC']);
  await person('SMP-ACC', '[SAMPLE] Accounts Executive', null, null, state, 'accounts@demo.local', ['ACCOUNTS_EXEC']);
  const storesHead = await person('SMP-SH', '[SAMPLE] Stores Head', null, null, state, 'stores-head@demo.local', ['STORES_HEAD']);
  await person('SMP-SK', '[SAMPLE] Storekeeper', null, storesHead, state, 'storekeeper@demo.local', ['STOREKEEPER']);
  // quality control (Stage 3 part 3): the analyst tests, a different person (QC manager) decides
  const qcManager = await person('SMP-QCM', '[SAMPLE] QC Manager', null, null, state, 'qc-manager@demo.local', ['QC_MANAGER']);
  await person('SMP-QCA', '[SAMPLE] QC Analyst', null, qcManager, state, 'qc@demo.local', ['QC_ANALYST']);
  await audit(tx, SYSTEM, { action: 'demo.users_seeded', entityType: 'iam.user', reason: '[SAMPLE] demo hierarchy for UAT' });
}

async function seedSample(tx: pg.PoolClient) {
  const d = await tx.query<{ id: string }>(
    `insert into org.departments (code, name) values ('SALES', '[SAMPLE] Sales'), ('QC', '[SAMPLE] Quality Control') on conflict (code) do nothing returning id`);
  void d;
  const node = async (parent: string | null, code: string, name: string, level: number) => {
    const p = parent ? (await tx.query<{ path: string }>(`select path::text from org.territories where id = $1`, [parent])).rows[0]!.path + '.' : '';
    const r = await tx.query<{ id: string }>(
      `insert into org.territories (parent_id, code, name, level, path) values ($1,$2,$3,$4,$5::ltree)
       on conflict (code) do update set name = excluded.name returning id`, [parent, code, name, level, p + code.replace(/-/g, '_')]);
    return r.rows[0]!.id;
  };
  const india = await node(null, 'IN', '[SAMPLE] India', 1);
  const wz = await node(india, 'ZC-WEST', '[SAMPLE] West Cluster', 2);
  const w = await node(wz, 'Z-WEST', '[SAMPLE] West Zone', 3);
  await node(w, 'ST-MH', '[SAMPLE] Maharashtra', 4);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const args = new Set(process.argv.slice(2));
  (async () => {
    await client.connect();
    await client.query('begin');
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const name = process.env.BOOTSTRAP_ADMIN_NAME;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (email && name && password) {
      await seedBootstrapAdmin(client as unknown as pg.PoolClient, email.toLowerCase(), name, password);
      console.log('bootstrap admin ready (password change required at first login)');
    } else console.log('BOOTSTRAP_ADMIN_* not set — skipped admin');
    if (args.has('--org-from-brd')) { await seedOrgFromBrd(client as unknown as pg.PoolClient); console.log('provisional BRD organisation seeded'); }
    if (args.has('--products-from-brd')) { await seedProductsFromBrd(client as unknown as pg.PoolClient); console.log('provisional BRD categories and HSN codes seeded (no GST rates)'); }
    if (args.has('--sample')) { await seedSample(client as unknown as pg.PoolClient); console.log('[SAMPLE] data seeded'); }
    if (args.has('--demo-users')) {
      const pw = process.env.DEMO_PASSWORD;
      if (!pw) throw new Error('Set DEMO_PASSWORD to use --demo-users');
      await seedDemoUsers(client as unknown as pg.PoolClient, pw);
      console.log('[SAMPLE] demo sales hierarchy and users seeded (sales, purchase, stores, finance and verifier roles @demo.local)');
    }
    await client.query('commit');
    await client.end();
  })().catch(async (e) => { console.error(e); await client.query('rollback').catch(() => 0); process.exit(1); });
}
