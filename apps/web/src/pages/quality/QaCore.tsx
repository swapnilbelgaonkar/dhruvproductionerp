import { Plus, Trash } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../../lib/format';

const lbl = (s: string | null | undefined) => (s ? humanize(s.toLowerCase()) : '—');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); };
const Sev = ({ s }: { s: string }) => <StatusBadge status={s === 'CRITICAL' ? 'Rejected' : s === 'MAJOR' ? 'Pending' : 'Draft'} label={lbl(s)} />;
const St = ({ s }: { s: string }) => <StatusBadge status={['Closed', 'Implemented', 'Approved'].includes(s) ? (s === 'Closed' ? 'Closed' : 'Approved') : ['Rejected', 'Cancelled'].includes(s) ? s : s === 'Draft' ? 'Draft' : 'Pending'}
  label={s === 'EffectivenessCheck' ? 'Effectiveness check' : s} />;

/** One register page: a table of records and a "new" form in a dialog. */
function Register<T extends { id: string }>({ title, subtitle, path, queryKey, columns, rowHref, createLabel, canCreate, form, empty, initialOpen }: {
  title: string; subtitle: string; path: string; queryKey: string; columns: { h: string; c: (r: T) => ReactNode; right?: boolean }[]; rowHref: (r: T) => string;
  createLabel?: string; canCreate?: boolean; form?: (close: () => void) => ReactNode; empty: string; initialOpen?: boolean;
}) {
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(!!initialOpen);
  const q = useQuery({ queryKey: [queryKey, status], queryFn: () => api<{ data: T[] }>(`${path}${status ? `?status=${status}` : ''}`) });
  const nav = useNavigate();
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={canCreate && createLabel && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>{createLabel}</Button>} />
      <div className="mb-4 w-56"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option><option value="Open">Open</option><option value="Closed">Closed</option></Select></div>
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="Nothing here" text={empty} /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            {columns.map((c, i) => <th key={c.h} className={`${i ? 'px-3' : 'px-5'} py-3 ${c.right ? 'text-right' : ''}`}>{c.h}</th>)}</tr></thead>
            <tbody>{q.data.data.map((r) => <tr key={r.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => nav(rowHref(r))}>
              {columns.map((c, i) => <td key={c.h} className={`${i ? 'px-3' : 'px-5'} py-3 ${c.right ? 'text-right' : ''}`}>{c.c(r)}</td>)}</tr>)}</tbody></table></div>
        )}
      </Card>
      {open && form?.(() => setOpen(false))}
    </>
  );
}

/** A dialog with a few fields that posts once and refreshes. */
function ActionDialog({ title, description, fields, submit, onClose, confirm = 'Save', danger }: {
  title: string; description?: string; fields: { key: string; label: string; type?: 'text' | 'textarea' | 'select' | 'date'; options?: [string, string][]; required?: boolean; initial?: string }[];
  submit: (v: Record<string, string>) => Promise<unknown>; onClose: () => void; confirm?: string; danger?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.initial ?? (f.options?.[0]?.[0] ?? '')])));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ok = fields.every((f) => !f.required || (v[f.key] ?? '').trim());
  const go = async () => { setBusy(true); setError(null); try { await submit(v); toast('success', 'Saved.'); await qc.invalidateQueries(); onClose(); } catch (e) { setError(e); } finally { setBusy(false); } };
  return (
    <Modal open onClose={onClose} title={title} description={description} width={640} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={!ok} onClick={go}>{confirm}</Button></>}>
      <ErrorBanner error={error} />
      <div className="space-y-4">{fields.map((f) => (
        <Field key={f.key} label={f.label} htmlFor={`ad-${f.key}`} required={f.required}>
          {f.type === 'textarea' ? <Textarea id={`ad-${f.key}`} rows={3} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
            : f.type === 'select' ? <Select id={`ad-${f.key}`} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>{f.options!.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</Select>
              : <Input id={`ad-${f.key}`} type={f.type === 'date' ? 'date' : 'text'} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}
        </Field>))}</div>
    </Modal>
  );
}
const usePeople = () => useQuery({ queryKey: ['qa-people'], queryFn: () => api<{ data: { id: string; name: string }[] }>('/qa/people') });
const sevOpts: [string, string][] = [['MINOR', 'Minor'], ['MAJOR', 'Major'], ['CRITICAL', 'Critical']];

// ================================================================ CAPA
interface Capa { id: string; docNo: string; title: string; sourceType: string; sourceId: string | null; sourceRef: string | null; problem: string; rootCause: string | null; ownerId: string; owner: string;
  dueDate: string; status: string; effective: boolean | null; verificationNote: string | null; verifiedBy: string | null; verifiedAt: string | null; createdAt: string; actionCount: number; actionsDone: number }

export function CapasPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  return <Register<Capa> title="CAPA" subtitle="Corrective and preventive actions from deviations, non-conformances, complaints, audits and recalls; each closes only after someone other than its owner verifies it worked."
    path="/qa/capas" queryKey="qa-capas" rowHref={(r) => `/qa/capas/${r.id}`} createLabel="New CAPA" canCreate={can('qa.capa:manage')} empty="No CAPA yet." initialOpen={!!sp.get('sourceId') && can('qa.capa:manage')}
    columns={[{ h: 'CAPA', c: (r) => <span className="font-semibold num">{r.docNo}</span> }, { h: 'Title', c: (r) => r.title }, { h: 'Source', c: (r) => `${lbl(r.sourceType)}${r.sourceRef ? ` ${r.sourceRef}` : ''}` },
      { h: 'Owner', c: (r) => r.owner }, { h: 'Due', c: (r) => <span className={r.status !== 'Closed' && r.dueDate < today() ? 'text-danger-text' : ''}>{fmtDate(r.dueDate)}</span> },
      { h: 'Actions', right: true, c: (r) => `${r.actionsDone}/${r.actionCount}` }, { h: 'Status', c: (r) => <St s={r.status} /> }]}
    form={(close) => <CapaForm close={close} sourceType={sp.get('sourceType') ?? 'OTHER'} sourceId={sp.get('sourceId')} sourceRef={sp.get('sourceRef')} />} />;
}

export function CapaForm({ close, sourceType, sourceId, sourceRef }: { close: () => void; sourceType: string; sourceId: string | null; sourceRef: string | null }) {
  const people = usePeople();
  const nav = useNavigate();
  const toast = useToast();
  const [h, setH] = useState({ title: '', problem: '', rootCause: '', ownerId: '', dueDate: plusDays(30), sourceType });
  const [acts, setActs] = useState([{ kind: 'CORRECTION', description: '', ownerId: '', dueDate: plusDays(7) }]);
  const [error, setError] = useState<unknown>(null);
  const ok = h.title && h.problem && h.ownerId && acts.every((a) => a.description && a.ownerId);
  const save = async () => { setError(null); try { const r = await api<{ id: string; docNo: string }>('/qa/capas', { body: { ...h, rootCause: h.rootCause || null, sourceId, sourceRef, actions: acts } }); toast('success', `${r.docNo} opened.`); close(); nav(`/qa/capas/${r.id}`); } catch (e) { setError(e); } };
  const pp = people.data?.data ?? [];
  return (
    <Modal open onClose={close} title={`New CAPA${sourceRef ? ` for ${sourceRef}` : ''}`} width={860} footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button disabled={!ok} onClick={save}>Open CAPA</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><Field label="Title" htmlFor="cp-title" required><Input id="cp-title" value={h.title} onChange={(e) => setH({ ...h, title: e.target.value })} /></Field></div>
        <Field label="Source" htmlFor="cp-src"><Select id="cp-src" value={h.sourceType} disabled={!!sourceId} onChange={(e) => setH({ ...h, sourceType: e.target.value })}>
          {['DEVIATION', 'NON_CONFORMANCE', 'COMPLAINT', 'AUDIT', 'OOS', 'CHANGE', 'RECALL', 'OTHER'].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Owner" htmlFor="cp-owner" required><Select id="cp-owner" value={h.ownerId} onChange={(e) => setH({ ...h, ownerId: e.target.value })}><option value="">Select…</option>{pp.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Due" htmlFor="cp-due" required><Input id="cp-due" type="date" value={h.dueDate} onChange={(e) => setH({ ...h, dueDate: e.target.value })} /></Field></div>
        <Field label="Problem" htmlFor="cp-prob" required><Textarea id="cp-prob" rows={3} value={h.problem} onChange={(e) => setH({ ...h, problem: e.target.value })} /></Field>
        <Field label="Root cause" htmlFor="cp-rc"><Textarea id="cp-rc" rows={3} value={h.rootCause} onChange={(e) => setH({ ...h, rootCause: e.target.value })} /></Field>
      </div>
      <p className="mb-2 mt-5 font-semibold">Actions</p>
      {acts.map((a, i) => (
        <div key={i} className="mb-2 grid grid-cols-[150px_1fr_180px_150px_32px] gap-2">
          <Select aria-label={`Action ${i + 1} kind`} value={a.kind} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}><option value="CORRECTION">Correction</option><option value="CORRECTIVE">Corrective</option><option value="PREVENTIVE">Preventive</option></Select>
          <Input aria-label={`Action ${i + 1}`} placeholder="What will be done" value={a.description} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
          <Select aria-label={`Action ${i + 1} owner`} value={a.ownerId} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, ownerId: e.target.value } : x)))}><option value="">Owner…</option>{pp.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          <Input aria-label={`Action ${i + 1} due`} type="date" value={a.dueDate} onChange={(e) => setActs(acts.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
          <Button size="sm" variant="ghost" aria-label={`Remove action ${i + 1}`} disabled={acts.length === 1} onClick={() => setActs(acts.filter((_, j) => j !== i))}><Trash size={16} /></Button>
        </div>))}
      <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setActs([...acts, { kind: 'CORRECTIVE', description: '', ownerId: '', dueDate: plusDays(14) }])}>Add action</Button>
    </Modal>
  );
}

export function CapaDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['qa-capa', id], queryFn: () => api<Capa & { allowedActions: string[]; overdue: boolean; actions: { id: string; kind: string; description: string; ownerId: string; owner: string; dueDate: string; status: string; evidence: string | null; doneAt: string | null }[] }>(`/qa/capas/${id}`) });
  const { me } = useAuth();
  const [dlg, setDlg] = useState<null | { kind: 'complete'; aid: string } | { kind: 'verify' } | { kind: 'add' }>(null);
  const people = usePeople();
  if (q.isLoading) return <Skeleton className="h-96" />;
  const c = q.data;
  if (!c) return <ErrorBanner error={q.error} />;
  const myId = me?.user.id;
  return (
    <>
      <PageHeader title={c.docNo} crumbs={<Link to="/qa/capas" className="hover:text-primary">CAPA</Link>} subtitle={<span className="inline-flex items-center gap-2"><St s={c.status} />{c.title}{c.overdue && <StatusBadge status="Rejected" label="Overdue" />}</span>}
        actions={<>{c.allowedActions.includes('add_action') && <Button variant="secondary" onClick={() => setDlg({ kind: 'add' })}>Add action</Button>}
          {c.allowedActions.includes('verify') && <Button onClick={() => setDlg({ kind: 'verify' })}>Verify effectiveness</Button>}</>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Actions" padded={false}>
          <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Kind</th><th className="px-3 py-3">Action</th><th className="px-3 py-3">Owner</th><th className="px-3 py-3">Due</th><th className="px-3 py-3">Done</th><th className="px-3 py-3" /></tr></thead>
            <tbody>{c.actions.map((a) => <tr key={a.id} className="border-b border-line align-top last:border-0"><td className="px-5 py-3">{lbl(a.kind)}</td><td className="px-3 py-3">{a.description}{a.evidence && <span className="block text-[13px] text-ink-2">Evidence: {a.evidence}</span>}</td>
              <td className="px-3 py-3">{a.owner}</td><td className="px-3 py-3 num">{fmtDate(a.dueDate)}</td><td className="px-3 py-3">{a.status === 'Done' ? fmtDateTime(a.doneAt) : <St s="Open" />}</td>
              <td className="px-3 py-3 text-right">{a.status === 'Open' && c.allowedActions.includes('complete_action') && (a.ownerId === myId || c.allowedActions.includes('add_action')) && <Button size="sm" onClick={() => setDlg({ kind: 'complete', aid: a.id })}>Mark done</Button>}</td></tr>)}</tbody></table>
        </Card>
        <Card title="CAPA"><KeyValues columns="narrow" items={[['Source', `${lbl(c.sourceType)}${c.sourceRef ? ` ${c.sourceRef}` : ''}`], ['Problem', c.problem], ['Root cause', c.rootCause ?? '—'], ['Owner', c.owner], ['Due', fmtDate(c.dueDate)],
          ['Effectiveness', c.verifiedBy ? `${c.effective ? 'Effective' : 'Not effective'} — ${c.verificationNote} (${c.verifiedBy}, ${fmtDateTime(c.verifiedAt)})` : 'Not verified yet']]} /></Card>
      </div>
      {dlg?.kind === 'complete' && <ActionDialog title="Mark the action done" fields={[{ key: 'evidence', label: 'Evidence (what was done, records)', type: 'textarea', required: true }]} onClose={() => setDlg(null)}
        submit={(v) => api(`/qa/capas/${id}/actions/${dlg.aid}/complete`, { body: v })} />}
      {dlg?.kind === 'verify' && <ActionDialog title="Effectiveness check" description="Did the actions remove the problem? If not, the CAPA reopens for more action." onClose={() => setDlg(null)}
        fields={[{ key: 'effective', label: 'Outcome', type: 'select', options: [['yes', 'Effective — close the CAPA'], ['no', 'Not effective — reopen']] }, { key: 'note', label: 'Evidence', type: 'textarea', required: true }]}
        submit={(v) => api(`/qa/capas/${id}/verify`, { body: { effective: v.effective === 'yes', note: v.note } })} />}
      {dlg?.kind === 'add' && <ActionDialog title="Add an action" onClose={() => setDlg(null)} fields={[{ key: 'kind', label: 'Kind', type: 'select', options: [['CORRECTIVE', 'Corrective'], ['PREVENTIVE', 'Preventive'], ['CORRECTION', 'Correction']] },
        { key: 'description', label: 'Action', required: true }, { key: 'ownerId', label: 'Owner', type: 'select', options: (people.data?.data ?? []).map((p) => [p.id, p.name]) }, { key: 'dueDate', label: 'Due', type: 'date', initial: plusDays(14), required: true }]}
        submit={(v) => api(`/qa/capas/${id}/actions`, { body: v })} />}
    </>
  );
}

// ================================================================ non-conformance
interface Nc { id: string; docNo: string; kind: string; title: string; description: string; severity: string; lotId: string | null; lotNo: string | null; partyName: string | null; disposition: string | null;
  dispositionNote: string | null; capaId: string | null; capaNo: string | null; status: string; raisedBy: string; createdAt: string; closedBy: string | null; closedAt: string | null }
export function NcsPage() {
  const { can } = useAuth();
  return <Register<Nc> title="Non-conformances" subtitle="Material, process, supplier or product not meeting requirements, with its disposition. A critical one needs a CAPA before it closes." path="/qa/ncs" queryKey="qa-ncs"
    rowHref={(r) => `/qa/ncs/${r.id}`} createLabel="Raise non-conformance" canCreate={can('qa.nc:create')} empty="No non-conformances."
    columns={[{ h: 'NC', c: (r) => <span className="font-semibold num">{r.docNo}</span> }, { h: 'What', c: (r) => r.title }, { h: 'Kind', c: (r) => lbl(r.kind) }, { h: 'Severity', c: (r) => <Sev s={r.severity} /> },
      { h: 'Lot / supplier', c: (r) => [r.lotNo, r.partyName].filter(Boolean).join(' · ') || '—' }, { h: 'Raised', c: (r) => fmtDate(r.createdAt) }, { h: 'Status', c: (r) => <St s={r.status} /> }]}
    form={(close) => <ActionDialog title="Raise a non-conformance" onClose={close} confirm="Raise" fields={[{ key: 'title', label: 'What is wrong', required: true }, { key: 'kind', label: 'Kind', type: 'select', options: [['MATERIAL', 'Material'], ['PROCESS', 'Process'], ['SUPPLIER', 'Supplier'], ['PRODUCT', 'Product'], ['OTHER', 'Other']] },
      { key: 'severity', label: 'Severity', type: 'select', options: sevOpts }, { key: 'description', label: 'Details', type: 'textarea', required: true }]} submit={(v) => api('/qa/ncs', { body: v })} />} />;
}
export function NcDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['qa-nc', id], queryFn: () => api<Nc & { allowedActions: string[] }>(`/qa/ncs/${id}`) });
  const [close, setClose] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const n = q.data;
  if (!n) return <ErrorBanner error={q.error} />;
  return (
    <>
      <PageHeader title={n.docNo} crumbs={<Link to="/qa/ncs" className="hover:text-primary">Non-conformances</Link>} subtitle={<span className="inline-flex items-center gap-2"><St s={n.status} /><Sev s={n.severity} />{n.title}</span>}
        actions={n.allowedActions.includes('close') && <>{!n.capaId && <Button variant="secondary" onClick={() => nav(`/qa/capas?sourceType=NON_CONFORMANCE&sourceId=${n.id}&sourceRef=${encodeURIComponent(n.docNo)}`)}>Raise CAPA</Button>}<Button onClick={() => setClose(true)}>Close with disposition</Button></>} />
      <Card><KeyValues items={[['Kind', lbl(n.kind)], ['Details', n.description], ['Lot', n.lotId ? <Link className="text-primary" to={`/stores/lots/${n.lotId}`}>{n.lotNo}</Link> : '—'], ['Supplier', n.partyName ?? '—'],
        ['CAPA', n.capaId ? <Link className="text-primary" to={`/qa/capas/${n.capaId}`}>{n.capaNo}</Link> : '—'], ['Raised', `${n.raisedBy}, ${fmtDateTime(n.createdAt)}`], ['Disposition', n.disposition ? `${lbl(n.disposition)} — ${n.dispositionNote}` : '—'],
        ['Closed', n.closedBy ? `${n.closedBy}, ${fmtDateTime(n.closedAt)}` : '—']]} /></Card>
      {close && <ActionDialog title={`Close ${n.docNo}`} onClose={() => setClose(false)} confirm="Close" fields={[{ key: 'disposition', label: 'Disposition', type: 'select', options: [['USE_AS_IS', 'Use as is'], ['REWORK', 'Rework'], ['RETURN', 'Return to supplier'], ['SCRAP', 'Scrap']] },
        { key: 'note', label: 'Justification', type: 'textarea', required: true }]} submit={(v) => api(`/qa/ncs/${id}/close`, { body: v })} />}
    </>
  );
}

// ================================================================ change control
interface Cc { id: string; docNo: string; title: string; changeType: string; description: string; justification: string; impact: string; risk: string; targetDate: string | null; status: string; statusReason: string | null;
  implementationNote: string | null; requestedBy: string; createdAt: string; approvalId: string | null }
export function ChangesPage() {
  const { can } = useAuth();
  return <Register<Cc> title="Change Control" subtitle="Planned changes to formulations, specifications, processes, equipment, SOPs or suppliers: impact and risk assessed, approved by the QA head (and the executive director when high risk), implemented and closed."
    path="/qa/changes" queryKey="qa-changes" rowHref={(r) => `/qa/changes/${r.id}`} createLabel="Request a change" canCreate={can('qa.change:create')} empty="No change requests."
    columns={[{ h: 'Change', c: (r) => <span className="font-semibold num">{r.docNo}</span> }, { h: 'Title', c: (r) => r.title }, { h: 'Type', c: (r) => lbl(r.changeType) }, { h: 'Risk', c: (r) => <Sev s={r.risk === 'HIGH' ? 'CRITICAL' : r.risk === 'MEDIUM' ? 'MAJOR' : 'MINOR'} /> },
      { h: 'Requested by', c: (r) => r.requestedBy }, { h: 'Status', c: (r) => <St s={r.status} /> }]}
    form={(close) => <ActionDialog title="Request a change" onClose={close} confirm="Save draft" fields={[{ key: 'title', label: 'Title', required: true },
      { key: 'changeType', label: 'Type', type: 'select', options: ['FORMULATION', 'SPECIFICATION', 'PROCESS', 'EQUIPMENT', 'SOP', 'SUPPLIER', 'OTHER'].map((x) => [x, lbl(x)]) },
      { key: 'risk', label: 'Risk', type: 'select', options: [['LOW', 'Low'], ['MEDIUM', 'Medium'], ['HIGH', 'High']] }, { key: 'description', label: 'The change', type: 'textarea', required: true },
      { key: 'justification', label: 'Why', type: 'textarea', required: true }, { key: 'impact', label: 'Impact (quality, regulatory, stock, documents)', type: 'textarea', required: true }]}
      submit={(v) => api('/qa/changes', { body: v })} />} />;
}
export function ChangeDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['qa-change', id], queryFn: () => api<Cc & { allowedActions: string[] }>(`/qa/changes/${id}`) });
  const [dlg, setDlg] = useState<null | 'implement' | 'close'>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const c = q.data;
  if (!c) return <ErrorBanner error={q.error} />;
  return (
    <>
      <PageHeader title={c.docNo} crumbs={<Link to="/qa/changes" className="hover:text-primary">Change Control</Link>} subtitle={<span className="inline-flex items-center gap-2"><St s={c.status} />{c.title}</span>}
        actions={<>{c.allowedActions.includes('submit') && <Button onClick={async () => { const r = await api<{ approvalDocNo: string }>(`/qa/changes/${id}/submit`, { body: {} }); toast('success', `Sent for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); }}>Submit for approval</Button>}
          {c.allowedActions.includes('implement') && <Button onClick={() => setDlg('implement')}>Record implementation</Button>}{c.allowedActions.includes('close') && <Button onClick={() => setDlg('close')}>Close</Button>}</>} />
      <Card><KeyValues items={[['Type', lbl(c.changeType)], ['Risk', lbl(c.risk)], ['Change', c.description], ['Justification', c.justification], ['Impact', c.impact], ['Target', fmtDate(c.targetDate)],
        ['Requested by', `${c.requestedBy}, ${fmtDateTime(c.createdAt)}`], ['Approval', c.approvalId ? <Link className="text-primary" to={`/approvals/${c.approvalId}`}>View</Link> : '—'], ['Implementation', c.implementationNote ?? '—']]} /></Card>
      {dlg && <ActionDialog title={dlg === 'implement' ? 'Record implementation' : 'Close the change'} onClose={() => setDlg(null)} fields={[{ key: 'note', label: dlg === 'implement' ? 'What was implemented' : 'Verification', type: 'textarea', required: true }]}
        submit={(v) => api(`/qa/changes/${id}/${dlg}`, { body: v })} />}
    </>
  );
}

// ================================================================ complaints
interface Cmp { id: string; docNo: string; partyId: string | null; partyName: string | null; partyCode: string | null; receivedOn: string; channel: string; itemCode: string | null; itemName: string | null; lotId: string | null; lotNo: string | null;
  boxSerial: string | null; category: string; description: string; severity: string; status: string; findings: string | null; conclusion: string | null; response: string | null; capaId: string | null; capaNo: string | null;
  loggedBy: string; createdAt: string; closedBy: string | null; closedAt: string | null; recallId: string | null }
export function ComplaintsPage() {
  const { can } = useAuth();
  const dealers = useQuery({ queryKey: ['dealers-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/dealers?usable=1&limit=100').catch(() => ({ data: [], total: 0 })) });
  return <Register<Cmp> title="Complaints" subtitle="Dealer and farmer complaints, traced to the lot from the box label, investigated by QA and linked to CAPA and recall." path="/qa/complaints" queryKey="qa-complaints"
    rowHref={(r) => `/qa/complaints/${r.id}`} createLabel="Log complaint" canCreate={can('qa.complaint:create')} empty="No complaints."
    columns={[{ h: 'Complaint', c: (r) => <span className="font-semibold num">{r.docNo}</span> }, { h: 'Dealer', c: (r) => r.partyName ?? '—' }, { h: 'Product / lot', c: (r) => [r.itemCode, r.lotNo].filter(Boolean).join(' · ') || '—' },
      { h: 'Category', c: (r) => lbl(r.category) }, { h: 'Severity', c: (r) => <Sev s={r.severity} /> }, { h: 'Received', c: (r) => fmtDate(r.receivedOn) }, { h: 'Status', c: (r) => <St s={r.status} /> }]}
    form={(close) => <ActionDialog title="Log a complaint" description="The box serial printed under the QR code identifies the batch." onClose={close} confirm="Log complaint"
      fields={[{ key: 'partyId', label: 'Dealer', type: 'select', options: [['', '—'], ...(dealers.data?.data ?? []).map((d) => [d.id, `${d.code} — ${d.legalName}`] as [string, string])] },
        { key: 'boxSerial', label: 'Box serial (from the label)' }, { key: 'receivedOn', label: 'Received on', type: 'date', initial: today(), required: true },
        { key: 'channel', label: 'Received by', type: 'select', options: ['FIELD_VISIT', 'PHONE', 'EMAIL', 'WHATSAPP', 'LETTER', 'OTHER'].map((x) => [x, lbl(x)]) },
        { key: 'category', label: 'Category', type: 'select', options: ['QUALITY', 'EFFICACY', 'PACKAGING', 'LABELLING', 'QUANTITY', 'DAMAGE', 'OTHER'].map((x) => [x, lbl(x)]) },
        { key: 'severity', label: 'Severity', type: 'select', options: sevOpts }, { key: 'description', label: 'Complaint', type: 'textarea', required: true }]}
      submit={(v) => api('/qa/complaints', { body: { ...v, partyId: v.partyId || null, boxSerial: v.boxSerial || null } })} />} />;
}
export function ComplaintDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['qa-complaint', id], queryFn: () => api<Cmp & { allowedActions: string[] }>(`/qa/complaints/${id}`) });
  const [dlg, setDlg] = useState<null | 'investigate' | 'close' | 'recall'>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const c = q.data;
  if (!c) return <ErrorBanner error={q.error} />;
  const a = c.allowedActions;
  return (
    <>
      <PageHeader title={c.docNo} crumbs={<Link to="/qa/complaints" className="hover:text-primary">Complaints</Link>} subtitle={<span className="inline-flex items-center gap-2"><St s={c.status} /><Sev s={c.severity} />{lbl(c.category)} · {c.partyName ?? 'no dealer'}</span>}
        actions={<>{a.includes('investigate') && <Button variant="secondary" onClick={() => setDlg('investigate')}>Record findings</Button>}
          {a.includes('close') && !c.capaId && <Button variant="secondary" onClick={() => nav(`/qa/capas?sourceType=COMPLAINT&sourceId=${c.id}&sourceRef=${encodeURIComponent(c.docNo)}`)}>Raise CAPA</Button>}
          {c.lotId && !c.recallId && can('qa.recall:drill') && <Button variant="danger" onClick={() => setDlg('recall')}>Start recall…</Button>}
          {a.includes('close') && <Button onClick={() => setDlg('close')}>Close</Button>}</>} />
      <Card><KeyValues items={[['Complaint', c.description], ['Product', c.itemCode ? `${c.itemCode} — ${c.itemName}` : '—'], ['Lot', c.lotId ? <Link className="text-primary" to={`/stores/lots/${c.lotId}`}>{c.lotNo}</Link> : '—'],
        ['Box', c.boxSerial ?? '—'], ['Received', `${fmtDate(c.receivedOn)} by ${lbl(c.channel)}`], ['Logged by', `${c.loggedBy}, ${fmtDateTime(c.createdAt)}`], ['Findings', c.findings ?? '—'],
        ['CAPA', c.capaId ? <Link className="text-primary" to={`/qa/capas/${c.capaId}`}>{c.capaNo}</Link> : '—'], ['Recall', c.recallId ? <Link className="text-primary" to={`/qa/recalls/${c.recallId}`}>View recall</Link> : '—'],
        ['Conclusion', c.conclusion ? `${c.conclusion === 'Justified' ? 'Justified' : 'Not justified'} — ${c.response}` : '—']]} /></Card>
      {dlg === 'investigate' && <ActionDialog title="Investigation findings" onClose={() => setDlg(null)} fields={[{ key: 'findings', label: 'Findings (retained sample, batch record, field visit)', type: 'textarea', required: true, initial: c.findings ?? '' }]} submit={(v) => api(`/qa/complaints/${id}/investigate`, { body: v })} />}
      {dlg === 'close' && <ActionDialog title={`Close ${c.docNo}`} onClose={() => setDlg(null)} confirm="Close" fields={[{ key: 'conclusion', label: 'Conclusion', type: 'select', options: [['Justified', 'Justified'], ['NotJustified', 'Not justified']] },
        { key: 'response', label: 'Response to the dealer', type: 'textarea', required: true }]} submit={(v) => api(`/qa/complaints/${id}/close`, { body: v })} />}
      {dlg === 'recall' && <RecallDialog lotId={c.lotId!} lotNo={c.lotNo!} complaintId={c.id} onClose={() => setDlg(null)} />}
    </>
  );
}

// ================================================================ recall (QA-008, QA-016)
interface Rcl { id: string; docNo: string; mode: string; reason: string; sourceLotId: string; sourceLotNo: string; itemCode: string; complaintId: string | null; complaintNo: string | null; status: string;
  initiatedBy: string; initiatedAt: string; tracedAt: string | null; lockedAt: string | null; traceSeconds: number | null; closureNote: string | null; closedBy: string | null; closedAt: string | null; lotCount: number }
export function RecallDialog({ lotId, lotNo, complaintId, onClose }: { lotId: string; lotNo: string; complaintId?: string; onClose: () => void }) {
  const { can } = useAuth();
  const nav = useNavigate();
  return <ActionDialog title={`Recall from lot ${lotNo}`} danger confirm="Start" onClose={onClose}
    description="Traces every lot made from this one. A drill only identifies them; an actual recall also puts all their stock on hold."
    fields={[{ key: 'mode', label: 'Mode', type: 'select', options: can('qa.recall:actual') ? [['DRILL', 'Drill (mock recall)'], ['ACTUAL', 'Actual recall — lock stock']] : [['DRILL', 'Drill (mock recall)']] },
      { key: 'reason', label: 'Reason', type: 'textarea', required: true }]}
    submit={async (v) => { const r = await api<{ id: string }>('/qa/recalls', { body: { mode: v.mode, reason: v.reason, sourceLotId: lotId, complaintId: complaintId ?? null } }); nav(`/qa/recalls/${r.id}`); }} />;
}
export function RecallsPage() {
  const { can } = useAuth();
  const lots = useQuery({ queryKey: ['lots-all'], queryFn: () => api<Page<{ id: string; lotNo: string; itemCode: string }>>('/stock/lots?limit=100') });
  const [pick, setPick] = useState('');
  const [open, setOpen] = useState(false);
  const lot = lots.data?.data.find((l) => l.id === pick);
  return (
    <>
      <Register<Rcl> title="Recalls" subtitle="Mock and actual recalls: from one lot, every lot made from it is traced with its stock and boxes; an actual recall locks them. Target: traced and locked within 2 hours (QA-016)."
        path="/qa/recalls" queryKey="qa-recalls" rowHref={(r) => `/qa/recalls/${r.id}`} empty="No recalls or drills yet."
        columns={[{ h: 'Recall', c: (r) => <span className="font-semibold num">{r.docNo}</span> }, { h: 'Mode', c: (r) => (r.mode === 'ACTUAL' ? <StatusBadge status="Rejected" label="Actual" /> : <StatusBadge status="Draft" label="Drill" />) },
          { h: 'From lot', c: (r) => `${r.sourceLotNo} · ${r.itemCode}` }, { h: 'Lots traced', right: true, c: (r) => r.lotCount }, { h: 'Time to trace', c: (r) => (r.traceSeconds === null ? '—' : `${r.traceSeconds} s`) },
          { h: 'Started', c: (r) => fmtDateTime(r.initiatedAt) }, { h: 'Status', c: (r) => <St s={r.status} /> }]} />
      {can('qa.recall:drill') && <Card className="mt-6" title="Start a recall or drill">
        <div className="flex flex-wrap items-end gap-3"><div className="w-96"><Field label="Lot" htmlFor="rc-lot"><Select id="rc-lot" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Select…</option>
          {(lots.data?.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.lotNo} — {l.itemCode}</option>)}</Select></Field></div>
          <Button variant="danger" disabled={!lot} onClick={() => setOpen(true)}>Start…</Button></div>
      </Card>}
      {open && lot && <RecallDialog lotId={lot.id} lotNo={lot.lotNo} onClose={() => setOpen(false)} />}
    </>
  );
}
export function RecallDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['qa-recall', id], queryFn: () => api<Rcl & { allowedActions: string[]; lots: { lotId: string; lotNo: string; itemCode: string; itemName: string; uom: string; depth: number; relation: string; producedQty: string | null; onHandQty: string; boxes: number; lockedQty: string; qcStatus: string }[] }>(`/qa/recalls/${id}`) });
  const [close, setClose] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const r = q.data;
  if (!r) return <ErrorBanner error={q.error} />;
  const within = (r.traceSeconds ?? 0) <= 7200;
  return (
    <>
      <PageHeader title={r.docNo} crumbs={<Link to="/qa/recalls" className="hover:text-primary">Recalls</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><St s={r.status} />{r.mode === 'ACTUAL' ? <StatusBadge status="Rejected" label="Actual recall" /> : <StatusBadge status="Draft" label="Drill" />}<span>from lot {r.sourceLotNo} · {r.itemCode}</span></span>}
        actions={r.allowedActions.includes('close') && <Button onClick={() => setClose(true)}>Close</Button>} />
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <div className="card p-5"><p className="text-[13px] font-semibold text-ink-2">Lots traced</p><p className="mt-2 text-[32px] font-semibold num">{r.lots.length}</p></div>
        <div className="card p-5"><p className="text-[13px] font-semibold text-ink-2">Time to trace{r.mode === 'ACTUAL' ? ' and lock' : ''}</p><p className="mt-2 text-[32px] font-semibold num">{r.traceSeconds} s</p>
          <p className={`mt-1 text-[13px] ${within ? 'text-success-text' : 'text-danger-text'}`}>{within ? 'Within the 2-hour target' : 'Beyond the 2-hour target'}</p></div>
        <div className="card p-5"><p className="text-[13px] font-semibold text-ink-2">{r.mode === 'ACTUAL' ? 'Stock locked' : 'Stock that would be locked'}</p>
          <p className="mt-2 text-[32px] font-semibold num">{fmtNum(r.lots.reduce((a, l) => a + Number(r.mode === 'ACTUAL' ? l.lockedQty : l.onHandQty), 0))}</p><p className="mt-1 text-[13px] text-ink-2">{r.lots.reduce((a, l) => a + l.boxes, 0)} boxes · shipments join with logistics</p></div>
      </div>
      <Card title="Affected lots" padded={false}>
        <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Lot</th><th className="px-3 py-3">Relation</th><th className="px-3 py-3 text-right">Produced</th>
          <th className="px-3 py-3 text-right">On hand</th><th className="px-3 py-3 text-right">Boxes</th><th className="px-3 py-3 text-right">Locked</th><th className="px-3 py-3">Status</th></tr></thead>
          <tbody>{r.lots.map((l) => <tr key={l.lotId} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/stores/lots/${l.lotId}`}>{l.lotNo}</Link> <span className="text-ink-2">{l.itemCode}</span></td>
            <td className="px-3 py-3">{l.relation === 'SOURCE' ? 'Source' : `Made from it (level ${l.depth})`}</td><td className="px-3 py-3 text-right num">{l.producedQty ? fmtNum(Number(l.producedQty)) : '—'}</td>
            <td className="px-3 py-3 text-right num">{fmtNum(Number(l.onHandQty))} {l.uom}</td><td className="px-3 py-3 text-right num">{l.boxes}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(l.lockedQty))}</td><td className="px-3 py-3">{l.qcStatus}</td></tr>)}</tbody></table>
      </Card>
      <Card className="mt-6" title="Record"><KeyValues items={[['Reason', r.reason], ['Complaint', r.complaintId ? <Link className="text-primary" to={`/qa/complaints/${r.complaintId}`}>{r.complaintNo}</Link> : '—'], ['Started', `${r.initiatedBy}, ${fmtDateTime(r.initiatedAt)}`],
        ['Traced', fmtDateTime(r.tracedAt)], ['Locked', r.lockedAt ? fmtDateTime(r.lockedAt) : '—'], ['Closed', r.closedBy ? `${r.closedBy}, ${fmtDateTime(r.closedAt)} — ${r.closureNote}` : '—']]} /></Card>
      {close && <ActionDialog title={`Close ${r.docNo}`} onClose={() => setClose(false)} confirm="Close" fields={[{ key: 'note', label: 'Reconciliation and outcome', type: 'textarea', required: true }]} submit={(v) => api(`/qa/recalls/${id}/close`, { body: v })} />}
    </>
  );
}
