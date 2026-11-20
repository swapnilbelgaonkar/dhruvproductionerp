import { Router } from 'express';
import { priceListItemSchema, priceListSchema } from '@dhruv/contracts';
import { withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf } from '../../middleware/context';
import { lifecycleRoutes } from '../org/lifecycle';

/** Active price for a dealer price group and pack on a date (CRM-010). */
export async function priceFor(dbx: Db | Tx, priceGroup: string, itemPackId: string, onDate: string) {
  const r = (await dbx.query(
    `select pl.id as price_list_id, pl.code, i.id as item_id, i.rate,
            coalesce((select json_agg(json_build_object('minQty', s.min_qty::float, 'discountPct', s.discount_pct::float)) from sales.price_slabs s where s.price_list_item_id = i.id), '[]') as slabs
       from sales.price_lists pl join sales.price_list_items i on i.price_list_id = pl.id
      where pl.price_group = $1 and pl.status = 'Active' and i.item_pack_id = $2 and pl.valid_from <= $3::date and (pl.valid_to is null or pl.valid_to >= $3::date)
      order by pl.valid_from desc limit 1`, [priceGroup, itemPackId, onDate])).rows[0];
  return r as { price_list_id: string; code: string; rate: string; slabs: { minQty: number; discountPct: number }[] } | undefined;
}

/**
 * Active lists of the same group whose dates overlap this one and that it cannot supersede (they start on or after it).
 * An older list is superseded instead: on approval its validity is closed the day before the new list starts.
 */
async function overlapping(tx: Tx, row: Record<string, unknown>) {
  return (await tx.query(
    `select code from sales.price_lists where id <> $1 and price_group = $2 and status = 'Active' and valid_from >= $3::date
        and daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') && daterange($3::date, coalesce($4::date, 'infinity'::date), '[]')`,
    [row.id, row.price_group, row.valid_from, row.valid_to])).rows;
}

async function supersedeOlder(tx: Tx, id: string, actor: Actor) {
  const pl = (await tx.query(`select price_group, valid_from from sales.price_lists where id = $1`, [id])).rows[0];
  const closed = (await tx.query(
    `update sales.price_lists set valid_to = $3::date - 1, updated_by = $4 where id <> $1 and price_group = $2 and status = 'Active'
        and valid_from < $3::date and (valid_to is null or valid_to >= $3::date) returning id, code, valid_to`, [id, pl.price_group, pl.valid_from, actor.userId])).rows;
  for (const c of closed) await audit(tx, actor, { action: 'sales.price_list.superseded', entityType: 'sales.price_list', entityId: c.id, after: { validTo: c.valid_to, by: id } });
}

export function pricingRoutes(db: Db) {
  const r = Router();
  const editable = async (tx: Tx, id: string) => {
    const pl = (await tx.query(`select * from sales.price_lists where id = $1 for update`, [id])).rows[0];
    if (!pl) throw Errors.notFound('Price list');
    if (!['Draft', 'Rejected'].includes(pl.status)) throw Errors.state('Prices can be changed while the list is Draft or Rejected. Copy it to create a new version.');
    return pl;
  };

  // packs that can be priced: active packs of active finished goods
  r.get('/saleable-packs', requirePermission('sales.price_list:view'), asyncHandler(async (_req, res) => {
    const rows = await db.query(
      `select p.id, i.code as "itemCode", i.name as "itemName", p.pack_code as "packCode", p.pack_size as "packSize", p.pack_uom as "packUom", p.container
         from mdm.item_packs p join mdm.items i on i.id = p.item_id where p.status = 'Active' and i.status = 'Active' and i.item_type = 'FG' order by i.code, p.pack_size`);
    res.json({ data: rows.rows });
  }));

  r.get('/:id/items', requirePermission('sales.price_list:view'), asyncHandler(async (req, res) => {
    const rows = await db.query(
      `select i.id, i.item_pack_id as "itemPackId", it.code as "itemCode", it.name as "itemName", p.pack_code as "packCode", p.pack_size as "packSize", p.pack_uom as "packUom",
              p.container, i.rate,
              coalesce((select json_agg(json_build_object('minQty', s.min_qty, 'discountPct', s.discount_pct) order by s.min_qty) from sales.price_slabs s where s.price_list_item_id = i.id), '[]') as slabs
         from sales.price_list_items i join mdm.item_packs p on p.id = i.item_pack_id join mdm.items it on it.id = p.item_id
        where i.price_list_id = $1 order by it.code, p.pack_size`, [req.params.id]);
    res.json({ data: rows.rows });
  }));

  // add or replace the price of one pack (with its volume slabs)
  r.post('/:id/items', requirePermission('sales.price_list:edit_draft'), asyncHandler(async (req, res) => {
    const d = parse(priceListItemSchema, req.body);
    await withTx(db, async (tx) => {
      const pl = await editable(tx, req.params.id!);
      const pack = (await tx.query(
        `select p.status, i.status as item_status, i.item_type, i.code from mdm.item_packs p join mdm.items i on i.id = p.item_id where p.id = $1`, [d.itemPackId])).rows[0];
      if (!pack || pack.status !== 'Active' || pack.item_status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Only active packs of approved items can be priced.');
      if (pack.item_type !== 'FG') throw Errors.rule('ITEM_NOT_SALEABLE', `${pack.code} is not a finished good.`);
      const item = (await tx.query(
        `insert into sales.price_list_items (price_list_id, item_pack_id, rate, created_by) values ($1,$2,$3,$4)
         on conflict (price_list_id, item_pack_id) do update set rate = excluded.rate returning id`, [pl.id, d.itemPackId, d.rate, req.auth!.user.id])).rows[0];
      await tx.query(`delete from sales.price_slabs where price_list_item_id = $1`, [item.id]);
      for (const s of d.slabs) await tx.query(`insert into sales.price_slabs (price_list_item_id, min_qty, discount_pct) values ($1,$2,$3)`, [item.id, s.minQty, s.discountPct]);
      await audit(tx, actorOf(req), { action: 'sales.price.set', entityType: 'sales.price_list', entityId: pl.id, after: d });
    });
    res.status(201).json({ ok: true });
  }));

  r.post('/:id/items/:itemId/remove', requirePermission('sales.price_list:edit_draft'), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const pl = await editable(tx, req.params.id!);
      const x = await tx.query(`delete from sales.price_list_items where id = $1 and price_list_id = $2 returning item_pack_id`, [req.params.itemId, pl.id]);
      if (!x.rowCount) throw Errors.notFound('Price');
      await audit(tx, actorOf(req), { action: 'sales.price.removed', entityType: 'sales.price_list', entityId: pl.id, after: x.rows[0] });
    });
    res.json({ ok: true });
  }));

  // New version of a list (price revision): same prices and slabs, new code and dates, starts as Draft.
  r.post('/:id/copy', requirePermission('sales.price_list:create'), asyncHandler(async (req, res) => {
    const d = parse(priceListSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const src = (await tx.query(`select id from sales.price_lists where id = $1`, [req.params.id])).rows[0];
      if (!src) throw Errors.notFound('Price list');
      const pl = (await tx.query(
        `insert into sales.price_lists (code, name, price_group, valid_from, valid_to, notes, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id`,
        [d.code, d.name, d.priceGroup, d.validFrom, d.validTo ?? null, d.notes, req.auth!.user.id])).rows[0];
      const items = (await tx.query(`select id, item_pack_id, rate from sales.price_list_items where price_list_id = $1`, [src.id])).rows;
      for (const it of items) {
        const n = (await tx.query(`insert into sales.price_list_items (price_list_id, item_pack_id, rate, created_by) values ($1,$2,$3,$4) returning id`, [pl.id, it.item_pack_id, it.rate, req.auth!.user.id])).rows[0];
        await tx.query(`insert into sales.price_slabs (price_list_item_id, min_qty, discount_pct) select $1, min_qty, discount_pct from sales.price_slabs where price_list_item_id = $2`, [n.id, it.id]);
      }
      await audit(tx, actorOf(req), { action: 'sales.price_list.copied', entityType: 'sales.price_list', entityId: pl.id, after: { from: src.id, ...d } });
      return pl.id;
    });
    res.status(201).json({ id });
  }));

  r.use('/', lifecycleRoutes(db, {
    resource: 'sales.price_list', table: 'sales.price_lists', label: 'Price list', schema: priceListSchema, scopeColumn: null,
    columns: { code: 'code', name: 'name', priceGroup: 'price_group', validFrom: 'valid_from', validTo: 'valid_to', notes: 'notes' },
    select: `t.id, t.code, t.name, t.price_group as "priceGroup", t.valid_from as "validFrom", t.valid_to as "validTo", t.notes, t.status, t.version,
             t.created_at as "createdAt", t.updated_at as "updatedAt", (select count(*) from sales.price_list_items i where i.price_list_id = t.id) as "itemCount"`,
    from: `from sales.price_lists t`,
    validateSubmit: async (tx, row) => {
      const n = Number((await tx.query(`select count(*) from sales.price_list_items where price_list_id = $1`, [row.id])).rows[0].count);
      if (!n) throw Errors.rule('PRICE_LIST_EMPTY', 'Add at least one product price before submitting.');
      const o = await overlapping(tx, row);
      if (o.length) throw Errors.rule('PRICE_LIST_OVERLAP', `Active list ${o.map((x) => x.code).join(', ')} for price group ${row.price_group} starts on or after this list. A new list must start later than the one it replaces.`);
    },
    onActivated: supersedeOlder,
  }));
  return r;
}
