import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Config } from '../../config';
import { allowTransition, withTx, type Db, type Tx } from '../../db/pool';
import { audit } from '../../lib/audit';
import { decrypt, encrypt } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { asyncHandler, parse } from '../../lib/http';
import { nextDocNo } from '../../lib/numbering';
import { requirePermission } from '../../middleware/auth';
import { actorOf, legalEntityScope } from '../../middleware/context';
import { releasePayment } from '../finance/payables';
import { todayIST } from '../sales/quotations';
import { logCall, requireOn } from './registry';

/**
 * Bank payment files (FIN-010). Approved NEFT / RTGS / IMPS payments are put in one bulk file for the company bank account, in the layout
 * that bank takes (generic CSV or the pipe-delimited host-to-host layout). The file is not kept: it holds account numbers, so it is rebuilt from
 * the encrypted data when downloaded and must match the fingerprint taken when it was made. The bank's reply file (reference, status, UTR, date)
 * releases the paid payments; failed ones leave the batch and can go in the next file.
 */
const LAYOUTS = ['GENERIC_CSV', 'PIPE_H2H'] as const;
type Row = { docNo: string; mode: string; amount: number; name: string; account: string; ifsc: string; narration: string };
const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n|]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const clean = (s: string, n: number) => s.replace(/[^A-Za-z0-9 .,&/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const dmy = (s: string) => `${s.slice(8)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

export function renderBankFile(layout: string, meta: { clientCode: string | null; debitAccount: string; date: string; batchNo: string }, rows: Row[]) {
  const total = rows.reduce((a, r) => a + r.amount, 0).toFixed(2);
  if (layout === 'PIPE_H2H') {
    return [`H|${meta.clientCode ?? ''}|${meta.batchNo}|${dmy(meta.date)}|${meta.debitAccount}|${rows.length}|${total}`,
      ...rows.map((r) => `D|${r.docNo}|${r.mode === 'RTGS' ? 'R' : r.mode === 'IMPS' ? 'I' : 'N'}|${r.amount.toFixed(2)}|${clean(r.name, 35)}|${r.account}|${r.ifsc}|${clean(r.narration, 30)}`),
      `T|${rows.length}|${total}`].join('\r\n') + '\r\n';
  }
  return [['Payment Ref', 'Txn Type', 'Amount', 'Value Date', 'Beneficiary Name', 'Beneficiary Account', 'IFSC', 'Debit Account', 'Narration'].join(','),
    ...rows.map((r) => [r.docNo, r.mode, r.amount.toFixed(2), dmy(meta.date), clean(r.name, 35), r.account, r.ifsc, meta.debitAccount, clean(r.narration, 30)].map(esc).join(','))].join('\r\n') + '\r\n';
}

/** Parses the bank's reply: a CSV whose header names columns for the reference, status, UTR and date (common bank wordings accepted). */
export function parseBankReply(csv: string) {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) throw Errors.rule('EMPTY_FILE', 'The reply file has no rows.');
  const split = (l: string) => { const out: string[] = []; let cur = ''; let q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if ((ch === ',' || ch === '|') && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
  const head = split(lines[0]!).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ref = col('paymentref', 'customerref', 'reference', 'ref', 'paymentreference', 'crn');
  const st = col('status', 'txnstatus', 'transactionstatus');
  const utr = col('utr', 'utrno', 'utrnumber', 'bankref', 'bankreference');
  const dt = col('date', 'valuedate', 'txndate', 'paymentdate');
  const reason = col('reason', 'remarks', 'failurereason', 'rejectreason');
  if (ref < 0 || st < 0 || utr < 0) throw Errors.rule('UNKNOWN_LAYOUT', 'The reply file needs columns for the payment reference, status and UTR.');
  return lines.slice(1).map((l) => { const c = split(l);
    const raw = (c[dt] ?? '').replace(/\./g, '/');
    const date = /^\d{2}[/-]\d{2}[/-]\d{4}$/.test(raw) ? `${raw.slice(6, 10)}-${raw.slice(3, 5)}-${raw.slice(0, 2)}` : /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    const s = (c[st] ?? '').toUpperCase();
    return { ref: c[ref] ?? '', ok: /^(SUCCESS|SUCCESSFUL|PAID|PROCESSED|EXECUTED|S)$/.test(s), failed: /^(FAIL|FAILED|REJECTED|RETURNED|F|R)$/.test(s), utr: c[utr] ?? '', date, reason: reason >= 0 ? c[reason] ?? '' : '' }; });
}

export function bankRoutes(db: Db, cfg: Config) {
  const r = Router();
  const V = 'finance.payment_batch:view';
  const leOk = (req: Request, perm: string, le: string) => { const s = legalEntityScope(req, perm); return !s || s.includes(le); };

  async function rowsFor(tx: Db | Tx, paymentIds: string[]) {
    const ps = (await tx.query(`select p.id, p.doc_no, p.mode, p.net_amount, p.payee_type, p.party_id, p.transporter_id, coalesce(pt.legal_name, t.name) as payee,
        ba.account_holder, ba.ifsc, ba.account_no_enc, ba.verification, t.bank_holder, t.bank_ifsc, t.bank_account_enc
        from fin.payments p left join mdm.parties pt on pt.id = p.party_id left join logistics.transporters t on t.id = p.transporter_id
        left join mdm.party_bank_accounts ba on ba.party_id = p.party_id and ba.status = 'Active' where p.id = any($1::uuid[]) order by p.doc_no`, [paymentIds])).rows;
    return ps.map((p) => {
      const vendor = p.payee_type === 'VENDOR';
      const enc = vendor ? p.account_no_enc : p.bank_account_enc;
      if (!enc || (vendor && p.verification !== 'Verified')) throw Errors.rule('NO_BANK_ACCOUNT', `${p.doc_no}: ${p.payee} has no ${vendor ? 'verified ' : ''}bank account on record.`);
      return { docNo: p.doc_no as string, mode: p.mode as string, amount: Number(p.net_amount), name: (vendor ? p.account_holder : p.bank_holder) ?? p.payee, account: decrypt(enc, cfg.APP_ENCRYPTION_KEY),
        ifsc: (vendor ? p.ifsc : p.bank_ifsc) as string, narration: `${p.doc_no} ${p.payee}` };
    });
  }
  async function render(tx: Db | Tx, batchId: string) {
    const b = (await tx.query(`select b.*, a.account_no_enc, a.client_code from fin.payment_batches b join fin.bank_accounts a on a.id = b.bank_account_id where b.id = $1`, [batchId])).rows[0];
    const ids = (await tx.query(`select id from fin.payments where batch_id = $1`, [batchId])).rows.map((x) => x.id);
    const body = renderBankFile(b.layout, { clientCode: b.client_code, debitAccount: decrypt(b.account_no_enc, cfg.APP_ENCRYPTION_KEY), date: new Date(b.created_at).toISOString().slice(0, 10), batchNo: b.doc_no }, await rowsFor(tx, ids));
    return { b, body };
  }

  // ---- company bank accounts
  r.get('/bank-accounts', requirePermission(V), asyncHandler(async (req, res) => {
    const scope = legalEntityScope(req, V);
    res.json({ data: (await db.query(`select a.id, a.legal_entity_id as "legalEntityId", le.name as "legalEntityName", a.name, a.bank_name as "bankName", a.ifsc, a.account_last4 as "accountLast4",
        a.client_code as "clientCode", a.file_layout as "fileLayout", a.status from fin.bank_accounts a join org.legal_entities le on le.id = a.legal_entity_id
        where ($1::uuid[] is null or a.legal_entity_id = any($1::uuid[])) order by le.name, a.name`, [scope])).rows, layouts: LAYOUTS });
  }));
  r.post('/bank-accounts', requirePermission('finance.bank_account:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ legalEntityId: z.string().uuid(), name: z.string().trim().min(2).max(80), bankName: z.string().trim().min(2).max(80),
      ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC like HDFC0001234'), accountNo: z.string().trim().regex(/^[0-9]{9,18}$/, '9 to 18 digits'),
      clientCode: z.string().trim().max(30).optional().nullable(), fileLayout: z.enum(LAYOUTS) }), req.body);
    if (!leOk(req, 'finance.bank_account:manage', d.legalEntityId)) throw Errors.forbidden('finance.bank_account:manage');
    const id = await withTx(db, async (tx) => {
      const a = (await tx.query(`insert into fin.bank_accounts (legal_entity_id, name, bank_name, ifsc, account_no_enc, account_last4, client_code, file_layout, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [d.legalEntityId, d.name, d.bankName, d.ifsc, encrypt(d.accountNo, cfg.APP_ENCRYPTION_KEY), d.accountNo.slice(-4), d.clientCode ?? null, d.fileLayout, req.auth!.user.id])).rows[0].id as string;
      await audit(tx, actorOf(req), { action: 'finance.bank_account.created', entityType: 'fin.bank_account', entityId: a, after: { ...d, accountNo: `••${d.accountNo.slice(-4)}` } });
      return a;
    });
    res.status(201).json({ id });
  }));

  // transporters are paid into the account recorded on the transporter
  r.put('/transporters/:id/bank', requirePermission('finance.bank_account:manage'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ holder: z.string().trim().min(2).max(80), ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/), accountNo: z.string().trim().regex(/^[0-9]{9,18}$/) }), req.body);
    await withTx(db, async (tx) => {
      const t = (await tx.query(`update logistics.transporters set bank_holder = $2, bank_ifsc = $3, bank_account_enc = $4, bank_last4 = $5, updated_by = $6 where id = $1 returning id`,
        [req.params.id, d.holder, d.ifsc, encrypt(d.accountNo, cfg.APP_ENCRYPTION_KEY), d.accountNo.slice(-4), req.auth!.user.id])).rows[0];
      if (!t) throw Errors.notFound('Transporter');
      await audit(tx, actorOf(req), { action: 'logistics.transporter.bank_set', entityType: 'logistics.transporter', entityId: t.id, after: { holder: d.holder, ifsc: d.ifsc, account: `••${d.accountNo.slice(-4)}` } });
    });
    res.json({ ok: true });
  }));

  // ---- batches
  r.get('/payment-batches', requirePermission(V), asyncHandler(async (req, res) => {
    const scope = legalEntityScope(req, V);
    const batches = (await db.query(`select b.id, b.doc_no as "docNo", b.legal_entity_id as "legalEntityId", a.name as "bankAccount", a.account_last4 as "accountLast4", b.layout, b.status, b.payment_count as "paymentCount",
        b.total, b.file_name as "fileName", b.created_at as "createdAt", u.full_name as "createdBy",
        (select count(*)::int from fin.payments p where p.batch_id = b.id and p.status = 'Paid') as paid
        from fin.payment_batches b join fin.bank_accounts a on a.id = b.bank_account_id left join iam.users u on u.id = b.created_by
        where ($1::uuid[] is null or b.legal_entity_id = any($1::uuid[])) order by b.created_at desc limit 200`, [scope])).rows;
    const ready = (await db.query(`select p.id, p.doc_no as "docNo", p.legal_entity_id as "legalEntityId", coalesce(pt.legal_name, t.name) as "payeeName", p.mode, p.net_amount as "netAmount", p.payment_date as "paymentDate"
        from fin.payments p left join mdm.parties pt on pt.id = p.party_id left join logistics.transporters t on t.id = p.transporter_id
        where p.status = 'Approved' and p.mode in ('NEFT','RTGS','IMPS') and (p.batch_id is null or exists (select 1 from fin.payment_batches b where b.id = p.batch_id and b.status <> 'Generated'))
          and ($1::uuid[] is null or p.legal_entity_id = any($1::uuid[])) order by p.payment_date, p.doc_no`, [scope])).rows;
    res.json({ data: batches, ready });
  }));

  r.get('/payment-batches/:id', requirePermission(V), asyncHandler(async (req, res) => {
    const b = (await db.query(`select b.id, b.doc_no as "docNo", b.legal_entity_id as "legalEntityId", a.name as "bankAccount", a.account_last4 as "accountLast4", b.layout, b.status, b.status_reason as "statusReason",
        b.payment_count as "paymentCount", b.total, b.file_name as "fileName", b.created_at as "createdAt" from fin.payment_batches b join fin.bank_accounts a on a.id = b.bank_account_id where b.id = $1`, [req.params.id])).rows[0];
    if (!b || !leOk(req, V, b.legalEntityId)) throw Errors.notFound('Payment file');
    const payments = (await db.query(`select p.id, p.doc_no as "docNo", coalesce(pt.legal_name, t.name) as "payeeName", p.mode, p.net_amount as "netAmount", p.status, p.reference, p.paid_on as "paidOn"
        from fin.payments p left join mdm.parties pt on pt.id = p.party_id left join logistics.transporters t on t.id = p.transporter_id where p.batch_id = $1 order by p.doc_no`, [b.id])).rows;
    res.json({ ...b, payments });
  }));

  r.post('/payment-batches', requirePermission('finance.payment_batch:create'), asyncHandler(async (req, res) => {
    const d = parse(z.object({ bankAccountId: z.string().uuid(), paymentIds: z.array(z.string().uuid()).min(1).max(500) }), req.body);
    const out = await withTx(db, async (tx) => {
      await requireOn(tx, 'BANK_PAYMENTS');
      const a = (await tx.query(`select * from fin.bank_accounts where id = $1 and status = 'Active'`, [d.bankAccountId])).rows[0];
      if (!a || !leOk(req, 'finance.payment_batch:create', a.legal_entity_id)) throw Errors.notFound('Bank account');
      const ps = (await tx.query(`select p.id, p.doc_no, p.status, p.mode, p.legal_entity_id, p.net_amount, b.status as batch_status from fin.payments p left join fin.payment_batches b on b.id = p.batch_id
          where p.id = any($1::uuid[]) for update of p`, [d.paymentIds])).rows;
      if (ps.length !== new Set(d.paymentIds).size) throw Errors.notFound('Payment');
      for (const p of ps) {
        if (p.status !== 'Approved') throw Errors.rule('NOT_APPROVED', `${p.doc_no} is ${String(p.status).toLowerCase()}, not approved.`);
        if (!['NEFT', 'RTGS', 'IMPS'].includes(p.mode)) throw Errors.rule('NOT_A_TRANSFER', `${p.doc_no} is a ${p.mode} payment; only bank transfers go in a payment file.`);
        if (p.legal_entity_id !== a.legal_entity_id) throw Errors.rule('WRONG_ENTITY', `${p.doc_no} belongs to another legal entity than the bank account.`);
        if (p.batch_status === 'Generated') throw Errors.conflict('ALREADY_IN_FILE', `${p.doc_no} is already in an open payment file.`);
      }
      const docNo = await nextDocNo(tx, 'PAYMENT_BATCH');
      await rowsFor(tx, ps.map((p) => p.id));                                  // every payee has a usable account
      const total = Math.round(ps.reduce((s, p) => s + Number(p.net_amount), 0) * 100) / 100;
      const fileName = `${docNo.replace(/\//g, '-')}${a.file_layout === 'PIPE_H2H' ? '.txt' : '.csv'}`;
      const b = (await tx.query(`insert into fin.payment_batches (doc_no, legal_entity_id, bank_account_id, layout, payment_count, total, file_name, file_sha256, created_by, updated_by)
          values ($1,$2,$3,$4,$5,$6,$7,'',$8,$8) returning id`, [docNo, a.legal_entity_id, a.id, a.file_layout, ps.length, total, fileName, req.auth!.user.id])).rows[0];
      await tx.query(`update fin.payments set batch_id = $2 where id = any($1::uuid[])`, [ps.map((p) => p.id), b.id]);
      const { body } = await render(tx, b.id);
      await tx.query(`update fin.payment_batches set file_sha256 = $2 where id = $1`, [b.id, createHash('sha256').update(body).digest('hex')]);
      await logCall(tx, { integration: 'BANK_PAYMENTS', operation: 'file', mode: 'MANUAL', subjectType: 'fin.payment_batch', subjectId: b.id, ok: true, request: { payments: ps.map((p) => p.doc_no), total }, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'finance.payment_batch.generated', entityType: 'fin.payment_batch', entityId: b.id, after: { docNo, payments: ps.map((p) => p.doc_no), total } });
      return { id: b.id as string, docNo, total, payments: ps.length, fileName };
    });
    res.status(201).json(out);
  }));

  r.get('/payment-batches/:id/file', requirePermission('finance.payment_batch:create'), asyncHandler(async (req, res) => {
    const out = await withTx(db, async (tx) => {
      const x = await render(tx, req.params.id!);
      if (!x.b || !leOk(req, 'finance.payment_batch:create', x.b.legal_entity_id)) throw Errors.notFound('Payment file');
      if (x.b.status !== 'Generated') throw Errors.state('This payment file is closed.');
      // anything changed since (an account, a payment) means this is no longer the file that was approved for upload
      if (createHash('sha256').update(x.body).digest('hex') !== x.b.file_sha256) throw Errors.rule('FILE_CHANGED', 'A payee bank account or payment changed after the file was made. Cancel it and make a new one.');
      await audit(tx, actorOf(req), { action: 'finance.payment_batch.downloaded', entityType: 'fin.payment_batch', entityId: x.b.id });
      return x;
    });
    res.setHeader('content-type', out.b.layout === 'PIPE_H2H' ? 'text/plain; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${out.b.file_name}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(out.body);
  }));

  r.post('/payment-batches/:id/reply', requirePermission('finance.payment_batch:close'), asyncHandler(async (req, res) => {
    const { content } = parse(z.object({ content: z.string().min(10).max(2_000_000) }), req.body);
    const rows = parseBankReply(content);
    const out = await withTx(db, async (tx) => {
      const b = (await tx.query(`select * from fin.payment_batches where id = $1 for update`, [req.params.id])).rows[0];
      if (!b || !leOk(req, 'finance.payment_batch:close', b.legal_entity_id)) throw Errors.notFound('Payment file');
      if (b.status !== 'Generated') throw Errors.state('This payment file is already closed.');
      const ps = (await tx.query(`select id, doc_no, status from fin.payments where batch_id = $1`, [b.id])).rows;
      const result: { ref: string; outcome: 'paid' | 'failed' | 'unknown' | 'already' | 'invalid'; message?: string }[] = [];
      for (const row of rows) {
        const p = ps.find((x) => x.doc_no === row.ref);
        if (!p) { result.push({ ref: row.ref, outcome: 'unknown', message: 'Not in this file' }); continue; }
        if (p.status === 'Paid') { result.push({ ref: row.ref, outcome: 'already' }); continue; }
        if (row.ok) {
          if (!/^[A-Z0-9]{8,30}$/i.test(row.utr) || !row.date) { result.push({ ref: row.ref, outcome: 'invalid', message: 'Paid but the UTR or date is missing' }); continue; }
          await releasePayment(tx, actorOf(req), p.id, row.utr.toUpperCase(), row.date > todayIST() ? todayIST() : row.date);
          p.status = 'Paid'; result.push({ ref: row.ref, outcome: 'paid' });
        } else if (row.failed) {
          // back to the queue for the next file; the reason stays on the payment
          await tx.query(`update fin.payments set batch_id = null, status_reason = $2 where id = $1`, [p.id, `Bank rejected in ${b.doc_no}: ${row.reason || 'no reason given'}`.slice(0, 300)]);
          p.status = 'Removed'; result.push({ ref: row.ref, outcome: 'failed', message: row.reason });
        } else result.push({ ref: row.ref, outcome: 'invalid', message: 'Status not understood' });
      }
      const open = ps.filter((p) => p.status === 'Approved').length;
      if (!open) {
        await allowTransition(tx);
        await tx.query(`update fin.payment_batches set status = 'Closed', updated_by = $2 where id = $1`, [b.id, req.auth!.user.id]);
      }
      await logCall(tx, { integration: 'BANK_PAYMENTS', operation: 'reply', mode: 'MANUAL', subjectType: 'fin.payment_batch', subjectId: b.id, ok: true, response: result, userId: req.auth!.user.id });
      await audit(tx, actorOf(req), { action: 'finance.payment_batch.reply', entityType: 'fin.payment_batch', entityId: b.id, after: { result } });
      return { result, open, closed: !open };
    });
    res.json(out);
  }));

  r.post('/payment-batches/:id/cancel', requirePermission('finance.payment_batch:create'), asyncHandler(async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    await withTx(db, async (tx) => {
      const b = (await tx.query(`select * from fin.payment_batches where id = $1 for update`, [req.params.id])).rows[0];
      if (!b || !leOk(req, 'finance.payment_batch:create', b.legal_entity_id)) throw Errors.notFound('Payment file');
      if (b.status !== 'Generated') throw Errors.state('This payment file is already closed.');
      if ((await tx.query(`select 1 from fin.payments where batch_id = $1 and status = 'Paid'`, [b.id])).rowCount) throw Errors.rule('PARTLY_PAID', 'Some payments of this file are already paid; load the bank’s reply instead.');
      await tx.query(`update fin.payments set batch_id = null where batch_id = $1`, [b.id]);
      await allowTransition(tx);
      await tx.query(`update fin.payment_batches set status = 'Cancelled', status_reason = $2, updated_by = $3 where id = $1`, [b.id, reason, req.auth!.user.id]);
      await audit(tx, actorOf(req), { action: 'finance.payment_batch.cancelled', entityType: 'fin.payment_batch', entityId: b.id, reason });
    });
    res.json({ ok: true });
  }));
  return r;
}
