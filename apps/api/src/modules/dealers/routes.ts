import { Router, type Request } from 'express';
import { DEALER_LICENCE_TYPES, dealerSchema, reasonSchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, diff, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextMasterCode } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, territoryScope } from '../../middleware/context';
import { checklist, duplicates, identityChecks, kycDetailChecks, kycChecks, licenceChecks, partyChildRoutes, partyDetailParts } from '../parties/shared';
import { registerSubjectHandler, submitForApproval, type ApprovalRequestRow } from '../workflow/engine';

const P = (a: string) => `mdm.dealer:${a}`;
const EDITABLE = ['Draft', 'Rejected'];

/** SQL fragment restricting dealers (alias dp) to the user's territory subtree. */
async function scopeSql(db: Db | Tx, req: Request, perm: string, args: unknown[]) {
  const ids = await territoryScope(db, req, perm);
  if (ids === null) return 'true';
  args.push(ids);
  return `exists (select 1 from org.territories dt join org.territories ut on dt.path <@ ut.path where dt.id = dp.territory_id and ut.id = any($${args.length}::uuid[]))`;
}

async function loadDealer(dbx: Db | Tx, req: Request, id: string, perm = P('view'), lock = false) {
  const args: unknown[] = [id];
  const scope = await scopeSql(dbx, req, perm, args);
  const row = (await dbx.query(
    `select p.*, dp.*, dp.status as dealer_status from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id
      where p.id = $1 and ${scope} ${lock ? 'for update of dp' : ''}`, args)).rows[0];
  if (!row) throw Errors.notFound('Dealer');
  return row;
}

async function setStatus(tx: Tx, partyId: string, status: string, actor: Actor, reason?: string | null) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from mdm.dealer_profiles where party_id = $1`, [partyId])).rows[0];
  await tx.query(
    `update mdm.dealer_profiles set status = $2, status_reason = $3, updated_by = $4,
       activated_at = case when $2 = 'Active' and activated_at is null then now() else activated_at end where party_id = $1`,
    [partyId, status, reason ?? null, actor.userId]);
  await audit(tx, actor, { action: 'mdm.dealer.status', entityType: 'mdm.party', entityId: partyId, before, after: { status }, reason: reason ?? null });
  await emit(tx, 'mdm.dealer', partyId, `dealer.${status.toLowerCase()}`);
}

/** Readiness checklist shown to the user and enforced on submission (DLR-001…008, D07 rules). */
export async function readiness(dbx: Db | Tx, partyId: string) {
  const p = (await dbx.query(`select p.*, dp.* from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id where p.id = $1`, [partyId])).rows[0];
  const { checks, add } = checklist();
  await kycDetailChecks(dbx, { ...p, id: partyId }, add);
  add('profile', 'Dealer category, territory and sales owner', !!p.dealer_category && !!p.territory_id && !!p.sales_owner_id,
    [!p.dealer_category && 'category', !p.territory_id && 'territory', !p.sales_owner_id && 'sales owner'].filter(Boolean).length
      ? `Missing: ${[!p.dealer_category && 'category', !p.territory_id && 'territory', !p.sales_owner_id && 'sales owner'].filter(Boolean).join(', ')}` : undefined);
  await identityChecks(dbx, { ...p, id: partyId }, add, { billing: true, shipping: true, noun: 'dealer' });
  const refs = (await dbx.query(
    `select (select status from org.territories where id = $1) as territory, (select status from org.employees where id = $2) as owner`, [p.territory_id, p.sales_owner_id])).rows[0];
  add('refs', 'Territory and sales owner are active', refs.territory === 'Active' && refs.owner === 'Active');
  await licenceChecks(dbx, partyId, p.licence_types, add);
  const policy = await getSetting<string>(dbx, 'dealer.kyc.policy', 'CONDITIONAL');
  await kycChecks(dbx, 'DEALER', policy, { ...p, id: partyId }, add);
  return { ready: checks.every((c) => c.ok), policy, checks };
}

export function dealerRoutes(db: Db) {
  registerSubjectHandler('mdm.dealer', {
    onApproved: (tx, r: ApprovalRequestRow, a) => setStatus(tx, r.subject_id, 'Active', a),
    onRejected: (tx, r, a) => setStatus(tx, r.subject_id, 'Rejected', a),
    onReturned: (tx, r, a) => setStatus(tx, r.subject_id, 'Draft', a, 'Returned for correction'),
    onCancelled: (tx, r, a) => setStatus(tx, r.subject_id, 'Draft', a, 'Submission withdrawn'),
    beforeApprove: async (tx, r, stepKey) => {
      if (stepKey !== 'doc_verification') return;
      const pending = (await tx.query(
        `select licence_type, verification from mdm.party_licences where party_id = $1 and status = 'Active' and verification <> 'Verified'`, [r.subject_id])).rows;
      if (pending.length) {
        throw Errors.rule('LICENCES_NOT_VERIFIED', `Verify every licence before approving: ${pending.map((x) => `${x.licence_type} (${x.verification})`).join(', ')}. Return the application if a licence was rejected.`);
      }
    },
  });

  const r = Router();

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = [await scopeSql(db, req, P('view'), args)];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(p.code ilike $${args.length} or p.legal_name ilike $${args.length} or p.trade_name ilike $${args.length} or p.gstin ilike $${args.length} or p.mobile like $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`dp.status = $${args.length}`); }
    const rows = await db.query(
      `select p.id, p.code, p.legal_name as "legalName", p.trade_name as "tradeName", p.constitution, p.gstin, p.mobile,
              dp.dealer_category as "dealerCategory", dp.status, dp.credit_limit as "creditLimit", dp.credit_days as "creditDays",
              t.name as territory, e.full_name as "salesOwner", dp.licence_types as "licenceTypes",
              (select min(valid_to) from mdm.party_licences l where l.party_id = p.id and l.status = 'Active') as "nextLicenceExpiry",
              count(*) over() as total
         from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id
         left join org.territories t on t.id = dp.territory_id left join org.employees e on e.id = dp.sales_owner_id
        where ${where.join(' and ')} order by p.code desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/duplicates', requirePermission(P('view')), asyncHandler(async (req, res) => {
    res.json({ data: await duplicates(db, { gstin: str(req.query.gstin)?.toUpperCase(), pan: str(req.query.pan)?.toUpperCase(), mobile: str(req.query.mobile) }, str(req.query.excludeId) ?? null) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const d = await loadDealer(db, req, req.params.id!);
    const parts = await partyDetailParts(db, d.party_id, 'mdm.dealer');
    const refs = await db.query(`select (select name from org.territories where id = $1) as territory, (select full_name from org.employees where id = $2) as owner`, [d.territory_id, d.sales_owner_id]);
    const status = d.dealer_status as string;
    const actions: string[] = [];
    if (EDITABLE.includes(status) && can(req, P('edit_draft'))) actions.push('edit');
    if (EDITABLE.includes(status) && can(req, P('submit'))) actions.push('submit');
    if (status === 'Active' && can(req, P('suspend'))) actions.push('suspend');
    if (status === 'Suspended' && can(req, P('suspend'))) actions.push('reactivate');
    res.json({
      id: d.party_id, code: d.code, legalName: d.legal_name, tradeName: d.trade_name, constitution: d.constitution, pan: d.pan,
      gstRegistered: d.gst_registered, gstin: d.gstin, contactPerson: d.contact_person, mobile: d.mobile, phoneNumbers: d.phone_numbers, email: d.email,
      dealerCategory: d.dealer_category, territoryId: d.territory_id, territory: refs.rows[0]?.territory, salesOwnerId: d.sales_owner_id, salesOwner: refs.rows[0]?.owner,
      licenceTypes: d.licence_types, priceGroup: d.price_group, creditDays: d.credit_days, creditLimit: d.credit_limit, annualTarget: d.annual_target, targetFy: d.target_fy,
      status, statusReason: d.status_reason, activatedAt: d.activated_at, version: d.version, updatedAt: d.updated_at,
      ...parts,
      readiness: EDITABLE.includes(status) ? await readiness(db, d.party_id) : null,
      allowedActions: actions,
      canEditDetails: EDITABLE.includes(status) && can(req, P('edit_draft')),
      canAddLicence: status !== 'Inactive' && can(req, P('edit_draft')),
      canVerify: ['Submitted', 'Active', 'Suspended'].includes(status) && can(req, P('verify_documents')),
    });
  }));

  async function checkRefs(tx: Tx, req: Request, d: { territoryId?: string | null; salesOwnerId?: string | null }) {
    if (d.territoryId) {
      const t = (await tx.query(`select status from org.territories where id = $1`, [d.territoryId])).rows[0];
      if (!t || t.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active territory.');
    }
    if (d.salesOwnerId) {
      const e = (await tx.query(`select status from org.employees where id = $1`, [d.salesOwnerId])).rows[0];
      if (!e || e.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active sales owner.');
    }
    const ids = await territoryScope(tx, req, P('create'));
    // a territory-scoped user only records dealers inside their territory; leaving it empty is for unscoped users
    if (ids !== null && !d.territoryId) throw Errors.validation([{ field: 'territoryId', message: 'Choose the territory' }]);
    if (ids !== null) {
      const ok = await tx.query(`select 1 from org.territories dt join org.territories ut on dt.path <@ ut.path where dt.id = $1 and ut.id = any($2::uuid[])`, [d.territoryId, ids]);
      if (!ok.rowCount) throw Errors.forbidden(`${P('create')} in this territory`);
    }
  }

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(dealerSchema, req.body);
    const actor = actorOf(req);
    const out = await withTx(db, async (tx) => {
      await checkRefs(tx, req, d);
      const dups = (await duplicates(tx, d, null)).filter((x) => x.matches.includes('GSTIN') || x.matches.includes('PAN'));
      if (dups.length) throw Errors.conflict('DUPLICATE_PARTY', `A dealer with the same ${dups[0]!.matches.join(' and ')} already exists: ${dups[0]!.code}.`, dups);
      const code = await nextMasterCode(tx, 'DEALER_CODE');
      const p = (await tx.query(
        `insert into mdm.parties (code, legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email, phone_numbers, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning id`,
        [code, d.legalName, d.tradeName, d.constitution ?? null, d.pan ?? null, d.gstRegistered, d.gstRegistered ? d.gstin : null, d.contactPerson ?? null, d.mobile ?? null, d.email ?? null, d.phoneNumbers ?? null, actor.userId])).rows[0];
      await tx.query(
        `insert into mdm.dealer_profiles (party_id, dealer_category, territory_id, sales_owner_id, licence_types, price_group, credit_days, credit_limit, annual_target, target_fy, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [p.id, d.dealerCategory ?? null, d.territoryId ?? null, d.salesOwnerId ?? null, d.licenceTypes, d.priceGroup, d.creditDays, d.creditLimit, d.annualTarget ?? null, d.targetFy ?? null, actor.userId]);
      await audit(tx, actor, { action: 'mdm.dealer.created', entityType: 'mdm.party', entityId: p.id, after: { code, ...d } });
      return { id: p.id, code };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const d = parse(dealerSchema, req.body);
    const actor = actorOf(req);
    await withTx(db, async (tx) => {
      const before = await loadDealer(tx, req, req.params.id!, P('edit_draft'), true);
      if (!EDITABLE.includes(before.dealer_status)) throw Errors.state(`A ${before.dealer_status} dealer cannot be edited.`);
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      await checkRefs(tx, req, d);
      const dups = (await duplicates(tx, d, before.party_id)).filter((x) => x.matches.includes('GSTIN') || x.matches.includes('PAN'));
      if (dups.length) throw Errors.conflict('DUPLICATE_PARTY', `A dealer with the same ${dups[0]!.matches.join(' and ')} already exists: ${dups[0]!.code}.`, dups);
      const p = (await tx.query(
        `update mdm.parties set legal_name=$2, trade_name=$3, constitution=$4, pan=$5, gst_registered=$6, gstin=$7, contact_person=$8, mobile=$9, email=$10, phone_numbers=$11, updated_by=$12
          where id = $1 returning legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email, phone_numbers`,
        [before.party_id, d.legalName, d.tradeName, d.constitution ?? null, d.pan ?? null, d.gstRegistered, d.gstRegistered ? d.gstin : null, d.contactPerson ?? null, d.mobile ?? null, d.email ?? null, d.phoneNumbers ?? null, actor.userId])).rows[0];
      const dp = (await tx.query(
        `update mdm.dealer_profiles set dealer_category=$2, territory_id=$3, sales_owner_id=$4, licence_types=$5, price_group=$6, credit_days=$7, credit_limit=$8,
           annual_target=$9, target_fy=$10, updated_by=$11 where party_id = $1 returning dealer_category, territory_id, sales_owner_id, licence_types, price_group, credit_days, credit_limit, annual_target, target_fy`,
        [before.party_id, d.dealerCategory ?? null, d.territoryId ?? null, d.salesOwnerId ?? null, d.licenceTypes, d.priceGroup, d.creditDays, d.creditLimit, d.annualTarget ?? null, d.targetFy ?? null, actor.userId])).rows[0];
      const df = diff(before, { ...before, ...p, ...dp });
      await audit(tx, actor, { action: 'mdm.dealer.updated', entityType: 'mdm.party', entityId: before.party_id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));

  // ---- addresses, licences, signatories (shared with other party roles)
  partyChildRoutes(r, db, {
    noun: 'dealer', perm: P, editable: EDITABLE, licenceTypes: DEALER_LICENCE_TYPES,
    licenceStatuses: [...EDITABLE, 'Submitted', 'Active', 'Suspended'], verifyStatuses: ['Submitted', 'Active', 'Suspended'],
    load: async (tx, req, id, perm) => { const d = await loadDealer(tx, req, id, perm, true); return { party_id: d.party_id, status: d.dealer_status }; },
  });

  // ---- lifecycle
  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const out = await withTx(db, async (tx) => {
      const d = await loadDealer(tx, req, req.params.id!, P('submit'), true);
      if (!EDITABLE.includes(d.dealer_status)) throw Errors.state(`A ${d.dealer_status} dealer cannot be submitted.`);
      const ready = await readiness(tx, d.party_id);
      if (!ready.ready) throw Errors.rule('NOT_READY', 'Complete the onboarding checklist before submitting.', ready.checks.filter((c) => !c.ok));
      // licences re-verified on every submission
      await tx.query(`update mdm.party_licences set verification = 'Pending', verified_by = null, verified_at = null where party_id = $1 and status = 'Active' and verification = 'Rejected'`, [d.party_id]);
      await setStatus(tx, d.party_id, 'Submitted', actor);
      return submitForApproval(tx, actor, {
        subjectType: 'mdm.dealer', subjectId: d.party_id, subjectLabel: `Dealer ${d.code} — ${d.legal_name}`, revision: d.version,
        facts: { creditLimit: Number(d.credit_limit), constitution: d.constitution, licenceTypes: d.licence_types },
      });
    });
    res.json({ approvalRequestId: out.id, approvalDocNo: out.doc_no, status: out.status });
  }));

  const suspendLike = (from: string, to: string, action: string) => asyncHandler(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const d = await loadDealer(tx, req, req.params.id!, P('suspend'), true);
      if (d.dealer_status !== from) throw Errors.state(`Only a ${from} dealer can be ${action}.`);
      await setStatus(tx, d.party_id, to, actorOf(req), reason);
    });
    res.json({ ok: true });
  });
  r.post('/:id/suspend', requirePermission(P('suspend')), suspendLike('Active', 'Suspended', 'suspended'));
  r.post('/:id/reactivate', requirePermission(P('suspend')), suspendLike('Suspended', 'Active', 'reactivated'));

  return r;
}

/**
 * Can this dealer be sold products needing these licences on this date? Used by quotations and orders (DLR-008, BR-11, TC-03).
 */
export async function dealerEligibility(dbx: Db | Tx, partyId: string, licenceTypes: string[], onDate: string) {
  const d = (await dbx.query(`select status from mdm.dealer_profiles where party_id = $1`, [partyId])).rows[0];
  if (!d) return { eligible: false, reasons: ['Not a dealer'] };
  const reasons: string[] = [];
  if (d.status !== 'Active') reasons.push(`Dealer is ${d.status}`);
  const lic = (await dbx.query(`select licence_type, valid_to, verification from mdm.party_licences where party_id = $1 and status = 'Active'`, [partyId])).rows;
  for (const t of licenceTypes) {
    const l = lic.find((x) => x.licence_type === t);
    if (!l) reasons.push(`No ${t.toLowerCase()} licence`);
    else if (new Date(l.valid_to).toISOString().slice(0, 10) < onDate) reasons.push(`${t.toLowerCase()} licence expired`);
    else if (l.verification !== 'Verified') reasons.push(`${t.toLowerCase()} licence not verified`);
  }
  return { eligible: reasons.length === 0, reasons };
}
