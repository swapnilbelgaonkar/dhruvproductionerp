import { Router } from 'express';
import { z } from 'zod';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { AppError, Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { nextDocNo, nextMasterCode } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { postJournal } from '../finance/ledger';

/**
 * Bulk import (Stage 8; D10). A CSV is checked row by row first (nothing saved), then committed in one transaction — all rows or none.
 * Masters enter the normal life cycle: items, dealers and vendors are created as Draft and go through KYC and approval as usual;
 * employees, transporters and HSN codes are created directly. Opening balances are allowed once per legal entity, at the cut-over date.
 */
type Row = Record<string, string>;
type Err = { row: number; field: string; message: string };
interface Ctx { tx: Tx; actor: Actor; errors: Err[]; n: number; cutover: string | null }
interface Kind { label: string; perm: 'sys.import:masters' | 'sys.import:opening'; columns: { key: string; required?: boolean; note: string; example: string }[];
  check: (c: Ctx, r: Row) => Promise<unknown>; save: (c: Ctx, r: Row, x: unknown) => Promise<void>; after?: (c: Ctx, all: { r: Row; x: unknown }[]) => Promise<Record<string, unknown>> }

/** RFC 4180 CSV with a header row; returns rows keyed by lower-case header. */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = []; let cur: string[] = []; let cell = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) { if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { cur.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; cur.push(cell); rows.push(cur); cur = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || cur.length) { cur.push(cell); rows.push(cur); }
  const data = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (data.length < 2) throw Errors.rule('EMPTY_FILE', 'The file needs a header row and at least one data row.');
  const head = data[0]!.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return data.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const num = (c: Ctx, r: Row, k: string, opts: { min?: number; int?: boolean; required?: boolean } = {}) => {
  const v = r[k];
  if (!v) { if (opts.required) c.errors.push({ row: c.n, field: k, message: 'Required' }); return null; }
  const x = Number(v.replace(/,/g, ''));
  if (!Number.isFinite(x) || (opts.int && !Number.isInteger(x)) || (opts.min != null && x < opts.min)) { c.errors.push({ row: c.n, field: k, message: `Not a valid ${opts.int ? 'whole number' : 'number'}${opts.min != null ? ` ≥ ${opts.min}` : ''}` }); return null; }
  return x;
};
const date = (c: Ctx, r: Row, k: string, required = false) => {
  const v = r[k];
  if (!v) { if (required) c.errors.push({ row: c.n, field: k, message: 'Required' }); return null; }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) ?? /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(v);
  const iso = m ? (m[1]!.length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`) : null;
  if (!iso || Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) { c.errors.push({ row: c.n, field: k, message: 'A date as YYYY-MM-DD or DD/MM/YYYY' }); return null; }
  return iso;
};
const need = (c: Ctx, r: Row, ...keys: string[]) => { for (const k of keys) if (!r[k]) c.errors.push({ row: c.n, field: k, message: 'Required' }); };
const pattern = (c: Ctx, r: Row, k: string, re: RegExp, msg: string) => { if (r[k] && !re.test(r[k]!)) c.errors.push({ row: c.n, field: k, message: msg }); };
const oneOf = (c: Ctx, r: Row, k: string, values: string[]) => { if (r[k] && !values.includes(r[k]!.toUpperCase())) c.errors.push({ row: c.n, field: k, message: `One of ${values.join(', ')}` }); };
async function ref(c: Ctx, r: Row, k: string, sql: string, what: string) {
  if (!r[k]) return null;
  const x = (await c.tx.query(sql, [r[k]])).rows[0];
  if (!x) c.errors.push({ row: c.n, field: k, message: `No ${what} ${r[k]}` });
  return x ?? null;
}
const dup = async (c: Ctx, r: Row, k: string, sql: string, what: string) => { if (r[k] && (await c.tx.query(sql, [r[k]])).rowCount) c.errors.push({ row: c.n, field: k, message: `${what} ${r[k]} already exists` }); };
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/; const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/; const MOBILE = /^[6-9][0-9]{9}$/; const PIN = /^[1-9][0-9]{5}$/;
const LE = `select id, code from org.legal_entities where code = $1 and status = 'Active'`;
const CONSTITUTION = ['PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PVT_LTD', 'PUBLIC_LTD', 'FPO'];

async function partyChecks(c: Ctx, r: Row) {
  need(c, r, 'legal_name', 'constitution', 'contact_person', 'mobile', 'address_line1', 'city', 'district', 'state_code', 'pincode');
  oneOf(c, r, 'constitution', CONSTITUTION);
  pattern(c, r, 'pan', PAN, 'PAN like ABCDE1234F'); pattern(c, r, 'gstin', GSTIN, 'GSTIN like 27ABCDE1234F1Z5'); pattern(c, r, 'mobile', MOBILE, '10-digit mobile');
  pattern(c, r, 'pincode', PIN, '6-digit PIN'); pattern(c, r, 'state_code', /^[0-9]{2}$/, '2-digit GST state code');
  if (r.gstin && r.pan && r.gstin.slice(2, 12) !== r.pan) c.errors.push({ row: c.n, field: 'gstin', message: 'The GSTIN does not carry this PAN' });
  if (r.gstin && r.state_code && r.gstin.slice(0, 2) !== r.state_code) c.errors.push({ row: c.n, field: 'gstin', message: 'The GSTIN is of another state' });
  await dup(c, r, 'gstin', `select 1 from mdm.parties where gstin = $1`, 'A party with GSTIN');
}
async function saveParty(c: Ctx, r: Row, code: string) {
  const p = (await c.tx.query(`insert into mdm.parties (code, legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email, created_by, updated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`, [code, r.legal_name, r.trade_name || null, r.constitution!.toUpperCase(), r.pan || null, !!r.gstin, r.gstin || null,
    r.contact_person, r.mobile, r.email || null, c.actor.userId])).rows[0].id as string;
  await c.tx.query(`insert into mdm.party_addresses (party_id, kind, line1, line2, city, district, state_code, pincode, is_default, created_by) values ($1,'REGISTERED',$2,$3,$4,$5,$6,$7,true,$8)`,
    [p, r.address_line1, r.address_line2 || null, r.city, r.district, r.state_code, r.pincode, c.actor.userId]);
  return p;
}
const PARTY_COLS = [
  { key: 'legal_name', required: true, note: 'Name as on the GST / PAN record', example: 'Krishi Seva Kendra' }, { key: 'trade_name', note: 'Optional', example: '' },
  { key: 'constitution', required: true, note: CONSTITUTION.join(' / '), example: 'PROPRIETORSHIP' }, { key: 'pan', note: 'ABCDE1234F', example: 'ABCPK1234D' },
  { key: 'gstin', note: 'Blank if not registered', example: '27ABCPK1234D1Z5' }, { key: 'contact_person', required: true, note: '', example: 'Rajesh Patil' },
  { key: 'mobile', required: true, note: '10 digits', example: '9822012345' }, { key: 'email', note: '', example: 'kendra@example.in' },
  { key: 'address_line1', required: true, note: '', example: 'Shop 4, Market Yard' }, { key: 'address_line2', note: '', example: '' },
  { key: 'city', required: true, note: '', example: 'Niphad' }, { key: 'district', required: true, note: '', example: 'Nashik' },
  { key: 'state_code', required: true, note: 'GST state code', example: '27' }, { key: 'pincode', required: true, note: '', example: '422303' },
];

const KINDS: Record<string, Kind> = {
  hsn: { label: 'HSN / SAC codes', perm: 'sys.import:masters',
    columns: [{ key: 'code', required: true, note: '4–8 digits', example: '31059090' }, { key: 'description', required: true, note: '', example: 'Micronutrient fertilizer mixtures' }],
    check: async (c, r) => { need(c, r, 'code', 'description'); pattern(c, r, 'code', /^[0-9]{4,8}$/, '4 to 8 digits'); await dup(c, r, 'code', `select 1 from mdm.hsn_codes where code = $1`, 'HSN'); },
    save: async (c, r) => { await c.tx.query(`insert into mdm.hsn_codes (code, description) values ($1,$2)`, [r.code, r.description]); } },

  employees: { label: 'Employees', perm: 'sys.import:masters',
    columns: [{ key: 'emp_code', required: true, note: '', example: 'E1001' }, { key: 'full_name', required: true, note: '', example: 'Sunita Jadhav' }, { key: 'email', note: '', example: 'sunita@dhruvagro.in' },
      { key: 'mobile', note: '', example: '9822000001' }, { key: 'designation', note: '', example: 'Area Sales Manager' }, { key: 'department_code', note: 'Existing department', example: 'SALES' },
      { key: 'manager_emp_code', note: 'Existing employee, or one earlier in this file', example: 'E1000' }, { key: 'sales_tier', note: 'BH NSM DSM ZSM RSM SASM ASM TSM SE', example: 'ASM' },
      { key: 'territory_code', note: 'Existing territory', example: 'TK-NIPHAD' }],
    check: async (c, r) => {
      need(c, r, 'emp_code', 'full_name'); pattern(c, r, 'mobile', MOBILE, '10-digit mobile'); oneOf(c, r, 'sales_tier', ['BH', 'NSM', 'DSM', 'ZSM', 'RSM', 'SASM', 'ASM', 'TSM', 'SE']);
      await dup(c, r, 'emp_code', `select 1 from org.employees where emp_code = $1`, 'Employee');
      const dept = await ref(c, r, 'department_code', `select id from org.departments where code = $1`, 'department');
      const terr = await ref(c, r, 'territory_code', `select id from org.territories where code = $1`, 'territory');
      return { dept: dept?.id ?? null, terr: terr?.id ?? null };
    },
    save: async (c, r, x) => {
      const { dept, terr } = x as { dept: string | null; terr: string | null };
      const mgr = r.manager_emp_code ? (await c.tx.query(`select id from org.employees where emp_code = $1`, [r.manager_emp_code])).rows[0]?.id : null;
      if (r.manager_emp_code && !mgr) throw new AppError(422, 'IMPORT_INVALID', `Row ${c.n}: no manager ${r.manager_emp_code} (list managers before their reports).`);
      await c.tx.query(`insert into org.employees (emp_code, full_name, email, mobile, designation, department_id, manager_id, sales_tier, territory_id, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [r.emp_code, r.full_name, r.email || null, r.mobile || null, r.designation || null, dept, mgr, r.sales_tier?.toUpperCase() || null, terr, c.actor.userId]);
    } },

  transporters: { label: 'Transporters', perm: 'sys.import:masters',
    columns: [{ key: 'code', required: true, note: 'A–Z 0–9 -', example: 'SAHYADRI' }, { key: 'name', required: true, note: '', example: 'Sahyadri Roadways' }, { key: 'gstin', note: '', example: '' },
      { key: 'pan', note: '', example: 'ABCFS1234K' }, { key: 'contact', note: '', example: 'Vilas' }, { key: 'phone', note: '', example: '9822000002' }],
    check: async (c, r) => { need(c, r, 'code', 'name'); pattern(c, r, 'code', /^[A-Z0-9-]{2,20}$/, '2–20 capitals, digits or -'); pattern(c, r, 'gstin', GSTIN, 'GSTIN'); pattern(c, r, 'pan', PAN, 'PAN');
      await dup(c, r, 'code', `select 1 from logistics.transporters where code = $1`, 'Transporter'); },
    save: async (c, r) => { await c.tx.query(`insert into logistics.transporters (code, name, gstin, pan, contact, phone, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [r.code, r.name, r.gstin || null, r.pan || null, r.contact || null, r.phone || null, c.actor.userId]); } },

  items: { label: 'Items with a pack size (created as Draft)', perm: 'sys.import:masters',
    columns: [{ key: 'code', required: true, note: '', example: 'FG-ZN-EDTA-12' }, { key: 'name', required: true, note: '', example: 'Zinc EDTA 12%' },
      { key: 'item_type', required: true, note: 'FG RM PM SEMI LAB SERVICE', example: 'FG' }, { key: 'category_code', note: '', example: 'MICRONUTRIENT' },
      { key: 'base_uom', required: true, note: 'Existing unit', example: 'L' }, { key: 'hsn_code', note: 'Existing HSN', example: '31059090' }, { key: 'shelf_life_days', note: '', example: '730' },
      { key: 'pack_code', note: 'Optional pack: code', example: '1L' }, { key: 'pack_size', note: '', example: '1' }, { key: 'pack_uom', note: '', example: 'L' },
      { key: 'container', note: '', example: 'Bottle' }, { key: 'units_per_box', note: '', example: '12' }],
    check: async (c, r) => {
      need(c, r, 'code', 'name', 'item_type', 'base_uom'); oneOf(c, r, 'item_type', ['FG', 'RM', 'PM', 'SEMI', 'LAB', 'SERVICE']);
      await dup(c, r, 'code', `select 1 from mdm.items where code = $1`, 'Item');
      await ref(c, r, 'base_uom', `select code from mdm.uom where code = $1`, 'unit');
      const cat = await ref(c, r, 'category_code', `select id from mdm.product_categories where code = $1`, 'category');
      const hsn = await ref(c, r, 'hsn_code', `select id from mdm.hsn_codes where code = $1`, 'HSN code');
      num(c, r, 'shelf_life_days', { min: 1, int: true });
      if (r.pack_code) { need(c, r, 'pack_size', 'pack_uom', 'container'); pattern(c, r, 'pack_code', /^[A-Z0-9-]{1,20}$/, 'Capitals, digits or -'); num(c, r, 'pack_size', { min: 0.0001 }); num(c, r, 'units_per_box', { min: 1, int: true });
        await ref(c, r, 'pack_uom', `select code from mdm.uom where code = $1`, 'unit'); }
      return { cat: cat?.id ?? null, hsn: hsn?.id ?? null };
    },
    save: async (c, r, x) => {
      const { cat, hsn } = x as { cat: string | null; hsn: string | null };
      const id = (await c.tx.query(`insert into mdm.items (code, name, item_type, category_id, base_uom, hsn_id, shelf_life_days, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [r.code, r.name, r.item_type!.toUpperCase(), cat, r.base_uom, hsn, r.shelf_life_days ? Number(r.shelf_life_days) : null, c.actor.userId])).rows[0].id;
      if (r.pack_code) await c.tx.query(`insert into mdm.item_packs (item_id, pack_code, pack_size, pack_uom, container, units_per_box, created_by) values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, r.pack_code, Number(r.pack_size), r.pack_uom, r.container, r.units_per_box ? Number(r.units_per_box) : 1, c.actor.userId]);
    } },

  dealers: { label: 'Dealers (created as Draft for KYC and approval)', perm: 'sys.import:masters',
    columns: [...PARTY_COLS, { key: 'dealer_category', required: true, note: 'DISTRIBUTOR DEALER RETAILER INSTITUTION', example: 'DEALER' },
      { key: 'territory_code', required: true, note: '', example: 'TK-NIPHAD' }, { key: 'sales_owner_emp_code', required: true, note: '', example: 'E1001' },
      { key: 'credit_days', note: '', example: '30' }, { key: 'credit_limit', note: '₹', example: '200000' }],
    check: async (c, r) => {
      await partyChecks(c, r); need(c, r, 'dealer_category', 'territory_code', 'sales_owner_emp_code'); oneOf(c, r, 'dealer_category', ['DISTRIBUTOR', 'DEALER', 'RETAILER', 'INSTITUTION']);
      const t = await ref(c, r, 'territory_code', `select id from org.territories where code = $1 and status = 'Active'`, 'active territory');
      const e = await ref(c, r, 'sales_owner_emp_code', `select id from org.employees where emp_code = $1 and status = 'Active'`, 'active employee');
      num(c, r, 'credit_days', { min: 0, int: true }); num(c, r, 'credit_limit', { min: 0 });
      return { t: t?.id, e: e?.id };
    },
    save: async (c, r, x) => {
      const { t, e } = x as { t: string; e: string };
      const p = await saveParty(c, r, await nextMasterCode(c.tx, 'DEALER_CODE'));
      await c.tx.query(`insert into mdm.dealer_profiles (party_id, dealer_category, territory_id, sales_owner_id, credit_days, credit_limit, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [p, r.dealer_category!.toUpperCase(), t, e, Number(r.credit_days || 0), Number((r.credit_limit || '0').replace(/,/g, '')), c.actor.userId]);
    } },

  vendors: { label: 'Vendors (created as Draft for KYC and approval)', perm: 'sys.import:masters',
    columns: [...PARTY_COLS, { key: 'vendor_category', required: true, note: 'RAW_MATERIAL PACKAGING LAB_CONSUMABLE SERVICES CAPITAL OTHER', example: 'RAW_MATERIAL' },
      { key: 'payment_terms_days', note: '', example: '30' }],
    check: async (c, r) => { await partyChecks(c, r); need(c, r, 'vendor_category'); oneOf(c, r, 'vendor_category', ['RAW_MATERIAL', 'PACKAGING', 'LAB_CONSUMABLE', 'SERVICES', 'CAPITAL', 'OTHER']);
      num(c, r, 'payment_terms_days', { min: 0, int: true }); },
    save: async (c, r) => {
      const p = await saveParty(c, r, await nextMasterCode(c.tx, 'VENDOR_CODE'));
      await c.tx.query(`insert into mdm.vendor_profiles (party_id, vendor_category, payment_terms_days, created_by, updated_by) values ($1,$2,$3,$4,$4)`,
        [p, r.vendor_category!.toUpperCase(), Number(r.payment_terms_days || 30), c.actor.userId]);
    } },

  // ---------------------------------------------------------------- opening balances
  'opening-stock': { label: 'Opening stock by lot', perm: 'sys.import:opening',
    columns: [{ key: 'warehouse_code', required: true, note: '', example: 'WH-01' }, { key: 'item_code', required: true, note: 'Active item', example: 'FG-ZN-EDTA-12' },
      { key: 'lot_no', required: true, note: 'New lot number (unique)', example: 'B2526-0412' }, { key: 'mfg_date', note: '', example: '2026-03-14' }, { key: 'expiry_date', note: '', example: '2028-03-13' },
      { key: 'qty', required: true, note: 'In the item’s base unit', example: '1200' }, { key: 'unit_cost', required: true, note: '₹ per base unit', example: '142.50' },
      { key: 'qc_status', required: true, note: 'Released or Quarantine', example: 'Released' }],
    check: async (c, r) => {
      need(c, r, 'warehouse_code', 'item_code', 'lot_no', 'qty', 'unit_cost', 'qc_status'); oneOf(c, r, 'qc_status', ['RELEASED', 'QUARANTINE']);
      const w = await ref(c, r, 'warehouse_code', `select id, legal_entity_id from org.warehouses where code = $1 and status = 'Active'`, 'active warehouse');
      const i = await ref(c, r, 'item_code', `select id, lot_controlled from mdm.items where code = $1 and status = 'Active'`, 'active item');
      await dup(c, r, 'lot_no', `select 1 from inv.lots where lot_no = $1`, 'Lot');
      const mfg = date(c, r, 'mfg_date'); const exp = date(c, r, 'expiry_date');
      if (mfg && exp && exp <= mfg) c.errors.push({ row: c.n, field: 'expiry_date', message: 'Expiry must be after manufacture' });
      num(c, r, 'qty', { min: 0.0001, required: true }); num(c, r, 'unit_cost', { min: 0, required: true });
      if (w && (await c.tx.query(`select 1 from inv.stock_ledger sl join org.warehouses x on x.id = sl.warehouse_id where sl.txn_type = 'OPENING' and sl.source_type = 'opening' and x.legal_entity_id = $1 limit 1`, [w.legal_entity_id])).rowCount) {
        c.errors.push({ row: c.n, field: 'warehouse_code', message: 'Opening stock was already loaded for this legal entity' });
      }
      return { w, i, mfg, exp };
    },
    save: async (c, r, x) => {
      const { w, i, mfg, exp } = x as { w: { id: string }; i: { id: string }; mfg: string | null; exp: string | null };
      const released = r.qc_status!.toUpperCase() === 'RELEASED';
      const lot = (await c.tx.query(`insert into inv.lots (lot_no, item_id, mfg_date, expiry_date, source_type, source_id, qc_status, qc_decided_by, qc_decided_at, created_by)
          values ($1,$2,$3,$4,'OPENING',$2,$5,$6,$7,$6) returning id`, [r.lot_no, i.id, mfg, exp, released ? 'Released' : 'Quarantine', c.actor.userId, released ? new Date() : null])).rows[0].id;
      await c.tx.query(`insert into inv.stock_ledger (posted_at, item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
          values ($1,$2,$3,$4,$5,$6,$7,'OPENING','opening',$3,$8)`, [`${c.cutover}T00:00:00+05:30`, i.id, lot, w.id, released ? 'UNRESTRICTED' : 'QUARANTINE', Number(r.qty!.replace(/,/g, '')), Number(r.unit_cost!.replace(/,/g, '')), c.actor.userId]);
    } },

  'opening-receivables': { label: 'Open dealer invoices', perm: 'sys.import:opening',
    columns: [{ key: 'legal_entity_code', required: true, note: '', example: 'DAT' }, { key: 'dealer_code', required: true, note: 'Dealer code in this ERP', example: 'DLR-2026-0001' },
      { key: 'invoice_no', required: true, note: 'Number in the old system', example: 'T/2526/1187' }, { key: 'invoice_date', required: true, note: '', example: '2026-02-11' },
      { key: 'due_date', required: true, note: '', example: '2026-03-13' }, { key: 'outstanding', required: true, note: '₹ still to be received', example: '48500' }],
    check: async (c, r) => {
      need(c, r, 'legal_entity_code', 'dealer_code', 'invoice_no', 'invoice_date', 'due_date', 'outstanding');
      const le = await ref(c, r, 'legal_entity_code', LE, 'active legal entity');
      const p = await ref(c, r, 'dealer_code', `select p.id, p.gstin, (select id from mdm.party_addresses a where a.party_id = p.id and a.status = 'Active' order by is_default desc, created_at limit 1) as addr,
          (select state_code from mdm.party_addresses a where a.party_id = p.id and a.status = 'Active' order by is_default desc, created_at limit 1) as st, dp.credit_days
          from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id where p.code = $1`, 'dealer');
      if (p && !p.addr) c.errors.push({ row: c.n, field: 'dealer_code', message: 'The dealer has no address' });
      const d1 = date(c, r, 'invoice_date', true); const d2 = date(c, r, 'due_date', true);
      if (d1 && d2 && d2 < d1) c.errors.push({ row: c.n, field: 'due_date', message: 'Due before the invoice date' });
      if (d1 && c.cutover && d1 >= c.cutover) c.errors.push({ row: c.n, field: 'invoice_date', message: 'An opening invoice is dated before the cut-over' });
      num(c, r, 'outstanding', { min: 0.01, required: true });
      if (le && p && (await c.tx.query(`select 1 from sales.invoices where is_opening and party_id = $1 and opening_ref = $2`, [p.id, r.invoice_no])).rowCount) c.errors.push({ row: c.n, field: 'invoice_no', message: 'Already brought forward' });
      return { le, p, d1, d2 };
    },
    save: async (c, r, x) => {
      const { le, p, d1, d2 } = x as { le: { id: string }; p: { id: string; gstin: string | null; addr: string; st: string; credit_days: number }; d1: string; d2: string };
      const seller = (await c.tx.query(`select g.gstin, g.state_code from org.gst_registrations g where g.legal_entity_id = $1 and g.status = 'Active' order by g.gstin limit 1`, [le.id])).rows[0];
      const amt = Number(r.outstanding!.replace(/,/g, ''));
      const docNo = await nextDocNo(c.tx, 'OPENING_AR', { date: new Date(`${d1}T00:00:00Z`) });
      await c.tx.query(`insert into sales.invoices (doc_no, legal_entity_id, seller_state, seller_gstin, party_id, party_gstin, bill_to_id, ship_to_id, place_of_supply, inter_state, invoice_date, due_date,
          payment_terms, taxable_total, grand_total, is_opening, opening_ref, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$13,true,$14,$15,$15)`,
        [docNo, le.id, seller?.state_code ?? p.st, seller?.gstin ?? null, p.id, p.gstin, p.addr, p.st, (seller?.state_code ?? p.st) !== p.st, d1, d2, `Brought forward (${p.credit_days ?? 0} days)`, amt, r.invoice_no, c.actor.userId]);
    } },

  'opening-payables': { label: 'Open vendor bills', perm: 'sys.import:opening',
    columns: [{ key: 'legal_entity_code', required: true, note: '', example: 'DAT' }, { key: 'vendor_code', required: true, note: 'Vendor code in this ERP', example: 'VEN-2026-0003' },
      { key: 'bill_no', required: true, note: 'The vendor’s invoice number', example: 'MMPL/25-26/0931' }, { key: 'bill_date', required: true, note: '', example: '2026-03-02' },
      { key: 'due_date', required: true, note: '', example: '2026-04-01' }, { key: 'outstanding', required: true, note: '₹ still to be paid', example: '126000' }],
    check: async (c, r) => {
      need(c, r, 'legal_entity_code', 'vendor_code', 'bill_no', 'bill_date', 'due_date', 'outstanding');
      const le = await ref(c, r, 'legal_entity_code', LE, 'active legal entity');
      const p = await ref(c, r, 'vendor_code', `select p.id, p.gstin from mdm.parties p join mdm.vendor_profiles v on v.party_id = p.id where p.code = $1`, 'vendor');
      const d1 = date(c, r, 'bill_date', true); const d2 = date(c, r, 'due_date', true);
      if (d1 && d2 && d2 < d1) c.errors.push({ row: c.n, field: 'due_date', message: 'Due before the bill date' });
      if (d1 && c.cutover && d1 >= c.cutover) c.errors.push({ row: c.n, field: 'bill_date', message: 'An opening bill is dated before the cut-over' });
      num(c, r, 'outstanding', { min: 0.01, required: true });
      if (p && (await c.tx.query(`select 1 from purchase.supplier_invoices where party_id = $1 and invoice_no = $2 and status <> 'Cancelled'`, [p.id, r.bill_no])).rowCount) c.errors.push({ row: c.n, field: 'bill_no', message: 'This vendor bill is already in the ERP' });
      return { le, p, d1, d2 };
    },
    save: async (c, r, x) => {
      const { le, p, d1, d2 } = x as { le: { id: string }; p: { id: string }; d1: string; d2: string };
      const amt = Number(r.outstanding!.replace(/,/g, ''));
      const docNo = await nextDocNo(c.tx, 'OPENING_AP', { date: new Date(`${d1}T00:00:00Z`) });
      await c.tx.query(`insert into purchase.supplier_invoices (doc_no, party_id, invoice_no, invoice_date, due_date, inter_state, taxable_total, tax_total, grand_total, status, is_opening, legal_entity_id, created_by, updated_by)
          values ($1,$2,$3,$4,$5,false,$6,0,$6,'Approved',true,$7,$8,$8)`, [docNo, p.id, r.bill_no, d1, d2, amt, le.id, c.actor.userId]);
    } },

  'opening-ledger': { label: 'Opening trial balance', perm: 'sys.import:opening',
    columns: [{ key: 'legal_entity_code', required: true, note: '', example: 'DAT' }, { key: 'account_code', required: true, note: 'Chart of accounts code', example: '1200' },
      { key: 'party_code', note: 'Dealer or vendor code, for receivable and payable accounts', example: 'DLR-2026-0001' }, { key: 'debit', note: '₹', example: '48500' }, { key: 'credit', note: '₹', example: '' }],
    check: async (c, r) => {
      need(c, r, 'legal_entity_code', 'account_code');
      const le = await ref(c, r, 'legal_entity_code', LE, 'active legal entity');
      const a = await ref(c, r, 'account_code', `select id, system_key, party_ledger, name from fin.accounts where code = $1 and status = 'Active'`, 'active account');
      if (a && String(a.system_key ?? '').startsWith('INV_')) c.errors.push({ row: c.n, field: 'account_code', message: 'Inventory comes from the opening stock import, not the trial balance' });
      const p = await ref(c, r, 'party_code', `select id from mdm.parties where code = $1`, 'party');
      if (a?.party_ledger && !r.party_code) c.errors.push({ row: c.n, field: 'party_code', message: `${a.name} is kept by party: give the dealer or vendor code` });
      const dr = num(c, r, 'debit', { min: 0 }) ?? 0; const cr = num(c, r, 'credit', { min: 0 }) ?? 0;
      if (!dr === !cr) c.errors.push({ row: c.n, field: 'debit', message: 'Give either a debit or a credit' });
      if (le && (await c.tx.query(`select 1 from fin.journals where legal_entity_id = $1 and source_type = 'opening' and status = 'Posted'`, [le.id])).rowCount) c.errors.push({ row: c.n, field: 'legal_entity_code', message: 'The opening trial balance is already posted for this legal entity' });
      return { le, a, p, dr, cr };
    },
    save: async () => { /* posted as one journal per legal entity in after() */ },
    after: async (c, all) => {
      const byLe = new Map<string, { r: Row; x: { le: { id: string; code: string }; a: { id: string }; p: { id: string } | null; dr: number; cr: number } }[]>();
      for (const e of all as { r: Row; x: { le: { id: string; code: string }; a: { id: string }; p: { id: string } | null; dr: number; cr: number } }[]) byLe.set(e.x.le.id, [...(byLe.get(e.x.le.id) ?? []), e]);
      const out: Record<string, unknown> = {};
      for (const [le, rows] of byLe) {
        const dr = rows.reduce((s, e) => s + e.x.dr, 0); const cr = rows.reduce((s, e) => s + e.x.cr, 0);
        const diff = Math.round((dr - cr) * 100) / 100;
        const day = new Date(`${c.cutover}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - 1);
        // the difference is the stock value still to come from the opening stock import; it sits in opening balance equity until then
        await postJournal(c.tx, { le, date: day.toISOString().slice(0, 10), sourceType: 'opening', sourceId: le, sourceEvent: 'trial-balance', sourceRef: 'Opening balances',
          narration: `Opening trial balance at cut-over ${c.cutover}`, userId: c.actor.userId,
          lines: [...rows.map((e) => ({ accountId: e.x.a.id, debit: e.x.dr, credit: e.x.cr, partyId: e.x.p?.id ?? null })), ...(diff ? [{ key: 'OPENING_EQUITY', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0 }] : [])] });
        out[rows[0]!.x.le.code] = { debit: dr, credit: cr, toOpeningEquity: diff };
      }
      return out;
    } },
};

export const IMPORT_KINDS = Object.keys(KINDS);

type Result = { ok: boolean; rows: number; errors: Err[]; summary: Record<string, unknown> | null };
/** Thrown to roll the checking transaction back (lookups may have taken number-series values). */
class DryRun extends Error { constructor(public result: Result) { super('dry run'); } }

async function run(db: Db, actor: Actor, kind: string, rows: Row[], commit: boolean): Promise<Result> {
  const k = KINDS[kind]!;
  return withTx(db, async (tx): Promise<Result> => {
    const cutover = await getSetting<string | null>(tx, 'golive.cutoverDate', null);
    if (k.perm === 'sys.import:opening' && !cutover) throw Errors.rule('NO_CUTOVER_DATE', 'Set the cut-over date (Go-live → Cut-over) before loading opening balances.');
    const c: Ctx = { tx, actor, errors: [], n: 0, cutover };
    const checked: { r: Row; x: unknown }[] = [];
    const seen = new Map<string, number>();
    const uniqKey = ({ hsn: 'code', employees: 'emp_code', transporters: 'code', items: 'code', 'opening-stock': 'lot_no' } as Record<string, string>)[kind];
    for (const [i, r] of rows.entries()) {
      c.n = i + 2;                                     // spreadsheet row number (header is row 1)
      const unknown = Object.keys(r).filter((h) => !k.columns.some((col) => col.key === h));
      if (i === 0 && unknown.length) c.errors.push({ row: 1, field: unknown.join(', '), message: 'Unknown column — use the template' });
      if (uniqKey && r[uniqKey]) { const prev = seen.get(r[uniqKey]!); if (prev) c.errors.push({ row: c.n, field: uniqKey, message: `Same as row ${prev}` }); else seen.set(r[uniqKey]!, c.n); }
      checked.push({ r, x: await k.check(c, r) });
      if (c.errors.length >= 200) break;
    }
    if (!commit || c.errors.length) throw new DryRun({ ok: !c.errors.length, rows: rows.length, errors: c.errors, summary: null });
    await allowTransition(tx);
    for (const [i, e] of checked.entries()) { c.n = i + 2; await k.save(c, e.r, e.x); }
    const summary = k.after ? await k.after(c, checked) : {};
    return { ok: true, rows: rows.length, errors: [], summary };
  }).catch((e) => { if (e instanceof DryRun) return e.result; throw e; });
}

export function importRoutes(db: Db) {
  const r = Router();
  const kindOf = (req: { params: Record<string, string | undefined> }) => { const k = KINDS[req.params.kind!]; if (!k) throw Errors.notFound('Import'); return k; };

  r.get('/', asyncHandler(async (req, res) => {
    if (!can(req, 'sys.import:masters') && !can(req, 'sys.import:opening')) throw Errors.forbidden('sys.import:masters');
    const runs = (await db.query(`select r.id, r.kind, r.file_name as "fileName", r.status, r.row_count as "rowCount", jsonb_array_length(r.errors) as "errorCount", r.summary, r.created_at as "createdAt",
        r.committed_at as "committedAt", u.full_name as "by" from sys.import_runs r left join iam.users u on u.id = r.created_by order by r.created_at desc limit 100`)).rows;
    res.json({ kinds: Object.entries(KINDS).filter(([, k]) => can(req, k.perm)).map(([id, k]) => ({ id, label: k.label, group: k.perm === 'sys.import:opening' ? 'Opening balances' : 'Masters', columns: k.columns })),
      runs, cutoverDate: await getSetting(db, 'golive.cutoverDate', null) });
  }));

  r.get('/:kind/template', asyncHandler(async (req, res) => {
    const k = kindOf(req);
    if (!can(req, k.perm)) throw Errors.forbidden(k.perm);
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="import-${req.params.kind}.csv"`);
    res.send(`﻿${k.columns.map((c) => c.key).join(',')}\r\n${k.columns.map((c) => esc(c.example)).join(',')}\r\n`);
  }));

  // masters out in the same columns the import takes, for corrections in a spreadsheet or a move to another system
  const EXPORTS: Record<string, { perm: string; sql: string }> = {
    hsn: { perm: 'mdm.hsn:view', sql: `select code, description from mdm.hsn_codes order by code` },
    employees: { perm: 'org.employee:view', sql: `select e.emp_code, e.full_name, e.email, e.mobile, e.designation, d.code as department_code, m.emp_code as manager_emp_code, e.sales_tier, t.code as territory_code, e.status
        from org.employees e left join org.departments d on d.id = e.department_id left join org.employees m on m.id = e.manager_id left join org.territories t on t.id = e.territory_id order by e.emp_code` },
    transporters: { perm: 'logistics.shipment:view', sql: `select code, name, gstin, pan, contact, phone, status from logistics.transporters order by code` },
    items: { perm: 'mdm.item:view', sql: `select i.code, i.name, i.item_type, c.code as category_code, i.base_uom, h.code as hsn_code, i.shelf_life_days, p.pack_code, p.pack_size, p.pack_uom, p.container, p.units_per_box, i.status
        from mdm.items i left join mdm.product_categories c on c.id = i.category_id left join mdm.hsn_codes h on h.id = i.hsn_id left join mdm.item_packs p on p.item_id = i.id order by i.code, p.pack_code` },
    dealers: { perm: 'mdm.dealer:view', sql: `select p.code, p.legal_name, p.trade_name, p.constitution, p.pan, p.gstin, p.contact_person, p.mobile, p.email, a.line1 as address_line1, a.line2 as address_line2, a.city, a.district,
        a.state_code, a.pincode, d.dealer_category, t.code as territory_code, e.emp_code as sales_owner_emp_code, d.credit_days, d.credit_limit, d.status
        from mdm.dealer_profiles d join mdm.parties p on p.id = d.party_id left join lateral (select * from mdm.party_addresses x where x.party_id = p.id and x.status = 'Active' order by x.is_default desc, x.created_at limit 1) a on true
        left join org.territories t on t.id = d.territory_id left join org.employees e on e.id = d.sales_owner_id order by p.code` },
    vendors: { perm: 'mdm.vendor:view', sql: `select p.code, p.legal_name, p.trade_name, p.constitution, p.pan, p.gstin, p.contact_person, p.mobile, p.email, a.line1 as address_line1, a.line2 as address_line2, a.city, a.district,
        a.state_code, a.pincode, v.vendor_category, v.payment_terms_days, v.status
        from mdm.vendor_profiles v join mdm.parties p on p.id = v.party_id left join lateral (select * from mdm.party_addresses x where x.party_id = p.id and x.status = 'Active' order by x.is_default desc, x.created_at limit 1) a on true order by p.code` },
  };
  r.get('/export/:kind', asyncHandler(async (req, res) => {
    const x = EXPORTS[req.params.kind!];
    if (!x) throw Errors.notFound('Export');
    if (!can(req, x.perm)) throw Errors.forbidden(x.perm);
    const q = await db.query(x.sql);
    const esc = (v: unknown) => { const t = v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${req.params.kind}.csv"`);
    res.send(`\uFEFF${[q.fields.map((f) => f.name).join(','), ...q.rows.map((row) => q.fields.map((f) => esc(row[f.name])).join(','))].join('\r\n')}\r\n`);
  }));

  for (const action of ['validate', 'commit'] as const) {
    r.post(`/:kind/${action}`, asyncHandler(async (req, res) => {
      const k = kindOf(req);
      if (!can(req, k.perm)) throw Errors.forbidden(k.perm);
      const d = parse(z.object({ content: z.string().min(5).max(5_000_000), fileName: z.string().max(200).optional() }), req.body);
      const rows = parseCsv(d.content);
      if (rows.length > 20000) throw Errors.rule('TOO_MANY_ROWS', 'Split the file: at most 20,000 rows at a time.');
      const out = await run(db, actorOf(req), req.params.kind!, rows, action === 'commit');
      const status = !out.ok ? 'Failed' : action === 'commit' ? 'Committed' : 'Validated';
      await withTx(db, async (tx) => {
        const id = (await tx.query(`insert into sys.import_runs (kind, file_name, status, row_count, errors, summary, created_by, committed_at) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [req.params.kind, d.fileName ?? null, status, rows.length, JSON.stringify(out.errors), JSON.stringify(out.summary ?? {}), req.auth!.user.id, status === 'Committed' ? new Date() : null])).rows[0].id;
        if (status === 'Committed') await audit(tx, actorOf(req), { action: `sys.import.${req.params.kind}`, entityType: 'sys.import_run', entityId: id, after: { rows: rows.length, file: d.fileName, summary: out.summary } });
      });
      if (action === 'commit' && !out.ok) throw Errors.rule('IMPORT_INVALID', 'Nothing was imported: correct the rows listed and try again.', out.errors);
      res.json(out);
    }));
  }
  return r;
}
