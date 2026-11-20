import { policyDefinitionSchema, type ApprovalDecision, type PolicyDefinition, type StepDef } from '@dhruv/contracts';
import { allowTransition, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, emit } from '../../lib/audit';
import { AppError, Errors } from '../../lib/errors';
import { nextDocNo } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { selectRule } from './conditions';
import { resolveLadder, type ChainMember, type TierLimit } from './ladder';

export interface ApprovalRequestRow {
  id: string; doc_no: string; subject_type: string; subject_id: string; subject_label: string; subject_revision: number;
  status: string; initiated_by: string; facts: Record<string, unknown>; legal_entity_id: string | null; policy_version_id: string;
}

export interface SubjectHandler {
  onApproved(tx: Tx, req: ApprovalRequestRow, actor: Actor): Promise<void>;
  onRejected(tx: Tx, req: ApprovalRequestRow, actor: Actor): Promise<void>;
  onReturned(tx: Tx, req: ApprovalRequestRow, actor: Actor): Promise<void>;
  onCancelled(tx: Tx, req: ApprovalRequestRow, actor: Actor): Promise<void>;
  /** Optional gate run before a step is approved, e.g. all licences verified before document verification passes. */
  beforeApprove?(tx: Tx, req: ApprovalRequestRow, stepKey: string | null, actor: Actor): Promise<void>;
}

const handlers = new Map<string, SubjectHandler>();
export function registerSubjectHandler(subjectType: string, h: SubjectHandler) { handlers.set(subjectType, h); }
function handlerFor(subjectType: string): SubjectHandler {
  const h = handlers.get(subjectType);
  if (!h) throw new AppError(500, 'NO_HANDLER', `No approval handler for ${subjectType}`);
  return h;
}

export interface ResolvedStep {
  label: string; kind: 'approve' | 'notify'; rule: StepDef;
  approvers: { userId: string; name: string; tier?: string | null }[]; slaHours: number;
}
export interface Resolution { policyVersionId: string; version: number; ruleName: string; distinct: boolean; steps: ResolvedStep[]; warnings: string[] }

export async function loadPublishedPolicy(db: Db | Tx, docType: string) {
  const r = await db.query<{ id: string; version: number; definition: unknown }>(
    `select v.id, v.version, v.definition from wf.policy_versions v join wf.policies p on p.id = v.policy_id
      where p.doc_type = $1 and v.status = 'Published'`, [docType]);
  const row = r.rows[0];
  if (!row) throw new AppError(422, 'NO_POLICY', `No published approval policy for ${docType}`);
  return { id: row.id, version: row.version, definition: policyDefinitionSchema.parse(row.definition) as PolicyDefinition };
}

async function usersWithRoles(db: Db | Tx, roles: string[], excludeUserId: string, legalEntityId: string | null) {
  const r = await db.query<{ id: string; full_name: string }>(
    `select distinct u.id, u.full_name from iam.user_roles ur
       join iam.roles r on r.id = ur.role_id join iam.users u on u.id = ur.user_id
      where r.code = any($1) and ur.status = 'Active' and u.status = 'Active' and u.id <> $2
        and (ur.scope ? 'all' or $3::text is null or (ur.scope -> 'legalEntityIds') ? $3::text)
      order by u.full_name`, [roles, excludeUserId, legalEntityId]);
  return r.rows.map((x) => ({ userId: x.id, name: x.full_name }));
}

async function reportingChain(db: Db | Tx, initiatorUserId: string): Promise<{ chain: ChainMember[]; hasEmployee: boolean; managerUserId: ChainMember | null }> {
  const r = await db.query<{ employee_id: string; full_name: string; sales_tier: string | null; status: string; user_id: string | null; user_status: string | null; depth: number }>(
    `with recursive me as (select e.manager_id from iam.users u join org.employees e on e.id = u.employee_id where u.id = $1),
     chain as (
       select e.*, 1 as depth from org.employees e where e.id = (select manager_id from me)
       union all
       select e.*, c.depth + 1 from org.employees e join chain c on e.id = c.manager_id where c.depth < 25
     )
     select c.id as employee_id, c.full_name, c.sales_tier, c.status, u.id as user_id, u.status as user_status, c.depth
       from chain c left join iam.users u on u.employee_id = c.id order by c.depth`, [initiatorUserId]);
  const has = await db.query(`select 1 from iam.users where id = $1 and employee_id is not null`, [initiatorUserId]);
  const chain = r.rows.map((x) => ({ employeeId: x.employee_id, name: x.full_name, tier: x.sales_tier, userId: x.user_status === 'Active' ? x.user_id : null, active: x.status === 'Active' }));
  return { chain, hasEmployee: (has.rowCount ?? 0) > 0, managerUserId: chain[0] ?? null };
}

async function tierLimits(db: Db | Tx) {
  const r = await db.query<{ tier: string; max_discount_pct: string | null; max_order_value: string | null; can_approve: boolean; active: boolean }>(
    `select tier, max_discount_pct, max_order_value, can_approve, active from iam.authority_limits`);
  const limits = new Map<string, TierLimit>();
  for (const x of r.rows) limits.set(x.tier, {
    tier: x.tier, canApprove: x.can_approve,
    maxDiscountPct: x.max_discount_pct === null ? null : Number(x.max_discount_pct),
    maxOrderValue: x.max_order_value === null ? null : Number(x.max_order_value),
  });
  return { limits, allActive: r.rows.length > 0 && r.rows.every((x) => x.active) };
}

/** Works out the approval route without writing anything. Used by submit() and by the policy simulator. */
export async function resolveRoute(db: Db | Tx, docType: string, initiatorUserId: string, facts: Record<string, unknown>, legalEntityId: string | null, mode: 'live' | 'simulate'): Promise<Resolution> {
  const policy = await loadPublishedPolicy(db, docType);
  const rule = selectRule(policy.definition, facts);
  if (!rule) throw new AppError(422, 'NO_MATCHING_RULE', 'No approval rule matches this document.');
  const defaultSla = await getSetting<number>(db, 'approvals.defaultSlaHours', 24);
  const warnings: string[] = [];
  const steps: ResolvedStep[] = [];
  for (const s of rule.steps) {
    const sla = s.slaHours ?? defaultSla;
    if (s.kind === 'role') {
      const approvers = await usersWithRoles(db, s.roles, initiatorUserId, legalEntityId);
      if (approvers.length === 0) {
        if (mode === 'live') throw new AppError(422, 'NO_ELIGIBLE_APPROVER', `No active user other than you holds ${s.roles.join(' / ')} for step "${s.label}".`);
        warnings.push(`No eligible approver for "${s.label}" (${s.roles.join(' / ')}).`);
      }
      steps.push({ label: s.label, kind: 'approve', rule: s, approvers, slaHours: sla });
    } else if (s.kind === 'reporting_manager') {
      const { managerUserId } = await reportingChain(db, initiatorUserId);
      if (!managerUserId?.userId) {
        if (mode === 'live') throw new AppError(422, 'NO_ELIGIBLE_APPROVER', 'You have no active reporting manager with a system account.');
        warnings.push('No active reporting manager with a system account.');
      }
      steps.push({ label: s.label, kind: 'approve', rule: s, approvers: managerUserId?.userId ? [{ userId: managerUserId.userId, name: managerUserId.name, tier: managerUserId.tier }] : [], slaHours: sla });
    } else {
      const amount = Number(facts[s.amountFact] ?? 0);
      const discount = Number(facts[s.discountFact] ?? 0);
      if (!Number.isFinite(amount) || !Number.isFinite(discount)) throw Errors.validation([{ field: 'facts', message: 'amount and discount must be numbers' }]);
      const { limits, allActive } = await tierLimits(db);
      if (!allActive) {
        if (mode === 'live') throw new AppError(422, 'AUTHORITY_LIMITS_INACTIVE', 'Sales authority limits have not been activated yet (D15).');
        warnings.push('Authority limits are seeded from the BRD but not yet activated (D15). Live submissions are blocked until activation.');
      }
      const { chain, hasEmployee } = await reportingChain(db, initiatorUserId);
      if (!hasEmployee) {
        if (mode === 'live') throw new AppError(422, 'NO_EMPLOYEE_LINK', 'Your user account is not linked to an employee in the hierarchy.');
        warnings.push('Initiator is not linked to an employee record.');
      }
      const res = resolveLadder(chain, limits, amount, discount);
      for (const v of res.vacant) warnings.push(`Passed over ${v.name} (${v.tier ?? 'no tier'}): no active system user or no approval authority.`);
      if (s.notifySkipped && res.skipped.length) {
        steps.push({ label: `For information: ${s.label}`, kind: 'notify', rule: s, slaHours: 0,
          approvers: res.skipped.filter((m) => m.userId).map((m) => ({ userId: m.userId!, name: m.name, tier: m.tier })) });
      }
      if (!res.ok) {
        if (mode === 'live') throw new AppError(422, 'NO_AUTHORITY', 'No one in your reporting chain has authority for this value and discount.');
        warnings.push('No one in the reporting chain covers this value and discount.');
        steps.push({ label: s.label, kind: 'approve', rule: s, approvers: [], slaHours: sla });
      } else {
        steps.push({ label: `${s.label} (${res.approver.tier})`, kind: 'approve', rule: s, slaHours: sla,
          approvers: [{ userId: res.approver.userId!, name: res.approver.name, tier: res.approver.tier }] });
      }
    }
  }
  return { policyVersionId: policy.id, version: policy.version, ruleName: rule.name, distinct: policy.definition.distinctApprovers, steps, warnings };
}

export interface SubmitInput {
  subjectType: string; subjectId: string; subjectLabel: string; revision?: number;
  facts?: Record<string, unknown>; legalEntityId?: string | null;
}

export async function submitForApproval(tx: Tx, actor: Actor, input: SubmitInput): Promise<ApprovalRequestRow> {
  if (!actor.userId) throw Errors.authRequired();
  handlerFor(input.subjectType);
  const facts = input.facts ?? {};
  const route = await resolveRoute(tx, input.subjectType, actor.userId, facts, input.legalEntityId ?? null, 'live');
  const docNo = await nextDocNo(tx, 'APPROVAL');
  await allowTransition(tx);
  const reqRow = (await tx.query<ApprovalRequestRow>(
    `insert into wf.approval_requests (doc_no, subject_type, subject_id, subject_label, subject_revision, policy_version_id, rule_name, facts, initiated_by, legal_entity_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [docNo, input.subjectType, input.subjectId, input.subjectLabel, input.revision ?? 1, route.policyVersionId, route.ruleName,
      JSON.stringify(facts), actor.userId, input.legalEntityId ?? null])).rows[0]!;

  let firstApprove = true;
  let seq = 0;
  for (const s of route.steps) {
    seq++;
    const status = s.kind === 'notify' ? 'Notified' : firstApprove ? 'Pending' : 'Waiting';
    const active = status === 'Pending';
    await tx.query(
      `insert into wf.approval_steps (request_id, seq, label, step_kind, approver_rule, approver_ids, status, activated_at, due_at)
       values ($1,$2,$3,$4,$5,$6,$7, case when $8 then now() end, case when $8 then now() + make_interval(hours => $9) end)`,
      [reqRow.id, seq, s.label, s.kind, JSON.stringify(s.rule), s.approvers.map((a) => a.userId), status, active, s.slaHours]);
    if (s.kind === 'notify') await emit(tx, 'wf.approval', reqRow.id, 'approval.notified', { userIds: s.approvers.map((a) => a.userId), label: s.label });
    if (active) { firstApprove = false; await emit(tx, 'wf.approval', reqRow.id, 'approval.step_assigned', { userIds: s.approvers.map((a) => a.userId) }); }
  }
  await audit(tx, actor, { action: 'approval.submitted', entityType: input.subjectType, entityId: input.subjectId,
    after: { approvalRequest: docNo, rule: route.ruleName, policyVersion: route.version, steps: route.steps.map((s) => ({ label: s.label, kind: s.kind, approvers: s.approvers.map((a) => a.name) })) } });

  if (firstApprove) {
    // no approval step matched -> approved immediately (still audited)
    await tx.query(`update wf.approval_requests set status = 'Approved', completed_at = now() where id = $1`, [reqRow.id]);
    await handlerFor(input.subjectType).onApproved(tx, reqRow, actor);
    reqRow.status = 'Approved';
  }
  return reqRow;
}

export function allowedDecisions(req: { status: string; initiated_by: string }, step: { status: string; approver_ids: string[] } | null, userId: string, priorDeciders: string[], distinct: boolean): ApprovalDecision[] {
  const out: ApprovalDecision[] = [];
  if (['Pending', 'OnHold'].includes(req.status) && req.initiated_by === userId) out.push('Cancel');
  if (!step || req.initiated_by === userId || !step.approver_ids.includes(userId)) return out;
  if (distinct && priorDeciders.includes(userId)) return out;
  if (step.status === 'Pending') out.push('Approve', 'Reject', 'Return', 'Hold');
  if (step.status === 'OnHold') out.push('Resume', 'Reject', 'Return');
  return out;
}

export async function decide(tx: Tx, actor: Actor, requestId: string, decision: ApprovalDecision, remarks: string): Promise<ApprovalRequestRow> {
  if (!actor.userId) throw Errors.authRequired();
  const req = (await tx.query<ApprovalRequestRow>(`select * from wf.approval_requests where id = $1 for update`, [requestId])).rows[0];
  if (!req) throw Errors.notFound('Approval request');
  if (!['Pending', 'OnHold'].includes(req.status)) throw Errors.state(`This request is already ${req.status}.`);
  const step = (await tx.query<{ id: string; seq: number; status: string; approver_ids: string[]; approver_rule: StepDef }>(
    `select id, seq, status, approver_ids, approver_rule from wf.approval_steps where request_id = $1 and step_kind = 'approve' and status in ('Pending','OnHold')
      order by seq limit 1 for update`, [requestId])).rows[0] ?? null;
  const prior = (await tx.query<{ decided_by: string }>(
    `select decided_by from wf.approval_steps where request_id = $1 and status = 'Approved' and decided_by is not null`, [requestId])).rows.map((r) => r.decided_by);
  const pv = await tx.query<{ definition: PolicyDefinition }>(`select definition from wf.policy_versions where id = $1`, [req.policy_version_id]);
  const distinct = pv.rows[0]?.definition.distinctApprovers ?? true;

  const allowed = allowedDecisions(req, step, actor.userId, prior, distinct);
  if (!allowed.includes(decision)) {
    if (req.initiated_by === actor.userId && decision !== 'Cancel') throw Errors.sod('You cannot decide on a request you initiated.');
    if (distinct && prior.includes(actor.userId)) throw Errors.sod('You already approved an earlier step of this request.');
    if (step && !step.approver_ids.includes(actor.userId) && decision !== 'Cancel') throw Errors.forbidden('wf.approval:decide');
    throw Errors.state(`"${decision}" is not possible at this point.`);
  }

  await allowTransition(tx);
  const h = handlerFor(req.subject_type);
  const setReq = (status: string, done = false) =>
    tx.query(`update wf.approval_requests set status = $2, completed_at = case when $3 then now() else completed_at end where id = $1`, [req.id, status, done]);
  const setStep = (status: string, decided = true) =>
    tx.query(`update wf.approval_steps set status = $2, decided_at = case when $3 then now() end, decided_by = case when $3 then $4::uuid end where id = $1`,
      [step!.id, status, decided, actor.userId]);
  const cancelWaiting = () => tx.query(`update wf.approval_steps set status = 'Cancelled' where request_id = $1 and status in ('Waiting','Pending','OnHold')`, [req.id]);

  switch (decision) {
    case 'Cancel': await cancelWaiting(); await setReq('Cancelled', true); await h.onCancelled(tx, req, actor); break;
    case 'Hold': await setStep('OnHold', false); await setReq('OnHold'); break;
    case 'Resume': await setStep('Pending', false); await setReq('Pending'); break;
    case 'Reject': await setStep('Rejected'); await cancelWaiting(); await setReq('Rejected', true); await h.onRejected(tx, req, actor); break;
    case 'Return': await setStep('Returned'); await cancelWaiting(); await setReq('Returned', true); await h.onReturned(tx, req, actor); break;
    case 'Approve': {
      await h.beforeApprove?.(tx, req, step?.approver_rule?.key ?? null, actor);
      await setStep('Approved');
      const next = (await tx.query<{ id: string; approver_ids: string[]; approver_rule: StepDef }>(
        `select id, approver_ids, approver_rule from wf.approval_steps where request_id = $1 and status = 'Waiting' and step_kind = 'approve' order by seq limit 1`, [req.id])).rows[0];
      if (next) {
        const deciders = [...prior, actor.userId];
        const eligible = distinct ? next.approver_ids.filter((u) => !deciders.includes(u)) : next.approver_ids;
        const sla = next.approver_rule.slaHours ?? (await getSetting<number>(tx, 'approvals.defaultSlaHours', 24));
        if (eligible.length === 0) {
          await tx.query(`update wf.approval_steps set status = 'OnHold', approver_ids = $2, activated_at = now() where id = $1`, [next.id, next.approver_ids]);
          await setReq('OnHold');
          await audit(tx, actor, { action: 'approval.no_distinct_approver', entityType: 'wf.approval', entityId: req.id, reason: 'Every eligible approver of the next step already decided an earlier step.' });
        } else {
          await tx.query(`update wf.approval_steps set status = 'Pending', approver_ids = $2, activated_at = now(), due_at = now() + make_interval(hours => $3) where id = $1`, [next.id, eligible, sla]);
          await emit(tx, 'wf.approval', req.id, 'approval.step_assigned', { userIds: eligible });
        }
      } else {
        await setReq('Approved', true);
        await h.onApproved(tx, req, actor);
      }
      break;
    }
    default: throw Errors.state('Unknown decision');
  }
  await tx.query(`insert into wf.approval_decisions (request_id, step_id, actor_id, decision, remarks) values ($1,$2,$3,$4,$5)`,
    [req.id, step?.id ?? null, actor.userId, decision, remarks]);
  await audit(tx, actor, { action: `approval.${decision.toLowerCase()}`, entityType: req.subject_type, entityId: req.subject_id,
    after: { approvalRequest: req.doc_no, step: step?.seq ?? null }, reason: remarks || null });
  await emit(tx, 'wf.approval', req.id, `approval.${decision.toLowerCase()}`, { subjectType: req.subject_type, subjectId: req.subject_id });
  return (await tx.query<ApprovalRequestRow>(`select * from wf.approval_requests where id = $1`, [req.id])).rows[0]!;
}
