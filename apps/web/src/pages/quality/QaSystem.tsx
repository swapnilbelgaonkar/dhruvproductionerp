import { CheckCircle, Plus, XCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api, uploadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, humanize } from '../../lib/format';

const lbl = (s: string | null | undefined) => (s ? humanize(s.toLowerCase()) : '—');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); };
const usePeople = () => useQuery({ queryKey: ['qa-people'], queryFn: () => api<{ data: { id: string; name: string }[] }>('/qa/people') });
const th = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';

// ================================================================ controlled documents (QA-006, QA-018) and training (QA-011)
interface Doc { id: string; code: string; title: string; docType: string; department: string; owner: string; reviewMonths: number; status: string; currentVersion: number | null; effectiveFrom: string | null;
  reviewDue: string | null; reviewState: string | null; pendingCount: number; roles: string[] }
const ReviewBadge = ({ s }: { s: string | null }) => (!s ? <StatusBadge status="Draft" label="Not effective yet" /> : s === 'Overdue' ? <StatusBadge status="Rejected" label="Review overdue" />
  : s === 'DueSoon' ? <StatusBadge status="Pending" label="Review due soon" /> : <StatusBadge status="Active" label="In date" />);

export function DocumentsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'documents' | 'training'>('documents');
  const q = useQuery({ queryKey: ['qa-documents'], queryFn: () => api<{ data: Doc[] }>('/qa/documents') });
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Documents & Training" subtitle="Controlled SOPs, test procedures and policies with approved versions and a review every two years; and who must be trained on each effective version."
        actions={can('qa.document:manage') && tab === 'documents' && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>New document</Button>} />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'documents', label: 'Documents' }, { value: 'training', label: 'Training matrix' }]} /></div>
      {tab === 'training' ? <TrainingMatrix /> : (
        <Card padded={false}>{!q.data?.data.length ? <div className="p-5"><EmptyState title="No controlled documents" text="Add the SOPs and test procedures the plant and laboratory work to." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]"><thead><tr className={th}><th className="px-5 py-3">Document</th><th className="px-3 py-3">Type</th><th className="px-3 py-3">Owner</th>
            <th className="px-3 py-3">Version</th><th className="px-3 py-3">Review due</th><th className="px-3 py-3">Training for</th></tr></thead>
            <tbody>{q.data.data.map((d) => <tr key={d.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/qa/documents/${d.id}`}>{d.code}</Link><span className="block text-[13px] text-ink-2">{d.title}</span></td>
              <td className="px-3 py-3">{d.docType} · {d.department}</td><td className="px-3 py-3">{d.owner}</td><td className="px-3 py-3">{d.currentVersion ? `v${d.currentVersion} from ${fmtDate(d.effectiveFrom)}` : '—'}{d.pendingCount ? <span className="block"><StatusBadge status="Pending" label="New version pending" /></span> : null}</td>
              <td className="px-3 py-3"><span className="num">{fmtDate(d.reviewDue)}</span> <ReviewBadge s={d.reviewState} /></td><td className="px-3 py-3">{d.roles.length ? d.roles.map(lbl).join(', ') : '—'}</td></tr>)}</tbody></table></div>)}
        </Card>
      )}
      {open && <NewDocument onClose={() => setOpen(false)} />}
    </>
  );
}

function NewDocument({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const people = usePeople();
  const roles = useQuery({ queryKey: ['qa-roles'], queryFn: () => api<{ data: { code: string; name: string; department: string }[] }>('/qa/roles') });
  const [f, setF] = useState({ code: '', title: '', docType: 'SOP', department: '', ownerId: '', reviewMonths: '24' });
  const [sel, setSel] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api('/qa/documents', { body: { ...f, reviewMonths: Number(f.reviewMonths), roles: sel } }); toast('success', 'Document created. Add its first version.'); await qc.invalidateQueries({ queryKey: ['qa-documents'] }); onClose(); } catch (e) { setError(e); } };
  return (
    <Modal open onClose={onClose} title="New controlled document" width={720} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={!f.code || !f.title || !f.department || !f.ownerId} onClick={save}>Create</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Code" htmlFor="doc-code" required hint="e.g. SOP-PRD-001"><Input id="doc-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Type" htmlFor="doc-type"><Select id="doc-type" value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}>{['SOP', 'STP', 'POLICY', 'WORK_INSTRUCTION', 'FORM', 'MANUAL'].map((t) => <option key={t} value={t}>{lbl(t)}</option>)}</Select></Field>
        <div className="md:col-span-2"><Field label="Title" htmlFor="doc-title" required><Input id="doc-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
        <Field label="Department" htmlFor="doc-dept" required><Input id="doc-dept" value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Owner" htmlFor="doc-owner" required><Select id="doc-owner" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">Select…</option>{(people.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Review (months)" htmlFor="doc-rev"><Input id="doc-rev" type="number" min="1" max="60" value={f.reviewMonths} onChange={(e) => setF({ ...f, reviewMonths: e.target.value })} /></Field></div>
      </div>
      <p className="mb-2 mt-5 font-semibold">Roles that must be trained</p>
      <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-3 text-[14px]">{(roles.data?.data ?? []).map((r) => (
        <label key={r.code} className="flex items-center gap-2"><input type="checkbox" checked={sel.includes(r.code)} onChange={(e) => setSel(e.target.checked ? [...sel, r.code] : sel.filter((x) => x !== r.code))} />{r.name}</label>))}</div>
    </Modal>
  );
}

export function DocumentDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const people = usePeople();
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['qa-document', id], queryFn: () => api<Doc & { canManage: boolean; versions: { id: string; versionNo: number; effectiveFrom: string; reviewDue: string; changeSummary: string; fileId: string | null; fileVersionId: string | null; trainingRequired: boolean; status: string; author: string; approvedAt: string | null; approvalId: string | null; trained: number }[] }>(`/qa/documents/${id}`) });
  const [ver, setVer] = useState(false);
  const [train, setTrain] = useState<string | null>(null);
  const [f, setF] = useState({ effectiveFrom: today(), changeSummary: '', trainingRequired: true });
  const [file, setFile] = useState<File | null>(null);
  const [t, setT] = useState({ userIds: [] as string[], trainedOn: today(), trainer: '', assessment: 'Pass', score: '' });
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const d = q.data;
  if (!d) return <ErrorBanner error={q.error} />;
  const open = d.versions.find((v) => ['Draft', 'Submitted', 'Rejected'].includes(v.status));
  const saveVersion = async () => {
    setError(null);
    try {
      const fileId = file ? (await uploadFile<{ id: string }>('/documents', file, { documentType: 'CONTROLLED_DOCUMENT', entityType: 'qa.controlled_document', entityId: id!, title: `${d.code} v${(d.versions[0]?.versionNo ?? 0) + 1}` })).id : null;
      await api(`/qa/documents/${id}/versions`, { body: { ...f, fileId } }); toast('success', 'Version saved as Draft.'); setVer(false); setFile(null); await qc.invalidateQueries();
    } catch (e) { setError(e); }
  };
  const submit = async (vid: string) => { try { const r = await api<{ approvalDocNo: string }>(`/qa/documents/${id}/versions/${vid}/submit`, { body: {} }); toast('success', `Sent for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  const saveTraining = async () => { setError(null); try { await api('/qa/training', { body: { documentVersionId: train, userIds: t.userIds, trainedOn: t.trainedOn, trainer: t.trainer, assessment: t.assessment, score: t.score === '' ? null : Number(t.score) } }); toast('success', 'Training recorded.'); setTrain(null); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  return (
    <>
      <PageHeader title={d.code} crumbs={<Link to="/qa/documents" className="hover:text-primary">Documents & Training</Link>} subtitle={<span className="inline-flex items-center gap-2"><ReviewBadge s={d.reviewState} />{d.title} · {d.docType} · owner {d.owner}</span>}
        actions={d.canManage && !open && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setVer(true)}>{d.versions.length ? 'New version' : 'Add first version'}</Button>} />
      <ErrorBanner error={ver || train ? null : error} />
      <Card title="Versions" padded={false}>
        {!d.versions.length ? <div className="p-5"><EmptyState title="No versions" text="Upload the document file as version 1; a QA manager reviews and the QA head approves it." /></div> : (
          <table className="w-full text-[14px]"><thead><tr className={th}><th className="px-5 py-3">Version</th><th className="px-3 py-3">Effective / review</th><th className="px-3 py-3">Change</th><th className="px-3 py-3">File</th><th className="px-3 py-3 text-right">Trained</th><th className="px-3 py-3">Status</th><th className="px-3 py-3" /></tr></thead>
            <tbody>{d.versions.map((v) => <tr key={v.id} className="border-b border-line last:border-0"><td className="px-5 py-3 font-semibold">v{v.versionNo}</td>
              <td className="px-3 py-3 num">{fmtDate(v.effectiveFrom)} / {fmtDate(v.reviewDue)}</td><td className="px-3 py-3">{v.changeSummary}<span className="block text-[12px] text-ink-2">{v.author}</span></td>
              <td className="px-3 py-3">{v.fileVersionId ? <button type="button" className="text-primary" onClick={async () => { const { url } = await api<{ url: string }>(`/documents/versions/${v.fileVersionId}/link`, { method: 'POST' }); window.open(url + '&inline=1', '_blank', 'noopener'); }}>Open</button> : '—'}</td>
              <td className="px-3 py-3 text-right num">{v.trainingRequired ? v.trained : 'Not required'}</td>
              <td className="px-3 py-3"><StatusBadge status={v.status === 'Effective' ? 'Active' : v.status === 'Superseded' ? 'Superseded' : v.status === 'Submitted' ? 'Pending' : v.status} label={v.status} />{v.approvalId && <Link className="ml-2 text-[13px] text-primary" to={`/approvals/${v.approvalId}`}>approval</Link>}</td>
              <td className="px-3 py-3 text-right">{d.canManage && ['Draft', 'Rejected'].includes(v.status) && <Button size="sm" onClick={() => submit(v.id)}>Submit</Button>}
                {v.status === 'Effective' && v.trainingRequired && can('qa.training:record') && <Button size="sm" variant="secondary" onClick={() => setTrain(v.id)}>Record training</Button>}</td></tr>)}</tbody></table>)}
      </Card>
      <Modal open={ver} onClose={() => setVer(false)} title="New version" footer={<><Button variant="secondary" onClick={() => setVer(false)}>Cancel</Button><Button disabled={!f.changeSummary.trim() || !file} onClick={saveVersion}>Save draft</Button></>}>
        <ErrorBanner error={error} />
        <div className="space-y-4">
          <Field label="Document file (PDF)" htmlFor="dv-file" required><input id="dv-file" type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Field label="Effective from" htmlFor="dv-from" required><Input id="dv-from" type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} /></Field>
          <Field label="What changed" htmlFor="dv-change" required><Textarea id="dv-change" rows={2} value={f.changeSummary} onChange={(e) => setF({ ...f, changeSummary: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-[14px]"><input type="checkbox" checked={f.trainingRequired} onChange={(e) => setF({ ...f, trainingRequired: e.target.checked })} />People in the listed roles must be trained on this version</label>
        </div>
      </Modal>
      <Modal open={!!train} onClose={() => setTrain(null)} title="Record training" width={640} footer={<><Button variant="secondary" onClick={() => setTrain(null)}>Cancel</Button><Button disabled={!t.userIds.length || !t.trainer.trim()} onClick={saveTraining}>Record</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Date" htmlFor="tr-date" required><Input id="tr-date" type="date" max={today()} value={t.trainedOn} onChange={(e) => setT({ ...t, trainedOn: e.target.value })} /></Field>
          <Field label="Trainer" htmlFor="tr-by" required><Input id="tr-by" value={t.trainer} onChange={(e) => setT({ ...t, trainer: e.target.value })} /></Field>
          <Field label="Assessment" htmlFor="tr-as"><Select id="tr-as" value={t.assessment} onChange={(e) => setT({ ...t, assessment: e.target.value })}><option>Pass</option><option>Fail</option></Select></Field>
          <Field label="Score %" htmlFor="tr-score"><Input id="tr-score" type="number" min="0" max="100" value={t.score} onChange={(e) => setT({ ...t, score: e.target.value })} /></Field>
        </div>
        <p className="mb-2 mt-4 font-semibold">People trained</p>
        <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-3 text-[14px]">{(people.data?.data ?? []).map((p) => (
          <label key={p.id} className="flex items-center gap-2"><input type="checkbox" checked={t.userIds.includes(p.id)} onChange={(e) => setT({ ...t, userIds: e.target.checked ? [...t.userIds, p.id] : t.userIds.filter((x) => x !== p.id) })} />{p.name}</label>))}</div>
      </Modal>
    </>
  );
}

function TrainingMatrix() {
  const q = useQuery({ queryKey: ['qa-training-matrix'], queryFn: () => api<{ data: { documentId: string; code: string; title: string; versionNo: number; userId: string; userName: string; roles: string; trainedOn: string | null }[]; gaps: number }>('/qa/training/matrix') });
  if (q.isLoading) return <Skeleton className="h-60" />;
  const rows = q.data?.data ?? [];
  return (
    <Card padded={false} title={<span>Training matrix {q.data?.gaps ? <StatusBadge status="Rejected" label={`${q.data.gaps} not trained`} /> : rows.length ? <StatusBadge status="Approved" label="Everyone trained" /> : null}</span>}>
      {!rows.length ? <div className="p-5"><EmptyState title="No training required yet" text="Documents that list roles to be trained appear here once a version is effective." /></div> : (
        <table className="w-full text-[14px]"><thead><tr className={th}><th className="px-5 py-3">Document</th><th className="px-3 py-3">Person</th><th className="px-3 py-3">Role</th><th className="px-3 py-3">Trained</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={`${r.documentId}-${r.userId}`} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="text-primary" to={`/qa/documents/${r.documentId}`}>{r.code}</Link> v{r.versionNo}</td>
            <td className="px-3 py-3">{r.userName}</td><td className="px-3 py-3">{lbl(r.roles)}</td><td className="px-3 py-3">{r.trainedOn ? <span className="inline-flex items-center gap-1 text-success-text"><CheckCircle size={16} weight="fill" />{fmtDate(r.trainedOn)}</span> : <span className="inline-flex items-center gap-1 text-danger-text"><XCircle size={16} weight="fill" />Not trained</span>}</td></tr>)}</tbody></table>)}
    </Card>
  );
}

// ================================================================ audits (QA-010)
interface Audit { id: string; docNo: string; auditType: string; title: string; scope: string; partyName: string | null; auditor: string; plannedDate: string; status: string; summary: string | null; findings: number; openMajor: number; closedBy: string | null; closedAt: string | null }
export function AuditsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['qa-audits'], queryFn: () => api<{ data: Audit[] }>('/qa/audits') });
  const vendors = useQuery({ queryKey: ['vendors-active'], queryFn: () => api<{ data: { id: string; code: string; legalName: string }[] }>('/vendors?usable=1&limit=100').catch(() => ({ data: [] })) });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ auditType: 'INTERNAL', title: '', scope: '', partyId: '', auditor: '', plannedDate: plusDays(7) });
  const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null); try { await api('/qa/audits', { body: { ...f, partyId: f.partyId || null } }); toast('success', 'Audit planned.'); setOpen(false); await qc.invalidateQueries({ queryKey: ['qa-audits'] }); } catch (e) { setError(e); } };
  return (
    <>
      <PageHeader title="Audits" subtitle="Internal, supplier, customer and regulatory audits; a major or critical finding needs a CAPA before the audit closes." actions={can('qa.audit:manage') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Plan audit</Button>} />
      <Card padded={false}>{!q.data?.data.length ? <div className="p-5"><EmptyState title="No audits" text="Plan the internal audit programme and supplier audits here." /></div> : (
        <table className="w-full text-[14px]"><thead><tr className={th}><th className="px-5 py-3">Audit</th><th className="px-3 py-3">Type</th><th className="px-3 py-3">Date</th><th className="px-3 py-3">Auditor</th><th className="px-3 py-3 text-right">Findings</th><th className="px-3 py-3">Status</th></tr></thead>
          <tbody>{q.data.data.map((a) => <tr key={a.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/qa/audits/${a.id}`}>{a.docNo}</Link><span className="block text-[13px] text-ink-2">{a.title}{a.partyName ? ` · ${a.partyName}` : ''}</span></td>
            <td className="px-3 py-3">{lbl(a.auditType)}</td><td className="px-3 py-3 num">{fmtDate(a.plannedDate)}</td><td className="px-3 py-3">{a.auditor}</td><td className="px-3 py-3 text-right num">{a.findings}{a.openMajor ? <span className="text-danger-text"> ({a.openMajor} need CAPA)</span> : ''}</td>
            <td className="px-3 py-3"><StatusBadge status={a.status === 'Closed' ? 'Closed' : a.status === 'Planned' ? 'Draft' : 'Pending'} label={lbl(a.status)} /></td></tr>)}</tbody></table>)}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Plan an audit" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!f.title || !f.scope || !f.auditor} onClick={save}>Plan</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Type" htmlFor="au-type"><Select id="au-type" value={f.auditType} onChange={(e) => setF({ ...f, auditType: e.target.value })}>{['INTERNAL', 'SUPPLIER', 'CUSTOMER', 'REGULATORY'].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select></Field>
          <Field label="Date" htmlFor="au-date" required><Input id="au-date" type="date" value={f.plannedDate} onChange={(e) => setF({ ...f, plannedDate: e.target.value })} /></Field>
          {f.auditType === 'SUPPLIER' && <div className="md:col-span-2"><Field label="Supplier" htmlFor="au-party" required><Select id="au-party" value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}><option value="">Select…</option>{(vendors.data?.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.legalName}</option>)}</Select></Field></div>}
          <div className="md:col-span-2"><Field label="Title" htmlFor="au-title" required><Input id="au-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
          <div className="md:col-span-2"><Field label="Scope" htmlFor="au-scope" required><Textarea id="au-scope" rows={2} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /></Field></div>
          <Field label="Auditor" htmlFor="au-by" required><Input id="au-by" value={f.auditor} onChange={(e) => setF({ ...f, auditor: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}
export function AuditDetailPage() {
  const { id } = useParams();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['qa-audit', id], queryFn: () => api<Audit & { canManage: boolean; findingList: { id: string; seq: number; classification: string; clause: string | null; description: string; capaId: string | null; capaNo: string | null }[] }>(`/qa/audits/${id}`) });
  const capas = useQuery({ queryKey: ['qa-capas', 'Open'], queryFn: () => api<{ data: { id: string; docNo: string; title: string }[] }>('/qa/capas?status=Open') });
  const [dlg, setDlg] = useState<null | 'finding' | 'close' | { fid: string }>(null);
  const [f, setF] = useState({ classification: 'MINOR', clause: '', description: '', summary: '', capaId: '' });
  const [error, setError] = useState<unknown>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const a = q.data;
  if (!a) return <ErrorBanner error={q.error} />;
  const run = async (fn: () => Promise<unknown>, msg: string) => { setError(null); try { await fn(); toast('success', msg); setDlg(null); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  return (
    <>
      <PageHeader title={a.docNo} crumbs={<Link to="/qa/audits" className="hover:text-primary">Audits</Link>} subtitle={`${lbl(a.auditType)} audit · ${a.title}${a.partyName ? ` · ${a.partyName}` : ''}`}
        actions={a.canManage && <><Button variant="secondary" onClick={() => setDlg('finding')}>Add finding</Button><Button onClick={() => setDlg('close')}>Close audit</Button></>} />
      <Card title="Findings" padded={false}>{!a.findingList.length ? <div className="p-5"><EmptyState title="No findings recorded" text="Record observations and non-conformities as the audit proceeds." /></div> : (
        <table className="w-full text-[14px]"><thead><tr className={th}><th className="px-5 py-3">#</th><th className="px-3 py-3">Class</th><th className="px-3 py-3">Clause</th><th className="px-3 py-3">Finding</th><th className="px-3 py-3">CAPA</th></tr></thead>
          <tbody>{a.findingList.map((x) => <tr key={x.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{x.seq}</td><td className="px-3 py-3">{lbl(x.classification)}</td><td className="px-3 py-3">{x.clause ?? '—'}</td><td className="px-3 py-3">{x.description}</td>
            <td className="px-3 py-3">{x.capaId ? <Link className="text-primary" to={`/qa/capas/${x.capaId}`}>{x.capaNo}</Link> : a.canManage && ['MAJOR', 'CRITICAL'].includes(x.classification) ? <Button size="sm" variant="secondary" onClick={() => setDlg({ fid: x.id })}>Link CAPA</Button> : '—'}</td></tr>)}</tbody></table>)}
      </Card>
      <Card className="mt-6" title="Audit"><KeyValues items={[['Scope', a.scope], ['Auditor', a.auditor], ['Date', fmtDate(a.plannedDate)], ['Summary', a.summary ?? '—'], ['Closed', a.closedBy ? `${a.closedBy}, ${fmtDateTime(a.closedAt)}` : '—']]} /></Card>
      <Modal open={dlg === 'finding'} onClose={() => setDlg(null)} title="Add a finding" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button disabled={!f.description.trim()} onClick={() => run(() => api(`/qa/audits/${id}/findings`, { body: { classification: f.classification, clause: f.clause || null, description: f.description } }), 'Finding added.')}>Add</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2"><Field label="Classification" htmlFor="af-class"><Select id="af-class" value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })}>{['OBSERVATION', 'MINOR', 'MAJOR', 'CRITICAL'].map((x) => <option key={x} value={x}>{lbl(x)}</option>)}</Select></Field>
          <Field label="Clause" htmlFor="af-clause"><Input id="af-clause" value={f.clause} onChange={(e) => setF({ ...f, clause: e.target.value })} /></Field>
          <div className="md:col-span-2"><Field label="Finding" htmlFor="af-desc" required><Textarea id="af-desc" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div></div>
      </Modal>
      <Modal open={!!dlg && typeof dlg === 'object'} onClose={() => setDlg(null)} title="Link a CAPA" footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button disabled={!f.capaId} onClick={() => run(() => api(`/qa/audits/${id}/findings/${(dlg as { fid: string }).fid}/capa`, { body: { capaId: f.capaId } }), 'CAPA linked.')}>Link</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Open CAPA" htmlFor="af-capa" hint="Raise a new one under CAPA if none fits"><Select id="af-capa" value={f.capaId} onChange={(e) => setF({ ...f, capaId: e.target.value })}><option value="">Select…</option>{(capas.data?.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.docNo} — {c.title}</option>)}</Select></Field>
      </Modal>
      <Modal open={dlg === 'close'} onClose={() => setDlg(null)} title={`Close ${a.docNo}`} footer={<><Button variant="secondary" onClick={() => setDlg(null)}>Cancel</Button><Button disabled={!f.summary.trim()} onClick={() => run(() => api(`/qa/audits/${id}/close`, { body: { summary: f.summary } }), 'Audit closed.')}>Close</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Summary" htmlFor="au-sum" required><Textarea id="au-sum" rows={3} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
      </Modal>
    </>
  );
}

// ================================================================ risk register (QA-012)
interface Risk { id: string; docNo: string; title: string; processArea: string; failureMode: string; effect: string; severity: number; occurrence: number; detection: number; rpn: number; controls: string | null; ownerId: string; owner: string; reviewDate: string; status: string }
export function RisksPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const people = usePeople();
  const q = useQuery({ queryKey: ['qa-risks'], queryFn: () => api<{ data: Risk[] }>('/qa/risks') });
  const blank = { title: '', processArea: '', failureMode: '', effect: '', severity: '5', occurrence: '5', detection: '5', controls: '', ownerId: '', reviewDate: plusDays(90), status: 'Open' };
  const [edit, setEdit] = useState<null | { id?: string; f: typeof blank }>(null);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    const body = { ...edit!.f, severity: Number(edit!.f.severity), occurrence: Number(edit!.f.occurrence), detection: Number(edit!.f.detection), controls: edit!.f.controls || null };
    try { if (edit!.id) await api(`/qa/risks/${edit!.id}`, { method: 'PUT', body }); else await api('/qa/risks', { body }); toast('success', 'Risk saved.'); setEdit(null); await qc.invalidateQueries({ queryKey: ['qa-risks'] }); } catch (e) { setError(e); }
  };
  const rpnBadge = (n: number) => <StatusBadge status={n >= 200 ? 'Rejected' : n >= 100 ? 'Pending' : 'Active'} label={`RPN ${n}`} />;
  const f = edit?.f;
  const set = (k: keyof typeof blank, v: string) => setEdit((e) => (e ? { ...e, f: { ...e.f, [k]: v } } : e));
  return (
    <>
      <PageHeader title="Quality Risks" subtitle="FMEA-style register: severity × occurrence × detection gives the risk priority number; 100 and above needs action." actions={can('qa.risk:manage') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setEdit({ f: blank })}>Add risk</Button>} />
      <Card padded={false}>{!q.data?.data.length ? <div className="p-5"><EmptyState title="No risks registered" text="Assess the failure modes of each process step and how they are controlled." /></div> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={th}><th className="px-5 py-3">Risk</th><th className="px-3 py-3">Process</th><th className="px-3 py-3">Failure mode → effect</th><th className="px-3 py-3 text-right">S · O · D</th><th className="px-3 py-3">RPN</th><th className="px-3 py-3">Owner / review</th><th className="px-3 py-3">Status</th></tr></thead>
          <tbody>{q.data.data.map((r) => <tr key={r.id} className={`border-b border-line last:border-0 ${can('qa.risk:manage') ? 'cursor-pointer hover:bg-surface-2' : ''}`} onClick={() => can('qa.risk:manage') && setEdit({ id: r.id, f: { title: r.title, processArea: r.processArea, failureMode: r.failureMode, effect: r.effect, severity: String(r.severity), occurrence: String(r.occurrence), detection: String(r.detection), controls: r.controls ?? '', ownerId: r.ownerId, reviewDate: r.reviewDate, status: r.status } })}>
            <td className="px-5 py-3"><span className="font-semibold">{r.docNo}</span><span className="block text-[13px] text-ink-2">{r.title}</span></td><td className="px-3 py-3">{r.processArea}</td><td className="px-3 py-3">{r.failureMode} → {r.effect}</td>
            <td className="px-3 py-3 text-right num">{r.severity} · {r.occurrence} · {r.detection}</td><td className="px-3 py-3">{rpnBadge(r.rpn)}</td><td className="px-3 py-3">{r.owner}<span className="block text-[12px] text-ink-2">{fmtDate(r.reviewDate)}</span></td><td className="px-3 py-3">{r.status}</td></tr>)}</tbody></table></div>)}
      </Card>
      {f && <Modal open onClose={() => setEdit(null)} title={edit?.id ? 'Update risk' : 'Add a risk'} width={760} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button disabled={!f.title || !f.processArea || !f.failureMode || !f.effect || !f.ownerId} onClick={save}>Save</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2"><Field label="Title" htmlFor="rk-title" required><Input id="rk-title" value={f.title} onChange={(e) => set('title', e.target.value)} /></Field></div>
          <Field label="Process area" htmlFor="rk-area" required><Input id="rk-area" value={f.processArea} onChange={(e) => set('processArea', e.target.value)} /></Field>
          <Field label="Owner" htmlFor="rk-owner" required><Select id="rk-owner" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}><option value="">Select…</option>{(people.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
          <Field label="Failure mode" htmlFor="rk-fm" required><Input id="rk-fm" value={f.failureMode} onChange={(e) => set('failureMode', e.target.value)} /></Field>
          <Field label="Effect" htmlFor="rk-eff" required><Input id="rk-eff" value={f.effect} onChange={(e) => set('effect', e.target.value)} /></Field>
          <div className="grid grid-cols-3 gap-3 md:col-span-2">{(['severity', 'occurrence', 'detection'] as const).map((k) => (
            <Field key={k} label={`${lbl(k)} (1–10)`} htmlFor={`rk-${k}`}><Input id={`rk-${k}`} type="number" min="1" max="10" value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>))}</div>
          <p className="md:col-span-2">Risk priority number: <span className="font-semibold num">{Number(f.severity) * Number(f.occurrence) * Number(f.detection)}</span></p>
          <div className="md:col-span-2"><Field label="Current controls" htmlFor="rk-ctrl"><Textarea id="rk-ctrl" rows={2} value={f.controls} onChange={(e) => set('controls', e.target.value)} /></Field></div>
          <Field label="Review by" htmlFor="rk-rev" required><Input id="rk-rev" type="date" value={f.reviewDate} onChange={(e) => set('reviewDate', e.target.value)} /></Field>
          <Field label="Status" htmlFor="rk-st"><Select id="rk-st" value={f.status} onChange={(e) => set('status', e.target.value)}><option>Open</option><option>Mitigated</option><option>Accepted</option></Select></Field>
        </div>
      </Modal>}
    </>
  );
}

// ================================================================ line clearance (QA-017)
const CHECKS: [string, string][] = [['previousMaterialRemoved', 'Previous product and material removed'], ['lineCleaned', 'Line and equipment cleaned'], ['labelsReconciled', 'Labels and packing material reconciled'],
  ['documentsInPlace', 'Current SOP and batch documents in place'], ['equipmentReady', 'Equipment set and calibrated']];
export function LineClearancePage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['line-clearances'], queryFn: () => api<{ data: { id: string; lineCode: string; lineName: string; purpose: string; checklist: Record<string, boolean>; outcome: string; remarks: string | null; clearedBy: string; clearedAt: string; usedByBatch: string | null; usedByPacking: string | null }[] }>('/qa/line-clearances') });
  const plants = useQuery({ queryKey: ['production-plants'], queryFn: () => api<{ data: { code: string; lines: { id: string; code: string; name: string; status: string }[] }[] }>('/production/plants').catch(() => ({ data: [] })) });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ lineId: '', purpose: 'BATCH', remarks: '', checklist: Object.fromEntries(CHECKS.map(([k]) => [k, false])) as Record<string, boolean> });
  const [error, setError] = useState<unknown>(null);
  const all = Object.values(f.checklist).every(Boolean);
  const save = async () => { setError(null); try { const r = await api<{ outcome: string }>('/qa/line-clearances', { body: { lineId: f.lineId, purpose: f.purpose, checklist: f.checklist, remarks: f.remarks || null } }); toast(r.outcome === 'Cleared' ? 'success' : 'error', r.outcome === 'Cleared' ? 'Line cleared.' : 'Recorded as not cleared.'); setOpen(false); await qc.invalidateQueries({ queryKey: ['line-clearances'] }); } catch (e) { setError(e); } };
  return (
    <>
      <PageHeader title="Line Clearance" subtitle="QA clears a line before each batch or packing run (BRD p.4): previous material out, line clean, labels reconciled. A batch cannot start on a line without a clearance recorded since it was last used."
        actions={can('qa.clearance:record') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Record clearance</Button>} />
      <Card padded={false}>{!q.data?.data.length ? <div className="p-5"><EmptyState title="No clearances yet" text="Record the checklist before production starts on a line." /></div> : (
        <table className="w-full text-[14px]"><thead><tr className={th}><th className="px-5 py-3">Line</th><th className="px-3 py-3">For</th><th className="px-3 py-3">Outcome</th><th className="px-3 py-3">By</th><th className="px-3 py-3">Used by</th></tr></thead>
          <tbody>{q.data.data.map((c) => <tr key={c.id} className="border-b border-line last:border-0"><td className="px-5 py-3 font-semibold">{c.lineCode} <span className="font-normal text-ink-2">{c.lineName}</span></td><td className="px-3 py-3">{lbl(c.purpose)}</td>
            <td className="px-3 py-3"><StatusBadge status={c.outcome === 'Cleared' ? 'Approved' : 'Rejected'} label={c.outcome === 'Cleared' ? 'Cleared' : 'Not cleared'} />{c.remarks && <span className="block text-[12px] text-ink-2">{c.remarks}</span>}</td>
            <td className="px-3 py-3">{c.clearedBy}<span className="block text-[12px] text-ink-2">{fmtDateTime(c.clearedAt)}</span></td><td className="px-3 py-3">{c.usedByBatch ?? c.usedByPacking ?? (c.outcome === 'Cleared' ? 'Available' : '—')}</td></tr>)}</tbody></table>)}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Line clearance" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button variant={all ? 'primary' : 'danger'} disabled={!f.lineId || (!all && !f.remarks.trim())} onClick={save}>{all ? 'Clear the line' : 'Record not cleared'}</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Line" htmlFor="lc-line" required><Select id="lc-line" value={f.lineId} onChange={(e) => setF({ ...f, lineId: e.target.value })}><option value="">Select…</option>
            {(plants.data?.data ?? []).flatMap((p) => p.lines.map((l) => ({ ...l, plant: p.code }))).filter((l) => l.status === 'Active').map((l) => <option key={l.id} value={l.id}>{l.plant} · {l.code} — {l.name}</option>)}</Select></Field>
          <Field label="For" htmlFor="lc-for"><Select id="lc-for" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}><option value="BATCH">A batch</option><option value="PACKING">Packing</option></Select></Field>
        </div>
        <ul className="mt-4 space-y-2">{CHECKS.map(([k, l]) => <li key={k}><label className="flex items-center gap-3 text-[14px]"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={f.checklist[k]} onChange={(e) => setF({ ...f, checklist: { ...f.checklist, [k]: e.target.checked } })} />{l}</label></li>)}</ul>
        {!all && <div className="mt-4"><Field label="What is not ready" htmlFor="lc-rem" required><Textarea id="lc-rem" rows={2} value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field></div>}
      </Modal>
    </>
  );
}

// ================================================================ quality dashboard (QC-002, QA-002)
export function QualityDashboardPage() {
  const q = useQuery({ queryKey: ['quality-dashboard'], queryFn: () => api<{ qc: Record<string, number | string | null>; qa: Record<string, number> }>('/qa/dashboard') });
  if (q.isLoading || !q.data) return <Skeleton className="h-96" />;
  const { qc, qa } = q.data;
  const tile = (label: string, value: number | string | null | undefined, to: string, bad = false, note?: string) => (
    <Link to={to} className="card block p-5 transition hover:-translate-y-0.5"><p className="text-[13px] font-semibold text-ink-2">{label}</p>
      <p className={`mt-2 text-[30px] font-semibold leading-none num ${bad && Number(value) > 0 ? 'text-danger-text' : ''}`}>{value === null || value === undefined ? '—' : value}</p>{note && <p className="mt-2 text-[13px] text-ink-2">{note}</p>}</Link>);
  return (
    <>
      <PageHeader title="Quality Dashboard" subtitle="What needs QC and QA attention now." />
      <h2 className="mb-3 text-[16px] font-semibold">Quality control</h2>
      <div className="mb-8 grid gap-4 md:grid-cols-3 xl:grid-cols-4">
        {tile('Lots waiting for QC', qc.openInspections, '/qc/inspections', false, `${qc.olderThan2Days} older than 2 days`)}{tile('In-process tests waiting', qc.ipqcPending, '/qc/ipqc')}
        {tile('Open OOS investigations', qc.openOos, '/qc/oos', true)}{tile('Instruments overdue', qc.instrumentsOverdue, '/qc/master?tab=instruments', true, `${qc.instrumentsDueSoon} due within 15 days`)}
        {tile('Right first time (90 days)', qc.firstTimeRightPct === null ? null : `${qc.firstTimeRightPct}%`, '/qc/inspections', false, 'Lots decided without an OOS')}{tile('Average turnaround', qc.avgTurnaroundHours === null ? null : `${qc.avgTurnaroundHours} h`, '/qc/inspections', false, 'Receipt to decision, 90 days')}
      </div>
      <h2 className="mb-3 text-[16px] font-semibold">Quality assurance</h2>
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-4">
        {tile('Batches awaiting release', qa.awaitingRelease, '/qa/releases')}{tile('Open deviations', qa.openDeviations, '/qa/deviations', true)}
        {tile('Open CAPA', qa.openCapa, '/qa/capas', false, `${qa.overdueCapa} overdue`)}{tile('Open complaints', qa.openComplaints, '/qa/complaints', true)}
        {tile('Open non-conformances', qa.openNc, '/qa/ncs', true)}{tile('Changes in progress', qa.changesInFlight, '/qa/changes')}
        {tile('Document reviews due (30 days)', qa.reviewsDue, '/qa/documents', true)}{tile('Training gaps', qa.trainingGaps, '/qa/documents', true)}
        {tile('High risks (RPN ≥ 100)', qa.highRisks, '/qa/risks', true)}{tile('Recalls this year', qa.recallsThisYear, '/qa/recalls')}
      </div>
    </>
  );
}
