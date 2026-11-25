/**
 * Loads the company product list (docs/source/products/dhruv-products-category-wise.csv, from Dhruv_Products_List_Categorywise.xlsx)
 * into the item master through the bulk importer, so every row passes the same checks as a CSV import.
 *   - each Category becomes a product category (licence requirement left as NONE until D08 confirms the mapping);
 *   - each product becomes a Draft FG item with code FG-<Sr No>, its agronomy fields, and one pack per size in "Packing Available";
 *   - the base unit is taken from the pack units (g/kg → KG, ml/L → L); placeholders such as "Not mentioned in brochure" stay empty;
 *   - HSN, GST, shelf life, cost, container and units per box are not in the list and are left empty to be filled before approval.
 *   pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-products.ts [path.csv]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { allowTransition, type Actor, type Db } from './pool';
import { audit } from '../lib/audit';
import { parseCsv, run } from '../modules/golive/imports';

const PLACEHOLDER = /^(not mentioned( in brochure)?|not marked|n\/?a|-|—)$/i;
const clean = (v: string | undefined) => (v && !PLACEHOLDER.test(v.trim()) ? v.trim() : '');

/** Category name → a 2–20 character code, e.g. "Chelated Micronutrient Fertilizers" → "CHELATED". */
export function categoryCode(name: string, taken: Set<string>) {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !['OF', 'AND', 'THE', 'REG'].includes(w));
  let code = '';
  for (const w of words) { const next = code ? `${code}-${w}` : w; if (next.length > 20) break; code = next; }
  if (!code) code = 'CATEGORY';
  let out = code.slice(0, 20); let i = 2;
  while (taken.has(out)) out = `${code.slice(0, 17)}-${i++}`;
  taken.add(out);
  return out;
}

export async function loadProducts(db: Db, csvText: string, actor: Actor) {
  const src = parseCsv(csvText).filter((r) => r.sr_no && r.product_name);
  const taken = new Set((await db.query(`select code from mdm.product_categories`)).rows.map((x) => x.code as string));
  const cats = new Map<string, string>();
  const client = await db.connect();
  try {
    await client.query('begin');
    await allowTransition(client);
    for (const name of [...new Set(src.map((r) => r.category ?? ""))].filter(Boolean)) {
      const existing = (await client.query(`select code from mdm.product_categories where lower(name) = lower($1)`, [name])).rows[0];
      const code = existing?.code ?? categoryCode(name, taken);
      if (!existing) await client.query(`insert into mdm.product_categories (code, name, created_by, updated_by) values ($1,$2,$3,$3)`, [code, name, actor.userId]);
      cats.set(name, code);
    }
    await audit(client, actor, { action: 'mdm.product_categories.loaded', entityType: 'mdm.product_category', after: Object.fromEntries(cats), reason: 'Company product list' });
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }

  const rows = src.map((r) => ({
    code: `FG-${String(Number(r.sr_no)).padStart(3, '0')}`, name: r.product_name!.trim(), item_type: 'FG', category_code: cats.get(r.category!)!,
    active_ingredient: clean(r.active_ingredient_type), composition: clean(r.composition_technical_content), key_benefits: clean(r.key_benefits_uses),
    advisory_dosage: clean(r.advisory_dosage), packing: clean(r.packing_available), fco_grade: clean(r.fco_grade_as_marked_in_brochure), brochure_page: clean(r.brochure_page),
  }));
  return run(db, actor, 'items', rows, true);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? new URL('../../../../docs/source/products/dhruv-products-category-wise.csv', import.meta.url).pathname;
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  loadProducts(db, readFileSync(path, 'utf8'), { userId: null, label: 'system:product-list' })
    .then((r) => { console.log(r.ok ? `${r.rows} products loaded as Draft items` : JSON.stringify(r.errors, null, 1)); return db.end().then(() => process.exit(r.ok ? 0 : 1)); })
    .catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
}
