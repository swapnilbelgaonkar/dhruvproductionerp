import { BellRinging, CheckCircle, Lightning, PencilSimple, Warning } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime, humanize } from '../../lib/format';

const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
interface Alert { id: string; ruleCode: string; ruleName: string; area: string; subjectRef: string | null; severity: 'warning' | 'critical'; title: string; body: string; link: string | null;
  raisedAt: string; lastSeenAt: string; escalatedAt: string | null; acknowledgedAt: string | null; acknowledgedBy: string | null; ackNote: string | null; resolvedAt: string | null; recipients: number }

// ---------------------------------------------------------------- my alerts (NOT-001…NOT-006)
export function AlertsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'resolved' | 'all'>('open');
  const [everyone, setEveryone] = useState(false);
  const [area, setArea] = useState('');
  const q = useQuery({ queryKey: ['alerts', status, everyone, area], queryFn: () => api<{ data: Alert[]; canViewAll: boolean; canConfigure: boolean }>(`/alerts?status=${status}${everyone ? '&scope=all' : ''}${area ? `&area=${area}` : ''}`) });
  const [ack, setAck] = useState<Alert | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const rows = q.data?.data ?? [];
  const confirm = async () => {
    setError(null);
    try { await api(`/alerts/${ack!.id}/acknowledge`, { body: { note: note || null } }); toast('success', 'Acknowledged — it will not escalate.'); setAck(null); setNote(''); await qc.invalidateQueries({ queryKey: ['alerts'] }); }
    catch (e) { setError(e); }
  };
  return (
    <>
      <PageHeader title="Alerts" subtitle="Things that need attention: overdue approvals, calibration, expiring stock, payments, late deliveries and more. An alert clears itself when the condition is fixed; acknowledge it to stop it escalating."
        actions={q.data?.canConfigure && <Link to="/admin/alert-rules"><Button variant="secondary">Alert rules</Button></Link>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs value={status} onChange={setStatus} tabs={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'all', label: 'All' }]} />
        <Select aria-label="Area" className="w-48" value={area} onChange={(e) => setArea(e.target.value)}><option value="">All areas</option>
          {['Workflow', 'QC', 'Quality', 'Inventory', 'Finance', 'Procurement', 'Logistics'].map((a) => <option key={a} value={a}>{a}</option>)}</Select>
        {q.data?.canViewAll && <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />Everyone's alerts</label>}
      </div>
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-60" /> : q.error ? <div className="p-5"><ErrorBanner error={q.error} /></div> : !rows.length ? <div className="p-5"><EmptyState title="Nothing needs you" text="No alerts here." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Alert</th><th className={th}>Area</th><th className={th}>Raised</th><th className={th}>State</th><th className={th} /></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id} className="border-b border-line align-top last:border-0">
                <td className="px-5 py-3"><div className="flex items-start gap-2">
                  {a.severity === 'critical' ? <Warning size={18} weight="fill" className="mt-0.5 shrink-0 text-danger-text" aria-label="Critical" /> : <BellRinging size={18} weight="fill" className="mt-0.5 shrink-0 text-warning-text" aria-label="Warning" />}
                  <div>{a.link ? <Link className="font-semibold text-primary" to={a.link}>{a.title}</Link> : <span className="font-semibold">{a.title}</span>}<div className="text-[13px] text-ink-2">{a.body}</div>
                    <div className="text-[12px] text-ink-2">{a.ruleName}</div></div></div></td>
                <td className={th}>{a.area}</td><td className={th}>{fmtDateTime(a.raisedAt)}</td>
                <td className={th}>{a.resolvedAt ? <span><StatusBadge status="Approved" label="Resolved" /><div className="text-[12px] text-ink-2">{fmtDateTime(a.resolvedAt)}</div></span>
                  : a.acknowledgedAt ? <span><StatusBadge status="Active" label="Acknowledged" /><div className="text-[12px] text-ink-2">{a.acknowledgedBy}{a.ackNote ? ` — ${a.ackNote}` : ''}</div></span>
                    : a.escalatedAt ? <span><StatusBadge status="Rejected" label="Escalated" /><div className="text-[12px] text-ink-2">{fmtDateTime(a.escalatedAt)}</div></span> : <StatusBadge status="Pending" label="Open" />}</td>
                <td className={`${th} text-right`}>{!a.resolvedAt && !a.acknowledgedAt && <Button size="sm" variant="secondary" icon={<CheckCircle size={16} />} onClick={() => setAck(a)}>Acknowledge</Button>}</td>
              </tr>))}</tbody></table></div>
        )}
      </Card>
      <Modal open={!!ack} onClose={() => setAck(null)} title="Acknowledge alert" description={ack?.title}
        footer={<><Button variant="secondary" onClick={() => setAck(null)}>Cancel</Button><Button onClick={confirm}>Acknowledge</Button></>}>
        <ErrorBanner error={error} />
        <Field label="What are you doing about it? (optional)" htmlFor="ack-note"><Textarea id="ack-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <p className="text-[13px] text-ink-2">It stays open until the condition is fixed, but will not escalate.</p>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- alert rules (administration)
interface Rule { code: string; name: string; description: string; area: string; enabled: boolean; params: Record<string, number>; recipientRoles: string[]; escalateAfterHours: number | null;
  escalateRoles: string[]; escalateToManager: boolean; updatedAt: string; openAlerts: number }
const PARAM_LABEL: Record<string, string> = { daysBefore: 'Warn this many days before', hours: 'Alert after this many hours', days: 'Alert after this many days', graceDays: 'Grace days after the due date' };

export function AlertRulesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['alert-rules'], queryFn: () => api<{ data: Rule[]; roles: { code: string; name: string }[] }>('/alerts/rules') });
  const [edit, setEdit] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const roleName = (c: string) => q.data?.roles.find((r) => r.code === c)?.name ?? humanize(c.toLowerCase());
  const run = async () => {
    setBusy(true);
    try { const r = await api<{ raised: number; worsened: number; resolved: number; escalated: number; failed: unknown[] }>('/alerts/run', { body: {} });
      toast('success', `Checked: ${r.raised} raised, ${r.worsened} worsened, ${r.escalated} escalated, ${r.resolved} resolved${r.failed.length ? `, ${r.failed.length} rule(s) failed` : ''}.`); await qc.invalidateQueries(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Failed.'); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!edit) return;
    setError(null);
    try {
      await api(`/alerts/rules/${edit.code}`, { method: 'PUT', body: { enabled: edit.enabled, params: edit.params, recipientRoles: edit.recipientRoles, escalateAfterHours: edit.escalateAfterHours,
        escalateRoles: edit.escalateRoles, escalateToManager: edit.escalateToManager } });
      toast('success', `${edit.name} saved; it applies from the next check.`); setEdit(null); await qc.invalidateQueries({ queryKey: ['alert-rules'] });
    } catch (e) { setError(e); }
  };
  const RolePicker = ({ value, onChange, label }: { value: string[]; onChange: (v: string[]) => void; label: string }) => (
    <fieldset><legend className="mb-1 text-[13px] font-semibold">{label}</legend>
      <div className="grid max-h-44 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2 text-[13px]">{(q.data?.roles ?? []).map((r) => (
        <label key={r.code} className="inline-flex items-center gap-2"><input type="checkbox" checked={value.includes(r.code)} onChange={(e) => onChange(e.target.checked ? [...value, r.code] : value.filter((x) => x !== r.code))} />{r.name}</label>))}</div>
    </fieldset>
  );
  return (
    <>
      <PageHeader title="Alert Rules" subtitle="What raises an alert, who hears about it, and who it escalates to if nobody acknowledges it. Checked every hour; in-app now, e-mail and WhatsApp once the channels are chosen (D11)."
        actions={<Button loading={busy} icon={<Lightning size={18} />} onClick={run}>Check now</Button>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-60" /> : !q.data ? <div className="p-5"><ErrorBanner error={q.error} /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Rule</th><th className={th}>Settings</th><th className={th}>Notifies</th><th className={th}>Escalates</th>
            <th className={`${th} text-right`}>Open</th><th className={th} /></tr></thead>
            <tbody>{q.data.data.map((r) => (
              <tr key={r.code} className={`border-b border-line align-top last:border-0 ${r.enabled ? '' : 'opacity-60'}`}>
                <td className="px-5 py-3"><span className="font-semibold">{r.name}</span> {!r.enabled && <StatusBadge status="Inactive" label="Off" />}<div className="text-[13px] text-ink-2">{r.description}</div><div className="text-[12px] text-ink-2">{r.area}</div></td>
                <td className={th}>{Object.entries(r.params).map(([k, v]) => <div key={k} className="text-[13px]">{PARAM_LABEL[k] ?? k}: <b>{v}</b></div>)}{!Object.keys(r.params).length && <span className="text-ink-2">—</span>}</td>
                <td className={`${th} text-[13px]`}>{['APPROVAL_OVERDUE', 'RECEIVABLE_DUE', 'DEALER_FROZEN', 'PO_DELIVERY_LATE', 'CAPA_OVERDUE'].includes(r.code) && <div>The person responsible</div>}{r.recipientRoles.map(roleName).join(', ')}</td>
                <td className={`${th} text-[13px]`}>{r.escalateAfterHours ? <>After {r.escalateAfterHours} h to {[...(r.escalateToManager ? ['their reporting manager'] : []), ...r.escalateRoles.map(roleName)].join(', ') || '—'}</> : 'Never'}</td>
                <td className={`${th} text-right num`}>{r.openAlerts}</td>
                <td className={`${th} text-right`}><Button size="sm" variant="ghost" icon={<PencilSimple size={16} />} onClick={() => { setError(null); setEdit({ ...r, params: { ...r.params } }); }}>Edit</Button></td>
              </tr>))}</tbody></table></div>
        )}
      </Card>
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.name} description={edit.description} width={760}
          footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save rule</Button></>}>
          <ErrorBanner error={error} />
          <label className="mb-4 inline-flex items-center gap-2 font-semibold"><input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />Rule is on</label>
          {Object.keys(edit.params).length > 0 && <div className="mb-4 grid gap-4 md:grid-cols-2">{Object.entries(edit.params).map(([k, v]) => (
            <Field key={k} label={PARAM_LABEL[k] ?? k} htmlFor={`rp-${k}`}><Input id={`rp-${k}`} type="number" min="0" step="1" value={v} onChange={(e) => setEdit({ ...edit, params: { ...edit.params, [k]: Number(e.target.value) } })} /></Field>))}</div>}
          <div className="grid gap-4 md:grid-cols-2">
            <RolePicker label="Also notify these roles" value={edit.recipientRoles} onChange={(v) => setEdit({ ...edit, recipientRoles: v })} />
            <RolePicker label="Escalate to these roles" value={edit.escalateRoles} onChange={(v) => setEdit({ ...edit, escalateRoles: v })} />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Escalate after (hours unacknowledged)" htmlFor="rp-esc" hint="Empty = never escalate"><Input id="rp-esc" type="number" min="1" step="1" value={edit.escalateAfterHours ?? ''}
              onChange={(e) => setEdit({ ...edit, escalateAfterHours: e.target.value ? Number(e.target.value) : null })} /></Field>
            <label className="mt-7 inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={edit.escalateToManager} onChange={(e) => setEdit({ ...edit, escalateToManager: e.target.checked })} />Also escalate to the reporting manager of the person responsible</label>
          </div>
        </Modal>
      )}
    </>
  );
}
