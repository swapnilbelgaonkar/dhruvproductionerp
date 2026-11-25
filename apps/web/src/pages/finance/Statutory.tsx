import { CheckCircle, DownloadSimple, FileArrowUp, Plus, XCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtINR } from '../../lib/format';

const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).slice(0, 7);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const readFile = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsText(f); });

// ================================================================ GST returns (GSTR-1, GSTR-3B)
interface Filing { id: string; gstin: string; returnType: 'GSTR1' | 'GSTR3B'; period: string; status: string; summary: Record<string, number | string | null>; arn: string | null; filedOn: string | null;
  preparedAt: string; preparedBy: string; filedAt: string | null; filedBy: string | null }
export function GstReturnsPage() {
  const qc = useQueryClient(); const toast = useToast();
  const list = useQuery({ queryKey: ['gst-returns'], queryFn: () => api<{ gstins: { gstin: string; legalEntityName: string }[]; data: Filing[]; mode: string; canFile: boolean }>('/gst/returns') });
  const [gstin, setGstin] = useState(''); const [period, setPeriod] = useState(thisMonth()); const [type, setType] = useState<'GSTR1' | 'GSTR3B'>('GSTR1');
  const g = gstin || list.data?.gstins[0]?.gstin || '';
  const pv = useQuery({ enabled: !!g, queryKey: ['gst-preview', g, period, type], queryFn: () => api<{ summary: Record<string, number | string | null>; filed: { arn: string; filedOn: string } | null }>(`/gst/returns/preview?gstin=${g}&period=${period}&type=${type}`) });
  const [filing, setFiling] = useState<Filing | null>(null); const [arn, setArn] = useState(''); const [filedOn, setFiledOn] = useState(today());
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const prepare = async () => { setBusy(true); setError(null); try { await api('/gst/returns', { body: { gstin: g, period, type } }); toast('success', `${type} for ${period} prepared — download it and upload it on the GST portal.`); await qc.invalidateQueries({ queryKey: ['gst-returns'] }); } catch (e) { setError(e); } finally { setBusy(false); } };
  const file = async () => { setError(null); try { await api(`/gst/returns/${filing!.id}/filed`, { body: { arn, filedOn } }); toast('success', 'Filing recorded. The month is closed for cancellations.'); setFiling(null); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  const label: Record<string, string> = { invoices: 'Invoices', cancelled: 'Cancelled', creditNotes: 'Credit notes', b2b: 'B2B invoices', b2cl: 'B2C large', b2csRows: 'B2C small rows', hsnRows: 'HSN rows',
    taxable: 'Taxable value', igst: 'IGST', cgst: 'CGST', sgst: 'SGST', outwardTaxable: 'Outward taxable', outputTax: 'Output tax', itc: 'Input tax credit', netPayable: 'Net payable', note: 'Note' };
  const money = new Set(['taxable', 'igst', 'cgst', 'sgst', 'outwardTaxable', 'outputTax', 'itc', 'netPayable']);
  const show = (s: Record<string, number | string | null>) => Object.entries(s).filter(([, v]) => v !== null).map(([k, v]) => [label[k] ?? k, money.has(k) ? fmtINR(v as number) : String(v)] as [string, string]);
  return (
    <>
      <PageHeader title="GST Returns" subtitle="GSTR-1 and GSTR-3B for each GSTIN and month, in the GST portal's offline-tool JSON. Upload the file on the portal, then record the ARN here; that month's invoices can then no longer be cancelled." />
      {list.data?.mode === 'OFF' && <div className="mb-4 rounded-md border border-warning-text/40 bg-warning-bg p-3 text-[14px]">The GST returns integration is switched off. An administrator can set it to manual in Administration → Integrations.</div>}
      <ErrorBanner error={error} />
      <div className="grid gap-6 xl:grid-cols-[2fr_3fr]">
        <Card title="Prepare a return">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="GSTIN" htmlFor="gr-g"><Select id="gr-g" value={g} onChange={(e) => setGstin(e.target.value)}>{list.data?.gstins.map((x) => <option key={x.gstin} value={x.gstin}>{x.gstin}</option>)}</Select></Field>
            <Field label="Month" htmlFor="gr-p"><Input id="gr-p" type="month" max={thisMonth()} value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
            <Field label="Return" htmlFor="gr-t"><Select id="gr-t" value={type} onChange={(e) => setType(e.target.value as 'GSTR1')}><option value="GSTR1">GSTR-1</option><option value="GSTR3B">GSTR-3B</option></Select></Field>
          </div>
          {pv.isLoading ? <Skeleton className="h-32" /> : pv.data && <>
            <KeyValues columns="narrow" items={show(pv.data.summary)} />
            {pv.data.filed ? <p className="mt-3 text-[14px]"><StatusBadge status="Approved" label="Filed" /> ARN {pv.data.filed.arn} on {fmtDate(pv.data.filed.filedOn)}</p>
              : <Button className="mt-4" loading={busy} disabled={list.data?.mode === 'OFF'} onClick={prepare}>Prepare {type === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} file</Button>}</>}
        </Card>
        <Card title="Prepared and filed" padded={false}>
          {!list.data ? <Skeleton className="h-40" /> : !list.data.data.length ? <div className="p-5"><EmptyState title="Nothing prepared yet" text="Prepare a return on the left." /></div> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Return</th><th className={th}>GSTIN</th><th className={th}>Prepared</th><th className={th}>Status</th><th className={th} /></tr></thead>
              <tbody>{list.data.data.map((f) => <tr key={f.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3 font-semibold">{f.returnType === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'} · {f.period}</td><td className={`${th} num`}>{f.gstin}</td><td className={th}>{f.preparedBy}<div className="text-[12px] text-ink-2">{fmtDateTime(f.preparedAt)}</div></td>
                <td className={th}>{f.status === 'Filed' ? <span><StatusBadge status="Approved" label="Filed" /><div className="text-[12px] text-ink-2">{f.arn} · {fmtDate(f.filedOn)}</div></span> : <StatusBadge status="Pending" label="Prepared" />}</td>
                <td className={`${th} text-right`}><a href={`/api/v1/gst/returns/${f.id}/json`}><Button size="sm" variant="ghost" icon={<DownloadSimple size={16} />}>JSON</Button></a>
                  {f.status === 'Prepared' && list.data!.canFile && <Button size="sm" variant="secondary" icon={<CheckCircle size={16} />} onClick={() => { setError(null); setArn(''); setFiling(f); }}>Record filing</Button>}</td></tr>)}</tbody></table></div>)}
        </Card>
      </div>
      <Modal open={!!filing} onClose={() => setFiling(null)} title="Record the filing" description="The ERP checks that nothing changed since the file was prepared."
        footer={<><Button variant="secondary" onClick={() => setFiling(null)}>Cancel</Button><Button disabled={!arn} onClick={file}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="ARN from the portal" htmlFor="gr-arn" required><Input id="gr-arn" maxLength={15} className="num" value={arn} onChange={(e) => setArn(e.target.value.toUpperCase())} /></Field>
        <Field label="Filed on" htmlFor="gr-fd" required><Input id="gr-fd" type="date" max={today()} value={filedOn} onChange={(e) => setFiledOn(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

// ================================================================ TDS
interface Section { code: string; name: string; rateIndividual: string | null; rateOther: string | null; rateNoPan: string | null; thresholdSingle: string | null; thresholdAnnual: string | null; deductOn: string; status: string; remarks: string | null }
interface Due { legalEntityId: string; legalEntityName: string; section: string; period: string; payments: number; deducted: number; deposited: number; pending: number; dueDate: string; overdue: boolean }
export function TdsPage() {
  const qc = useQueryClient(); const toast = useToast();
  const sec = useQuery({ queryKey: ['tds-sections'], queryFn: () => api<{ data: Section[] }>('/tds/sections') });
  const due = useQuery({ queryKey: ['tds-payable'], queryFn: () => api<{ data: Due[] }>('/tds/payable') });
  const ch = useQuery({ queryKey: ['tds-challans'], queryFn: () => api<{ data: { id: string; docNo: string; legalEntityName: string; section: string; period: string; tdsAmount: string; interest: string; total: string; depositedOn: string; bsrCode: string; challanSerial: string; payments: number }[] }>('/tds/challans') });
  const [edit, setEdit] = useState<Section | null>(null); const [dep, setDep] = useState<Due | null>(null);
  const [c, setC] = useState({ depositedOn: today(), bsrCode: '', challanSerial: '', interest: '' });
  const [q26, setQ26] = useState({ legalEntityId: '', fy: '', quarter: 'Q1' });
  const [error, setError] = useState<unknown>(null);
  const n = (v: string | null) => (v === '' || v == null ? null : Number(v));
  const save = async () => { setError(null);
    try { await api(`/tds/sections/${edit!.code}`, { method: 'PUT', body: { name: edit!.name, rateIndividual: n(edit!.rateIndividual), rateOther: n(edit!.rateOther), rateNoPan: n(edit!.rateNoPan), thresholdSingle: n(edit!.thresholdSingle),
      thresholdAnnual: n(edit!.thresholdAnnual), deductOn: edit!.deductOn, status: edit!.status, remarks: edit!.remarks } }); toast('success', `${edit!.code} saved.`); setEdit(null); await qc.invalidateQueries({ queryKey: ['tds-sections'] }); } catch (e) { setError(e); } };
  const deposit = async () => { setError(null);
    try { const r = await api<{ docNo: string }>('/tds/challans', { body: { legalEntityId: dep!.legalEntityId, section: dep!.section, period: dep!.period, depositedOn: c.depositedOn, bsrCode: c.bsrCode, challanSerial: c.challanSerial, interest: Number(c.interest || 0) } });
      toast('success', `${r.docNo} recorded.`); setDep(null); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  const les = [...new Map((due.data?.data ?? []).map((d) => [d.legalEntityId, d.legalEntityName])).entries()];
  const fy = (() => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-${String((y + 1) % 100).padStart(2, '0')}`; })();
  return (
    <>
      <PageHeader title="TDS" subtitle="Sections, rates and thresholds are kept here by finance — payments are worked out from them. Deposit what was deducted with a challan by the 7th of the next month, and download the quarterly 26Q rows for the return utility." />
      <div className="grid gap-6">
        <Card title="Sections" padded={false}>
          {!sec.data ? <Skeleton className="h-32" /> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Section</th><th className={th}>Individual / HUF</th><th className={th}>Others</th><th className={th}>No PAN</th>
            <th className={th}>Thresholds</th><th className={th}>Status</th><th className={th} /></tr></thead>
            <tbody>{sec.data.data.map((s) => <tr key={s.code} className="border-b border-line last:border-0"><td className="px-5 py-3"><b>{s.code}</b><div className="text-[13px] text-ink-2">{s.name}</div></td>
              <td className={`${th} num`}>{s.rateIndividual ?? '—'}{s.rateIndividual && '%'}</td><td className={`${th} num`}>{s.rateOther ?? '—'}{s.rateOther && '%'}</td><td className={`${th} num`}>{s.rateNoPan ?? '—'}{s.rateNoPan && '%'}</td>
              <td className={`${th} text-[13px]`}>{s.thresholdSingle ? `${fmtINR(s.thresholdSingle)} a payment` : ''}{s.thresholdSingle && s.thresholdAnnual ? ' · ' : ''}{s.thresholdAnnual ? `${fmtINR(s.thresholdAnnual)} a year${s.deductOn === 'EXCESS' ? ' (on the excess)' : ''}` : ''}{!s.thresholdSingle && !s.thresholdAnnual && '—'}</td>
              <td className={th}><StatusBadge status={s.status === 'Active' ? 'Active' : 'Draft'} label={s.status === 'Draft' ? 'Rates not set' : s.status} /></td>
              <td className={`${th} text-right`}><Button size="sm" variant="ghost" onClick={() => { setError(null); setEdit({ ...s }); }}>Edit</Button></td></tr>)}</tbody></table></div>}
        </Card>
        <Card title="Deducted and to deposit" padded={false}>
          {!due.data ? <Skeleton className="h-32" /> : !due.data.data.length ? <div className="p-5"><EmptyState title="No TDS deducted yet" text="Deductions appear when payments are released." /></div> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Month</th><th className={th}>Entity</th><th className={th}>Section</th><th className={`${th} text-right`}>Deducted</th><th className={`${th} text-right`}>Deposited</th><th className={th}>Due</th><th className={th} /></tr></thead>
              <tbody>{due.data.data.map((d) => <tr key={`${d.legalEntityId}${d.section}${d.period}`} className="border-b border-line last:border-0"><td className="px-5 py-3 font-semibold">{d.period}</td><td className={th}>{d.legalEntityName}</td><td className={th}>{d.section}</td>
                <td className={`${th} text-right num`}>{fmtINR(d.deducted)}<div className="text-[12px] text-ink-2">{d.payments} payments</div></td><td className={`${th} text-right num`}>{fmtINR(d.deposited)}</td>
                <td className={th}>{fmtDate(d.dueDate)} {d.overdue && <StatusBadge status="Rejected" label="Late" />}</td>
                <td className={`${th} text-right`}>{d.pending > 0 && <Button size="sm" onClick={() => { setError(null); setC({ depositedOn: today(), bsrCode: '', challanSerial: '', interest: '' }); setDep(d); }}>Record challan</Button>}</td></tr>)}</tbody></table></div>)}
        </Card>
        <div className="grid gap-6 xl:grid-cols-2">
          <Card title="Challans" padded={false}>
            {!ch.data?.data.length ? <div className="p-5 text-[14px] text-ink-2">None yet.</div> : <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Challan</th><th className={th}>Section · month</th><th className={`${th} text-right`}>Paid</th><th className={th}>Deposited</th></tr></thead>
              <tbody>{ch.data.data.map((x) => <tr key={x.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{x.docNo}<div className="text-[12px] text-ink-2">BSR {x.bsrCode} · {x.challanSerial}</div></td><td className={th}>{x.section} · {x.period}</td>
                <td className={`${th} text-right num`}>{fmtINR(x.total)}{Number(x.interest) > 0 && <div className="text-[12px] text-ink-2">incl. interest {fmtINR(x.interest)}</div>}</td><td className={th}>{fmtDate(x.depositedOn)}</td></tr>)}</tbody></table>}
          </Card>
          <Card title="Quarterly return rows (26Q)">
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Entity" htmlFor="q-le"><Select id="q-le" value={q26.legalEntityId || les[0]?.[0] || ''} onChange={(e) => setQ26({ ...q26, legalEntityId: e.target.value })}>{les.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></Field>
              <Field label="Financial year" htmlFor="q-fy"><Input id="q-fy" value={q26.fy || fy} onChange={(e) => setQ26({ ...q26, fy: e.target.value })} /></Field>
              <Field label="Quarter" htmlFor="q-q"><Select id="q-q" value={q26.quarter} onChange={(e) => setQ26({ ...q26, quarter: e.target.value })}>{['Q1', 'Q2', 'Q3', 'Q4'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
            </div>
            <a href={`/api/v1/tds/26q?legalEntityId=${q26.legalEntityId || les[0]?.[0] || ''}&fy=${q26.fy || fy}&quarter=${q26.quarter}`}><Button variant="secondary" disabled={!les.length} icon={<DownloadSimple size={16} />}>Download CSV</Button></a>
            <p className="mt-2 text-[13px] text-ink-2">One row per deduction with its challan, in the order the NSDL return preparation utility asks for.</p>
          </Card>
        </div>
      </div>
      {edit && <Modal open onClose={() => setEdit(null)} title={`Section ${edit.code}`} description="Confirm rates and thresholds with the tax adviser; they apply to payments drafted from now on." width={680}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Name" htmlFor="ts-n"><Input id="ts-n" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <div className="grid gap-4 md:grid-cols-3">
          {(['rateIndividual', 'rateOther', 'rateNoPan'] as const).map((k) => <Field key={k} label={{ rateIndividual: 'Rate — individual / HUF (%)', rateOther: 'Rate — others (%)', rateNoPan: 'Rate — no PAN (%)' }[k]} htmlFor={`ts-${k}`}>
            <Input id={`ts-${k}`} type="number" step="0.001" min="0" max="50" value={edit[k] ?? ''} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></Field>)}
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Single payment threshold (₹)" htmlFor="ts-s"><Input id="ts-s" type="number" min="0" value={edit.thresholdSingle ?? ''} onChange={(e) => setEdit({ ...edit, thresholdSingle: e.target.value })} /></Field>
          <Field label="Annual threshold (₹)" htmlFor="ts-a"><Input id="ts-a" type="number" min="0" value={edit.thresholdAnnual ?? ''} onChange={(e) => setEdit({ ...edit, thresholdAnnual: e.target.value })} /></Field>
          <Field label="Deduct on" htmlFor="ts-d"><Select id="ts-d" value={edit.deductOn} onChange={(e) => setEdit({ ...edit, deductOn: e.target.value })}><option value="BASE">The whole amount</option><option value="EXCESS">Only above the annual threshold</option></Select></Field>
        </div>
        <Field label="Status" htmlFor="ts-st"><Select id="ts-st" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="Draft">Draft (not used)</option><option value="Active">Active</option><option value="Inactive">Inactive</option></Select></Field>
      </Modal>}
      {dep && <Modal open onClose={() => setDep(null)} title={`Deposit ${dep.section} for ${dep.period}`} description={`${fmtINR(dep.pending)} deducted and not yet deposited; due by ${fmtDate(dep.dueDate)}.`}
        footer={<><Button variant="secondary" onClick={() => setDep(null)}>Cancel</Button><Button disabled={!c.bsrCode || !c.challanSerial} onClick={deposit}>Record</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Deposited on" htmlFor="tc-d" required><Input id="tc-d" type="date" max={today()} value={c.depositedOn} onChange={(e) => setC({ ...c, depositedOn: e.target.value })} /></Field>
          <Field label="Interest paid (₹)" htmlFor="tc-i" hint={c.depositedOn > dep.dueDate ? 'Late: interest is required' : undefined}><Input id="tc-i" type="number" min="0" value={c.interest} onChange={(e) => setC({ ...c, interest: e.target.value })} /></Field>
          <Field label="BSR code" htmlFor="tc-b" required><Input id="tc-b" inputMode="numeric" maxLength={7} value={c.bsrCode} onChange={(e) => setC({ ...c, bsrCode: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Challan serial no." htmlFor="tc-s" required><Input id="tc-s" inputMode="numeric" maxLength={5} value={c.challanSerial} onChange={(e) => setC({ ...c, challanSerial: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
      </Modal>}
    </>
  );
}

// ================================================================ bank payment files
interface Batch { id: string; docNo: string; bankAccount: string; accountLast4: string; layout: string; status: string; paymentCount: number; paid: number; total: string; fileName: string; createdAt: string; createdBy: string }
interface Ready { id: string; docNo: string; legalEntityId: string; payeeName: string; mode: string; netAmount: string; paymentDate: string }
export function BankFilesPage() {
  const qc = useQueryClient(); const toast = useToast();
  const b = useQuery({ queryKey: ['bank-batches'], queryFn: () => api<{ data: Batch[]; ready: Ready[] }>('/bank/payment-batches') });
  const acc = useQuery({ queryKey: ['bank-accounts'], queryFn: () => api<{ data: { id: string; legalEntityId: string; legalEntityName: string; name: string; bankName: string; ifsc: string; accountLast4: string; fileLayout: string }[]; layouts: string[] }>('/bank/bank-accounts') });
  const [sel, setSel] = useState<string[]>([]); const [bank, setBank] = useState('');
  const [add, setAdd] = useState(false); const [na, setNa] = useState({ legalEntityId: '', name: '', bankName: '', ifsc: '', accountNo: '', clientCode: '', fileLayout: 'GENERIC_CSV' });
  const [reply, setReply] = useState<Batch | null>(null); const [result, setResult] = useState<{ ref: string; outcome: string; message?: string }[] | null>(null);
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const les = useQuery({ enabled: add, queryKey: ['les'], queryFn: () => api<{ data: { id: string; name: string }[] }>('/legal-entities?status=Active') });
  const account = acc.data?.data.find((a) => a.id === (bank || acc.data?.data[0]?.id));
  const ready = (b.data?.ready ?? []).filter((r) => !account || r.legalEntityId === account.legalEntityId);
  const make = async () => { setBusy(true); setError(null);
    try { const r = await api<{ docNo: string; fileName: string }>('/bank/payment-batches', { body: { bankAccountId: account!.id, paymentIds: sel } }); toast('success', `${r.docNo} made — download it and upload it in the bank's corporate banking.`); setSel([]); await qc.invalidateQueries(); }
    catch (e) { setError(e); } finally { setBusy(false); } };
  const upload = async (f: File) => { setError(null); setResult(null);
    try { const r = await api<{ result: { ref: string; outcome: string; message?: string }[]; closed: boolean }>(`/bank/payment-batches/${reply!.id}/reply`, { body: { content: await readFile(f) } }); setResult(r.result); await qc.invalidateQueries(); }
    catch (e) { setError(e); } };
  const saveAcc = async () => { setError(null); try { await api('/bank/bank-accounts', { body: { ...na, clientCode: na.clientCode || null, legalEntityId: na.legalEntityId || les.data?.data[0]?.id } }); toast('success', 'Bank account added.'); setAdd(false); await qc.invalidateQueries({ queryKey: ['bank-accounts'] }); } catch (e) { setError(e); } };
  const total = ready.filter((r) => sel.includes(r.id)).reduce((s, r) => s + Number(r.netAmount), 0);
  return (
    <>
      <PageHeader title="Bank Payment Files" subtitle="Approved NEFT, RTGS and IMPS payments go to the bank in one bulk file. Load the bank's reply file to mark them paid with their UTRs; rejected ones come back here for the next file."
        actions={<Button variant="secondary" icon={<Plus size={18} />} onClick={() => { setError(null); setAdd(true); }}>Company bank account</Button>} />
      <ErrorBanner error={error} />
      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card title="Approved, waiting for the bank" padded={false}>
          <div className="flex flex-wrap items-end gap-3 p-5">
            <Field label="Pay from" htmlFor="bf-a"><Select id="bf-a" value={account?.id ?? ''} onChange={(e) => { setBank(e.target.value); setSel([]); }}>{acc.data?.data.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.bankName} ••{a.accountLast4}</option>)}</Select></Field>
            <Button loading={busy} disabled={!sel.length || !account} onClick={make}>Make file ({sel.length} · {fmtINR(total)})</Button>
          </div>
          {!b.data ? <Skeleton className="h-32" /> : !ready.length ? <div className="px-5 pb-5"><EmptyState title="Nothing to pay" text="Approved bank-transfer payments appear here." /></div> : (
            <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3"><input type="checkbox" aria-label="Select all" checked={sel.length === ready.length} onChange={(e) => setSel(e.target.checked ? ready.map((r) => r.id) : [])} /></th>
              <th className={th}>Payment</th><th className={th}>Payee</th><th className={th}>Mode</th><th className={`${th} text-right`}>To pay</th></tr></thead>
              <tbody>{ready.map((r) => <tr key={r.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><input type="checkbox" aria-label={`Select ${r.docNo}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
                <td className={th}><Link className="num text-primary" to={`/finance/payments/${r.id}`}>{r.docNo}</Link></td><td className={th}>{r.payeeName}</td><td className={th}>{r.mode}</td><td className={`${th} text-right num`}>{fmtINR(r.netAmount)}</td></tr>)}</tbody></table>)}
        </Card>
        <Card title="Files" padded={false}>
          {!b.data?.data.length ? <div className="p-5 text-[14px] text-ink-2">No files yet.</div> : <ul>{b.data.data.map((x) => <li key={x.id} className="border-b border-line px-5 py-3 text-[14px] last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold num">{x.docNo}</span><StatusBadge status={x.status === 'Generated' ? 'Pending' : x.status === 'Closed' ? 'Approved' : 'Cancelled'} label={x.status === 'Generated' ? 'With the bank' : x.status} /></div>
            <div className="text-[13px] text-ink-2">{x.paymentCount} payments · {fmtINR(x.total)} · {x.bankAccount} ••{x.accountLast4} · {x.paid} paid · {x.createdBy}, {fmtDateTime(x.createdAt)}</div>
            {x.status === 'Generated' && <div className="mt-2 flex flex-wrap gap-2"><a href={`/api/v1/bank/payment-batches/${x.id}/file`}><Button size="sm" variant="secondary" icon={<DownloadSimple size={16} />}>Download</Button></a>
              <Button size="sm" icon={<FileArrowUp size={16} />} onClick={() => { setError(null); setResult(null); setReply(x); }}>Load bank reply</Button>
              <Button size="sm" variant="ghost" icon={<XCircle size={16} />} onClick={async () => { try { await api(`/bank/payment-batches/${x.id}/cancel`, { body: { reason: 'Not sent to the bank' } }); await qc.invalidateQueries(); } catch (e) { setError(e); } }}>Cancel</Button></div>}
          </li>)}</ul>}
        </Card>
      </div>
      <Modal open={!!reply} onClose={() => setReply(null)} title={`Bank reply for ${reply?.docNo ?? ''}`} description="A CSV with columns for the payment reference, status and UTR (and the value date).">
        <ErrorBanner error={error} />
        <Input type="file" accept=".csv,.txt" aria-label="Reply file" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        {result && <ul className="mt-4 space-y-1 text-[14px]">{result.map((r) => <li key={r.ref}><b className="num">{r.ref}</b> — {{ paid: 'paid', failed: 'rejected by the bank, back in the queue', unknown: 'not in this file', already: 'already paid', invalid: 'not understood' }[r.outcome] ?? r.outcome}{r.message ? ` (${r.message})` : ''}</li>)}</ul>}
      </Modal>
      <Modal open={add} onClose={() => setAdd(false)} title="Company bank account" description="The account payment files debit. The number is stored encrypted." width={640}
        footer={<><Button variant="secondary" onClick={() => setAdd(false)}>Cancel</Button><Button onClick={saveAcc}>Add</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Legal entity" htmlFor="ba-le"><Select id="ba-le" value={na.legalEntityId} onChange={(e) => setNa({ ...na, legalEntityId: e.target.value })}>{les.data?.data.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" htmlFor="ba-n" required><Input id="ba-n" value={na.name} placeholder="Current account — main" onChange={(e) => setNa({ ...na, name: e.target.value })} /></Field>
          <Field label="Bank" htmlFor="ba-b" required><Input id="ba-b" value={na.bankName} onChange={(e) => setNa({ ...na, bankName: e.target.value })} /></Field>
          <Field label="IFSC" htmlFor="ba-i" required><Input id="ba-i" maxLength={11} value={na.ifsc} onChange={(e) => setNa({ ...na, ifsc: e.target.value.toUpperCase() })} /></Field>
          <Field label="Account number" htmlFor="ba-no" required><Input id="ba-no" inputMode="numeric" value={na.accountNo} onChange={(e) => setNa({ ...na, accountNo: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Corporate client code" htmlFor="ba-c"><Input id="ba-c" value={na.clientCode} onChange={(e) => setNa({ ...na, clientCode: e.target.value })} /></Field>
          <Field label="File layout" htmlFor="ba-l"><Select id="ba-l" value={na.fileLayout} onChange={(e) => setNa({ ...na, fileLayout: e.target.value })}><option value="GENERIC_CSV">Bulk upload CSV</option><option value="PIPE_H2H">Host-to-host (pipe-delimited)</option></Select></Field>
        </div>
      </Modal>
    </>
  );
}
