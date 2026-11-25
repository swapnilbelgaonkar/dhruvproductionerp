import { Router, type Request } from 'express';
import { usableStatuses } from '../parties/shared';
import { z } from 'zod';
import {
  activityCompleteSchema, activitySchema, bantSchema, leadDisqualifySchema, leadSchema, leadTransferSchema, OPEN_STAGES, opportunitySchema,
  reasonSchema, stageChangeSchema,
} from '@dhruv/contracts';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit, diff, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextMasterCode } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, territoryScope } from '../../middleware/context';

const OPEN = OPEN_STAGES as readonly string[];
const LEAD_OPEN = ['New', 'Contacted', 'Qualified'];

/** Restricts a query to records whose territory column falls in the user's territory subtree. */
async function scoped(dbx: Db | Tx, req: Request, perm: string, column: string, args: unknown[]) {
  const ids = await territoryScope(dbx, req, perm);
  if (ids === null) return 'true';
  args.push(ids);
  return `exists (select 1 from org.territories rt join org.territories ut on rt.path <@ ut.path where rt.id = ${column} and ut.id = any($${args.length}::uuid[]))`;
}

async function inTerritoryScope(dbx: Db | Tx, req: Request, perm: string, territoryId: string) {
  const ids = await territoryScope(dbx, req, perm);
  if (ids === null) return true;
  const r = await dbx.query(`select 1 from org.territories rt join org.territories ut on rt.path <@ ut.path where rt.id = $1 and ut.id = any($2::uuid[])`, [territoryId, ids]);
  return (r.rowCount ?? 0) > 0;
}

/** BANT score 0–100: budget 25, authority 25, need score × 5, timeline 25/15/5 by how soon. */
export function bantScore(b: { budget: boolean; authority: boolean; needScore: number; timeline: string }, today = new Date()) {
  const days = Math.ceil((new Date(b.timeline).getTime() - today.getTime()) / 86_400_000);
  const t = days <= 90 ? 25 : days <= 180 ? 15 : days <= 365 ? 5 : 0;
  return (b.budget ? 25 : 0) + (b.authority ? 25 : 0) + b.needScore * 5 + t;
}

async function myEmployee(dbx: Db | Tx, req: Request) {
  const id = req.auth!.user.employeeId;
  if (!id) throw Errors.rule('NO_EMPLOYEE_LINK', 'Your user account is not linked to an employee. Ask an administrator to link it.');
  const e = (await dbx.query(`select id, territory_id from org.employees where id = $1 and status = 'Active'`, [id])).rows[0];
  if (!e) throw Errors.rule('NO_EMPLOYEE_LINK', 'Your employee record is inactive.');
  return e as { id: string; territory_id: string | null };
}

async function assertOwner(tx: Tx, req: Request, perm: string, ownerId: string, territoryId: string) {
  const t = (await tx.query(`select status from org.territories where id = $1`, [territoryId])).rows[0];
  if (!t || t.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active territory.');
  const o = (await tx.query(`select status, sales_tier from org.employees where id = $1`, [ownerId])).rows[0];
  if (!o || o.status !== 'Active' || !o.sales_tier) throw Errors.rule('REFERENCE_NOT_ACTIVE', 'The owner must be an active member of the sales hierarchy.');
  if (!(await inTerritoryScope(tx, req, perm, territoryId))) throw Errors.forbidden(`${perm} in this territory`);
}

const leadSelect = `select l.id, l.code, l.company, l.contact_person as "contactPerson", l.mobile, l.email, l.source, l.source_detail as "sourceDetail",
    l.territory_id as "territoryId", t.name as territory, l.owner_id as "ownerId", e.full_name as owner, l.product_interest as "productInterest",
    l.expected_qty as "expectedQty", l.expected_uom as "expectedUom", l.status, l.bant_budget as "bantBudget", l.bant_authority as "bantAuthority",
    l.decision_maker as "decisionMaker", l.bant_need_score as "bantNeedScore", l.bant_timeline as "bantTimeline", l.bant_score as "bantScore",
    l.disqualify_reason as "disqualifyReason", l.follow_up_at as "followUpAt", l.party_id as "partyId", p.legal_name as "partyName",
    l.opportunity_id as "opportunityId", l.notes, l.created_at as "createdAt", l.version
  from sales.leads l join org.territories t on t.id = l.territory_id join org.employees e on e.id = l.owner_id left join mdm.parties p on p.id = l.party_id`;

const oppSelect = `select o.id, o.code, o.lead_id as "leadId", o.party_id as "partyId", p.legal_name as "partyName", o.company, o.title,
    o.territory_id as "territoryId", t.name as territory, o.owner_id as "ownerId", e.full_name as owner, o.stage, o.value, o.probability,
    o.expected_close as "expectedClose", o.product_interest as "productInterest", o.loss_reason as "lossReason", o.loss_notes as "lossNotes",
    o.closed_at as "closedAt", o.created_at as "createdAt", o.updated_at as "updatedAt", o.version
  from sales.opportunities o join org.territories t on t.id = o.territory_id join org.employees e on e.id = o.owner_id left join mdm.parties p on p.id = o.party_id`;

export function crmRoutes(db: Db) {
  const r = Router();

  async function loadLead(dbx: Db | Tx, req: Request, id: string, perm = 'crm.lead:view', lock = false) {
    const args: unknown[] = [id];
    const s = await scoped(dbx, req, perm, 'l.territory_id', args);
    const row = (await dbx.query(`${leadSelect} where l.id = $1 and ${s} ${lock ? 'for update of l' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Lead');
    return row;
  }
  async function loadOpp(dbx: Db | Tx, req: Request, id: string, perm = 'crm.opportunity:view', lock = false) {
    const args: unknown[] = [id];
    const s = await scoped(dbx, req, perm, 'o.territory_id', args);
    const row = (await dbx.query(`${oppSelect} where o.id = $1 and ${s} ${lock ? 'for update of o' : ''}`, args)).rows[0];
    if (!row) throw Errors.notFound('Opportunity');
    return row;
  }
  const activitiesOf = (type: string, id: string) => db.query(
    `select a.id, a.kind, a.title, a.notes, a.planned_at as "plannedAt", a.done_at as "doneAt", a.outcome, a.status, e.full_name as owner,
            a.latitude, a.longitude
       from sales.activities a join org.employees e on e.id = a.owner_id where a.subject_type = $1 and a.subject_id = $2
      order by coalesce(a.done_at, a.planned_at) desc`, [type, id]).then((x) => x.rows);

  // ================================================================== summary (BRD §4 #1 CRM dashboard)
  r.get('/summary', requirePermission('crm.lead:view'), asyncHandler(async (req, res) => {
    const la: unknown[] = []; const ls = await scoped(db, req, 'crm.lead:view', 'l.territory_id', la);
    const oa: unknown[] = []; const os = await scoped(db, req, 'crm.opportunity:view', 'o.territory_id', oa);
    const leads = (await db.query(
      `select count(*) filter (where status in ('New','Contacted')) as open, count(*) filter (where status = 'Qualified') as qualified,
              count(*) filter (where status = 'Converted' and created_at > now() - interval '90 days') as converted90,
              count(*) filter (where created_at > now() - interval '90 days') as total90,
              count(*) filter (where status in ('New','Contacted','Qualified') and follow_up_at < now()) as overdue_follow_up
         from sales.leads l where ${ls}`, la)).rows[0];
    const opps = (await db.query(
      `select stage, count(*)::int as n, coalesce(sum(value),0) as value, coalesce(sum(value * probability / 100.0),0) as weighted
         from sales.opportunities o where ${os} and (stage in ('REQUIREMENT','SAMPLE_TRIAL','QUOTE_SENT','PO_EXPECTED')
           or closed_at >= date_trunc('month', now())) group by stage`, oa)).rows;
    const emp = req.auth!.user.employeeId;
    const acts = emp ? (await db.query(
      `select count(*) filter (where planned_at::date = current_date) as today, count(*) filter (where planned_at < now()) as overdue
         from sales.activities where owner_id = $1 and status = 'Planned'`, [emp])).rows[0] : { today: 0, overdue: 0 };
    const open = opps.filter((o) => OPEN.includes(o.stage));
    res.json({
      leads: { open: Number(leads.open), qualified: Number(leads.qualified), overdueFollowUp: Number(leads.overdue_follow_up),
        conversionRate90: Number(leads.total90) ? Math.round((Number(leads.converted90) / Number(leads.total90)) * 100) : 0 },
      pipeline: { count: open.reduce((a, o) => a + o.n, 0), value: open.reduce((a, o) => a + Number(o.value), 0), weighted: Math.round(open.reduce((a, o) => a + Number(o.weighted), 0)),
        byStage: OPEN.map((s) => ({ stage: s, count: opps.find((o) => o.stage === s)?.n ?? 0, value: Number(opps.find((o) => o.stage === s)?.value ?? 0) })) },
      thisMonth: { won: Number(opps.find((o) => o.stage === 'WON')?.value ?? 0), wonCount: opps.find((o) => o.stage === 'WON')?.n ?? 0, lostCount: opps.find((o) => o.stage === 'LOST')?.n ?? 0 },
      myActivities: { today: Number(acts.today), overdue: Number(acts.overdue) },
    });
  }));

  // ================================================================== leads
  r.get('/leads', requirePermission('crm.lead:view'), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = [await scoped(db, req, 'crm.lead:view', 'l.territory_id', args)];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(l.code ilike $${args.length} or l.company ilike $${args.length} or l.contact_person ilike $${args.length} or l.mobile like $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`l.status = $${args.length}`); }
    if (req.query.mine === 'true' && req.auth!.user.employeeId) { args.push(req.auth!.user.employeeId); where.push(`l.owner_id = $${args.length}`); }
    const rows = await db.query(`${leadSelect.replace('select l.id,', 'select count(*) over() as total, l.id,')} where ${where.join(' and ')}
      order by case when l.status in ('New','Contacted','Qualified') then 0 else 1 end, l.follow_up_at nulls last, l.created_at desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/leads/:id', requirePermission('crm.lead:view'), asyncHandler(async (req, res) => {
    const l = await loadLead(db, req, req.params.id!);
    const open = LEAD_OPEN.includes(l.status);
    const threshold = await getSetting<number>(db, 'crm.bant.qualifyScore', 60);
    const actions: string[] = [];
    if (open && can(req, 'crm.lead:edit')) actions.push('edit', 'bant', 'disqualify');
    if (l.status === 'New' && can(req, 'crm.lead:edit')) actions.push('contacted');
    if (['New', 'Contacted'].includes(l.status) && can(req, 'crm.lead:edit') && (l.bantScore ?? 0) >= threshold) actions.push('qualify');
    if (l.status === 'Qualified' && can(req, 'crm.opportunity:create')) actions.push('convert');
    if (open && can(req, 'crm.lead:assign')) actions.push('transfer');
    res.json({ ...l, qualifyThreshold: threshold, activities: await activitiesOf('lead', l.id), allowedActions: actions,
      canLogActivity: open && can(req, 'crm.activity:create') });
  }));

  r.post('/leads', requirePermission('crm.lead:create'), asyncHandler(async (req, res) => {
    const d = parse(leadSchema, req.body);
    const out = await withTx(db, async (tx) => {
      await assertOwner(tx, req, 'crm.lead:create', d.ownerId, d.territoryId);
      const dup = (await tx.query(`select code, company, status from sales.leads where mobile = $1 and status in ('New','Contacted','Qualified') limit 1`, [d.mobile])).rows[0];
      if (dup) throw Errors.conflict('DUPLICATE_LEAD', `An open lead ${dup.code} (${dup.company}) already has this mobile number.`, dup);
      const dealer = (await tx.query(`select id, code, legal_name from mdm.parties where mobile = $1 limit 1`, [d.mobile])).rows[0];
      const code = await nextMasterCode(tx, 'LEAD_CODE');
      const ins = (await tx.query(
        `insert into sales.leads (code, company, contact_person, mobile, email, source, source_detail, territory_id, owner_id, product_interest, expected_qty, expected_uom,
           follow_up_at, party_id, notes, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) returning id`,
        [code, d.company, d.contactPerson, d.mobile, d.email ?? null, d.source, d.sourceDetail, d.territoryId, d.ownerId, d.productInterest, d.expectedQty ?? null,
          d.expectedUom ?? null, d.followUpAt ?? null, d.partyId ?? dealer?.id ?? null, d.notes, req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'crm.lead.created', entityType: 'crm.lead', entityId: ins.id, after: { code, ...d } });
      if (d.ownerId !== req.auth!.user.employeeId) await emit(tx, 'crm.lead', ins.id, 'crm.lead_assigned', { ownerId: d.ownerId });
      return { id: ins.id, code, linkedDealer: dealer ? { id: dealer.id, code: dealer.code, name: dealer.legal_name } : null };
    });
    res.status(201).json(out);
  }));

  r.put('/leads/:id', requirePermission('crm.lead:edit'), asyncHandler(async (req, res) => {
    const d = parse(leadSchema.omit({ ownerId: true, territoryId: true }), req.body);
    await withTx(db, async (tx) => {
      const before = await loadLead(tx, req, req.params.id!, 'crm.lead:edit', true);
      if (!LEAD_OPEN.includes(before.status)) throw Errors.state(`A ${before.status} lead cannot be edited.`);
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      const after = (await tx.query(
        `update sales.leads set company=$2, contact_person=$3, mobile=$4, email=$5, source=$6, source_detail=$7, product_interest=$8, expected_qty=$9, expected_uom=$10,
           follow_up_at=$11, party_id=$12, notes=$13, updated_by=$14 where id = $1 returning *`,
        [before.id, d.company, d.contactPerson, d.mobile, d.email ?? null, d.source, d.sourceDetail, d.productInterest, d.expectedQty ?? null, d.expectedUom ?? null,
          d.followUpAt ?? null, d.partyId ?? null, d.notes, req.auth!.user.id])).rows[0];
      const df = diff(before, after);
      await audit(tx, actorOf(req), { action: 'crm.lead.updated', entityType: 'crm.lead', entityId: before.id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));

  const leadStatus = async (tx: Tx, req: Request, id: string, from: string[], to: string, extra: Record<string, unknown> = {}, reason: string | null = null) => {
    const l = await loadLead(tx, req, id, 'crm.lead:edit', true);
    if (!from.includes(l.status)) throw Errors.state(`A ${l.status} lead cannot become ${to}.`);
    const sets = Object.keys(extra).map((k, i) => `${k} = $${i + 3}`);
    await tx.query(`update sales.leads set status = $2${sets.length ? ', ' + sets.join(', ') : ''}, updated_by = $${sets.length + 3} where id = $1`,
      [l.id, to, ...Object.values(extra), req.auth!.user.id]);
    await audit(tx, actorOf(req), { action: `crm.lead.${to.toLowerCase()}`, entityType: 'crm.lead', entityId: l.id, before: { status: l.status }, after: { status: to, ...extra }, reason });
    return l;
  };

  r.post('/leads/:id/contacted', requirePermission('crm.lead:edit'), asyncHandler(async (req, res) => {
    await withTx(db, (tx) => leadStatus(tx, req, req.params.id!, ['New'], 'Contacted'));
    res.json({ ok: true });
  }));

  r.post('/leads/:id/bant', requirePermission('crm.lead:edit'), asyncHandler(async (req, res) => {
    const b = parse(bantSchema, req.body);
    const score = bantScore(b);
    await withTx(db, async (tx) => {
      const l = await loadLead(tx, req, req.params.id!, 'crm.lead:edit', true);
      if (!LEAD_OPEN.includes(l.status)) throw Errors.state(`A ${l.status} lead cannot be re-scored.`);
      await tx.query(`update sales.leads set bant_budget=$2, bant_authority=$3, decision_maker=$4, bant_need_score=$5, bant_timeline=$6, bant_score=$7, updated_by=$8 where id = $1`,
        [l.id, b.budget, b.authority, b.decisionMaker, b.needScore, b.timeline, score, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'crm.lead.bant_scored', entityType: 'crm.lead', entityId: l.id, after: { ...b, score } });
    });
    res.json({ score });
  }));

  r.post('/leads/:id/qualify', requirePermission('crm.lead:edit'), asyncHandler(async (req, res) => {
    const threshold = await getSetting<number>(db, 'crm.bant.qualifyScore', 60);
    await withTx(db, async (tx) => {
      const l = await loadLead(tx, req, req.params.id!, 'crm.lead:edit', true);
      if ((l.bantScore ?? 0) < threshold) throw Errors.rule('BANT_TOO_LOW', `BANT score ${l.bantScore ?? 0} is below the qualifying score of ${threshold}. Update the BANT assessment first.`);
      await leadStatus(tx, req, l.id, ['New', 'Contacted'], 'Qualified');
    });
    res.json({ ok: true });
  }));

  r.post('/leads/:id/disqualify', requirePermission('crm.lead:edit'), asyncHandler(async (req, res) => {
    const { reason } = parse(leadDisqualifySchema, req.body);
    await withTx(db, (tx) => leadStatus(tx, req, req.params.id!, LEAD_OPEN, 'Disqualified', { disqualify_reason: reason }, reason));
    res.json({ ok: true });
  }));

  // Lead allocation (BRD p.3: ASM "lead allocation"). The history stays in the audit log.
  r.post('/leads/:id/transfer', requirePermission('crm.lead:assign'), asyncHandler(async (req, res) => {
    const d = parse(leadTransferSchema, req.body);
    await withTx(db, async (tx) => {
      const l = await loadLead(tx, req, req.params.id!, 'crm.lead:assign', true);
      if (!LEAD_OPEN.includes(l.status)) throw Errors.state(`A ${l.status} lead cannot be reassigned.`);
      const territoryId = d.territoryId ?? l.territoryId;
      await assertOwner(tx, req, 'crm.lead:assign', d.ownerId, territoryId);
      await tx.query(`update sales.leads set owner_id = $2, territory_id = $3, updated_by = $4 where id = $1`, [l.id, d.ownerId, territoryId, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'crm.lead.transferred', entityType: 'crm.lead', entityId: l.id,
        before: { ownerId: l.ownerId, territoryId: l.territoryId }, after: { ownerId: d.ownerId, territoryId }, reason: d.reason });
      await emit(tx, 'crm.lead', l.id, 'crm.lead_assigned', { ownerId: d.ownerId });
    });
    res.json({ ok: true });
  }));

  r.post('/leads/:id/convert', requirePermission('crm.opportunity:create'), asyncHandler(async (req, res) => {
    const d = parse(opportunitySchema.partial({ probability: true }), req.body);
    const out = await withTx(db, async (tx) => {
      const l = await loadLead(tx, req, req.params.id!, 'crm.lead:edit', true);
      if (l.status !== 'Qualified') throw Errors.state('Only a qualified lead can be converted.');
      const probs = await getSetting<Record<string, number>>(tx, 'crm.stageProbability', {});
      const code = await nextMasterCode(tx, 'OPP_CODE');
      const o = (await tx.query(
        `insert into sales.opportunities (code, lead_id, party_id, company, title, territory_id, owner_id, value, probability, expected_close, product_interest, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning id`,
        [code, l.id, d.partyId ?? l.partyId, l.company, d.title, l.territoryId, l.ownerId, d.value, d.probability ?? probs.REQUIREMENT ?? 10, d.expectedClose ?? null,
          d.productInterest ?? l.productInterest, req.auth!.user.id])).rows[0];
      await tx.query(`insert into sales.opportunity_stage_history (opportunity_id, from_stage, to_stage, value, changed_by, note) values ($1, null, 'REQUIREMENT', $2, $3, $4)`,
        [o.id, d.value, req.auth!.user.id, `Converted from lead ${l.code}`]);
      await leadStatus(tx, req, l.id, ['Qualified'], 'Converted', { opportunity_id: o.id });
      await audit(tx, actorOf(req), { action: 'crm.opportunity.created', entityType: 'crm.opportunity', entityId: o.id, after: { code, fromLead: l.code, ...d } });
      return { id: o.id, code };
    });
    res.status(201).json(out);
  }));

  // ================================================================== opportunities
  r.get('/opportunities', requirePermission('crm.opportunity:view'), asyncHandler(async (req, res) => {
    const args: unknown[] = [];
    const where = [await scoped(db, req, 'crm.opportunity:view', 'o.territory_id', args),
      `(o.stage in ('REQUIREMENT','SAMPLE_TRIAL','QUOTE_SENT','PO_EXPECTED') or o.closed_at > now() - interval '30 days')`];
    if (req.query.mine === 'true' && req.auth!.user.employeeId) { args.push(req.auth!.user.employeeId); where.push(`o.owner_id = $${args.length}`); }
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(o.code ilike $${args.length} or o.company ilike $${args.length} or o.title ilike $${args.length})`); }
    const rows = await db.query(`${oppSelect} where ${where.join(' and ')} order by o.expected_close nulls last, o.value desc limit 500`, args);
    res.json({ data: rows.rows });
  }));

  r.post('/opportunities', requirePermission('crm.opportunity:create'), asyncHandler(async (req, res) => {
    const d = parse(opportunitySchema.extend({ partyId: z.string().uuid() }), req.body);
    const out = await withTx(db, async (tx) => {
      const me = await myEmployee(tx, req);
      const p = (await tx.query(`select p.id, p.legal_name, dp.territory_id, dp.status from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id where p.id = $1`, [d.partyId])).rows[0];
      if (!p) throw Errors.rule('REFERENCE_INVALID', 'Choose a registered dealer.');
      if (!p.territory_id) throw Errors.rule('DEALER_NO_TERRITORY', `${p.legal_name} has no territory yet; set it on the dealer first.`);
      if (!(await inTerritoryScope(tx, req, 'crm.opportunity:create', p.territory_id))) throw Errors.forbidden('crm.opportunity:create in this territory');
      const code = await nextMasterCode(tx, 'OPP_CODE');
      const o = (await tx.query(
        `insert into sales.opportunities (code, party_id, company, title, territory_id, owner_id, value, probability, expected_close, product_interest, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
        [code, p.id, p.legal_name, d.title, p.territory_id, me.id, d.value, d.probability, d.expectedClose ?? null, d.productInterest, req.auth!.user.id])).rows[0];
      await tx.query(`insert into sales.opportunity_stage_history (opportunity_id, from_stage, to_stage, value, changed_by) values ($1, null, 'REQUIREMENT', $2, $3)`, [o.id, d.value, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'crm.opportunity.created', entityType: 'crm.opportunity', entityId: o.id, after: { code, ...d } });
      return { id: o.id, code };
    });
    res.status(201).json(out);
  }));

  r.get('/opportunities/:id', requirePermission('crm.opportunity:view'), asyncHandler(async (req, res) => {
    const o = await loadOpp(db, req, req.params.id!);
    const history = (await db.query(
      `select h.from_stage as "fromStage", h.to_stage as "toStage", h.value, h.changed_at as "changedAt", u.full_name as "changedBy", h.note
         from sales.opportunity_stage_history h left join iam.users u on u.id = h.changed_by where h.opportunity_id = $1 order by h.id desc`, [o.id])).rows;
    const open = OPEN.includes(o.stage);
    res.json({ ...o, history, activities: await activitiesOf('opportunity', o.id),
      allowedActions: [...(open && can(req, 'crm.opportunity:edit') ? ['edit', 'stage'] : []), ...(!open && can(req, 'crm.opportunity:reopen') ? ['reopen'] : [])],
      canLogActivity: open && can(req, 'crm.activity:create') });
  }));

  r.put('/opportunities/:id', requirePermission('crm.opportunity:edit'), asyncHandler(async (req, res) => {
    const d = parse(opportunitySchema, req.body);
    await withTx(db, async (tx) => {
      const before = await loadOpp(tx, req, req.params.id!, 'crm.opportunity:edit', true);
      if (!OPEN.includes(before.stage)) throw Errors.state('A closed opportunity cannot be edited.');
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      if (d.partyId) {
        const p = (await tx.query(`select 1 from mdm.dealer_profiles where party_id = $1`, [d.partyId])).rowCount;
        if (!p) throw Errors.rule('REFERENCE_INVALID', 'Link a registered dealer.');
      }
      const after = (await tx.query(
        `update sales.opportunities set title=$2, value=$3, probability=$4, expected_close=$5, product_interest=$6, party_id=$7, updated_by=$8 where id = $1 returning *`,
        [before.id, d.title, d.value, d.probability, d.expectedClose ?? null, d.productInterest, d.partyId ?? before.partyId, req.auth!.user.id])).rows[0];
      const df = diff(before, after);
      await audit(tx, actorOf(req), { action: 'crm.opportunity.updated', entityType: 'crm.opportunity', entityId: before.id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));

  r.post('/opportunities/:id/stage', requirePermission('crm.opportunity:edit'), asyncHandler(async (req, res) => {
    const s = parse(stageChangeSchema, req.body);
    await withTx(db, async (tx) => {
      const o = await loadOpp(tx, req, req.params.id!, 'crm.opportunity:edit', true);
      if (!OPEN.includes(o.stage)) throw Errors.state('Reopen a closed opportunity before moving it.');
      if (o.stage === s.stage) return;
      if (s.stage === 'WON') {
        if (!o.partyId) throw Errors.rule('DEALER_REQUIRED', 'Link the registered dealer before marking the opportunity won. Register them first if they are new.');
        const st = (await tx.query(`select status from mdm.dealer_profiles where party_id = $1`, [o.partyId])).rows[0];
        if (!st || !(await usableStatuses(tx)).includes(st.status)) throw Errors.rule('DEALER_NOT_ACTIVE', `The linked dealer is ${st?.status ?? 'not registered'}; an opportunity is won only with an active dealer.`);
      }
      const probs = await getSetting<Record<string, number>>(tx, 'crm.stageProbability', {});
      const closed = s.stage === 'WON' || s.stage === 'LOST';
      await tx.query(
        `update sales.opportunities set stage = $2, probability = $3, loss_reason = $4, loss_notes = $5, closed_at = case when $6 then now() end, updated_by = $7 where id = $1`,
        [o.id, s.stage, probs[s.stage] ?? o.probability, s.stage === 'LOST' ? s.lossReason : null, s.stage === 'LOST' ? s.note || null : null, closed, req.auth!.user.id]);
      await tx.query(`insert into sales.opportunity_stage_history (opportunity_id, from_stage, to_stage, value, changed_by, note) values ($1,$2,$3,$4,$5,$6)`,
        [o.id, o.stage, s.stage, o.value, req.auth!.user.id, s.note || null]);
      await audit(tx, actorOf(req), { action: 'crm.opportunity.stage', entityType: 'crm.opportunity', entityId: o.id, before: { stage: o.stage }, after: { stage: s.stage, lossReason: s.lossReason ?? null }, reason: s.note || null });
    });
    res.json({ ok: true });
  }));

  r.post('/opportunities/:id/reopen', requirePermission('crm.opportunity:reopen'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const o = await loadOpp(tx, req, req.params.id!, 'crm.opportunity:reopen', true);
      if (OPEN.includes(o.stage)) throw Errors.state('The opportunity is already open.');
      const probs = await getSetting<Record<string, number>>(tx, 'crm.stageProbability', {});
      await tx.query(`update sales.opportunities set stage = 'REQUIREMENT', probability = $2, loss_reason = null, loss_notes = null, closed_at = null, updated_by = $3 where id = $1`,
        [o.id, probs.REQUIREMENT ?? 10, req.auth!.user.id]);
      await tx.query(`insert into sales.opportunity_stage_history (opportunity_id, from_stage, to_stage, value, changed_by, note) values ($1,$2,'REQUIREMENT',$3,$4,$5)`,
        [o.id, o.stage, o.value, req.auth!.user.id, `Reopened: ${reason}`]);
      await audit(tx, actorOf(req), { action: 'crm.opportunity.reopened', entityType: 'crm.opportunity', entityId: o.id, before: { stage: o.stage }, reason });
    });
    res.json({ ok: true });
  }));

  // ================================================================== activities (BRD §4 #5)
  async function subjectTerritory(tx: Tx, req: Request, type: string, id: string) {
    const sql = type === 'lead' ? `select territory_id, status from sales.leads where id = $1`
      : type === 'opportunity' ? `select territory_id, stage as status from sales.opportunities where id = $1`
      : `select territory_id, status from mdm.dealer_profiles where party_id = $1`;
    const s = (await tx.query(sql, [id])).rows[0];
    if (!s) throw Errors.notFound('Record');
    const perm = type === 'dealer' ? 'mdm.dealer:view' : `crm.${type}:view`;
    if (!(await inTerritoryScope(tx, req, perm, s.territory_id))) throw Errors.notFound('Record');
    return s as { territory_id: string; status: string };
  }

  r.get('/activities', requirePermission('crm.activity:view'), asyncHandler(async (req, res) => {
    const view = str(req.query.view) ?? 'mine';
    const args: unknown[] = [];
    const where: string[] = [];
    if (view === 'subject') {
      const t = str(req.query.subjectType); const id = str(req.query.subjectId);
      if (!t || !id) throw Errors.validation([{ field: 'subjectId', message: 'Required' }]);
      await withTx(db, (tx) => subjectTerritory(tx, req, t, id));
      args.push(t, id); where.push(`a.subject_type = $1 and a.subject_id = $2`);
    } else {
      const emp = req.auth!.user.employeeId;
      if (view === 'team') where.push(await scoped(db, req, 'crm.activity:view', 'a.territory_id', args));
      else { if (!emp) return res.json({ data: [] }); args.push(emp); where.push(`a.owner_id = $${args.length}`); }
      if (view !== 'subject') where.push(`a.status = 'Planned'`);
    }
    const rows = await db.query(
      `select a.id, a.subject_type as "subjectType", a.subject_id as "subjectId", a.kind, a.title, a.notes, a.planned_at as "plannedAt", a.done_at as "doneAt",
              a.outcome, a.status, e.full_name as owner,
              coalesce(l.company, o.company, p.legal_name) as "subjectName", coalesce(l.code, o.code, p.code) as "subjectCode"
         from sales.activities a join org.employees e on e.id = a.owner_id
         left join sales.leads l on a.subject_type = 'lead' and l.id = a.subject_id
         left join sales.opportunities o on a.subject_type = 'opportunity' and o.id = a.subject_id
         left join mdm.parties p on a.subject_type = 'dealer' and p.id = a.subject_id
        where ${where.join(' and ')} order by a.planned_at limit 300`, args);
    res.json({ data: rows.rows });
  }));

  r.post('/activities', requirePermission('crm.activity:create'), asyncHandler(async (req, res) => {
    const a = parse(activitySchema, req.body);
    const out = await withTx(db, async (tx) => {
      const me = await myEmployee(tx, req);
      const s = await subjectTerritory(tx, req, a.subjectType, a.subjectId);
      if (['Disqualified', 'Converted', 'WON', 'LOST', 'Inactive'].includes(s.status)) throw Errors.state('Activities cannot be logged on a closed record.');
      const ins = (await tx.query(
        `insert into sales.activities (subject_type, subject_id, kind, title, notes, owner_id, territory_id, planned_at, done_at, outcome, status, latitude, longitude, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8, case when $9 then now() end, $10, case when $9 then 'Done' else 'Planned' end, $11, $12, $13) returning id`,
        [a.subjectType, a.subjectId, a.kind, a.title, a.notes, me.id, s.territory_id, a.plannedAt, a.done, a.done ? a.outcome : null, a.latitude ?? null, a.longitude ?? null, req.auth!.user.id])).rows[0];
      if (a.done && a.subjectType === 'lead') await tx.query(`update sales.leads set status = 'Contacted' where id = $1 and status = 'New'`, [a.subjectId]);
      await audit(tx, actorOf(req), { action: 'crm.activity.logged', entityType: `crm.${a.subjectType}`, entityId: a.subjectId, after: { kind: a.kind, title: a.title, done: a.done } });
      return { id: ins.id };
    });
    res.status(201).json(out);
  }));

  r.post('/activities/:id/complete', requirePermission('crm.activity:create'), asyncHandler(async (req, res) => {
    const d = parse(activityCompleteSchema, req.body);
    await withTx(db, async (tx) => {
      const a = (await tx.query(`select * from sales.activities where id = $1 for update`, [req.params.id])).rows[0];
      if (!a) throw Errors.notFound('Activity');
      if (a.owner_id !== req.auth!.user.employeeId) throw Errors.forbidden('only the owner can complete an activity');
      if (a.status !== 'Planned') throw Errors.state('This activity is already closed.');
      await tx.query(`update sales.activities set status = 'Done', done_at = now(), outcome = $2 where id = $1`, [a.id, d.outcome]);
      if (a.subject_type === 'lead') await tx.query(`update sales.leads set status = 'Contacted' where id = $1 and status = 'New'`, [a.subject_id]);
      if (d.nextAction) {
        await tx.query(
          `insert into sales.activities (subject_type, subject_id, kind, title, owner_id, territory_id, planned_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [a.subject_type, a.subject_id, d.nextAction.kind, d.nextAction.title, a.owner_id, a.territory_id, d.nextAction.plannedAt, req.auth!.user.id]);
        if (a.subject_type === 'lead') await tx.query(`update sales.leads set follow_up_at = $2 where id = $1`, [a.subject_id, d.nextAction.plannedAt]);
      }
      await audit(tx, actorOf(req), { action: 'crm.activity.completed', entityType: `crm.${a.subject_type}`, entityId: a.subject_id, after: { title: a.title, outcome: d.outcome, next: d.nextAction?.title ?? null } });
    });
    res.json({ ok: true });
  }));

  r.post('/activities/:id/cancel', requirePermission('crm.activity:create'), asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const a = (await tx.query(`select * from sales.activities where id = $1 for update`, [req.params.id])).rows[0];
      if (!a) throw Errors.notFound('Activity');
      if (a.owner_id !== req.auth!.user.employeeId) throw Errors.forbidden('only the owner can cancel an activity');
      if (a.status !== 'Planned') throw Errors.state('This activity is already closed.');
      await tx.query(`update sales.activities set status = 'Cancelled', outcome = $2 where id = $1`, [a.id, `Cancelled: ${reason}`]);
      await audit(tx, actorOf(req), { action: 'crm.activity.cancelled', entityType: `crm.${a.subject_type}`, entityId: a.subject_id, reason });
    });
    res.json({ ok: true });
  }));

  return r;
}
