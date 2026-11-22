import { ArrowLeft, Plus, Printer, Warning } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR } from '../../lib/format';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
const MODES: Record<string, string> = { NEFT: 'NEFT', RTGS: 'RTGS', IMPS: 'IMPS', UPI: 'UPI', CHEQUE: 'Cheque', DD: 'Demand draft', CASH: 'Cash' };

interface Receipt { id: string; docNo: string; legalEntityId: string; legalEntityName: string; partyId: string; partyName: string; partyCode: string; receiptDate: string; mode: string; reference: string | null;
  instrumentDate: string | null; draweeBank: string | null; depositAccount: string | null; amount: string; allocated: string; onAccount: string; status: string; statusReason: string | null;
  bouncedOn: string | null; remarks: string | null; createdAt: string; createdBy: string }
interface ReceiptDetail extends Receipt { allocations: { id: string; invoiceId: string; invoiceNo: string; invoiceDate: string; amount: string; status: string; allocatedAt: string; allocatedBy: string;
  reversedAt: string | null; reversalReason: string | null }[]; allowedActions: string[] }
interface OpenInvoice { id: string; docNo: string; invoiceDate: string; dueDate: string; grandTotal: string; outstanding: string; daysOverdue: number }

// ---------------------------------------------------------------- receipts (FIN-006, FIN-007)
export function CustomerReceiptsPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'Posted' | 'OnAccount' | 'Bounced' | 'All'>('Posted');
  const [open, setOpen] = useState(!!sp.get('partyId'));
  const q = useQuery({ queryKey: ['receipts'], queryFn: () => api<{ data: Receipt[] }>('/receipts') });
  const rows = (q.data?.data ?? []).filter((r) => tab === 'All' || (tab === 'OnAccount' ? r.status === 'Posted' && n(r.onAccount) > 0 : r.status === tab));
  return (
    <>
      <PageHeader title="Receipts" subtitle="Money received from dealers, allocated to their invoices oldest-due first. What is not allocated stays on account; a bounced cheque puts the invoices back as due."
        actions={can('finance.receipt:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Record receipt</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'Posted', label: 'Posted' }, { value: 'OnAccount', label: 'On account' }, { value: 'Bounced', label: 'Bounced' }, { value: 'All', label: 'All' }]} />
      <Card padded={false} className="mt-4">
        {q.isLoading ? <Skeleton className="h-40" /> : q.error ? <div className="p-5"><ErrorBanner error={q.error} /></div> : !rows.length ? <div className="p-5"><EmptyState title="No receipts here" text="Record a payment received from a dealer." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Receipt</th><th className={th}>Date</th><th className={th}>Dealer</th>
            <th className={th}>Mode / reference</th><th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>On account</th><th className={th}>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/finance/receipts/${r.id}`}>{r.docNo}</Link></td>
                <td className={th}>{fmtDate(r.receiptDate)}</td><td className={th}>{r.partyName}</td><td className={th}>{MODES[r.mode]}{r.reference ? ` · ${r.reference}` : ''}</td>
                <td className={`${th} text-right num`}>{fmtINR(r.amount)}</td><td className={`${th} text-right num`}>{r.status === 'Posted' && n(r.onAccount) > 0 ? fmtINR(r.onAccount) : '—'}</td>
                <td className={th}><StatusBadge status={r.status === 'Bounced' ? 'Rejected' : r.status} label={r.status} /></td></tr>))}</tbody></table></div>
        )}
      </Card>
      {open && <ReceiptDialog partyId={sp.get('partyId')} onClose={() => setOpen(false)} />}
    </>
  );
}

function ReceiptDialog({ partyId, onClose }: { partyId: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/legal-entities?status=Active&limit=100') });
  const dealers = useQuery({ queryKey: ['dealers-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/dealers?status=Active&limit=100') });
  const [f, setF] = useState({ legalEntityId: '', partyId: partyId ?? '', receiptDate: today(), mode: 'NEFT', reference: '', instrumentDate: '', draweeBank: '', depositAccount: '', amount: '', remarks: '' });
  const [how, setHow] = useState<'auto' | 'choose' | 'none'>('auto');
  const [split, setSplit] = useState<Record<string, string>>({});
  useEffect(() => { const e = entities.data?.data; if (e?.length === 1 && !f.legalEntityId) setF((x) => ({ ...x, legalEntityId: e[0]!.id })); }, [entities.data, f.legalEntityId]);
  const inv = useQuery({ queryKey: ['open-invoices', f.partyId, f.legalEntityId], enabled: !!f.partyId && !!f.legalEntityId,
    queryFn: () => api<{ data: OpenInvoice[] }>(`/receipts/open-invoices?partyId=${f.partyId}&legalEntityId=${f.legalEntityId}`) });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const instrument = ['CHEQUE', 'DD'].includes(f.mode);
  const amount = Number(f.amount) || 0;
  const chosen = Object.entries(split).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) || 0 })).filter((x) => x.amount > 0);
  const chosenSum = chosen.reduce((a, x) => a + x.amount, 0);
  const due = (inv.data?.data ?? []).reduce((a, x) => a + n(x.outstanding), 0);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string; allocated: number; onAccount: number }>('/receipts', { body: { legalEntityId: f.legalEntityId, partyId: f.partyId, receiptDate: f.receiptDate, mode: f.mode,
        reference: f.reference || null, instrumentDate: instrument ? f.instrumentDate || null : null, draweeBank: f.draweeBank || null, depositAccount: f.depositAccount || null, amount, remarks: f.remarks || null,
        allocation: how === 'choose' ? chosen : how } });
      toast('success', `${r.docNo}: ${fmtINR(r.allocated)} allocated${r.onAccount ? `, ${fmtINR(r.onAccount)} on account` : ''}.`); nav(`/finance/receipts/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Record receipt" width={780}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button loading={busy} disabled={!f.legalEntityId || !f.partyId || amount <= 0 || (f.mode !== 'CASH' && !f.reference) || (instrument && !f.instrumentDate) || (how === 'choose' && chosenSum > amount + 0.004)} onClick={save}>Post receipt</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Received by (entity)" htmlFor="rc-le" required><Select id="rc-le" value={f.legalEntityId} onChange={(e) => setF({ ...f, legalEntityId: e.target.value })}><option value="">Select…</option>
          {(entities.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
        <Field label="Dealer" htmlFor="rc-party" required><Select id="rc-party" value={f.partyId} onChange={(e) => { setF({ ...f, partyId: e.target.value }); setSplit({}); }}><option value="">Select…</option>
          {(dealers.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.legalName} ({x.code})</option>)}</Select></Field>
        <Field label="Date received" htmlFor="rc-date" required><Input id="rc-date" type="date" max={today()} value={f.receiptDate} onChange={(e) => setF({ ...f, receiptDate: e.target.value })} /></Field>
        <Field label="Mode" htmlFor="rc-mode" required><Select id="rc-mode" value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label={instrument ? `${MODES[f.mode]} number` : 'UTR / reference'} htmlFor="rc-ref" required={f.mode !== 'CASH'}><Input id="rc-ref" value={f.reference} disabled={f.mode === 'CASH'} onChange={(e) => setF({ ...f, reference: e.target.value.trim() })} /></Field>
        <Field label="Amount (₹)" htmlFor="rc-amt" required hint={f.mode === 'CASH' ? 'Cash from one dealer in a day must stay below ₹2 lakh (s.269ST)' : undefined}><Input id="rc-amt" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        {instrument && <><Field label="Instrument date" htmlFor="rc-idate" required><Input id="rc-idate" type="date" value={f.instrumentDate} onChange={(e) => setF({ ...f, instrumentDate: e.target.value })} /></Field>
          <Field label="Drawee bank" htmlFor="rc-bank"><Input id="rc-bank" value={f.draweeBank} onChange={(e) => setF({ ...f, draweeBank: e.target.value })} /></Field></>}
        <Field label="Deposited into" htmlFor="rc-dep"><Input id="rc-dep" placeholder="Our bank account" value={f.depositAccount} onChange={(e) => setF({ ...f, depositAccount: e.target.value })} /></Field>
      </div>
      <div className="mt-4">
        <p className="mb-2 font-semibold">Allocate to invoices {inv.data ? <span className="font-normal text-ink-2">· {fmtINR(due)} outstanding</span> : null}</p>
        <div className="mb-3 flex flex-wrap gap-4 text-[14px]">{([['auto', 'Oldest due first'], ['choose', 'Choose invoices'], ['none', 'Keep on account']] as const).map(([k, v]) => (
          <label key={k} className="inline-flex items-center gap-2"><input type="radio" name="rc-how" checked={how === k} onChange={() => setHow(k)} />{v}</label>))}</div>
        {how !== 'none' && (inv.data?.data.length ? (
          <table className="w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Invoice</th><th className="py-2">Due</th><th className="py-2 text-right">Outstanding</th>{how === 'choose' && <th className="w-36 py-2 text-right">Allocate</th>}</tr></thead>
            <tbody>{inv.data.data.map((i) => (
              <tr key={i.id} className="border-b border-line last:border-0"><td className="py-2 num">{i.docNo}</td><td className={`py-2 ${i.daysOverdue > 0 ? 'text-danger-text' : ''}`}>{fmtDate(i.dueDate)}{i.daysOverdue > 0 ? ` · ${i.daysOverdue} days overdue` : ''}</td>
                <td className="py-2 text-right num">{fmtINR(i.outstanding)}</td>
                {how === 'choose' && <td className="py-2 pl-3"><Input aria-label={`Allocate to ${i.docNo}`} type="number" min="0" max={n(i.outstanding)} step="0.01" value={split[i.id] ?? ''} onChange={(e) => setSplit({ ...split, [i.id]: e.target.value })} /></td>}</tr>))}</tbody></table>
        ) : <p className="text-ink-2">{f.partyId && f.legalEntityId ? 'No open invoices — the whole amount stays on account.' : 'Choose the entity and dealer to see open invoices.'}</p>)}
        {how === 'choose' && chosenSum > amount + 0.004 && <p className="mt-2 text-danger-text">You are allocating {fmtINR(chosenSum)}, more than the {fmtINR(amount)} received.</p>}
      </div>
    </Modal>
  );
}

export function CustomerReceiptDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => api<ReceiptDetail>(`/receipts/${id}`) });
  const [dialog, setDialog] = useState<null | 'cancel' | 'bounce' | { reverse: string }>(null);
  const [bounce, setBounce] = useState({ bouncedOn: today(), reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const r = q.data;
  if (!r) return <ErrorBanner error={q.error} />;
  const can = (a: string) => r.allowedActions.includes(a);
  const refresh = () => qc.invalidateQueries();
  const autoAllocate = async () => {
    setBusy(true);
    try { const o = await api<{ allocated: number }>(`/receipts/${id}/allocate`, { body: { allocation: 'auto' } }); toast('success', o.allocated ? `${fmtINR(o.allocated)} allocated.` : 'No open invoices to allocate to.'); await refresh(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Could not allocate.'); } finally { setBusy(false); }
  };
  const doBounce = async () => {
    setBusy(true); setError(null);
    try { await api(`/receipts/${id}/bounce`, { body: bounce }); toast('success', `${r.docNo} marked bounced; its invoices are due again.`); setDialog(null); await refresh(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={r.docNo} crumbs={<Link to="/finance/receipts" className="hover:text-primary">Receipts</Link>}
        subtitle={<span>{r.partyName} · {fmtINR(r.amount)} by {MODES[r.mode]} · <StatusBadge status={r.status === 'Bounced' ? 'Rejected' : r.status} label={r.status} /></span>}
        actions={<>
          {can('cancel') && <Button variant="secondary" onClick={() => setDialog('cancel')}>Cancel receipt</Button>}
          {can('bounce') && <Button variant="secondary" onClick={() => setDialog('bounce')}>Mark bounced</Button>}
          {can('allocate') && <Button loading={busy} onClick={autoAllocate}>Allocate on-account amount</Button>}
        </>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Allocations" padded={false}>
          {!r.allocations.length ? <div className="p-5"><EmptyState title="Not allocated" text="The whole amount is on account." /></div> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Invoice</th><th className={`${th} text-right`}>Amount</th><th className={th}>Allocated</th><th className={th}>Status</th><th className={th} /></tr></thead>
              <tbody>{r.allocations.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/finance/invoices/${a.invoiceId}`}>{a.invoiceNo}</Link></td>
                  <td className={`${th} text-right num`}>{fmtINR(a.amount)}</td><td className={th}>{a.allocatedBy}, {fmtDateTime(a.allocatedAt)}</td>
                  <td className={th}>{a.status === 'Active' ? <StatusBadge status="Active" /> : <span><StatusBadge status="Cancelled" label="Reversed" /><div className="text-[13px] text-ink-2">{a.reversalReason}</div></span>}</td>
                  <td className={th}>{a.status === 'Active' && can('unallocate') && <Button size="sm" variant="ghost" onClick={() => setDialog({ reverse: a.id })}>Reverse</Button>}</td></tr>))}</tbody></table></div>
          )}
        </Card>
        <div className="space-y-6">
          <Card title="Receipt">
            <KeyValues columns="narrow" items={[['Entity', r.legalEntityName], ['Dealer', <Link key="p" className="text-primary" to={`/finance/statements/${r.partyId}`}>{r.partyName} — statement</Link>], ['Date', fmtDate(r.receiptDate)],
              ['Mode', `${MODES[r.mode]}${r.reference ? ` · ${r.reference}` : ''}`], ...(r.instrumentDate ? [['Instrument', `${fmtDate(r.instrumentDate)}${r.draweeBank ? ` · ${r.draweeBank}` : ''}`] as [string, string]] : []),
              ['Deposited into', r.depositAccount ?? '—'], ['Amount', fmtINR(r.amount)], ['Allocated', fmtINR(r.allocated)], ['On account', fmtINR(r.onAccount)],
              ...(r.bouncedOn ? [['Bounced', `${fmtDate(r.bouncedOn)} — ${r.statusReason}`] as [string, string]] : r.status === 'Cancelled' ? [['Cancelled', r.statusReason ?? '—'] as [string, string]] : []),
              ['Recorded', `${r.createdBy}, ${fmtDateTime(r.createdAt)}`]]} />
          </Card>
          <DocumentsPanel entityType="fin.receipt" entityId={r.id} />
        </div>
      </div>
      <ReasonDialog open={dialog === 'cancel'} danger title={`Cancel ${r.docNo}`} description="For a wrong entry. Its allocations are reversed." confirmLabel="Cancel receipt" onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`/receipts/${id}/cancel`, { body: { reason } }); toast('success', `${r.docNo} cancelled.`); await refresh(); }} />
      <ReasonDialog open={typeof dialog === 'object' && dialog !== null} title="Reverse allocation" description="The amount goes back on account and the invoice is due again." confirmLabel="Reverse" onClose={() => setDialog(null)}
        onConfirm={async (reason) => { if (typeof dialog === 'object' && dialog) await api(`/receipts/${id}/allocations/${dialog.reverse}/reverse`, { body: { reason } }); toast('success', 'Allocation reversed.'); await refresh(); }} />
      <Modal open={dialog === 'bounce'} onClose={() => setDialog(null)} title={`${MODES[r.mode]} ${r.reference} bounced`} description="Its allocations are reversed and the invoices fall due again."
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={busy} disabled={!bounce.reason.trim()} onClick={doBounce}>Mark bounced</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Returned on" htmlFor="bn-on" required><Input id="bn-on" type="date" min={r.receiptDate} max={today()} value={bounce.bouncedOn} onChange={(e) => setBounce({ ...bounce, bouncedOn: e.target.value })} /></Field>
          <Field label="Bank's reason" htmlFor="bn-reason" required><Input id="bn-reason" placeholder="e.g. Funds insufficient" value={bounce.reason} onChange={(e) => setBounce({ ...bounce, reason: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- ageing (FIN-005, FIN-008)
interface AgeRow { partyId: string; partyCode: string; partyName: string; territory: string | null; creditLimit: number; creditDays: number; notDue: number; d1to30: number; d31to60: number; d61to90: number;
  d91to180: number; over180: number; total: number; overdue: number; oldestDays: number; onAccount: number }
const BUCKETS: [keyof AgeRow, string][] = [['notDue', 'Not due'], ['d1to30', '1–30'], ['d31to60', '31–60'], ['d61to90', '61–90'], ['d91to180', '91–180'], ['over180', '180+']];

export function AgeingPage() {
  const [asOf, setAsOf] = useState(today());
  const q = useQuery({ queryKey: ['ageing', asOf], queryFn: () => api<{ asOf: string; data: AgeRow[]; totals: Record<string, number>; overdueAlert: boolean; overdueAlertValue: number }>(`/receivables/ageing?asOf=${asOf}`) });
  const t = q.data?.totals;
  return (
    <>
      <PageHeader title="Receivables Ageing" subtitle="What each dealer owes, by days past the due date. A dealer with anything overdue cannot have new orders submitted (D18)."
        actions={<Field label="As of" htmlFor="ag-asof"><Input id="ag-asof" type="date" max={today()} value={asOf} onChange={(e) => setAsOf(e.target.value || today())} /></Field>} />
      {q.data?.overdueAlert && <p className="mb-4 flex items-center gap-2 rounded-md bg-danger-bg px-4 py-3 text-danger-text"><Warning size={20} weight="fill" aria-hidden />Overdue debt {fmtINR(t?.overdue)} is above the {fmtINR(q.data.overdueAlertValue)} alert level.</p>}
      {t && (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          {[['Outstanding', t.total], ['Overdue', t.overdue], ['Over 90 days', (t.d91to180 ?? 0) + (t.over180 ?? 0)], ['On account (unapplied)', t.onAccount]].map(([k, v]) => (
            <Card key={k as string}><p className="text-[13px] text-ink-2">{k}</p><p className={`mt-1 text-[22px] font-semibold num ${k === 'Overdue' && Number(v) > 0 ? 'text-danger-text' : ''}`}>{fmtINR(v as number)}</p></Card>))}
        </div>
      )}
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : q.error ? <div className="p-5"><ErrorBanner error={q.error} /></div> : !q.data?.data.length ? <div className="p-5"><EmptyState title="Nothing outstanding" text="Every invoice is settled." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Dealer</th><th className={`${th} text-right`}>Limit / days</th>
            {BUCKETS.map(([, l]) => <th key={l} className={`${th} text-right`}>{l}</th>)}<th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>On account</th></tr></thead>
            <tbody>{q.data.data.map((x) => (
              <tr key={x.partyId} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/finance/statements/${x.partyId}`}>{x.partyName}</Link><div className="text-[13px] text-ink-2">{x.partyCode}{x.territory ? ` · ${x.territory}` : ''}{x.overdue > 0 ? ` · oldest ${x.oldestDays} days` : ''}</div></td>
                <td className={`${th} text-right num`}>{fmtINR(x.creditLimit)} / {x.creditDays}</td>
                {BUCKETS.map(([k]) => <td key={k} className={`${th} text-right num ${k !== 'notDue' && n(x[k] as number) > 0 ? 'text-danger-text' : ''}`}>{n(x[k] as number) ? fmtINR(x[k] as number) : '—'}</td>)}
                <td className={`${th} text-right num font-semibold`}>{fmtINR(x.total)}</td><td className={`${th} text-right num`}>{x.onAccount ? fmtINR(x.onAccount) : '—'}</td></tr>))}
              {t && <tr className="bg-canvas font-semibold"><td className="px-5 py-3">Total</td><td className={th} />{BUCKETS.map(([k]) => <td key={k} className={`${th} text-right num`}>{fmtINR(t[k as string])}</td>)}
                <td className={`${th} text-right num`}>{fmtINR(t.total)}</td><td className={`${th} text-right num`}>{fmtINR(t.onAccount)}</td></tr>}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- dealer statement (FIN-008)
interface Statement { party: { id: string; code: string; name: string; gstin: string | null; creditLimit: string; creditDays: number }; from: string; to: string; opening: number; closing: number;
  lines: { date: string; kind: string; ref: string; id: string; note: string; debit: number; credit: number; balance: number }[];
  exposure: { creditLimit: number; outstanding: number; overdue: number; uninvoicedOrders: number; onAccount: number; exposure: number; headroom: number; frozen: boolean; advancePayment: boolean;
    overdueInvoices: { id: string; docNo: string; dueDate: string; outstanding: number; daysOverdue: number }[] } }
const LINK: Record<string, string> = { Invoice: '/finance/invoices/', 'Credit note': '/finance/credit-notes/', Receipt: '/finance/receipts/', 'Cheque bounced': '/finance/receipts/' };
const fy = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };

export function StatementPage() {
  const { partyId } = useParams();
  const { can } = useAuth();
  const [range, setRange] = useState({ from: fy(), to: today() });
  const q = useQuery({ queryKey: ['statement', partyId, range], queryFn: () => api<Statement>(`/receivables/statement/${partyId}?from=${range.from}&to=${range.to}`) });
  const s = q.data;
  useEffect(() => { if (s) document.title = `Statement ${s.party.code}`; return () => { document.title = 'Dhruv Agro ERP'; }; }, [s]);
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!s) return <ErrorBanner error={q.error} />;
  const e = s.exposure;
  const bal = (v: number) => `${fmtINR(Math.abs(v))} ${v >= 0 ? 'Dr' : 'Cr'}`;
  return (
    <>
      <div className="print:hidden">
        <PageHeader title={`Statement — ${s.party.name}`} crumbs={<Link to="/finance/ageing" className="hover:text-primary"><ArrowLeft size={14} className="inline" /> Receivables Ageing</Link>}
          subtitle={`${s.party.code}${s.party.gstin ? ` · GSTIN ${s.party.gstin}` : ''} · credit limit ${fmtINR(s.party.creditLimit)}, ${s.party.creditDays} days`}
          actions={<>
            {can('finance.receipt:create') && <Link to={`/finance/receipts?partyId=${s.party.id}`}><Button variant="secondary" icon={<Plus size={18} />}>Record receipt</Button></Link>}
            <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print statement</Button></>} />
      </div>
      {e.frozen && <p className="mb-4 flex items-center gap-2 rounded-md bg-danger-bg px-4 py-3 text-danger-text print:hidden"><Warning size={20} weight="fill" aria-hidden />
        Order-taking is frozen: {e.overdueInvoices.map((x) => `${x.docNo} (${x.daysOverdue} days overdue, ${fmtINR(x.outstanding)})`).join(', ')}.</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card padded={false} title={<span className="flex flex-wrap items-center gap-3">Ledger
          <span className="flex items-center gap-2 text-[13px] font-normal print:hidden"><Input aria-label="From" type="date" className="h-9 w-40" value={range.from} onChange={(x) => setRange({ ...range, from: x.target.value })} /> to
            <Input aria-label="To" type="date" className="h-9 w-40" max={today()} value={range.to} onChange={(x) => setRange({ ...range, to: x.target.value })} /></span>
          <span className="hidden text-[13px] font-normal print:inline">{fmtDate(s.from)} to {fmtDate(s.to)}</span></span>}>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Date</th><th className={th}>Document</th><th className={th}>Details</th>
            <th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Balance</th></tr></thead>
            <tbody>
              <tr className="border-b border-line bg-canvas"><td className="px-5 py-3" colSpan={5}>Opening balance on {fmtDate(s.from)}</td><td className={`${th} text-right num font-semibold`}>{bal(s.opening)}</td></tr>
              {s.lines.map((l, i) => (
                <tr key={`${l.id}${l.kind}${i}`} className="border-b border-line last:border-0"><td className="px-5 py-3">{fmtDate(l.date)}</td>
                  <td className={th}>{l.kind} <Link className="text-primary num" to={`${LINK[l.kind]}${l.id}`}>{l.ref}</Link></td><td className={`${th} text-ink-2`}>{l.note}</td>
                  <td className={`${th} text-right num`}>{l.debit ? fmtINR(l.debit) : ''}</td><td className={`${th} text-right num`}>{l.credit ? fmtINR(l.credit) : ''}</td><td className={`${th} text-right num`}>{bal(l.balance)}</td></tr>))}
              <tr className="bg-canvas font-semibold"><td className="px-5 py-3" colSpan={5}>Closing balance on {fmtDate(s.to)}</td><td className={`${th} text-right num`}>{bal(s.closing)}</td></tr>
            </tbody></table></div>
        </Card>
        <Card title="Credit position (today)">
          {e.advancePayment ? <p>Advance-payment dealer.</p> : (
            <KeyValues columns="narrow" items={[['Unpaid invoices', fmtINR(e.outstanding)], ['of which overdue', <span key="o" className={e.overdue ? 'text-danger-text' : ''}>{fmtINR(e.overdue)}</span>],
              ['Orders not yet invoiced', fmtINR(e.uninvoicedOrders)], ['Unapplied receipts', `− ${fmtINR(e.onAccount)}`], ['Exposure', <b key="e">{fmtINR(e.exposure)}</b>], ['Credit limit', fmtINR(e.creditLimit)],
              ['Headroom', <span key="h" className={e.headroom < 0 ? 'text-danger-text' : 'text-success-text'}>{fmtINR(e.headroom)}</span>], ['Order-taking', e.frozen ? 'Frozen (overdue)' : 'Open']]} />)}
        </Card>
      </div>
    </>
  );
}
