/**
 * Loads the company staff list (CSV: team, emp_code, sr, employee_name, headquarters, district, area, reporting_to, designation,
 * mobile_number, educational_details, date_of_joining, email, id_card, blood_group — converted from "Employee details") into
 * org.employees. No sign-in is created: logins are made separately, when the company asks.
 *   - team: the section heading the person is listed under (e.g. "Nagpur A", "FACTORY");
 *   - employee code without spaces ("DAPL EMP18" → DAPLEMP18); the ID card value is kept as written;
 *   - reporting line: "Reporting To" is kept as written; the manager is linked when its first name in the cell matches exactly one
 *     employee (ignoring case, extra spaces and "Sir"). A cell naming someone not on the list leaves the manager empty;
 *   - sales tier only where the designation states it plainly (ZSM, ASM, Sr. ASM → SASM, Territory Sales Manager → TSM, Sales Executive → SE);
 *     other designations keep the tier empty for the company to decide;
 *   - mobile: the first 10-digit mobile; the cell as written is kept in "phone numbers" when it holds more;
 *   - date of joining as a date when it is one (also dd.mm.yyyy / dd-mm-yyyy), else kept as text; blood group as A+ … O−;
 *   - placeholders "-" and N/A are empty. Employees whose code is already present are skipped.
 *   pnpm --filter @dhruv/api exec tsx --env-file=.env src/db/load-employees.ts path/to/employees.csv
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Actor, Db } from './pool';
import { audit } from '../lib/audit';
import { parseCsv } from '../modules/golive/imports';
import { val } from './load-vendors';

const TIER: Record<string, string> = { zsm: 'ZSM', asm: 'ASM', 'sr. asm': 'SASM', 'sr asm': 'SASM', 'sr. area sales manager': 'SASM', 'territory sales manager': 'TSM', 'se (sales executive)': 'SE', 'sales executive': 'SE' };
const norm = (s: string) => s.toLowerCase().replace(/\bsir\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseEmployeeRow(r: Record<string, string>) {
  const notes: string[] = [];
  const code = val(r.emp_code).toUpperCase().replace(/\s+/g, '');
  const phones = val(r.mobile_number);
  const mobile = (phones.replace(/(\d)\s+(?=\d)/g, '$1').match(/(?<![0-9])[6-9][0-9]{9}(?![0-9])/g) ?? [])[0] ?? null;
  const phoneNumbers = phones && phones.replace(/\s/g, '') !== mobile ? phones : null;
  const emailRaw = val(r.email).toLowerCase();
  const emails = emailRaw.split(/[\s/,;]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  const email = emails[0] ?? null;                     // the first valid address; a cell with two keeps the first
  if (emailRaw && !email) notes.push(`e-mail "${r.email}" not valid — left empty`);
  if (emails.length > 1) notes.push(`more than one e-mail given; kept ${email}`);
  const d = val(r.date_of_joining);
  let doj: string | null = null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d); const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(d);
  if (iso) doj = d; else if (dmy) doj = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  if (doj && Number.isNaN(Date.parse(`${doj}T00:00:00Z`))) doj = null;
  const bg = val(r.blood_group).toUpperCase().replace(/\s/g, '').replace(/VE$/, '');
  const bloodGroup = /^(A|B|AB|O)[+-]$/.test(bg) ? bg : null;
  if (bg && !bloodGroup) notes.push(`blood group "${r.blood_group}" not understood`);
  const idCard = val(r.id_card);
  if (idCard && idCard.toUpperCase().replace(/\s+/g, '') !== code) notes.push(`ID card shows ${idCard}`);
  const designation = val(r.designation);
  return { code, name: val(r.employee_name).replace(/\s{2,}/g, ' '), team: val(r.team) || null, serialNo: Number(r.sr) || null, headquarters: val(r.headquarters) || null,
    district: val(r.district) || null, area: val(r.area) || null, reportingTo: val(r.reporting_to) || null, designation: designation || null,
    salesTier: TIER[designation.toLowerCase()] ?? null, mobile, phoneNumbers, email, education: val(r.educational_details) || null,
    dateOfJoining: doj, dateOfJoiningText: d && !doj ? d : null, idCardNo: idCard || null, bloodGroup, notes };
}

/**
 * Links employees to the manager named in "Reporting To" (first name in the cell): an exact match of the full name, else the one
 * employee with the same first and last name ("Vaibhav Pund" → "Vaibhav Vijay Pund"). Anything else stays for a person to set.
 */
export async function linkManagers(client: pg.PoolClient) {
  const all = (await client.query(`select id, emp_code, full_name, manager_id, reporting_to from org.employees where status = 'Active'`)).rows as
    { id: string; emp_code: string; full_name: string; manager_id: string | null; reporting_to: string | null }[];
  const words = (s: string) => norm(s).split(' ').filter(Boolean);
  const out = { linked: 0, unresolved: [] as { code: string; reportingTo: string }[] };
  for (const e of all.filter((x) => x.reporting_to && !x.manager_id)) {
    const want = words(e.reporting_to!.split(/\/|,|\band\b/i)[0] ?? '');
    if (!want.length) continue;
    let hits = all.filter((x) => x.id !== e.id && words(x.full_name).join(' ') === want.join(' '));
    if (!hits.length && want.length >= 2) hits = all.filter((x) => { const w = words(x.full_name); return x.id !== e.id && w[0] === want[0] && w[w.length - 1] === want[want.length - 1]; });
    if (hits.length === 1) { await client.query(`update org.employees set manager_id = $2 where id = $1`, [e.id, hits[0]!.id]); out.linked++; }
    else out.unresolved.push({ code: e.emp_code, reportingTo: e.reporting_to! });
  }
  return out;
}

export async function loadEmployees(db: Db, csvText: string, actor: Actor) {
  const rows = parseCsv(csvText).filter((r) => val(r.employee_name) && val(r.emp_code)).map(parseEmployeeRow);
  const out = { created: [] as { code: string; notes: string[] }[], skipped: [] as { code: string; reason: string }[], managers: { linked: 0, unresolved: [] as { code: string; reportingTo: string }[] } };
  const client = await db.connect();
  try {
    await client.query('begin');
    for (const e of rows) {
      if ((await client.query(`select 1 from org.employees where emp_code = $1`, [e.code])).rowCount) { out.skipped.push({ code: e.code, reason: 'code already present' }); continue; }
      const id = (await client.query(`insert into org.employees (emp_code, full_name, email, mobile, designation, sales_tier, serial_no, team, headquarters, district, area, reporting_to,
          phone_numbers, education, date_of_joining, date_of_joining_text, id_card_no, blood_group, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19) returning id`,
        [e.code, e.name, e.email, e.mobile, e.designation, e.salesTier, e.serialNo, e.team, e.headquarters, e.district, e.area, e.reportingTo,
          e.phoneNumbers, e.education, e.dateOfJoining, e.dateOfJoiningText, e.idCardNo, e.bloodGroup, actor.userId])).rows[0].id as string;
      void id;
      out.created.push({ code: e.code, notes: e.notes });
    }
    // reporting lines, once everyone is in (also for anyone loaded earlier whose manager is still open)
    const link = await linkManagers(client);
    out.managers = link;
    await audit(client, actor, { action: 'org.employees.imported', entityType: 'org.employee', after: { created: out.created.length, managersLinked: out.managers.linked }, reason: 'Company staff list' });
    await client.query('commit');
  } catch (err) { await client.query('rollback'); throw err; } finally { client.release(); }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv[2]) { console.error('Give the employee CSV path'); process.exit(2); }
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  loadEmployees(db, readFileSync(process.argv[2], 'utf8'), { userId: null, label: 'system:staff-list' })
    .then((r) => { console.log(JSON.stringify(r, null, 1)); return db.end(); })
    .catch(async (e) => { console.error(e); await db.end(); process.exit(1); });
}
