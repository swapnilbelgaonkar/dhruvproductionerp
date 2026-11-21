import { Router, type Request } from 'express';
import { z } from 'zod';
import { productionLineSchema, reasonSchema, shiftSchema } from '@dhruv/contracts';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, inLegalEntityScope, legalEntityScope } from '../../middleware/context';

/** Plant & line settings master (BRD p.18 sub-module 16; MFG-019): production lines with machine parameters, and shifts. */
const VIEW = 'mfg.settings:view';
const CONFIGURE = 'mfg.settings:configure';

async function activePlant(tx: Tx, req: Request, plantId: string) {
  const p = (await tx.query(`select status, legal_entity_id from org.plants where id = $1`, [plantId])).rows[0];
  if (p?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active plant.');
  if (!inLegalEntityScope(req, CONFIGURE, p.legal_entity_id)) throw Errors.forbidden(`${CONFIGURE} for this plant`);
}

const lineSelect = `select l.id, l.plant_id as "plantId", p.code as "plantCode", p.name as "plantName", l.code, l.name, l.line_type as "lineType",
    l.capacity_per_shift as "capacityPerShift", l.capacity_uom as "capacityUom", l.parameters, l.status, l.status_reason as "statusReason", l.version
  from mfg.lines l join org.plants p on p.id = l.plant_id`;
const shiftSelect = `select s.id, s.plant_id as "plantId", p.code as "plantCode", p.name as "plantName", s.code, s.name,
    to_char(s.start_time, 'HH24:MI') as "startTime", to_char(s.end_time, 'HH24:MI') as "endTime", s.status, s.version
  from mfg.shifts s join org.plants p on p.id = s.plant_id`;

function scoped(req: Request, args: unknown[], alias: string) {
  const scope = legalEntityScope(req, VIEW);
  if (!scope) return 'true';
  args.push(scope);
  return `${alias}.plant_id in (select id from org.plants where legal_entity_id = any($${args.length}::uuid[]))`;
}

export function productionSettingsRoutes(db: Db) {
  const r = Router();

  /** Everything the plant screens need in one call: active plants with their lines and shifts. */
  r.get('/plants', requirePermission(VIEW), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const scope = legalEntityScope(req, VIEW);
    if (scope) args.push(scope);
    const plants = (await db.query(
      `select p.id, p.code, p.name, p.legal_entity_id as "legalEntityId", le.name as "legalEntityName" from org.plants p join org.legal_entities le on le.id = p.legal_entity_id
        where p.status = 'Active' ${scope ? 'and p.legal_entity_id = any($1::uuid[])' : ''} order by p.code`, args)).rows;
    const lines = (await db.query(`${lineSelect} where l.plant_id = any($1::uuid[]) order by l.code`, [plants.map((p) => p.id)])).rows;
    const shifts = (await db.query(`${shiftSelect} where s.plant_id = any($1::uuid[]) order by s.start_time`, [plants.map((p) => p.id)])).rows;
    res.json({ data: plants.map((p) => ({ ...p, lines: lines.filter((l) => l.plantId === p.id), shifts: shifts.filter((s) => s.plantId === p.id) })) });
  }));

  r.get('/lines', requirePermission(VIEW), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [scoped(req, args, 'l')];
    const plantId = str(req.query.plantId);
    if (plantId) { args.push(plantId); where.push(`l.plant_id = $${args.length}`); }
    if (str(req.query.status)) { args.push(str(req.query.status)); where.push(`l.status = $${args.length}`); }
    res.json({ data: (await db.query(`${lineSelect} where ${where.join(' and ')} order by p.code, l.code`, args)).rows });
  }));

  r.post('/lines', requirePermission(CONFIGURE), asyncHandler(async (req, res) => {
    const d = parse(productionLineSchema, req.body);
    const out = await withTx(db, async (tx) => {
      await activePlant(tx, req, d.plantId);
      if (d.capacityUom && !(await tx.query(`select 1 from mdm.uom where code = $1 and status = 'Active'`, [d.capacityUom])).rowCount) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active unit for the capacity.');
      if ((await tx.query(`select 1 from mfg.lines where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Line code ${d.code} is already used.`);
      const row = (await tx.query(
        `insert into mfg.lines (plant_id, code, name, line_type, capacity_per_shift, capacity_uom, parameters, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [d.plantId, d.code, d.name, d.lineType, d.capacityPerShift ?? null, d.capacityUom, JSON.stringify(d.parameters), req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'mfg.line.created', entityType: 'mfg.line', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));

  r.put('/lines/:id', requirePermission(CONFIGURE), asyncHandler(async (req, res) => {
    const d = parse(productionLineSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`${lineSelect} where l.id = $1 for update of l`, [req.params.id])).rows[0];
      if (!before) throw Errors.notFound('Production line');
      if (before.version !== d.version) throw Errors.concurrent();
      if (before.plantId !== d.plantId) throw Errors.rule('IMMUTABLE_FIELD', 'A line cannot move to another plant. Deactivate it and create a new one.');
      await activePlant(tx, req, d.plantId);
      if (d.code !== before.code && (await tx.query(`select 1 from mfg.lines where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Line code ${d.code} is already used.`);
      await tx.query(`update mfg.lines set code=$2, name=$3, line_type=$4, capacity_per_shift=$5, capacity_uom=$6, parameters=$7, updated_by=$8 where id = $1`,
        [before.id, d.code, d.name, d.lineType, d.capacityPerShift ?? null, d.capacityUom, JSON.stringify(d.parameters), req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mfg.line.edited', entityType: 'mfg.line', entityId: before.id, before, after: d });
    });
    res.json({ ok: true });
  }));

  for (const [kind, table, label] of [['lines', 'mfg.lines', 'line'], ['shifts', 'mfg.shifts', 'shift']] as const) {
    r.post(`/${kind}/:id/status`, requirePermission(CONFIGURE), asyncHandler(async (req, res) => {
      const d = parse(reasonSchema.and(z.object({ status: z.enum(['Active', 'Inactive']) })), req.body);
      await withTx(db, async (tx) => {
        const row = (await tx.query(`select id, status, plant_id from ${table} where id = $1 for update`, [req.params.id])).rows[0];
        if (!row) throw Errors.notFound(`Production ${label}`);
        await activePlant(tx, req, row.plant_id);
        if (row.status === d.status) throw Errors.state(`The ${label} is already ${d.status}.`);
        await tx.query(`update ${table} set status = $2, updated_by = $3 ${kind === 'lines' ? ', status_reason = $4' : ''} where id = $1`,
          kind === 'lines' ? [row.id, d.status, req.auth!.user.id, d.reason] : [row.id, d.status, req.auth!.user.id]);
        await audit(tx, actorOf(req), { action: `mfg.${label}.status`, entityType: `mfg.${label}`, entityId: row.id, before: { status: row.status }, after: { status: d.status }, reason: d.reason });
      });
      res.json({ ok: true });
    }));
  }

  r.post('/shifts', requirePermission(CONFIGURE), asyncHandler(async (req, res) => {
    const d = parse(shiftSchema, req.body);
    const out = await withTx(db, async (tx) => {
      await activePlant(tx, req, d.plantId);
      if ((await tx.query(`select 1 from mfg.shifts where plant_id = $1 and code = $2`, [d.plantId, d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Shift ${d.code} already exists for this plant.`);
      const row = (await tx.query(`insert into mfg.shifts (plant_id, code, name, start_time, end_time, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$6) returning id`,
        [d.plantId, d.code, d.name, d.startTime, d.endTime, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'mfg.shift.created', entityType: 'mfg.shift', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));

  r.put('/shifts/:id', requirePermission(CONFIGURE), asyncHandler(async (req, res) => {
    const d = parse(shiftSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`${shiftSelect} where s.id = $1 for update of s`, [req.params.id])).rows[0];
      if (!before) throw Errors.notFound('Shift');
      if (before.version !== d.version) throw Errors.concurrent();
      if (before.plantId !== d.plantId) throw Errors.rule('IMMUTABLE_FIELD', 'A shift cannot move to another plant.');
      await activePlant(tx, req, d.plantId);
      if (d.code !== before.code && (await tx.query(`select 1 from mfg.shifts where plant_id = $1 and code = $2`, [d.plantId, d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Shift ${d.code} already exists for this plant.`);
      await tx.query(`update mfg.shifts set code=$2, name=$3, start_time=$4, end_time=$5, updated_by=$6 where id = $1`, [before.id, d.code, d.name, d.startTime, d.endTime, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mfg.shift.edited', entityType: 'mfg.shift', entityId: before.id, before, after: d });
    });
    res.json({ ok: true });
  }));

  return r;
}
