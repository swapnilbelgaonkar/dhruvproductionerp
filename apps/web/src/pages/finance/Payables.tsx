import { ArrowLeft, Plus, Printer } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, humanize } from '../../lib/format';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const plus = (d: number) => { const x = new Date(`${today()}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
const TDS = ['194C', '194Q', '194J', '194H', '194I'];

interface PaymentRow { id: string; docNo: string; legalEntityId: string; legalEntityName: string; payeeType: string; partyId: string | null; transporterId: string | null; payeeName: string; payeeCode: string;
  paymentDate: string; mode: string; fromAccount: string | null; amount: string; tdsSection: string | null; tdsAmount: string; netAmount: string; reference: string | null; status: string; statusReason: string | null;
  paidOn: string | null; remarks: string | null; createdAt: string; createdBy: string }
interface PaymentDetail extends PaymentRow { lines: { id: string; supplierInvoiceId: string | null; freightBillId: string | null; docNo: string; billNo: string; dueDate: string; billTotal: string; amount: string }[];
  approval: { id: string; docNo: string; status: string } | null; bank: { bankName: string; ifsc: string; accountLast4: string; verification: string } | null; allowedActions: string[] }
interface OpenDoc { id: string; kind: string; docNo: string; billNo: string; billDate: string; dueDate: string; total: string; settled: string; held: string; outstanding: number }

// ---------------------------------------------------------------- payments (FIN-009, FIN-010)
export function PaymentsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'Open' | 'Paid' | 'All'>('Open');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['payments'], queryFn: () => api<{ data: PaymentRow[] }>('/payments') });
  const rows = (q.data?.data ?? []).filter((p) => tab === 'All' || (tab === 'Paid' ? p.status === 'Paid' : ['Draft', 'Submitted', 'Approved', 'Rejected'].includes(p.status)));
  return (
    <>
      <PageHeader title="Payments" subtitle="Payments to vendors and transporters against approved bills. Drafted by accounts, approved by the finance head, and settled only when released with the bank's UTR."
        actions={can('finance.payment:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>New payment</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'Open', label: 'In progress' }, { value: 'Paid', label: 'Paid' }, { value: 'All', label: 'All' }]} />
      <Card padded={false} className="mt-4">
        {q.isLoading ? <Skeleton className="h-40" /> : !rows.length ? <div className="p-5"><EmptyState title="No payments here" text="Draft a payment against a vendor's or transporter's approved bills." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Payment</th><th className={th}>Payee</th><th className={th}>Date</th>
            <th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>TDS</th><th className={`${th} text-right`}>Net paid</th><th className={th}>UTR</th><th className={th}>Status</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/finance/payments/${p.id}`}>{p.docNo}</Link></td>
                <td className={th}>{p.payeeName} <span className="text-ink-2">{p.payeeType === 'TRANSPORTER' ? '· transporter' : ''}</span></td><td className={th}>{fmtDate(p.paidOn ?? p.paymentDate)}</td>
                <td className={`${th} text-right num`}>{fmtINR(p.amount)}</td><td className={`${th} text-right num`}>{n(p.tdsAmount) ? fmtINR(p.tdsAmount) : '—'}</td><td className={`${th} text-right num`}>{fmtINR(p.netAmount)}</td>
                <td className={`${th} num`}>{p.reference ?? '—'}</td><td className={th}><StatusBadge status={p.status === 'Paid' ? 'Posted' : p.status} label={p.status} /></td></tr>))}</tbody></table></div>
        )}
      </Card>
      {open && <PaymentDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function PaymentDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/legal-entities?status=Active&limit=100') });
  const vendors = useQuery({ queryKey: ['vendors-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/vendors?usable=1&limit=100') });
  const trs = useQuery({ queryKey: ['transporters'], queryFn: () => api<{ data: { id: string; code: string; name: string; status: string }[] }>('/shipments/transporters').catch(() => ({ data: [] })) });
  const [f, setF] = useState({ legalEntityId: '', payeeType: 'VENDOR', payeeId: '', paymentDate: today(), mode: 'NEFT', fromAccount: '', tdsSection: '', tdsAmount: '', tdsReason: '', remarks: '' });
  const [override, setOverride] = useState(false);
  const [amt, setAmt] = useState<Record<string, string>>({});
  const [adjustTo, setAdjustTo] = useState<Record<string, string>>({});
  useEffect(() => { const e = entities.data?.data; if (e?.length === 1 && !f.legalEntityId) setF((x) => ({ ...x, legalEntityId: e[0]!.id })); }, [entities.data, f.legalEntityId]);
  const key = ['payables-open', f.legalEntityId, f.payeeType, f.payeeId];
  const docs = useQuery({ queryKey: key, enabled: !!f.legalEntityId && !!f.payeeId,
    queryFn: () => api<{ data: OpenDoc[]; debitNotes: { id: string; docNo: string; noteDate: string; reason: string; grandTotal: string }[]; bank: { bankName: string; ifsc: string; accountLast4: string; verification: string } | null }>(
      `/payments/payables?legalEntityId=${f.legalEntityId}&payeeType=${f.payeeType}&payeeId=${f.payeeId}`) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = Object.entries(amt).map(([docId, v]) => ({ docId, amount: Number(v) || 0 })).filter((l) => l.amount > 0);
  const gross = lines.reduce((a, l) => a + l.amount, 0);
  const auto = useQuery({ queryKey: ['tds-compute', f.payeeType, f.payeeId, f.paymentDate, JSON.stringify(lines)], enabled: !!f.payeeId && lines.length > 0,
    queryFn: () => api<{ section: string | null; rate: number; base: number; amount: number; basis: string; reason: string }>('/tds/compute', { body: { payeeType: f.payeeType, payeeId: f.payeeId, date: f.paymentDate, lines } }) });
  const tds = override ? Number(f.tdsAmount) || 0 : auto.data?.amount ?? 0;
  const adjust = async (dnId: string) => {
    try { await api(`/payables/debit-notes/${dnId}/adjust`, { body: { supplierInvoiceId: adjustTo[dnId] } }); toast('success', 'Debit note adjusted against the invoice.'); await qc.invalidateQueries({ queryKey: key }); }
    catch (e) { setError(e); }
  };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string }>('/payments', { body: { legalEntityId: f.legalEntityId, payeeType: f.payeeType, payeeId: f.payeeId, paymentDate: f.paymentDate, mode: f.mode,
        fromAccount: f.fromAccount || null, ...(override ? { tdsSection: f.tdsSection || null, tdsAmount: tds, tdsReason: f.tdsReason || null } : {}), remarks: f.remarks || null, lines } });
      toast('success', `${r.docNo} drafted. Submit it for approval.`); nav(`/finance/payments/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const bank = docs.data?.bank;
  return (
    <Modal open onClose={onClose} title="New payment" width={820}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.payeeId || !lines.length || tds >= gross || (override && tds > 0 && !f.tdsSection)} onClick={save}>Draft payment</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Paying entity" htmlFor="py-le" required><Select id="py-le" value={f.legalEntityId} onChange={(e) => { setF({ ...f, legalEntityId: e.target.value }); setAmt({}); }}><option value="">Select…</option>
          {(entities.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Pay to" htmlFor="py-type" required><Select id="py-type" value={f.payeeType} onChange={(e) => { setF({ ...f, payeeType: e.target.value, payeeId: '' }); setAmt({}); }}>
          <option value="VENDOR">Vendor</option><option value="TRANSPORTER">Transporter</option></Select></Field>
        <Field label={f.payeeType === 'VENDOR' ? 'Vendor' : 'Transporter'} htmlFor="py-payee" required><Select id="py-payee" value={f.payeeId} onChange={(e) => { setF({ ...f, payeeId: e.target.value }); setAmt({}); }}><option value="">Select…</option>
          {f.payeeType === 'VENDOR' ? (vendors.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.legalName} ({x.code})</option>)
            : (trs.data?.data ?? []).filter((t) => t.status === 'Active').map((x) => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</Select></Field>
        <Field label="Payment date" htmlFor="py-date" required><Input id="py-date" type="date" value={f.paymentDate} onChange={(e) => setF({ ...f, paymentDate: e.target.value })} /></Field>
        <Field label="Mode" htmlFor="py-mode" required><Select id="py-mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{['NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE'].map((m) => <option key={m} value={m}>{m === 'CHEQUE' ? 'Cheque' : m}</option>)}</Select></Field>
        <Field label="From our account" htmlFor="py-acc"><Input id="py-acc" value={f.fromAccount} onChange={(e) => setF({ ...f, fromAccount: e.target.value })} /></Field>
      </div>
      {bank !== undefined && f.payeeType === 'VENDOR' && (
        <p className={`mt-3 rounded-md px-3 py-2 text-[14px] ${bank?.verification === 'Verified' ? 'bg-success-bg text-success-text' : 'bg-danger-bg text-danger-text'}`}>
          {bank ? `${bank.bankName} · ${bank.ifsc} · ••${bank.accountLast4} — ${bank.verification === 'Verified' ? 'verified by finance' : 'NOT verified: the payment cannot be submitted'}` : 'No bank account on record: the vendor cannot be paid.'}</p>
      )}
      {!!docs.data?.debitNotes.length && (
        <div className="mt-4"><p className="mb-2 font-semibold">Open debit notes — adjust before paying</p>
          <ul className="space-y-2">{docs.data.debitNotes.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 text-[14px]"><span className="num">{d.docNo}</span><span className="text-ink-2">{fmtDate(d.noteDate)} · {fmtINR(d.grandTotal)}</span>
              <Select aria-label={`Invoice to adjust ${d.docNo} against`} className="w-56" value={adjustTo[d.id] ?? ''} onChange={(e) => setAdjustTo({ ...adjustTo, [d.id]: e.target.value })}><option value="">Against invoice…</option>
                {(docs.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.docNo} ({fmtINR(x.outstanding)})</option>)}</Select>
              <Button size="sm" variant="secondary" disabled={!adjustTo[d.id]} onClick={() => adjust(d.id)}>Adjust</Button></li>))}</ul></div>
      )}
      <div className="mt-4">
        <p className="mb-2 font-semibold">Approved bills</p>
        {!f.payeeId ? <p className="text-ink-2">Choose the payee.</p> : !docs.data?.data.length ? <p className="text-ink-2">Nothing payable: no approved, unpaid bills.</p> : (
          <table className="w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Bill</th><th className="py-2">Due</th><th className="py-2 text-right">Total</th><th className="py-2 text-right">Payable</th><th className="w-36 py-2 text-right">Pay now</th></tr></thead>
            <tbody>{docs.data.data.map((d) => (
              <tr key={d.id} className="border-b border-line last:border-0"><td className="py-2"><span className="num">{d.docNo}</span> <span className="text-ink-2">{d.billNo}</span></td>
                <td className={`py-2 ${d.dueDate < today() ? 'text-danger-text' : ''}`}>{fmtDate(d.dueDate)}</td><td className="py-2 text-right num">{fmtINR(d.total)}</td><td className="py-2 text-right num">{fmtINR(d.outstanding)}</td>
                <td className="py-2 pl-3"><Input aria-label={`Pay against ${d.docNo}`} type="number" min="0" max={d.outstanding} step="0.01" value={amt[d.id] ?? ''} onChange={(e) => setAmt({ ...amt, [d.id]: e.target.value })} /></td></tr>))}</tbody></table>
        )}
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        {!override ? <div className="md:col-span-2 text-[14px]"><p className="font-semibold">TDS</p><p className="text-ink-2">{!lines.length ? 'Worked out from the TDS master once amounts are entered.' : auto.data ? (auto.data.amount ? auto.data.reason : auto.data.reason) : 'Working out…'}</p>
          <button type="button" className="text-[13px] text-primary underline" onClick={() => { setOverride(true); setF({ ...f, tdsSection: auto.data?.section ?? '', tdsAmount: String(auto.data?.amount ?? '') }); }}>Enter TDS by hand</button></div> : <>
          <Field label="TDS section" htmlFor="py-tds"><Select id="py-tds" value={f.tdsSection} onChange={(e) => setF({ ...f, tdsSection: e.target.value })}><option value="">No TDS</option>{TDS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
          <Field label="TDS deducted (₹)" htmlFor="py-tdsamt" hint={auto.data?.basis === 'AUTO' ? `The master gives ${fmtINR(auto.data.amount)}` : undefined}><Input id="py-tdsamt" type="number" min="0" step="0.01" value={f.tdsAmount} disabled={!f.tdsSection} onChange={(e) => setF({ ...f, tdsAmount: e.target.value })} /></Field>
          <Field label="Reason for entering it by hand" htmlFor="py-tdsr"><Input id="py-tdsr" value={f.tdsReason} onChange={(e) => setF({ ...f, tdsReason: e.target.value })} /></Field></>}
        <div className="rounded-md bg-canvas p-3 text-[14px]"><p>Gross {fmtINR(gross)}</p><p>Less TDS {fmtINR(tds)}</p><p className="font-semibold">Net to bank {fmtINR(gross - tds)}</p></div>
      </div>
    </Modal>
  );
}

export function PaymentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['payment', id], queryFn: () => api<PaymentDetail>(`/payments/${id}`) });
  const [dialog, setDialog] = useState<null | 'cancel' | 'release'>(null);
  const [rel, setRel] = useState({ reference: '', paidOn: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const p = q.data;
  if (!p) return <ErrorBanner error={q.error} />;
  const can = (a: string) => p.allowedActions.includes(a);
  const refresh = () => qc.invalidateQueries();
  const submit = async () => {
    setBusy(true);
    try { const r = await api<{ approvalDocNo: string }>(`/payments/${id}/submit`, { body: {} }); toast('success', `Sent for approval as ${r.approvalDocNo}.`); await refresh(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Could not submit.'); } finally { setBusy(false); }
  };
  const release = async () => {
    setBusy(true); setError(null);
    try { await api(`/payments/${id}/release`, { body: rel }); toast('success', `${p.docNo} released; the bills are settled.`); setDialog(null); await refresh(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={p.docNo} crumbs={<Link to="/finance/payments" className="hover:text-primary">Payments</Link>}
        subtitle={<span>{p.payeeName} · net {fmtINR(p.netAmount)} by {p.mode} · <StatusBadge status={p.status === 'Paid' ? 'Posted' : p.status} label={p.status} /></span>}
        actions={<>
          {can('cancel') && <Button variant="secondary" onClick={() => setDialog('cancel')}>Cancel</Button>}
          {can('submit') && <Button loading={busy} onClick={submit}>Submit for approval</Button>}
          {can('release') && <Button onClick={() => setDialog('release')}>Release payment</Button>}
        </>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Bills paid" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Bill</th><th className={th}>Due</th><th className={`${th} text-right`}>Bill total</th><th className={`${th} text-right`}>Paid now</th></tr></thead>
            <tbody>{p.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0"><td className="px-5 py-3">
                {l.freightBillId ? <Link className="font-semibold text-primary num" to={`/logistics/freight-bills/${l.freightBillId}`}>{l.docNo}</Link> : <Link className="font-semibold text-primary num" to={`/purchase/invoices/${l.supplierInvoiceId}`}>{l.docNo}</Link>}
                <span className="text-ink-2"> {l.billNo}</span></td><td className={th}>{fmtDate(l.dueDate)}</td><td className={`${th} text-right num`}>{fmtINR(l.billTotal)}</td><td className={`${th} text-right num`}>{fmtINR(l.amount)}</td></tr>))}</tbody></table></div>
        </Card>
        <Card title="Payment">
          <KeyValues columns="narrow" items={[['Entity', p.legalEntityName], ['Payee', `${p.payeeName} (${p.payeeCode})`],
            ...(p.bank ? [['Bank', `${p.bank.bankName} · ${p.bank.ifsc} · ••${p.bank.accountLast4} (${p.bank.verification.toLowerCase()})`] as [string, string]] : []),
            ['Gross', fmtINR(p.amount)], ['TDS', n(p.tdsAmount) ? `${fmtINR(p.tdsAmount)} u/s ${p.tdsSection}` : '—'], ['Net to bank', fmtINR(p.netAmount)], ['From account', p.fromAccount ?? '—'],
            ['Approval', p.approval ? <Link key="a" className="text-primary" to={`/approvals/${p.approval.id}`}>{p.approval.docNo} · {humanize(p.approval.status)}</Link> : 'Not submitted'],
            ['Released', p.paidOn ? `${fmtDate(p.paidOn)} · UTR ${p.reference}` : '—'], ['Drafted', `${p.createdBy}, ${fmtDateTime(p.createdAt)}`], ['Note', p.statusReason ?? p.remarks ?? '—']]} />
        </Card>
      </div>
      <ReasonDialog open={dialog === 'cancel'} danger title={`Cancel ${p.docNo}`} confirmLabel="Cancel payment" onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`/payments/${id}/cancel`, { body: { reason } }); toast('success', `${p.docNo} cancelled; its bills are payable again.`); await refresh(); }} />
      <Modal open={dialog === 'release'} onClose={() => setDialog(null)} title={`Release ${p.docNo}`} description={`Record the bank transfer of ${fmtINR(p.netAmount)}. The bills are settled now.`}
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button loading={busy} disabled={!rel.reference.trim()} onClick={release}>Record release</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="UTR / cheque number" htmlFor="rl-ref" required><Input id="rl-ref" value={rel.reference} onChange={(e) => setRel({ ...rel, reference: e.target.value.trim() })} /></Field>
          <Field label="Paid on" htmlFor="rl-on" required><Input id="rl-on" type="date" max={today()} value={rel.paidOn} onChange={(e) => setRel({ ...rel, paidOn: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- freight bills (FIN-012)
interface FreightBill { id: string; docNo: string; transporterId: string; transporterName: string; transporterGstin: string | null; legalEntityId: string; billNo: string; billDate: string; dueDate: string;
  taxableTotal: string; gstRate: string; reverseCharge: boolean; gstAmount: string; grandTotal: string; amountSettled: string; outstanding: string; variance: string; status: string; statusReason: string | null;
  remarks: string | null; createdAt: string; createdBy: string }

export function FreightBillsPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['freight-bills'], queryFn: () => api<{ data: FreightBill[] }>('/freight-bills') });
  return (
    <>
      <PageHeader title="Freight Bills" subtitle="Transporter bills for freight we pay, checked shipment by shipment against the freight agreed at dispatch. Approved bills can be paid."
        actions={can('logistics.freight_bill:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Enter freight bill</Button>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="No freight bills" text="Enter a transporter's bill against the shipments it carried." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Bill</th><th className={th}>Transporter</th><th className={th}>Date / due</th>
            <th className={`${th} text-right`}>Payable</th><th className={`${th} text-right`}>Over agreed</th><th className={`${th} text-right`}>Outstanding</th><th className={th}>Status</th></tr></thead>
            <tbody>{q.data.data.map((b) => (
              <tr key={b.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/logistics/freight-bills/${b.id}`}>{b.docNo}</Link> <span className="text-ink-2">{b.billNo}</span></td>
                <td className={th}>{b.transporterName}</td><td className={th}>{fmtDate(b.billDate)} / {fmtDate(b.dueDate)}</td><td className={`${th} text-right num`}>{fmtINR(b.grandTotal)}</td>
                <td className={`${th} text-right num ${n(b.variance) > 0 ? 'text-warning-text' : ''}`}>{n(b.variance) ? fmtINR(b.variance) : '—'}</td><td className={`${th} text-right num`}>{b.status === 'Approved' ? fmtINR(b.outstanding) : '—'}</td>
                <td className={th}><StatusBadge status={b.status} /></td></tr>))}</tbody></table></div>
        )}
      </Card>
      {open && <FreightBillDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function FreightBillDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const trs = useQuery({ queryKey: ['transporters'], queryFn: () => api<{ data: { id: string; code: string; name: string; status: string }[] }>('/shipments/transporters') });
  const [f, setF] = useState({ transporterId: '', billNo: '', billDate: today(), dueDate: plus(15), gstRate: '5', reverseCharge: true, remarks: '' });
  const ships = useQuery({ queryKey: ['freight-billable', f.transporterId], enabled: !!f.transporterId,
    queryFn: () => api<{ data: { id: string; docNo: string; dispatchedAt: string; legalEntityId: string; freightTerms: string; freightAmount: string | null; lrNo: string; partyName: string; city: string }[] }>(`/freight-bills/billable?transporterId=${f.transporterId}`) });
  const [amt, setAmt] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = Object.entries(amt).map(([shipmentId, v]) => ({ shipmentId, amount: Number(v) || 0 })).filter((l) => l.amount > 0);
  const le = ships.data?.data.find((s) => lines.some((l) => l.shipmentId === s.id))?.legalEntityId;
  const taxable = lines.reduce((a, l) => a + l.amount, 0);
  const agreed = (ships.data?.data ?? []).filter((s) => lines.some((l) => l.shipmentId === s.id)).reduce((a, s) => a + n(s.freightAmount), 0);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string; variance: number }>('/freight-bills', { body: { transporterId: f.transporterId, legalEntityId: le, billNo: f.billNo, billDate: f.billDate, dueDate: f.dueDate,
        gstRate: Number(f.gstRate) || 0, reverseCharge: f.reverseCharge, remarks: f.remarks || null, lines } });
      toast('success', `${r.docNo} entered and sent for approval${r.variance > 0 ? ` (${fmtINR(r.variance)} over the agreed freight)` : ''}.`); nav(`/logistics/freight-bills/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Enter freight bill" width={820}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.transporterId || !f.billNo || !lines.length} onClick={save}>Enter bill</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Transporter" htmlFor="fb-tr" required><Select id="fb-tr" value={f.transporterId} onChange={(e) => { setF({ ...f, transporterId: e.target.value }); setAmt({}); }}><option value="">Select…</option>
          {(trs.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}</Select></Field>
        <Field label="Their bill number" htmlFor="fb-no" required><Input id="fb-no" value={f.billNo} onChange={(e) => setF({ ...f, billNo: e.target.value })} /></Field>
        <Field label="Bill date" htmlFor="fb-date" required><Input id="fb-date" type="date" max={today()} value={f.billDate} onChange={(e) => setF({ ...f, billDate: e.target.value })} /></Field>
        <Field label="Due date" htmlFor="fb-due" required><Input id="fb-due" type="date" min={f.billDate} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        <Field label="GST rate on the bill (%)" htmlFor="fb-gst"><Input id="fb-gst" type="number" min="0" max="28" step="0.01" value={f.gstRate} onChange={(e) => setF({ ...f, gstRate: e.target.value })} /></Field>
        <label className="mt-7 inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={f.reverseCharge} onChange={(e) => setF({ ...f, reverseCharge: e.target.checked })} />GST under reverse charge (we pay it)</label>
      </div>
      <p className="mb-2 mt-4 font-semibold">Shipments carried, freight paid by us, not yet billed</p>
      {!f.transporterId ? <p className="text-ink-2">Choose the transporter.</p> : !ships.data?.data.length ? <p className="text-ink-2">No unbilled shipments for this transporter.</p> : (
        <table className="w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Shipment</th><th className="py-2">Dealer</th><th className="py-2 text-right">Agreed freight</th><th className="w-36 py-2 text-right">Billed</th></tr></thead>
          <tbody>{ships.data.data.map((s) => (
            <tr key={s.id} className="border-b border-line last:border-0"><td className="py-2"><span className="num">{s.docNo}</span> <span className="text-ink-2">LR {s.lrNo} · {fmtDate(s.dispatchedAt)}</span></td>
              <td className="py-2">{s.partyName}, {s.city}</td><td className="py-2 text-right num">{s.freightAmount ? fmtINR(s.freightAmount) : '—'}</td>
              <td className="py-2 pl-3"><Input aria-label={`Freight billed for ${s.docNo}`} type="number" min="0" step="0.01" value={amt[s.id] ?? ''} disabled={!!le && le !== s.legalEntityId}
                onChange={(e) => setAmt({ ...amt, [s.id]: e.target.value })} /></td></tr>))}</tbody></table>
      )}
      {lines.length > 0 && <p className={`mt-3 rounded-md px-3 py-2 text-[14px] ${taxable > agreed + 0.004 ? 'bg-warning-bg text-warning-text' : 'bg-canvas'}`}>
        Billed {fmtINR(taxable)} against {fmtINR(agreed)} agreed{taxable > agreed + 0.004 ? ` — ${fmtINR(taxable - agreed)} more; above the tolerance the finance head approves too` : ''}.
        {f.reverseCharge ? ` GST ${fmtINR(taxable * (Number(f.gstRate) || 0) / 100)} is payable by us under RCM.` : ''}</p>}
    </Modal>
  );
}

export function FreightBillDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['freight-bill', id], queryFn: () => api<FreightBill & { lines: { id: string; shipmentId: string; shipmentNo: string; lrNo: string; dispatchedAt: string; partyName: string; amount: string; agreed: string | null }[];
    approval: { id: string; docNo: string; status: string } | null; allowedActions: string[] }>(`/freight-bills/${id}`) });
  const [cancel, setCancel] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const b = q.data;
  if (!b) return <ErrorBanner error={q.error} />;
  return (
    <>
      <PageHeader title={b.docNo} crumbs={<Link to="/logistics/freight-bills" className="hover:text-primary">Freight Bills</Link>}
        subtitle={<span>{b.transporterName} bill {b.billNo} · <StatusBadge status={b.status} /></span>}
        actions={b.allowedActions.includes('cancel') && <Button variant="secondary" onClick={() => setCancel(true)}>Cancel bill</Button>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Shipments" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Shipment</th><th className={th}>Dealer</th><th className={`${th} text-right`}>Agreed</th><th className={`${th} text-right`}>Billed</th></tr></thead>
            <tbody>{b.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/logistics/shipments/${l.shipmentId}`}>{l.shipmentNo}</Link> <span className="text-ink-2">LR {l.lrNo}</span></td>
                <td className={th}>{l.partyName}</td><td className={`${th} text-right num`}>{l.agreed ? fmtINR(l.agreed) : '—'}</td>
                <td className={`${th} text-right num ${n(l.amount) > n(l.agreed) ? 'text-warning-text' : ''}`}>{fmtINR(l.amount)}</td></tr>))}</tbody></table></div>
        </Card>
        <div className="space-y-6">
          <Card title="Bill">
            <KeyValues columns="narrow" items={[['Transporter GSTIN', b.transporterGstin ?? '—'], ['Bill date / due', `${fmtDate(b.billDate)} / ${fmtDate(b.dueDate)}`], ['Freight', fmtINR(b.taxableTotal)],
              ['GST', `${fmtINR(b.gstAmount)} at ${n(b.gstRate)}%${b.reverseCharge ? ' — reverse charge, paid by us' : ''}`], ['Payable to transporter', <b key="p">{fmtINR(b.grandTotal)}</b>],
              ['Over agreed freight', n(b.variance) ? fmtINR(b.variance) : '—'], ['Paid', fmtINR(b.amountSettled)],
              ['Approval', b.approval ? <Link key="a" className="text-primary" to={`/approvals/${b.approval.id}`}>{b.approval.docNo} · {humanize(b.approval.status)}</Link> : '—'],
              ['Entered', `${b.createdBy}, ${fmtDateTime(b.createdAt)}`], ['Note', b.statusReason ?? b.remarks ?? '—']]} />
          </Card>
          <DocumentsPanel entityType="logistics.freight_bill" entityId={b.id} />
        </div>
      </div>
      <ReasonDialog open={cancel} danger title={`Cancel ${b.docNo}`} confirmLabel="Cancel bill" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/freight-bills/${id}/cancel`, { body: { reason } }); toast('success', `${b.docNo} cancelled; its shipments can be billed again.`); await qc.invalidateQueries(); }} />
    </>
  );
}

// ---------------------------------------------------------------- payables ageing and vendor ledger (FIN-011)
export function PayablesAgeingPage() {
  const q = useQuery({ queryKey: ['payables-ageing'], queryFn: () => api<{ asOf: string; data: { type: string; id: string; code: string; name: string; notDue: number; d1to30: number; d31to60: number; over60: number; total: number; overdue: number; debitNotes: number }[]; totals: Record<string, number> }>('/payables/ageing') });
  const t = q.data?.totals;
  return (
    <>
      <PageHeader title="Payables Ageing" subtitle="What we owe vendors and transporters on approved bills, by days past the due date. Open debit notes are shown to adjust before paying." />
      {t && <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">{[['Payable', t.total], ['Overdue', t.overdue], ['Due in future', t.notDue], ['Open debit notes', t.debitNotes]].map(([k, v]) => (
        <Card key={k as string}><p className="text-[13px] text-ink-2">{k}</p><p className="mt-1 text-[22px] font-semibold num">{fmtINR(v as number)}</p></Card>))}</div>}
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="Nothing payable" text="No approved bills are open." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Payee</th><th className={`${th} text-right`}>Not due</th><th className={`${th} text-right`}>1–30</th>
            <th className={`${th} text-right`}>31–60</th><th className={`${th} text-right`}>60+</th><th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>Debit notes</th></tr></thead>
            <tbody>{q.data.data.map((x) => (
              <tr key={`${x.type}${x.id}`} className="border-b border-line last:border-0"><td className="px-5 py-3">{x.type === 'VENDOR' ? <Link className="font-semibold text-primary" to={`/finance/vendor-ledger/${x.id}`}>{x.name}</Link> : <span className="font-semibold">{x.name}</span>}
                <div className="text-[13px] text-ink-2">{x.code} · {x.type === 'VENDOR' ? 'vendor' : 'transporter'}</div></td>
                {(['notDue', 'd1to30', 'd31to60', 'over60'] as const).map((k) => <td key={k} className={`${th} text-right num ${k !== 'notDue' && x[k] > 0 ? 'text-danger-text' : ''}`}>{x[k] ? fmtINR(x[k]) : '—'}</td>)}
                <td className={`${th} text-right num font-semibold`}>{fmtINR(x.total)}</td><td className={`${th} text-right num`}>{x.debitNotes ? fmtINR(x.debitNotes) : '—'}</td></tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function VendorLedgerPage() {
  const { partyId } = useParams();
  const [from, setFrom] = useState(`${Number(today().slice(0, 4)) - (Number(today().slice(5, 7)) < 4 ? 1 : 0)}-04-01`);
  const q = useQuery({ queryKey: ['vendor-ledger', partyId, from], queryFn: () => api<{ party: { code: string; name: string; gstin: string | null }; from: string; to: string; opening: number; closing: number;
    lines: { date: string; kind: string; ref: string; id: string; note: string; debit: number; credit: number; balance: number }[] }>(`/payables/statement/vendor/${partyId}?from=${from}`) });
  const s = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!s) return <ErrorBanner error={q.error} />;
  const bal = (v: number) => `${fmtINR(Math.abs(v))} ${v >= 0 ? 'Cr' : 'Dr'}`;
  const link = (k: string, id: string) => (k === 'Supplier invoice' ? `/purchase/invoices/${id}` : k === 'Payment' ? `/finance/payments/${id}` : null);
  return (
    <>
      <PageHeader title={`Vendor ledger — ${s.party.name}`} crumbs={<Link to="/finance/payables" className="hover:text-primary"><ArrowLeft size={14} className="inline" /> Payables Ageing</Link>}
        subtitle={`${s.party.code}${s.party.gstin ? ` · GSTIN ${s.party.gstin}` : ''} · Cr = we owe the vendor`}
        actions={<><Input aria-label="From" type="date" className="w-44" value={from} onChange={(e) => setFrom(e.target.value)} /><Button icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></>} />
      <Card padded={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Date</th><th className={th}>Document</th><th className={th}>Details</th>
          <th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Balance</th></tr></thead>
          <tbody><tr className="border-b border-line bg-canvas"><td className="px-5 py-3" colSpan={5}>Opening balance on {fmtDate(s.from)}</td><td className={`${th} text-right num font-semibold`}>{bal(s.opening)}</td></tr>
            {s.lines.map((l, i) => { const to = link(l.kind, l.id); return (
              <tr key={`${l.id}${i}`} className="border-b border-line last:border-0"><td className="px-5 py-3">{fmtDate(l.date)}</td>
                <td className={th}>{l.kind} {to ? <Link className="text-primary num" to={to}>{l.ref}</Link> : <span className="num">{l.ref}</span>}</td><td className={`${th} text-ink-2`}>{l.note}</td>
                <td className={`${th} text-right num`}>{l.debit ? fmtINR(l.debit) : ''}</td><td className={`${th} text-right num`}>{l.credit ? fmtINR(l.credit) : ''}</td><td className={`${th} text-right num`}>{bal(l.balance)}</td></tr>); })}
            <tr className="bg-canvas font-semibold"><td className="px-5 py-3" colSpan={5}>Closing balance on {fmtDate(s.to)}</td><td className={`${th} text-right num`}>{bal(s.closing)}</td></tr></tbody></table></div>
      </Card>
    </>
  );
}
