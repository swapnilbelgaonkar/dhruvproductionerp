/**
 * Loads a dealer list (CSV with columns sr_no, company, address, pincode, state, mobile_no, e_mail, gstin_uin, pan_no — from the
 * company's "Dealer Data" workbook) as Draft dealers. Only what the list gives is filled in; category, territory, sales owner,
 * constitution, contact person, city, district, licences and documents are left for onboarding, and the onboarding checklist keeps
 * the dealer from being submitted until they are complete.
 *   - mobile: the first 10-digit mobile in the cell; the cell as written is kept in "phone numbers" when it holds more;
 *   - PIN: the Pincode column, else a 6-digit PIN written at the end of the address;
 *   - GSTIN when valid (the dealer is then GST-registered); PAN from the PAN column, else read from the GSTIN;
 *     a PAN that does not match its GSTIN is kept and reported;
 *   - a GSTIN can belong to one party only: when two rows share one (two branches), the first keeps it and the other is reported;
 *   - placeholders such as N/A are empty. Dealers already present with the same name are skipped.
 *   pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-dealers.ts path/to/dealers.csv
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { allowTransition, type Actor, type Db } from './pool';
import { audit } from '../lib/audit';
import { nextMasterCode } from '../lib/numbering';
import { parseCsv } from '../modules/golive/imports';
import { GST_STATE, val } from './load-vendors';

export function parseDealerRow(r: Record<string, string>) {
  const notes: string[] = [];
  const address = val(r.address);
  const stateName = val(r.state).toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ');
  const g = val(r.gstin_uin).toUpperCase().replace(/\s/g, '');
  const gstin = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) ? g : null;
  if (g && !gstin) notes.push(`GSTIN "${r.gstin_uin}" not valid`);
  const stateCode = GST_STATE[stateName] ?? (gstin ? gstin.slice(0, 2) : null);
  if (val(r.state) && !GST_STATE[stateName]) notes.push(`state "${r.state}" not recognised`);
  let pincode = val(r.pincode).replace(/\D/g, '');
  if (!pincode) { const m = /(?:^|[^0-9])([1-9][0-9]{5})(?![0-9])[\s.,]*$/.exec(address); if (m) pincode = m[1]!; }
  if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) { notes.push(`PIN "${r.pincode}" not valid`); pincode = ''; }
  const phones = val(r.mobile_no);
  const mobile = (phones.replace(/(\d)\s+(?=\d)/g, '$1').match(/(?<![0-9])[6-9][0-9]{9}(?![0-9])/g) ?? [])[0] ?? null;
  const phoneNumbers = phones && phones.replace(/\s/g, '') !== mobile ? phones : null;
  const emailRaw = val(r.e_mail).toLowerCase();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : null;
  if (emailRaw && !email) notes.push(`e-mail "${r.e_mail}" not valid`);
  const p = val(r.pan_no).toUpperCase().replace(/\s/g, '');
  let pan = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) ? p : null;
  if (p && !pan) notes.push(`PAN "${r.pan_no}" not valid`);
  if (!pan && gstin) pan = gstin.slice(2, 12);
  if (pan && gstin && gstin.slice(2, 12) !== pan) notes.push(`PAN ${pan} is not the one in GSTIN ${gstin}`);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) notes.push(`GSTIN state ${gstin.slice(0, 2)} differs from the address state ${stateCode}`);
  return { name: val(r.company).replace(/\s{2,}/g, ' '), address: address || null, stateCode, pincode: pincode || null, mobile, phoneNumbers, email, gstin, pan, notes };
}

export async function loadDealers(db: Db, csvText: string, actor: Actor) {
  const rows = parseCsv(csvText).filter((r) => val(r.company)).map(parseDealerRow);
  const out = { created: [] as { code: string; name: string; notes: string[] }[], skipped: [] as { name: string; reason: string }[] };
  const client = await db.connect();
  try {
    await client.query('begin');
    await allowTransition(client);
    for (const v of rows) {
      const dup = (await client.query(`select code from mdm.parties where lower(legal_name) = lower($1)`, [v.name])).rows[0];
      if (dup) { out.skipped.push({ name: v.name, reason: `already present as ${dup.code}` }); continue; }
      let gstin = v.gstin;
      if (gstin) {
        const owner = (await client.query(`select code, legal_name from mdm.parties where gstin = $1`, [gstin])).rows[0];
        if (owner) { v.notes.push(`GSTIN ${gstin} already belongs to ${owner.code} ${owner.legal_name}; left empty here`); gstin = null; }
      }
      const code = await nextMasterCode(client, 'DEALER_CODE');
      const p = (await client.query(`insert into mdm.parties (code, legal_name, pan, gst_registered, gstin, mobile, email, phone_numbers, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`, [code, v.name, v.pan, !!gstin, gstin, v.mobile, v.email, v.phoneNumbers, actor.userId])).rows[0].id;
      await client.query(`insert into mdm.dealer_profiles (party_id, created_by, updated_by) values ($1,$2,$2)`, [p, actor.userId]);
      if (v.address || v.stateCode || v.pincode) {
        await client.query(`insert into mdm.party_addresses (party_id, kind, line1, state_code, pincode, is_default, created_by) values ($1,'REGISTERED',$2,$3,$4,true,$5)`,
          [p, v.address, v.stateCode, v.pincode, actor.userId]);
      }
      await audit(client, actor, { action: 'mdm.dealer.imported', entityType: 'mdm.party', entityId: p, after: { code, ...v, gstin } });
      out.created.push({ code, name: v.name, notes: v.notes });
    }
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv[2]) { console.error('Give the dealer CSV path'); process.exit(2); }
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  loadDealers(db, readFileSync(process.argv[2], 'utf8'), { userId: null, label: 'system:dealer-list' })
    .then((r) => { console.log(JSON.stringify(r, null, 1)); return db.end(); })
    .catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
}
