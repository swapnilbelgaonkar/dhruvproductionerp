import { QC_TECHNIQUES, SPEC_CATEGORIES } from '@dhruv/contracts';
import { CheckCircle, Plus, Printer, Trash, XCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { fmtDate, fmtDateTime, humanize } from '../../lib/format';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const label = (s: string) => humanize(s.toLowerCase());
interface Param { id: string; seq: number; parameter: string; category: string; unit: string | null; limitType: string; minValue: string | null; maxValue: string | null; expectedText: string | null;
  methodId: string | null; methodCode: string | null; technique?: string | null; limit?: string }
interface Instrument { id: string; code: string; name: string; technique: string; makeModel: string | null; serialNo: string | null; location: string | null; intervalDays: number;
  lastCalibrated: string | null; calibrationDue: string | null; status: string; statusReason: string | null; state: string }
const InstState = ({ s }: { s: string }) => <StatusBadge status={s === 'Calibrated' ? 'Active' : s === 'DueSoon' ? 'Pending' : s === 'Overdue' || s === 'OutOfService' ? 'Rejected' : 'Inactive'}
  label={s === 'DueSoon' ? 'Due within 15 days' : s === 'OutOfService' ? 'Out of service' : s} />;

/** Local pass/fail preview; the server decides. */
function preview(p: Param, value: string) {
  if (!value.trim()) return null;
  if (p.limitType === 'TEXT') return value.trim().toLowerCase() === String(p.expectedText).trim().toLowerCase();
  const m = value.replace(',', '.').match(/-?\d+(\.\d+)?/);
  if (!m) return false;
  const x = Number(m[0]);
  return (p.minValue === null || x >= Number(p.minValue)) && (p.maxValue === null || x <= Number(p.maxValue));
}

// ---------------------------------------------------------------- results against the specification (inspection page)
export function SpecResultsCard({ inspectionId, spec, editable, coaDocumentId, onSaved }: {
  inspectionId: string; spec: { code: string; versionNo: number; parameters: Param[] }; editable: boolean; coaDocumentId: string | null; onSaved: () => void;
}) {
  const toast = useToast();
  const inst = useQuery({ queryKey: ['instruments-usable'], queryFn: () => api<{ data: Instrument[] }>('/qc/master/instruments?usable=1'), enabled: editable });
  const [vals, setVals] = useState<Record<string, { value: string; instrumentId: string }>>({});
  const [coaReceived, setCoaReceived] = useState(false);
  const [recommendation, setRecommendation] = useState('Release');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!editable) return null;
  const outcomes = spec.parameters.map((p) => preview(p, vals[p.id]?.value ?? ''));
  const complete = spec.parameters.every((p) => (vals[p.id]?.value ?? '').trim());
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ passed: boolean; oosNo: string | null }>(`/qc/inspections/${inspectionId}/spec-results`, { body: { coaReceived, coaDocumentId, recommendation: outcomes.every(Boolean) ? recommendation : 'Hold',
        results: spec.parameters.map((p) => ({ specParameterId: p.id, value: vals[p.id]!.value, instrumentId: vals[p.id]?.instrumentId || null })) } });
      toast(r.passed ? 'success' : 'error', r.passed ? 'Results saved: every parameter within specification.' : `Out of specification: investigation ${r.oosNo} opened. The lot is held.`); onSaved();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Card title={`2. Results against ${spec.code} v${spec.versionNo}`} padded={false}>
      <ErrorBanner error={error} />
      <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]">
        <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-6 py-3">Parameter</th><th className="px-2 py-3">Limit</th>
          <th className="px-2 py-3">Method</th><th className="px-2 py-3">Instrument</th><th className="w-40 px-2 py-3">Result</th><th className="px-3 py-3" /></tr></thead>
        <tbody>{spec.parameters.map((p, i) => {
          const v = vals[p.id] ?? { value: '', instrumentId: '' };
          const usable = (inst.data?.data ?? []).filter((x) => !p.technique || x.technique === p.technique);
          return (
            <tr key={p.id} className="border-b border-line last:border-0">
              <td className="px-6 py-2"><span className="font-medium">{p.parameter}</span><span className="block text-[12px] text-ink-2">{label(p.category)}</span></td>
              <td className="px-2 py-2 num">{p.limit}</td><td className="px-2 py-2">{p.methodCode ?? '—'}</td>
              <td className="px-2 py-2">{p.technique && !['VISUAL', 'OTHER'].includes(p.technique) ? (
                <Select aria-label={`Instrument for ${p.parameter}`} value={v.instrumentId} onChange={(e) => setVals({ ...vals, [p.id]: { ...v, instrumentId: e.target.value } })}>
                  <option value="">{usable.length ? 'Select…' : 'None calibrated'}</option>{usable.map((x) => <option key={x.id} value={x.id}>{x.code} (due {fmtDate(x.calibrationDue)})</option>)}</Select>) : '—'}</td>
              <td className="px-2 py-2"><Input aria-label={`Result for ${p.parameter}`} value={v.value} onChange={(e) => setVals({ ...vals, [p.id]: { ...v, value: e.target.value } })} /></td>
              <td className="px-3 py-2">{outcomes[i] === null ? null : outcomes[i] ? <CheckCircle size={20} weight="fill" className="text-success-text" aria-label="within specification" />
                : <XCircle size={20} weight="fill" className="text-danger-text" aria-label="out of specification" />}</td>
            </tr>);
        })}</tbody>
      </table></div>
      <div className="grid gap-4 border-t border-line px-6 py-5 md:grid-cols-3">
        <label className="flex items-center gap-3 text-[14px]"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={coaReceived} onChange={(e) => setCoaReceived(e.target.checked)} />Supplier's certificate of analysis received</label>
        <Field label="Recommendation" htmlFor="sr-rec"><Select id="sr-rec" value={outcomes.every(Boolean) ? recommendation : 'Hold'} disabled={!outcomes.every(Boolean)} onChange={(e) => setRecommendation(e.target.value)}>
          <option value="Release">Release</option><option value="Reject">Reject</option><option value="Hold">Hold</option></Select></Field>
        {outcomes.some((o) => o === false) && <p className="md:col-span-3 rounded-md bg-danger-bg px-4 py-3 text-danger-text">A result is out of specification. Saving opens an OOS investigation automatically; the results are then frozen and a retest needs the QC manager's authorisation.</p>}
        <div className="md:col-span-3"><Button loading={busy} disabled={!complete} onClick={save}>Save results</Button></div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- QC masters
export function QcMasterPage() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as 'specs' | 'methods' | 'instruments') ?? 'specs';
  return (
    <>
      <PageHeader title="QC Masters" subtitle="Specifications per item (approved by QC, then QA), the test methods they use, and the laboratory instruments with their calibration. An instrument past its due date cannot be used for a result." />
      <div className="mb-4"><Tabs value={tab} onChange={(v) => setSp({ tab: v })} tabs={[{ value: 'specs', label: 'Specifications' }, { value: 'methods', label: 'Test methods' }, { value: 'instruments', label: 'Instruments' }]} /></div>
      {tab === 'specs' ? <SpecsTab /> : tab === 'methods' ? <MethodsTab /> : <InstrumentsTab />}
    </>
  );
}

function SpecsTab() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['qc-specs'], queryFn: () => api<{ data: { id: string; code: string; title: string; itemCode: string; itemName: string; itemType: string; currentVersion: number | null; parameterCount: number; pendingCount: number }[] }>('/qc/master/specs') });
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; itemType: string }>>('/items?status=Active&limit=100') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ itemId: '', code: '', title: '' });
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const taken = new Set((q.data?.data ?? []).map((s) => s.itemCode));
  const save = async () => {
    setError(null);
    try { const r = await api<{ id: string }>('/qc/master/specs', { body: f }); toast('success', 'Specification created. Add its first version.'); setOpen(false); await qc.invalidateQueries(); window.location.assign(`/qc/specs/${r.id}`); }
    catch (e) { setError(e); }
  };
  return (
    <>
      <Card padded={false} title="Specifications" actions={<Button size="sm" icon={<Plus size={16} />} onClick={() => setOpen(true)}>New specification</Button>}>
        {!q.data?.data.length ? <div className="p-5"><EmptyState title="No specifications yet" text="Create one per raw material, packaging material and product: its parameters, limits and methods." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">Specification</th><th className="px-3 py-3">Item</th><th className="px-3 py-3">In force</th><th className="px-3 py-3 text-right">Parameters</th><th className="px-3 py-3">Status</th></tr></thead>
            <tbody>{q.data.data.map((s) => <tr key={s.id} className="border-b border-line last:border-0">
              <td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/qc/specs/${s.id}`}>{s.code}</Link><span className="block text-[13px] text-ink-2">{s.title}</span></td>
              <td className="px-3 py-3">{s.itemCode} <span className="text-ink-2">{s.itemName} ({s.itemType})</span></td>
              <td className="px-3 py-3">{s.currentVersion ? `v${s.currentVersion}` : <span className="text-warning-text">None</span>}</td><td className="px-3 py-3 text-right num">{s.currentVersion ? s.parameterCount : '—'}</td>
              <td className="px-3 py-3">{s.pendingCount ? <StatusBadge status="Pending" label="Version pending approval" /> : <StatusBadge status="Active" />}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="New specification" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!f.itemId || !f.code || !f.title} onClick={save}>Create</Button></>}>
        <ErrorBanner error={error} />
        <div className="space-y-4">
          <Field label="Item" htmlFor="sp-item" required><Select id="sp-item" value={f.itemId} onChange={(e) => { const it = items.data?.data.find((x) => x.id === e.target.value); setF({ itemId: e.target.value, code: f.code || (it ? `SPEC-${it.code}`.slice(0, 20) : ''), title: f.title || (it?.name ?? '') }); }}>
            <option value="">Select…</option>{(items.data?.data ?? []).filter((i) => !taken.has(i.code) && ['RM', 'PM', 'FG', 'SEMI'].includes(i.itemType)).map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name} ({i.itemType})</option>)}</Select></Field>
          <Field label="Code" htmlFor="sp-code" required><Input id="sp-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Title" htmlFor="sp-title" required><Input id="sp-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

function MethodsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['qc-methods'], queryFn: () => api<{ data: { id: string; code: string; name: string; technique: string; reference: string | null; status: string }[] }>('/qc/master/methods') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', technique: 'HPLC', reference: '' });
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api('/qc/master/methods', { body: { ...f, reference: f.reference || null } }); toast('success', 'Method added.'); setOpen(false); setF({ code: '', name: '', technique: 'HPLC', reference: '' }); await qc.invalidateQueries({ queryKey: ['qc-methods'] }); } catch (e) { setError(e); } };
  return (
    <>
      <Card padded={false} title="Test methods" actions={<Button size="sm" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add method</Button>}>
        {!q.data?.data.length ? <div className="p-5"><EmptyState title="No methods yet" text="Add the standard test procedures: HPLC assay, AAS for metals, pH, density, titration." /></div> : (
          <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Method</th><th className="px-3 py-3">Technique</th><th className="px-3 py-3">Reference</th></tr></thead>
            <tbody>{q.data.data.map((m) => <tr key={m.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><span className="font-semibold">{m.code}</span> {m.name}</td><td className="px-3 py-3">{label(m.technique)}</td><td className="px-3 py-3">{m.reference ?? '—'}</td></tr>)}</tbody></table>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add a test method" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!f.code || !f.name} onClick={save}>Add</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Code" htmlFor="tm-code" required><Input id="tm-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Technique" htmlFor="tm-tech" required><Select id="tm-tech" value={f.technique} onChange={(e) => setF({ ...f, technique: e.target.value })}>{QC_TECHNIQUES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <div className="md:col-span-2"><Field label="Name" htmlFor="tm-name" required><Input id="tm-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <div className="md:col-span-2"><Field label="Reference (standard)" htmlFor="tm-ref" hint="e.g. FCO 1985 Schedule II, IS 7179"><Input id="tm-ref" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </>
  );
}

function InstrumentsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['qc-instruments'], queryFn: () => api<{ data: Instrument[] }>('/qc/master/instruments') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', technique: 'PH_METER', makeModel: '', serialNo: '', location: '', intervalDays: '180' });
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api('/qc/master/instruments', { body: { ...f, intervalDays: Number(f.intervalDays), makeModel: f.makeModel || null, serialNo: f.serialNo || null, location: f.location || null } }); toast('success', 'Instrument added. Record its calibration before use.'); setOpen(false); await qc.invalidateQueries({ queryKey: ['qc-instruments'] }); } catch (e) { setError(e); } };
  return (
    <>
      <Card padded={false} title="Instruments" actions={<Button size="sm" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add instrument</Button>}>
        {!q.data?.data.length ? <div className="p-5"><EmptyState title="No instruments yet" text="Add HPLC, AAS, pH meters and balances with their calibration interval." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">Instrument</th><th className="px-3 py-3">Technique</th><th className="px-3 py-3">Location</th><th className="px-3 py-3">Calibrated</th><th className="px-3 py-3">Due</th><th className="px-3 py-3">State</th></tr></thead>
            <tbody>{q.data.data.map((i) => <tr key={i.id} className="border-b border-line last:border-0">
              <td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/qc/instruments/${i.id}`}>{i.code}</Link><span className="block text-[13px] text-ink-2">{i.name}</span></td>
              <td className="px-3 py-3">{label(i.technique)}</td><td className="px-3 py-3">{i.location ?? '—'}</td><td className="px-3 py-3 num">{fmtDate(i.lastCalibrated)}</td><td className="px-3 py-3 num">{fmtDate(i.calibrationDue)}</td>
              <td className="px-3 py-3"><InstState s={i.state} /></td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add an instrument" width={640} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!f.code || !f.name || !(Number(f.intervalDays) > 0)} onClick={save}>Add</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Code" htmlFor="in-code" required><Input id="in-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Technique" htmlFor="in-tech" required><Select id="in-tech" value={f.technique} onChange={(e) => setF({ ...f, technique: e.target.value })}>{QC_TECHNIQUES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field>
          <div className="md:col-span-2"><Field label="Name" htmlFor="in-name" required><Input id="in-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field></div>
          <Field label="Make / model" htmlFor="in-make"><Input id="in-make" value={f.makeModel} onChange={(e) => setF({ ...f, makeModel: e.target.value })} /></Field>
          <Field label="Serial number" htmlFor="in-serial"><Input id="in-serial" value={f.serialNo} onChange={(e) => setF({ ...f, serialNo: e.target.value })} /></Field>
          <Field label="Location" htmlFor="in-loc"><Input id="in-loc" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
          <Field label="Calibration interval (days)" htmlFor="in-int" required><Input id="in-int" type="number" min="1" max="1095" value={f.intervalDays} onChange={(e) => setF({ ...f, intervalDays: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

export function InstrumentDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['qc-instrument', id], queryFn: () => api<Instrument & { canManage: boolean; calibrations: { id: string; calibratedOn: string; dueOn: string; result: string; agency: string | null; certificateNo: string | null; remarks: string | null; recordedBy: string }[] }>(`/qc/master/instruments/${id}`) });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ calibratedOn: today(), result: 'Pass', agency: '', certificateNo: '', remarks: '' });
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const i = q.data;
  if (!i) return <ErrorBanner error={q.error} />;
  const save = async () => { setError(null); try { await api(`/qc/master/instruments/${id}/calibrations`, { body: { ...f, agency: f.agency || null, certificateNo: f.certificateNo || null, remarks: f.remarks || null } }); toast('success', 'Calibration recorded.'); setOpen(false); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  return (
    <>
      <PageHeader title={i.code} crumbs={<Link to="/qc/master?tab=instruments" className="hover:text-primary">QC Masters</Link>} subtitle={<span className="inline-flex items-center gap-2"><InstState s={i.state} />{i.name}</span>}
        actions={i.canManage && i.status !== 'Retired' && <Button onClick={() => setOpen(true)}>Record calibration</Button>} />
      {i.statusReason && <div className="mb-6 rounded-md bg-danger-bg px-4 py-3 text-danger-text">{i.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Calibration history" padded={false}>
          {!i.calibrations.length ? <div className="p-5"><EmptyState title="Never calibrated" text="The instrument cannot be used for results until a passed calibration is recorded." /></div> : (
            <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Calibrated</th><th className="px-3 py-3">Due</th><th className="px-3 py-3">Result</th><th className="px-3 py-3">Agency / certificate</th><th className="px-3 py-3">By</th></tr></thead>
              <tbody>{i.calibrations.map((c) => <tr key={c.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{fmtDate(c.calibratedOn)}</td><td className="px-3 py-3 num">{c.result === 'Pass' ? fmtDate(c.dueOn) : '—'}</td>
                <td className="px-3 py-3"><StatusBadge status={c.result === 'Pass' ? 'Approved' : 'Rejected'} label={c.result} /></td><td className="px-3 py-3">{[c.agency, c.certificateNo].filter(Boolean).join(' · ') || '—'}{c.remarks ? ` — ${c.remarks}` : ''}</td><td className="px-3 py-3">{c.recordedBy}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Instrument"><KeyValues columns="narrow" items={[['Technique', label(i.technique)], ['Make / model', i.makeModel], ['Serial', i.serialNo], ['Location', i.location], ['Interval', `${i.intervalDays} days`], ['Due', fmtDate(i.calibrationDue)]]} /></Card>
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={`Record calibration of ${i.code}`} footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save}>Record</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Calibrated on" htmlFor="cal-on" required><Input id="cal-on" type="date" max={today()} value={f.calibratedOn} onChange={(e) => setF({ ...f, calibratedOn: e.target.value })} /></Field>
          <Field label="Result" htmlFor="cal-res" required hint={f.result === 'Fail' ? 'The instrument goes out of service' : `Next due in ${i.intervalDays} days`}><Select id="cal-res" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}><option>Pass</option><option>Fail</option></Select></Field>
          <Field label="Agency" htmlFor="cal-ag"><Input id="cal-ag" value={f.agency} onChange={(e) => setF({ ...f, agency: e.target.value })} /></Field>
          <Field label="Certificate number" htmlFor="cal-cert"><Input id="cal-cert" value={f.certificateNo} onChange={(e) => setF({ ...f, certificateNo: e.target.value })} /></Field>
          <div className="md:col-span-2"><Field label="Remarks" htmlFor="cal-rem"><Input id="cal-rem" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- specification detail and version editor
interface SpecDetail { id: string; code: string; title: string; itemCode: string; itemName: string; canManage: boolean;
  versions: { id: string; versionNo: number; effectiveFrom: string; effectiveTo: string | null; changeNote: string; status: string; state: string; statusReason: string | null; version: number; createdBy: string; approvalId: string | null; parameters: Param[] }[] }
interface DraftParam { parameter: string; category: string; unit: string; limitType: string; minValue: string; maxValue: string; expectedText: string; methodId: string }

export function SpecDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['qc-spec', id], queryFn: () => api<SpecDetail>(`/qc/master/specs/${id}`) });
  const methods = useQuery({ queryKey: ['qc-methods'], queryFn: () => api<{ data: { id: string; code: string; name: string }[] }>('/qc/master/methods') });
  const [edit, setEdit] = useState<null | { vid?: string; version?: number }>(null);
  const [h, setH] = useState({ effectiveFrom: today(), changeNote: '' });
  const [rows, setRows] = useState<DraftParam[]>([]);
  const [error, setError] = useState<unknown>(null);
  const s = q.data;
  const open = s?.versions.find((v) => ['Draft', 'Submitted', 'Rejected'].includes(v.status));
  const start = (base?: SpecDetail['versions'][number], editing = false) => {
    setH({ effectiveFrom: editing && base ? base.effectiveFrom : today(), changeNote: editing && base ? base.changeNote : '' });
    setRows((base?.parameters ?? []).map((p) => ({ parameter: p.parameter, category: p.category, unit: p.unit ?? '', limitType: p.limitType, minValue: p.minValue === null ? '' : String(Number(p.minValue)),
      maxValue: p.maxValue === null ? '' : String(Number(p.maxValue)), expectedText: p.expectedText ?? '', methodId: p.methodId ?? '' })));
    if (!base?.parameters.length) setRows([{ parameter: '', category: 'CHEMICAL', unit: '', limitType: 'RANGE', minValue: '', maxValue: '', expectedText: '', methodId: '' }]);
    setEdit(editing && base ? { vid: base.id, version: base.version } : {});
  };
  useEffect(() => { setError(null); }, [edit]);
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!s) return <ErrorBanner error={q.error} />;
  const save = async () => {
    setError(null);
    const body = { ...h, parameters: rows.filter((r) => r.parameter.trim()).map((r) => ({ parameter: r.parameter, category: r.category, unit: r.unit || null, limitType: r.limitType,
      minValue: r.minValue === '' ? null : Number(r.minValue), maxValue: r.maxValue === '' ? null : Number(r.maxValue), expectedText: r.expectedText || null, methodId: r.methodId || null })) };
    try {
      if (edit?.vid) await api(`/qc/master/specs/${id}/versions/${edit.vid}`, { method: 'PUT', body: { ...body, version: edit.version } });
      else await api(`/qc/master/specs/${id}/versions`, { body });
      toast('success', 'Version saved as Draft.'); setEdit(null); await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  const submit = async (vid: string) => { try { const r = await api<{ approvalDocNo: string }>(`/qc/master/specs/${id}/versions/${vid}/submit`, { body: {} }); toast('success', `Sent for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  const setRow = (i: number, patch: Partial<DraftParam>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      <PageHeader title={s.code} crumbs={<Link to="/qc/master" className="hover:text-primary">QC Masters</Link>} subtitle={`${s.title} · ${s.itemCode} — ${s.itemName}`}
        actions={s.canManage && !open && <Button icon={<Plus size={18} weight="bold" />} onClick={() => start(s.versions.find((v) => v.state === 'Current') ?? s.versions[0])}>{s.versions.length ? 'New version' : 'Add first version'}</Button>} />
      <ErrorBanner error={error} />
      {!s.versions.length && <Card><EmptyState title="No versions yet" text="Add the parameters, limits and methods. QC and then QA approve before it applies to results." /></Card>}
      <div className="space-y-6">{s.versions.map((v) => (
        <Card key={v.id} padded={false} title={<span className="inline-flex flex-wrap items-center gap-2">v{v.versionNo} <StatusBadge status={v.state === 'Current' ? 'Active' : v.state === 'Scheduled' ? 'Issued' : v.state} label={v.state} />
          <span className="text-[13px] font-normal text-ink-2">from {fmtDate(v.effectiveFrom)}{v.effectiveTo ? ` to ${fmtDate(v.effectiveTo)}` : ''} · {v.changeNote}</span></span>}
          actions={<div className="flex gap-2">{v.approvalId && <Link className="text-[14px] text-primary" to={`/approvals/${v.approvalId}`}>Approval</Link>}
            {s.canManage && ['Draft', 'Rejected'].includes(v.status) && <><Button size="sm" variant="secondary" onClick={() => start(v, true)}>Edit</Button><Button size="sm" onClick={() => submit(v.id)}>Submit for approval</Button></>}</div>}>
          <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">#</th><th className="px-3 py-3">Parameter</th><th className="px-3 py-3">Category</th><th className="px-3 py-3">Limit</th><th className="px-3 py-3">Method</th></tr></thead>
            <tbody>{v.parameters.map((p) => <tr key={p.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{p.seq}</td><td className="px-3 py-3 font-medium">{p.parameter}</td><td className="px-3 py-3">{label(p.category)}</td>
              <td className="px-3 py-3 num">{p.limitType === 'RANGE' ? `${Number(p.minValue)} – ${Number(p.maxValue)}` : p.limitType === 'MIN' ? `≥ ${Number(p.minValue)}` : p.limitType === 'MAX' ? `≤ ${Number(p.maxValue)}` : p.expectedText} {p.limitType !== 'TEXT' ? p.unit ?? '' : ''}</td>
              <td className="px-3 py-3">{p.methodCode ?? '—'}</td></tr>)}</tbody></table>
        </Card>))}</div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.vid ? 'Edit version' : 'New specification version'} width={1000}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!h.changeNote.trim() || !rows.some((r) => r.parameter.trim())} onClick={save}>Save draft</Button></>}>
        <ErrorBanner error={error} />
        <div className="mb-4 grid gap-4 md:grid-cols-3">
          <Field label="Effective from" htmlFor="sv-from" required><Input id="sv-from" type="date" min={today()} value={h.effectiveFrom} onChange={(e) => setH({ ...h, effectiveFrom: e.target.value })} /></Field>
          <div className="md:col-span-2"><Field label="What changed and why" htmlFor="sv-note" required><Input id="sv-note" value={h.changeNote} onChange={(e) => setH({ ...h, changeNote: e.target.value })} /></Field></div>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1.6fr_1fr_0.6fr_0.9fr_0.7fr_0.7fr_1fr_32px] gap-2">
            <Input aria-label={`Parameter ${i + 1}`} placeholder="Parameter" value={r.parameter} onChange={(e) => setRow(i, { parameter: e.target.value })} />
            <Select aria-label={`Category ${i + 1}`} value={r.category} onChange={(e) => setRow(i, { category: e.target.value })}>{SPEC_CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</Select>
            <Input aria-label={`Unit ${i + 1}`} placeholder="Unit" value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })} />
            <Select aria-label={`Limit type ${i + 1}`} value={r.limitType} onChange={(e) => setRow(i, { limitType: e.target.value })}><option value="RANGE">Range</option><option value="MIN">Minimum</option><option value="MAX">Maximum</option><option value="TEXT">Text</option></Select>
            {r.limitType === 'TEXT' ? <div className="col-span-2"><Input aria-label={`Expected ${i + 1}`} placeholder="Expected" value={r.expectedText} onChange={(e) => setRow(i, { expectedText: e.target.value })} /></div> : <>
              <Input aria-label={`Minimum ${i + 1}`} placeholder="Min" type="number" step="any" disabled={r.limitType === 'MAX'} value={r.minValue} onChange={(e) => setRow(i, { minValue: e.target.value })} />
              <Input aria-label={`Maximum ${i + 1}`} placeholder="Max" type="number" step="any" disabled={r.limitType === 'MIN'} value={r.maxValue} onChange={(e) => setRow(i, { maxValue: e.target.value })} /></>}
            <Select aria-label={`Method ${i + 1}`} value={r.methodId} onChange={(e) => setRow(i, { methodId: e.target.value })}><option value="">No method</option>{(methods.data?.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}</Select>
            <Button size="sm" variant="ghost" aria-label={`Remove parameter ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash size={16} /></Button>
          </div>))}
        <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setRows([...rows, { parameter: '', category: 'CHEMICAL', unit: '', limitType: 'RANGE', minValue: '', maxValue: '', expectedText: '', methodId: '' }])}>Add parameter</Button>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- OOS investigations (QC-007, TC-12)
interface Oos { id: string; docNo: string; inspectionId: string; inspectionNo: string; lotId: string; lotNo: string; itemCode: string; itemName: string; parameters: string; status: string;
  phase1Findings: string | null; rootCause: string | null; conclusion: string | null; openedAt: string; retestAuthorisedBy: string | null; closedBy: string | null; closedAt: string | null }
const OosStatus = ({ o }: { o: Pick<Oos, 'status' | 'conclusion'> }) => <StatusBadge status={o.status === 'Closed' ? (o.conclusion === 'Confirmed' ? 'Rejected' : 'Closed') : 'Pending'}
  label={o.status === 'Closed' ? `Closed — ${o.conclusion}` : o.status === 'RetestAuthorised' ? 'Retest authorised' : 'Open'} />;

export function OosListPage() {
  const q = useQuery({ queryKey: ['oos'], queryFn: () => api<{ data: Oos[] }>('/qc/oos') });
  return (
    <>
      <PageHeader title="OOS Investigations" subtitle="Opened automatically when a result is out of specification. The lot is held; a retest needs the QC manager's authorisation, and the original result is kept." />
      <Card padded={false}>{!q.data?.data.length ? <div className="p-5"><EmptyState title="No investigations" text="None of the results recorded against a specification has been out of limits." /></div> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Case</th><th className="px-3 py-3">Lot</th><th className="px-3 py-3">Out of specification</th><th className="px-3 py-3">Opened</th><th className="px-3 py-3">Status</th></tr></thead>
          <tbody>{q.data.data.map((o) => <tr key={o.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/qc/oos/${o.id}`}>{o.docNo}</Link></td>
            <td className="px-3 py-3">{o.lotNo} <span className="text-ink-2">{o.itemCode}</span></td><td className="px-3 py-3">{o.parameters}</td><td className="px-3 py-3 num">{fmtDateTime(o.openedAt)}</td><td className="px-3 py-3"><OosStatus o={o} /></td></tr>)}</tbody></table></div>)}
      </Card>
    </>
  );
}

export function OosDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['oos', id], queryFn: () => api<Oos & { allowedActions: string[]; failedParams: string[]; results: { seq: number; parameter: string; specification: string; result: string; pass: boolean; attempt: number; specParameterId: string; instrumentCode: string | null; analyst: string | null; recordedAt: string }[] }>(`/qc/oos/${id}`) });
  const inst = useQuery({ queryKey: ['instruments-usable'], queryFn: () => api<{ data: Instrument[] }>('/qc/master/instruments?usable=1') });
  const [dialog, setDialog] = useState<null | 'investigate' | 'retest' | 'close'>(null);
  const [f, setF] = useState({ findings: '', authorise: true, conclusion: 'Invalidated', rootCause: '' });
  const [retest, setRetest] = useState<Record<string, { value: string; instrumentId: string }>>({});
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const o = q.data;
  if (!o) return <ErrorBanner error={q.error} />;
  const run = async (fn: () => Promise<unknown>, msg: string) => { setError(null); try { await fn(); toast('success', msg); setDialog(null); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  const failed = o.results.filter((r) => r.attempt === 1 && o.failedParams.includes(r.specParameterId));
  return (
    <>
      <PageHeader title={o.docNo} crumbs={<Link to="/qc/oos" className="hover:text-primary">OOS Investigations</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><OosStatus o={o} /><span>Lot {o.lotNo} · {o.itemCode} — {o.itemName} · <Link className="text-primary" to={`/qc/inspections/${o.inspectionId}`}>{o.inspectionNo}</Link></span></span>}
        actions={<>{o.allowedActions.includes('investigate') && <Button variant="secondary" onClick={() => setDialog('investigate')}>Record investigation</Button>}
          {o.allowedActions.includes('retest') && <Button variant="secondary" onClick={() => setDialog('retest')}>Enter retest</Button>}
          {o.allowedActions.includes('close') && <Button onClick={() => setDialog('close')}>Close case</Button>}</>} />
      <ErrorBanner error={dialog ? null : error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Results (every attempt kept)" padded={false}>
          <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Parameter</th><th className="px-3 py-3">Limit</th><th className="px-3 py-3">Attempt</th><th className="px-3 py-3">Result</th><th className="px-3 py-3">Instrument / analyst</th></tr></thead>
            <tbody>{o.results.map((r) => <tr key={`${r.seq}-${r.attempt}`} className="border-b border-line last:border-0"><td className="px-5 py-3 font-medium">{r.parameter}</td><td className="px-3 py-3 num">{r.specification}</td>
              <td className="px-3 py-3">{r.attempt === 1 ? 'Original' : `Retest ${r.attempt - 1}`}</td>
              <td className={`px-3 py-3 num ${r.pass ? 'text-success-text' : 'text-danger-text'}`}>{r.result} {r.pass ? '✓' : '✗'}</td><td className="px-3 py-3">{r.instrumentCode ?? '—'} · {r.analyst ?? '—'}</td></tr>)}</tbody></table>
        </Card>
        <Card title="Investigation"><KeyValues columns="narrow" items={[['Out of specification', o.parameters], ['Opened', fmtDateTime(o.openedAt)], ['Laboratory investigation', o.phase1Findings ?? '—'],
          ['Retest authorised', o.retestAuthorisedBy ? `by ${o.retestAuthorisedBy}` : '—'], ['Root cause', o.rootCause ?? '—'], ['Conclusion', o.conclusion ?? '—'], ['Closed', o.closedBy ? `${o.closedBy}, ${fmtDateTime(o.closedAt)}` : '—']]} /></Card>
      </div>
      <Modal open={dialog === 'investigate'} onClose={() => setDialog(null)} title="Laboratory investigation" footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={!f.findings.trim()}
        onClick={() => run(() => api(`/qc/oos/${id}/investigate`, { body: { phase1Findings: f.findings, authoriseRetest: f.authorise } }), f.authorise ? 'Retest authorised.' : 'Investigation recorded.')}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Findings (sample handling, instrument, calculation, analyst)" htmlFor="oos-find" required><Textarea id="oos-find" rows={4} value={f.findings} onChange={(e) => setF({ ...f, findings: e.target.value })} /></Field>
        <label className="mt-4 flex items-center gap-3 text-[14px]"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={f.authorise} onChange={(e) => setF({ ...f, authorise: e.target.checked })} />Authorise a retest of the failed parameters</label>
      </Modal>
      <Modal open={dialog === 'retest'} onClose={() => setDialog(null)} title="Retest results" width={720} footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
        <Button disabled={!failed.every((r) => retest[r.specParameterId]?.value)} onClick={() => run(() => api(`/qc/oos/${id}/retest`, { body: { results: failed.map((r) => ({ specParameterId: r.specParameterId, value: retest[r.specParameterId]!.value, instrumentId: retest[r.specParameterId]?.instrumentId || null })) } }), 'Retest recorded.')}>Save retest</Button></>}>
        <ErrorBanner error={error} />
        {failed.map((r) => { const v = retest[r.specParameterId] ?? { value: '', instrumentId: '' }; return (
          <div key={r.seq} className="mb-3 grid grid-cols-[1.4fr_1fr_1fr] items-end gap-3">
            <p className="pb-3 text-[14px]"><span className="font-medium">{r.parameter}</span> <span className="text-ink-2">({r.specification}; was {r.result})</span></p>
            <Select aria-label={`Retest instrument for ${r.parameter}`} value={v.instrumentId} onChange={(e) => setRetest({ ...retest, [r.specParameterId]: { ...v, instrumentId: e.target.value } })}><option value="">Instrument…</option>
              {(inst.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select>
            <Input aria-label={`Retest result for ${r.parameter}`} value={v.value} onChange={(e) => setRetest({ ...retest, [r.specParameterId]: { ...v, value: e.target.value } })} />
          </div>); })}
      </Modal>
      <Modal open={dialog === 'close'} onClose={() => setDialog(null)} title={`Close ${o.docNo}`} footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant={f.conclusion === 'Confirmed' ? 'danger' : 'primary'} disabled={!f.rootCause.trim()}
        onClick={() => run(() => api(`/qc/oos/${id}/close`, { body: { conclusion: f.conclusion, rootCause: f.rootCause } }), 'Case closed.')}>Close case</Button></>}>
        <ErrorBanner error={error instanceof ApiError ? error : null} />
        <div className="space-y-4">
          <Field label="Conclusion" htmlFor="oos-concl" required hint={f.conclusion === 'Confirmed' ? 'The lot fails and must be rejected' : 'Laboratory error: the lot is decided on the authorised retest'}>
            <Select id="oos-concl" value={f.conclusion} onChange={(e) => setF({ ...f, conclusion: e.target.value })}><option value="Invalidated">Invalidated (laboratory error)</option><option value="Confirmed">Confirmed (material fails)</option></Select></Field>
          <Field label="Root cause" htmlFor="oos-rc" required><Textarea id="oos-rc" rows={3} value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- certificate of analysis (QC-006, QC-013)
interface Coa { docNo: string; versionNo: number; issuedAt: string; analyst: string; approver: string; url: string; qrSvg: string;
  content: { lotNo: string; itemCode: string; itemName: string; inspectionNo: string; spec: string | null; mfgDate: { mfg_date: string | null; expiry_date: string | null }; testedAt: string; conclusion: string;
    results: { seq: number; parameter: string; specification: string; result: string; pass: boolean; category: string | null; method: string | null; instrument: string | null }[] } }

export function CoaPrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['coa', id], queryFn: () => api<Coa>(`/qc/inspections/${id}/coa`) });
  useEffect(() => { if (q.data) document.title = `${q.data.docNo} v${q.data.versionNo}`; }, [q.data]);
  if (q.isLoading) return <Skeleton className="m-8 h-96" />;
  const c = q.data;
  if (!c) return <ErrorBanner error={q.error} />;
  const groups = ['PHYSICAL', 'CHEMICAL', 'HEAVY_METAL', 'MICROBIAL', 'OTHER', null].map((g) => ({ g, rows: c.content.results.filter((r) => (r.category ?? null) === g) })).filter((x) => x.rows.length);
  return (
    <div className="mx-auto max-w-[800px] bg-white p-8 text-[13px] text-black">
      <div className="mb-4 flex justify-end print:hidden"><Button icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></div>
      <div className="flex items-start justify-between border-b-2 border-black pb-3">
        <div><p className="text-[18px] font-bold">Dhruv Agro Technologies Pvt. Ltd.</p><p>Quality Control Laboratory</p></div>
        <div className="text-right"><p className="text-[16px] font-bold">CERTIFICATE OF ANALYSIS</p><p>{c.docNo} · version {c.versionNo}</p><p>Issued {fmtDateTime(c.issuedAt)}</p></div>
      </div>
      <table className="mt-4 w-full"><tbody>{[['Product', `${c.content.itemCode} — ${c.content.itemName}`], ['Batch / lot', c.content.lotNo], ['Manufactured / expiry', `${fmtDate(c.content.mfgDate?.mfg_date)} / ${fmtDate(c.content.mfgDate?.expiry_date)}`],
        ['Specification', c.content.spec ?? '—'], ['Inspection', c.content.inspectionNo]].map(([k, v]) => <tr key={k}><td className="w-48 py-0.5 font-semibold">{k}</td><td>{v}</td></tr>)}</tbody></table>
      {groups.map(({ g, rows }) => (
        <div key={g ?? 'x'} className="mt-4"><p className="mb-1 font-bold uppercase">{g ? label(g) : 'Tests'}</p>
          <table className="w-full border border-black"><thead><tr className="border-b border-black text-left"><th className="p-1.5">Parameter</th><th className="p-1.5">Specification</th><th className="p-1.5">Result</th><th className="p-1.5">Method</th><th className="p-1.5">Complies</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.seq} className="border-b border-black/30"><td className="p-1.5">{r.parameter}</td><td className="p-1.5">{r.specification}</td><td className="p-1.5 font-semibold">{r.result}</td><td className="p-1.5">{r.method ?? '—'}</td><td className="p-1.5">{r.pass ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div>))}
      <p className="mt-4 text-[14px] font-bold">Conclusion: {c.content.conclusion}</p>
      <div className="mt-8 flex items-end justify-between gap-6">
        <div><p className="border-t border-black pt-1">Tested by: {c.analyst}<br />QC Analyst · {fmtDateTime(c.content.testedAt)}</p></div>
        <div aria-label="Quality seal" className="grid h-24 w-24 place-items-center rounded-full border-4 border-double border-black text-center text-[10px] font-bold leading-tight">DHRUV AGRO<br />QC<br />APPROVED</div>
        <div><p className="border-t border-black pt-1">Approved by: {c.approver}<br />QC Manager · {fmtDateTime(c.issuedAt)}</p></div>
        <div className="text-center"><div className="h-24 w-24" dangerouslySetInnerHTML={{ __html: c.qrSvg }} /><p className="text-[10px]">Scan to verify</p></div>
      </div>
      <p className="mt-6 text-[10px]">This certificate is issued electronically from the ERP; the signatures are the recorded approvals of the named people. The QR code checks it against the issued record.</p>
    </div>
  );
}

export function VerifyCoaPage() {
  const { docNo } = useParams();
  const [sp] = useSearchParams();
  const q = useQuery({ queryKey: ['verify-coa', docNo, sp.toString()], queryFn: () => api<{ genuine: boolean; docNo?: string; versionNo?: number; current?: boolean; issuedAt?: string; product?: string; lotNo?: string; conclusion?: string }>(
    `/public/coa/${encodeURIComponent(docNo ?? '')}?v=${encodeURIComponent(sp.get('v') ?? '')}&s=${encodeURIComponent(sp.get('s') ?? '')}`) });
  const v = q.data;
  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-4"><div className="card w-full max-w-md p-8 text-center">
      <p className="mb-6 text-[14px] font-semibold text-ink-2">Dhruv Agro — certificate check</p>
      {q.isLoading ? <Skeleton className="h-40" /> : v?.genuine ? <>
        <CheckCircle size={56} weight="fill" className="mx-auto text-success-text" aria-hidden /><h1 className="mt-3 text-[24px] font-semibold">Certificate is genuine</h1>
        <dl className="mt-6 space-y-2 text-left text-[14px]">{[['Certificate', `${v.docNo} v${v.versionNo}`], ['Product', v.product], ['Batch / lot', v.lotNo], ['Issued', fmtDateTime(v.issuedAt)], ['Conclusion', v.conclusion]].map(([k, val]) =>
          <div key={k} className="flex justify-between gap-4"><dt className="text-ink-2">{k}</dt><dd className="font-semibold">{val}</dd></div>)}</dl>
        {v.current === false && <p className="mt-4 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning-text">A newer version of this certificate has been issued.</p>}
      </> : <><XCircle size={56} weight="fill" className="mx-auto text-danger-text" aria-hidden /><h1 className="mt-3 text-[24px] font-semibold">Not recognised</h1><p className="mt-3 text-ink-2">This certificate could not be verified.</p></>}
    </div></div>
  );
}
