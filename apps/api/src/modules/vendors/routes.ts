import { Router, type Request } from 'express';
import { bankAccountSchema, licenceVerifySchema, reasonSchema, VENDOR_LICENCE_TYPES, vendorItemSchema, vendorSchema } from '@dhruv/contracts';
import type { Config } from '../../config';
import { allowTransition, withTx, type Actor, type Db, type Tx } from '../../db/pool';
import { audit, diff, emit } from '../../lib/audit';
import { decrypt, encrypt } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { asyncHandler, pageParams, parse, str } from '../../lib/http';
import { nextMasterCode } from '../../lib/numbering';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { actorOf, can } from '../../middleware/context';
import { assertPartyDoc, checklist, duplicates, identityChecks, kycChecks, licenceChecks, partyChildRoutes, partyDetailParts } from '../parties/shared';
import { registerSubjectHandler, submitForApproval } from '../workflow/engine';

const P = (a: string) => `mdm.vendor:${a}`;
const EDITABLE = ['Draft', 'Rejected'];
const LIVE = ['Submitted', 'Active', 'Suspended'];

async function loadVendor(dbx: Db | Tx, id: string, lock = false) {
  const row = (await dbx.query(
    `select p.*, vp.*, vp.status as vendor_status from mdm.parties p join mdm.vendor_profiles vp on vp.party_id = p.id
      where p.id = $1 ${lock ? 'for update of vp' : ''}`, [id])).rows[0];
  if (!row) throw Errors.notFound('Vendor');
  return row;
}

async function setStatus(tx: Tx, partyId: string, status: string, actor: Actor, reason?: string | null) {
  await allowTransition(tx);
  const before = (await tx.query(`select status from mdm.vendor_profiles where party_id = $1`, [partyId])).rows[0];
  await tx.query(
    `update mdm.vendor_profiles set status = $2, status_reason = $3, updated_by = $4,
       activated_at = case when $2 = 'Active' and activated_at is null then now() else activated_at end where party_id = $1`,
    [partyId, status, reason ?? null, actor.userId]);
  await audit(tx, actor, { action: 'mdm.vendor.status', entityType: 'mdm.party', entityId: partyId, before, after: { status }, reason: reason ?? null });
  await emit(tx, 'mdm.vendor', partyId, `vendor.${status.toLowerCase()}`);
}

/** Onboarding checklist, shown live and enforced on submission (MDM-011/016, D07). */
export async function vendorReadiness(dbx: Db | Tx, partyId: string) {
  const p = await loadVendor(dbx, partyId);
  const { checks, add } = checklist();
  const missing = [!p.constitution && 'constitution', !p.pan && 'PAN', !p.contact_person && 'contact person', !p.mobile && 'mobile number'].filter(Boolean);
  add('kyc.details', 'Constitution, PAN, contact person and mobile', !missing.length, missing.length ? `Missing: ${missing.join(', ')}` : undefined);
  const reg = (await dbx.query(`select line1, city, district, state_code, pincode from mdm.party_addresses where party_id = $1 and kind = 'REGISTERED' and status = 'Active' limit 1`, [partyId])).rows[0];
  const gaps = reg ? [!reg.line1 && 'address line', !reg.city && 'city', !reg.district && 'district', !reg.state_code && 'state', !reg.pincode && 'PIN code'].filter(Boolean) : [];
  if (reg) add('addr.complete', 'Registered address complete', !gaps.length, gaps.length ? `Missing: ${gaps.join(', ')}` : undefined);
  await identityChecks(dbx, { ...p, id: partyId }, add, { billing: false, shipping: false, noun: 'vendor' });
  const bank = (await dbx.query(`select verification from mdm.party_bank_accounts where party_id = $1 and status = 'Active'`, [partyId])).rows[0];
  add('bank', 'Bank account with cancelled cheque', !!bank && bank.verification !== 'Rejected', bank?.verification === 'Rejected' ? 'Rejected by finance — replace it' : undefined);
  const items = Number((await dbx.query(`select count(*) from mdm.vendor_items where party_id = $1 and status = 'Active'`, [partyId])).rows[0].count);
  add('items', 'At least one item the vendor supplies', items > 0);
  await licenceChecks(dbx, partyId, p.licence_types, add);
  const policy = await getSetting<string>(dbx, 'vendor.kyc.policy', 'CONDITIONAL');
  await kycChecks(dbx, 'VENDOR', policy, { ...p, id: partyId }, add);
  return { ready: checks.every((c) => c.ok), policy, checks };
}

/**
 * Can goods be bought from this vendor on this date (purchase orders, part 2)? Active, bank account verified,
 * every licence it must hold valid and verified, and approved for the items.
 */
export async function vendorEligibility(dbx: Db | Tx, partyId: string, itemIds: string[], onDate: string) {
  const v = (await dbx.query(`select status, licence_types from mdm.vendor_profiles where party_id = $1`, [partyId])).rows[0];
  if (!v) return { eligible: false, reasons: ['Not a vendor'] };
  const reasons: string[] = [];
  if (v.status !== 'Active') reasons.push(`Vendor is ${v.status}`);
  const bank = (await dbx.query(`select verification from mdm.party_bank_accounts where party_id = $1 and status = 'Active'`, [partyId])).rows[0];
  if (bank?.verification !== 'Verified') reasons.push('Bank account not verified');
  const lic = (await dbx.query(`select licence_type, valid_to, verification from mdm.party_licences where party_id = $1 and status = 'Active'`, [partyId])).rows;
  for (const t of v.licence_types as string[]) {
    const l = lic.find((x) => x.licence_type === t);
    if (!l) reasons.push(`No ${t.toLowerCase()} licence`);
    else if (String(l.valid_to).slice(0, 10) < onDate) reasons.push(`${t.toLowerCase()} licence expired`);
    else if (l.verification !== 'Verified') reasons.push(`${t.toLowerCase()} licence not verified`);
  }
  if (itemIds.length) {
    const ok = new Set((await dbx.query(`select item_id from mdm.vendor_items where party_id = $1 and status = 'Active' and item_id = any($2::uuid[])`, [partyId, itemIds])).rows.map((x) => x.item_id));
    const missing = itemIds.filter((i) => !ok.has(i));
    if (missing.length) reasons.push(`Not approved for ${missing.length} of the items`);
  }
  return { eligible: reasons.length === 0, reasons };
}

export function vendorRoutes(db: Db, cfg: Config) {
  registerSubjectHandler('mdm.vendor', {
    onApproved: (tx, r, a) => setStatus(tx, r.subject_id, 'Active', a),
    onRejected: (tx, r, a) => setStatus(tx, r.subject_id, 'Rejected', a),
    onReturned: (tx, r, a) => setStatus(tx, r.subject_id, 'Draft', a, 'Returned for correction'),
    onCancelled: (tx, r, a) => setStatus(tx, r.subject_id, 'Draft', a, 'Submission withdrawn'),
    // gates: licences verified before document verification passes; bank account verified before finance passes
    beforeApprove: async (tx, r, stepKey) => {
      if (stepKey === 'doc_verification') {
        const pending = (await tx.query(`select licence_type, verification from mdm.party_licences where party_id = $1 and status = 'Active' and verification <> 'Verified'`, [r.subject_id])).rows;
        if (pending.length) throw Errors.rule('LICENCES_NOT_VERIFIED', `Verify every licence before approving: ${pending.map((x) => `${x.licence_type} (${x.verification})`).join(', ')}.`);
      }
      if (stepKey === 'finance') {
        const bank = (await tx.query(`select verification from mdm.party_bank_accounts where party_id = $1 and status = 'Active'`, [r.subject_id])).rows[0];
        if (bank?.verification !== 'Verified') throw Errors.rule('BANK_NOT_VERIFIED', 'Verify the bank account against the cancelled cheque before approving.');
      }
    },
  });
  const r = Router();

  r.get('/', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const args: unknown[] = [];
    const where = ['true'];
    const q = str(req.query.q);
    if (q) { args.push(`%${q}%`); where.push(`(p.code ilike $${args.length} or p.legal_name ilike $${args.length} or p.trade_name ilike $${args.length} or p.gstin ilike $${args.length} or p.mobile like $${args.length})`); }
    const status = str(req.query.status);
    if (status) { args.push(status); where.push(`vp.status = $${args.length}`); }
    const item = str(req.query.itemId);
    if (item) { args.push(item); where.push(`exists (select 1 from mdm.vendor_items vi where vi.party_id = p.id and vi.item_id = $${args.length} and vi.status = 'Active')`); }
    const rows = await db.query(
      `select p.id, p.code, p.legal_name as "legalName", p.trade_name as "tradeName", p.gstin, p.mobile, vp.vendor_category as "vendorCategory", vp.status,
              vp.payment_terms_days as "paymentTermsDays", vp.msme_registered as "msmeRegistered", vp.rating, vp.licence_types as "licenceTypes",
              (select count(*)::int from mdm.vendor_items vi where vi.party_id = p.id and vi.status = 'Active') as "itemCount",
              (select verification from mdm.party_bank_accounts b where b.party_id = p.id and b.status = 'Active') as "bankVerification",
              (select min(valid_to) from mdm.party_licences l where l.party_id = p.id and l.status = 'Active') as "nextLicenceExpiry",
              count(*) over() as total
         from mdm.parties p join mdm.vendor_profiles vp on vp.party_id = p.id where ${where.join(' and ')} order by p.code desc limit ${limit} offset ${offset}`, args);
    res.json({ data: rows.rows.map(({ total: _t, ...x }) => x), total: Number(rows.rows[0]?.total ?? 0) });
  }));

  r.get('/duplicates', requirePermission(P('view')), asyncHandler(async (req, res) => {
    res.json({ data: await duplicates(db, { gstin: str(req.query.gstin)?.toUpperCase(), pan: str(req.query.pan)?.toUpperCase(), mobile: str(req.query.mobile) }, str(req.query.excludeId) ?? null) });
  }));

  r.get('/:id', requirePermission(P('view')), asyncHandler(async (req, res) => {
    const d = await loadVendor(db, req.params.id!);
    const parts = await partyDetailParts(db, d.party_id, 'mdm.vendor');
    const bankRow = (await db.query(
      `select b.id, b.account_holder as "accountHolder", b.bank_name as "bankName", b.branch, b.ifsc, b.account_no_enc, b.account_last4 as "accountLast4",
              b.document_id as "documentId", b.verification, b.remarks, b.verified_at as "verifiedAt", u.full_name as "verifiedBy", b.created_at as "createdAt"
         from mdm.party_bank_accounts b left join iam.users u on u.id = b.verified_by where b.party_id = $1 and b.status = 'Active'`, [d.party_id])).rows[0];
    // the full account number only for users cleared for sensitive vendor data (X26)
    const bank = bankRow ? (({ account_no_enc, ...b }) => ({ ...b, accountNumber: can(req, P('view_sensitive')) ? decrypt(account_no_enc, cfg.APP_ENCRYPTION_KEY) : null }))(bankRow) : null;
    const items = (await db.query(
      `select vi.id, vi.item_id as "itemId", i.code as "itemCode", i.name as "itemName", i.item_type as "itemType", i.base_uom as "uom",
              vi.vendor_item_code as "vendorItemCode", vi.lead_time_days as "leadTimeDays", vi.min_order_qty as "minOrderQty"
         from mdm.vendor_items vi join mdm.items i on i.id = vi.item_id where vi.party_id = $1 and vi.status = 'Active' order by i.code`, [d.party_id])).rows;
    const status = d.vendor_status as string;
    const actions: string[] = [];
    if (EDITABLE.includes(status) && can(req, P('edit_draft'))) actions.push('edit');
    if (EDITABLE.includes(status) && can(req, P('submit'))) actions.push('submit');
    if (status === 'Active' && can(req, P('suspend'))) actions.push('suspend');
    if (status === 'Suspended' && can(req, P('suspend'))) actions.push('reactivate');
    res.json({
      id: d.party_id, code: d.code, legalName: d.legal_name, tradeName: d.trade_name, constitution: d.constitution, pan: d.pan,
      gstRegistered: d.gst_registered, gstin: d.gstin, contactPerson: d.contact_person, mobile: d.mobile, phoneNumbers: d.phone_numbers, email: d.email,
      vendorCategory: d.vendor_category, licenceTypes: d.licence_types, msmeRegistered: d.msme_registered, udyamNumber: d.udyam_number,
      paymentTermsDays: d.payment_terms_days, rating: d.rating, status, statusReason: d.status_reason, activatedAt: d.activated_at, version: d.version, updatedAt: d.updated_at,
      ...parts, bank, items,
      readiness: EDITABLE.includes(status) ? await vendorReadiness(db, d.party_id) : null,
      allowedActions: actions,
      canEditDetails: EDITABLE.includes(status) && can(req, P('edit_draft')),
      canAddLicence: status !== 'Inactive' && can(req, P('edit_draft')),
      canVerify: LIVE.includes(status) && can(req, P('verify_documents')),
      canVerifyBank: LIVE.includes(status) && can(req, P('verify_bank')),
    });
  }));

  const values = (d: ReturnType<typeof vendorSchema.parse>) => ({
    party: [d.legalName, d.tradeName, d.constitution ?? null, d.pan ?? null, d.gstRegistered, d.gstRegistered ? d.gstin : null, d.contactPerson ?? null, d.mobile ?? null, d.email ?? null, d.phoneNumbers ?? null],
    profile: [d.vendorCategory, d.licenceTypes, d.msmeRegistered, d.msmeRegistered ? d.udyamNumber : null, d.paymentTermsDays],
  });
  const noDup = async (tx: Tx, d: { gstin?: string | null; pan?: string | null; mobile?: string | null }, id: string | null) => {
    const dups = (await duplicates(tx, d, id)).filter((x) => x.matches.includes('GSTIN') || x.matches.includes('PAN'));
    if (dups.length) {
      const x = dups[0]!;
      throw Errors.conflict('DUPLICATE_PARTY', x.role === 'dealer'
        ? `${x.code} (${x.legalName}) is already registered as a dealer with the same ${x.matches.join(' and ')}. A party that is both dealer and vendor is not supported yet.`
        : `A vendor with the same ${x.matches.join(' and ')} already exists: ${x.code}.`, dups);
    }
  };

  r.post('/', requirePermission(P('create')), asyncHandler(async (req, res) => {
    const d = parse(vendorSchema, req.body);
    const actor = actorOf(req);
    const out = await withTx(db, async (tx) => {
      await noDup(tx, d, null);
      const code = await nextMasterCode(tx, 'VENDOR_CODE');
      const v = values(d);
      const p = (await tx.query(
        `insert into mdm.parties (code, legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email, phone_numbers, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning id`, [code, ...v.party, actor.userId])).rows[0];
      await tx.query(
        `insert into mdm.vendor_profiles (party_id, vendor_category, licence_types, msme_registered, udyam_number, payment_terms_days, created_by, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$7)`, [p.id, ...v.profile, actor.userId]);
      await audit(tx, actor, { action: 'mdm.vendor.created', entityType: 'mdm.party', entityId: p.id, after: { code, ...d } });
      return { id: p.id, code };
    });
    res.status(201).json(out);
  }));

  r.put('/:id', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const d = parse(vendorSchema, req.body);
    const actor = actorOf(req);
    await withTx(db, async (tx) => {
      const before = await loadVendor(tx, req.params.id!, true);
      if (!EDITABLE.includes(before.vendor_status)) throw Errors.state(`A ${before.vendor_status} vendor cannot be edited.`);
      if (before.version !== Number(req.body?.version)) throw Errors.concurrent();
      await noDup(tx, d, before.party_id);
      const v = values(d);
      const p = (await tx.query(
        `update mdm.parties set legal_name=$2, trade_name=$3, constitution=$4, pan=$5, gst_registered=$6, gstin=$7, contact_person=$8, mobile=$9, email=$10, phone_numbers=$11, updated_by=$12
          where id = $1 returning legal_name, trade_name, constitution, pan, gst_registered, gstin, contact_person, mobile, email, phone_numbers`, [before.party_id, ...v.party, actor.userId])).rows[0];
      const vp = (await tx.query(
        `update mdm.vendor_profiles set vendor_category=$2, licence_types=$3, msme_registered=$4, udyam_number=$5, payment_terms_days=$6, updated_by=$7
          where party_id = $1 returning vendor_category, licence_types, msme_registered, udyam_number, payment_terms_days`, [before.party_id, ...v.profile, actor.userId])).rows[0];
      const df = diff(before, { ...before, ...p, ...vp });
      await audit(tx, actor, { action: 'mdm.vendor.updated', entityType: 'mdm.party', entityId: before.party_id, before: df.before, after: df.after });
    });
    res.json({ ok: true });
  }));

  partyChildRoutes(r, db, {
    noun: 'vendor', perm: P, editable: EDITABLE, licenceTypes: VENDOR_LICENCE_TYPES,
    licenceStatuses: [...EDITABLE, ...LIVE], verifyStatuses: LIVE,
    load: async (tx, _req, id) => { const d = await loadVendor(tx, id, true); return { party_id: d.party_id, status: d.vendor_status }; },
  });

  // ---- bank account: a new one replaces the old and must be verified again by finance (SoD: not by the person who entered it)
  r.post('/:id/bank-account', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const b = parse(bankAccountSchema, req.body);
    await withTx(db, async (tx) => {
      const d = await loadVendor(tx, req.params.id!, true);
      if (![...EDITABLE, ...LIVE].includes(d.vendor_status)) throw Errors.state(`The bank account of a ${d.vendor_status} vendor cannot be changed.`);
      await assertPartyDoc(tx, d.party_id, b.documentId, ['CANCELLED_CHEQUE'], 'vendor');
      await tx.query(`update mdm.party_bank_accounts set status = 'Superseded' where party_id = $1 and status = 'Active'`, [d.party_id]);
      await tx.query(
        `insert into mdm.party_bank_accounts (party_id, account_holder, bank_name, branch, ifsc, account_no_enc, account_last4, document_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.party_id, b.accountHolder, b.bankName, b.branch, b.ifsc, encrypt(b.accountNumber, cfg.APP_ENCRYPTION_KEY), b.accountNumber.slice(-4), b.documentId, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.vendor.bank_account_set', entityType: 'mdm.party', entityId: d.party_id,
        after: { bankName: b.bankName, ifsc: b.ifsc, accountLast4: b.accountNumber.slice(-4) } });
      await emit(tx, 'mdm.vendor', d.party_id, 'vendor.bank_changed', { code: d.code });
    });
    res.status(201).json({ ok: true });
  }));

  r.post('/:id/bank-account/verify', requirePermission(P('verify_bank')), asyncHandler(async (req, res) => {
    const v = parse(licenceVerifySchema, req.body);
    await withTx(db, async (tx) => {
      const d = await loadVendor(tx, req.params.id!, true);
      if (!LIVE.includes(d.vendor_status)) throw Errors.state('The bank account is verified after the vendor is submitted.');
      const b = (await tx.query(`select * from mdm.party_bank_accounts where party_id = $1 and status = 'Active' for update`, [d.party_id])).rows[0];
      if (!b) throw Errors.notFound('Bank account');
      if (b.created_by === req.auth!.user.id) throw Errors.sod('You entered this bank account; another person must verify it.');
      if (v.verification === 'Rejected' && !v.remarks) throw Errors.validation([{ field: 'remarks', message: 'Give the reason' }]);
      await tx.query(`update mdm.party_bank_accounts set verification = $2, remarks = $3, verified_by = $4, verified_at = now() where id = $1`, [b.id, v.verification, v.remarks || null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: `mdm.vendor.bank_${v.verification.toLowerCase()}`, entityType: 'mdm.party', entityId: d.party_id,
        after: { ifsc: b.ifsc, accountLast4: b.account_last4 }, reason: v.remarks || null });
    });
    res.json({ ok: true });
  }));

  // ---- items supplied (MDM-011)
  r.post('/:id/items', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const it = parse(vendorItemSchema, req.body);
    await withTx(db, async (tx) => {
      const d = await loadVendor(tx, req.params.id!, true);
      if (!EDITABLE.includes(d.vendor_status)) throw Errors.state('Approved items change only while the vendor is Draft or Rejected (a later change needs re-approval).');
      const item = (await tx.query(`select status, code from mdm.items where id = $1`, [it.itemId])).rows[0];
      if (!item || item.status !== 'Active') throw Errors.rule('REFERENCE_NOT_ACTIVE', 'Only approved items can be linked to a vendor.');
      await tx.query(
        `insert into mdm.vendor_items (party_id, item_id, vendor_item_code, lead_time_days, min_order_qty, created_by) values ($1,$2,$3,$4,$5,$6)
         on conflict (party_id, item_id) do update set vendor_item_code = excluded.vendor_item_code, lead_time_days = excluded.lead_time_days,
           min_order_qty = excluded.min_order_qty, status = 'Active'`,
        [d.party_id, it.itemId, it.vendorItemCode, it.leadTimeDays, it.minOrderQty ?? null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'mdm.vendor.item_set', entityType: 'mdm.party', entityId: d.party_id, after: { item: item.code, ...it } });
    });
    res.status(201).json({ ok: true });
  }));
  r.post('/:id/items/:vid/remove', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const d = await loadVendor(tx, req.params.id!, true);
      if (!EDITABLE.includes(d.vendor_status)) throw Errors.state('Approved items change only while the vendor is Draft or Rejected.');
      const x = await tx.query(`update mdm.vendor_items set status = 'Inactive' where id = $1 and party_id = $2 and status = 'Active'`, [req.params.vid, d.party_id]);
      if (!x.rowCount) throw Errors.notFound('Vendor item');
      await audit(tx, actorOf(req), { action: 'mdm.vendor.item_removed', entityType: 'mdm.party', entityId: d.party_id, after: { vendorItemId: req.params.vid } });
    });
    res.json({ ok: true });
  }));

  // ---- lifecycle
  r.post('/:id/submit', requirePermission(P('submit')), asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const out = await withTx(db, async (tx) => {
      const d = await loadVendor(tx, req.params.id!, true);
      if (!EDITABLE.includes(d.vendor_status)) throw Errors.state(`A ${d.vendor_status} vendor cannot be submitted.`);
      const ready = await vendorReadiness(tx, d.party_id);
      if (!ready.ready) throw Errors.rule('NOT_READY', 'Complete the onboarding checklist before submitting.', ready.checks.filter((c) => !c.ok));
      // rejected licences and bank details are checked again on every submission
      await tx.query(`update mdm.party_licences set verification = 'Pending', verified_by = null, verified_at = null where party_id = $1 and status = 'Active' and verification = 'Rejected'`, [d.party_id]);
      await setStatus(tx, d.party_id, 'Submitted', actor);
      return submitForApproval(tx, actor, {
        subjectType: 'mdm.vendor', subjectId: d.party_id, subjectLabel: `Vendor ${d.code} — ${d.legal_name}`, revision: d.version,
        facts: { vendorCategory: d.vendor_category, constitution: d.constitution, licenceTypes: d.licence_types, msme: d.msme_registered },
      });
    });
    res.json({ approvalRequestId: out.id, approvalDocNo: out.doc_no, status: out.status });
  }));

  const suspendLike = (from: string, to: string, action: string) => asyncHandler(async (req: Request, res) => {
    const { reason } = parse(reasonSchema, req.body);
    await withTx(db, async (tx) => {
      const d = await loadVendor(tx, req.params.id!, true);
      if (d.vendor_status !== from) throw Errors.state(`Only a ${from} vendor can be ${action}.`);
      await setStatus(tx, d.party_id, to, actorOf(req), reason);
    });
    res.json({ ok: true });
  });
  r.post('/:id/suspend', requirePermission(P('suspend')), suspendLike('Active', 'Suspended', 'suspended'));
  r.post('/:id/reactivate', requirePermission(P('suspend')), suspendLike('Suspended', 'Active', 'reactivated'));

  return r;
}
