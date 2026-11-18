import { Router } from 'express';
import { decisionSchema, policyDefinitionSchema, simulateSchema } from '@dhruv/contracts';
import { withTx, type Db } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { allowedDecisions, decide, resolveRoute } from './engine';

export function approvalRoutes(db: Db) {
  const r = Router();

  r.get('/', asyncHandler(async (req, res) => {
    const me = req.auth!.user.id;
    const view = str(req.query.view) ?? 'inbox';
    const status = str(req.query.status);
    const { limit, offset } = pageParams(req.query);
    if (view === 'all' && !can(req, 'wf.approval:view_all')) throw Errors.forbidden('wf.approval:view_all');
    const where: string[] = [];
    const args: unknown[] = [];
    if (view === 'inbox') {
      args.push(me);
      where.push(`exists (select 1 from wf.approval_steps s where s.request_id = a.id and s.step_kind = 'approve' and s.status in ('Pending','OnHold') and $${args.length} = any(s.approver_ids))`);
    }
    if (view === 'initiated') { args.push(me); where.push(`a.initiated_by = $${args.length}`); }
    if (view === 'notified') {
      args.push(me);
      where.push(`exists (select 1 from wf.approval_steps s where s.request_id = a.id and s.step_kind = 'notify' and $${args.length} = any(s.approver_ids))`);
    }
    if (status) { args.push(status); where.push(`a.status = $${args.length}`); }
    const w = where.length ? `where ${where.join(' and ')}` : '';
    const rows = await db.query(
      `select a.id, a.doc_no, a.subject_type, a.subject_id, a.subject_label, a.status, a.submitted_at, a.completed_at, a.facts,
              u.full_name as initiator, cs.label as current_step, cs.due_at, count(*) over() as total
         from wf.approval_requests a join iam.users u on u.id = a.initiated_by
         left join lateral (select label, due_at from wf.approval_steps s where s.request_id = a.id and s.step_kind = 'approve'
                              and s.status in ('Pending','OnHold') order by seq limit 1) cs on true
         ${w} order by a.submitted_at desc limit ${limit} offset ${offset}`, args);
    const data = rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; });
    res.json({ data, total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const me = req.auth!.user.id;
    const a = (await db.query(
      `select a.*, u.full_name as initiator, pv.version as policy_version, pv.definition as policy_definition
         from wf.approval_requests a join iam.users u on u.id = a.initiated_by join wf.policy_versions pv on pv.id = a.policy_version_id
        where a.id = $1`, [req.params.id])).rows[0];
    if (!a) throw Errors.notFound('Approval request');
    const steps = (await db.query(
      `select s.id, s.seq, s.label, s.step_kind, s.status, s.approver_ids, s.decided_by, s.activated_at, s.due_at, s.decided_at,
              d.full_name as decided_by_name,
              (select json_agg(json_build_object('id', u.id, 'name', u.full_name) order by u.full_name) from iam.users u where u.id = any(s.approver_ids)) as approvers
         from wf.approval_steps s left join iam.users d on d.id = s.decided_by where s.request_id = $1 order by s.seq`, [a.id])).rows;
    const involved = a.initiated_by === me || steps.some((s) => (s.approver_ids as string[]).includes(me));
    if (!involved && !can(req, 'wf.approval:view_all')) throw Errors.notFound('Approval request');
    const decisions = (await db.query(
      `select d.decision, d.remarks, d.created_at, u.full_name as actor from wf.approval_decisions d join iam.users u on u.id = d.actor_id
        where d.request_id = $1 order by d.created_at`, [a.id])).rows;
    const current = steps.find((s) => s.step_kind === 'approve' && ['Pending', 'OnHold'].includes(s.status)) ?? null;
    const priorIds = steps.filter((s) => s.status === 'Approved' && s.decided_by).map((s) => s.decided_by as string);
    const distinct = a.policy_definition?.distinctApprovers ?? true;
    const allowed = allowedDecisions(a, current, me, priorIds, distinct);
    const publicSteps = steps.map((s) => {
      const { approver_ids: _ids, decided_by: _by, ...rest } = s;
      return rest;
    });
    const { policy_definition: _def, ...request } = a;
    res.json({ ...request, steps: publicSteps, decisions, allowedDecisions: allowed });
  }));

  r.post('/:id/decisions', asyncHandler(async (req, res) => {
    const { decision, remarks } = parse(decisionSchema, req.body);
    const out = await withTx(db, (tx) => decide(tx, actorOf(req), req.params.id!, decision, remarks));
    res.json(out);
  }));

  return r;
}

export function policyRoutes(db: Db) {
  const r = Router();

  r.get('/', requirePermission('wf.policy:view'), asyncHandler(async (_req, res) => {
    const rows = await db.query(
      `select p.id, p.doc_type, p.name, p.description, v.version as published_version, v.published_at, v.definition,
              (select count(*) from wf.policy_versions x where x.policy_id = p.id and x.status = 'Draft') as drafts
         from wf.policies p left join wf.policy_versions v on v.policy_id = p.id and v.status = 'Published' order by p.doc_type`);
    res.json({ data: rows.rows });
  }));

  r.get('/:docType/versions', requirePermission('wf.policy:view'), asyncHandler(async (req, res) => {
    const rows = await db.query(
      `select v.id, v.version, v.status, v.definition, v.created_at, cu.full_name as created_by, v.published_at, pu.full_name as published_by
         from wf.policy_versions v join wf.policies p on p.id = v.policy_id
         left join iam.users cu on cu.id = v.created_by left join iam.users pu on pu.id = v.published_by
        where p.doc_type = $1 order by v.version desc`, [req.params.docType]);
    res.json({ data: rows.rows });
  }));

  r.post('/:docType/versions', requirePermission('wf.policy:configure'), asyncHandler(async (req, res) => {
    const definition = parse(policyDefinitionSchema, req.body?.definition);
    const out = await withTx(db, async (tx) => {
      const p = (await tx.query(`select id from wf.policies where doc_type = $1`, [req.params.docType])).rows[0];
      if (!p) throw Errors.notFound('Policy');
      const v = (await tx.query(
        `insert into wf.policy_versions (policy_id, version, definition, status, created_by)
         values ($1, (select coalesce(max(version),0)+1 from wf.policy_versions where policy_id = $1), $2, 'Draft', $3) returning id, version`,
        [p.id, JSON.stringify(definition), req.auth!.user.id])).rows[0];
      await audit(tx, actorOf(req), { action: 'policy.version_drafted', entityType: 'wf.policy', entityId: req.params.docType, after: { version: v.version, definition } });
      return v;
    });
    res.status(201).json(out);
  }));

  // Publishing is maker-checker: the author of a version cannot publish it (doc 07 §6).
  r.post('/:docType/versions/:version/publish', requirePermission('wf.policy:configure'), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const v = (await tx.query(
        `select v.id, v.status, v.created_by, v.policy_id from wf.policy_versions v join wf.policies p on p.id = v.policy_id
          where p.doc_type = $1 and v.version = $2 for update`, [req.params.docType, Number(req.params.version)])).rows[0];
      if (!v) throw Errors.notFound('Policy version');
      if (v.status !== 'Draft') throw Errors.state('Only a draft version can be published.');
      if (v.created_by === req.auth!.user.id) throw Errors.sod('A different administrator must publish the version you drafted.');
      await tx.query(`update wf.policy_versions set status = 'Retired' where policy_id = $1 and status = 'Published'`, [v.policy_id]);
      await tx.query(`update wf.policy_versions set status = 'Published', published_at = now(), published_by = $2 where id = $1`, [v.id, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'policy.published', entityType: 'wf.policy', entityId: req.params.docType, after: { version: Number(req.params.version) } });
    });
    res.json({ ok: true });
  }));

  r.post('/simulate', requirePermission('wf.policy:simulate'), asyncHandler(async (req, res) => {
    const { docType, initiatorUserId, facts } = parse(simulateSchema, req.body);
    const legalEntityId = typeof facts.legalEntityId === 'string' ? facts.legalEntityId : null;
    res.json(await resolveRoute(db, docType, initiatorUserId, facts, legalEntityId, 'simulate'));
  }));

  return r;
}
