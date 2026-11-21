import { Router } from 'express';
import { z } from 'zod';
import { authorityLimitSchema, numberSeriesFormatSchema, reasonSchema } from '@dhruv/contracts';
import { withTx, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { financialYear } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, legalEntityScope, territoryScope } from '../../middleware/context';

export function auditRoutes(db: Db) {
  const r = Router();
  const filters = (q: Record<string, unknown>) => {
    const args: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (str(q.entityType)) add('a.entity_type = ?', str(q.entityType));
    if (str(q.entityId)) add('a.entity_id = ?', str(q.entityId));
    if (str(q.actorId)) add('a.actor_id = ?::uuid', str(q.actorId));
    if (str(q.action)) add('a.action ilike ?', `%${str(q.action)}%`);
    if (str(q.from)) add('a.occurred_at >= ?::date', str(q.from));
    if (str(q.to)) add(`a.occurred_at < (?::date + 1)`, str(q.to));
    return { args, w: where.length ? `where ${where.join(' and ')}` : '' };
  };

  r.get('/', requirePermission('sys.audit:view'), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const { args, w } = filters(req.query);
    const rows = await db.query(
      `select a.seq, a.occurred_at as "occurredAt", a.actor_label as actor, a.action, a.entity_type as "entityType", a.entity_id as "entityId",
              a.before, a.after, a.reason, a.ip, count(*) over() as total
         from sys.audit_events a ${w} order by a.seq desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/export.csv', requirePermission('sys.audit:export'), asyncHandler(async (req, res) => {
    const { args, w } = filters(req.query);
    const rows = await db.query(
      `select a.seq, a.occurred_at, a.actor_label, a.action, a.entity_type, a.entity_id, a.reason, a.ip, a.hash
         from sys.audit_events a ${w} order by a.seq desc limit 50000`, args);
    await withTx(db, (tx) => audit(tx, actorOf(req), { action: 'sys.audit.exported', entityType: 'sys.audit', after: { filters: req.query, rows: rows.rowCount } }));
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['seq,occurred_at,actor,action,entity_type,entity_id,reason,ip,hash',
      ...rows.rows.map((x) => [x.seq, new Date(x.occurred_at).toISOString(), x.actor_label, x.action, x.entity_type, x.entity_id, x.reason, x.ip, x.hash].map(esc).join(','))].join('\n');
    res.type('text/csv').attachment('audit-log.csv').send(csv);
  }));

  r.post('/verify', requirePermission('sys.audit:verify'), asyncHandler(async (req, res) => {
    const out = (await db.query(`select checked, first_broken_seq as "firstBrokenSeq" from sys.verify_audit_chain()`)).rows[0];
    await withTx(db, (tx) => audit(tx, actorOf(req), { action: 'sys.audit.verified', entityType: 'sys.audit', after: out }));
    res.json({ ...out, intact: out.firstBrokenSeq === null });
  }));
  return r;
}

export function adminRoutes(db: Db) {
  const r = Router();

  r.get('/settings', requirePermission('sys.settings:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select s.key, s.value, s.description, s.updated_at as "updatedAt", u.full_name as "updatedBy"
      from sys.settings s left join iam.users u on u.id = s.updated_by order by s.key`)).rows });
  }));
  r.put('/settings/:key', requirePermission('sys.settings:configure'), asyncHandler(async (req, res) => {
    const { value, reason } = parse(z.object({ value: z.union([z.number(), z.string(), z.boolean()]), reason: reasonSchema.shape.reason }), req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select value from sys.settings where key = $1 for update`, [req.params.key])).rows[0];
      if (!before) throw Errors.notFound('Setting');
      if (typeof before.value !== typeof value) throw Errors.validation([{ field: 'value', message: `Expected a ${typeof before.value}` }]);
      if (typeof value === 'number' && value <= 0) throw Errors.validation([{ field: 'value', message: 'Must be positive' }]);
      await tx.query(`update sys.settings set value = $2, updated_at = now(), updated_by = $3 where key = $1`, [req.params.key, JSON.stringify(value), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'sys.setting.changed', entityType: 'sys.setting', entityId: req.params.key, before: before.value, after: value, reason });
    });
    res.json({ ok: true });
  }));

  r.get('/number-series', requirePermission('sys.number_series:view'), asyncHandler(async (_req, res) => {
    const fy = financialYear(new Date());
    res.json({ fy, data: (await db.query(
      `select f.doc_type as "docType", f.prefix, f.padding, f.description,
              (select coalesce(sum(n.next_value - 1), 0) from sys.number_series n where n.doc_type = f.doc_type and n.fy = $1) as "issuedThisYear"
         from sys.number_series_formats f order by f.doc_type`, [fy])).rows });
  }));
  r.put('/number-series/:docType', requirePermission('sys.number_series:configure'), asyncHandler(async (req, res) => {
    const d = parse(numberSeriesFormatSchema, req.body);
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select prefix, padding from sys.number_series_formats where doc_type = $1 for update`, [req.params.docType])).rows[0];
      if (!before) throw Errors.notFound('Number series');
      await tx.query(`update sys.number_series_formats set prefix = $2, padding = $3 where doc_type = $1`, [req.params.docType, d.prefix, d.padding]);
      await audit(tx, actorOf(req), { action: 'sys.number_series.changed', entityType: 'sys.number_series', entityId: req.params.docType, before, after: d, reason });
    });
    res.json({ ok: true });
  }));

  r.get('/authority-limits', requirePermission('iam.authority_limit:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(
      `select a.tier, a.rank, a.title, a.max_discount_pct as "maxDiscountPct", a.max_order_value as "maxOrderValue", a.can_approve as "canApprove",
              a.active, a.updated_at as "updatedAt", u.full_name as "updatedBy", a.version
         from iam.authority_limits a left join iam.users u on u.id = a.updated_by order by a.rank`)).rows });
  }));
  r.put('/authority-limits/:tier', requirePermission('iam.authority_limit:configure'), asyncHandler(async (req, res) => {
    const d = parse(authorityLimitSchema, req.body);
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from iam.authority_limits where tier = $1 for update`, [req.params.tier])).rows[0];
      if (!before) throw Errors.notFound('Tier');
      if (before.version !== d.version) throw Errors.concurrent();
      await tx.query(`update iam.authority_limits set max_discount_pct = $2, max_order_value = $3, updated_by = $4 where tier = $1`,
        [req.params.tier, d.maxDiscountPct, d.maxOrderValue, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'iam.authority_limit.changed', entityType: 'iam.authority_limit', entityId: req.params.tier,
        before: { maxDiscountPct: before.max_discount_pct, maxOrderValue: before.max_order_value }, after: d, reason });
    });
    res.json({ ok: true });
  }));
  // D15: activation is a separate, audited executive act. The person who last edited a limit cannot activate (maker-checker).
  r.post('/authority-limits/activate', requirePermission('iam.authority_limit:configure'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const editors = (await tx.query(`select distinct updated_by from iam.authority_limits where updated_by is not null`)).rows.map((x) => x.updated_by);
      if (editors.includes(req.auth!.user.id)) throw Errors.sod('You edited these limits; a different executive must activate them.');
      await tx.query(`update iam.authority_limits set active = true`);
      await audit(tx, actorOf(req), { action: 'iam.authority_limits.activated', entityType: 'iam.authority_limit', reason });
    });
    res.json({ ok: true });
  }));
  return r;
}

export function dashboardRoutes(db: Db) {
  const r = Router();
  r.get('/overview', asyncHandler(async (req, res) => {
    const me = req.auth!.user.id;
    const [pending, initiated, trend] = await Promise.all([
      db.query(`select count(distinct s.request_id) as n, count(distinct s.request_id) filter (where s.due_at < now()) as overdue
                  from wf.approval_steps s where s.step_kind = 'approve' and s.status in ('Pending','OnHold') and $1 = any(s.approver_ids)`, [me]),
      db.query(`select count(*) filter (where status in ('Pending','OnHold')) as open, count(*) filter (where status = 'Approved') as approved,
                       count(*) filter (where status in ('Rejected','Returned')) as rejected from wf.approval_requests where initiated_by = $1`, [me]),
      db.query(`select d::date as day,
                       (select count(*) from wf.approval_requests a where a.submitted_at::date = d::date) as submitted,
                       (select count(*) from wf.approval_requests a where a.completed_at::date = d::date and a.status = 'Approved') as approved
                  from generate_series(current_date - 13, current_date, interval '1 day') d order by d`),
    ]);
    const out: Record<string, unknown> = {
      myPendingApprovals: Number(pending.rows[0].n), myOverdueApprovals: Number(pending.rows[0].overdue),
      myRequests: initiated.rows[0], approvalTrend: trend.rows,
    };
    const leScope = can(req, 'org.legal_entity:view') ? legalEntityScope(req, 'org.plant:view') : [];
    if (can(req, 'org.plant:view') || can(req, 'org.warehouse:view') || can(req, 'org.legal_entity:view')) {
      const masters = await db.query(
        `select 'Legal entities' as master, status, count(*) as n from org.legal_entities where $1::uuid[] is null or id = any($1) group by status
         union all select 'Plants', status, count(*) from org.plants where $1::uuid[] is null or legal_entity_id = any($1) group by status
         union all select 'Warehouses', status, count(*) from org.warehouses where $1::uuid[] is null or legal_entity_id = any($1) group by status`, [leScope]);
      out.masters = masters.rows;
    }
    if (can(req, 'sys.dashboard:view_admin')) {
      const u = await db.query(`select count(*) filter (where status = 'Active') as active, count(*) filter (where status = 'Active' and mfa_enabled) as mfa,
                                       count(*) filter (where locked_until > now()) as locked from iam.users`);
      out.users = u.rows[0];
    }
    const activity = await db.query(
      `select a.seq, a.occurred_at as "occurredAt", a.actor_label as actor, a.action, a.entity_type as "entityType", a.entity_id as "entityId"
         from sys.audit_events a where ${can(req, 'sys.audit:view') ? 'true' : 'a.actor_id = $1'} and a.action not like 'auth.%'
        order by a.seq desc limit 8`, can(req, 'sys.audit:view') ? [] : [me]);
    out.recentActivity = activity.rows;
    res.json(out);
  }));
  return r;
}

export function searchRoutes(db: Db) {
  const r = Router();
  r.get('/', asyncHandler(async (req, res) => {
    const q = str(req.query.q);
    if (!q || q.length < 2) return res.json({ data: [] });
    const like = `%${q}%`;
    const parts: string[] = [];
    const scoped = (perm: string, col: string) => {
      const s = legalEntityScope(req, perm);
      return s === null ? 'true' : `${col} = any('{${s.join(',')}}'::uuid[])`;
    };
    if (can(req, 'org.legal_entity:view')) parts.push(`(select 'Legal entity' as type, id, code as title, name as subtitle, '/masters/legal-entities/' || id as href from org.legal_entities where (code ilike $1 or name ilike $1) and ${scoped('org.legal_entity:view', 'id')} limit 5)`);
    if (can(req, 'org.plant:view')) parts.push(`(select 'Plant', id, code, name, '/masters/plants/' || id from org.plants where (code ilike $1 or name ilike $1) and ${scoped('org.plant:view', 'legal_entity_id')} limit 5)`);
    if (can(req, 'org.warehouse:view')) parts.push(`(select 'Warehouse', id, code, name, '/masters/warehouses/' || id from org.warehouses where (code ilike $1 or name ilike $1) and ${scoped('org.warehouse:view', 'legal_entity_id')} limit 5)`);
    if (can(req, 'org.territory:view')) parts.push(`(select 'Territory', id, code, name, '/masters/territories?focus=' || id from org.territories where code ilike $1 or name ilike $1 limit 5)`);
    if (can(req, 'org.employee:view')) parts.push(`(select 'Employee', id, emp_code, full_name, '/masters/employees/' || id from org.employees where emp_code ilike $1 or full_name ilike $1 limit 5)`);
    if (can(req, 'mdm.dealer:view')) {
      const ids = await territoryScope(db, req, 'mdm.dealer:view');
      const scope = ids === null ? 'true' : `exists (select 1 from org.territories dt join org.territories ut on dt.path <@ ut.path where dt.id = dp.territory_id and ut.id = any('{${ids.join(',')}}'::uuid[]))`;
      parts.push(`(select 'Dealer', p.id, p.code, p.legal_name, '/sales/dealers/' || p.id from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id
                    where (p.code ilike $1 or p.legal_name ilike $1 or p.gstin ilike $1 or p.mobile like $1) and ${scope} limit 5)`);
    }
    for (const [perm, table, label, base] of [['crm.lead:view', 'sales.leads', 'Lead', '/sales/leads/'], ['crm.opportunity:view', 'sales.opportunities', 'Opportunity', '/sales/opportunities/']] as const) {
      if (!can(req, perm)) continue;
      const ids = await territoryScope(db, req, perm);
      const scope = ids === null ? 'true' : `exists (select 1 from org.territories rt join org.territories ut on rt.path <@ ut.path where rt.id = x.territory_id and ut.id = any('{${ids.join(',')}}'::uuid[]))`;
      parts.push(`(select '${label}', x.id, x.code, x.company, '${base}' || x.id from ${table} x where (x.code ilike $1 or x.company ilike $1) and ${scope} limit 5)`);
    }
    if (can(req, 'sales.quotation:view')) {
      const ids = await territoryScope(db, req, 'sales.quotation:view');
      const scope = ids === null ? 'true' : `exists (select 1 from org.territories rt join org.territories ut on rt.path <@ ut.path where rt.id = q.territory_id and ut.id = any('{${ids.join(',')}}'::uuid[]))`;
      parts.push(`(select 'Quotation', q.id, q.doc_no || ' R' || q.revision, p.legal_name, '/sales/quotations/' || q.id from sales.quotations q join mdm.parties p on p.id = q.party_id
                    where q.status <> 'Superseded' and (q.doc_no ilike $1 or p.legal_name ilike $1) and ${scope} limit 5)`);
    }
    if (can(req, 'sales.order:view')) {
      const ids = await territoryScope(db, req, 'sales.order:view');
      const scope = ids === null ? 'true' : `exists (select 1 from org.territories rt join org.territories ut on rt.path <@ ut.path where rt.id = o.territory_id and ut.id = any('{${ids.join(',')}}'::uuid[]))`;
      parts.push(`(select 'Sales order', o.id, o.doc_no, p.legal_name, '/sales/orders/' || o.id from sales.sales_orders o join mdm.parties p on p.id = o.party_id
                    where (o.doc_no ilike $1 or p.legal_name ilike $1 or o.dealer_po_no ilike $1) and ${scope} limit 5)`);
    }
    if (can(req, 'mdm.vendor:view')) parts.push(`(select 'Vendor', p.id, p.code, p.legal_name, '/purchase/vendors/' || p.id from mdm.parties p join mdm.vendor_profiles vp on vp.party_id = p.id
                    where p.code ilike $1 or p.legal_name ilike $1 or p.gstin ilike $1 or p.mobile like $1 limit 5)`);
    if (can(req, 'purchase.requisition:view')) {
      const own = can(req, 'purchase.requisition:view_all') ? 'true' : `r.requested_by = '${req.auth!.user.id}'`;
      parts.push(`(select 'Requisition', r.id, r.doc_no, left(r.purpose, 80), '/purchase/requisitions/' || r.id from purchase.requisitions r
                    where (r.doc_no ilike $1 or r.purpose ilike $1) and ${own} limit 5)`);
    }
    if (can(req, 'purchase.order:view')) parts.push(`(select 'Purchase order', o.id, o.doc_no, p.legal_name, '/purchase/orders/' || o.id from purchase.purchase_orders o
                    join mdm.parties p on p.id = o.party_id where o.doc_no ilike $1 or p.legal_name ilike $1 limit 5)`);
    if (can(req, 'purchase.rfq:view')) parts.push(`(select 'RFQ', r.id, r.doc_no, coalesce(left(r.notes, 80), ''), '/purchase/rfqs/' || r.id from purchase.rfqs r where r.doc_no ilike $1 limit 5)`);
    if (can(req, 'purchase.grn:view')) parts.push(`(select 'Goods receipt', g.id, g.doc_no, g.challan_no, '/stores/receipts/' || g.id from purchase.goods_receipts g where g.doc_no ilike $1 or g.challan_no ilike $1 limit 5)`);
    if (can(req, 'inv.stock:view')) parts.push(`(select 'Lot', l.id, l.lot_no, coalesce(l.vendor_lot_no, ''), '/stores/lots/' || l.id from inv.lots l where l.lot_no ilike $1 or l.vendor_lot_no ilike $1 limit 5)`);
    if (can(req, 'purchase.invoice:view')) parts.push(`(select 'Supplier invoice', si.id, si.doc_no || ' · ' || si.invoice_no, p.legal_name, '/purchase/invoices/' || si.id from purchase.supplier_invoices si
                    join mdm.parties p on p.id = si.party_id where si.doc_no ilike $1 or si.invoice_no ilike $1 or p.legal_name ilike $1 limit 5)`);
    if (can(req, 'purchase.return:view')) parts.push(`(select 'Supplier return', sr.id, sr.doc_no, sr.reason, '/stores/returns/' || sr.id from purchase.supplier_returns sr where sr.doc_no ilike $1 limit 5)`);
    if (can(req, 'sales.price_list:view')) parts.push(`(select 'Price list', id, code, name, '/sales/price-lists/' || id from sales.price_lists where code ilike $1 or name ilike $1 limit 5)`);
    if (can(req, 'mdm.item:view')) parts.push(`(select 'Item', id, code, name, '/products/items/' || id from mdm.items where code ilike $1 or name ilike $1 limit 5)`);
    if (can(req, 'iam.user:view')) parts.push(`(select 'User', id, full_name, email::text, '/admin/users/' || id from iam.users where email ilike $1 or full_name ilike $1 limit 5)`);
    parts.push(`(select 'Approval', a.id, a.doc_no, a.subject_label, '/approvals/' || a.id from wf.approval_requests a
                  where (a.doc_no ilike $1 or a.subject_label ilike $1) and (a.initiated_by = $2 or exists (select 1 from wf.approval_steps s where s.request_id = a.id and $2 = any(s.approver_ids))) limit 5)`);
    const rows = await db.query(parts.join(' union all '), [like, req.auth!.user.id]);
    res.json({ data: rows.rows });
  }));
  return r;
}
