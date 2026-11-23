import { ArrowRight, DownloadSimple, MagnifyingGlass, Play, Printer } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, PageHeader, Select, Skeleton } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';

const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
const lakh = (v: number) => (Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : Math.abs(v) >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L` : `₹${Math.round(v).toLocaleString('en-IN')}`);
const RAG: Record<string, { bar: string; text: string; label: string }> = {
  green: { bar: 'bg-success-text', text: 'text-success-text', label: 'On target' }, amber: { bar: 'bg-warning-text', text: 'text-warning-text', label: 'Watch' },
  red: { bar: 'bg-danger-text', text: 'text-danger-text', label: 'Act now' }, neutral: { bar: 'bg-line', text: 'text-ink-2', label: 'No data yet' },
};

// ---------------------------------------------------------------- executive dashboard (MIS-007)
interface Kpi { key: string; label: string; value: number | null; unit: 'inr' | 'count' | 'pct'; rag: string; link: string; report: string; formula: string; target: string; owner: string; detail?: Record<string, number | null> }
interface Exec {
  asOf: string; kpis: Kpi[]; months: { month: string; label: string; sales: string; collections: string; orders: string; output: string }[];
  topDealers: { name: string; sales: string; outstanding: string }[]; receivablesAgeing: Record<string, string>; operations: Record<string, number | string>; provisional: string;
}
const kpiValue = (k: Kpi) => (k.value === null ? '—' : k.unit === 'inr' ? lakh(k.value) : k.unit === 'pct' ? `${fmtNum(k.value)}%` : fmtNum(k.value));

export function ExecutiveDashboardPage() {
  const q = useQuery({ queryKey: ['executive'], queryFn: () => api<Exec>('/dashboard/executive'), refetchInterval: 300_000 });
  const [dict, setDict] = useState(false);
  const d = q.data;
  const months = (d?.months ?? []).map((m) => ({ ...m, sales: Number(m.sales), collections: Number(m.collections), orders: Number(m.orders), output: Number(m.output) }));
  const ar = d?.receivablesAgeing;
  const ageing = ar ? [['Not due', ar.notDue], ['1–30', ar.d30], ['31–60', ar.d60], ['61–90', ar.d90], ['90+', ar.over90]].map(([k, v]) => ({ bucket: k as string, value: Number(v) })) : [];
  const ops = d?.operations ?? {};
  return (
    <>
      <PageHeader title="Executive Dashboard" subtitle={d ? `Company-wide, as of ${fmtDateTime(d.asOf)}. Click a card for the detail; refreshes every 5 minutes.` : 'Company-wide KPIs'}
        actions={<><Button variant="secondary" onClick={() => setDict(!dict)}>{dict ? 'Hide' : 'Show'} KPI dictionary</Button><Link to="/reports"><Button icon={<ArrowRight size={18} />}>All reports</Button></Link></>} />
      {q.isLoading ? <Skeleton className="h-96" /> : !d ? <ErrorBanner error={q.error} /> : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {d.kpis.map((k) => (
              <Link key={k.key} to={k.link} className="card group relative overflow-hidden p-5 transition hover:-translate-y-0.5 hover:shadow-lg">
                <span className={`absolute inset-y-0 left-0 w-1.5 ${RAG[k.rag]!.bar}`} aria-hidden />
                <div className="flex items-start justify-between gap-3"><p className="font-semibold">{k.label}</p><span className={`text-[12px] font-semibold ${RAG[k.rag]!.text}`}>{RAG[k.rag]!.label}</span></div>
                <p className={`mt-2 text-[30px] font-semibold num ${RAG[k.rag]!.text}`}>{kpiValue(k)}</p>
                <p className="text-[13px] text-ink-2">{k.target}</p>
                {k.key === 'oee' && k.detail && <p className="mt-1 text-[13px] text-ink-2">Availability {k.detail.availability ?? '—'}% · performance {k.detail.performance ?? '—'}% · quality {k.detail.quality ?? '—'}%</p>}
                {k.key === 'quarantine' && k.detail && <p className="mt-1 text-[13px] text-ink-2">{k.detail.lotsInQuarantine} lots in quarantine · oldest {k.detail.oldestHours} h</p>}
                {dict && <div className="mt-3 border-t border-line pt-3 text-[13px]"><p><b>Formula:</b> {k.formula}</p><p><b>Owner:</b> {k.owner} · <b>Refresh:</b> live when opened</p>
                  <p><Link className="text-primary" to={`/reports/${k.report}`} onClick={(e) => e.stopPropagation()}>Open the report</Link></p></div>}
              </Link>))}
          </div>
          <p className="text-[12px] text-ink-2">{d.provisional}</p>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Net sales and collections (6 months)">
              <div className="h-64"><ResponsiveContainer><BarChart data={months} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} stroke="#F1F0F6" strokeDasharray="3 6" /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} tickFormatter={(v: number) => lakh(v)} width={80} />
                <Tooltip formatter={(v: number) => fmtINR(v)} /><Legend /><Bar dataKey="sales" name="Net sales" fill="#5B3DF5" radius={[4, 4, 0, 0]} /><Bar dataKey="collections" name="Collections" fill="#22C55E" radius={[4, 4, 0, 0]} />
              </BarChart></ResponsiveContainer></div>
            </Card>
            <Card title="Orders booked and production output (6 months)">
              <div className="h-64"><ResponsiveContainer><LineChart data={months} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} stroke="#F1F0F6" strokeDasharray="3 6" /><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                <YAxis yAxisId="v" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} tickFormatter={(v: number) => lakh(v)} width={80} />
                <YAxis yAxisId="q" orientation="right" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                <Tooltip formatter={(v: number, n: string) => (n === 'Orders booked' ? fmtINR(v) : fmtNum(v))} /><Legend />
                <Line yAxisId="v" dataKey="orders" name="Orders booked" stroke="#5B3DF5" strokeWidth={2} dot /><Line yAxisId="q" dataKey="output" name="Output (kg / L)" stroke="#F59E0B" strokeWidth={2} dot />
              </LineChart></ResponsiveContainer></div>
            </Card>
            <Card title="Receivables by age">
              <div className="h-56"><ResponsiveContainer><BarChart data={ageing} layout="vertical" margin={{ left: 8, right: 24 }}>
                <XAxis type="number" hide /><YAxis type="category" dataKey="bucket" tickLine={false} axisLine={false} width={70} tick={{ fontSize: 12, fill: '#6B6B80' }} />
                <Tooltip formatter={(v: number) => fmtINR(v)} /><Bar dataKey="value" name="Outstanding" fill="#EF4444" radius={[0, 4, 4, 0]} />
              </BarChart></ResponsiveContainer></div>
              <Link className="text-[14px] font-semibold text-primary" to="/finance/ageing">Receivables ageing →</Link>
            </Card>
            <Card title="Top dealers this financial year" padded={false}>
              {!d.topDealers.length ? <p className="p-5 text-ink-2">No invoices yet this year.</p> : (
                <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Dealer</th><th className={`${th} text-right`}>Net sales</th><th className={`${th} text-right`}>Outstanding</th></tr></thead>
                  <tbody>{d.topDealers.map((t) => <tr key={t.name} className="border-b border-line last:border-0"><td className="px-5 py-3">{t.name}</td><td className={`${th} text-right num`}>{fmtINR(t.sales)}</td><td className={`${th} text-right num`}>{fmtINR(t.outstanding)}</td></tr>)}</tbody></table>)}
            </Card>
          </div>
          <Card title="Operations at a glance">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
              {[['Approvals waiting', ops.pendingApprovals, '/approvals'], ['Open purchase orders', ops.openPos, '/reports/pending-pos'], ['Open PO value', lakh(Number(ops.openPoValue ?? 0)), '/reports/pending-pos'],
                ['QC lots pending', ops.qcPending, '/qc/inspections'], ['Batches running', ops.batchesRunning, '/production/batches'], ['Open deviations', ops.openDeviations, '/qa/deviations'],
                ['CAPAs overdue', ops.capasOverdue, '/reports/capa-ageing'], ['Open complaints', ops.openComplaints, '/qa/complaints'], ['Shipments in transit', ops.inTransit, '/reports/pod-pending'],
                ['Calibration overdue', ops.calibrationOverdue, '/reports/calibration-status'], ['Payables overdue', lakh(Number(ops.payablesOverdue ?? 0)), '/finance/payables']].map(([k, v, to]) => (
                <Link key={k as string} to={to as string} className="rounded-md bg-canvas p-3 transition hover:bg-primary-tint"><p className="text-[12px] text-ink-2">{k}</p><p className="mt-1 text-[20px] font-semibold num">{v as string}</p></Link>))}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- report catalogue (MIS-002)
interface ReportEntry { id: string; area: string; title: string; description: string; brd: string | null; link: string | null }
export function ReportsPage() {
  const q = useQuery({ queryKey: ['reports'], queryFn: () => api<{ data: ReportEntry[]; total: number; catalogue: number }>('/reports') });
  const [search, setSearch] = useState('');
  const list = (q.data?.data ?? []).filter((r) => !search || `${r.title} ${r.description} ${r.area}`.toLowerCase().includes(search.toLowerCase()));
  const areas = [...new Set(list.map((r) => r.area))];
  return (
    <>
      <PageHeader title="Reports" subtitle={q.data ? `${q.data.total} reports open to you. Each shows only the records you may see, and exports to CSV for Excel.` : 'Report catalogue'}
        actions={<div className="relative"><MagnifyingGlass size={18} className="absolute left-3 top-3 text-ink-2" aria-hidden /><Input aria-label="Search reports" className="w-72 pl-9" placeholder="Search reports" value={search} onChange={(e) => setSearch(e.target.value)} /></div>} />
      {q.isLoading ? <Skeleton className="h-96" /> : !list.length ? <Card><EmptyState title="No reports" text="Nothing matches, or your role has no reports." /></Card> : (
        <div className="space-y-6">{areas.map((a) => (
          <Card key={a} title={`${a} (${list.filter((r) => r.area === a).length})`}>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{list.filter((r) => r.area === a).map((r) => (
              <Link key={r.id} to={r.link ?? `/reports/${r.id}`} className="rounded-md border border-line p-4 transition hover:border-primary hover:bg-primary-tint">
                <p className="font-semibold text-primary">{r.title}</p><p className="mt-1 text-[13px] text-ink-2">{r.description}</p>
                {r.brd && <p className="mt-1 text-[12px] text-ink-2">{r.brd}</p>}
              </Link>))}</div>
          </Card>))}</div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- report viewer
interface Col { key: string; label: string; type?: string; total?: boolean; link?: string }
interface Def { id: string; area: string; title: string; description: string; columns: Col[]; filters: { key: string; label: string; type: string; options?: { value: string; label: string }[]; default: string | null }[] }
const cell = (c: Col, v: unknown) => {
  if (v === null || v === undefined || v === '') return '—';
  switch (c.type) {
    case 'money': return fmtINR(v as number);
    case 'number': return fmtNum(v as number);
    case 'int': return fmtNum(v as number);
    case 'pct': return `${fmtNum(v as number)}%`;
    case 'date': return fmtDate(String(v));
    case 'datetime': return fmtDateTime(String(v));
    default: return String(v);
  }
};
const numeric = (t?: string) => ['money', 'number', 'int', 'pct'].includes(t ?? '');

export function ReportViewerPage() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const def = useQuery({ queryKey: ['report-def', id], queryFn: () => api<Def>(`/reports/${id}`) });
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!def.data) return;
    setVals(Object.fromEntries(def.data.filters.map((f) => [f.key, sp.get(f.key) ?? f.default ?? ''])));
  }, [def.data]);   // eslint-disable-line react-hooks/exhaustive-deps
  const query = useMemo(() => { const p = new URLSearchParams(); for (const [k, v] of sp) if (v) p.set(k, v); return p.toString(); }, [sp]);
  const run = useQuery({ queryKey: ['report-run', id, query], enabled: !!def.data,
    queryFn: () => api<{ columns: Col[]; rows: Record<string, unknown>[]; totals: Record<string, number>; count: number; truncated: boolean }>(`/reports/${id}/run${query ? `?${query}` : ''}`) });
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  useEffect(() => { if (def.data) document.title = def.data.title; return () => { document.title = 'Dhruv Agro ERP'; }; }, [def.data]);
  const apply = () => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(vals)) if (v) p.set(k, v); setSp(p, { replace: true }); };
  const rows = useMemo(() => {
    const r = [...(run.data?.rows ?? [])];
    if (sort) { const c = run.data?.columns.find((x) => x.key === sort.key); r.sort((a, b) => { const x = a[sort.key]; const y = b[sort.key]; const cmp = numeric(c?.type) ? Number(x ?? 0) - Number(y ?? 0) : String(x ?? '').localeCompare(String(y ?? '')); return cmp * sort.dir; }); }
    return r;
  }, [run.data, sort]);
  if (def.isLoading) return <Skeleton className="h-96" />;
  const d = def.data;
  if (!d) return <ErrorBanner error={def.error} />;
  const href = (c: Col, row: Record<string, unknown>) => (c.link ? c.link.replace(/\{(\w+)\}/g, (_, k: string) => String(row[k] ?? '')) : null);
  const exportUrl = `/api/v1/reports/${id}/export${query ? `?${query}` : ''}`;
  return (
    <>
      <div className="print:hidden">
        <PageHeader title={d.title} crumbs={<Link to="/reports" className="hover:text-primary">Reports</Link>} subtitle={d.description}
          actions={<><a href={exportUrl} download><Button variant="secondary" icon={<DownloadSimple size={18} />}>Export CSV</Button></a>
            <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></>} />
        {!!d.filters.length && (
          <Card className="mb-4">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); apply(); }}>
              {d.filters.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`rf-${f.key}`}>
                  {f.type === 'select' ? <Select id={`rf-${f.key}`} className="min-w-44" value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}><option value="">All</option>
                    {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                    : <Input id={`rf-${f.key}`} className="w-40" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />}
                </Field>))}
              <Button type="submit" icon={<Play size={16} weight="fill" />}>Run</Button>
            </form>
          </Card>
        )}
      </div>
      <div className="mb-3 hidden print:block"><h1 className="text-[18px] font-bold">{d.title}</h1>
        <p className="text-[12px]">{d.filters.filter((f) => sp.get(f.key) ?? f.default).map((f) => `${f.label}: ${f.options?.find((o) => o.value === (sp.get(f.key) ?? f.default))?.label ?? sp.get(f.key) ?? f.default}`).join(' · ')} · printed {fmtDateTime(new Date().toISOString())}</p></div>
      <Card padded={false}>
        {run.isLoading ? <Skeleton className="h-60" /> : run.error ? <div className="p-5"><ErrorBanner error={run.error} /></div> : !rows.length ? <div className="p-5"><EmptyState title="No rows" text="Nothing matches these filters." /></div> : (
          <>
            <p className="px-5 pt-4 text-[13px] text-ink-2 print:hidden">{run.data!.count} row{run.data!.count === 1 ? '' : 's'}{run.data!.truncated ? ' — the first 5,000; narrow the filters or export' : ''}. Click a heading to sort.</p>
            <div className="overflow-x-auto"><table className="w-full text-[13px]"><thead><tr className={thead}>
              {run.data!.columns.map((c) => <th key={c.key} className={`${th} cursor-pointer select-none whitespace-nowrap ${numeric(c.type) ? 'text-right' : ''}`}
                onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}>{c.label}{sort?.key === c.key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
              <tbody>{rows.map((row, i) => (
                <tr key={i} className="border-b border-line last:border-0">{run.data!.columns.map((c) => {
                  const to = href(c, row);
                  return <td key={c.key} className={`${th} ${numeric(c.type) ? 'text-right num' : ''}`}>{to ? <Link className="text-primary num" to={to}>{cell(c, row[c.key])}</Link> : cell(c, row[c.key])}</td>;
                })}</tr>))}
                {Object.keys(run.data!.totals).length > 0 && <tr className="bg-canvas font-semibold">{run.data!.columns.map((c, i) => (
                  <td key={c.key} className={`${th} ${numeric(c.type) ? 'text-right num' : ''}`}>{i === 0 ? 'Total' : c.key in run.data!.totals ? cell(c, run.data!.totals[c.key]) : ''}</td>))}</tr>}
              </tbody></table></div>
          </>
        )}
      </Card>
    </>
  );
}
