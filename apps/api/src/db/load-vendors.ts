/**
 * Loads a vendor list (CSV with columns group, name, address, state, pin_code, mobile_number, mail_id, gstin — from the company's
 * "Vendor Data" workbook) as Draft vendors. Only what the list gives is filled in; everything else the KYC form needs (constitution,
 * contact person, city, district, bank account, licences, documents) is left empty for onboarding, and the onboarding checklist
 * keeps the vendor from being submitted until it is complete.
 *   - group "Packing Material Creditors" → vendor category PACKAGING; "Factory other creditors" → OTHER;
 *   - mobile: the first 10-digit mobile in the cell; the cell as written is kept in "phone numbers" when it holds more (landlines, several);
 *   - PIN: the PIN column, else a 6-digit PIN written at the end of the address;
 *   - GSTIN: when valid; PAN is read from it (characters 3–12) and the vendor is marked GST-registered;
 *   - placeholders such as N/A are empty; bank details written into an address are dropped from it (bank accounts are entered
 *     with a cancelled cheque and verified by finance).
 * Vendors already present with the same name or GSTIN are skipped. The list itself is company data and is not kept in the repository.
 *   pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-vendors.ts path/to/vendors.csv
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { allowTransition, type Actor, type Db } from './pool';
import { audit } from '../lib/audit';
import { nextMasterCode } from '../lib/numbering';
import { parseCsv } from '../modules/golive/imports';

export const GST_STATE: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05', haryana: '06', delhi: '07', rajasthan: '08',
  'uttar pradesh': '09', bihar: '10', sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17',
  assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21', chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24',
  'dadra and nagar haveli and daman and diu': '26', maharashtra: '27', karnataka: '29', goa: '30', lakshadweep: '31', kerala: '32', 'tamil nadu': '33',
  puducherry: '34', 'andaman and nicobar islands': '35', telangana: '36', 'andhra pradesh': '37', ladakh: '38',
};
const CATEGORY: Record<string, string> = { 'packing material creditors': 'PACKAGING', 'factory other creditors': 'OTHER' };
export const NA = /^(n\/?a|na|nil|none|-|—)$/i;
export const val = (v?: string) => (v && !NA.test(v.trim()) ? v.trim() : '');

export function parseVendorRow(r: Record<string, string>) {
  const notes: string[] = [];
  let address = val(r.address);
  const bank = address.search(/\b(bank|a\/c\s*no|ifsc)\b/i);
  if (bank >= 0) {
    // drop the whole comma-separated part where the bank details start ("…, XYZ BANK LTD, A/C NO …")
    const cut = address.lastIndexOf(',', bank);
    address = (cut >= 0 ? address.slice(0, cut) : '').replace(/[\s,]+$/, '');
    notes.push('bank details removed from the address');
  }
  const stateName = val(r.state).toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ');
  const stateCode = GST_STATE[stateName] ?? null;
  if (val(r.state) && !stateCode) notes.push(`state "${r.state}" not recognised`);
  let pincode = val(r.pin_code).replace(/\D/g, '');
  if (!pincode) { const m = /(?:^|[^0-9])([1-9][0-9]{5})(?![0-9])[\s.,]*$/.exec(address) ?? /(?:^|[^0-9])([1-9][0-9]{5})(?![0-9])/.exec(address.replace(/\b[6-9][0-9]{9}\b/g, '')); if (m) pincode = m[1]!; }
  if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) { notes.push(`PIN "${r.pin_code}" not valid`); pincode = ''; }
  const phones = val(r.mobile_number);
  const mobiles = (phones.replace(/(\d)\s+(?=\d)/g, '$1').match(/(?<![0-9])[6-9][0-9]{9}(?![0-9])/g) ?? []);
  const mobile = mobiles[0] ?? null;
  const phoneNumbers = phones && phones.replace(/\s/g, '') !== mobile ? phones : null;
  const emailRaw = val(r.mail_id).toLowerCase();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : null;
  if (emailRaw && !email) notes.push(`e-mail "${r.mail_id}" not valid`);
  const g = val(r.gstin).toUpperCase().replace(/\s/g, '');
  const gstin = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) ? g : null;
  if (g && !gstin) notes.push(`GSTIN "${r.gstin}" not valid`);
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) notes.push(`GSTIN state ${gstin.slice(0, 2)} differs from the address state ${stateCode}`);
  return { name: val(r.name).replace(/\s{2,}/g, ' '), category: CATEGORY[val(r.group).toLowerCase()] ?? 'OTHER', address: address || null, stateCode: stateCode ?? (gstin ? gstin.slice(0, 2) : null),
    pincode: pincode || null, mobile, phoneNumbers, email, gstin, pan: gstin ? gstin.slice(2, 12) : null, notes };
}

export async function loadVendors(db: Db, csvText: string, actor: Actor) {
  const rows = parseCsv(csvText).filter((r) => val(r.name)).map(parseVendorRow);
  const client = await db.connect();
  const out = { created: [] as { code: string; name: string; notes: string[] }[], skipped: [] as { name: string; reason: string }[] };
  try {
    await client.query('begin');
    await allowTransition(client);
    for (const v of rows) {
      const dup = (await client.query(`select code from mdm.parties where lower(legal_name) = lower($1) or ($2::text is not null and gstin = $2)`, [v.name, v.gstin])).rows[0];
      if (dup) { out.skipped.push({ name: v.name, reason: `already present as ${dup.code}` }); continue; }
      const code = await nextMasterCode(client, 'VENDOR_CODE');
      const p = (await client.query(`insert into mdm.parties (code, legal_name, pan, gst_registered, gstin, mobile, email, phone_numbers, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`, [code, v.name, v.pan, !!v.gstin, v.gstin, v.mobile, v.email, v.phoneNumbers, actor.userId])).rows[0].id;
      await client.query(`insert into mdm.vendor_profiles (party_id, vendor_category, created_by, updated_by) values ($1,$2,$3,$3)`, [p, v.category, actor.userId]);
      if (v.address || v.stateCode || v.pincode) {
        await client.query(`insert into mdm.party_addresses (party_id, kind, line1, state_code, pincode, is_default, created_by) values ($1,'REGISTERED',$2,$3,$4,true,$5)`,
          [p, v.address, v.stateCode, v.pincode, actor.userId]);
      }
      await audit(client, actor, { action: 'mdm.vendor.imported', entityType: 'mdm.party', entityId: p, after: { code, ...v } });
      out.created.push({ code, name: v.name, notes: v.notes });
    }
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv[2]) { console.error('Give the vendor CSV path'); process.exit(2); }
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  loadVendors(db, readFileSync(process.argv[2], 'utf8'), { userId: null, label: 'system:vendor-list' })
    .then((r) => { console.log(JSON.stringify(r, null, 1)); return db.end(); })
    .catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
}
