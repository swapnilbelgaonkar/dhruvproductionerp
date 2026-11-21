import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { CostSheetCard } from './Packing';

interface BatchRow { id: string; batchNo: string; productionOrderId: string; orderNo: string; itemCode: string; itemName: string; seq: number; batchCount: number; plannedQty: string; uom: string;
  lineCode: string; shiftCode: string | null; operators: string[]; status: string; startedAt: string; outputQty: string | null; yieldPct: string | null; fgLotNo: string | null }
interface Mat { id: string; stepNo: number; itemId: string; itemCode: string; itemName: string; uom: string; tolerancePct: string; planned: number; dosed: number; variancePct: number; low: number; high: number;
  state: 'Pending' | 'Within' | 'Over' | 'Under'; awaitingApproval: boolean }
interface HeldLot { lotId: string; lotNo: string; lotStatus: string; itemId: string; itemCode: string; uom: string; factor: number; available: number }
interface BatchDetail extends BatchRow { orderStatus: string; itemId: string; lineName: string; startedBy: string; completedAt: string | null; completedBy: string | null; statusReason: string | null;
  processLossQty: string | null; recoveredQty: string | null; wasteQty: string | null; balanceBasis: string | null; inputBasisQty: string | null; unaccountedQty: string | null;
  materialCost: string | null; fgLotId: string | null; fgLotStatus: string | null; completionRemarks: string | null; standardYieldPct: string | null; reactionTempC: string | null;
  reactionTimeMin: number | null; processNotes: string | null; materials: Mat[]; lots: Record<string, HeldLot[]>; allowedActions: string[];
  consumptions: { id: string; orderMaterialId: string; lotNo: string; lotId: string; itemCode: string; uom: string; qty: string; factor: string; status: string; deviationNo: string | null; deviationId: string | null; dosedBy: string; dosedAt: string; approvalId: string | null }[];
  readings: { id: string; parameter: string; value: string; unit: string | null; inLimits: boolean | null; remarks: string | null; recordedAt: string; recordedBy: string }[];
  ipqc: { id: string; docNo: string; stage: string; status: string; requestedAt: string; requestedBy: string; testedAt: string | null; testedBy: string | null; remarks: string | null; deviationNo: string | null;
    results: { parameter: string; specification: string; result: string; pass: boolean }[] }[];
  deviations: { id: string; docNo: string; category: string; title: string; status: string }[] }

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const BatchStatus = ({ s }: { s: string }) => <StatusBadge status={s === 'InProgress' ? 'Pending' : s === 'Completed' ? 'Approved' : s === 'Scrapped' ? 'Rejected' : s} label={s === 'InProgress' ? 'In progress' : s === 'OnHold' ? 'On hold' : s} />;
const DoseState = ({ m }: { m: Mat }) => (m.awaitingApproval ? <StatusBadge status="Pending" label="Deviation awaiting approval" />
  : m.state === 'Pending' ? <StatusBadge status="Draft" label="Not dosed" /> : m.state === 'Within' ? <StatusBadge status="Approved" label="Within tolerance" />
  : <StatusBadge status="Rejected" label={m.state === 'Over' ? 'Over tolerance' : 'Under tolerance'} />);

const columns: Column<BatchRow>[] = [
  { key: 'no', header: 'Batch', render: (r) => <span className="font-semibold num">{r.batchNo}</span> },
  { key: 'item', header: 'Product', render: (r) => <span><span className="block">{r.itemCode}</span><span className="text-[13px] text-ink-2">{r.itemName}</span></span> },
  { key: 'order', header: 'Order', render: (r) => <span className="num">{r.orderNo} · {r.seq}/{r.batchCount}</span> },
  { key: 'line', header: 'Line / shift', render: (r) => `${r.lineCode}${r.shiftCode ? ` · ${r.shiftCode}` : ''}` },
  { key: 'qty', header: 'Planned → output', className: 'text-right', render: (r) => <span className="num">{fmtNum(n(r.plannedQty))}{r.outputQty ? ` → ${fmtNum(n(r.outputQty))}` : ''} {r.uom}</span> },
  { key: 'yield', header: 'Yield', className: 'text-right', render: (r) => (r.yieldPct ? <span className="num">{fmtNum(n(r.yieldPct))}%</span> : '—') },
  { key: 'started', header: 'Started', render: (r) => <span className="num">{fmtDateTime(r.startedAt)}</span> },
  { key: 'status', header: 'Status', render: (r) => <BatchStatus s={r.status} /> },
];

export function BatchesPage() {
  return (
    <>
      <PageHeader title="Batches" subtitle="Every batch on the shop floor: dosing against the formulation tolerance, process readings, in-process QC, and completion with yield and mass balance." />
      <DataTable<BatchRow> queryKey="batches" path="/batches" columns={columns} rowHref={(r) => `/production/batches/${r.id}`} statusOptions={['InProgress', 'OnHold', 'Completed', 'Scrapped']}
        searchPlaceholder="Search batch, order or product" empty={{ title: 'No batches yet', text: 'Batches are started from a released production order once its material is issued.' }} />
    </>
  );
}

/** Start the next batch of an order: who is running it and on which shift. */
export function StartBatchDialog({ orderId, shifts, defaultShiftId, onClose }: { orderId: string; shifts: { id: string; code: string; name: string }[]; defaultShiftId: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [shiftId, setShiftId] = useState(defaultShiftId ?? '');
  const [operators, setOperators] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const list = operators.split(',').map((x) => x.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await api<{ id: string; batchNo: string }>('/batches', { body: { productionOrderId: orderId, shiftId: shiftId || null, operators: list } }); toast('success', `Batch ${r.batchNo} started.`); nav(`/production/batches/${r.id}`); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Start the next batch" description="The batch number is also the number of the finished-goods lot it makes."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!list.length} onClick={save}>Start batch</Button></>}>
      <ErrorBanner error={error} />
      <div className="space-y-4">
        <Field label="Shift" htmlFor="bt-shift"><Select id="bt-shift" value={shiftId} onChange={(e) => setShiftId(e.target.value)}><option value="">—</option>
          {shifts.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}</Select></Field>
        <Field label="Operators" htmlFor="bt-ops" required hint="Names separated by commas"><Input id="bt-ops" value={operators} onChange={(e) => setOperators(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function BatchDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['batch', id], queryFn: () => api<BatchDetail>(`/batches/${id}`) });
  const [dose, setDose] = useState<Mat | null>(null);
  const [dialog, setDialog] = useState<null | 'reading' | 'ipqc' | 'complete' | 'hold' | 'resume' | 'scrap'>(null);
  const refresh = () => qc.invalidateQueries();
  if (q.isLoading) return <Skeleton className="h-96" />;
  const b = q.data;
  if (!b) return <ErrorBanner error={q.error} />;
  const a = b.allowedActions;
  const lastIpqc = b.ipqc[b.ipqc.length - 1];
  return (
    <>
      <PageHeader title={`Batch ${b.batchNo}`} crumbs={<><Link to="/production/batches" className="hover:text-primary">Batches</Link> / <Link to={`/production/orders/${b.productionOrderId}`} className="hover:text-primary">{b.orderNo}</Link></>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><BatchStatus s={b.status} /><span>{b.itemCode} — {b.itemName} · batch {b.seq} of {b.batchCount} · {fmtNum(n(b.plannedQty))} {b.uom} planned</span></span>}
        actions={<>
          {a.includes('scrap') && <Button variant="danger" onClick={() => setDialog('scrap')}>Scrap batch</Button>}
          {a.includes('hold') && <Button variant="secondary" onClick={() => setDialog('hold')}>Hold</Button>}
          {a.includes('resume') && <Button variant="secondary" onClick={() => setDialog('resume')}>Resume</Button>}
          {a.includes('reading') && <Button variant="secondary" onClick={() => setDialog('reading')}>Record reading</Button>}
          {a.includes('ipqc') && <Button variant="secondary" onClick={() => setDialog('ipqc')}>Ask QC to test</Button>}
          {a.includes('complete') && <Button onClick={() => setDialog('complete')}>Complete batch</Button>}
          {b.status === 'Completed' && b.fgLotId && b.fgLotStatus !== 'Rejected' && can('mfg.packing:post') && <Button onClick={() => nav(`/production/packing?lotId=${b.fgLotId}`)}>Pack this lot</Button>}
        </>} />
      {b.statusReason && ['OnHold', 'Scrapped'].includes(b.status) && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">{b.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Process">
          <KeyValues items={[['Line', `${b.lineCode} — ${b.lineName}`], ['Shift', b.shiftCode ?? '—'], ['Operators', b.operators.join(', ')], ['Started', `${b.startedBy}, ${fmtDateTime(b.startedAt)}`],
            ['Standard', `${b.reactionTempC ? `${fmtNum(n(b.reactionTempC))} °C` : '—'} · ${b.reactionTimeMin ? `${b.reactionTimeMin} min` : '—'} · yield ${fmtNum(n(b.standardYieldPct))}%`],
            ['Instructions', b.processNotes ? <span className="whitespace-pre-line">{b.processNotes}</span> : '—']]} />
        </Card>
        <Card title="In-process QC">
          {!b.ipqc.length ? <p className="text-ink-2">Not requested yet. The batch cannot be completed before QC passes it.</p> : (
            <ul className="space-y-3">{b.ipqc.map((t) => (
              <li key={t.id} className="text-[14px]"><p className="flex flex-wrap items-center gap-2"><span className="font-semibold num">{t.docNo}</span>
                <StatusBadge status={t.status === 'Passed' ? 'Approved' : t.status === 'Failed' ? 'Rejected' : 'Pending'} label={t.status} /></p>
                <p className="text-ink-2">{t.stage} · asked by {t.requestedBy}{t.testedBy ? ` · tested by ${t.testedBy}` : ''}</p>
                {t.results.length > 0 && <p>{t.results.map((x) => `${x.parameter} ${x.result}${x.pass ? '' : ' ✗'}`).join(' · ')}</p>}
                {t.deviationNo && <p className="text-danger-text">Deviation {t.deviationNo}</p>}</li>))}</ul>
          )}
          {lastIpqc?.status === 'Failed' && b.status === 'InProgress' && <p className="mt-3 text-[13px] text-warning-text">Correct the batch, then ask QC to test again.</p>}
        </Card>
      </div>
      <Card title="Dosing" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">Step</th><th className="px-3 py-3">Ingredient</th><th className="px-3 py-3 text-right">Planned</th><th className="px-3 py-3 text-right">Allowed</th>
            <th className="px-3 py-3 text-right">Dosed</th><th className="px-3 py-3 text-right">Variance</th><th className="px-3 py-3">State</th><th className="px-3 py-3" /></tr></thead>
          <tbody>{b.materials.map((m) => (
            <tr key={m.id} className="border-b border-line last:border-0">
              <td className="px-5 py-3 num">{m.stepNo}</td><td className="px-3 py-3"><span className="font-semibold">{m.itemCode}</span> <span className="text-ink-2">{m.itemName}</span></td>
              <td className="px-3 py-3 text-right num">{fmtNum(m.planned)} {m.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(m.low)}–{fmtNum(m.high)}</td>
              <td className="px-3 py-3 text-right num">{m.dosed ? fmtNum(m.dosed) : '—'}</td><td className="px-3 py-3 text-right num">{m.dosed ? `${m.variancePct > 0 ? '+' : ''}${fmtNum(m.variancePct)}%` : '—'}</td>
              <td className="px-3 py-3"><DoseState m={m} /></td>
              <td className="px-3 py-3 text-right">{a.includes('dose') && <Button size="sm" variant={m.state === 'Pending' ? 'primary' : 'secondary'} onClick={() => setDose(m)}>{m.state === 'Pending' ? 'Dose' : 'Top up'}</Button>}</td>
            </tr>))}</tbody>
        </table></div>
        {b.consumptions.length > 0 && <div className="border-t border-line px-5 py-4 text-[14px]"><p className="mb-2 font-semibold">Lots dosed</p>
          <ul className="space-y-1">{b.consumptions.map((c) => <li key={c.id}><Link className="text-primary" to={`/stores/lots/${c.lotId}`}>{c.lotNo}</Link> {c.itemCode} {fmtNum(n(c.qty))} {c.uom}
            {n(c.factor) !== 1 && ` (substitute × ${fmtNum(n(c.factor))})`} · {c.dosedBy}, {fmtDateTime(c.dosedAt)}
            {c.deviationNo && <> · <Link className="text-primary" to={`/qa/deviations/${c.deviationId}`}>{c.deviationNo}</Link> <StatusBadge status={c.status === 'PendingApproval' ? 'Pending' : c.status} label={c.status === 'PendingApproval' ? 'Awaiting approval' : c.status} /></>}</li>)}</ul></div>}
      </Card>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="Process readings">
          {!b.readings.length ? <p className="text-ink-2">None recorded.</p> : <ul className="space-y-2">{b.readings.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 text-[14px]"><span className="font-semibold">{r.parameter}</span><span className="num">{r.value} {r.unit}</span>
              {r.inLimits === false && <StatusBadge status="Rejected" label="Out of limits" />}<span className="text-ink-2">{r.recordedBy}, {fmtDateTime(r.recordedAt)}{r.remarks ? ` · ${r.remarks}` : ''}</span></li>))}</ul>}
        </Card>
        <Card title={b.status === 'Completed' ? 'Completion' : 'Deviations'}>
          {b.status === 'Completed' ? (
            <KeyValues items={[['Output', `${fmtNum(n(b.outputQty))} ${b.uom} · yield ${fmtNum(n(b.yieldPct))}% (standard ${fmtNum(n(b.standardYieldPct))}%)`],
              ['Losses', `process ${fmtNum(n(b.processLossQty))} · recovered ${fmtNum(n(b.recoveredQty))} · waste ${fmtNum(n(b.wasteQty))} ${b.uom}`],
              ['Mass balance', b.balanceBasis ? `${fmtNum(n(b.inputBasisQty))} ${b.balanceBasis} in · ${fmtNum(n(b.unaccountedQty))} ${b.balanceBasis} unaccounted` : 'Not computed — a unit conversion is missing'],
              ['Material cost', `${fmtINR(b.materialCost)} · ${fmtINR(n(b.materialCost) / n(b.outputQty))} per ${b.uom}`],
              ['Finished-goods lot', b.fgLotId ? <span><Link className="text-primary" to={`/stores/lots/${b.fgLotId}`}>{b.fgLotNo}</Link> · {b.fgLotStatus === 'Quarantine' ? 'in quarantine, waiting for QC and QA' : b.fgLotStatus}</span> : '—'],
              ['Completed', `${b.completedBy}, ${fmtDateTime(b.completedAt)}`], ['Remarks', b.completionRemarks ?? '—']]} />
          ) : null}
          {b.deviations.length > 0 ? <ul className={b.status === 'Completed' ? 'mt-4 space-y-2 border-t border-line pt-4' : 'space-y-2'}>{b.deviations.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 text-[14px]"><span><Link className="text-primary" to={`/qa/deviations/${d.id}`}>{d.docNo}</Link> {d.title}</span>
              <StatusBadge status={d.status === 'Open' ? 'Pending' : 'Closed'} label={d.status} /></li>))}</ul>
            : b.status !== 'Completed' && <p className="text-ink-2">None.</p>}
        </Card>
      </div>
      {b.status === 'Completed' && <CostSheetCard batchId={b.id} />}
      {dose && <DoseDialog b={b} m={dose} onClose={() => setDose(null)} />}
      {dialog === 'reading' && <ReadingDialog id={b.id} onClose={() => setDialog(null)} />}
      {dialog === 'ipqc' && <IpqcRequestDialog id={b.id} onClose={() => setDialog(null)} />}
      {dialog === 'complete' && <CompleteDialog b={b} onClose={() => setDialog(null)} />}
      <ReasonDialog open={dialog === 'hold' || dialog === 'resume'} title={dialog === 'hold' ? `Hold batch ${b.batchNo}` : `Resume batch ${b.batchNo}`} confirmLabel={dialog === 'hold' ? 'Hold' : 'Resume'}
        onClose={() => setDialog(null)} onConfirm={async (reason) => { await api(`/batches/${b.id}/${dialog}`, { body: { reason } }); toast('success', dialog === 'hold' ? 'Batch on hold.' : 'Batch resumed.'); await refresh(); }} />
      <ReasonDialog open={dialog === 'scrap'} danger title={`Scrap batch ${b.batchNo}`} confirmLabel="Scrap batch" description="The material dosed is lost and a deviation is raised. The order can then start another batch."
        onClose={() => setDialog(null)} onConfirm={async (reason) => { await api(`/batches/${b.id}/scrap`, { body: { reason } }); toast('success', 'Batch scrapped.'); await refresh(); }} />
    </>
  );
}

function DoseDialog({ b, m, onClose }: { b: BatchDetail; m: Mat; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lots = b.lots[m.id] ?? [];
  const [qty, setQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const adding = lots.reduce((s, l) => s + (Number(qty[l.lotId]) || 0) / l.factor, 0);
  const total = Math.round((m.dosed + adding) * 10000) / 10000;
  const over = total > m.high + 1e-9;
  const entries = lots.filter((l) => Number(qty[l.lotId]) > 0).map((l) => ({ lotId: l.lotId, qty: Number(qty[l.lotId]) }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ state: string; deviationNo: string | null; approvalDocNo: string | null }>(`/batches/${b.id}/dosing`, { body: { orderMaterialId: m.id, entries, deviationReason: over ? reason : null } });
      toast('success', r.deviationNo ? `Dosed with deviation ${r.deviationNo}, sent for approval as ${r.approvalDocNo}.` : 'Dose recorded.'); await qc.invalidateQueries(); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Dose ${m.itemCode}`} width={680} description={`Planned ${fmtNum(m.planned)} ${m.uom}, allowed ${fmtNum(m.low)}–${fmtNum(m.high)} (±${fmtNum(n(m.tolerancePct))}%). Already dosed: ${fmtNum(m.dosed)}.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={over ? 'danger' : 'primary'} loading={busy} disabled={!entries.length || (over && !reason.trim())} onClick={save}>{over ? 'Dose with deviation' : 'Record dose'}</Button></>}>
      <ErrorBanner error={error instanceof ApiError && error.code === 'TOLERANCE_EXCEEDED' ? null : error} />
      {!lots.length ? <EmptyState title="Nothing issued for this ingredient" text="Ask stores to issue the lot to the production order first." /> : (
        <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
          <th className="py-2">Lot (issued to the order)</th><th className="py-2 text-right">With production</th><th className="w-40 py-2 pl-3">Weighed now</th></tr></thead>
          <tbody>{lots.map((l) => (
            <tr key={l.lotId} className="border-b border-line last:border-0">
              <td className="py-2"><span className="font-semibold">{l.lotNo}</span> {l.itemCode}{l.factor !== 1 && <span className="block text-[12px] text-ink-2">Substitute × {fmtNum(l.factor)}</span>}</td>
              <td className="py-2 text-right num">{fmtNum(l.available)} {l.uom}</td>
              <td className="py-2 pl-3"><Input aria-label={`Dose from lot ${l.lotNo}`} type="number" min="0" step="any" value={qty[l.lotId] ?? ''} onChange={(e) => setQty({ ...qty, [l.lotId]: e.target.value })} /></td>
            </tr>))}</tbody></table>
      )}
      <p className={`mt-4 rounded-md px-4 py-3 ${over ? 'bg-danger-bg text-danger-text' : 'bg-neutral-bg text-neutral-text'}`}>
        Total after this dose: <span className="font-semibold num">{fmtNum(total)} {m.uom}</span> ({m.planned ? `${total >= m.planned ? '+' : ''}${fmtNum(Math.round((total - m.planned) / m.planned * 100000) / 1000)}%` : '—'}).
        {over && ' This is beyond the tolerance. Reduce the dose, or give the reason: a deviation is raised and production and QA must approve before the batch can be completed.'}</p>
      {over && <div className="mt-4"><Field label="Reason for dosing beyond tolerance" htmlFor="dose-reason" required><Textarea id="dose-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>}
    </Modal>
  );
}

function ReadingDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ parameter: '', value: '', unit: '', inLimits: 'yes', remarks: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { await api(`/batches/${id}/readings`, { body: { parameter: f.parameter, value: f.value, unit: f.unit || null, inLimits: f.inLimits === '' ? null : f.inLimits === 'yes', remarks: f.remarks || null } });
      toast('success', 'Reading recorded.'); await qc.invalidateQueries(); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Record a process reading" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.parameter || !f.value} onClick={save}>Record</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Parameter" htmlFor="rd-param" required hint="For example reaction temperature, pH, agitator speed"><Input id="rd-param" value={f.parameter} onChange={(e) => setF({ ...f, parameter: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="Value" htmlFor="rd-val" required><Input id="rd-val" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
          <Field label="Unit" htmlFor="rd-unit"><Input id="rd-unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field></div>
        <Field label="Within the process limits?" htmlFor="rd-ok"><Select id="rd-ok" value={f.inLimits} onChange={(e) => setF({ ...f, inLimits: e.target.value })}>
          <option value="yes">Yes</option><option value="no">No</option><option value="">Not applicable</option></Select></Field>
        <Field label="Remarks" htmlFor="rd-rem"><Input id="rd-rem" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function IpqcRequestDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [stage, setStage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await api<{ docNo: string }>(`/batches/${id}/ipqc`, { body: { stage } }); toast('success', `${r.docNo} sent to QC.`); await qc.invalidateQueries(); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Ask QC for an in-process test" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!stage.trim()} onClick={save}>Send to QC</Button></>}>
      <ErrorBanner error={error} />
      <Field label="Stage" htmlFor="ipqc-stage" required hint="For example: after reaction, after pH adjustment, before filling"><Input id="ipqc-stage" value={stage} onChange={(e) => setStage(e.target.value)} /></Field>
    </Modal>
  );
}

function CompleteDialog({ b, onClose }: { b: BatchDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ outputQty: '', processLossQty: '0', recoveredQty: '0', wasteQty: '0', remarks: '', underDoseReason: '', balanceReason: '' });
  const [need, setNeed] = useState<{ under?: string; balance?: string }>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ fgLotNo: string; inspectionNo: string; yieldPct: number; orderCompleted: boolean }>(`/batches/${b.id}/complete`, { body: {
        outputQty: Number(f.outputQty), processLossQty: Number(f.processLossQty) || 0, recoveredQty: Number(f.recoveredQty) || 0, wasteQty: Number(f.wasteQty) || 0,
        remarks: f.remarks || null, underDoseReason: f.underDoseReason || null, balanceReason: f.balanceReason || null } });
      toast('success', `Completed at ${fmtNum(r.yieldPct)}% yield. Lot ${r.fgLotNo} is in quarantine and ${r.inspectionNo} is with QC.${r.orderCompleted ? ' The order is complete.' : ''}`);
      await qc.invalidateQueries(); onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'UNDER_DOSED') setNeed((x) => ({ ...x, under: e.message }));
      else if (e instanceof ApiError && e.code === 'MASS_BALANCE_GAP') setNeed((x) => ({ ...x, balance: e.message }));
      else setError(e);
    } finally { setBusy(false); }
  };
  const num = (key: 'outputQty' | 'processLossQty' | 'recoveredQty' | 'wasteQty', label: string, required = false) => (
    <Field label={`${label} (${b.uom})`} htmlFor={`cp-${key}`} required={required}><Input id={`cp-${key}`} type="number" min="0" step="any" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} /></Field>);
  return (
    <Modal open onClose={onClose} title={`Complete batch ${b.batchNo}`} width={680} description="Input = output + process loss + recovered + waste. The finished-goods lot goes into quarantine for QC and QA."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!(Number(f.outputQty) > 0) || (!!need.under && !f.underDoseReason.trim()) || (!!need.balance && !f.balanceReason.trim())} onClick={save}>Complete batch</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        {num('outputQty', 'Output', true)}{num('processLossQty', 'Process loss')}{num('recoveredQty', 'Recovered scrap')}{num('wasteQty', 'Waste')}
        <div className="md:col-span-2"><Field label="Remarks" htmlFor="cp-rem"><Input id="cp-rem" maxLength={1000} value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field></div>
        {Number(f.outputQty) > 0 && <p className="md:col-span-2 text-ink-2">Yield {fmtNum(Math.round(Number(f.outputQty) / n(b.plannedQty) * 100000) / 1000)}% against the standard {fmtNum(n(b.standardYieldPct))}%.</p>}
        {need.under && <div className="md:col-span-2"><p className="mb-2 rounded-md bg-warning-bg px-4 py-3 text-warning-text">{need.under}</p>
          <Field label="Reason for completing under-dosed" htmlFor="cp-under" required><Textarea id="cp-under" rows={2} value={f.underDoseReason} onChange={(e) => setF({ ...f, underDoseReason: e.target.value })} /></Field></div>}
        {need.balance && <div className="md:col-span-2"><p className="mb-2 rounded-md bg-warning-bg px-4 py-3 text-warning-text">{need.balance}</p>
          <Field label="Reason for the mass balance gap" htmlFor="cp-balance" required><Textarea id="cp-balance" rows={2} value={f.balanceReason} onChange={(e) => setF({ ...f, balanceReason: e.target.value })} /></Field></div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- QC worklist for in-process tests
interface IpqcRow { id: string; docNo: string; stage: string; status: string; requestedAt: string; requestedBy: string; batchId: string; batchNo: string; itemCode: string; itemName: string; orderNo: string }

export function IpqcWorklistPage() {
  const [status, setStatus] = useState('Pending');
  const q = useQuery({ queryKey: ['ipqc', status], queryFn: () => api<{ data: IpqcRow[] }>(`/batches/ipqc?status=${status}`) });
  const [open, setOpen] = useState<IpqcRow | null>(null);
  return (
    <>
      <PageHeader title="QC — In-process" subtitle="Tests production asks for during a batch: pH, viscosity, reaction completion, assay. A failed test raises a deviation and stops the batch from completing." />
      <div className="mb-4 w-56"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="Pending">Waiting for QC</option><option value="Passed">Passed</option><option value="Failed">Failed</option></Select></div>
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="Nothing here" text={status === 'Pending' ? 'No batch is waiting for an in-process test.' : 'No tests with this result yet.'} /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Test</th><th className="px-3 py-3">Batch</th><th className="px-3 py-3">Product</th><th className="px-3 py-3">Stage</th><th className="px-3 py-3">Asked</th><th className="px-3 py-3" /></tr></thead>
            <tbody>{q.data.data.map((t) => (
              <tr key={t.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3 font-semibold num">{t.docNo}</td><td className="px-3 py-3"><Link className="text-primary" to={`/production/batches/${t.batchId}`}>{t.batchNo}</Link> · {t.orderNo}</td>
                <td className="px-3 py-3">{t.itemCode} <span className="text-ink-2">{t.itemName}</span></td><td className="px-3 py-3">{t.stage}</td>
                <td className="px-3 py-3">{t.requestedBy}, {fmtDateTime(t.requestedAt)}</td>
                <td className="px-3 py-3 text-right">{t.status === 'Pending' && <Button size="sm" onClick={() => setOpen(t)}>Record results</Button>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
      {open && <IpqcResultsDialog t={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function IpqcResultsDialog({ t, onClose }: { t: IpqcRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [rows, setRows] = useState([{ parameter: '', specification: '', result: '', pass: 'yes' }]);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const valid = rows.every((r) => r.parameter && r.specification && r.result);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ status: string; deviationNo: string | null }>(`/batches/ipqc/${t.id}/results`, { body: { results: rows.map((x) => ({ ...x, pass: x.pass === 'yes' })), remarks: remarks || null } });
      toast(r.status === 'Passed' ? 'success' : 'error', r.status === 'Passed' ? `${t.docNo} passed.` : `${t.docNo} failed; deviation ${r.deviationNo} raised.`); await qc.invalidateQueries(); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Results for ${t.docNo}`} description={`Batch ${t.batchNo}, ${t.stage}.`} width={760}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!valid} onClick={save}>Save results</Button></>}>
      <ErrorBanner error={error} />
      {rows.map((r, i) => (
        <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_1fr_110px] gap-2">
          <Input aria-label={`Parameter ${i + 1}`} placeholder="Parameter" value={r.parameter} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, parameter: e.target.value } : x)))} />
          <Input aria-label={`Specification ${i + 1}`} placeholder="Specification" value={r.specification} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, specification: e.target.value } : x)))} />
          <Input aria-label={`Result ${i + 1}`} placeholder="Result" value={r.result} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, result: e.target.value } : x)))} />
          <Select aria-label={`Pass ${i + 1}`} value={r.pass} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pass: e.target.value } : x)))}><option value="yes">Pass</option><option value="no">Fail</option></Select>
        </div>))}
      <Button size="sm" variant="secondary" disabled={rows.length >= 30} onClick={() => setRows([...rows, { parameter: '', specification: '', result: '', pass: 'yes' }])}>Add test</Button>
      <div className="mt-4"><Field label="Remarks" htmlFor="ipqc-rem"><Input id="ipqc-rem" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>
    </Modal>
  );
}
