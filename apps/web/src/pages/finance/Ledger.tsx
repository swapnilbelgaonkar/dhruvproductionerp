import { Lock, LockOpen, Plus, Printer, Trash } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, humanize } from '../../lib/format';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const fyStart = () => `${Number(today().slice(0, 4)) - (Number(today().slice(5, 7)) < 4 ? 1 : 0)}-04-01`;
const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
const drcr = (v: number) => (v ? `${fmtINR(Math.abs(v))} ${v > 0 ? 'Dr' : 'Cr'}` : '—');
const SOURCE_LINK: Record<string, string> = { 'sales.invoice': '/finance/invoices/', 'sales.credit_note': '/finance/credit-notes/', 'fin.receipt': '/finance/receipts/',
  'purchase.supplier_invoice': '/purchase/invoices/', 'logistics.freight_bill': '/logistics/freight-bills/', 'fin.payment': '/finance/payments/' };
const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', stock: 'Stock valuation', 'sales.invoice': 'Sales invoice', 'sales.credit_note': 'Credit note', 'fin.receipt': 'Receipt',
  'purchase.supplier_invoice': 'Supplier invoice', 'purchase.debit_note': 'Debit note', 'logistics.freight_bill': 'Freight bill', 'fin.payment': 'Payment' };
interface Account { id: string; code: string; name: string; type: string; grp: string; systemKey: string | null; partyLedger: boolean; status: string }

/** The legal entity whose books are shown; remembered in the URL. */
function useEntity() {
  const [sp, setSp] = useSearchParams();
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/legal-entities?status=Active&limit=100') });
  const le = sp.get('le') ?? entities.data?.data[0]?.id ?? '';
  const picker = (
    <Field label="Entity" htmlFor="gl-le"><Select id="gl-le" value={le} onChange={(e) => { sp.set('le', e.target.value); setSp(sp, { replace: true }); }}>
      {(entities.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
  );
  return { le, picker, sp, setSp };
}
const useAccounts = () => useQuery({ queryKey: ['gl-accounts'], queryFn: () => api<{ data: Account[] }>('/gl/accounts') });

// ---------------------------------------------------------------- trial balance (FIN-016)
interface TbRow { id: string; code: string; name: string; type: string; grp: string; opening: number; periodDr: number; periodCr: number; closing: number; closingDr: number; closingCr: number }
export function TrialBalancePage() {
  const { le, picker } = useEntity();
  const [range, setRange] = useState({ from: fyStart(), to: today() });
  const q = useQuery({ queryKey: ['tb', le, range], enabled: !!le, queryFn: () => api<{ data: TbRow[]; totals: Record<string, number>; balanced: boolean }>(`/gl/trial-balance?legalEntityId=${le}&from=${range.from}&to=${range.to}`) });
  return (
    <>
      <PageHeader title="Trial Balance" subtitle="Every account's movement and closing balance. Journals are posted automatically from invoices, receipts, bills, payments and stock movements."
        actions={<div className="flex flex-wrap items-end gap-3">{picker}
          <Field label="From" htmlFor="tb-from"><Input id="tb-from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
          <Field label="To" htmlFor="tb-to"><Input id="tb-to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></div>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-60" /> : q.error ? <div className="p-5"><ErrorBanner error={q.error} /></div> : !q.data?.data.length ? <div className="p-5"><EmptyState title="No postings yet" text="Journals appear as documents are raised." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Account</th><th className={th}>Group</th>
            <th className={`${th} text-right`}>Opening</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Closing Dr</th><th className={`${th} text-right`}>Closing Cr</th></tr></thead>
            <tbody>{q.data.data.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="text-primary" to={`/finance/ledger/${r.id}?le=${le}&from=${range.from}&to=${range.to}`}><span className="num">{r.code}</span> {r.name}</Link></td>
                <td className={`${th} text-ink-2`}>{r.grp}</td><td className={`${th} text-right num`}>{drcr(r.opening)}</td><td className={`${th} text-right num`}>{r.periodDr ? fmtINR(r.periodDr) : ''}</td>
                <td className={`${th} text-right num`}>{r.periodCr ? fmtINR(r.periodCr) : ''}</td><td className={`${th} text-right num`}>{r.closingDr ? fmtINR(r.closingDr) : ''}</td><td className={`${th} text-right num`}>{r.closingCr ? fmtINR(r.closingCr) : ''}</td></tr>))}
              <tr className="bg-canvas font-semibold"><td className="px-5 py-3" colSpan={3}>Total {q.data.balanced ? <StatusBadge status="Approved" label="Balanced" /> : <StatusBadge status="Rejected" label="Not balanced" />}</td>
                <td className={`${th} text-right num`}>{fmtINR(q.data.totals.periodDr)}</td><td className={`${th} text-right num`}>{fmtINR(q.data.totals.periodCr)}</td>
                <td className={`${th} text-right num`}>{fmtINR(q.data.totals.closingDr)}</td><td className={`${th} text-right num`}>{fmtINR(q.data.totals.closingCr)}</td></tr></tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function AccountLedgerPage() {
  const { accountId } = useParams();
  const { le, picker, sp, setSp } = useEntity();
  const from = sp.get('from') ?? fyStart(); const to = sp.get('to') ?? today();
  const q = useQuery({ queryKey: ['gl-ledger', le, accountId, from, to], enabled: !!le,
    queryFn: () => api<{ account: Account; opening: number; closing: number; lines: { journalId: string; docNo: string; date: string; sourceType: string; sourceId: string | null; sourceRef: string | null; narration: string; debit: number; credit: number; party: string | null; balance: number }[] }>(
      `/gl/ledger?legalEntityId=${le}&accountId=${accountId}&from=${from}&to=${to}`) });
  const set = (k: string, v: string) => { sp.set(k, v); setSp(sp, { replace: true }); };
  const a = q.data?.account;
  return (
    <>
      <PageHeader title={a ? `${a.code} ${a.name}` : 'Account ledger'} crumbs={<Link to={`/finance/trial-balance?le=${le}`} className="hover:text-primary">Trial Balance</Link>}
        actions={<div className="flex flex-wrap items-end gap-3">{picker}<Field label="From" htmlFor="lg-from"><Input id="lg-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="To" htmlFor="lg-to"><Input id="lg-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></Field></div>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-60" /> : !q.data ? <div className="p-5"><ErrorBanner error={q.error} /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Date</th><th className={th}>Journal</th><th className={th}>Source</th><th className={th}>Narration</th>
            <th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th><th className={`${th} text-right`}>Balance</th></tr></thead>
            <tbody><tr className="border-b border-line bg-canvas"><td className="px-5 py-3" colSpan={6}>Opening balance</td><td className={`${th} text-right num font-semibold`}>{drcr(q.data.opening)}</td></tr>
              {q.data.lines.map((l, i) => (
                <tr key={`${l.journalId}${i}`} className="border-b border-line last:border-0"><td className="px-5 py-3">{fmtDate(l.date)}</td>
                  <td className={th}><Link className="text-primary num" to={`/finance/journals/${l.journalId}`}>{l.docNo}</Link></td>
                  <td className={th}>{SOURCE_LABEL[l.sourceType] ?? l.sourceType} {l.sourceId && SOURCE_LINK[l.sourceType] ? <Link className="text-primary num" to={`${SOURCE_LINK[l.sourceType]}${l.sourceId}`}>{l.sourceRef}</Link> : <span className="num">{l.sourceRef}</span>}</td>
                  <td className={`${th} text-ink-2`}>{l.narration}{l.party ? ` · ${l.party}` : ''}</td><td className={`${th} text-right num`}>{l.debit ? fmtINR(l.debit) : ''}</td>
                  <td className={`${th} text-right num`}>{l.credit ? fmtINR(l.credit) : ''}</td><td className={`${th} text-right num`}>{drcr(l.balance)}</td></tr>))}
              <tr className="bg-canvas font-semibold"><td className="px-5 py-3" colSpan={6}>Closing balance</td><td className={`${th} text-right num`}>{drcr(q.data.closing)}</td></tr></tbody></table></div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- journals (FIN-013, FIN-014)
interface JournalRow { id: string; docNo: string; journalDate: string; originalDate: string | null; sourceType: string; sourceId: string | null; sourceRef: string | null; narration: string; status: string; amount: string }
export function JournalsPage() {
  const { can } = useAuth();
  const { le, picker } = useEntity();
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const list = useQuery({ queryKey: ['journals', le, type, q], enabled: !!le, queryFn: () => api<{ data: JournalRow[] }>(`/gl/journals?legalEntityId=${le}${type ? `&sourceType=${type}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <>
      <PageHeader title="Journals" subtitle="Every posting in the books. Automatic journals come from the documents; manual journals are drafted by accounts and posted by another person."
        actions={<div className="flex flex-wrap items-end gap-3">{picker}{can('finance.gl:journal') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Manual journal</Button>}</div>} />
      <div className="mb-4 flex flex-wrap gap-3">
        <Select aria-label="Source" className="w-56" value={type} onChange={(e) => setType(e.target.value)}><option value="">All sources</option>{Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Input aria-label="Search journals" placeholder="Journal, document or narration" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card padded={false}>
        {list.isLoading ? <Skeleton className="h-60" /> : !list.data?.data.length ? <div className="p-5"><EmptyState title="No journals" text="Nothing matches." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Journal</th><th className={th}>Date</th><th className={th}>Source</th><th className={th}>Narration</th>
            <th className={`${th} text-right`}>Amount</th><th className={th}>Status</th></tr></thead>
            <tbody>{list.data.data.map((j) => (
              <tr key={j.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/finance/journals/${j.id}`}>{j.docNo}</Link></td>
                <td className={th}>{fmtDate(j.journalDate)}{j.originalDate ? <div className="text-[12px] text-warning-text">dated {fmtDate(j.originalDate)} (locked period)</div> : null}</td>
                <td className={th}>{SOURCE_LABEL[j.sourceType] ?? j.sourceType} <span className="num text-ink-2">{j.sourceRef}</span></td><td className={`${th} text-ink-2`}>{j.narration}</td>
                <td className={`${th} text-right num`}>{j.amount ? fmtINR(j.amount) : '—'}</td><td className={th}><StatusBadge status={j.status === 'Posted' ? 'Posted' : j.status} /></td></tr>))}</tbody></table></div>
        )}
      </Card>
      {open && <JournalDialog le={le} onClose={() => setOpen(false)} />}
    </>
  );
}

function JournalDialog({ le, onClose }: { le: string; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const accts = useAccounts();
  const dealers = useQuery({ queryKey: ['dealers-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/dealers?status=Active&limit=100').catch(() => ({ data: [], total: 0 })) });
  const vendors = useQuery({ queryKey: ['vendors-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/vendors?status=Active&limit=100').catch(() => ({ data: [], total: 0 })) });
  const parties = [...(dealers.data?.data ?? []), ...(vendors.data?.data ?? [])];
  const [date, setDate] = useState(today());
  const [narration, setNarration] = useState('');
  const blank = () => ({ accountId: '', debit: '', credit: '', partyId: '' });
  const [lines, setLines] = useState([blank(), blank()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const dr = lines.reduce((a, l) => a + (Number(l.debit) || 0), 0); const cr = lines.reduce((a, l) => a + (Number(l.credit) || 0), 0);
  const accById = (id: string) => accts.data?.data.find((a) => a.id === id);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string }>('/gl/journals', { body: { legalEntityId: le, date, narration,
        lines: lines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, partyId: l.partyId || null })) } });
      toast('success', `${r.docNo} drafted. Another person posts it.`); nav(`/finance/journals/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Manual journal" description="For entries no document makes: accruals, depreciation, bank charges, corrections. It is posted by someone other than you." width={860}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={narration.trim().length < 5 || !dr || Math.abs(dr - cr) > 0.004} onClick={save}>Draft journal</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-[180px_1fr]">
        <Field label="Date" htmlFor="jv-date" required><Input id="jv-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Narration" htmlFor="jv-nar" required><Input id="jv-nar" value={narration} onChange={(e) => setNarration(e.target.value)} /></Field>
      </div>
      <table className="mt-4 w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Account</th><th className="py-2">Party</th><th className="w-32 py-2 text-right">Debit</th><th className="w-32 py-2 text-right">Credit</th><th className="w-10" /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i} className="border-b border-line last:border-0">
            <td className="py-2 pr-2"><Select aria-label={`Account of line ${i + 1}`} value={l.accountId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}><option value="">Select…</option>
              {(accts.data?.data ?? []).filter((a) => a.status === 'Active').map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></td>
            <td className="py-2 pr-2">{accById(l.accountId)?.partyLedger ? <Select aria-label={`Party of line ${i + 1}`} value={l.partyId} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, partyId: e.target.value } : x)))}><option value="">Select…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.legalName} ({p.code})</option>)}</Select> : <span className="text-ink-2">—</span>}</td>
            <td className="py-2 pr-2"><Input aria-label={`Debit of line ${i + 1}`} type="number" min="0" step="0.01" value={l.debit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, debit: e.target.value, credit: e.target.value ? '' : x.credit } : x)))} /></td>
            <td className="py-2 pr-2"><Input aria-label={`Credit of line ${i + 1}`} type="number" min="0" step="0.01" value={l.credit} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, credit: e.target.value, debit: e.target.value ? '' : x.debit } : x)))} /></td>
            <td className="py-2">{lines.length > 2 && <Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash size={16} /></Button>}</td></tr>))}
          <tr className="font-semibold"><td className="py-2" colSpan={2}><Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setLines([...lines, blank()])}>Add line</Button></td>
            <td className="py-2 pr-2 text-right num">{fmtINR(dr)}</td><td className="py-2 pr-2 text-right num">{fmtINR(cr)}</td><td /></tr></tbody></table>
      {Math.abs(dr - cr) > 0.004 && <p className="mt-2 text-danger-text">Debits and credits differ by {fmtINR(Math.abs(dr - cr))}.</p>}
    </Modal>
  );
}

export function JournalDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['journal', id], queryFn: () => api<JournalRow & { legalEntityName: string; sourceEvent: string; reversalOf: string | null; createdAt: string; createdBy: string | null; postedAt: string | null; postedBy: string | null;
    lines: { id: string; code: string; accountName: string; accountId: string; debit: string; credit: string; party: string | null; narration: string | null }[]; reversedBy: { id: string; docNo: string } | null; allowedActions: string[] }>(`/gl/journals/${id}`) });
  const [reverse, setReverse] = useState(false);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const j = q.data;
  if (!j) return <ErrorBanner error={q.error} />;
  const act = async (a: 'post' | 'cancel') => {
    setBusy(true);
    try { await api(`/gl/journals/${id}/${a}`, { body: {} }); toast('success', a === 'post' ? `${j.docNo} posted.` : `${j.docNo} cancelled.`); await qc.invalidateQueries(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Failed.'); } finally { setBusy(false); }
  };
  const dr = j.lines.reduce((a, l) => a + Number(l.debit), 0);
  return (
    <>
      <PageHeader title={j.docNo} crumbs={<Link to="/finance/journals" className="hover:text-primary">Journals</Link>}
        subtitle={<span>{SOURCE_LABEL[j.sourceType] ?? j.sourceType}{j.sourceRef ? ` ${j.sourceRef}` : ''} · {fmtDate(j.journalDate)} · <StatusBadge status={j.status} /></span>}
        actions={<>
          {j.allowedActions.includes('cancel') && <Button variant="secondary" loading={busy} onClick={() => act('cancel')}>Cancel draft</Button>}
          {j.allowedActions.includes('reverse') && <Button variant="secondary" onClick={() => setReverse(true)}>Reverse</Button>}
          {j.allowedActions.includes('post') && <Button loading={busy} onClick={() => act('post')}>Post journal</Button>}
        </>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Lines" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Account</th><th className={th}>Party</th><th className={`${th} text-right`}>Debit</th><th className={`${th} text-right`}>Credit</th></tr></thead>
            <tbody>{j.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="text-primary" to={`/finance/ledger/${l.accountId}`}><span className="num">{l.code}</span> {l.accountName}</Link></td>
                <td className={th}>{l.party ?? '—'}</td><td className={`${th} text-right num`}>{Number(l.debit) ? fmtINR(l.debit) : ''}</td><td className={`${th} text-right num`}>{Number(l.credit) ? fmtINR(l.credit) : ''}</td></tr>))}
              <tr className="bg-canvas font-semibold"><td className="px-5 py-3" colSpan={2}>Total</td><td className={`${th} text-right num`}>{fmtINR(dr)}</td><td className={`${th} text-right num`}>{fmtINR(dr)}</td></tr></tbody></table></div>
        </Card>
        <Card title="Journal">
          <KeyValues columns="narrow" items={[['Entity', j.legalEntityName], ['Narration', j.narration], ['Date', fmtDate(j.journalDate)],
            ...(j.originalDate ? [['Document date', `${fmtDate(j.originalDate)} — its period was locked`] as [string, string]] : []),
            ['Source', j.sourceId && SOURCE_LINK[j.sourceType] ? <Link key="s" className="text-primary" to={`${SOURCE_LINK[j.sourceType]}${j.sourceId}`}>{SOURCE_LABEL[j.sourceType]} {j.sourceRef}</Link> : `${SOURCE_LABEL[j.sourceType] ?? j.sourceType}${j.sourceRef ? ` ${j.sourceRef}` : ''}`],
            ['Drafted', j.createdBy ? `${j.createdBy}, ${fmtDateTime(j.createdAt)}` : `Automatic, ${fmtDateTime(j.createdAt)}`], ['Posted', j.postedAt ? `${j.postedBy ?? 'Automatic'}, ${fmtDateTime(j.postedAt)}` : '—'],
            ...(j.reversalOf ? [['Reverses', <Link key="r" className="text-primary" to={`/finance/journals/${j.reversalOf}`}>original journal</Link>] as [string, ReactNode]] : []),
            ...(j.reversedBy ? [['Reversed by', <Link key="rb" className="text-primary" to={`/finance/journals/${j.reversedBy.id}`}>{j.reversedBy.docNo}</Link>] as [string, ReactNode]] : [])]} />
        </Card>
      </div>
      <ReasonDialog open={reverse} title={`Reverse ${j.docNo}`} description="A mirror journal is posted today; the original stays as it was." confirmLabel="Reverse" onClose={() => setReverse(false)}
        onConfirm={async (reason) => { const r = await api<{ docNo: string }>(`/gl/journals/${id}/reverse`, { body: { date: today(), reason } }); toast('success', `Reversed by ${r.docNo}.`); await qc.invalidateQueries(); }} />
    </>
  );
}

// ---------------------------------------------------------------- financial statements (FIN-017)
export function FinancialStatementsPage() {
  const { le, picker } = useEntity();
  const [tab, setTab] = useState<'pl' | 'bs'>('pl');
  const [range, setRange] = useState({ from: fyStart(), to: today() });
  const pl = useQuery({ queryKey: ['pl', le, range], enabled: !!le && tab === 'pl', queryFn: () => api<{ income: { code: string; name: string; grp: string; amount: number }[]; expenses: { code: string; name: string; grp: string; amount: number }[];
    totalIncome: number; totalExpenses: number; netProfit: number }>(`/gl/profit-and-loss?legalEntityId=${le}&from=${range.from}&to=${range.to}`) });
  const bs = useQuery({ queryKey: ['bs', le, range.to], enabled: !!le && tab === 'bs', queryFn: () => api<{ assets: { code: string; name: string; grp: string; amount: number }[]; liabilities: { code: string; name: string; grp: string; amount: number }[];
    equity: { code: string; name: string; grp: string; amount: number }[]; profit: number; totalAssets: number; totalLiabilitiesAndEquity: number; balanced: boolean }>(`/gl/balance-sheet?legalEntityId=${le}&asOf=${range.to}`) });
  const section = (title: string, rows: { code: string; name: string; grp: string; amount: number }[], total: number, extra?: [string, number]) => {
    const groups = [...new Set(rows.map((r) => r.grp))];
    return (
      <Card title={title} padded={false}>
        <table className="w-full text-[14px]"><tbody>
          {groups.flatMap((g) => [<tr key={`g${g}`} className="bg-canvas"><td className="px-5 py-2 font-semibold" colSpan={2}>{g}</td></tr>,
            ...rows.filter((r) => r.grp === g).map((r) => <tr key={r.code} className="border-b border-line"><td className="px-5 py-2"><span className="num text-ink-2">{r.code}</span> {r.name}</td><td className="px-5 py-2 text-right num">{fmtINR(r.amount)}</td></tr>)])}
          {extra && <tr className="border-b border-line"><td className="px-5 py-2">{extra[0]}</td><td className="px-5 py-2 text-right num">{fmtINR(extra[1])}</td></tr>}
          <tr className="font-semibold"><td className="px-5 py-3">Total</td><td className="px-5 py-3 text-right num">{fmtINR(total)}</td></tr></tbody></table>
      </Card>
    );
  };
  return (
    <>
      <PageHeader title="Financial Statements" subtitle="Profit and loss for a period and the balance sheet on a date, straight from the posted journals."
        actions={<div className="flex flex-wrap items-end gap-3">{picker}
          {tab === 'pl' && <Field label="From" htmlFor="fs-from"><Input id="fs-from" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>}
          <Field label={tab === 'pl' ? 'To' : 'As on'} htmlFor="fs-to"><Input id="fs-to" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></div>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'pl', label: 'Profit and loss' }, { value: 'bs', label: 'Balance sheet' }]} />
      <div className="mt-4">
        {tab === 'pl' ? (pl.isLoading ? <Skeleton className="h-60" /> : !pl.data ? <ErrorBanner error={pl.error} /> : (
          <div className="grid gap-6 xl:grid-cols-2">
            {section('Income', pl.data.income, pl.data.totalIncome)}
            {section('Expenses', pl.data.expenses, pl.data.totalExpenses)}
            <Card className="xl:col-span-2"><p className="text-[13px] text-ink-2">{pl.data.netProfit >= 0 ? 'Net profit' : 'Net loss'} for {fmtDate(range.from)} to {fmtDate(range.to)}</p>
              <p className={`mt-1 text-[26px] font-semibold num ${pl.data.netProfit < 0 ? 'text-danger-text' : 'text-success-text'}`}>{fmtINR(Math.abs(pl.data.netProfit))}</p></Card>
          </div>)) : (bs.isLoading ? <Skeleton className="h-60" /> : !bs.data ? <ErrorBanner error={bs.error} /> : (
          <div className="grid gap-6 xl:grid-cols-2">
            {section('Assets', bs.data.assets, bs.data.totalAssets)}
            {section('Equity and liabilities', [...bs.data.equity, ...bs.data.liabilities], bs.data.totalLiabilitiesAndEquity, ['Profit / (loss) to date', bs.data.profit])}
            <p className={`xl:col-span-2 rounded-md px-4 py-3 ${bs.data.balanced ? 'bg-success-bg text-success-text' : 'bg-danger-bg text-danger-text'}`}>{bs.data.balanced ? 'The balance sheet balances.' : 'The balance sheet does not balance — check the trial balance.'}</p>
          </div>))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- periods (FIN-018)
export function PeriodsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const { le, picker } = useEntity();
  const q = useQuery({ queryKey: ['periods', le], enabled: !!le, queryFn: () => api<{ data: { id: string; periodStart: string; periodEnd: string; status: string; lockedAt: string | null; lockedBy: string | null; journals: number }[] }>(`/gl/periods?legalEntityId=${le}`) });
  const [unlock, setUnlock] = useState<string | null>(null);
  const lock = async (p: string) => {
    try { const r = await api<{ posted: number }>('/gl/periods/lock', { body: { legalEntityId: le, period: p } }); toast('success', `${p} locked${r.posted ? ` after posting ${r.posted} pending journal${r.posted === 1 ? '' : 's'}` : ''}.`); await qc.invalidateQueries({ queryKey: ['periods', le] }); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Could not lock.'); }
  };
  return (
    <>
      <PageHeader title="Accounting Periods" subtitle="Lock a month once it is closed: nothing can then be posted into it. A document dated in a locked month is posted on the first day of the next open month, with its own date kept."
        actions={picker} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : (
          <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Month</th><th className={`${th} text-right`}>Journals</th><th className={th}>Status</th><th className={th} /></tr></thead>
            <tbody>{(q.data?.data ?? []).map((p) => { const m = p.periodStart.slice(0, 7); return (
              <tr key={p.id} className="border-b border-line last:border-0"><td className="px-5 py-3 font-semibold">{new Date(`${p.periodStart}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</td>
                <td className={`${th} text-right num`}>{p.journals}</td>
                <td className={th}>{p.status === 'Locked' ? <span><StatusBadge status="Closed" label="Locked" /> <span className="text-[13px] text-ink-2">{p.lockedBy}, {fmtDateTime(p.lockedAt)}</span></span> : <StatusBadge status="Active" label="Open" />}</td>
                <td className={`${th} text-right`}>{p.status === 'Open' ? can('finance.gl:lock') && p.periodStart <= today() && <Button size="sm" variant="secondary" icon={<Lock size={16} />} onClick={() => lock(m)}>Lock</Button>
                  : can('finance.gl:unlock') && <Button size="sm" variant="ghost" icon={<LockOpen size={16} />} onClick={() => setUnlock(m)}>Unlock</Button>}</td></tr>); })}</tbody></table>
        )}
      </Card>
      <ReasonDialog open={!!unlock} title={`Unlock ${unlock}`} description="Reopening a closed month is recorded in the audit trail." confirmLabel="Unlock" danger onClose={() => setUnlock(null)}
        onConfirm={async (reason) => { await api('/gl/periods/unlock', { body: { legalEntityId: le, period: unlock, reason } }); toast('success', `${unlock} reopened.`); await qc.invalidateQueries({ queryKey: ['periods', le] }); }} />
    </>
  );
}

// ---------------------------------------------------------------- GST working (FIN-019)
type Tax = { taxable: string; cgst: string; sgst: string; igst: string };
export function GstPage() {
  const { le, picker } = useEntity();
  const [month, setMonth] = useState(today().slice(0, 7));
  const q = useQuery({ queryKey: ['gst', le, month], enabled: !!le, queryFn: () => api<{ gstr1: { b2b: (Tax & { id: string; docNo: string; invoiceDate: string; gstin: string; partyName: string; placeOfSupply: string; total: string })[];
    b2c: (Tax & { placeOfSupply: string; gstRate: string })[]; cdn: (Tax & { id: string; docNo: string; noteDate: string; invoiceNo: string; gstin: string | null; partyName: string; reason: string; total: string })[];
    hsn: (Tax & { hsnCode: string; gstRate: string; qty: string })[]; cancelled: { docNo: string; invoiceDate: string }[] };
    gstr3b: { outwardTaxable: number; output: { cgst: number; sgst: number; igst: number; rcm: number }; itc: { cgst: number; sgst: number; igst: number; rcm: number; other: number }; totalOutput: number; totalItc: number } }>(`/gl/gst?legalEntityId=${le}&month=${month}`) });
  const g = q.data;
  const taxCells = (x: Tax) => <><td className={`${th} text-right num`}>{fmtINR(x.taxable)}</td><td className={`${th} text-right num`}>{fmtINR(x.cgst)}</td><td className={`${th} text-right num`}>{fmtINR(x.sgst)}</td><td className={`${th} text-right num`}>{fmtINR(x.igst)}</td></>;
  const taxHead = <><th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>CGST</th><th className={`${th} text-right`}>SGST</th><th className={`${th} text-right`}>IGST</th></>;
  return (
    <>
      <PageHeader title="GST Working" subtitle="Outward supplies as GSTR-1 tables and a GSTR-3B style summary from the ledger, for review before filing. Filing through the GST portal is a Stage 7 integration."
        actions={<div className="flex flex-wrap items-end gap-3">{picker}<Field label="Month" htmlFor="gst-m"><Input id="gst-m" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></div>} />
      {q.isLoading ? <Skeleton className="h-60" /> : !g ? <ErrorBanner error={q.error} /> : (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <Card><p className="text-[13px] text-ink-2">Outward taxable value (net of credit notes)</p><p className="mt-1 text-[22px] font-semibold num">{fmtINR(g.gstr3b.outwardTaxable)}</p></Card>
            <Card><p className="text-[13px] text-ink-2">Output tax (incl. RCM {fmtINR(g.gstr3b.output.rcm)})</p><p className="mt-1 text-[22px] font-semibold num">{fmtINR(g.gstr3b.totalOutput)}</p>
              <p className="text-[13px] text-ink-2">CGST {fmtINR(g.gstr3b.output.cgst)} · SGST {fmtINR(g.gstr3b.output.sgst)} · IGST {fmtINR(g.gstr3b.output.igst)}</p></Card>
            <Card><p className="text-[13px] text-ink-2">Input tax credit booked</p><p className="mt-1 text-[22px] font-semibold num">{fmtINR(g.gstr3b.totalItc)}</p>
              <p className="text-[13px] text-ink-2">CGST {fmtINR(g.gstr3b.itc.cgst)} · SGST {fmtINR(g.gstr3b.itc.sgst)} · IGST {fmtINR(g.gstr3b.itc.igst)} · RCM {fmtINR(g.gstr3b.itc.rcm)} · other {fmtINR(g.gstr3b.itc.other)}</p></Card>
          </div>
          <Card title={`B2B invoices (${g.gstr1.b2b.length})`} padded={false}>
            {!g.gstr1.b2b.length ? <p className="p-5 text-ink-2">None this month.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Invoice</th><th className={th}>Date</th><th className={th}>GSTIN</th><th className={th}>Recipient</th><th className={th}>POS</th>{taxHead}</tr></thead>
              <tbody>{g.gstr1.b2b.map((x) => <tr key={x.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="text-primary num" to={`/finance/invoices/${x.id}`}>{x.docNo}</Link></td><td className={th}>{fmtDate(x.invoiceDate)}</td>
                <td className={`${th} num`}>{x.gstin}</td><td className={th}>{x.partyName}</td><td className={th}>{x.placeOfSupply}</td>{taxCells(x)}</tr>)}</tbody></table></div>}
          </Card>
          <Card title="B2C (unregistered) by place of supply and rate" padded={false}>
            {!g.gstr1.b2c.length ? <p className="p-5 text-ink-2">None this month.</p> : <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Place of supply</th><th className={th}>Rate</th>{taxHead}</tr></thead>
              <tbody>{g.gstr1.b2c.map((x) => <tr key={`${x.placeOfSupply}${x.gstRate}`} className="border-b border-line last:border-0"><td className="px-5 py-3">{x.placeOfSupply}</td><td className={th}>{Number(x.gstRate)}%</td>{taxCells(x)}</tr>)}</tbody></table>}
          </Card>
          <Card title={`Credit notes (${g.gstr1.cdn.length})`} padded={false}>
            {!g.gstr1.cdn.length ? <p className="p-5 text-ink-2">None this month.</p> : <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Note</th><th className={th}>Against</th><th className={th}>Recipient</th><th className={th}>Reason</th>{taxHead}</tr></thead>
              <tbody>{g.gstr1.cdn.map((x) => <tr key={x.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="text-primary num" to={`/finance/credit-notes/${x.id}`}>{x.docNo}</Link></td><td className={`${th} num`}>{x.invoiceNo}</td>
                <td className={th}>{x.partyName}{x.gstin ? ` · ${x.gstin}` : ''}</td><td className={th}>{humanize(x.reason.toLowerCase())}</td>{taxCells(x)}</tr>)}</tbody></table>}
          </Card>
          <Card title="HSN summary" padded={false}>
            {!g.gstr1.hsn.length ? <p className="p-5 text-ink-2">None this month.</p> : <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">HSN</th><th className={th}>Rate</th><th className={`${th} text-right`}>Quantity</th>{taxHead}</tr></thead>
              <tbody>{g.gstr1.hsn.map((x) => <tr key={`${x.hsnCode}${x.gstRate}`} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{x.hsnCode}</td><td className={th}>{Number(x.gstRate)}%</td><td className={`${th} text-right num`}>{Number(x.qty)}</td>{taxCells(x)}</tr>)}</tbody></table>}
          </Card>
          {!!g.gstr1.cancelled.length && <Card title="Cancelled invoices (report as cancelled)"><p className="num">{g.gstr1.cancelled.map((c) => c.docNo).join(', ')}</p></Card>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- chart of accounts (FIN-013)
export function ChartOfAccountsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAccounts();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', type: 'EXPENSE', grp: '', partyLedger: false });
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { if (!open) setError(null); }, [open]);
  const save = async () => {
    try { await api('/gl/accounts', { body: f }); toast('success', `${f.code} ${f.name} added.`); setOpen(false); setF({ code: '', name: '', type: 'EXPENSE', grp: '', partyLedger: false }); await qc.invalidateQueries({ queryKey: ['gl-accounts'] }); }
    catch (e) { setError(e); }
  };
  const types = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
  return (
    <>
      <PageHeader title="Chart of Accounts" subtitle="Accounts marked automatic receive the postings from documents and stock; finance can add its own for manual journals."
        actions={can('finance.coa:manage') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Add account</Button>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-60" /> : (
          <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Code</th><th className={th}>Account</th><th className={th}>Type</th><th className={th}>Group</th><th className={th}>Posting</th><th className={th}>Status</th></tr></thead>
            <tbody>{(q.data?.data ?? []).map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{a.code}</td><td className={th}><Link className="text-primary" to={`/finance/ledger/${a.id}`}>{a.name}</Link>{a.partyLedger ? <span className="text-[13px] text-ink-2"> · by party</span> : null}</td>
                <td className={th}>{humanize(a.type.toLowerCase())}</td><td className={`${th} text-ink-2`}>{a.grp}</td><td className={th}>{a.systemKey ? 'Automatic' : 'Manual'}</td><td className={th}><StatusBadge status={a.status} /></td></tr>))}</tbody></table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add account" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!f.code || !f.name || !f.grp} onClick={save}>Add</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Code" htmlFor="ac-code" required hint="4 to 6 digits"><Input id="ac-code" inputMode="numeric" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Name" htmlFor="ac-name" required><Input id="ac-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Type" htmlFor="ac-type" required><Select id="ac-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{types.map((t) => <option key={t} value={t}>{humanize(t.toLowerCase())}</option>)}</Select></Field>
          <Field label="Statement group" htmlFor="ac-grp" required hint="e.g. Other expenses, Current assets"><Input id="ac-grp" value={f.grp} onChange={(e) => setF({ ...f, grp: e.target.value })} /></Field>
          <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={f.partyLedger} onChange={(e) => setF({ ...f, partyLedger: e.target.checked })} />Lines name a dealer or vendor</label>
        </div>
      </Modal>
    </>
  );
}
