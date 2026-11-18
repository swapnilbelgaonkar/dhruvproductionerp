import { policyDefinitionSchema } from '@dhruv/contracts';
import { CheckCircle, DownloadSimple, ShieldCheck, Warning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, qs, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtINR, humanize } from '../../lib/format';
import { ChangePasswordForm } from '../auth/Gate';

// ---------------------------------------------------------------- Approval policies
interface Policy { id: string; doc_type: string; name: string; description: string; published_version: number; published_at: string; definition: unknown; drafts: number }
interface Version { id: string; version: number; status: string; definition: unknown; created_at: string; created_by: string | null; published_at: string | null; published_by: string | null }
interface SimResult { ruleName: string; version: number; steps: { label: string; kind: string; approvers: { userId: string; name: string; tier?: string }[] }[]; warnings: string[] }

export function PoliciesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['policies'], queryFn: () => api<{ data: Policy[] }>('/approval-policies') });
  const [sel, setSel] = useState<string | null>(null);
  const policy = q.data?.data.find((p) => p.doc_type === sel) ?? q.data?.data[0];
  const versions = useQuery({ queryKey: ['policy-versions', policy?.doc_type], queryFn: () => api<{ data: Version[] }>(`/approval-policies/${policy!.doc_type}/versions`), enabled: !!policy });
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftErr, setDraftErr] = useState<string | null>(null);
  const saveDraft = useMutation({ mutationFn: (definition: unknown) => api(`/approval-policies/${policy!.doc_type}/versions`, { body: { definition } }),
    onSuccess: async () => { toast('success', 'Draft saved. Another administrator must publish it.'); setDraftOpen(false); await qc.invalidateQueries(); } });
  const publish = useMutation({ mutationFn: (v: number) => api(`/approval-policies/${policy!.doc_type}/versions/${v}/publish`, { method: 'POST' }),
    onSuccess: async () => { toast('success', 'Published.'); await qc.invalidateQueries(); } });

  return (
    <>
      <PageHeader title="Approval Policies" subtitle="Who approves what. Each version is immutable once published, and every decision records the version it used." />
      <ErrorBanner error={q.error} />
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <Card title="Document types" padded={false} className="p-0">
          <ul className="divide-y divide-line">{q.data?.data.map((p) => (
            <li key={p.id}><button onClick={() => setSel(p.doc_type)} className={`w-full px-6 py-3 text-left hover:bg-[#FAF9FF] ${policy?.doc_type === p.doc_type ? 'bg-primary-tint' : ''}`}>
              <span className="block font-medium">{p.name}</span><span className="text-[12px] text-ink-2">{p.doc_type} · v{p.published_version}{Number(p.drafts) ? ` · ${p.drafts} draft` : ''}</span></button></li>))}</ul>
        </Card>
        {policy && (
          <div className="space-y-6">
            <Card title={policy.name} actions={can('wf.policy:configure') && <Button size="sm" variant="secondary" onClick={() => { setDraft(JSON.stringify(policy.definition, null, 2)); setDraftErr(null); setDraftOpen(true); }}>New draft version</Button>}>
              <p className="mb-4 text-ink-2">{policy.description}</p>
              <PolicySteps definition={policy.definition} />
            </Card>
            {policy.doc_type === 'sales.order' && can('wf.policy:simulate') && <Simulator docType={policy.doc_type} />}
            <Card title="Versions">
              <ErrorBanner error={publish.error} />
              <ul className="divide-y divide-line">{versions.data?.data.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center gap-3 py-3">
                  <span className="w-12 font-semibold">v{v.version}</span><StatusBadge status={v.status} />
                  <span className="flex-1 text-[13px] text-ink-2">{v.created_by ? `drafted by ${v.created_by}` : 'system default'}{v.published_by ? ` · published by ${v.published_by} ${fmtDateTime(v.published_at)}` : ''}</span>
                  {v.status === 'Draft' && can('wf.policy:configure') && <Button size="sm" loading={publish.isPending} onClick={() => publish.mutate(v.version)}>Publish</Button>}
                </li>))}</ul>
            </Card>
          </div>
        )}
      </div>
      <Modal open={draftOpen} onClose={() => setDraftOpen(false)} title="New draft version" width={720} description="Edit the rule definition (JSON). It is validated before saving."
        footer={<><Button variant="secondary" onClick={() => setDraftOpen(false)}>Cancel</Button><Button loading={saveDraft.isPending} onClick={() => {
          try { const parsed = policyDefinitionSchema.safeParse(JSON.parse(draft)); if (!parsed.success) { setDraftErr(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')); return; } setDraftErr(null); saveDraft.mutate(parsed.data); }
          catch { setDraftErr('Not valid JSON.'); }
        }}>Save draft</Button></>}>
        <ErrorBanner error={saveDraft.error ?? (draftErr ? { message: draftErr } : null)} />
        <Textarea aria-label="Policy definition JSON" value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-[340px] font-mono text-[13px]" spellCheck={false} />
      </Modal>
    </>
  );
}

function PolicySteps({ definition }: { definition: unknown }) {
  const d = policyDefinitionSchema.safeParse(definition);
  if (!d.success) return <p className="text-danger-text">Definition is invalid.</p>;
  return (
    <div className="space-y-4">
      {d.data.rules.map((r, i) => (
        <div key={i}>
          <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-2">Rule: {r.name}{r.when ? ' (conditional)' : ''}</p>
          <ol className="mt-2 space-y-2">{r.steps.map((s, j) => (
            <li key={j} className="flex gap-3 rounded-md bg-canvas px-4 py-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-[12px] font-bold text-white">{j + 1}</span>
              <span><span className="font-medium">{s.label}</span><span className="block text-[13px] text-ink-2">{s.kind === 'role' ? `Any of: ${s.roles.join(', ')}` : s.kind === 'reporting_manager' ? 'Initiator’s reporting manager' : `Lowest tier in the initiator’s chain whose limits cover "${s.amountFact}" and "${s.discountFact}"${s.notifySkipped ? '; skipped managers notified (D01 hybrid)' : ''}`}</span></span></li>))}</ol>
        </div>
      ))}
      <p className="text-[13px] text-ink-2">{d.data.distinctApprovers ? 'The same person cannot approve two steps of one request.' : 'The same person may approve more than one step.'}</p>
    </div>
  );
}

function Simulator({ docType }: { docType: string }) {
  const users = useQuery({ queryKey: ['users-sim'], queryFn: () => api<Page<{ id: string; fullName: string; email: string }>>('/users?limit=100&status=Active') });
  const [initiator, setInitiator] = useState('');
  const [amount, setAmount] = useState('120000');
  const [disc, setDisc] = useState('6');
  const sim = useMutation({ mutationFn: () => api<SimResult>('/approval-policies/simulate', { body: { docType, initiatorUserId: initiator, facts: { amount: Number(amount), maxDiscountPct: Number(disc) } } }) });
  return (
    <Card title="Simulate a sales order route">
      <div className="grid gap-4 md:grid-cols-[1fr_180px_140px_auto] md:items-end">
        <Field label="Initiator" htmlFor="simu"><Select id="simu" value={initiator} onChange={(e) => setInitiator(e.target.value)}><option value="">Select user…</option>{users.data?.data.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></Field>
        <Field label="Order value (₹)" htmlFor="sima"><Input id="sima" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Max discount %" htmlFor="simd"><Input id="simd" inputMode="decimal" value={disc} onChange={(e) => setDisc(e.target.value)} /></Field>
        <Button disabled={!initiator} loading={sim.isPending} onClick={() => sim.mutate()}>Simulate</Button>
      </div>
      <ErrorBanner error={sim.error} />
      {sim.data && (
        <div className="mt-5 space-y-3">
          <p className="text-[14px] text-ink-2">Order of {fmtINR(amount)} at {disc}% — rule "{sim.data.ruleName}" (v{sim.data.version})</p>
          <ol className="space-y-2">{sim.data.steps.map((s, i) => (
            <li key={i} className="rounded-md bg-canvas px-4 py-3"><span className="font-medium">{s.label}</span>{s.kind === 'notify' && <span className="ml-2 text-[12px] font-semibold text-primary">notify only</span>}
              <span className="block text-[13px] text-ink-2">{s.approvers.map((a) => a.name + (a.tier ? ` (${a.tier})` : '')).join(', ') || 'No eligible person'}</span></li>))}</ol>
          {sim.data.warnings.map((w, i) => <p key={i} className="flex items-start gap-2 text-[14px] text-warning-text"><Warning size={18} className="mt-0.5 shrink-0" />{w}</p>)}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Authority limits
interface Limit { tier: string; rank: number; title: string; maxDiscountPct: string | null; maxOrderValue: string | null; canApprove: boolean; active: boolean; updatedAt: string; updatedBy: string | null; version: number }
export function AuthorityLimitsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['limits'], queryFn: () => api<{ data: Limit[] }>('/admin/authority-limits') });
  const [edit, setEdit] = useState<Limit | null>(null);
  const [vals, setVals] = useState({ d: '', v: '' });
  const [activate, setActivate] = useState(false);
  const active = q.data?.data.every((l) => l.active);
  return (
    <>
      <PageHeader title="Sales Authority Limits" subtitle="Nine-tier discount and order-value ceilings (BRD p.3–4). Used by the hybrid approval route (D01)."
        actions={can('iam.authority_limit:configure') && !active && <Button onClick={() => setActivate(true)}>Activate limits</Button>} />
      <ErrorBanner error={q.error} />
      {q.data && !active && <div className="mb-6 flex items-start gap-2 rounded-md bg-warning-bg px-4 py-3 text-warning-text"><Warning size={20} className="shrink-0" /><span>Seeded from the BRD but <b>not active</b>: business approval of the values is pending (D15). Sales orders cannot be submitted until an executive activates them.</span></div>}
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className="px-5 py-3 font-medium">Tier</th><th className="px-5 py-3 font-medium">Role</th><th className="px-5 py-3 text-right font-medium">Max discount</th><th className="px-5 py-3 text-right font-medium">Max order value</th><th className="px-5 py-3 font-medium">Last changed</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>{q.isLoading ? <tr><td colSpan={6}><Skeleton className="m-5 h-40" /></td></tr> : q.data?.data.map((l) => (
            <tr key={l.tier} className="h-14 border-t border-line">
              <td className="px-5"><span className="font-semibold">{l.rank}. {l.tier}</span></td><td className="px-5">{l.title}</td>
              <td className="px-5 text-right num">{!l.canApprove ? 'Catalogue price' : l.maxDiscountPct === null ? 'Exceptional' : `${Number(l.maxDiscountPct)}%`}</td>
              <td className="px-5 text-right num">{!l.canApprove ? 'Initiator only' : l.maxOrderValue === null ? 'Exceptional' : fmtINR(l.maxOrderValue)}</td>
              <td className="px-5 text-[13px] text-ink-2">{l.updatedBy ? `${l.updatedBy}, ${fmtDateTime(l.updatedAt)}` : 'BRD seed'}</td>
              <td className="px-5 text-right">{can('iam.authority_limit:configure') && l.canApprove && <Button size="sm" variant="ghost" onClick={() => { setEdit(l); setVals({ d: l.maxDiscountPct ?? '', v: l.maxOrderValue ?? '' }); }}>Edit</Button>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      <ReasonDialog open={!!edit} title={`Change ${edit?.tier ?? ''} limits`} confirmLabel="Save" onClose={() => setEdit(null)}
        description="Leave a field empty for “Exceptional” (no ceiling)."
        onConfirm={async (reason) => { await api(`/admin/authority-limits/${edit!.tier}`, { method: 'PUT', body: { maxDiscountPct: vals.d === '' ? null : Number(vals.d), maxOrderValue: vals.v === '' ? null : Number(vals.v), version: edit!.version, reason } }); toast('success', 'Saved.'); await qc.invalidateQueries({ queryKey: ['limits'] }); }}>
        <Field label="Max discount %" htmlFor="ld"><Input id="ld" inputMode="decimal" value={vals.d} onChange={(e) => setVals({ ...vals, d: e.target.value })} /></Field>
        <Field label="Max order value (₹)" htmlFor="lv"><Input id="lv" inputMode="decimal" value={vals.v} onChange={(e) => setVals({ ...vals, v: e.target.value })} /></Field>
      </ReasonDialog>
      <ReasonDialog open={activate} title="Activate authority limits" confirmLabel="Activate" onClose={() => setActivate(false)}
        description="Confirms business approval of these values (D15). Someone who edited the limits cannot activate them."
        onConfirm={async (reason) => { await api('/admin/authority-limits/activate', { body: { reason } }); toast('success', 'Limits activated.'); await qc.invalidateQueries({ queryKey: ['limits'] }); }} />
    </>
  );
}

// ---------------------------------------------------------------- Number series & settings
export function NumberSeriesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['number-series'], queryFn: () => api<{ fy: string; data: { docType: string; prefix: string; padding: number; description: string; issuedThisYear: number }[] }>('/admin/number-series') });
  const [edit, setEdit] = useState<{ docType: string; prefix: string; padding: number } | null>(null);
  return (
    <>
      <PageHeader title="Number Series" subtitle={`Document numbers restart every financial year (April–March). Current FY: ${q.data?.fy ?? ''}. Format: PREFIX/FY/000001 (D28).`} />
      <ErrorBanner error={q.error} />
      <div className="card overflow-x-auto"><table className="w-full min-w-[640px] text-left">
        <thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className="px-5 py-3 font-medium">Document</th><th className="px-5 py-3 font-medium">Next number looks like</th><th className="px-5 py-3 text-right font-medium">Issued this FY</th><th className="px-5 py-3" /></tr></thead>
        <tbody>{q.data?.data.map((s) => (
          <tr key={s.docType} className="h-14 border-t border-line"><td className="px-5"><span className="font-medium">{s.description}</span><span className="block text-[12px] text-ink-2">{s.docType}</span></td>
            <td className="px-5 num">{s.prefix}/{q.data!.fy}/{String(Number(s.issuedThisYear) + 1).padStart(s.padding, '0')}</td><td className="px-5 text-right num">{s.issuedThisYear}</td>
            <td className="px-5 text-right">{can('sys.number_series:configure') && <Button size="sm" variant="ghost" onClick={() => setEdit({ docType: s.docType, prefix: s.prefix, padding: s.padding })}>Edit</Button>}</td></tr>))}</tbody></table></div>
      <ReasonDialog open={!!edit} title={`Edit ${edit?.docType ?? ''}`} confirmLabel="Save" onClose={() => setEdit(null)}
        onConfirm={async (reason) => { await api(`/admin/number-series/${edit!.docType}`, { method: 'PUT', body: { prefix: edit!.prefix, padding: edit!.padding, reason } }); toast('success', 'Saved.'); await qc.invalidateQueries({ queryKey: ['number-series'] }); }}>
        {edit && <>
          <Field label="Prefix" htmlFor="nsp"><Input id="nsp" className="uppercase" value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value.toUpperCase() })} /></Field>
          <Field label="Digits" htmlFor="nsd"><Input id="nsd" type="number" min={3} max={10} value={edit.padding} onChange={(e) => setEdit({ ...edit, padding: Number(e.target.value) })} /></Field>
        </>}
      </ReasonDialog>
    </>
  );
}

export function SettingsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api<{ data: { key: string; value: number | string | boolean; description: string; updatedAt: string; updatedBy: string | null }[] }>('/admin/settings') });
  const [edit, setEdit] = useState<{ key: string; value: string; type: string } | null>(null);
  return (
    <>
      <PageHeader title="Settings" subtitle="Company policies the system enforces. Every change is audited with a reason." />
      <ErrorBanner error={q.error} />
      <div className="card overflow-x-auto"><table className="w-full min-w-[640px] text-left">
        <thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className="px-5 py-3 font-medium">Setting</th><th className="px-5 py-3 font-medium">Value</th><th className="px-5 py-3 font-medium">Last changed</th><th className="px-5 py-3" /></tr></thead>
        <tbody>{q.data?.data.map((s) => (
          <tr key={s.key} className="h-14 border-t border-line"><td className="px-5"><span className="font-medium">{s.description}</span><span className="block text-[12px] text-ink-2">{s.key}</span></td>
            <td className="px-5 font-semibold num">{String(s.value)}</td><td className="px-5 text-[13px] text-ink-2">{s.updatedBy ? `${s.updatedBy}, ${fmtDateTime(s.updatedAt)}` : 'Default'}</td>
            <td className="px-5 text-right">{can('sys.settings:configure') && <Button size="sm" variant="ghost" onClick={() => setEdit({ key: s.key, value: String(s.value), type: typeof s.value })}>Edit</Button>}</td></tr>))}</tbody></table></div>
      <ReasonDialog open={!!edit} title={edit?.key ?? ''} confirmLabel="Save" onClose={() => setEdit(null)}
        onConfirm={async (reason) => { await api(`/admin/settings/${edit!.key}`, { method: 'PUT', body: { value: edit!.type === 'number' ? Number(edit!.value) : edit!.value, reason } }); toast('success', 'Saved.'); await qc.invalidateQueries({ queryKey: ['settings'] }); }}>
        {edit && <Field label="New value" htmlFor="sv"><Input id="sv" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>}
      </ReasonDialog>
    </>
  );
}

// ---------------------------------------------------------------- Audit log
interface AuditRow { seq: number; occurredAt: string; actor: string; action: string; entityType: string; entityId: string | null; before: unknown; after: unknown; reason: string | null; ip: string | null }
export function AuditPage() {
  const { can } = useAuth();
  const [filters, setFilters] = useState({ action: '', entityType: '', from: '', to: '' });
  const [open, setOpen] = useState<AuditRow | null>(null);
  const verify = useMutation({ mutationFn: () => api<{ checked: number; intact: boolean; firstBrokenSeq: number | null }>('/audit/verify', { method: 'POST' }) });
  return (
    <>
      <PageHeader title="Audit Log" subtitle="Append-only, hash-chained record of every action (SEC-013). Nobody — including administrators — can edit or delete entries."
        actions={<>
          {can('sys.audit:verify') && <Button variant="secondary" icon={<ShieldCheck size={18} />} loading={verify.isPending} onClick={() => verify.mutate()}>Verify integrity</Button>}
          {can('sys.audit:export') && <a href={`/api/v1/audit/export.csv${qs(filters)}`} className="inline-flex h-12 items-center gap-2 rounded-md bg-primary px-5 font-semibold text-white hover:bg-primary-hover"><DownloadSimple size={18} />Export CSV</a>}
        </>} />
      {verify.data && <div className={`mb-5 flex items-center gap-2 rounded-md px-4 py-3 ${verify.data.intact ? 'bg-success-bg text-success-text' : 'bg-danger-bg text-danger-text'}`}>{verify.data.intact ? <CheckCircle size={20} weight="fill" /> : <Warning size={20} weight="fill" />}
        {verify.data.intact ? `Chain intact — ${verify.data.checked} entries verified.` : `Chain broken at entry ${verify.data.firstBrokenSeq}. Escalate to the Security Administrator.`}</div>}
      <ErrorBanner error={verify.error} />
      <div className="card mb-4 grid gap-3 p-4 md:grid-cols-4">
        <Input aria-label="Action contains" placeholder="Action contains…" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />
        <Input aria-label="Entity type" placeholder="Entity type, e.g. org.plant" value={filters.entityType} onChange={(e) => setFilters({ ...filters, entityType: e.target.value })} />
        <Input aria-label="From date" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <Input aria-label="To date" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
      </div>
      <DataTable<AuditRow & { id?: string }> queryKey="audit" path="/audit" filters={filters} searchable={false}
        empty={{ title: 'No entries', text: 'Try widening the filters.' }}
        columns={[
          { key: 'seq', header: '#', render: (r) => <span className="num text-ink-2">{r.seq}</span> },
          { key: 'time', header: 'When', render: (r) => fmtDateTime(r.occurredAt) },
          { key: 'actor', header: 'Actor', render: (r) => r.actor },
          { key: 'action', header: 'Action', render: (r) => <span className="font-medium">{r.action}</span> },
          { key: 'entity', header: 'Record', render: (r) => <span className="text-[13px]">{humanize(r.entityType)}</span> },
          { key: 'reason', header: 'Reason', render: (r) => <span className="line-clamp-1 max-w-[220px] text-[13px]">{r.reason ?? '—'}</span> },
          { key: 'view', header: '', render: (r) => (r.before || r.after) ? <Button size="sm" variant="ghost" onClick={() => setOpen(r)}>Changes</Button> : null },
        ]} />
      <Modal open={!!open} onClose={() => setOpen(null)} title={open?.action ?? ''} description={`${open?.actor} · ${fmtDateTime(open?.occurredAt)} · IP ${open?.ip ?? '—'}`} width={760}>
        <div className="grid gap-4 md:grid-cols-2">
          <div><p className="label">Before</p><pre className="max-h-80 overflow-auto rounded-md bg-canvas p-3 text-[12px]">{JSON.stringify(open?.before, null, 2) ?? '—'}</pre></div>
          <div><p className="label">After</p><pre className="max-h-80 overflow-auto rounded-md bg-canvas p-3 text-[12px]">{JSON.stringify(open?.after, null, 2) ?? '—'}</pre></div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- My profile
export function ProfilePage() {
  const { me } = useAuth();
  const toast = useToast();
  if (!me) return null;
  return (
    <>
      <PageHeader title="My profile" subtitle="Your account and sign-in security." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Account"><KeyValues items={[['Name', me.user.fullName], ['Email', me.user.email], ['Two-step verification', me.user.mfaEnabled ? 'Enrolled' : me.mfaRequiredByRole ? 'Required by your role' : 'Not enrolled'], ['Roles', me.roles.map((r) => r.name).join(', ') || '—']]} /></Card>
        <Card title="Change password"><ChangePasswordForm onDone={() => toast('success', 'Password changed. Your other sessions were signed out.')} /></Card>
      </div>
    </>
  );
}
