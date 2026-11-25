import { ArrowClockwise, CheckCircle, Circle, DownloadSimple, PaperPlaneTilt, PencilSimple, Plus, Trash, UploadSimple, WarningCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';

const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';
const readFile = (f: File) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsText(f); });
const MODE_LABEL: Record<string, string> = { OFF: 'Off', MANUAL: 'Manual (portal or bank upload)', SIMULATED: 'Simulated (training)', LIVE: 'Live' };

// ================================================================ integrations
interface Integration { code: string; name: string; area: string; description: string; modes: string[]; mode: string; provider: string | null; config: Record<string, string | number | boolean>;
  calls30d: number; failures30d: number; queued: number; live: { providers: string[]; config: string[]; note: string } | null; updatedAt: string }
export function IntegrationsPage() {
  const [tab, setTab] = useState<'settings' | 'addresses' | 'messages' | 'templates' | 'reminders' | 'log'>('settings');
  return (
    <>
      <PageHeader title="Integrations" subtitle="Government portals, the bank and messages. Each one is off, manual (the ERP makes the file, a person uploads it and records the reply), simulated for training, or live through a provider. Keys are never stored here: a live connection names the environment variable that holds them." />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'settings', label: 'Connections' }, { value: 'addresses', label: 'GST addresses' }, { value: 'messages', label: 'Messages sent' },
        { value: 'templates', label: 'Message wording' }, { value: 'reminders', label: 'Dealer reminders' }, { value: 'log', label: 'Activity' }]} /></div>
      {tab === 'settings' && <Connections />}{tab === 'addresses' && <Addresses />}{tab === 'messages' && <Messages />}{tab === 'templates' && <Templates />}{tab === 'reminders' && <Reminders />}{tab === 'log' && <Log />}
    </>
  );
}

function Connections() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<{ data: Integration[] }>('/integrations') });
  const [edit, setEdit] = useState<Integration | null>(null); const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<{ channel: string; to: string } | null>(null);
  const save = async () => { setError(null);
    try { await api(`/integrations/${edit!.code}`, { method: 'PUT', body: { mode: edit!.mode, provider: edit!.provider, config: edit!.mode === 'LIVE' ? edit!.config : {} } }); toast('success', `${edit!.name}: ${MODE_LABEL[edit!.mode]}.`); setEdit(null); await qc.invalidateQueries({ queryKey: ['integrations'] }); } catch (e) { setError(e); } };
  const sendTest = async () => { setError(null);
    try { const r = await api<{ message: { status: string; lastError: string | null } }>('/messaging/messages/test', { body: test }); toast(r.message.status === 'Sent' ? 'success' : 'error', r.message.status === 'Sent' ? 'Test message sent.' : `Not sent: ${r.message.lastError ?? r.message.status}`); setTest(null); await qc.invalidateQueries(); } catch (e) { setError(e); } };
  if (!q.data) return q.error ? <ErrorBanner error={q.error} /> : <Skeleton className="h-60" />;
  return (
    <>
      <Card padded={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Integration</th><th className={th}>Mode</th><th className={th}>Last 30 days</th><th className={th} /></tr></thead>
          <tbody>{q.data.data.map((i) => <tr key={i.code} className="border-b border-line align-top last:border-0">
            <td className="px-5 py-3"><b>{i.name}</b><div className="text-[13px] text-ink-2">{i.description}</div><div className="text-[12px] text-ink-2">{i.area}</div></td>
            <td className={th}><StatusBadge status={i.mode === 'OFF' ? 'Inactive' : i.mode === 'SIMULATED' ? 'Pending' : 'Active'} label={MODE_LABEL[i.mode]} />{i.provider && <div className="text-[12px] text-ink-2">{i.provider}</div>}</td>
            <td className={`${th} text-[13px]`}>{i.calls30d} calls{i.failures30d ? `, ${i.failures30d} failed` : ''}{i.queued ? ` · ${i.queued} waiting` : ''}</td>
            <td className={`${th} text-right`}><Button size="sm" variant="ghost" icon={<PencilSimple size={16} />} onClick={() => { setError(null); setEdit({ ...i, config: { ...i.config } }); }}>Change</Button>
              {['EMAIL', 'SMS', 'WHATSAPP'].includes(i.code) && i.mode !== 'OFF' && <Button size="sm" variant="ghost" icon={<PaperPlaneTilt size={16} />} onClick={() => { setError(null); setTest({ channel: i.code, to: '' }); }}>Test</Button>}</td></tr>)}</tbody></table></div>
      </Card>
      {edit && <Modal open onClose={() => setEdit(null)} title={edit.name} description={edit.description} width={680}
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={save}>Save</Button></>}>
        <ErrorBanner error={error} />
        <fieldset className="space-y-2"><legend className="mb-1 text-[13px] font-semibold">Mode</legend>
          {edit.modes.map((m) => { const disabled = m === 'LIVE' && !edit.live;
            return <label key={m} className={`flex items-start gap-2 text-[14px] ${disabled ? 'opacity-50' : ''}`}><input type="radio" name="mode" disabled={disabled} checked={edit.mode === m} onChange={() => setEdit({ ...edit, mode: m, provider: m === 'LIVE' ? edit.live?.providers[0] ?? null : null })} />
              <span><b>{MODE_LABEL[m]}</b>{disabled && <span className="block text-[12px] text-ink-2">{edit.area === 'GST' ? 'Needs the GST service provider chosen under D27.' : 'Needs the bank’s host-to-host interface.'}</span>}</span></label>; })}
        </fieldset>
        {edit.mode === 'LIVE' && edit.live && <div className="mt-4 space-y-3">
          <p className="text-[13px] text-ink-2">{edit.live.note}</p>
          {edit.live.config.map((k) => <Field key={k} label={k} htmlFor={`ic-${k}`} hint={/Env$/.test(k) ? 'Name of the environment variable on the server' : undefined}>
            <Input id={`ic-${k}`} value={String(edit.config[k] ?? '')} onChange={(e) => setEdit({ ...edit, config: { ...edit.config, [k]: k === 'port' ? Number(e.target.value) : k === 'secure' ? e.target.value === 'true' : e.target.value } })} /></Field>)}
        </div>}
      </Modal>}
      {test && <Modal open onClose={() => setTest(null)} title={`Test ${test.channel.toLowerCase()}`} footer={<><Button variant="secondary" onClick={() => setTest(null)}>Cancel</Button><Button onClick={sendTest}>Send</Button></>}>
        <ErrorBanner error={error} />
        <Field label={test.channel === 'EMAIL' ? 'E-mail address' : 'Mobile number'} htmlFor="it-to"><Input id="it-to" value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value.trim() })} /></Field>
      </Modal>}
    </>
  );
}

function Addresses() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['int-addresses'], queryFn: () => api<{ gstins: { id: string; gstin: string; legalEntityName: string; tradeName: string | null; addrLine1: string | null; location: string | null; pincode: string | null; einvoiceApplicable: boolean }[];
    warehouses: { id: string; code: string; name: string; address: string | null; city: string | null; pincode: string | null }[] }>('/integrations/addresses') });
  const [g, setG] = useState<{ id: string; tradeName: string; addrLine1: string; location: string; pincode: string; einvoiceApplicable: boolean } | null>(null);
  const [w, setW] = useState<{ id: string; address: string; city: string; pincode: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const put = async (path: string, body: object, done: () => void) => { setError(null); try { await api(path, { method: 'PUT', body }); toast('success', 'Saved.'); done(); await qc.invalidateQueries({ queryKey: ['int-addresses'] }); } catch (e) { setError(e); } };
  if (!q.data) return <Skeleton className="h-40" />;
  const missing = (v: unknown) => (v ? v as string : <span className="text-danger-text">missing</span>);
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="GSTINs — seller address on e-invoices" padded={false}>
        <table className="w-full text-[14px]"><tbody>{q.data.gstins.map((x) => <tr key={x.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><b className="num">{x.gstin}</b><div className="text-[13px] text-ink-2">{x.legalEntityName}</div></td>
          <td className={`${th} text-[13px]`}>{missing(x.addrLine1)}, {missing(x.location)} {missing(x.pincode)}{!x.einvoiceApplicable && <div className="text-ink-2">E-invoice not required</div>}</td>
          <td className={`${th} text-right`}><Button size="sm" variant="ghost" onClick={() => { setError(null); setG({ id: x.id, tradeName: x.tradeName ?? '', addrLine1: x.addrLine1 ?? '', location: x.location ?? '', pincode: x.pincode ?? '', einvoiceApplicable: x.einvoiceApplicable }); }}>Edit</Button></td></tr>)}</tbody></table>
      </Card>
      <Card title="Warehouses — dispatch-from address on e-way bills" padded={false}>
        <table className="w-full text-[14px]"><tbody>{q.data.warehouses.map((x) => <tr key={x.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><b>{x.code}</b><div className="text-[13px] text-ink-2">{x.name}</div></td>
          <td className={`${th} text-[13px]`}>{missing(x.address)}, {missing(x.city)} {missing(x.pincode)}</td>
          <td className={`${th} text-right`}><Button size="sm" variant="ghost" onClick={() => { setError(null); setW({ id: x.id, address: x.address ?? '', city: x.city ?? '', pincode: x.pincode ?? '' }); }}>Edit</Button></td></tr>)}</tbody></table>
      </Card>
      {g && <Modal open onClose={() => setG(null)} title="Seller address" footer={<><Button variant="secondary" onClick={() => setG(null)}>Cancel</Button><Button onClick={() => put(`/integrations/addresses/gstin/${g.id}`, { ...g, tradeName: g.tradeName || null }, () => setG(null))}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Trade name" htmlFor="ga-t"><Input id="ga-t" value={g.tradeName} onChange={(e) => setG({ ...g, tradeName: e.target.value })} /></Field>
        <Field label="Address line" htmlFor="ga-a" required><Input id="ga-a" maxLength={100} value={g.addrLine1} onChange={(e) => setG({ ...g, addrLine1: e.target.value })} /></Field>
        <div className="grid gap-4 md:grid-cols-2"><Field label="Place" htmlFor="ga-l" required><Input id="ga-l" value={g.location} onChange={(e) => setG({ ...g, location: e.target.value })} /></Field>
          <Field label="PIN code" htmlFor="ga-p" required><Input id="ga-p" inputMode="numeric" maxLength={6} value={g.pincode} onChange={(e) => setG({ ...g, pincode: e.target.value })} /></Field></div>
        <label className="inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={g.einvoiceApplicable} onChange={(e) => setG({ ...g, einvoiceApplicable: e.target.checked })} />This GSTIN must e-invoice B2B sales</label>
      </Modal>}
      {w && <Modal open onClose={() => setW(null)} title="Dispatch-from address" footer={<><Button variant="secondary" onClick={() => setW(null)}>Cancel</Button><Button onClick={() => put(`/integrations/addresses/warehouse/${w.id}`, w, () => setW(null))}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Address" htmlFor="wa-a" required><Textarea id="wa-a" value={w.address} onChange={(e) => setW({ ...w, address: e.target.value })} /></Field>
        <div className="grid gap-4 md:grid-cols-2"><Field label="City" htmlFor="wa-c" required><Input id="wa-c" value={w.city} onChange={(e) => setW({ ...w, city: e.target.value })} /></Field>
          <Field label="PIN code" htmlFor="wa-p" required><Input id="wa-p" inputMode="numeric" maxLength={6} value={w.pincode} onChange={(e) => setW({ ...w, pincode: e.target.value })} /></Field></div>
      </Modal>}
    </div>
  );
}

function Messages() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['messages', status], queryFn: () => api<{ data: { id: string; channel: string; template: string; to: string; recipient: string | null; subject: string | null; body: string; status: string; attempts: number; lastError: string | null; mode: string | null; createdAt: string; sentAt: string | null; attachments: number }[] }>(`/messaging/messages${status ? `?status=${status}` : ''}`) });
  return (
    <Card padded={false}>
      <div className="p-5"><Select aria-label="Status" className="w-48" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['Queued', 'Sent', 'Failed', 'Skipped'].map((s) => <option key={s}>{s}</option>)}</Select></div>
      {!q.data ? <Skeleton className="h-40" /> : !q.data.data.length ? <div className="px-5 pb-5"><EmptyState title="No messages" text="Messages appear when a channel is switched on." /></div> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Message</th><th className={th}>To</th><th className={th}>Status</th><th className={th}>When</th><th className={th} /></tr></thead>
          <tbody>{q.data.data.map((m) => <tr key={m.id} className="border-b border-line align-top last:border-0"><td className="px-5 py-3"><b>{m.subject ?? m.template}</b><div className="max-w-[420px] truncate text-[13px] text-ink-2">{m.body}</div><div className="text-[12px] text-ink-2">{m.channel}{m.attachments ? ` · ${m.attachments} attachment` : ''}</div></td>
            <td className={th}>{m.recipient ?? '—'}<div className="text-[12px] text-ink-2">{m.to}</div></td>
            <td className={th}><StatusBadge status={m.status === 'Sent' ? 'Approved' : m.status === 'Failed' ? 'Rejected' : m.status === 'Queued' ? 'Pending' : 'Inactive'} label={`${m.status}${m.mode === 'SIMULATED' ? ' (simulated)' : ''}`} />{m.lastError && <div className="text-[12px] text-danger-text">{m.lastError}</div>}</td>
            <td className={th}>{fmtDateTime(m.sentAt ?? m.createdAt)}</td>
            <td className={`${th} text-right`}>{['Failed', 'Skipped'].includes(m.status) && <Button size="sm" variant="ghost" icon={<ArrowClockwise size={16} />} onClick={async () => { await api(`/messaging/messages/${m.id}/retry`, { body: {} }); await qc.invalidateQueries({ queryKey: ['messages'] }); }}>Send again</Button>}</td></tr>)}</tbody></table></div>)}
    </Card>
  );
}

function Templates() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['msg-templates'], queryFn: () => api<{ data: { code: string; channel: string; subject: string | null; body: string; providerTemplateId: string | null }[] }>('/messaging/message-templates') });
  const [e, setE] = useState<{ code: string; channel: string; subject: string | null; body: string; providerTemplateId: string | null } | null>(null); const [error, setError] = useState<unknown>(null);
  const NAMES: Record<string, string> = { ALERT: 'Alert', REPORT: 'Scheduled report', DEALER_PAYMENT_DUE: 'Dealer — payment due', DEALER_PAYMENT_OVERDUE: 'Dealer — payment overdue' };
  if (!q.data) return <Skeleton className="h-40" />;
  return (
    <Card padded={false}>
      <table className="w-full text-[14px]"><tbody>{q.data.data.map((t) => <tr key={`${t.code}${t.channel}`} className="border-b border-line align-top last:border-0"><td className="px-5 py-3"><b>{NAMES[t.code] ?? t.code}</b><div className="text-[12px] text-ink-2">{t.channel}{t.providerTemplateId ? ` · template ${t.providerTemplateId}` : ''}</div></td>
        <td className={`${th} text-[13px]`}>{t.subject && <div className="font-semibold">{t.subject}</div>}<div className="whitespace-pre-line text-ink-2">{t.body}</div></td>
        <td className={`${th} text-right`}><Button size="sm" variant="ghost" onClick={() => { setError(null); setE({ ...t }); }}>Edit</Button></td></tr>)}</tbody></table>
      {e && <Modal open onClose={() => setE(null)} title={`${NAMES[e.code] ?? e.code} — ${e.channel}`} description="Keep the {{placeholders}}; SMS and WhatsApp wording must match the template registered with the provider." width={680}
        footer={<><Button variant="secondary" onClick={() => setE(null)}>Cancel</Button><Button onClick={async () => { setError(null); try { await api(`/messaging/message-templates/${e.code}/${e.channel}`, { method: 'PUT', body: e }); toast('success', 'Saved.'); setE(null); await qc.invalidateQueries({ queryKey: ['msg-templates'] }); } catch (x) { setError(x); } }}>Save</Button></>}>
        <ErrorBanner error={error} />
        {e.channel === 'EMAIL' && <Field label="Subject" htmlFor="mt-s"><Input id="mt-s" value={e.subject ?? ''} onChange={(x) => setE({ ...e, subject: x.target.value })} /></Field>}
        <Field label="Text" htmlFor="mt-b"><Textarea id="mt-b" rows={8} value={e.body} onChange={(x) => setE({ ...e, body: x.target.value })} /></Field>
        {e.channel !== 'EMAIL' && <Field label={e.channel === 'SMS' ? 'DLT template id' : 'Approved template name'} htmlFor="mt-p"><Input id="mt-p" value={e.providerTemplateId ?? ''} onChange={(x) => setE({ ...e, providerTemplateId: x.target.value || null })} /></Field>}
      </Modal>}
    </Card>
  );
}

function Reminders() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['dealer-reminders'], queryFn: () => api<{ enabled: boolean; daysBefore: number; overdueEveryDays: number; channels: string[] }>('/messaging/dealer-reminders') });
  const [f, setF] = useState<{ enabled: boolean; daysBefore: number; overdueEveryDays: number; channels: string[] } | null>(null); const [error, setError] = useState<unknown>(null);
  const v = f ?? q.data;
  if (!v) return <Skeleton className="h-40" />;
  return (
    <Card title="Payment reminders to dealers" className="max-w-2xl">
      <ErrorBanner error={error} />
      <label className="mb-4 inline-flex items-center gap-2 font-semibold"><input type="checkbox" checked={v.enabled} onChange={(e) => setF({ ...v, enabled: e.target.checked })} />Send reminders</label>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Remind this many days before the due date" htmlFor="dr-b"><Input id="dr-b" type="number" min="0" max="30" value={v.daysBefore} onChange={(e) => setF({ ...v, daysBefore: Number(e.target.value) })} /></Field>
        <Field label="While overdue, remind every (days)" htmlFor="dr-o"><Input id="dr-o" type="number" min="1" max="60" value={v.overdueEveryDays} onChange={(e) => setF({ ...v, overdueEveryDays: Number(e.target.value) })} /></Field>
      </div>
      <p className="mb-2 text-[13px] font-semibold">Channels (to the dealer's e-mail and mobile on record)</p>
      {['EMAIL', 'SMS', 'WHATSAPP'].map((c) => <label key={c} className="mr-5 inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={v.channels.includes(c)} onChange={(e) => setF({ ...v, channels: e.target.checked ? [...v.channels, c] : v.channels.filter((x) => x !== c) })} />{c === 'EMAIL' ? 'E-mail' : c === 'SMS' ? 'SMS' : 'WhatsApp'}</label>)}
      <div className="mt-4"><Button onClick={async () => { setError(null); try { await api('/messaging/dealer-reminders', { method: 'PUT', body: v }); toast('success', 'Saved; checked every hour.'); setF(null); await qc.invalidateQueries({ queryKey: ['dealer-reminders'] }); } catch (e) { setError(e); } }}>Save</Button></div>
    </Card>
  );
}

function Log() {
  const q = useQuery({ queryKey: ['int-log'], queryFn: () => api<{ data: { id: number; integration: string; operation: string; mode: string; ok: boolean; error: string | null; at: string; byUser: string | null; subjectType: string | null }[] }>('/integrations/log') });
  if (!q.data) return <Skeleton className="h-40" />;
  return (
    <Card padded={false}>{!q.data.data.length ? <div className="p-5"><EmptyState title="No activity yet" text="Every file made and every message sent is recorded here." /></div> : (
      <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">When</th><th className={th}>Integration</th><th className={th}>What</th><th className={th}>Result</th><th className={th}>By</th></tr></thead>
        <tbody>{q.data.data.map((l) => <tr key={l.id} className="border-b border-line last:border-0"><td className="px-5 py-3">{fmtDateTime(l.at)}</td><td className={th}>{l.integration}</td><td className={th}>{l.operation}<div className="text-[12px] text-ink-2">{MODE_LABEL[l.mode] ?? l.mode}</div></td>
          <td className={th}>{l.ok ? <StatusBadge status="Approved" label="OK" /> : <span><StatusBadge status="Rejected" label="Failed" /><div className="text-[12px] text-danger-text">{l.error}</div></span>}</td><td className={th}>{l.byUser ?? 'System'}</td></tr>)}</tbody></table>)}
    </Card>
  );
}

// ================================================================ imports
interface Kind { id: string; label: string; group: string; columns: { key: string; required?: boolean; note: string; example: string }[] }
export function ImportsPage() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['imports'], queryFn: () => api<{ kinds: Kind[]; runs: { id: string; kind: string; fileName: string | null; status: string; rowCount: number; errorCount: number; createdAt: string; by: string }[]; cutoverDate: string | null }>('/imports') });
  const [kind, setKind] = useState(''); const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [res, setRes] = useState<{ ok: boolean; rows: number; errors: { row: number; field: string; message: string }[]; summary: Record<string, unknown> | null } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const k = q.data?.kinds.find((x) => x.id === (kind || q.data?.kinds[0]?.id));
  const go = async (action: 'validate' | 'commit') => { setBusy(true); setError(null);
    try { const r = await api<typeof res>(`/imports/${k!.id}/${action}`, { body: { content: file!.content, fileName: file!.name } }); setRes(r);
      if (action === 'commit') { toast('success', `${r!.rows} rows imported.`); setFile(null); await qc.invalidateQueries(); } } catch (e) { setError(e); } finally { setBusy(false); } };
  if (!q.data) return q.error ? <ErrorBanner error={q.error} /> : <Skeleton className="h-60" />;
  const exportable = ['hsn', 'employees', 'transporters', 'items', 'dealers', 'vendors'];
  return (
    <>
      <PageHeader title="Import" subtitle="Load masters and opening balances from a spreadsheet saved as CSV. The file is checked first and nothing is saved until every row is right; then all rows go in together. Items, dealers and vendors arrive as Draft and go through the usual checks and approvals." />
      <div className="grid gap-6 xl:grid-cols-[3fr_2fr]">
        <Card title="Load a file">
          <ErrorBanner error={error} />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="What" htmlFor="im-k"><Select id="im-k" value={k?.id ?? ''} onChange={(e) => { setKind(e.target.value); setRes(null); setFile(null); }}>
              {['Masters', 'Opening balances'].map((g) => <optgroup key={g} label={g}>{q.data!.kinds.filter((x) => x.group === g).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</optgroup>)}</Select></Field>
            <Field label="CSV file" htmlFor="im-f"><Input id="im-f" type="file" accept=".csv" onChange={async (e) => { const f = e.target.files?.[0]; setRes(null); setFile(f ? { name: f.name, content: await readFile(f) } : null); }} /></Field>
          </div>
          {k?.group === 'Opening balances' && <p className="mb-3 text-[13px] text-ink-2">{q.data.cutoverDate ? `Opening balances are as at the end of the day before the cut-over date ${fmtDate(q.data.cutoverDate)}. Load the trial balance, then stock, then open invoices and bills.` : 'Set the cut-over date on the Go-live page first.'}</p>}
          <div className="flex flex-wrap gap-2">
            <a href={`/api/v1/imports/${k?.id}/template`}><Button variant="secondary" icon={<DownloadSimple size={16} />}>Template</Button></a>
            {k && exportable.includes(k.id) && <a href={`/api/v1/imports/export/${k.id}`}><Button variant="ghost" icon={<DownloadSimple size={16} />}>Export current</Button></a>}
            <Button variant="secondary" loading={busy} disabled={!file} onClick={() => go('validate')}>Check</Button>
            <Button loading={busy} disabled={!file || !res?.ok} icon={<UploadSimple size={16} />} onClick={() => go('commit')}>Import {res?.ok ? `${res.rows} rows` : ''}</Button>
          </div>
          {res && (res.ok ? <p className="mt-4 text-[14px]"><CheckCircle size={18} weight="fill" className="mr-1 inline text-success-text" />All {res.rows} rows are fine.{res.summary && Object.keys(res.summary).length ? ` ${JSON.stringify(res.summary)}` : ''}</p> : (
            <div className="mt-4"><p className="mb-2 text-[14px] font-semibold text-danger-text"><WarningCircle size={18} className="mr-1 inline" />{res.errors.length} problem{res.errors.length === 1 ? '' : 's'} — nothing was saved</p>
              <div className="max-h-72 overflow-y-auto rounded-md border border-line"><table className="w-full text-[13px]"><thead><tr className={thead}><th className="px-3 py-2">Row</th><th className="px-3 py-2">Column</th><th className="px-3 py-2">Problem</th></tr></thead>
                <tbody>{res.errors.map((e, i) => <tr key={i} className="border-b border-line last:border-0"><td className="px-3 py-2 num">{e.row}</td><td className="px-3 py-2">{e.field}</td><td className="px-3 py-2">{e.message}</td></tr>)}</tbody></table></div></div>))}
        </Card>
        <Card title="Columns">{k && <ul className="space-y-1 text-[13px]">{k.columns.map((c) => <li key={c.key}><code className="font-semibold">{c.key}</code>{c.required && <span className="text-danger-text"> *</span>}{c.note && <span className="text-ink-2"> — {c.note}</span>}</li>)}</ul>}</Card>
      </div>
      <Card title="Earlier imports" className="mt-6" padded={false}>
        {!q.data.runs.length ? <div className="p-5 text-[14px] text-ink-2">None yet.</div> : <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">When</th><th className={th}>What</th><th className={th}>File</th><th className={th}>Result</th><th className={th}>By</th></tr></thead>
          <tbody>{q.data.runs.map((r) => <tr key={r.id} className="border-b border-line last:border-0"><td className="px-5 py-3">{fmtDateTime(r.createdAt)}</td><td className={th}>{q.data!.kinds.find((x) => x.id === r.kind)?.label ?? r.kind}</td><td className={th}>{r.fileName ?? '—'}</td>
            <td className={th}><StatusBadge status={r.status === 'Committed' ? 'Approved' : r.status === 'Failed' ? 'Rejected' : 'Pending'} label={r.status === 'Committed' ? `Imported ${r.rowCount}` : r.status === 'Failed' ? `${r.errorCount} problems` : `Checked ${r.rowCount}`} /></td><td className={th}>{r.by}</td></tr>)}</tbody></table>}
      </Card>
    </>
  );
}

// ================================================================ go-live readiness
interface Check { key: string; area: string; title: string; status: 'ok' | 'todo' | 'warn'; detail: string; fix?: string; signedBy?: string | null; signedAt?: string | null; note?: string | null }
export function GoLivePage() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['golive'], queryFn: () => api<{ checks: Check[]; manual: Check[]; ready: boolean; done: number; total: number; cutoverDate: string | null; canSignOff: boolean }>('/golive') });
  const [sign, setSign] = useState<Check | null>(null); const [note, setNote] = useState(''); const [cut, setCut] = useState(''); const [error, setError] = useState<unknown>(null);
  const icon = (s: string) => (s === 'ok' ? <CheckCircle size={20} weight="fill" className="shrink-0 text-success-text" aria-label="Done" /> : s === 'warn' ? <WarningCircle size={20} weight="fill" className="shrink-0 text-warning-text" aria-label="Check" /> : <Circle size={20} className="shrink-0 text-ink-2" aria-label="To do" />);
  if (!q.data) return q.error ? <ErrorBanner error={q.error} /> : <Skeleton className="h-96" />;
  const d = q.data;
  const areas = [...new Set(d.checks.map((c) => c.area))];
  return (
    <>
      <PageHeader title="Go-live" subtitle="Everything that has to be true before the ERP replaces the old system. The automatic checks read the live data; the others are signed off by a named person with what was checked."
        actions={<Button variant="secondary" icon={<ArrowClockwise size={18} />} onClick={() => q.refetch()}>Check again</Button>} />
      <div className="mb-6 flex flex-wrap items-center gap-4"><StatusBadge status={d.ready ? 'Approved' : 'Pending'} label={d.ready ? 'Ready to go live' : 'Not ready yet'} /><span className="text-[14px] text-ink-2">{d.done} of {d.total} done</span>
        <div className="h-2 w-64 overflow-hidden rounded-full bg-line"><div className="h-full bg-primary" style={{ width: `${Math.round((d.done / d.total) * 100)}%` }} /></div></div>
      <ErrorBanner error={error} />
      <div className="grid gap-6 xl:grid-cols-2">
        {areas.map((a) => <Card key={a} title={a}><ul className="space-y-3">{d.checks.filter((c) => c.area === a).map((c) => <li key={c.key} className="flex gap-3">{icon(c.status)}<div className="text-[14px]"><b>{c.title}</b><div className="text-ink-2">{c.detail}</div>
          {c.status !== 'ok' && c.fix && <div className="text-[12px] text-primary">{c.fix}</div>}
          {c.key === 'cutoverDate' && d.canSignOff && <div className="mt-2 flex gap-2"><Input type="date" aria-label="Cut-over date" className="w-44" value={cut || d.cutoverDate || ''} onChange={(e) => setCut(e.target.value)} />
            <Button size="sm" variant="secondary" disabled={!cut} onClick={async () => { setError(null); try { await api('/golive/cutover', { method: 'PUT', body: { date: cut } }); toast('success', 'Cut-over date set.'); await qc.invalidateQueries({ queryKey: ['golive'] }); } catch (e) { setError(e); } }}>Set</Button></div>}
        </div></li>)}</ul></Card>)}
        <Card title="Signed off by people" className="xl:col-span-2"><ul className="grid gap-3 md:grid-cols-2">{d.manual.map((c) => <li key={c.key} className="flex gap-3">{icon(c.status)}<div className="text-[14px]"><b>{c.title}</b><div className="text-ink-2">{c.detail}</div>
          {c.signedBy ? <div className="text-[12px]">Signed by {c.signedBy}, {fmtDateTime(c.signedAt)} — {c.note}</div> : null}
          {d.canSignOff && <Button className="mt-1" size="sm" variant="ghost" onClick={async () => { if (c.signedBy) { await api(`/golive/signoff/${c.key}`, { body: { undo: true } }); await qc.invalidateQueries({ queryKey: ['golive'] }); } else { setError(null); setNote(''); setSign(c); } }}>{c.signedBy ? 'Withdraw' : 'Sign off'}</Button>}
        </div></li>)}</ul></Card>
      </div>
      <Modal open={!!sign} onClose={() => setSign(null)} title={sign?.title ?? ''} description={sign?.detail}
        footer={<><Button variant="secondary" onClick={() => setSign(null)}>Cancel</Button><Button disabled={note.trim().length < 3} onClick={async () => { setError(null); try { await api(`/golive/signoff/${sign!.key}`, { body: { note } }); toast('success', 'Signed off.'); setSign(null); await qc.invalidateQueries({ queryKey: ['golive'] }); } catch (e) { setError(e); } }}>Sign off</Button></>}>
        <ErrorBanner error={error} />
        <Field label="What was checked (report, minutes, who signed)" htmlFor="gl-n" required><Textarea id="gl-n" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

// ================================================================ scheduled reports
interface Sched { id: string; name: string; reportId: string; params: Record<string, string>; frequency: string; weekday: number | null; monthDay: number | null; hourIst: number; enabled: boolean; nextRunAt: string; lastRunAt: string | null; lastStatus: string | null; recipientUserIds: string[]; recipients: string[] | null; owner: string }
const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function ReportSchedulesPage() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['schedules'], queryFn: () => api<{ data: Sched[]; emailMode: string }>('/messaging/report-schedules') });
  const reps = useQuery({ queryKey: ['reports'], queryFn: () => api<{ data: { id: string; title: string; area: string; link: string | null }[] }>('/reports') });
  const users = useQuery({ queryKey: ['schedule-recipients'], queryFn: () => api<{ data: { id: string; fullName: string }[] }>('/messaging/recipients') });
  const blank = { id: '', name: '', reportId: '', frequency: 'WEEKLY', weekday: 1, monthDay: 1, hourIst: 8, recipientUserIds: [] as string[], enabled: true };
  const [f, setF] = useState<typeof blank | null>(null); const [error, setError] = useState<unknown>(null);
  const save = async () => { setError(null);
    const body = { name: f!.name, reportId: f!.reportId, frequency: f!.frequency, weekday: f!.frequency === 'WEEKLY' ? f!.weekday : null, monthDay: f!.frequency === 'MONTHLY' ? f!.monthDay : null, hourIst: f!.hourIst, recipientUserIds: f!.recipientUserIds, enabled: f!.enabled, params: {} };
    try { await api(f!.id ? `/messaging/report-schedules/${f!.id}` : '/messaging/report-schedules', { method: f!.id ? 'PUT' : 'POST', body }); toast('success', 'Schedule saved.'); setF(null); await qc.invalidateQueries({ queryKey: ['schedules'] }); } catch (e) { setError(e); } };
  const when = (s: Sched) => `${s.frequency === 'DAILY' ? 'Every day' : s.frequency === 'WEEKLY' ? `Every ${DAYS[s.weekday!]}` : `Day ${s.monthDay} of each month`} at ${String(s.hourIst).padStart(2, '0')}:00`;
  const runnable = (reps.data?.data ?? []).filter((r) => !r.link);
  return (
    <>
      <PageHeader title="Scheduled Reports" subtitle="A report e-mailed as a spreadsheet (CSV) on a schedule. It shows only what you may see, whoever receives it."
        actions={<Button icon={<Plus size={18} />} onClick={() => { setError(null); setF({ ...blank, reportId: runnable[0]?.id ?? '' }); }}>New schedule</Button>} />
      {q.data?.emailMode === 'OFF' && <div className="mb-4 rounded-md border border-warning-text/40 bg-warning-bg p-3 text-[14px]">E-mail is switched off, so schedules run but nothing is sent. An administrator switches it on in Administration → Integrations.</div>}
      <Card padded={false}>{!q.data ? <Skeleton className="h-40" /> : !q.data.data.length ? <div className="p-5"><EmptyState title="No schedules" text="Create one to get a report by e-mail." /></div> : (
        <table className="w-full text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Schedule</th><th className={th}>When</th><th className={th}>To</th><th className={th}>Last run</th><th className={th} /></tr></thead>
          <tbody>{q.data.data.map((s) => <tr key={s.id} className={`border-b border-line align-top last:border-0 ${s.enabled ? '' : 'opacity-60'}`}><td className="px-5 py-3"><b>{s.name}</b><div className="text-[13px] text-ink-2">{reps.data?.data.find((r) => r.id === s.reportId)?.title ?? s.reportId} · {s.owner}</div></td>
            <td className={th}>{when(s)}<div className="text-[12px] text-ink-2">Next {fmtDateTime(s.nextRunAt)}</div></td><td className={`${th} text-[13px]`}>{(s.recipients ?? []).join(', ')}</td>
            <td className={`${th} text-[13px]`}>{s.lastRunAt ? <>{fmtDateTime(s.lastRunAt)}<div className="text-ink-2">{s.lastStatus}</div></> : '—'}</td>
            <td className={`${th} whitespace-nowrap text-right`}><Button size="sm" variant="ghost" icon={<PaperPlaneTilt size={16} />} onClick={async () => { try { const r = await api<{ status: string }>(`/messaging/report-schedules/${s.id}/run`, { body: {} }); toast('success', r.status); await qc.invalidateQueries({ queryKey: ['schedules'] }); } catch (e) { toast('error', e instanceof Error ? e.message : 'Failed'); } }}>Send now</Button>
              <Button size="sm" variant="ghost" icon={<PencilSimple size={16} />} onClick={() => { setError(null); setF({ id: s.id, name: s.name, reportId: s.reportId, frequency: s.frequency, weekday: s.weekday ?? 1, monthDay: s.monthDay ?? 1, hourIst: s.hourIst, recipientUserIds: s.recipientUserIds, enabled: s.enabled }); }}>Edit</Button>
              <Button size="sm" variant="ghost" icon={<Trash size={16} />} aria-label="Delete" onClick={async () => { await api(`/messaging/report-schedules/${s.id}`, { method: 'DELETE' }); await qc.invalidateQueries({ queryKey: ['schedules'] }); }} /></td></tr>)}</tbody></table>)}</Card>
      {f && <Modal open onClose={() => setF(null)} title={f.id ? 'Edit schedule' : 'New schedule'} width={680} footer={<><Button variant="secondary" onClick={() => setF(null)}>Cancel</Button><Button disabled={!f.name || !f.reportId || !f.recipientUserIds.length} onClick={save}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Name" htmlFor="rs-n" required><Input id="rs-n" value={f.name} placeholder="Monday receivables for the sales heads" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Report" htmlFor="rs-r" required><Select id="rs-r" value={f.reportId} onChange={(e) => setF({ ...f, reportId: e.target.value })}>{runnable.map((r) => <option key={r.id} value={r.id}>{r.area} — {r.title}</option>)}</Select></Field>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="How often" htmlFor="rs-f"><Select id="rs-f" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="DAILY">Daily</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly</option></Select></Field>
          {f.frequency === 'WEEKLY' && <Field label="Day" htmlFor="rs-w"><Select id="rs-w" value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>{DAYS.slice(1).map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</Select></Field>}
          {f.frequency === 'MONTHLY' && <Field label="Day of month" htmlFor="rs-m"><Input id="rs-m" type="number" min="1" max="28" value={f.monthDay} onChange={(e) => setF({ ...f, monthDay: Number(e.target.value) })} /></Field>}
          <Field label="Hour (IST)" htmlFor="rs-h"><Input id="rs-h" type="number" min="0" max="23" value={f.hourIst} onChange={(e) => setF({ ...f, hourIst: Number(e.target.value) })} /></Field>
        </div>
        <fieldset><legend className="mb-1 text-[13px] font-semibold">Send to</legend>
          <div className="grid max-h-52 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2 text-[13px]">{(users.data?.data ?? []).map((u) => <label key={u.id} className="inline-flex items-center gap-2">
            <input type="checkbox" checked={f.recipientUserIds.includes(u.id)} onChange={(e) => setF({ ...f, recipientUserIds: e.target.checked ? [...f.recipientUserIds, u.id] : f.recipientUserIds.filter((x) => x !== u.id) })} />{u.fullName}</label>)}</div></fieldset>
        <label className="mt-3 inline-flex items-center gap-2 text-[14px]"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />On</label>
      </Modal>}
    </>
  );
}
