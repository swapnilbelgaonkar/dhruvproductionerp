import type { Request, Router } from 'express';
import { addressSchema, licenceSchema, licenceVerifySchema, signatorySchema } from '@dhruv/contracts';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { requirePermission } from '../../middleware/auth';
import { actorOf } from '../../middleware/context';

/**
 * Pieces shared by every party role (dealer, vendor; transporter later): duplicate check, onboarding checks,
 * the detail sub-records, and the child-record endpoints for addresses, licences and signatories.
 */
export type Check = { key: string; label: string; ok: boolean; detail?: string };
export type AddCheck = (key: string, label: string, ok: boolean, detail?: string) => void;
export const checklist = () => {
  const checks: Check[] = [];
  const add: AddCheck = (key, label, ok, detail) => { checks.push({ key, label, ok, detail }); };
  return { checks, add };
};

export const LICENCE_DOC: Record<string, string> = {
  FERTILIZER: 'FERTILIZER_LICENCE', PESTICIDE: 'PESTICIDE_LICENCE', BIOSTIMULANT: 'BIOSTIMULANT_REGISTRATION',
  CIB_REGISTRATION: 'CIB_REGISTRATION', MANUFACTURING: 'FACTORY_LICENCE',
};
const LICENCE_NAME: Record<string, string> = {
  FERTILIZER: 'Fertilizer licence', PESTICIDE: 'Pesticide licence', BIOSTIMULANT: 'Bio-stimulant registration',
  CIB_REGISTRATION: 'CIB&RC registration', MANUFACTURING: 'Factory manufacturing licence',
};

/** Other parties with the same GSTIN, PAN or mobile (a rejected onboarding does not count). */
export async function duplicates(dbx: Db | Tx, d: { gstin?: string | null; pan?: string | null; mobile?: string | null }, excludeId: string | null) {
  const r = await dbx.query(
    `select p.id, p.code, p.legal_name as "legalName", p.gstin, p.pan, p.mobile, coalesce(dp.status, vp.status) as status,
            case when dp.party_id is not null then 'dealer' when vp.party_id is not null then 'vendor' end as role
       from mdm.parties p left join mdm.dealer_profiles dp on dp.party_id = p.id left join mdm.vendor_profiles vp on vp.party_id = p.id
      where p.id <> coalesce($4::uuid, '00000000-0000-0000-0000-000000000000') and (($1::text is not null and p.gstin = $1) or p.pan = $2 or p.mobile = $3)
        and coalesce(dp.status, vp.status, 'Active') <> 'Rejected'`, [d.gstin ?? null, d.pan ?? null, d.mobile ?? null, excludeId]);
  return r.rows.map((x) => ({ ...x, matches: [x.gstin && x.gstin === d.gstin && 'GSTIN', !!x.pan && x.pan === d.pan && 'PAN', !!x.mobile && x.mobile === d.mobile && 'mobile'].filter(Boolean) as string[] }));
}

/** Addresses, GSTIN state and duplicates — common to every party role. */
export async function identityChecks(dbx: Db | Tx, p: { id: string; gst_registered: boolean; gstin: string | null; pan: string; mobile: string }, add: AddCheck,
  opts: { billing: boolean; shipping: boolean; noun: string }) {
  const addr = (await dbx.query(`select kind, state_code from mdm.party_addresses where party_id = $1 and status = 'Active'`, [p.id])).rows;
  const reg = addr.find((a) => a.kind === 'REGISTERED');
  add('addr.registered', 'Registered address', !!reg);
  if (opts.billing) add('addr.billing', 'Billing address', addr.some((a) => a.kind === 'BILLING'));
  if (opts.shipping) add('addr.shipping', 'At least one shipping address', addr.some((a) => a.kind === 'SHIPPING'));
  if (p.gst_registered) {
    add('gst.state', 'GSTIN state matches the registered address', !!reg && !!p.gstin && p.gstin.slice(0, 2) === reg.state_code,
      reg && p.gstin && p.gstin.slice(0, 2) !== reg.state_code ? `GSTIN state ${p.gstin.slice(0, 2)}, address state ${reg.state_code}` : undefined);
  }
  const dups = (await duplicates(dbx, p, p.id)).filter((d) => d.matches.includes('GSTIN') || d.matches.includes('PAN'));
  add('dup', `No other ${opts.noun} with the same GSTIN or PAN`, dups.length === 0, dups.length ? dups.map((d) => `${d.code} (${d.matches.join(', ')})`).join('; ') : undefined);
}

/** Statuses a dealer or vendor may have and still be traded with: Active, plus Draft/Submitted while parties.allowPendingKyc is on. */
export async function usableStatuses(dbx: Db | Tx): Promise<string[]> {
  const r = (await dbx.query(`select value from sys.settings where key = 'parties.allowPendingKyc'`)).rows[0];
  return r?.value === true ? ['Active', 'Draft', 'Submitted'] : ['Active'];
}

/** Fields an imported Draft may lack: identity details and a complete registered address (enforced on submission). */
export async function kycDetailChecks(dbx: Db | Tx, p: { id: string; constitution: string | null; pan: string | null; contact_person: string | null; mobile: string | null }, add: AddCheck) {
  const missing = [!p.constitution && 'constitution', !p.pan && 'PAN', !p.contact_person && 'contact person', !p.mobile && 'mobile number'].filter(Boolean);
  add('kyc.details', 'Constitution, PAN, contact person and mobile', !missing.length, missing.length ? `Missing: ${missing.join(', ')}` : undefined);
  const reg = (await dbx.query(`select line1, city, district, state_code, pincode from mdm.party_addresses where party_id = $1 and kind = 'REGISTERED' and status = 'Active' limit 1`, [p.id])).rows[0];
  const gaps = reg ? [!reg.line1 && 'address line', !reg.city && 'city', !reg.district && 'district', !reg.state_code && 'state', !reg.pincode && 'PIN code'].filter(Boolean) : [];
  if (reg) add('addr.complete', 'Registered address complete', !gaps.length, gaps.length ? `Missing: ${gaps.join(', ')}` : undefined);
}

/** Each needed licence present with its certificate, not expired and not rejected. */
export async function licenceChecks(dbx: Db | Tx, partyId: string, types: string[], add: AddCheck) {
  const lic = (await dbx.query(`select licence_type, valid_to, verification from mdm.party_licences where party_id = $1 and status = 'Active'`, [partyId])).rows;
  const today = new Date().toISOString().slice(0, 10);
  for (const t of types) {
    const l = lic.find((x) => x.licence_type === t);
    const validTo = l ? String(l.valid_to).slice(0, 10) : null;
    add(`licence.${t}`, `${LICENCE_NAME[t] ?? t} with certificate, not expired`, !!l && validTo! >= today && l.verification !== 'Rejected',
      !l ? 'Missing' : validTo! < today ? `Expired on ${validTo}` : l.verification === 'Rejected' ? 'Rejected by verifier — replace it' : undefined);
  }
}

/** Configurable KYC documents (D07): the active rule set per party role; the strictest applicable rule per requirement wins. */
export async function kycChecks(dbx: Db | Tx, role: 'DEALER' | 'VENDOR', policy: string, p: { id: string; constitution: string; gst_registered: boolean; credit_limit?: unknown }, add: AddCheck) {
  const reqs = (await dbx.query(
    `select requirement, min_count, condition, threshold, note from mdm.kyc_requirements
      where party_role = $3 and policy in ('BOTH', $1) and constitution in ('*', $2) order by requirement`, [policy, p.constitution, role])).rows;
  const docCounts = new Map((await dbx.query(
    `select document_type, count(*)::int as n from sys.documents where entity_type = 'mdm.party' and entity_id = $1 and status = 'Active' group by document_type`, [p.id])).rows
    .map((r) => [r.document_type, r.n]));
  const signatories = Number((await dbx.query(`select count(*) from mdm.party_signatories where party_id = $1 and status = 'Active'`, [p.id])).rows[0].count);
  const need = new Map<string, { n: number; note: string }>();
  for (const r of reqs) {
    const applies = r.condition === 'ALWAYS' || (r.condition === 'GST_REGISTERED' && p.gst_registered) || (r.condition === 'CREDIT_ABOVE' && Number(p.credit_limit ?? 0) > Number(r.threshold ?? 0));
    if (applies && (need.get(r.requirement)?.n ?? 0) < r.min_count) need.set(r.requirement, { n: r.min_count, note: r.note });
  }
  for (const [reqt, { n, note }] of need) {
    const have = reqt === 'SIGNATORY' ? signatories : docCounts.get(reqt) ?? 0;
    add(`kyc.${reqt}`, note, have >= n, have < n ? `${have} of ${n} uploaded` : undefined);
  }
}

/** Sub-records shown on every party detail page. */
export async function partyDetailParts(db: Db, partyId: string, subjectType: string) {
  const [addresses, licences, signatories, approvals] = await Promise.all([
    db.query(`select id, kind, label, line1, line2, city, district, state_code as "stateCode", pincode, is_default as "isDefault", status
                from mdm.party_addresses where party_id = $1 and status = 'Active' order by kind, created_at`, [partyId]),
    db.query(`select l.id, l.licence_type as "licenceType", l.number, l.issuer, l.valid_from as "validFrom", l.valid_to as "validTo", l.verification,
                     l.remarks, l.verified_at as "verifiedAt", v.full_name as "verifiedBy", l.document_id as "documentId", l.status
                from mdm.party_licences l left join iam.users v on v.id = l.verified_by where l.party_id = $1 order by l.status, l.licence_type, l.created_at desc`, [partyId]),
    db.query(`select id, full_name as "fullName", designation, id_type as "idType", id_last4 as "idLast4", document_id as "documentId"
                from mdm.party_signatories where party_id = $1 and status = 'Active' order by created_at`, [partyId]),
    db.query(`select a.id, a.doc_no, a.status, a.submitted_at, u.full_name as initiator from wf.approval_requests a join iam.users u on u.id = a.initiated_by
               where a.subject_type = $2 and a.subject_id = $1 order by a.submitted_at desc`, [partyId, subjectType]),
  ]);
  return { addresses: addresses.rows, licences: licences.rows, signatories: signatories.rows, approvals: approvals.rows };
}

export async function assertPartyDoc(tx: Tx, partyId: string, documentId: string, types: string[], noun: string) {
  const doc = (await tx.query(`select document_type, entity_type, entity_id, status from sys.documents where id = $1`, [documentId])).rows[0];
  if (!doc || doc.entity_type !== 'mdm.party' || doc.entity_id !== partyId || doc.status !== 'Active') throw Errors.rule('DOCUMENT_INVALID', `Upload the supporting document to this ${noun} first.`);
  if (!types.includes(doc.document_type)) throw Errors.rule('DOCUMENT_INVALID', `The supporting document must be of type ${types.join(' or ')}.`);
}

export interface PartyRoleConfig {
  /** audit action prefix and wording, e.g. dealer */
  noun: 'dealer' | 'vendor';
  perm: (action: string) => string;
  /** loads the party in the caller's scope and locks the role profile */
  load: (tx: Tx, req: Request, id: string, perm: string) => Promise<{ party_id: string; status: string }>;
  editable: string[];
  /** statuses in which a licence may still be added or renewed, and verified */
  licenceStatuses: string[];
  verifyStatuses: string[];
  licenceTypes: readonly string[];
}

/** Addresses, licences (with independent verification) and signatories of a party, mounted on the role's router. */
export function partyChildRoutes(r: Router, db: Db, c: PartyRoleConfig) {
  const P = c.perm;
  const guard = async (tx: Tx, req: Request, perm: string, statuses = c.editable) => {
    const d = await c.load(tx, req, req.params.id!, perm);
    if (!statuses.includes(d.status)) throw Errors.state(`Details of a ${d.status} ${c.noun} cannot be changed here.`);
    return d;
  };
  const act = (what: string) => `mdm.${c.noun}.${what}`;

  r.post('/:id/addresses', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const a = parse(addressSchema, req.body);
    const id = await withTx(db, async (tx) => {
      const d = await guard(tx, req, P('edit_draft'));
      if (a.kind !== 'SHIPPING') await tx.query(`update mdm.party_addresses set status = 'Inactive' where party_id = $1 and kind = $2 and status = 'Active'`, [d.party_id, a.kind]);
      const ins = await tx.query(
        `insert into mdm.party_addresses (party_id, kind, label, line1, line2, city, district, state_code, pincode, is_default, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [d.party_id, a.kind, a.label, a.line1, a.line2, a.city, a.district, a.stateCode, a.pincode, a.isDefault, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: act('address_added'), entityType: 'mdm.party', entityId: d.party_id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.post('/:id/addresses/:aid/remove', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const d = await guard(tx, req, P('edit_draft'));
      const x = await tx.query(`update mdm.party_addresses set status = 'Inactive' where id = $1 and party_id = $2 and status = 'Active' returning kind`, [req.params.aid, d.party_id]);
      if (!x.rowCount) throw Errors.notFound('Address');
      await audit(tx, actorOf(req), { action: act('address_removed'), entityType: 'mdm.party', entityId: d.party_id, after: { addressId: req.params.aid } });
    });
    res.json({ ok: true });
  }));

  // A new licence of the same type supersedes the old one (renewal). It needs verification again before it counts.
  r.post('/:id/licences', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const l = parse(licenceSchema, req.body);
    if (!c.licenceTypes.includes(l.licenceType)) throw Errors.validation([{ field: 'licenceType', message: `Not a ${c.noun} licence type` }]);
    const id = await withTx(db, async (tx) => {
      const d = await guard(tx, req, P('edit_draft'), c.licenceStatuses);
      await assertPartyDoc(tx, d.party_id, l.documentId, [LICENCE_DOC[l.licenceType]!], c.noun);
      await tx.query(`update mdm.party_licences set status = 'Superseded' where party_id = $1 and licence_type = $2 and status = 'Active'`, [d.party_id, l.licenceType]);
      const ins = await tx.query(
        `insert into mdm.party_licences (party_id, licence_type, number, issuer, valid_from, valid_to, document_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [d.party_id, l.licenceType, l.number, l.issuer, l.validFrom, l.validTo, l.documentId, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: act('licence_added'), entityType: 'mdm.party', entityId: d.party_id, after: ins.rows[0] });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));

  r.post('/:id/licences/:lid/verify', requirePermission(P('verify_documents')), asyncHandler(async (req, res) => {
    const v = parse(licenceVerifySchema, req.body);
    await withTx(db, async (tx) => {
      const d = await c.load(tx, req, req.params.id!, P('verify_documents'));
      if (!c.verifyStatuses.includes(d.status)) throw Errors.state(`Licences are verified after the ${c.noun} is submitted.`);
      const l = (await tx.query(`select * from mdm.party_licences where id = $1 and party_id = $2 and status = 'Active' for update`, [req.params.lid, d.party_id])).rows[0];
      if (!l) throw Errors.notFound('Licence');
      if (l.created_by === req.auth!.user.id) throw Errors.sod('You entered this licence; another person must verify it.');
      await tx.query(`update mdm.party_licences set verification = $2, remarks = $3, verified_by = $4, verified_at = now() where id = $1`,
        [l.id, v.verification, v.remarks || null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: act(`licence_${v.verification.toLowerCase()}`), entityType: 'mdm.party', entityId: d.party_id,
        after: { licenceId: l.id, type: l.licence_type, number: l.number }, reason: v.remarks || null });
    });
    res.json({ ok: true });
  }));

  r.post('/:id/signatories', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    const s = parse(signatorySchema, req.body);
    const id = await withTx(db, async (tx) => {
      const d = await guard(tx, req, P('edit_draft'));
      await assertPartyDoc(tx, d.party_id, s.documentId, ['SIGNATORY_ID', 'PAN_CARD'], c.noun);
      const ins = await tx.query(
        `insert into mdm.party_signatories (party_id, full_name, designation, id_type, id_last4, document_id, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [d.party_id, s.fullName, s.designation, s.idType, s.idLast4, s.documentId, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: act('signatory_added'), entityType: 'mdm.party', entityId: d.party_id, after: { fullName: s.fullName, designation: s.designation, idType: s.idType } });
      return ins.rows[0].id;
    });
    res.status(201).json({ id });
  }));
  r.post('/:id/signatories/:sid/remove', requirePermission(P('edit_draft')), asyncHandler(async (req, res) => {
    await withTx(db, async (tx) => {
      const d = await guard(tx, req, P('edit_draft'));
      const x = await tx.query(`update mdm.party_signatories set status = 'Inactive' where id = $1 and party_id = $2 and status = 'Active'`, [req.params.sid, d.party_id]);
      if (!x.rowCount) throw Errors.notFound('Signatory');
      await audit(tx, actorOf(req), { action: act('signatory_removed'), entityType: 'mdm.party', entityId: d.party_id, after: { signatoryId: req.params.sid } });
    });
    res.json({ ok: true });
  }));
}
