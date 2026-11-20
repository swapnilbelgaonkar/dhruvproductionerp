import { Router, type Request } from 'express';
import { addressSchema, dealerSchema, licenceSchema, licenceVerifySchema, reasonSchema, signatorySchema } from '@dhruv/contracts';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, diff, emit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextMasterCode } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can, territoryScope } from '../../middleware/context';
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

async function duplicates(dbx: Db | Tx, d: { gstin?: string | null; pan?: string; mobile?: string }, excludeId: string | null) {
  const r = await dbx.query(
    `select p.id, p.code, p.legal_name as "legalName", p.gstin, p.pan, p.mobile, dp.status
       from mdm.parties p left join mdm.dealer_profiles dp on dp.party_id = p.id
      where p.id <> coalesce($4::uuid, '00000000-0000-0000-0000-000000000000') and (($1::text is not null and p.gstin = $1) or p.pan = $2 or p.mobile = $3)
        and coalesce(dp.status, 'Active') <> 'Rejected'`, [d.gstin ?? null, d.pan ?? null, d.mobile ?? null, excludeId]);
  return r.rows.map((x) => ({ ...x, matches: [x.gstin && x.gstin === d.gstin && 'GSTIN', x.pan === d.pan && 'PAN', x.mobile === d.mobile && 'mobile'].filter(Boolean) }));
}

/** Readiness checklist shown to the user and enforced on submission (DLR-001…008, D07 rules). */
export async function readiness(dbx: Db | Tx, partyId: string) {
  const p = (await dbx.query(`select p.*, dp.* from mdm.parties p join mdm.dealer_profiles dp on dp.party_id = p.id where p.id = $1`, [partyId])).rows[0];
  const checks: { key: string; label: string; ok: boolean; detail?: string }[] = [];
  const add = (key: string, label: string, ok: boolean, detail?: string) => checks.push({ key, label, ok, detail });

  const addr = (await dbx.query(`select kind, state_code from mdm.party_addresses where party_id = $1 and status = 'Active'`, [partyId])).rows;
  const reg = addr.find((a) => a.kind === 'REGISTERED');
  add('addr.registered', 'Registered address', !!reg);
  add('addr.billing', 'Billing address', addr.some((a) => a.kind === 'BILLING'));
  add('addr.shipping', 'At least one shipping address', addr.some((a) => a.kind === 'SHIPPING'));
  if (p.gst_registered) {
    add('gst.state', 'GSTIN state matches the registered address', !!reg && !!p.gstin && p.gstin.slice(0, 2) === reg.state_code,
      reg && p.gstin && p.gstin.slice(0, 2) !== reg.state_code ? `GSTIN state ${p.gstin.slice(0, 2)}, address state ${reg.state_code}` : undefined);
  }

  const dups = await duplicates(dbx, p, partyId);
  add('dup', 'No other dealer with the same GSTIN or PAN', !dups.some((d) => d.matches.includes('GSTIN') || d.matches.includes('PAN')),
    dups.length ? dups.map((d) => `${d.code} (${d.matches.join(', ')})`).join('; ') : undefined);

  const refs = (await dbx.query(
    `select (select status from org.territories where id = $1) as territory, (select status from org.employees where id = $2) as owner`, [p.territory_id, p.sales_owner_id])).rows[0];
  add('refs', 'Territory and sales owner are active', refs.territory === 'Active' && refs.owner === 'Active');

  const lic = (await dbx.query(`select licence_type, valid_to, verification from mdm.party_licences where party_id = $1 and status = 'Active'`, [partyId])).rows;
  const today = new Date().toISOString().slice(0, 10);
  for (const t of p.licence_types as string[]) {
    const l = lic.find((x) => x.licence_type === t);
    const validTo = l ? new Date(l.valid_to).toISOString().slice(0, 10) : null;
    add(`licence.${t}`, `${t[0]}${t.slice(1).toLowerCase()} licence with certificate, not expired`, !!l && validTo! >= today && l.verification !== 'Rejected',
      !l ? 'Missing' : validTo! < today ? `Expired on ${validTo}` : l.verification === 'Rejected' ? 'Rejected by verifier — replace it' : undefined);
  }

  const policy = await getSetting<string>(dbx, 'dealer.kyc.policy', 'CONDITIONAL');
  const reqs = (await dbx.query(
    `select requirement, min_count, condition, threshold, note from mdm.kyc_requirements
      where policy in ('BOTH', $1) and constitution in ('*', $2) order by requirement`, [policy, p.constitution])).rows;
  const docCounts = new Map((await dbx.query(
    `select document_type, count(*)::int as n from sys.documents where entity_type = 'mdm.party' and entity_id = $1 and status = 'Active' group by document_type`, [partyId])).rows
    .map((r) => [r.document_type, r.n]));
  const signatories = Number((await dbx.query(`select count(*) from mdm.party_signatories where party_id = $1 and status = 'Active'`, [partyId])).rows[0].count);
  // the strictest applicable rule per requirement wins
  const need = new Map<string, { n: number; note: string }>();
  for (const r of reqs) {
    const applies = r.condition === 'ALWAYS' || (r.condition === 'GST_REGISTERED' && p.gst_registered) || (r.condition === 'CREDIT_ABOVE' && Number(p.credit_limit) > Number(r.threshold ?? 0));
    if (applies && (need.get(r.requirement)?.n ?? 0) < r.min_count) need.set(r.requirement, { n: r.min_count, note: r.note });
  }
  for (const [reqt, { n, note }] of need) {
    const have = reqt === 'SIGNATORY' ? signatories : docCounts.get(reqt) ?? 0;
    add(`kyc.${reqt}`, note, have >= n, have < n ? `${have} of ${n} uploaded` : undefined);
  }
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
         join org.territories t on t.id = dp.territory_id join org.employees e on e.id = dp.sales_owner_id
        where ${where.join(' and ')} order by p.code desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map((x) => { const { total: _t, ...rest } = x; return rest; }), total: rows.rows[0]?.total ?? 0 });
  }));

  r.get('/duplicates', requirePermission(P('view')), asyncHandler(async (req, res) => {
    res.json({ data: await duplicates(db, { gstin: str(req.query.gstin)?.toUpperCase(), pan: str(req.query.pan)?.toUpperCase(), mobile: str(req.query.mobile) }, str(req.query.excludeId) ?? null) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const d = await loadDealer(db, req, req.params.id!);
    const [addresses, licences, signatories, approvals, refs] = await Promise.all([
      db.query(`select id, kind, label, line1, line2, city, district, state_code as "stateCode", pincode, is_default as "isDefault", status
                  from mdm.party_addresses where party_id = $1 and status = 'Active' order by kind, created_at`, [d.party_id]),
      db.query(`select l.id, l.licence_type as "licenceType", l.number, l.issuer, l.valid_from as "validFrom", l.valid_to as "validTo", l.verification,
                       l.remarks, l.verified_at as "verifiedAt", v.full_name as "verifiedBy", l.document_id as "documentId", l.status
                  from mdm.party_licences l left join iam.users v on v.id = l.verified_by where l.party_id = $1 order by l.status, l.licence_type, l.created_at desc`, [d.party_id]),
      db.query(`select id, full_name as "fullName", designation, id_type as "idType", id_last4 as "idLast4", document_id as "documentId"
                  from mdm.party_signatories where party_id = $1 and status = 'Active' order by created_at`, [d.party_id]),
      db.query(`select a.id, a.doc_no, a.status, a.submitted_at, u.full_name as initiator from wf.approval_requests a join iam.users u on u.id = a.initiated_by
                 where a.subject_type = 'mdm.dealer' and a.subject_id = $1 order by a.submitted_at desc`, [d.party_id]),
      db.query(`select t.name as territory, e.full_name as owner from org.territories t, org.employees e where t.id = $1 and e.id = $2`, [d.territory_id, d.sales_owner_id]),
    ]);
    const status = d.dealer_status as string;
    const actions: string[] = [];
    if (EDITABLE.includes(status) && can(req, P('edit_draft'))) actions.push('edit');
    if (EDITABLE.includes(status) && can(req, P('submit'))) actions.push('submit');
    if (status === 'Active' && can(req, P('suspend'))) actions.push('suspend');
    if (status === 'Suspended' && can(req, P('suspend'))) actions.push('reactivate');
    res.json({
      id: d.party_id, code: d.code, legalName: d.legal_name, tradeName: d.trade_name, constitution: d.constitution, pan: d.pan,
      gstRegistered: d.gst_registered, gstin: d.gstin, contactPerson: d.contact_person, mobile: d.mobile, email: d.email,
      dealerCategory: d.dealer_category, territoryId: d.territory_id, territory: refs.rows[0]?.territory, salesOwnerId: d.sales_owner_id, salesOwner: refs.rows[0]?.owner,
      licenceTypes: d.licence_types, priceGroup: d.price_group, creditDays: d.credit_days, creditLimit: d.credit_limit, annualTarget: d.annual_target, targetFy: d.target_fy,
      status, statusReason: d.status_reason, activatedAt: d.activated_at, version: d.version, updatedAt: d.updated_at,
      addresses: addresses.rows, licences: licences.rows, signatories: signatories.rows, approvals: approvals.rows,
      readiness: EDITABLE.includes(status) ? await readiness(db, d.party_id) : null,
      allowedActions: actions,
      canEditDetails: EDITABLE.includes(status) && can(req, P('edit_draft')),
      canAddLicence: status !== 'Inactive' && can(req, P('edit_draft')),
      canVerify: ['Submitted', 'Active', 'Suspended'].includes(status) && can(req, P('verify_documents')),
    });
  }));

  async function checkRefs(tx: Tx, req: Request, d: { territoryId: string; salesOwnerId: string }) {
    const t = (await tx.query(`select status from org.territories where id = $1`, [d.territoryId])).rows[0];
    if (!t || t.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active territory.');
    const e = (await tx.query(`select status from org.employees where id = $1`, [d.salesOwnerId])).rows[0];
    if (!e || e.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Choose an active sales owner.');
    const ids = await territoryScope(tx, req, P('create'));
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
        `insert into mdm.parties (code, legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`,
        [code, d.legalName, d.tradeName, d.constitution, d.pan, d.gstRegistered, d.gstRegistered ? d.gstin : null, d.contactPerson, d.mobile, d.email ?? null, actor.userId])).rows[0];
      await tx.query(
        `insert into mdm.dealer_profiles (party_id, dealer_category, territory_id, sales_owner_id, licence_types, price_group, credit_days, credit_limit, annual_target, target_fy, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [p.id, d.dealerCategory, d.territoryId, d.salesOwnerId, d.licenceTypes, d.priceGroup, d.creditDays, d.creditLimit, d.annualTarget ?? null, d.targetFy ?? null, actor.userId]);
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
        `update mdm.parties set legal_name=$2, trade_name=$3, constitution=$4, pan=$5, gst_registered=$6, gstin=$7, contact_person=$8, mobile=$9, email=$10, updated_by=$11
          where id = $1 returning legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email`,
        [before.party_id, d.legalName, d.tradeName, d.constitution, d.pan, d.gstRegistered, d.gstRegistered ? d.gstin : null, d.contactPerson, d.mobile, d.email ?? null, actor.userId])).rows[0];
      const dp = (await tx.query(
        `update mdm.dealer_profiles set dealer_category=$2, territory_id=$3, sales_owner_id=$4, licence_types=$5, price_group=$6, credit_days=$7, credit_limit=$8,
           annual_target=$9, target_fy=$10, updated_by=$11 where party_id = $1 returning dealer_category, territory_id, sales_owner_id, licence_types, price_group, credit_days, credit_limit, annual_target, target_fy`,
        [before.party_id, d.dealerCategory, d.territoryId, d.salesOwnerId, d.licenceTypes, d.priceGroup, d.creditDays, d.creditLimit, d.annualTarget ?? null, d.targetFy ?? null, actor.userId])).rows[0];
      const df = diff(before, { ...before, ...p, ...dp });
      await audit(tx, actor, { action: 'mdm.dealer.updated', entityType: 'mdm.party', entityId: before.party_id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));

  // ---- addresses, licences, signatories (child records)
  const childGuard = async (tx: Tx, req: Request, perm: string, allowActive = false) => {
    const d = await loadDealer(tx, req, req.params.id!, perm, true);
    const ok = EDITABLE.includes(d.dealer_status) || (allowActive && ['Active', 'Suspended', 'Submitted'].includes(d.dealer_status));
    if (!ok) throw Errors.state(`Details of a ${d.dealer_status} dealer cannot be changed here.`);
    return d;
  };

  r.post('/:id/addresses', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const a = parse(addressSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const d = await childGuard(tx, req, P('edit_draft'));
      if (a.kind !== 'SHIPPING') {
        await tx.query(`update mdm.party_addresses set status = 'Inactive' where party_id = $1 and kind = $2 and status = 'Active'`, [d.party_id, a.kind]);
      }
      const ins = await tx.query(
        `insert into mdm.party_addresses (party_id, kind, label, line1, line2, city, district, state_code, pincode, is_default, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [d.party_id, a.kind, a.label, a.line1, a.line2, a.city, a.district, a.stateCode, a.pincode, a.isDefault, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.dealer.address_added', entityType: 'mdm.party', entityId: d.party_id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.post('/:id/addresses/:aid/remove', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const d = await childGuard(tx, req, P('edit_draft'));
      const x = await tx.query(`update mdm.party_addresses set status = 'Inactive' where id = $1 and party_id = $2 and status = 'Active' returning kind`, [req.params.aid, d.party_id]);
      if (!x.rowCount) throw Errors.notFound('Address');
      await audit(tx, actorOf(req), { action: 'mdm.dealer.address_removed', entityType: 'mdm.party', entityId: d.party_id, after: { addressId: req.params.aid } });
    });
    res.json({ ok: true });
  }));

  async function assertDoc(tx: Tx, partyId: string, documentId: string, types: string[]) {
    const doc = (await tx.query(`select document_type, entity_type, entity_id, status from sys.documents where id = $1`, [documentId])).rows[0];
    if (!doc || doc.entity_type !== 'mdm.party' || doc.entity_id !== partyId || doc.status !== 'Active') throw Errors.rule('DOCUMENT_INVALID', 'Upload the supporting document to this dealer first.');
    if (!types.includes(doc.document_type)) throw Errors.rule('DOCUMENT_INVALID', `The supporting document must be of type ${types.join(' or ')}.`);
  }
  const LICENCE_DOC: Record<string, string> = { FERTILIZER: 'FERTILIZER_LICENCE', PESTICIDE: 'PESTICIDE_LICENCE', BIOSTIMULANT: 'BIOSTIMULANT_REGISTRATION' };

  // A new licence of the same type supersedes the old one (renewal). It needs verification again before it counts for orders.
  r.post('/:id/licences', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const l = parse(licenceSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const d = await childGuard(tx, req, P('edit_draft'), true);
      await assertDoc(tx, d.party_id, l.documentId, [LICENCE_DOC[l.licenceType]!]);
      await tx.query(`update mdm.party_licences set status = 'Superseded' where party_id = $1 and licence_type = $2 and status = 'Active'`, [d.party_id, l.licenceType]);
      const ins = await tx.query(
        `insert into mdm.party_licences (party_id, licence_type, number, issuer, valid_from, valid_to, document_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [d.party_id, l.licenceType, l.number, l.issuer, l.validFrom, l.validTo, l.documentId, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.dealer.licence_added', entityType: 'mdm.party', entityId: d.party_id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));

  r.post('/:id/licences/:lid/verify', requirePermission(P('verify_documents')), asyncHandler(async (req, res) => {
    const v = parse(licenceVerifySchema, req.body);
    await withTx(db, async (tx) => {
      const d = await loadDealer(tx, req, req.params.id!, P('verify_documents'), true);
      if (!['Submitted', 'Active', 'Suspended'].includes(d.dealer_status)) throw Errors.state('Licences are verified after the dealer is submitted.');
      const l = (await tx.query(`select * from mdm.party_licences where id = $1 and party_id = $2 and status = 'Active' for update`, [req.params.lid, d.party_id])).rows[0];
      if (!l) throw Errors.notFound('Licence');
      if (l.created_by === req.auth!.user.id) throw Errors.sod('You entered this licence; another person must verify it.');
      await tx.query(`update mdm.party_licences set verification = $2, remarks = $3, verified_by = $4, verified_at = now() where id = $1`,
        [l.id, v.verification, v.remarks || null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `mdm.dealer.licence_${v.verification.toLowerCase()}`, entityType: 'mdm.party', entityId: d.party_id,
        after: { licenceId: l.id, type: l.licence_type, number: l.number }, reason: v.remarks || null });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/signatories', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const s = parse(signatorySchema, req.body);
    const id = await withTx(db, async (tx) => {
      const d = await childGuard(tx, req, P('edit_draft'));
      await assertDoc(tx, d.party_id, s.documentId, ['SIGNATORY_ID', 'PAN_CARD']);
      const ins = await tx.query(
        `insert into mdm.party_signatories (party_id, full_name, designation, id_type, id_last4, document_id, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [d.party_id, s.fullName, s.designation, s.idType, s.idLast4, s.documentId, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.dealer.signatory_added', entityType: 'mdm.party', entityId: d.party_id, after: { fullName: s.fullName, designation: s.designation, idType: s.idType } });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.post('/:id/signatories/:sid/remove', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const d = await childGuard(tx, req, P('edit_draft'));
      const x = await tx.query(`update mdm.party_signatories set status = 'Inactive' where id = $1 and party_id = $2 and status = 'Active'`, [req.params.sid, d.party_id]);
      if (!x.rowCount) throw Errors.notFound('Signatory');
      await audit(tx, actorOf(req), { action: 'mdm.dealer.signatory_removed', entityType: 'mdm.party', entityId: d.party_id, after: { signatoryId: req.params.sid } });
    });
    res.json({ ok: true });
  }));

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
