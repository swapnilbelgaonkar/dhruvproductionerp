/**
 * Loads the purchased-material list (docs/source/materials/materials.csv: name and group from RawPacking_Labour_Consumables_Material_List.xlsx, the
 * stock group summary 1-Apr-26 to 21-Nov-26) into the item master through the bulk importer, as Draft items in three categories:
 *   Raw Material → RAW-MATERIAL, item type RM, codes RM-001…
 *   Packing Material → PACKING-MATERIAL, item type PM (so packing runs and stores treat them as packaging), codes PM-001…
 *   Labour Consumables → LABOUR-CONSUMABLES, item type RM, codes LC-001…
 * Only the name and the group are taken. Quantity, rate and value are a stock valuation, not master data: they are not kept in the repository
 * (they belong to the opening-stock load at cut-over). Base unit, HSN, shelf life and the rest stay empty to be completed before approval.
 *   pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-materials.ts [path.csv]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { allowTransition, type Actor, type Db } from './pool';
import { audit } from '../lib/audit';
import { parseCsv, run } from '../modules/golive/imports';

export const MATERIAL_GROUPS: Record<string, { category: string; name: string; type: 'RM' | 'PM'; prefix: string }> = {
  'Raw Material': { category: 'RAW-MATERIAL', name: 'Raw Material', type: 'RM', prefix: 'RM' },
  'Packing Material': { category: 'PACKING-MATERIAL', name: 'Packing Material', type: 'PM', prefix: 'PM' },
  'Labour Consumables': { category: 'LABOUR-CONSUMABLES', name: 'Labour Consumables', type: 'RM', prefix: 'LC' },
};

export async function loadMaterials(db: Db, csvText: string, actor: Actor) {
  const src = parseCsv(csvText).filter((r) => r.name && r.group);
  const unknown = [...new Set(src.map((r) => r.group!))].filter((g) => !MATERIAL_GROUPS[g]);
  if (unknown.length) throw new Error(`Unknown material group: ${unknown.join(', ')}`);
  const client = await db.connect();
  try {
    await client.query('begin');
    await allowTransition(client);
    for (const g of Object.values(MATERIAL_GROUPS)) {
      await client.query(`insert into mdm.product_categories (code, name, created_by, updated_by) values ($1,$2,$3,$3) on conflict (code) do nothing`, [g.category, g.name, actor.userId]);
    }
    await audit(client, actor, { action: 'mdm.product_categories.loaded', entityType: 'mdm.product_category', after: MATERIAL_GROUPS, reason: 'Purchased-material list' });
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }

  // numbering continues after any codes already used, sorted by name within each group
  const next: Record<string, number> = {};
  for (const g of Object.values(MATERIAL_GROUPS)) {
    const max = (await db.query(`select coalesce(max(substring(code from '^${g.prefix}-([0-9]+)$')::int), 0) as n from mdm.items where code ~ '^${g.prefix}-[0-9]+$'`)).rows[0].n;
    next[g.prefix] = Number(max);
  }
  const existing = new Set((await db.query(`select lower(name) as n from mdm.items`)).rows.map((x) => x.n as string));
  const rows = src.filter((r) => !existing.has(r.name!.trim().toLowerCase()))
    .sort((a, b) => a.group!.localeCompare(b.group!) || a.name!.localeCompare(b.name!, 'en', { sensitivity: 'base' }))
    .map((r) => {
      const g = MATERIAL_GROUPS[r.group!]!;
      return { code: `${g.prefix}-${String(++next[g.prefix]!).padStart(3, '0')}`, name: r.name!.trim().replace(/\s{2,}/g, ' '), item_type: g.type, category_code: g.category };
    });
  if (!rows.length) return { ok: true, rows: 0, errors: [], summary: { skipped: src.length } };
  return run(db, actor, 'items', rows, true);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? new URL('../../../../docs/source/materials/materials.csv', import.meta.url).pathname;
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  loadMaterials(db, readFileSync(path, 'utf8'), { userId: null, label: 'system:material-list' })
    .then((r) => { console.log(r.ok ? `${r.rows} materials loaded as Draft items` : JSON.stringify(r.errors, null, 1)); return db.end().then(() => process.exit(r.ok ? 0 : 1)); })
    .catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
}
