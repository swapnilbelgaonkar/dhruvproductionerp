import { DownloadSimple, Lightning, PencilSimple, XCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useToast } from './toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, Select, Skeleton, StatusBadge, Textarea } from './ui';

type Problem = { field: string; message: string };
const REASONS: Record<string, string> = { 1: 'Duplicate', 2: 'Data entry mistake', 3: 'Order cancelled', 4: 'Other' };
const modeNote = (m: string) => (m === 'MANUAL' ? 'Upload the JSON on the government portal and record the reply here.' : m === 'SIMULATED' ? 'Training mode: results are marked SIMULATED and are not valid.' : '');

const download = (name: string, data: unknown) => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};

function CancelDialog({ open, title, onClose, onConfirm }: { open: boolean; title: string; onClose: () => void; onConfirm: (reason: string, remarks: string) => Promise<void> }) {
  const [reason, setReason] = useState('2'); const [remarks, setRemarks] = useState(''); const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title} description="Allowed within 24 hours. Cancel it on the government portal too if it was made there."
      footer={<><Button variant="secondary" onClick={onClose}>Keep</Button><Button variant="danger" loading={busy} disabled={!remarks.trim()} onClick={async () => { setBusy(true); setError(null); try { await onConfirm(reason, remarks); onClose(); } catch (e) { setError(e); } finally { setBusy(false); } }}>Cancel it</Button></>}>
      <ErrorBanner error={error} />
      <Field label="Reason" htmlFor="gc-r"><Select id="gc-r" value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <Field label="Remarks" htmlFor="gc-m" required><Textarea id="gc-m" maxLength={100} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- e-invoice (IRN)
interface Einv { mode: string; applicable: boolean; reason: string | null; problems: Problem[]; payload: unknown; active: { irn: string; ackNo: string; ackDate: string; mode: string; simulated: boolean; qrDataUrl: string } | null;
  history: { id: string; status: string; irn: string; ackNo: string; ackDate: string; mode: string; cancelledAt: string | null; createdBy: string }[]; allowedActions: string[] }

export function EinvoicePanel({ kind, id, docNo }: { kind: 'invoice' | 'credit-note'; id: string; docNo: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['einvoice', kind, id], queryFn: () => api<Einv>(`/gst/einvoice/${kind}/${id}`) });
  const [record, setRecord] = useState(false); const [cancel, setCancel] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState({ irn: '', ackNo: '', ackDate: '', signedQr: '' });
  const refresh = () => qc.invalidateQueries();
  const generate = async (body: object) => { setBusy(true); setError(null);
    try { const r = await api<{ irn: string }>(`/gst/einvoice/${kind}/${id}`, { body }); toast('success', `IRN recorded: ${r.irn.slice(0, 12)}…`); setRecord(false); await refresh(); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (q.isLoading) return <Card title="E-invoice"><Skeleton className="h-20" /></Card>;
  if (!q.data) return <Card title="E-invoice"><ErrorBanner error={q.error} /></Card>;
  const d = q.data;
  return (
    <Card title="E-invoice (IRN)" actions={d.payload ? <Button size="sm" variant="ghost" icon={<DownloadSimple size={16} />} onClick={() => download(`${docNo.replace(/\//g, '-')}-einvoice.json`, [d.payload])}>JSON</Button> : undefined}>
      <ErrorBanner error={error} />
      {d.mode === 'OFF' ? <p className="text-[14px] text-ink-2">The e-invoice integration is switched off (Administration → Integrations).</p>
        : !d.applicable ? <p className="text-[14px] text-ink-2">{d.reason}</p>
          : d.active ? (
            <div className="flex gap-4">
              <img src={d.active.qrDataUrl} alt="Signed QR code of the e-invoice" width={112} height={112} className="shrink-0" />
              <div className="min-w-0 text-[13px]">{d.active.simulated && <StatusBadge status="Pending" label="Simulated — not valid" />}
                <KeyValues columns="narrow" items={[['IRN', <span key="i" className="break-all num">{d.active.irn}</span>], ['Ack. no.', d.active.ackNo], ['Ack. date', fmtDateTime(d.active.ackDate)]]} />
                {d.allowedActions.includes('cancel') && <Button className="mt-2" size="sm" variant="secondary" icon={<XCircle size={16} />} onClick={() => setCancel(true)}>Cancel IRN</Button>}</div>
            </div>)
            : (
              <div className="space-y-3 text-[14px]">
                {d.problems.length > 0 && <div className="rounded-md border border-warning-text/40 bg-warning-bg p-3"><p className="font-semibold">Correct these first</p><ul className="ml-5 list-disc">{d.problems.map((p) => <li key={p.field}>{p.message}</li>)}</ul></div>}
                <p className="text-ink-2">{modeNote(d.mode)}</p>
                {d.allowedActions.includes('generate') && <Button loading={busy} icon={<Lightning size={16} />} onClick={() => generate({})}>Generate IRN</Button>}
                {d.allowedActions.includes('record') && <Button icon={<PencilSimple size={16} />} onClick={() => setRecord(true)}>Record IRN from the portal</Button>}
              </div>)}
      {d.history.filter((h) => h.status === 'Cancelled').map((h) => <p key={h.id} className="mt-2 text-[12px] text-ink-2">Cancelled IRN {h.irn.slice(0, 16)}… ({fmtDateTime(h.cancelledAt)})</p>)}
      <Modal open={record} onClose={() => setRecord(false)} title="Record the IRN" description="Copy from the acknowledgement the IRP portal shows after uploading the JSON." width={640}
        footer={<><Button variant="secondary" onClick={() => setRecord(false)}>Cancel</Button><Button loading={busy} onClick={() => generate(f)}>Save</Button></>}>
        <ErrorBanner error={error} />
        <Field label="IRN (64 characters)" htmlFor="ei-irn" required><Input id="ei-irn" className="num" value={f.irn} onChange={(e) => setF({ ...f, irn: e.target.value.trim() })} /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Acknowledgement number" htmlFor="ei-ack" required><Input id="ei-ack" inputMode="numeric" value={f.ackNo} onChange={(e) => setF({ ...f, ackNo: e.target.value.trim() })} /></Field>
          <Field label="Acknowledgement date and time" htmlFor="ei-dt" required><Input id="ei-dt" type="datetime-local" value={f.ackDate} onChange={(e) => setF({ ...f, ackDate: e.target.value })} /></Field>
        </div>
        <Field label="Signed QR code (text)" htmlFor="ei-qr" required><Textarea id="ei-qr" rows={4} value={f.signedQr} onChange={(e) => setF({ ...f, signedQr: e.target.value.trim() })} /></Field>
      </Modal>
      <CancelDialog open={cancel} title={`Cancel the IRN of ${docNo}`} onClose={() => setCancel(false)}
        onConfirm={async (reason, remarks) => { await api(`/gst/einvoice/${kind}/${id}/cancel`, { body: { reason, remarks } }); toast('success', 'IRN cancelled.'); await refresh(); }} />
    </Card>
  );
}

// ---------------------------------------------------------------- e-way bill
interface Ewb { mode: string; required: boolean; threshold: number; problems: Problem[]; payload: unknown; distanceKm: number | null; kmPerDay: number;
  active: { ewbNo: string; ewbDate: string; validUntil: string; distanceKm: number; mode: string } | null; history: { id: string; status: string; ewbNo: string; cancelledAt: string | null }[]; allowedActions: string[] }

export function EwayBillPanel({ shipmentId, docNo }: { shipmentId: string; docNo: string }) {
  const qc = useQueryClient(); const toast = useToast();
  const [km, setKm] = useState('');
  const q = useQuery({ queryKey: ['ewb', shipmentId, km], queryFn: () => api<Ewb>(`/gst/ewaybill/${shipmentId}${Number(km) > 0 ? `?distanceKm=${Number(km)}` : ''}`) });
  const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null); const [cancel, setCancel] = useState(false);
  const [m, setM] = useState({ ewbNo: '', ewbDate: '' });
  if (q.isLoading && !q.data) return <Card title="E-way bill"><Skeleton className="h-20" /></Card>;
  if (!q.data) return <Card title="E-way bill"><ErrorBanner error={q.error} /></Card>;
  const d = q.data;
  const dist = Number(km || d.distanceKm || 0);
  const go = async () => { setBusy(true); setError(null);
    try { const r = await api<{ ewbNo: string; validUntil: string }>(`/gst/ewaybill/${shipmentId}`, { body: { distanceKm: dist, ...(d.mode === 'MANUAL' ? m : {}) } });
      toast('success', `E-way bill ${r.ewbNo}, valid to ${fmtDateTime(r.validUntil)}.`); await qc.invalidateQueries(); } catch (e) { setError(e); } finally { setBusy(false); } };
  if (d.mode === 'OFF') return null;
  return (
    <Card title="E-way bill" actions={d.payload ? <Button size="sm" variant="ghost" icon={<DownloadSimple size={16} />} onClick={() => download(`${docNo.replace(/\//g, '-')}-ewaybill.json`, d.payload)}>JSON</Button> : undefined}>
      <ErrorBanner error={error} />
      {d.active ? (
        <div className="text-[14px]">{d.active.mode === 'SIMULATED' && <StatusBadge status="Pending" label="Simulated — not valid" />}
          <KeyValues columns="narrow" items={[['EWB no.', <b key="n" className="num">{d.active.ewbNo}</b>], ['Generated', fmtDateTime(d.active.ewbDate)], ['Valid until', fmtDateTime(d.active.validUntil)], ['Distance', `${d.active.distanceKm} km`]]} />
          {d.allowedActions.includes('cancel') && <Button className="mt-2" size="sm" variant="secondary" icon={<XCircle size={16} />} onClick={() => setCancel(true)}>Cancel e-way bill</Button>}
        </div>
      ) : !d.allowedActions.length ? <p className="text-[14px] text-ink-2">{d.required ? `Needed above ${d.threshold.toLocaleString('en-IN')}: generated once the shipment is dispatched (the invoice is raised then).` : 'Not required at this value.'}</p> : (
        <div className="space-y-3 text-[14px]">
          {!d.required && <p className="text-ink-2">Not required at this value, but it can be made.</p>}
          <Field label="Distance (km)" htmlFor="ewb-km" required hint={dist ? `Valid for ${Math.max(1, Math.ceil(dist / d.kmPerDay))} day(s)` : undefined}>
            <Input id="ewb-km" type="number" min="1" max="4000" value={km || d.distanceKm || ''} onChange={(e) => setKm(e.target.value)} /></Field>
          {d.problems.filter((p) => p.field !== 'transDistance').length > 0 && <div className="rounded-md border border-warning-text/40 bg-warning-bg p-3"><ul className="ml-5 list-disc">{d.problems.filter((p) => p.field !== 'transDistance').map((p) => <li key={p.field}>{p.message}</li>)}</ul></div>}
          {d.mode === 'MANUAL' && <div className="grid gap-3 md:grid-cols-2">
            <Field label="EWB number from the portal" htmlFor="ewb-no" required><Input id="ewb-no" inputMode="numeric" maxLength={12} value={m.ewbNo} onChange={(e) => setM({ ...m, ewbNo: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="Generated at" htmlFor="ewb-dt" required><Input id="ewb-dt" type="datetime-local" value={m.ewbDate} onChange={(e) => setM({ ...m, ewbDate: e.target.value })} /></Field></div>}
          <p className="text-ink-2">{modeNote(d.mode)}</p>
          <Button loading={busy} disabled={!dist || (d.mode === 'MANUAL' && (!m.ewbNo || !m.ewbDate))} onClick={go}>{d.mode === 'MANUAL' ? 'Record e-way bill' : 'Generate e-way bill'}</Button>
        </div>)}
      <CancelDialog open={cancel} title="Cancel the e-way bill" onClose={() => setCancel(false)}
        onConfirm={async (reason, remarks) => { await api(`/gst/ewaybill/${shipmentId}/cancel`, { body: { reason, remarks } }); toast('success', 'E-way bill cancelled.'); await qc.invalidateQueries(); }} />
    </Card>
  );
}
