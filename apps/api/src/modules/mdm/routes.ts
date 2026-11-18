import { Router } from 'express';
import { hsnSchema, itemPackSchema, itemSchema, productCategorySchema, reasonSchema, taxRateSchema, uomConversionSchema, uomSchema } from '@dhruv/contracts';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit, diff } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { lifecycleRoutes } from '../org/lifecycle';

async function activeRef(tx: Tx, sql: string, id: unknown, label: string) {
  if (!id) return null;
  const r = (await tx.query(sql, [id])).rows[0];
  if (!r) throw Errors.rule('REFERENCE_INVALID', `${label} does not exist.`);
  if (r.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', `${label} is ${r.status}. Only active masters can be used (MDM-005).`);
  return r;
}

/** Effective GST rate for an HSN on a date (used by quotations and invoices from Stage 2 on). */
export async function effectiveTaxRate(db: Db | Tx, hsnId: string, onDate: string) {
  const r = await db.query(
    `select gst_rate as "gstRate", cess_rate as "cessRate", valid_from as "validFrom", valid_to as "validTo" from mdm.tax_rates
      where hsn_id = $1 and valid_from <= $2::date and (valid_to is null or valid_to >= $2::date)`, [hsnId, onDate]);
  return r.rows[0] ?? null;
}

export function mdmRoutes(db: Db) {
  const r = Router();

  // ------------------------------------------------------------------ units of measure
  r.get('/uom', requirePermission('mdm.uom:view'), asyncHandler(async (_req, res) => {
    const units = await db.query(`select code, name, dimension, decimals, status from mdm.uom order by dimension, code`);
    const conv = await db.query(
      `select c.id, c.item_id as "itemId", i.code as "itemCode", c.from_uom as "fromUom", c.to_uom as "toUom", c.factor
         from mdm.uom_conversions c left join mdm.items i on i.id = c.item_id order by i.code nulls first, c.from_uom`);
    res.json({ data: units.rows, conversions: conv.rows });
  }));
  r.post('/uom', requirePermission('mdm.uom:configure'), asyncHandler(async (req, res) => {
    const d = parse(uomSchema, req.body);
    await withTx(db, async (tx) => {
      await tx.query(`insert into mdm.uom (code, name, dimension, decimals, created_by) values ($1,$2,$3,$4,$5)`, [d.code, d.name, d.dimension, d.decimals, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.uom.created', entityType: 'mdm.uom', entityId: d.code, after: d });
    });
    res.status(201).json({ code: d.code });
  }));
  r.post('/uom/conversions', requirePermission('mdm.uom:configure'), asyncHandler(async (req, res) => {
    const d = parse(uomConversionSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const units = (await tx.query(`select code, dimension from mdm.uom where code = any($1)`, [[d.fromUom, d.toUom]])).rows;
      if (units.length !== 2) throw Errors.rule('REFERENCE_INVALID', 'Unknown unit.');
      // cross-dimension conversions (e.g. kg <-> L) need an item, because they depend on density
      if (units[0].dimension !== units[1].dimension && !d.itemId) throw Errors.rule('ITEM_REQUIRED', 'Converting between mass and volume depends on the product: choose an item.');
      const ins = await tx.query(`insert into mdm.uom_conversions (item_id, from_uom, to_uom, factor, created_by) values ($1,$2,$3,$4,$5) returning id`,
        [d.itemId ?? null, d.fromUom, d.toUom, d.factor, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.uom_conversion.created', entityType: 'mdm.uom', entityId: `${d.fromUom}->${d.toUom}`, after: d });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));

  // ------------------------------------------------------------------ HSN codes & effective-dated GST rates
  r.get('/hsn-codes', requirePermission('mdm.hsn:view'), asyncHandler(async (req, res) => {
    const q = str(req.query.q);
    const rows = await db.query(
      `select h.id, h.code, h.kind, h.description, h.status, h.version,
              cr.gst_rate as "currentRate", cr.valid_from as "rateFrom"
         from mdm.hsn_codes h
         left join lateral (select gst_rate, valid_from from mdm.tax_rates t where t.hsn_id = h.id and t.valid_from <= current_date
                              and (t.valid_to is null or t.valid_to >= current_date)) cr on true
        where $1::text is null or h.code like $1 || '%' or h.description ilike '%' || $1 || '%'
        order by h.code limit 200`, [q ?? null]);
    res.json({ data: rows.rows, total: rows.rowCount });
  }));
  r.get('/hsn-codes/:id', requirePermission('mdm.hsn:view'), asyncHandler(async (req, res) => {
    const h = (await db.query(`select id, code, kind, description, status, version from mdm.hsn_codes where id = $1`, [req.params.id])).rows[0];
    if (!h) throw Errors.notFound('HSN code');
    const rates = (await db.query(
      `select t.id, t.gst_rate as "gstRate", t.cess_rate as "cessRate", t.valid_from as "validFrom", t.valid_to as "validTo", t.notes,
              t.created_at as "createdAt", u.full_name as "createdBy"
         from mdm.tax_rates t left join iam.users u on u.id = t.created_by where t.hsn_id = $1 order by t.valid_from desc`, [h.id])).rows;
    res.json({ ...h, rates, canAddRate: can(req, 'mdm.tax_rate:configure') });
  }));
  r.post('/hsn-codes', requirePermission('mdm.hsn:create'), asyncHandler(async (req, res) => {
    const d = parse(hsnSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const ins = await tx.query(`insert into mdm.hsn_codes (code, kind, description, created_by, updated_by) values ($1,$2,$3,$4,$4) returning *`,
        [d.code, d.kind, d.description, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.hsn.created', entityType: 'mdm.hsn', entityId: ins.rows[0].id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  // A new rate closes the previous open period the day before it starts. History is never edited (D27).
  r.post('/hsn-codes/:id/rates', requirePermission('mdm.tax_rate:configure'), asyncHandler(async (req, res) => {
    const d = parse(taxRateSchema, req.body);
    await withTx(db, async (tx) => {
      const h = (await tx.query(`select id, code from mdm.hsn_codes where id = $1 for update`, [req.params.id])).rows[0];
      if (!h) throw Errors.notFound('HSN code');
      const open = (await tx.query(`select id, valid_from from mdm.tax_rates where hsn_id = $1 and valid_to is null`, [h.id])).rows[0];
      if (open) {
        if (new Date(d.validFrom) <= new Date(open.valid_from)) throw Errors.rule('RATE_DATE_INVALID', 'The new rate must start after the current rate’s start date.');
        await tx.query(`update mdm.tax_rates set valid_to = $2::date - 1 where id = $1`, [open.id, d.validFrom]);
      }
      const later = await tx.query(`select 1 from mdm.tax_rates where hsn_id = $1 and valid_from >= $2::date`, [h.id, d.validFrom]);
      if (later.rowCount) throw Errors.rule('RATE_DATE_INVALID', 'A rate already starts on or after this date.');
      await tx.query(`insert into mdm.tax_rates (hsn_id, gst_rate, cess_rate, valid_from, notes, created_by) values ($1,$2,$3,$4,$5,$6)`,
        [h.id, d.gstRate, d.cessRate, d.validFrom, d.notes, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.tax_rate.added', entityType: 'mdm.hsn', entityId: h.id, after: { hsn: h.code, ...d }, reason: d.notes });
    });
    res.status(201).json({ ok: true });
  }));
  r.get('/tax-rates/effective', requirePermission('mdm.hsn:view'), asyncHandler(async (req, res) => {
    const hsnId = str(req.query.hsnId);
    if (!hsnId) throw Errors.validation([{ field: 'hsnId', message: 'Required' }]);
    const rate = await effectiveTaxRate(db, hsnId, str(req.query.date) ?? new Date().toISOString().slice(0, 10));
    if (!rate) throw Errors.rule('NO_TAX_RATE', 'No GST rate is configured for this HSN on that date.');
    res.json(rate);
  }));

  // ------------------------------------------------------------------ product categories
  r.get('/product-categories', requirePermission('mdm.product_category:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(
      `select c.id, c.code, c.name, c.licence_required as "licenceRequired", c.status, c.version,
              (select count(*) from mdm.items i where i.category_id = c.id and i.status <> 'Inactive') as items
         from mdm.product_categories c order by c.name`)).rows });
  }));
  r.post('/product-categories', requirePermission('mdm.product_category:create'), asyncHandler(async (req, res) => {
    const d = parse(productCategorySchema, req.body);
    const id = await withTx(db, async (tx) => {
      const ins = await tx.query(`insert into mdm.product_categories (code, name, licence_required, created_by, updated_by) values ($1,$2,$3,$4,$4) returning *`,
        [d.code, d.name, d.licenceRequired, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.product_category.created', entityType: 'mdm.product_category', entityId: ins.rows[0].id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.put('/product-categories/:id', requirePermission('mdm.product_category:edit'), asyncHandler(async (req, res) => {
    const d = parse(productCategorySchema, req.body);
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from mdm.product_categories where id = $1 for update`, [req.params.id])).rows[0];
      if (!before) throw Errors.notFound('Category');
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      const after = (await tx.query(`update mdm.product_categories set code=$2, name=$3, licence_required=$4, updated_by=$5 where id=$1 returning *`,
        [before.id, d.code, d.name, d.licenceRequired, req.auth!.user.id])).rows[0];
      const df = diff(before, after);
      await audit(tx, actorOf(req), { action: 'mdm.product_category.updated', entityType: 'mdm.product_category', entityId: before.id, before: df.before, after: df.after, reason });
    });
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------------ items (maker-checker lifecycle)
  const itemCols = { code: 'code', name: 'name', itemType: 'item_type', categoryId: 'category_id', baseUom: 'base_uom', hsnId: 'hsn_id', formulation: 'formulation',
    shelfLifeDays: 'shelf_life_days', storageClass: 'storage_class', lotControlled: 'lot_controlled', serialControlled: 'serial_controlled', hazardous: 'hazardous' };
  r.use('/items', lifecycleRoutes(db, {
    resource: 'mdm.item', table: 'mdm.items', label: 'Item', schema: itemSchema, scopeColumn: null, columns: itemCols,
    select: `t.id, t.code, t.name, t.item_type as "itemType", t.category_id as "categoryId", c.name as "categoryName", c.licence_required as "licenceRequired",
             t.base_uom as "baseUom", t.hsn_id as "hsnId", h.code as "hsnCode", t.formulation, t.shelf_life_days as "shelfLifeDays", t.storage_class as "storageClass",
             t.lot_controlled as "lotControlled", t.serial_controlled as "serialControlled", t.hazardous, t.status, t.version,
             t.created_at as "createdAt", t.updated_at as "updatedAt",
             (select count(*) from mdm.item_packs p where p.item_id = t.id and p.status = 'Active') as "packCount"`,
    from: `from mdm.items t left join mdm.product_categories c on c.id = t.category_id left join mdm.hsn_codes h on h.id = t.hsn_id`,
    validateWrite: async (tx, d) => {
      const u = (await tx.query(`select status from mdm.uom where code = $1`, [d.baseUom])).rows[0];
      if (!u || u.status !== 'Active') throw Errors.rule('REFERENCE_INVALID', 'Base unit is unknown or inactive.');
    },
    validateSubmit: async (tx, row) => {
      await activeRef(tx, `select status from mdm.product_categories where id = $1`, row.category_id, 'Category');
      await activeRef(tx, `select status from mdm.hsn_codes where id = $1`, row.hsn_id, 'HSN code');
      const missing: { field: string; message: string }[] = [];
      if (['FG', 'RM', 'PM'].includes(row.item_type as string)) {
        if (!row.hsn_id) missing.push({ field: 'hsnId', message: 'HSN is required for stock items' });
        if (!row.category_id) missing.push({ field: 'categoryId', message: 'Category is required' });
      }
      if (['FG', 'RM'].includes(row.item_type as string) && !row.shelf_life_days) missing.push({ field: 'shelfLifeDays', message: 'Shelf life is required for FG and RM' });
      if (missing.length) throw Errors.rule('FIELD_REQUIRED', 'Complete the required fields before submitting.', missing);
      if (row.item_type === 'FG') {
        const packs = await tx.query(`select 1 from mdm.item_packs where item_id = $1 and status = 'Active'`, [row.id]);
        if (!packs.rowCount) throw Errors.rule('PACK_REQUIRED', 'A finished-goods item needs at least one pack size before submission.');
      }
    },
    extraDetail: async (dbx, row) => ({
      packs: (await dbx.query(
        `select id, pack_code as "packCode", pack_size as "packSize", pack_uom as "packUom", container, units_per_box as "unitsPerBox", gtin, status
           from mdm.item_packs where item_id = $1 order by pack_size`, [row.id])).rows,
    }),
  }));
  r.post('/items/:id/packs', requirePermission('mdm.item:edit_draft'), asyncHandler(async (req, res) => {
    const d = parse(itemPackSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const item = (await tx.query(`select id, status from mdm.items where id = $1 for update`, [req.params.id])).rows[0];
      if (!item) throw Errors.notFound('Item');
      if (!['Draft', 'Rejected'].includes(item.status)) throw Errors.state('Pack sizes can be changed while the item is Draft or Rejected.');
      const u = (await tx.query(`select status from mdm.uom where code = $1`, [d.packUom])).rows[0];
      if (!u || u.status !== 'Active') throw Errors.rule('REFERENCE_INVALID', 'Pack unit is unknown or inactive.');
      const ins = await tx.query(
        `insert into mdm.item_packs (item_id, pack_code, pack_size, pack_uom, container, units_per_box, gtin, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [item.id, d.packCode, d.packSize, d.packUom, d.container, d.unitsPerBox, d.gtin ?? null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.item_pack.added', entityType: 'mdm.item', entityId: item.id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.post('/items/:id/packs/:packId/deactivate', requirePermission('mdm.item:edit_draft'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const item = (await tx.query(`select id, status from mdm.items where id = $1 for update`, [req.params.id])).rows[0];
      if (!item) throw Errors.notFound('Item');
      if (!['Draft', 'Rejected'].includes(item.status)) throw Errors.state('Pack sizes can be changed while the item is Draft or Rejected.');
      const p = await tx.query(`update mdm.item_packs set status = 'Inactive' where id = $1 and item_id = $2 returning pack_code`, [req.params.packId, item.id]);
      if (!p.rowCount) throw Errors.notFound('Pack');
      await audit(tx, actorOf(req), { action: 'mdm.item_pack.deactivated', entityType: 'mdm.item', entityId: item.id, after: p.rows[0], reason });
    });
    res.json({ ok: true });
  }));

  return r;
}
