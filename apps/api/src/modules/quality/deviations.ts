import { Router } from 'express';
import { z } from 'zod';
import { allowTransition, withTx, type Db } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';

/**
 * Deviation register (QA-005): raised automatically by the quarantine override (D33), and in part 3 by dosing outside tolerance and IPQC failures.
 * QA closes a deviation with its conclusion. An open deviation blocks the release of the batch it belongs to (QA-003, TC-13).
 */
const P = (a: string) => `qa.deviation:${a}`;
const closeSchema = z.object({ note: z.string().trim().min(1, 'Required').max(2000) });

const select = `select d.id, d.doc_no as "docNo", d.category, d.title, d.description, d.status, d.production_order_id as "productionOrderId", po.doc_no as "productionOrderNo",
    d.lot_id as "lotId", l.lot_no as "lotNo", l.qc_status as "lotStatus", i.code as "itemCode", d.source_type as "sourceType", d.source_id as "sourceId",
    ru.full_name as "raisedBy", d.created_at as "createdAt", d.closure_note as "closureNote", cu.full_name as "closedBy", d.closed_at as "closedAt", d.version
  from qa.deviations d left join mfg.production_orders po on po.id = d.production_order_id left join inv.lots l on l.id = d.lot_id left join mdm.items i on i.id = l.item_id
  left join iam.users ru on ru.id = d.raised_by left join iam.users cu on cu.id = d.closed_by`;

export function deviationRoutes(db: Db) {
  const r = Router();

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(d.doc_no ilike $${args.length} or d.title ilike $${args.length} or po.doc_no ilike $${args.length} or l.lot_no ilike $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`d.status = $${args.length}`); }
    const rows = (await db.query(`${select.replace('select d.id,', 'select count(*) over() as total, d.id,')} where ${where.join(' and ')}
      order by case d.status when 'Open' then 0 else 1 end, d.created_at desc limit ${limit} offset ${offset}`, args)).rows;
    res.json({ data: rows.map(({ total: _t, ...x }) => x), total: Number(rows[0]?.total ?? 0) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const d = (await db.query(`${select} where d.id = $1`, [req.params.id])).rows[0];
    if (!d) throw Errors.notFound('Deviation');
    const waitingForQc = d.category === 'QUARANTINE_OVERRIDE' && d.lotStatus === 'Quarantine';
    res.json({ ...d, waitingForQc, allowedActions: d.status === 'Open' && can(req, P('close')) && !waitingForQc ? ['close'] : [] });
  }));

  r.post('/:id/close', requirePermission(P('close')), asyncHandler(async (req, res) => {
    const { note } = parse(closeSchema, req.body);
    await withTx(db, async (tx) => {
      const d = (await tx.query(`${select} where d.id = $1 for update of d`, [req.params.id])).rows[0];
      if (!d) throw Errors.notFound('Deviation');
      if (d.status !== 'Open') throw Errors.state('This deviation is already closed.');
      // D33: an override deviation stays open until QC has decided on the lot
      if (d.category === 'QUARANTINE_OVERRIDE' && d.lotStatus === 'Quarantine') throw Errors.rule('LOT_STILL_IN_QUARANTINE', `Lot ${d.lotNo} has not been decided by QC yet.`);
      await allowTransition(tx);
      await tx.query(`update qa.deviations set status = 'Closed', closure_note = $2, closed_by = $3, closed_at = now(), updated_by = $3 where id = $1`, [d.id, note, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'qa.deviation.closed', entityType: 'qa.deviation', entityId: d.id, before: { status: 'Open' }, after: { status: 'Closed', note } });
      await emit(tx, 'qa.deviation', d.id, 'qa.deviation.closed');
    });
    res.json({ ok: true });
  }));

  return r;
}
