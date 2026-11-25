import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse, str } from '../../lib/http';
import { financialYear, nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, legalEntityScope } from '../../middleware/context';
import { todayIST } from '../sales/quotations';

/**
 * TDS on payments to vendors and transporters (FIN-010). Sections, rates and thresholds are master data set by finance (fin.tds_sections),
 * never constants in code. The deduction is worked out when a payment is drafted:
 *  - section: the payee's default section (vendor profile / transporter);
 *  - rate: lower-deduction certificate if valid, else individual / other by the PAN's fourth letter, else the no-PAN rate (s.206AA);
 *    a transporter with the s.194C(6) declaration and a PAN suffers none;
 *  - base: the bill value before GST (GST shown separately is not part of the base);
 *  - thresholds: nothing below the single-payment threshold while the year's total stays under the annual one; for EXCESS sections (194Q)
 *    only the part above the annual threshold is taxed.
 * Deposits are recorded by challan; the quarterly 26Q file lists every deduction with its challan.
 */
const r2 = (n: number) => Math.round(n * 100) / 100;
export interface TdsResult { section: string | null; rate: number; base: number; amount: number; basis: 'AUTO' | 'NONE'; reason: string }

export async function computeTds(tx: Db | Tx, p: { payeeType: 'VENDOR' | 'TRANSPORTER'; payeeId: string; date: string; lines: { docId: string; amount: number }[]; excludePaymentId?: string }): Promise<TdsResult> {
  const payee = p.payeeType === 'VENDOR'
    ? (await tx.query(`select pt.pan, vp.tds_section as section, vp.tds_ldc_rate as ldc, vp.tds_ldc_valid_to as ldc_to, false as exempt from mdm.parties pt
        left join mdm.vendor_profiles vp on vp.party_id = pt.id where pt.id = $1`, [p.payeeId])).rows[0]
    : (await tx.query(`select pan, tds_section as section, null::numeric as ldc, null::date as ldc_to, tds_exempt_declaration as exempt from logistics.transporters where id = $1`, [p.payeeId])).rows[0];
  const none = (reason: string): TdsResult => ({ section: payee?.section ?? null, rate: 0, base: 0, amount: 0, basis: 'NONE', reason });
  if (!payee?.section) return none('No TDS section is set for this payee.');
  const s = (await tx.query(`select * from fin.tds_sections where code = $1`, [payee.section])).rows[0];
  if (s?.status !== 'Active') return none(`Section ${payee.section} is not active in the TDS master — finance has to enter its rates first.`);
  const pan = payee.pan && /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(payee.pan) ? String(payee.pan) : null;
  if (p.payeeType === 'TRANSPORTER' && payee.exempt && pan) return none('Transporter declared under s.194C(6) (ten or fewer goods carriages) with PAN: no deduction.');

  // base = the pre-GST share of each amount paid
  let base = 0;
  for (const l of p.lines) {
    const b = (await tx.query(`select taxable_total, grand_total from purchase.supplier_invoices where id = $1
        union all select taxable_total, grand_total from logistics.freight_bills where id = $1`, [l.docId])).rows[0];
    if (!b) continue;
    base += Number(b.grand_total) > 0 ? l.amount * Number(b.taxable_total) / Number(b.grand_total) : l.amount;
  }
  base = r2(base);
  const fy = financialYear(new Date(`${p.date}T00:00:00Z`));
  const fyStart = `${fy.slice(0, 4)}-04-01`;
  const before = Number((await tx.query(`select coalesce(sum(coalesce(tds_base, amount)), 0) as s from fin.payments where ${p.payeeType === 'VENDOR' ? 'party_id' : 'transporter_id'} = $1
      and tds_section is not distinct from $2 and status in ('Submitted','Approved','Paid') and payment_date between $3 and $4 and id is distinct from $5`,
    [p.payeeId, s.code, fyStart, p.date, p.excludePaymentId ?? null])).rows[0].s);
  const yearBefore = before;
  const after = yearBefore + base;
  const single = s.threshold_single == null ? null : Number(s.threshold_single);
  const annual = s.threshold_annual == null ? null : Number(s.threshold_annual);
  let taxable = base;
  if (s.deduct_on === 'EXCESS') {
    if (annual == null) return none(`Section ${s.code} deducts on the excess over the annual threshold, but no threshold is set.`);
    taxable = r2(Math.max(0, after - annual) - Math.max(0, yearBefore - annual));
    if (taxable <= 0) return { ...none(`Purchases this year (₹${r2(after).toLocaleString('en-IN')}) are within the ₹${annual.toLocaleString('en-IN')} threshold of ${s.code}.`), section: s.code };
  } else if ((single == null || base <= single) && (annual == null || after <= annual) && (single != null || annual != null)) {
    return { ...none(`Below the ${s.code} thresholds (this payment ₹${base.toLocaleString('en-IN')}${single != null ? ` ≤ ₹${single.toLocaleString('en-IN')}` : ''}; year ₹${r2(after).toLocaleString('en-IN')}${annual != null ? ` ≤ ₹${annual.toLocaleString('en-IN')}` : ''}).`), section: s.code };
  }
  let rate: number; let why: string;
  if (!pan) { rate = Number(s.rate_no_pan); why = 'no valid PAN (s.206AA)'; }
  else if (payee.ldc != null && payee.ldc_to && new Date(payee.ldc_to).toISOString().slice(0, 10) >= p.date) { rate = Number(payee.ldc); why = 'lower-deduction certificate'; }
  else if ('PH'.includes(pan[3]!)) { rate = Number(s.rate_individual); why = pan[3] === 'P' ? 'individual' : 'HUF'; }
  else { rate = Number(s.rate_other); why = 'company / firm'; }
  const amount = Math.round(taxable * rate / 100);        // s.288B: rounded to the rupee
  return { section: s.code, rate, base: r2(taxable), amount, basis: 'AUTO', reason: `${s.code} at ${rate}% (${why}) on ₹${r2(taxable).toLocaleString('en-IN')}` };
}

/** Due date for depositing TDS deducted in a month: the 7th of the next month, and 30 April for March. */
export const tdsDueDate = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  if (m === 3) return `${y}-04-30`;
  const n = new Date(Date.UTC(y, m, 7));
  return n.toISOString().slice(0, 10);
};

export function tdsRoutes(db: Db) {
  const r = Router();
  const V = 'finance.tds:view';
  const leOk = (req: Request, perm: string, le: string) => { const s = legalEntityScope(req, perm); return !s || s.includes(le); };

  r.get('/sections', requirePermission(V), asyncHandler(async (_req, res) => {
    res.json({ data: (await db.query(`select code, name, rate_individual as "rateIndividual", rate_other as "rateOther", rate_no_pan as "rateNoPan", threshold_single as "thresholdSingle",
        threshold_annual as "thresholdAnnual", deduct_on as "deductOn", status, remarks, updated_at as "updatedAt" from fin.tds_sections order by code`)).rows });
  }));

  r.put('/sections/:code', requirePermission('finance.tds:configure'), asyncHandler(async (req, res) => {
    const pct = z.number().min(0).max(50).nullable();
    const d = parse(z.object({ name: z.string().trim().min(3).max(120), rateIndividual: pct, rateOther: pct, rateNoPan: pct, thresholdSingle: z.number().min(0).nullable(),
      thresholdAnnual: z.number().min(0).nullable(), deductOn: z.enum(['BASE', 'EXCESS']), status: z.enum(['Draft', 'Active', 'Inactive']), remarks: z.string().trim().max(300).optional().nullable() })
      .refine((x) => x.status !== 'Active' || (x.rateIndividual != null && x.rateOther != null && x.rateNoPan != null), { message: 'An active section needs all three rates', path: ['status'] })
      .refine((x) => x.deductOn !== 'EXCESS' || x.thresholdAnnual != null, { message: 'Give the annual threshold', path: ['thresholdAnnual'] }), req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query(`select * from fin.tds_sections where code = $1 for update`, [req.params.code])).rows[0];
      if (!before) throw Errors.notFound('TDS section');
      await tx.query(`update fin.tds_sections set name=$2, rate_individual=$3, rate_other=$4, rate_no_pan=$5, threshold_single=$6, threshold_annual=$7, deduct_on=$8, status=$9, remarks=$10, updated_at=now(), updated_by=$11 where code=$1`,
        [before.code, d.name, d.rateIndividual, d.rateOther, d.rateNoPan, d.thresholdSingle, d.thresholdAnnual, d.deductOn, d.status, d.remarks ?? null, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'finance.tds_section.updated', entityType: 'fin.tds_section', entityId: before.code, before, after: d });
    });
    res.json({ ok: true });
  }));

  // the payee's TDS profile: default section, lower-deduction certificate, transporter declaration
  r.put('/payees/:type/:id', requirePermission('finance.tds:configure'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ section: z.string().nullable(), ldcRate: z.number().min(0).max(50).nullable().default(null), ldcValidTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
      exemptDeclaration: z.boolean().default(false) }).refine((x) => (x.ldcRate == null) === (x.ldcValidTo == null), { message: 'Give both the certificate rate and its validity', path: ['ldcValidTo'] }), req.body);
    await withTx(db, async (tx) => {
      if (d.section && !(await tx.query(`select 1 from fin.tds_sections where code = $1`, [d.section])).rowCount) throw Errors.rule('UNKNOWN_TDS_SECTION', `No TDS section ${d.section}.`);
      let n = 0;
      if (req.params.type === 'vendor') n = (await tx.query(`update mdm.vendor_profiles set tds_section = $2, tds_ldc_rate = $3, tds_ldc_valid_to = $4 where party_id = $1`, [req.params.id, d.section, d.ldcRate, d.ldcValidTo])).rowCount ?? 0;
      else if (req.params.type === 'transporter') n = (await tx.query(`update logistics.transporters set tds_section = $2, tds_exempt_declaration = $3 where id = $1`, [req.params.id, d.section, d.exemptDeclaration])).rowCount ?? 0;
      if (!n) throw Errors.notFound('Payee');
      await audit(tx, actorOf(req), { action: 'finance.tds_profile.updated', entityType: req.params.type === 'vendor' ? 'mdm.party' : 'logistics.transporter', entityId: req.params.id!, after: d });
    });
    res.json({ ok: true });
  }));

  // what the system would deduct on a payment being drafted
  r.post('/compute', requirePermission('finance.payment:view'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ payeeType: z.enum(['VENDOR', 'TRANSPORTER']), payeeId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(todayIST()),
      lines: z.array(z.object({ docId: z.string().uuid(), amount: z.number().positive() })).min(1).max(100) }), req.body);
    res.json(await computeTds(db, d));
  }));

  // deducted vs deposited, by entity, section and month
  r.get('/payable', requirePermission(V), asyncHandler(async (req, res) => {
    const scope = legalEntityScope(req, V);
    const rows = (await db.query(`select p.legal_entity_id as "legalEntityId", le.name as "legalEntityName", p.tds_section as section, to_char(p.paid_on, 'YYYY-MM') as period,
        count(*)::int as payments, sum(p.tds_amount)::float as deducted, sum(p.tds_amount) filter (where p.tds_challan_id is not null)::float as deposited
        from fin.payments p join org.legal_entities le on le.id = p.legal_entity_id where p.status = 'Paid' and p.tds_amount > 0 and ($1::uuid[] is null or p.legal_entity_id = any($1::uuid[]))
        group by 1, 2, 3, 4 order by 4 desc, 3`, [scope])).rows;
    const today = todayIST();
    res.json({ data: rows.map((x) => { const due = tdsDueDate(x.period); const pending = r2(x.deducted - (x.deposited ?? 0));
      return { ...x, deposited: x.deposited ?? 0, pending, dueDate: due, overdue: pending > 0 && today > due }; }) });
  }));

  r.get('/challans', requirePermission(V), asyncHandler(async (req, res) => {
    const scope = legalEntityScope(req, V);
    res.json({ data: (await db.query(`select c.id, c.doc_no as "docNo", c.legal_entity_id as "legalEntityId", le.name as "legalEntityName", c.section, c.period, c.tds_amount as "tdsAmount", c.interest, c.total,
        c.deposited_on as "depositedOn", c.bsr_code as "bsrCode", c.challan_serial as "challanSerial", c.status, (select count(*)::int from fin.payments p where p.tds_challan_id = c.id) as payments,
        u.full_name as "createdBy" from fin.tds_challans c join org.legal_entities le on le.id = c.legal_entity_id left join iam.users u on u.id = c.created_by
        where ($1::uuid[] is null or c.legal_entity_id = any($1::uuid[])) order by c.deposited_on desc limit 300`, [scope])).rows });
  }));

  r.post('/challans', requirePermission('finance.tds:deposit'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), section: z.string(), period: z.string().regex(/^\d{4}-\d{2}$/), interest: z.number().min(0).default(0),
      depositedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bsrCode: z.string().regex(/^[0-9]{7}$/, 'BSR code has 7 digits'), challanSerial: z.string().regex(/^[0-9]{1,5}$/, 'Challan serial number, up to 5 digits') }), req.body);
    const out = await withTx(db, async (tx) => {
      if (!leOk(req, 'finance.tds:deposit', d.legalEntityId)) throw Errors.forbidden('finance.tds:deposit');
      if (d.depositedOn > todayIST()) throw Errors.rule('INVALID_DATE', 'The deposit date cannot be in the future.');
      const pays = (await tx.query(`select id, tds_amount from fin.payments where legal_entity_id = $1 and tds_section = $2 and status = 'Paid' and tds_amount > 0 and tds_challan_id is null
          and to_char(paid_on, 'YYYY-MM') = $3 for update`, [d.legalEntityId, d.section, d.period])).rows;
      if (!pays.length) throw Errors.rule('NOTHING_TO_DEPOSIT', `No undeposited ${d.section} deduction for ${d.period}.`);
      const tds = r2(pays.reduce((a, p) => a + Number(p.tds_amount), 0));
      const late = d.depositedOn > tdsDueDate(d.period);
      if (late && !d.interest) throw Errors.rule('INTEREST_REQUIRED', `Deposited after the due date ${tdsDueDate(d.period)}: enter the interest paid with the challan (s.201(1A)).`);
      const docNo = await nextDocNo(tx, 'TDS_CHALLAN', { date: new Date(`${d.depositedOn}T00:00:00Z`) });
      const c = (await tx.query(`insert into fin.tds_challans (doc_no, legal_entity_id, section, period, tds_amount, interest, total, deposited_on, bsr_code, challan_serial, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning id`, [docNo, d.legalEntityId, d.section, d.period, tds, d.interest, r2(tds + d.interest), d.depositedOn, d.bsrCode, d.challanSerial, req.auth!.user.id])).rows[0];
      await tx.query(`update fin.payments set tds_challan_id = $2 where id = any($1::uuid[])`, [pays.map((p) => p.id), c.id]);
      await audit(tx, actorOf(req), { action: 'finance.tds_challan.deposited', entityType: 'fin.tds_challan', entityId: c.id, after: { docNo, ...d, tds, payments: pays.length } });
      return { id: c.id as string, docNo, tdsAmount: tds, payments: pays.length, late };
    });
    res.status(201).json(out);
  }));

  // Form 26Q (non-salary TDS) deductee rows for a quarter, in the column order of the NSDL return preparation utility
  r.get('/26q', requirePermission(V), asyncHandler(async (req, res) => {
    const le = str(req.query.legalEntityId); const fy = str(req.query.fy); const q = str(req.query.quarter);
    if (!le || !fy || !/^\d{4}-\d{2}$/.test(fy) || !q || !['Q1', 'Q2', 'Q3', 'Q4'].includes(q)) throw Errors.validation([{ field: 'quarter', message: 'Give legalEntityId, fy (2026-27) and quarter Q1–Q4' }]);
    if (!leOk(req, V, le)) throw Errors.notFound('Legal entity');
    const y = Number(fy.slice(0, 4));
    const [from, to] = ({ Q1: [`${y}-04-01`, `${y}-06-30`], Q2: [`${y}-07-01`, `${y}-09-30`], Q3: [`${y}-10-01`, `${y}-12-31`], Q4: [`${y + 1}-01-01`, `${y + 1}-03-31`] } as Record<string, [string, string]>)[q]!;
    const rows = (await db.query(`select p.doc_no, p.tds_section, coalesce(pt.pan, t.pan) as pan, coalesce(pt.legal_name, t.name) as name, coalesce(p.tds_base, p.amount) as base, p.paid_on, p.tds_rate, p.tds_amount,
        c.bsr_code, c.challan_serial, c.deposited_on from fin.payments p left join mdm.parties pt on pt.id = p.party_id left join logistics.transporters t on t.id = p.transporter_id
        left join fin.tds_challans c on c.id = p.tds_challan_id where p.legal_entity_id = $1 and p.status = 'Paid' and p.tds_amount > 0 and p.paid_on between $2 and $3 order by p.paid_on, p.doc_no`, [le, from, to])).rows;
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '');
    const dmy = (v: unknown) => { const s = iso(v); return s ? `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : ''; };
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Sr No', 'Section', 'Deductee PAN', 'Deductee name', 'Amount paid / credited', 'Date of payment / credit', 'Date of deduction', 'Rate (%)', 'TDS deducted', 'TDS deposited',
      'BSR code', 'Challan serial', 'Date of deposit', 'Reason for no / lower deduction', 'Our payment ref'];
    const missing = rows.filter((x) => Number(x.tds_amount) > 0 && !x.bsr_code).length;
    const body = rows.map((x, i) => [i + 1, x.tds_section, x.pan ?? 'PANNOTAVBL', x.name, Number(x.base).toFixed(2), dmy(x.paid_on), Number(x.tds_amount) > 0 ? dmy(x.paid_on) : '', x.tds_rate ?? '',
      Number(x.tds_amount).toFixed(2), x.bsr_code ? Number(x.tds_amount).toFixed(2) : '0.00', x.bsr_code ?? '', x.challan_serial ?? '', dmy(x.deposited_on),
      !x.pan ? 'C' : '', x.doc_no].map(esc).join(','));
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="26Q_${fy}_${q}.csv"`);
    res.setHeader('x-undeposited-rows', String(missing));
    res.send(`﻿${[head.join(','), ...body].join('\r\n')}\r\n`);
  }));
  return r;
}
