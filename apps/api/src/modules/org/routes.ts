import { Router } from 'express';
import {
  departmentSchema, employeeSchema, gstRegistrationSchema, gstinMatchesPan, legalEntitySchema, plantSchema, reasonSchema,
  territorySchema, warehouseSchema,
} from '@dhruv/contracts';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit, diff } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, inLegalEntityScope, legalEntityScope } from '../../middleware/context';
import { lifecycleRoutes } from './lifecycle';

const AUDIT_COLS = `t.status, t.version, t.created_at as "createdAt", t.updated_at as "updatedAt"`;

async function assertActive(tx: Tx, table: string, id: string | null | undefined, label: string) {
  if (!id) return null;
  const r = (await tx.query(`select * from ${table} where id = $1`, [id])).rows[0];
  if (!r) throw Errors.rule('REFERENCE_INVALID', `${label} does not exist.`);
  if (r.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', `${label} ${r.code ?? ''} is not active (${r.status}). Only active masters can be used (MDM-005).`);
  return r;
}

async function countActive(tx: Tx, sql: string, id: string) {
  return Number((await tx.query(sql, [id])).rows[0].n);
}

export function orgRoutes(db: Db) {
  const r = Router();

  // ------------------------------------------------------------------ legal entities (+ GST registrations)
  r.use('/legal-entities', lifecycleRoutes(db, {
    resource: 'org.legal_entity', table: 'org.legal_entities', label: 'Legal entity', schema: legalEntitySchema, scopeColumn: 'id',
    columns: { code: 'code', name: 'name', pan: 'pan', cin: 'cin', registeredAddress: 'registered_address', stateCode: 'state_code' },
    select: `t.id, t.code, t.name, t.pan, t.cin, t.registered_address as "registeredAddress", t.state_code as "stateCode", ${AUDIT_COLS},
             (select count(*) from org.gst_registrations g where g.legal_entity_id = t.id and g.status = 'Active') as "gstRegistrations"`,
    from: `from org.legal_entities t`,
    validateWrite: async (tx, data, id) => {
      if (id && data.pan) {
        const bad = await tx.query(`select gstin from org.gst_registrations where legal_entity_id = $1`, [id]);
        const mismatch = bad.rows.find((g) => !gstinMatchesPan(g.gstin, data.pan as string));
        if (mismatch) throw Errors.rule('GSTIN_PAN_MISMATCH', `GSTIN ${mismatch.gstin} does not contain PAN ${data.pan}.`);
      }
    },
    validateSubmit: async (_tx, row) => {
      if (!row.pan) throw Errors.rule('FIELD_REQUIRED', 'PAN is required before a legal entity can be submitted.', [{ field: 'pan', message: 'Required' }]);
    },
    validateDeactivate: async (tx, row) => {
      const n = await countActive(tx, `select (select count(*) from org.plants where legal_entity_id = $1 and status = 'Active') +
                                              (select count(*) from org.warehouses where legal_entity_id = $1 and status = 'Active') as n`, row.id as string);
      if (n > 0) throw Errors.rule('HAS_ACTIVE_CHILDREN', `Deactivate its ${n} active plant(s)/warehouse(s) first.`);
    },
  }));

  r.get('/legal-entities/:id/gst-registrations', requirePermission('org.legal_entity:view'), asyncHandler(async (req, res) => {
    if (!inLegalEntityScope(req, 'org.legal_entity:view', req.params.id!)) throw Errors.notFound('Legal entity');
    const rows = await db.query(
      `select id, gstin, state_code as "stateCode", address, status, created_at as "createdAt" from org.gst_registrations where legal_entity_id = $1 order by gstin`, [req.params.id]);
    res.json({ data: rows.rows });
  }));

  r.post('/legal-entities/:id/gst-registrations', requirePermission('org.legal_entity:edit_draft'), asyncHandler(async (req, res) => {
    const { gstin, address } = parse(gstRegistrationSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const le = (await tx.query(`select * from org.legal_entities where id = $1 for update`, [req.params.id])).rows[0];
      if (!le || !inLegalEntityScope(req, 'org.legal_entity:edit_draft', le.id)) throw Errors.notFound('Legal entity');
      // Changes to an active legal entity go through a master change request (S-M02-21, Stage 1 increment 2).
      if (!['Draft', 'Rejected'].includes(le.status)) throw Errors.state('GST registrations can be added while the legal entity is Draft or Rejected.');
      if (le.pan && !gstinMatchesPan(gstin, le.pan)) throw Errors.rule('GSTIN_PAN_MISMATCH', `GSTIN must contain the legal entity PAN ${le.pan} (characters 3–12).`);
      const ins = await tx.query(
        `insert into org.gst_registrations (legal_entity_id, state_code, gstin, address, created_by) values ($1,$2,$3,$4,$5) returning *`,
        [le.id, gstin.slice(0, 2), gstin, address, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'org.gst_registration.created', entityType: 'org.legal_entity', entityId: le.id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));

  // ------------------------------------------------------------------ plants
  r.use('/plants', lifecycleRoutes(db, {
    resource: 'org.plant', table: 'org.plants', label: 'Plant', schema: plantSchema, scopeColumn: 'legal_entity_id',
    columns: { legalEntityId: 'legal_entity_id', code: 'code', name: 'name', address: 'address', stateCode: 'state_code' },
    select: `t.id, t.code, t.name, t.address, t.state_code as "stateCode", t.legal_entity_id as "legalEntityId", le.name as "legalEntityName", ${AUDIT_COLS}`,
    from: `from org.plants t join org.legal_entities le on le.id = t.legal_entity_id`,
    validateSubmit: async (tx, row) => { await assertActive(tx, 'org.legal_entities', row.legal_entity_id as string, 'Legal entity'); },
    validateDeactivate: async (tx, row) => {
      const n = await countActive(tx, `select count(*) as n from org.warehouses where plant_id = $1 and status = 'Active'`, row.id as string);
      if (n > 0) throw Errors.rule('HAS_ACTIVE_CHILDREN', `Deactivate its ${n} active warehouse(s) first.`);
    },
  }));

  // ------------------------------------------------------------------ warehouses
  r.use('/warehouses', lifecycleRoutes(db, {
    resource: 'org.warehouse', table: 'org.warehouses', label: 'Warehouse', schema: warehouseSchema, scopeColumn: 'legal_entity_id',
    columns: { legalEntityId: 'legal_entity_id', plantId: 'plant_id', code: 'code', name: 'name', type: 'type', address: 'address', stateCode: 'state_code', gstRegistrationId: 'gst_registration_id' },
    select: `t.id, t.code, t.name, t.type, t.address, t.state_code as "stateCode", t.legal_entity_id as "legalEntityId", le.name as "legalEntityName",
             t.plant_id as "plantId", p.name as "plantName", t.gst_registration_id as "gstRegistrationId", g.gstin, ${AUDIT_COLS}`,
    from: `from org.warehouses t join org.legal_entities le on le.id = t.legal_entity_id left join org.plants p on p.id = t.plant_id left join org.gst_registrations g on g.id = t.gst_registration_id`,
    validateWrite: async (tx, data) => {
      if (data.plantId) {
        const p = (await tx.query(`select legal_entity_id from org.plants where id = $1`, [data.plantId])).rows[0];
        if (!p || p.legal_entity_id !== data.legalEntityId) throw Errors.rule('PLANT_ENTITY_MISMATCH', 'The plant belongs to a different legal entity.');
      }
      if (data.gstRegistrationId) {
        const g = (await tx.query(`select legal_entity_id, state_code from org.gst_registrations where id = $1`, [data.gstRegistrationId])).rows[0];
        if (!g || g.legal_entity_id !== data.legalEntityId) throw Errors.rule('GST_ENTITY_MISMATCH', 'The GST registration belongs to a different legal entity.');
        if (data.stateCode && g.state_code !== data.stateCode) throw Errors.rule('GST_STATE_MISMATCH', 'The GST registration is for a different state than the warehouse.');
      }
    },
    validateSubmit: async (tx, row) => {
      await assertActive(tx, 'org.legal_entities', row.legal_entity_id as string, 'Legal entity');
      await assertActive(tx, 'org.plants', row.plant_id as string | null, 'Plant');
    },
  }));

  // ------------------------------------------------------------------ departments (simple master)
  r.get('/departments', requirePermission('org.department:view'), asyncHandler(async (_req, res) => {
    const rows = await db.query(`select id, code, name, status, version from org.departments order by code`);
    res.json({ data: rows.rows });
  }));
  r.post('/departments', requirePermission('org.department:create'), asyncHandler(async (req, res) => {
    const d = parse(departmentSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const ins = await tx.query(`insert into org.departments (code, name, created_by, updated_by) values ($1,$2,$3,$3) returning *`, [d.code, d.name, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'org.department.created', entityType: 'org.department', entityId: ins.rows[0].id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  simpleStatusRoutes(r, db, 'departments', 'org.departments', 'org.department', 'Department',
    async (tx, id) => countActive(tx, `select count(*) as n from org.employees where department_id = $1 and status = 'Active'`, id));

  // ------------------------------------------------------------------ territories (configurable tree, D37)
  r.get('/territory-levels', requirePermission('org.territory:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select level, name, tier_hint as "tierHint" from org.territory_levels order by level`)).rows });
  }));
  r.get('/territories', requirePermission('org.territory:view'), asyncHandler(async (_req, res) => {
    const rows = await db.query(
      `select t.id, t.parent_id as "parentId", t.code, t.name, t.level, l.name as "levelName", t.path::text as path, t.status, t.version,
              (select count(*) from org.employees e where e.territory_id = t.id and e.status = 'Active') as employees
         from org.territories t join org.territory_levels l on l.level = t.level order by t.path`);
    res.json({ data: rows.rows });
  }));
  r.post('/territories', requirePermission('org.territory:create'), asyncHandler(async (req, res) => {
    const d = parse(territorySchema, req.body);
    const id = await withTx(db, async (tx) => {
      let path = d.code.replace(/-/g, '_');
      if (d.parentId) {
        const p = (await tx.query(`select path::text, level, status from org.territories where id = $1`, [d.parentId])).rows[0];
        if (!p) throw Errors.rule('REFERENCE_INVALID', 'Parent territory does not exist.');
        if (p.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Parent territory is inactive.');
        if (d.level <= p.level) throw Errors.rule('LEVEL_INVALID', 'A child territory must sit at a lower level than its parent.');
        path = `${p.path}.${path}`;
      }
      const ins = await tx.query(
        `insert into org.territories (parent_id, code, name, level, path, created_by, updated_by) values ($1,$2,$3,$4,$5::ltree,$6,$6) returning *`,
        [d.parentId ?? null, d.code, d.name, d.level, path, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'org.territory.created', entityType: 'org.territory', entityId: ins.rows[0].id, after: { ...ins.rows[0], path } });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.patch('/territories/:id', requirePermission('org.territory:edit'), asyncHandler(async (req, res) => {
    const name = parse(territorySchema.pick({ name: true }), req.body).name;
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from org.territories where id = $1 for update`, [req.params.id])).rows[0];
      if (!before) throw Errors.notFound('Territory');
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      await tx.query(`update org.territories set name = $2, updated_by = $3 where id = $1`, [before.id, name, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'org.territory.updated', entityType: 'org.territory', entityId: before.id, before: { name: before.name }, after: { name } });
    });
    res.json({ ok: true });
  }));
  simpleStatusRoutes(r, db, 'territories', 'org.territories', 'org.territory', 'Territory', async (tx, id) =>
    countActive(tx, `select (select count(*) from org.territories c where c.parent_id = $1 and c.status = 'Active') +
                            (select count(*) from org.employees e where e.territory_id = $1 and e.status = 'Active') as n`, id),
  async (tx, id) => {
    const p = (await tx.query(`select p.status from org.territories t join org.territories p on p.id = t.parent_id where t.id = $1`, [id])).rows[0];
    if (p && p.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Activate the parent territory first.');
  });

  // ------------------------------------------------------------------ employees
  const empSelect = `select e.id, e.emp_code as "empCode", e.full_name as "fullName", e.email, e.mobile, e.department_id as "departmentId", d.name as "departmentName",
      e.designation, e.sales_tier as "salesTier", e.manager_id as "managerId", m.full_name as "managerName", e.territory_id as "territoryId",
      t.name as "territoryName", e.legal_entity_id as "legalEntityId", e.status, e.version, u.id as "userId", u.email as "userEmail"
    from org.employees e left join org.departments d on d.id = e.department_id left join org.employees m on m.id = e.manager_id
    left join org.territories t on t.id = e.territory_id left join iam.users u on u.employee_id = e.id`;

  r.get('/employees', requirePermission('org.employee:view'), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where: string[] = [];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(e.emp_code ilike $1 or e.full_name ilike $1)`); }
    const tier = str(req.query.salesTier);
    if (tier) { args.push(tier); where.push(`e.sales_tier = $${args.length}`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`e.status = $${args.length}`); }
    const scope = legalEntityScope(req, 'org.employee:view');
    if (scope) { args.push(scope); where.push(`e.legal_entity_id = any($${args.length}::uuid[])`); }
    const rows = await db.query(`${empSelect.replace('select e.id,', 'select count(*) over() as total, e.id,')} ${where.length ? 'where ' + where.join(' and ') : ''}
      order by e.emp_code limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));
  r.get('/employees/:id', requirePermission('org.employee:view'), asyncHandler(async (req, res) => {
    const row = (await db.query(`${empSelect} where e.id = $1`, [req.params.id])).rows[0];
    if (!row || !inLegalEntityScope(req, 'org.employee:view', row.legalEntityId)) throw Errors.notFound('Employee');
    const reports = (await db.query(`select id, emp_code as "empCode", full_name as "fullName", sales_tier as "salesTier", status from org.employees where manager_id = $1 order by full_name`, [row.id])).rows;
    res.json({ ...row, directReports: reports, allowedActions: [
      ...(can(req, 'org.employee:edit') ? ['edit'] : []),
      ...(can(req, 'org.employee:deactivate') ? [row.status === 'Active' ? 'deactivate' : 'activate'] : []),
    ] });
  }));

  async function validateEmployee(tx: Tx, d: Record<string, unknown>, id: string | null) {
    await assertActive(tx, 'org.departments', d.departmentId as string, 'Department');
    await assertActive(tx, 'org.territories', d.territoryId as string, 'Territory');
    if (d.legalEntityId) await assertActive(tx, 'org.legal_entities', d.legalEntityId as string, 'Legal entity');
    if (d.managerId) {
      await assertActive(tx, 'org.employees', d.managerId as string, 'Manager');
      if (id) {
        const cycle = await tx.query(
          `with recursive up as (select id, manager_id, 1 as depth from org.employees where id = $1
             union all select e.id, e.manager_id, up.depth + 1 from org.employees e join up on e.id = up.manager_id where up.depth < 50)
           select 1 from up where id = $2`, [d.managerId, id]);
        if (cycle.rowCount) throw Errors.rule('MANAGER_CYCLE', 'This manager reports (directly or indirectly) to the employee — that would create a loop.');
      }
    }
  }
  const empCols = (d: Record<string, unknown>) => [d.empCode, d.fullName, d.email ?? null, d.mobile ?? null, d.departmentId ?? null, d.designation ?? null,
    d.salesTier ?? null, d.managerId ?? null, d.territoryId ?? null, d.legalEntityId ?? null];

  r.post('/employees', requirePermission('org.employee:create'), asyncHandler(async (req, res) => {
    const d = parse(employeeSchema, req.body) as Record<string, unknown>;
    const id = await withTx(db, async (tx) => {
      await validateEmployee(tx, d, null);
      const ins = await tx.query(
        `insert into org.employees (emp_code, full_name, email, mobile, department_id, designation, sales_tier, manager_id, territory_id, legal_entity_id, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning *`, [...empCols(d), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'org.employee.created', entityType: 'org.employee', entityId: ins.rows[0].id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.put('/employees/:id', requirePermission('org.employee:edit'), asyncHandler(async (req, res) => {
    const d = parse(employeeSchema, req.body) as Record<string, unknown>;
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from org.employees where id = $1 for update`, [req.params.id])).rows[0];
      if (!before) throw Errors.notFound('Employee');
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      await validateEmployee(tx, d, before.id);
      const after = (await tx.query(
        `update org.employees set emp_code=$2, full_name=$3, email=$4, mobile=$5, department_id=$6, designation=$7, sales_tier=$8, manager_id=$9,
           territory_id=$10, legal_entity_id=$11, updated_by=$12 where id = $1 returning *`, [before.id, ...empCols(d), req.auth!.user.id])).rows[0];
      const df = diff(before, after);
      await audit(tx, actorOf(req), { action: 'org.employee.updated', entityType: 'org.employee', entityId: before.id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));
  simpleStatusRoutes(r, db, 'employees', 'org.employees', 'org.employee', 'Employee',
    async (tx, id) => countActive(tx, `select count(*) as n from org.employees where manager_id = $1 and status = 'Active'`, id));

  return r;
}

/** Activate / deactivate for masters without an approval lifecycle. */
function simpleStatusRoutes(r: Router, db: Db, path: string, table: string, resource: string, label: string,
  activeDependents: (tx: Tx, id: string) => Promise<number>, beforeActivate?: (tx: Tx, id: string) => Promise<void>) {
  r.post(`/${path}/:id/deactivate`, requirePermission(`${resource}:deactivate`), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const row = (await tx.query(`select id, status from ${table} where id = $1 for update`, [req.params.id])).rows[0];
      if (!row) throw Errors.notFound(label);
      if (row.status !== 'Active') throw Errors.state(`${label} is already inactive.`);
      const n = await activeDependents(tx, row.id);
      if (n > 0) throw Errors.rule('HAS_ACTIVE_DEPENDENTS', `${label} still has ${n} active dependent record(s). Reassign or deactivate them first.`);
      await tx.query(`update ${table} set status = 'Inactive', updated_by = $2 where id = $1`, [row.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `${resource}.deactivated`, entityType: resource, entityId: row.id, reason });
    });
    res.json({ ok: true });
  }));
  r.post(`/${path}/:id/activate`, requirePermission(`${resource}:deactivate`), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const row = (await tx.query(`select id, status from ${table} where id = $1 for update`, [req.params.id])).rows[0];
      if (!row) throw Errors.notFound(label);
      if (row.status !== 'Inactive') throw Errors.state(`${label} is already active.`);
      await beforeActivate?.(tx, row.id);
      await tx.query(`update ${table} set status = 'Active', updated_by = $2 where id = $1`, [row.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `${resource}.activated`, entityType: resource, entityId: row.id, reason });
    });
    res.json({ ok: true });
  }));
}
