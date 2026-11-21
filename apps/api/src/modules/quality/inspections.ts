import { Router, type Request } from 'express';
import { oosCloseSchema, oosInvestigationSchema, oosRetestSchema, qcDecisionSchema, qcResultsSchema, qcSampleSchema, qcSpecResultsSchema } from '@dhruv/contracts';
import { createHmac } from 'node:crypto';
import type { Config } from '../../config';
import { nextDocNo } from '../../lib/numbering';
import { todayIST } from '../sales/quotations';
import { assertInstrumentUsable, effectiveSpec, evaluate, limitText, type SpecParam } from './qcmaster';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';

const SUBJECT = 'qc.inspection';
const P = (a: string) => `${SUBJECT}:${a}`;

async function setStatus(tx: Tx, actor: Actor, id: string, status: string, extra: Record<string, unknown> = {}) {
  await allowTransition(tx);
  await tx.query(`update qc.inspections set status = $2, updated_by = $3 where id = $1`, [id, status, actor.userId]);
  await audit(tx, actor, { action: `${SUBJECT}.status`, entityType: SUBJECT, entityId: id, after: { status, ...extra } });
  await emit(tx, SUBJECT, id, `${SUBJECT}.${status.toLowerCase()}`);
}

/** Quantity of the lot still held in quarantine or blocked, per warehouse. */
async function heldStock(tx: Tx, lotId: string) {
  return (await tx.query(`select warehouse_id, bucket, sum(qty) as qty, max(unit_cost) as unit_cost from inv.stock_ledger
                           where lot_id = $1 and bucket in ('QUARANTINE','BLOCKED') group by warehouse_id, bucket having sum(qty) > 0`, [lotId])).rows;
}

/** Moves everything held (quarantine/blocked) for the lot to another bucket — the stock effect of a QC decision. */
async function moveHeld(tx: Tx, actor: Actor, lotId: string, itemId: string, to: string, txn: string, inspectionId: string) {
  for (const h of await heldStock(tx, lotId)) {
    if (h.bucket === to) continue;
    await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by) values
                    ($1,$2,$3,$4,$5,$6,$7,'qc.inspection',$8,$9), ($1,$2,$3,$10,$11,$6,$7,'qc.inspection',$8,$9)`,
    [itemId, lotId, h.warehouse_id, h.bucket, -Number(h.qty), Number(h.unit_cost), txn, inspectionId, actor.userId, to, Number(h.qty)]);
  }
}

/**
 * Vendor rating (MDM-011) from its last 20 decided lots: 70% QC acceptance, 30% on-time delivery (receipt on or before the PO delivery date).
 * Feeds the RFQ comparison's quality score.
 */
export async function updateVendorRating(tx: Tx, partyId: string) {
  const r = (await tx.query(
    `select count(*) as n, count(*) filter (where l.qc_status = 'Released') as ok, count(*) filter (where g.receipt_date <= o.delivery_date) as on_time
       from (select * from inv.lots where party_id = $1 and qc_status in ('Released','Rejected') and source_type = 'GRN' order by qc_decided_at desc limit 20) l
       join purchase.goods_receipts g on g.id = l.source_id join purchase.purchase_orders o on o.id = g.purchase_order_id`, [partyId])).rows[0];
  const n = Number(r.n);
  if (!n) return null;
  // 5 × (70% acceptance + 30% on time), in integers so 3.25 rounds to 3.3 rather than drifting to 3.2
  const rating = Math.round((70 * Number(r.ok) + 30 * Number(r.on_time)) / (2 * n)) / 10;
  await tx.query(`update mdm.vendor_profiles set rating = $2 where party_id = $1`, [partyId, rating]);
  return rating;
}

const insSelect = `select qi.id, qi.doc_no as "docNo", qi.status, qi.lot_id as "lotId", lt.lot_no as "lotNo", lt.vendor_lot_no as "vendorLotNo", lt.mfg_date as "mfgDate",
    lt.expiry_date as "expiryDate", lt.qc_status as "lotStatus", qi.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType", i.base_uom as uom,
    lt.party_id as "partyId", p.legal_name as "vendorName", g.id as "grnId", g.doc_no as "grnNo", g.receipt_date as "receiptDate", o.id as "poId", o.doc_no as "poNo",
    w.code as "warehouseCode", qi.sample_qty as "sampleQty", su.full_name as "sampledBy", qi.sampled_at as "sampledAt", qi.coa_received as "coaReceived",
    qi.coa_document_id as "coaDocumentId", tu.full_name as "testedBy", qi.tested_by as "testedById", qi.tested_at as "testedAt", qi.recommendation, qi.decision,
    qi.decision_remarks as "decisionRemarks", qi.source_type as "sourceType", du.full_name as "decidedBy", qi.decided_at as "decidedAt", qi.created_at as "createdAt", qi.version,
    (select coalesce(sum(sl.qty), 0) from inv.stock_ledger sl where sl.lot_id = lt.id and sl.txn_type = 'GRN') as "receivedQty"
  from qc.inspections qi join inv.lots lt on lt.id = qi.lot_id join mdm.items i on i.id = qi.item_id left join mdm.parties p on p.id = lt.party_id
  left join purchase.goods_receipts g on g.id = qi.source_id left join purchase.purchase_orders o on o.id = g.purchase_order_id left join org.warehouses w on w.id = g.warehouse_id
  left join iam.users su on su.id = qi.sampled_by left join iam.users tu on tu.id = qi.tested_by left join iam.users du on du.id = qi.decided_by`;

function allowedActions(req: Request, row: { status: string; testedById: string | null }) {
  const out: string[] = [];
  if (row.status === 'Pending' && can(req, P('record'))) out.push('sample');
  if (['Sampled', 'Tested'].includes(row.status) && can(req, P('record'))) out.push('results');
  if (['Tested', 'Hold'].includes(row.status) && can(req, P('decide')) && row.testedById !== req.auth!.user.id) out.push('decide');
  if (['Released', 'QcApproved'].includes(row.status) && can(req, P('decide')) && row.testedById !== req.auth!.user.id) out.push('coa');
  return out;
}

/** Signature of an issued CoA (QR-verifiable), keyed from the application key. */
export function coaSignature(cfg: Config, docNo: string, versionNo: number) {
  const key = createHmac('sha256', Buffer.from(cfg.APP_ENCRYPTION_KEY, 'base64')).update('coa-v1').digest();
  return createHmac('sha256', key).update(`${docNo}|${versionNo}`).digest('base64url').slice(0, 16);
}

/** Pass/fail of the latest attempt of every test (QC-007: retests add attempts; the originals stay). */
async function latestFailures(tx: Db | Tx, inspectionId: string) {
  return Number((await tx.query(`select count(*) from (select distinct on (seq) pass from qc.inspection_results where inspection_id = $1 order by seq, attempt desc) x where not pass`, [inspectionId])).rows[0].count);
}

export function inspectionRoutes(db: Db, cfg: Config) {
  const r = Router();
  async function load(dbx: Db | Tx, id: string, lock = false) {
    const row = (await dbx.query(`${insSelect} where qi.id = $1 ${lock ? 'for update of qi' : ''}`, [id])).rows[0];
    if (!row) throw Errors.notFound('Inspection');
    return row;
  }

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const status = str(req.query.status);
    if (status === 'open') where.push(`qi.status in ('Pending','Sampled','Tested','Hold')`);
    else if (status) { args.push(status); where.push(`qi.status = $${args.length}`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(qi.doc_no ilike $${args.length} or lt.lot_no ilike $${args.length} or i.code ilike $${args.length} or i.name ilike $${args.length} or p.legal_name ilike $${args.length})`); }
    const rows = await db.query(`${insSelect.replace('select qi.id,', 'select count(*) over() as total, qi.id,')} where ${where.join(' and ')}
      order by case qi.status when 'Pending' then 0 when 'Sampled' then 1 when 'Tested' then 2 when 'Hold' then 3 else 4 end, qi.created_at limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const ins = await load(db, req.params.id!);
    const results = (await db.query(`select r.seq, r.parameter, r.specification, r.result, r.pass, r.attempt, r.spec_parameter_id as "specParameterId", ins.code as "instrumentCode",
        m.code as "methodCode", u.full_name as analyst, r.recorded_at as "recordedAt"
      from qc.inspection_results r left join qc.instruments ins on ins.id = r.instrument_id left join qc.test_methods m on m.id = r.method_id left join iam.users u on u.id = r.analyst_id
      where r.inspection_id = $1 order by r.seq, r.attempt`, [ins.id])).rows;
    const spec = await effectiveSpec(db, ins.itemId, todayIST());
    const oos = (await db.query(`select o.id, o.doc_no as "docNo", o.parameters, o.status, o.conclusion, o.opened_at as "openedAt" from qc.oos_cases o where o.inspection_id = $1 order by o.opened_at`, [ins.id])).rows;
    const coa = (await db.query(`select doc_no as "docNo", version_no as "versionNo", issued_at as "issuedAt" from qc.coas where inspection_id = $1 and status = 'Current'`, [ins.id])).rows[0] ?? null;
    const stock = (await db.query(`select bucket, sum(qty) as qty from inv.stock_ledger where lot_id = $1 group by bucket having sum(qty) <> 0`, [ins.lotId])).rows;
    // the last results of this item's previous inspections, as a starting template for the analyst
    const template = (await db.query(
      `select r.parameter, r.specification from qc.inspection_results r join qc.inspections qi on qi.id = r.inspection_id
        where qi.item_id = $1 and qi.id <> $2 and qi.tested_at is not null and qi.tested_at = (select max(tested_at) from qc.inspections where item_id = $1 and id <> $2)
        order by r.seq`, [ins.itemId, ins.id])).rows;
    res.json({ ...ins, spec: spec ? { ...spec, parameters: spec.parameters.map((p: SpecParam) => ({ ...p, limit: limitText(p) })) } : null, oos, coa, results, stock, template, allowedActions: allowedActions(req, ins) });
  }));

  // sampling: the sample quantity is drawn from the quarantined lot (BRD p.15)
  r.post('/:id/sample', requirePermission(P('record')), asyncHandler(async (req, res) => {
    const { sampleQty } = parse(qcSampleSchema, req.body);
    await withTx(db, async (tx) => {
      const ins = await load(tx, req.params.id!, true);
      if (ins.status !== 'Pending') throw Errors.state('This lot has already been sampled.');
      const held = await heldStock(tx, ins.lotId);
      const q = held.find((h) => h.bucket === 'QUARANTINE');
      if (sampleQty > 0) {
        if (!q || sampleQty > Number(q.qty)) throw Errors.rule('SAMPLE_TOO_LARGE', 'The sample cannot be larger than the quantity in quarantine.');
        await tx.query(`insert into inv.stock_ledger (item_id, lot_id, warehouse_id, bucket, qty, unit_cost, txn_type, source_type, source_id, created_by)
                        values ($1,$2,$3,'QUARANTINE',$4,$5,'SAMPLE','qc.inspection',$6,$7)`, [ins.itemId, ins.lotId, q.warehouse_id, -sampleQty, Number(q.unit_cost), ins.id, req.auth!.user.id]);
      }
      await tx.query(`update qc.inspections set sample_qty = $2, sampled_by = $3, sampled_at = now() where id = $1`, [ins.id, sampleQty, req.auth!.user.id]);
      await setStatus(tx, actorOf(req), ins.id, 'Sampled', { sampleQty });
    });
    res.json({ ok: true });
  }));

  // results and the analyst's recommendation (can be re-entered until a decision)
  r.post('/:id/results', requirePermission(P('record')), asyncHandler(async (req, res) => {
    const d = parse(qcResultsSchema, req.body);
    await withTx(db, async (tx) => {
      const ins = await load(tx, req.params.id!, true);
      if (!['Sampled', 'Tested'].includes(ins.status)) throw Errors.state(ins.status === 'Pending' ? 'Sample the lot first.' : 'The lot has already been decided.');
      if (await effectiveSpec(tx, ins.itemId, todayIST())) throw Errors.rule('SPEC_RESULTS_REQUIRED', 'This item has an approved specification: enter the results against it.');
      if ((await tx.query(`select 1 from qc.oos_cases where inspection_id = $1`, [ins.id])).rowCount) throw Errors.rule('RESULTS_FROZEN', 'An OOS investigation is open on these results; retests go through it.');
      if (d.coaDocumentId) {
        const doc = (await tx.query(`select entity_type, entity_id from sys.documents where id = $1 and status = 'Active'`, [d.coaDocumentId])).rows[0];
        if (doc?.entity_type !== SUBJECT || doc.entity_id !== ins.id) throw Errors.rule('DOCUMENT_INVALID', 'Upload the certificate of analysis to this inspection first.');
      }
      if (d.recommendation === 'Release' && d.results.some((x) => !x.pass)) throw Errors.rule('RESULTS_FAILED', 'A failed test cannot be recommended for release. Recommend rejection or hold.');
      await tx.query(`delete from qc.inspection_results where inspection_id = $1`, [ins.id]);
      let seq = 0;
      for (const x of d.results) await tx.query(`insert into qc.inspection_results (inspection_id, seq, parameter, specification, result, pass) values ($1,$2,$3,$4,$5,$6)`, [ins.id, ++seq, x.parameter, x.specification, x.result, x.pass]);
      await tx.query(`update qc.inspections set coa_received = $2, coa_document_id = $3, recommendation = $4, tested_by = $5, tested_at = now() where id = $1`,
        [ins.id, d.coaReceived, d.coaDocumentId ?? null, d.recommendation, req.auth!.user.id]);
      if (ins.status !== 'Tested') await setStatus(tx, actorOf(req), ins.id, 'Tested', { recommendation: d.recommendation });
      else await audit(tx, actorOf(req), { action: `${SUBJECT}.results_updated`, entityType: SUBJECT, entityId: ins.id, after: d });
    });
    res.json({ ok: true });
  }));

  /**
   * Results against the effective specification (QC-004, QC-008, TC-12): every parameter, with the instrument (calibrated and in service).
   * Pass/fail is computed from the limits, not typed. Any result out of specification opens an OOS case and freezes the results:
   * the lot cannot be released, and a retest needs the QC manager's authorisation through the case.
   */
  r.post('/:id/spec-results', requirePermission(P('record')), asyncHandler(async (req, res) => {
    const d = parse(qcSpecResultsSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const ins = await load(tx, req.params.id!, true);
      if (!['Sampled', 'Tested'].includes(ins.status)) throw Errors.state(ins.status === 'Pending' ? 'Sample the lot first.' : 'The lot has already been decided.');
      if ((await tx.query(`select 1 from qc.oos_cases where inspection_id = $1`, [ins.id])).rowCount) throw Errors.rule('RESULTS_FROZEN', 'An OOS investigation is open on these results; retests go through it.');
      const spec = await effectiveSpec(tx, ins.itemId, todayIST());
      if (!spec) throw Errors.rule('NO_SPECIFICATION', 'This item has no approved specification in force.');
      const missing = spec.parameters.filter((p: SpecParam) => !d.results.some((x) => x.specParameterId === p.id));
      if (missing.length) throw Errors.rule('RESULTS_INCOMPLETE', `Enter every parameter of the specification: ${missing.map((p: SpecParam) => p.parameter).join(', ')} missing.`);
      if (d.coaDocumentId) {
        const doc = (await tx.query(`select entity_type, entity_id from sys.documents where id = $1 and status = 'Active'`, [d.coaDocumentId])).rows[0];
        if (doc?.entity_type !== SUBJECT || doc.entity_id !== ins.id) throw Errors.rule('DOCUMENT_INVALID', 'Upload the certificate of analysis to this inspection first.');
      }
      await tx.query(`delete from qc.inspection_results where inspection_id = $1`, [ins.id]);
      const failed: string[] = [];
      for (const p of spec.parameters) {
        const x = d.results.find((y) => y.specParameterId === p.id)!;
        if (x.instrumentId) await assertInstrumentUsable(tx, x.instrumentId);
        else if (p.technique && !['VISUAL', 'OTHER'].includes(p.technique)) throw Errors.rule('INSTRUMENT_REQUIRED', `${p.parameter}: choose the instrument used (${p.technique}).`);
        const ev = evaluate(p, x.value);
        if (!ev.pass) failed.push(`${p.parameter} ${x.value} (spec ${limitText(p)})`);
        await tx.query(`insert into qc.inspection_results (inspection_id, seq, parameter, specification, result, pass, spec_parameter_id, numeric_value, method_id, instrument_id, attempt, analyst_id)
                        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)`,
          [ins.id, p.seq, p.parameter, limitText(p), x.value, ev.pass, p.id, ev.numeric, p.methodId, x.instrumentId ?? null, req.auth!.user.id]);
      }
      const recommendation = failed.length ? 'Hold' : d.recommendation;
      await tx.query(`update qc.inspections set spec_version_id = $2, coa_received = $3, coa_document_id = $4, recommendation = $5, tested_by = $6, tested_at = now() where id = $1`,
        [ins.id, spec.id, d.coaReceived, d.coaDocumentId ?? null, recommendation, req.auth!.user.id]);
      let oosNo: string | null = null;
      if (failed.length) {
        oosNo = await nextDocNo(tx, 'OOS_CASE');
        const c = (await tx.query(`insert into qc.oos_cases (doc_no, inspection_id, parameters, updated_by) values ($1,$2,$3,$4) returning id`, [oosNo, ins.id, failed.join('; '), req.auth!.user.id])).rows[0];
        await audit(tx, actorOf(req), { action: 'qc.oos.opened', entityType: 'qc.oos_case', entityId: c.id, after: { docNo: oosNo, lot: ins.lotNo, failed } });
        await emit(tx, 'qc.oos_case', c.id, 'qc.oos.opened');
      }
      if (ins.status !== 'Tested') await setStatus(tx, actorOf(req), ins.id, 'Tested', { recommendation, oos: oosNo });
      else await audit(tx, actorOf(req), { action: `${SUBJECT}.results_updated`, entityType: SUBJECT, entityId: ins.id, after: { results: d.results, oos: oosNo } });
      return { passed: !failed.length, failed, oosNo, recommendation };
    });
    res.json(out);
  }));

  // controlled CoA (QC-006, QC-013): issued by the QC manager after the decision; a reissue supersedes the previous version
  r.post('/:id/coa', requirePermission(P('decide')), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const ins = await load(tx, req.params.id!, true);
      if (!['Released', 'QcApproved'].includes(ins.status)) throw Errors.state('A certificate is issued for a lot QC has approved or released.');
      if (!ins.testedById || ins.testedById === req.auth!.user.id) throw Errors.sod('The analyst who tested the lot cannot sign its certificate as approver.');
      const prev = (await tx.query(`select doc_no, max(version_no) as v from qc.coas where inspection_id = $1 group by doc_no`, [ins.id])).rows[0];
      const docNo = prev?.doc_no ?? await nextDocNo(tx, 'COA');
      const versionNo = Number(prev?.v ?? 0) + 1;
      const results = (await tx.query(`select distinct on (r.seq) r.seq, r.parameter, r.specification, r.result, r.pass, p.category, m.code as method, i.code as instrument
        from qc.inspection_results r left join qc.spec_parameters p on p.id = r.spec_parameter_id left join qc.test_methods m on m.id = r.method_id
        left join qc.instruments i on i.id = r.instrument_id where r.inspection_id = $1 order by r.seq, r.attempt desc`, [ins.id])).rows;
      const sv = (await tx.query(`select s.code, v.version_no from qc.inspections q left join qc.spec_versions v on v.id = q.spec_version_id left join qc.specifications s on s.id = v.spec_id where q.id = $1`, [ins.id])).rows[0];
      const analyst = (await tx.query(`select full_name from iam.users where id = $1`, [ins.testedById])).rows[0]?.full_name;
      const content = { lotNo: ins.lotNo, itemCode: ins.itemCode, itemName: ins.itemName, inspectionNo: ins.docNo, spec: sv?.code ? `${sv.code} v${sv.version_no}` : null,
        mfgDate: (await tx.query(`select mfg_date, expiry_date from inv.lots where id = $1`, [ins.lotId])).rows[0], results, analyst, approver: req.auth!.user.fullName ?? null,
        testedAt: ins.testedAt, conclusion: results.every((x) => x.pass) ? 'Complies with the specification' : 'Does not comply' };
      await tx.query(`update qc.coas set status = 'Superseded' where inspection_id = $1 and status = 'Current'`, [ins.id]);
      await tx.query(`insert into qc.coas (doc_no, inspection_id, version_no, analyst_id, approver_id, content, signature) values ($1,$2,$3,$4,$5,$6,$7)`,
        [docNo, ins.id, versionNo, ins.testedById, req.auth!.user.id, JSON.stringify(content), coaSignature(cfg, docNo, versionNo)]);
      await audit(tx, actorOf(req), { action: 'qc.coa.issued', entityType: SUBJECT, entityId: ins.id, after: { docNo, versionNo } });
      return { docNo, versionNo };
    });
    res.status(201).json(out);
  }));

  r.get('/:id/coa', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const c = (await db.query(`select c.doc_no as "docNo", c.version_no as "versionNo", c.issued_at as "issuedAt", c.content, c.signature, a.full_name as analyst, ap.full_name as approver
      from qc.coas c join iam.users a on a.id = c.analyst_id join iam.users ap on ap.id = c.approver_id where c.inspection_id = $1 and c.status = 'Current'`, [req.params.id])).rows[0];
    if (!c) throw Errors.notFound('Certificate of analysis');
    const origin = `${req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}`;
    const url = `${origin}/verify-coa/${encodeURIComponent(c.docNo)}?v=${c.versionNo}&s=${c.signature}`;
    const { default: QRCode } = await import('qrcode');
    res.json({ ...c, signature: undefined, url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 0 }) });
  }));

  /**
   * Disposition (BRD p.15, doc 07 §6): the QC manager decides — never the analyst who tested it. Release needs every test passed and the
   * vendor's certificate of analysis; it moves the lot to unrestricted stock. Reject moves it to rejected stock (to be returned); hold blocks it.
   */
  r.post('/:id/decide', requirePermission(P('decide')), asyncHandler(async (req, res) => {
    const d = parse(qcDecisionSchema, req.body);
    const out = await withTx(db, async (tx) => {
      const ins = await load(tx, req.params.id!, true);
      if (!['Tested', 'Hold'].includes(ins.status)) throw Errors.state(ins.status === 'Released' || ins.status === 'Rejected' ? 'This lot has already been decided.' : 'Record the test results first.');
      if (ins.testedById === req.auth!.user.id) throw Errors.sod('You recorded the results of this lot; another QC manager must decide it.');
      if (ins.status === 'Hold' && d.decision === 'Hold') throw Errors.state('The lot is already on hold.');
      // finished goods (D04, BRD p.4/p.16): QC approves the results; the lot stays in quarantine until the QA head releases it
      if (d.decision === 'Release') {
        const cases = (await tx.query(`select doc_no, status, conclusion from qc.oos_cases where inspection_id = $1`, [ins.id])).rows;
        const open = cases.find((c) => c.status !== 'Closed');
        if (open) throw Errors.rule('OOS_OPEN', `OOS investigation ${open.doc_no} is still open — the lot cannot be released.`);
        const confirmed = cases.find((c) => c.conclusion === 'Confirmed');
        if (confirmed) throw Errors.rule('OOS_CONFIRMED', `OOS ${confirmed.doc_no} was confirmed — the lot must be rejected.`);
      }
      if (d.decision === 'Release' && ins.sourceType === 'PRODUCTION') {
        const failed = await latestFailures(tx, ins.id);
        if (failed) throw Errors.rule('RESULTS_FAILED', `${failed} test(s) failed — the results cannot be approved.`);
        await allowTransition(tx);
        await tx.query(`update qc.inspections set decision = 'Release', decision_remarks = $2, decided_by = $3, decided_at = now() where id = $1`, [ins.id, d.remarks || null, req.auth!.user.id]);
        await setStatus(tx, actorOf(req), ins.id, 'QcApproved', { decision: 'QC approved', remarks: d.remarks });
        return { lotStatus: 'Quarantine', qcApproved: true, vendorRating: null };
      }
      if (d.decision === 'Release') {
        const failed = await latestFailures(tx, ins.id);
        if (failed) throw Errors.rule('RESULTS_FAILED', `${failed} test(s) failed — the lot cannot be released.`);
        if (!ins.coaReceived) throw Errors.rule('COA_REQUIRED', "The vendor's certificate of analysis has not been received — the lot cannot be released (BRD p.15).");
      }
      const to = d.decision === 'Release' ? 'UNRESTRICTED' : d.decision === 'Reject' ? 'REJECTED' : 'BLOCKED';
      const txn = d.decision === 'Release' ? 'QC_RELEASE' : d.decision === 'Reject' ? 'QC_REJECT' : 'QC_HOLD';
      await moveHeld(tx, actorOf(req), ins.lotId, ins.itemId, to, txn, ins.id);
      const lotStatus = d.decision === 'Release' ? 'Released' : d.decision === 'Reject' ? 'Rejected' : 'Hold';
      await allowTransition(tx);
      await tx.query(`update inv.lots set qc_status = $2, qc_decided_by = $3, qc_decided_at = now() where id = $1`, [ins.lotId, lotStatus, req.auth!.user.id]);
      await tx.query(`update qc.inspections set decision = $2, decision_remarks = $3, decided_by = $4, decided_at = now() where id = $1`, [ins.id, d.decision, d.remarks || null, req.auth!.user.id]);
      await setStatus(tx, actorOf(req), ins.id, lotStatus, { decision: d.decision, remarks: d.remarks });
      const rating = ins.partyId && d.decision !== 'Hold' ? await updateVendorRating(tx, ins.partyId) : null;
      return { lotStatus, vendorRating: rating };
    });
    res.json(out);
  }));

  return r;
}
