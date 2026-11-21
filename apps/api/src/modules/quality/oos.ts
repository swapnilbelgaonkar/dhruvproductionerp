import { Router } from 'express';
import { oosCloseSchema, oosInvestigationSchema, oosRetestSchema } from '@dhruv/contracts';
import type { Config } from '../../config';
import { allowTransition, withTx, type Db } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { coaSignature } from './inspections';
import { assertInstrumentUsable, evaluate, limitText } from './qcmaster';

/**
 * OOS / OOT investigation (BRD p.15 sub-module 4; MP §13.6; QC-007; TC-12). Opened automatically by an out-of-specification result.
 * The QC manager records the laboratory (phase 1) investigation and may authorise a retest; the analyst's retest results are added as a new
 * attempt — the original result is never overwritten. The manager closes the case: Invalidated (laboratory error, the retest passed) lets the
 * lot be decided on the retest; Confirmed means the lot fails and must be rejected.
 */
const select = `select o.id, o.doc_no as "docNo", o.inspection_id as "inspectionId", q.doc_no as "inspectionNo", l.id as "lotId", l.lot_no as "lotNo", i.code as "itemCode", i.name as "itemName",
    o.parameters, o.status, o.phase1_findings as "phase1Findings", o.root_cause as "rootCause", o.conclusion, o.opened_at as "openedAt",
    au.full_name as "retestAuthorisedBy", o.retest_authorised_at as "retestAuthorisedAt", cu.full_name as "closedBy", o.closed_at as "closedAt", o.version
  from qc.oos_cases o join qc.inspections q on q.id = o.inspection_id join inv.lots l on l.id = q.lot_id join mdm.items i on i.id = q.item_id
  left join iam.users au on au.id = o.retest_authorised_by left join iam.users cu on cu.id = o.closed_by`;

export function oosRoutes(db: Db) {
  const r = Router();
  r.get('/', requirePermission('qc.inspection:view'), asyncHandler(async (req, res) => {
    const status = str(req.query.status);
    const rows = (await db.query(`${select} ${status === 'open' ? `where o.status <> 'Closed'` : status === 'closed' ? `where o.status = 'Closed'` : ''} order by o.opened_at desc limit 200`)).rows;
    res.json({ data: rows, total: rows.length });
  }));
  r.get('/:id', requirePermission('qc.inspection:view'), asyncHandler(async (req, res) => {
    const o = (await db.query(`${select} where o.id = $1`, [req.params.id])).rows[0];
    if (!o) throw Errors.notFound('OOS case');
    const results = (await db.query(`select r.seq, r.parameter, r.specification, r.result, r.pass, r.attempt, r.spec_parameter_id as "specParameterId", ins.code as "instrumentCode",
      u.full_name as analyst, r.recorded_at as "recordedAt" from qc.inspection_results r left join qc.instruments ins on ins.id = r.instrument_id left join iam.users u on u.id = r.analyst_id
      where r.inspection_id = $1 order by r.seq, r.attempt`, [o.inspectionId])).rows;
    const failedParams = [...new Set(results.filter((x) => x.attempt === 1 && !x.pass).map((x) => x.specParameterId as string))];
    const actions: string[] = [];
    if (o.status === 'Open' && can(req, 'qc.inspection:decide')) actions.push('investigate');
    if (o.status === 'RetestAuthorised' && can(req, 'qc.inspection:record')) actions.push('retest');
    if (o.status !== 'Closed' && can(req, 'qc.inspection:decide')) actions.push('close');
    res.json({ ...o, results, failedParams, allowedActions: actions });
  }));

  r.post('/:id/investigate', requirePermission('qc.inspection:decide'), asyncHandler(async (req, res) => {
    const d = parse(oosInvestigationSchema, req.body);
    await withTx(db, async (tx) => {
      const o = (await tx.query(`select id, status from qc.oos_cases where id = $1 for update`, [req.params.id])).rows[0];
      if (!o) throw Errors.notFound('OOS case');
      if (o.status !== 'Open') throw Errors.state(`The case is ${o.status}.`);
      await allowTransition(tx);
      await tx.query(`update qc.oos_cases set phase1_findings = $2, status = $3, retest_authorised_by = case when $4 then $5::uuid end, retest_authorised_at = case when $4 then now() end, updated_by = $5 where id = $1`,
        [o.id, d.phase1Findings, d.authoriseRetest ? 'RetestAuthorised' : 'Open', d.authoriseRetest, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qc.oos.investigated', entityType: 'qc.oos_case', entityId: o.id, after: d });
    });
    res.json({ ok: true });
  }));

  // a retest adds attempt n+1 for the parameters that failed; only after the manager authorised it
  r.post('/:id/retest', requirePermission('qc.inspection:record'), asyncHandler(async (req, res) => {
    const d = parse(oosRetestSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const o = (await tx.query(`select id, status, inspection_id from qc.oos_cases where id = $1 for update`, [req.params.id])).rows[0];
      if (!o) throw Errors.notFound('OOS case');
      if (o.status !== 'RetestAuthorised') throw Errors.rule('RETEST_NOT_AUTHORISED', 'A retest needs the QC manager’s authorisation on the OOS case.');
      let allPass = true;
      for (const x of d.results) {
        const p = (await tx.query(`select p.*, m.technique, (select max(attempt) from qc.inspection_results r where r.inspection_id = $2 and r.spec_parameter_id = p.id) as last
          from qc.spec_parameters p left join qc.test_methods m on m.id = p.method_id where p.id = $1`, [x.specParameterId, o.inspection_id])).rows[0];
        if (!p?.last) throw Errors.rule('NOT_IN_CASE', 'Retest only the parameters of this inspection.');
        if (x.instrumentId) await assertInstrumentUsable(tx, x.instrumentId);
        const lim = { limitType: p.limit_type, minValue: p.min_value, maxValue: p.max_value, expectedText: p.expected_text, unit: p.unit };
        const ev = evaluate(lim, x.value);
        allPass &&= ev.pass;
        await tx.query(`insert into qc.inspection_results (inspection_id, seq, parameter, specification, result, pass, spec_parameter_id, numeric_value, method_id, instrument_id, attempt, analyst_id)
                        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [o.inspection_id, p.seq, p.parameter, limitText(lim), x.value, ev.pass, p.id, ev.numeric, p.method_id, x.instrumentId ?? null, Number(p.last) + 1, req.auth!.user.id]);
      }
      await audit(tx, actorOf(req), { action: 'qc.oos.retested', entityType: 'qc.oos_case', entityId: o.id, after: { results: d.results, allPass } });
      return { allPass };
    });
    res.status(201).json(out);
  }));

  r.post('/:id/close', requirePermission('qc.inspection:decide'), asyncHandler(async (req, res) => {
    const d = parse(oosCloseSchema, req.body);
    await withTx(db, async (tx) => {
      const o = (await tx.query(`select id, status, inspection_id from qc.oos_cases where id = $1 for update`, [req.params.id])).rows[0];
      if (!o) throw Errors.notFound('OOS case');
      if (o.status === 'Closed') throw Errors.state('The case is already closed.');
      if (d.conclusion === 'Invalidated') {
        const bad = Number((await tx.query(`select count(*) from (select distinct on (seq) pass, attempt from qc.inspection_results where inspection_id = $1 order by seq, attempt desc) x
          where not pass or attempt = 1 and not pass`, [o.inspection_id])).rows[0].count);
        if (bad) throw Errors.rule('RETEST_NOT_PASSED', 'To invalidate the OOS, the authorised retest of every failed parameter must pass.');
      }
      await allowTransition(tx);
      await tx.query(`update qc.oos_cases set status = 'Closed', conclusion = $2, root_cause = $3, closed_by = $4, closed_at = now(), updated_by = $4 where id = $1`, [o.id, d.conclusion, d.rootCause, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qc.oos.closed', entityType: 'qc.oos_case', entityId: o.id, after: d });
      await emit(tx, 'qc.oos_case', o.id, `qc.oos.${d.conclusion.toLowerCase()}`);
    });
    res.json({ ok: true });
  }));
  return r;
}

/** Public CoA check: the QR on a certificate opens this (no sign-in). */
export function publicCoaRoutes(db: Db, cfg: Config) {
  const r = Router();
  r.get('/coa/:docNo', asyncHandler(async (req, res) => {
    const v = Number(str(req.query.v));
    const c = (await db.query(`select doc_no, version_no, signature, status, content, issued_at from qc.coas where doc_no = $1 and version_no = $2`, [req.params.docNo, v])).rows[0];
    const s = str(req.query.s) ?? '';
    if (!c || s !== c.signature || s !== coaSignature(cfg, c.doc_no, c.version_no)) { res.json({ genuine: false }); return; }
    res.json({ genuine: true, docNo: c.doc_no, versionNo: c.version_no, current: c.status === 'Current', issuedAt: c.issued_at, product: c.content.itemName, lotNo: c.content.lotNo,
      conclusion: c.content.conclusion });
  }));
  return r;
}
