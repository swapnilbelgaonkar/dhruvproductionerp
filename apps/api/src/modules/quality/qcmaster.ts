import { Router, type Request } from 'express';
import { z } from 'zod';
import { calibrationSchema, instrumentSchema, reasonSchema, specSchema, specVersionSchema, testMethodSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { todayIST } from '../sales/quotations';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

/**
 * QC masters (BRD p.15 sub-modules 3 and 5; MP §13.3, §13.7; QC-004, QC-008): test methods, instruments with their calibration, and
 * item specifications in approved, effective-dated versions (QC manager or head, then QA). Results are entered against the version in force.
 */
const SPEC = 'qc.spec_version';
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export interface SpecParam { id: string; seq: number; parameter: string; category: string; unit: string | null; limitType: string; minValue: string | null; maxValue: string | null;
  expectedText: string | null; methodId: string | null; methodCode: string | null; methodName: string | null; technique: string | null }

/** The approved specification version in force for an item on a date, with its parameters. */
export async function effectiveSpec(dbx: Db | Tx, itemId: string, onDate: string) {
  const v = (await dbx.query(
    `select v.id, v.version_no as "versionNo", s.code, s.title, v.effective_from as "effectiveFrom" from qc.spec_versions v join qc.specifications s on s.id = v.spec_id
      where s.item_id = $1 and s.status = 'Active' and v.status = 'Approved' and v.effective_from <= $2 and (v.effective_to is null or v.effective_to >= $2)`, [itemId, onDate])).rows[0];
  if (!v) return null;
  const parameters = (await dbx.query<SpecParam>(
    `select p.id, p.seq, p.parameter, p.category, p.unit, p.limit_type as "limitType", p.min_value as "minValue", p.max_value as "maxValue", p.expected_text as "expectedText",
            p.method_id as "methodId", m.code as "methodCode", m.name as "methodName", m.technique
       from qc.spec_parameters p left join qc.test_methods m on m.id = p.method_id where p.spec_version_id = $1 order by p.seq`, [v.id])).rows;
  return { ...v, parameters };
}

/** The limit as people read it, e.g. "6.0 – 6.5", "≥ 12.0 %", "Clear". */
export function limitText(p: Pick<SpecParam, 'limitType' | 'minValue' | 'maxValue' | 'expectedText' | 'unit'>) {
  const u = p.unit ? ` ${p.unit}` : '';
  const f = (v: string | null) => String(Number(v));
  return p.limitType === 'RANGE' ? `${f(p.minValue)} – ${f(p.maxValue)}${u}` : p.limitType === 'MIN' ? `≥ ${f(p.minValue)}${u}` : p.limitType === 'MAX' ? `≤ ${f(p.maxValue)}${u}` : String(p.expectedText);
}

/** Pass or fail of a value against a parameter; numbers are read from the value (e.g. "12.2%" → 12.2). Text limits compare without case. */
export function evaluate(p: Pick<SpecParam, 'limitType' | 'minValue' | 'maxValue' | 'expectedText'>, value: string) {
  if (p.limitType === 'TEXT') return { pass: value.trim().toLowerCase() === String(p.expectedText).trim().toLowerCase(), numeric: null as number | null };
  const m = value.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) throw Errors.rule('NOT_A_NUMBER', `"${value}" is not a number.`);
  const x = Number(m[0]);
  const ok = (p.minValue === null || x >= Number(p.minValue)) && (p.maxValue === null || x <= Number(p.maxValue));
  return { pass: ok, numeric: x };
}

/** An instrument may be used for a result only while active and within its calibration date (QC-008). */
export async function assertInstrumentUsable(tx: Tx, instrumentId: string) {
  const i = (await tx.query(`select code, status, calibration_due from qc.instruments where id = $1`, [instrumentId])).rows[0];
  if (!i) throw Errors.notFound('Instrument');
  if (i.status !== 'Active') throw Errors.rule('INSTRUMENT_OUT_OF_SERVICE', `${i.code} is out of service.`);
  if (!i.calibration_due || String(i.calibration_due) < todayIST()) throw Errors.rule('INSTRUMENT_OVERDUE', `${i.code} is overdue for calibration${i.calibration_due ? ` (due ${i.calibration_due})` : ''}; it cannot be used.`);
  return i.code as string;
}

async function setSpecStatus(tx: Tx, actor: Actor, id: string, status: string, reason: string | null = null) {
  await allowTransition(tx);
  await tx.query(`update qc.spec_versions set status = $2, status_reason = $3, updated_by = $4, approved_at = case when $2 = 'Approved' then now() else approved_at end where id = $1`, [id, status, reason, actor.userId]);
  await audit(tx, actor, { action: `${SPEC}.status`, entityType: SPEC, entityId: id, after: { status }, reason });
  await emit(tx, SPEC, id, `${SPEC}.${status.toLowerCase()}`);
}
async function approveSpec(tx: Tx, actor: Actor, id: string) {
  const v = (await tx.query(`select spec_id, effective_from::text as "from" from qc.spec_versions where id = $1 for update`, [id])).rows[0];
  const later = (await tx.query(`select version_no from qc.spec_versions where spec_id = $1 and status = 'Approved' and effective_from >= $2`, [v.spec_id, v.from])).rows[0];
  if (later) throw Errors.rule('EFFECTIVE_DATE_OVERLAP', `Version ${later.version_no} already starts on or after this date.`);
  await tx.query(`update qc.spec_versions set effective_to = $2, updated_by = $3 where spec_id = $1 and status = 'Approved' and (effective_to is null or effective_to >= $4)`,
    [v.spec_id, addDays(v.from, -1), actor.userId, v.from]);
  await setSpecStatus(tx, actor, id, 'Approved');
}

export function qcMasterRoutes(db: Db) {
  registerSubjectHandler(SPEC, {
    onApproved: (tx, r, a) => approveSpec(tx, a, r.subject_id),
    onRejected: (tx, r, a) => setSpecStatus(tx, a, r.subject_id, 'Rejected'),
    onReturned: (tx, r, a) => setSpecStatus(tx, a, r.subject_id, 'Draft', 'Returned for correction'),
    onCancelled: (tx, r, a) => setSpecStatus(tx, a, r.subject_id, 'Draft', 'Submission withdrawn'),
  });
  const r = Router();

  // ---------------------------------------------------------------- test methods
  r.get('/methods', requirePermission('qc.spec:view'), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select id, code, name, technique, reference, status, version from qc.test_methods order by code`)).rows });
  }));
  r.post('/methods', requirePermission('qc.spec:manage'), asyncHandler(async (req, res) => {
    const d = parse(testMethodSchema, req.body);
    const out = await withTx(db, async (tx) => {
      if ((await tx.query(`select 1 from qc.test_methods where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Method ${d.code} exists.`);
      const row = (await tx.query(`insert into qc.test_methods (code, name, technique, reference, created_by, updated_by) values ($1,$2,$3,$4,$5,$5) returning id`,
        [d.code, d.name, d.technique, d.reference, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qc.method.created', entityType: 'qc.test_method', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));

  // ---------------------------------------------------------------- instruments and calibration (QC-008)
  const instSelect = `select i.id, i.code, i.name, i.technique, i.make_model as "makeModel", i.serial_no as "serialNo", i.location, i.interval_days as "intervalDays",
      i.last_calibrated as "lastCalibrated", i.calibration_due as "calibrationDue", i.status, i.status_reason as "statusReason", i.version,
      case when i.status <> 'Active' then i.status when i.calibration_due is null or i.calibration_due < $1::date then 'Overdue'
           when i.calibration_due <= $1::date + 15 then 'DueSoon' else 'Calibrated' end as state
    from qc.instruments i`;
  r.get('/instruments', requirePermission('qc.instrument:view'), asyncHandler(async (req, res) => {
    const args: unknown[] = [todayIST()];
    const usable = str(req.query.usable) === '1';
    res.json({ data: (await db.query(`${instSelect} ${usable ? `where i.status = 'Active' and i.calibration_due >= $1::date` : ''} order by i.code`, args)).rows });
  }));
  r.get('/instruments/:id', requirePermission('qc.instrument:view'), asyncHandler(async (req, res) => {
    const i = (await db.query(`${instSelect} where i.id = $2`, [todayIST(), req.params.id])).rows[0];
    if (!i) throw Errors.notFound('Instrument');
    const calibrations = (await db.query(`select c.id, c.calibrated_on as "calibratedOn", c.due_on as "dueOn", c.result, c.agency, c.certificate_no as "certificateNo",
      c.document_id as "documentId", c.remarks, u.full_name as "recordedBy" from qc.calibrations c join iam.users u on u.id = c.recorded_by where c.instrument_id = $1 order by c.calibrated_on desc`, [i.id])).rows;
    res.json({ ...i, calibrations, canManage: can(req, 'qc.instrument:manage') });
  }));
  r.post('/instruments', requirePermission('qc.instrument:manage'), asyncHandler(async (req, res) => {
    const d = parse(instrumentSchema, req.body);
    const out = await withTx(db, async (tx) => {
      if ((await tx.query(`select 1 from qc.instruments where code = $1`, [d.code])).rowCount) throw Errors.conflict('DUPLICATE', `Instrument ${d.code} exists.`);
      const row = (await tx.query(`insert into qc.instruments (code, name, technique, make_model, serial_no, location, interval_days, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id`,
        [d.code, d.name, d.technique, d.makeModel, d.serialNo, d.location, d.intervalDays, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qc.instrument.created', entityType: 'qc.instrument', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));
  // a passed calibration sets the next due date from the interval; a failed one takes the instrument out of service
  r.post('/instruments/:id/calibrations', requirePermission('qc.instrument:manage'), asyncHandler(async (req, res) => {
    const d = parse(calibrationSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const i = (await tx.query(`select id, code, interval_days from qc.instruments where id = $1 for update`, [req.params.id])).rows[0];
      if (!i) throw Errors.notFound('Instrument');
      if (d.calibratedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'A calibration cannot be dated in the future.');
      const due = addDays(d.calibratedOn, i.interval_days);
      await tx.query(`insert into qc.calibrations (instrument_id, calibrated_on, due_on, result, agency, certificate_no, document_id, remarks, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [i.id, d.calibratedOn, due, d.result, d.agency, d.certificateNo, d.documentId ?? null, d.remarks, req.auth!.user.id]);
      if (d.result === 'Pass') await tx.query(`update qc.instruments set last_calibrated = $2, calibration_due = $3, status = 'Active', status_reason = null, updated_by = $4 where id = $1`, [i.id, d.calibratedOn, due, req.auth!.user.id]);
      else await tx.query(`update qc.instruments set last_calibrated = $2, calibration_due = null, status = 'OutOfService', status_reason = $3, updated_by = $4 where id = $1`,
        [i.id, d.calibratedOn, `Failed calibration on ${d.calibratedOn}${d.remarks ? `: ${d.remarks}` : ''}`, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qc.instrument.calibrated', entityType: 'qc.instrument', entityId: i.id, after: { ...d, due } });
      return { dueOn: d.result === 'Pass' ? due : null };
    });
    res.status(201).json(out);
  }));
  r.post('/instruments/:id/retire', requirePermission('qc.instrument:manage'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const n = (await tx.query(`update qc.instruments set status = 'Retired', status_reason = $2, updated_by = $3 where id = $1 and status <> 'Retired' returning id`, [req.params.id, reason, req.auth!.user.id])).rowCount;
      if (!n) throw Errors.state('The instrument is already retired.');
      await audit(tx, actorOf(req), { action: 'qc.instrument.retired', entityType: 'qc.instrument', entityId: req.params.id!, reason });
    });
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- specifications (QC-004, QA spec approval)
  r.get('/specs', requirePermission('qc.spec:view'), asyncHandler(async (_req, res) => {
    const today = todayIST();
    res.json({ data: (await db.query(
      `select s.id, s.code, s.title, s.status, i.id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType", cur.version_no as "currentVersion",
              (select count(*)::int from qc.spec_parameters p where p.spec_version_id = cur.id) as "parameterCount",
              (select count(*)::int from qc.spec_versions x where x.spec_id = s.id and x.status = 'Submitted') as "pendingCount"
         from qc.specifications s join mdm.items i on i.id = s.item_id
         left join qc.spec_versions cur on cur.spec_id = s.id and cur.status = 'Approved' and cur.effective_from <= $1 and (cur.effective_to is null or cur.effective_to >= $1)
        order by i.item_type, i.code`, [today])).rows });
  }));
  r.post('/specs', requirePermission('qc.spec:manage'), asyncHandler(async (req, res) => {
    const d = parse(specSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const it = (await tx.query(`select status from mdm.items where id = $1`, [d.itemId])).rows[0];
      if (it?.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an approved item.');
      if ((await tx.query(`select 1 from qc.specifications where item_id = $1 or code = $2`, [d.itemId, d.code])).rowCount) throw Errors.conflict('DUPLICATE', 'This item or code already has a specification.');
      const row = (await tx.query(`insert into qc.specifications (item_id, code, title, created_by, updated_by) values ($1,$2,$3,$4,$4) returning id`, [d.itemId, d.code, d.title, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'qc.spec.created', entityType: 'qc.specification', entityId: row.id, after: d });
      return { id: row.id as string };
    });
    res.status(201).json(out);
  }));
  r.get('/specs/:id', requirePermission('qc.spec:view'), asyncHandler(async (req: Request, res) => {
    const today = todayIST();
    const s = (await db.query(`select s.id, s.code, s.title, s.status, i.id as "itemId", i.code as "itemCode", i.name as "itemName" from qc.specifications s join mdm.items i on i.id = s.item_id where s.id = $1`, [req.params.id])).rows[0];
    if (!s) throw Errors.notFound('Specification');
    const versions = (await db.query(
      `select v.id, v.version_no as "versionNo", v.effective_from as "effectiveFrom", v.effective_to as "effectiveTo", v.change_note as "changeNote", v.status, v.status_reason as "statusReason",
              case when v.status <> 'Approved' then v.status when v.effective_from > $2 then 'Scheduled' when v.effective_to is not null and v.effective_to < $2 then 'Superseded' else 'Current' end as state,
              v.version, u.full_name as "createdBy", v.created_at as "createdAt",
              (select a.id from wf.approval_requests a where a.subject_type = $3 and a.subject_id = v.id order by a.submitted_at desc limit 1) as "approvalId",
              coalesce((select json_agg(json_build_object('id', p.id, 'seq', p.seq, 'parameter', p.parameter, 'category', p.category, 'unit', p.unit, 'limitType', p.limit_type,
                 'minValue', p.min_value, 'maxValue', p.max_value, 'expectedText', p.expected_text, 'methodId', p.method_id, 'methodCode', m.code) order by p.seq)
                 from qc.spec_parameters p left join qc.test_methods m on m.id = p.method_id where p.spec_version_id = v.id), '[]'::json) as parameters
         from qc.spec_versions v join iam.users u on u.id = v.created_by where v.spec_id = $1 order by v.version_no desc`, [s.id, today, SPEC])).rows;
    res.json({ ...s, versions, canManage: can(req, 'qc.spec:manage') });
  }));

  const writeParams = async (tx: Tx, vid: string, d: z.infer<typeof specVersionSchema>) => {
    await tx.query(`delete from qc.spec_parameters where spec_version_id = $1`, [vid]);
    for (const [i, p] of d.parameters.entries()) {
      if (p.methodId && !(await tx.query(`select 1 from qc.test_methods where id = $1 and status = 'Active'`, [p.methodId])).rowCount) throw Errors.rule('REFERENCE_NOT_ACTIVE', `Parameter ${i + 1}: choose an active method.`);
      await tx.query(`insert into qc.spec_parameters (spec_version_id, seq, parameter, category, unit, limit_type, min_value, max_value, expected_text, method_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [vid, i + 1, p.parameter, p.category, p.unit, p.limitType, p.limitType === 'MAX' || p.limitType === 'TEXT' ? null : p.minValue, p.limitType === 'MIN' || p.limitType === 'TEXT' ? null : p.maxValue,
          p.limitType === 'TEXT' ? p.expectedText : null, p.methodId ?? null]);
    }
  };
  r.post('/specs/:id/versions', requirePermission('qc.spec:manage'), asyncHandler(async (req, res) => {
    const d = parse(specVersionSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const s = (await tx.query(`select id from qc.specifications where id = $1 for update`, [req.params.id])).rows[0];
      if (!s) throw Errors.notFound('Specification');
      if ((await tx.query(`select 1 from qc.spec_versions where spec_id = $1 and status in ('Draft','Submitted','Rejected')`, [s.id])).rowCount) throw Errors.state('Finish or withdraw the open draft first.');
      const no = Number((await tx.query(`select coalesce(max(version_no), 0) + 1 as n from qc.spec_versions where spec_id = $1`, [s.id])).rows[0].n);
      const v = (await tx.query(`insert into qc.spec_versions (spec_id, version_no, effective_from, change_note, created_by, updated_by) values ($1,$2,$3,$4,$5,$5) returning id`,
        [s.id, no, d.effectiveFrom, d.changeNote, req.auth!.user.id])).rows[0];
      await writeParams(tx, v.id, d);
      await audit(tx, actorOf(req), { action: `${SPEC}.created`, entityType: SPEC, entityId: v.id, after: { versionNo: no, ...d } });
      return { id: v.id as string, versionNo: no };
    });
    res.status(201).json(out);
  }));
  r.put('/specs/:id/versions/:vid', requirePermission('qc.spec:manage'), asyncHandler(async (req, res) => {
    const d = parse(specVersionSchema.and(z.object({ version: z.number().int() })), req.body);
    await withTx(db, async (tx) => {
      const v = (await tx.query(`select id, status, version from qc.spec_versions where id = $1 and spec_id = $2 for update`, [req.params.vid, req.params.id])).rows[0];
      if (!v) throw Errors.notFound('Specification version');
      if (!['Draft', 'Rejected'].includes(v.status)) throw Errors.state(`A ${v.status} version cannot be changed.`);
      if (v.version !== d.version) throw Errors.concurrent();
      await tx.query(`update qc.spec_versions set effective_from = $2, change_note = $3, updated_by = $4 where id = $1`, [v.id, d.effectiveFrom, d.changeNote, req.auth!.user.id]);
      await writeParams(tx, v.id, d);
      await audit(tx, actorOf(req), { action: `${SPEC}.edited`, entityType: SPEC, entityId: v.id, after: d });
    });
    res.json({ ok: true });
  }));
  r.post('/specs/:id/versions/:vid/submit', requirePermission('qc.spec:manage'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const v = (await tx.query(`select v.id, v.status, v.version_no, v.effective_from::text as "from", s.code, s.title from qc.spec_versions v join qc.specifications s on s.id = v.spec_id
                                  where v.id = $1 and v.spec_id = $2 for update of v`, [req.params.vid, req.params.id])).rows[0];
      if (!v) throw Errors.notFound('Specification version');
      if (!['Draft', 'Rejected'].includes(v.status)) throw Errors.state(`Only a Draft or Rejected version can be submitted (this one is ${v.status}).`);
      if (v.from < todayIST()) throw Errors.rule('INVALID_DATE', 'The effective date has passed. Edit the version first.');
      await setSpecStatus(tx, actorOf(req), v.id, 'Submitted');
      const ar = await submitForApproval(tx, actorOf(req), { subjectType: SPEC, subjectId: v.id, subjectLabel: `${v.code} v${v.version_no} — ${v.title}`, facts: {}, legalEntityId: null });
      return { status: ar.status === 'Approved' ? 'Approved' : 'Submitted', approvalDocNo: ar.doc_no };
    });
    res.json(out);
  }));

  return r;
}
