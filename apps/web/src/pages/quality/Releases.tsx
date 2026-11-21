import { CheckCircle, XCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, KeyValues, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';

interface ReleaseRow { id: string; lotNo: string; itemCode: string; itemName: string; uom: string; qcStatus: string; qaDisposition: string | null; batchId: string; outputQty: string; yieldPct: string;
  completedAt: string; orderNo: string; inspectionStatus: string | null; openDeviations: number }
interface Review { id: string; lotNo: string; itemCode: string; itemName: string; uom: string; mfgDate: string; expiryDate: string | null; qcStatus: string; qaDisposition: string | null;
  batchId: string; batchNo: string; batchStatus: string; plannedQty: string; outputQty: string; yieldPct: string; standardYieldPct: string; startedBy: string; completedBy: string; startedAt: string;
  completedAt: string; unaccountedQty: string | null; balanceBasis: string | null; operators: string[]; orderId: string; orderNo: string; bomCode: string; bomVersionNo: number;
  inspectionId: string | null; inspectionNo: string | null; inspectionStatus: string | null; testedBy: string | null; qcDecidedBy: string | null; onHand: string;
  results: { parameter: string; specification: string; result: string; pass: boolean }[]; ipqc: { docNo: string; stage: string; status: string }[];
  inputs: { lotId: string; lotNo: string; itemCode: string; uom: string; qty: string; qcStatus: string }[]; deviations: { id: string; docNo: string; category: string; title: string; status: string }[];
  history: { decision: string; remarks: string | null; decidedAt: string; decidedBy: string }[];
  checklist: { qcApproved: boolean; batchRecordComplete: boolean; deviationsClosed: boolean; inputLotsReleased: boolean; independentReleaser: boolean };
  blockers: { code: string; message: string }[]; allowedDecisions: string[] }

const LABEL: Record<string, string> = { Released: 'Release', OnHold: 'Put on hold', Rejected: 'Reject', ReworkAuthorised: 'Authorise rework' };
const DispBadge = ({ d }: { d: string | null }) => (d ? <StatusBadge status={d === 'Released' ? 'Approved' : d === 'Rejected' ? 'Rejected' : 'OnHold'} label={d === 'ReworkAuthorised' ? 'Rework authorised' : d === 'OnHold' ? 'On hold' : d} />
  : <StatusBadge status="Pending" label="Awaiting QA" />);
const n = (v: string | number | null) => Number(v ?? 0);

/** QA batch release queue (QA-003): finished-goods lots waiting for the QA disposition, with what still blocks them. */
export function ReleasesPage() {
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const q = useQuery({ queryKey: ['qa-releases', tab], queryFn: () => api<{ data: ReleaseRow[] }>(`/qa/releases?status=${tab}`) });
  return (
    <>
      <PageHeader title="QA — Batch Release" subtitle="Finished goods become saleable only when the QA head releases them, after QC has approved the results, the batch record is complete and every deviation is closed." />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Awaiting release' }, { value: 'decided', label: 'Decided' }]} /></div>
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title={tab === 'pending' ? 'Nothing waiting for QA' : 'No dispositions yet'} text="Completed batches appear here with their finished-goods lot." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Lot / batch</th><th className="px-3 py-3">Product</th><th className="px-3 py-3 text-right">Output</th><th className="px-3 py-3 text-right">Yield</th>
              <th className="px-3 py-3">QC</th><th className="px-3 py-3">Open deviations</th><th className="px-3 py-3">QA</th></tr></thead>
            <tbody>{q.data.data.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/qa/releases/${r.id}`}>{r.lotNo}</Link><span className="block text-[12px] text-ink-2">{r.orderNo} · {fmtDateTime(r.completedAt)}</span></td>
                <td className="px-3 py-3">{r.itemCode} <span className="text-ink-2">{r.itemName}</span></td><td className="px-3 py-3 text-right num">{fmtNum(n(r.outputQty))} {r.uom}</td>
                <td className="px-3 py-3 text-right num">{fmtNum(n(r.yieldPct))}%</td>
                <td className="px-3 py-3">{r.inspectionStatus === 'QcApproved' || r.inspectionStatus === 'Released' ? <StatusBadge status="Approved" label="Approved" /> : <StatusBadge status="Pending" label={r.inspectionStatus ?? '—'} />}</td>
                <td className="px-3 py-3">{r.openDeviations ? <StatusBadge status="Rejected" label={`${r.openDeviations} open`} /> : '—'}</td><td className="px-3 py-3"><DispBadge d={r.qaDisposition} /></td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

const Check = ({ ok, label }: { ok: boolean; label: string }) => (
  <li className="flex items-center gap-2 text-[14px]">{ok ? <CheckCircle size={18} weight="fill" className="text-success-text" aria-label="done" /> : <XCircle size={18} weight="fill" className="text-danger-text" aria-label="not done" />}{label}</li>);

export function ReleaseReviewPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['qa-release', id], queryFn: () => api<Review>(`/qa/releases/${id}`) });
  const [f, setF] = useState({ decision: '', remarks: '', bmrReviewed: false });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const r = q.data;
  if (!r) return <ErrorBanner error={q.error} />;
  const c = r.checklist;
  const save = async () => {
    setBusy(true); setError(null);
    try { const x = await api<{ lotNo: string; decision: string }>(`/qa/releases/${id}/disposition`, { body: f }); toast('success', `${x.lotNo}: ${LABEL[x.decision]?.toLowerCase() ?? x.decision} recorded.`);
      setF({ decision: '', remarks: '', bmrReviewed: false }); await qc.invalidateQueries(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={`Batch review — ${r.lotNo}`} crumbs={<Link to="/qa/releases" className="hover:text-primary">QA — Batch Release</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><DispBadge d={r.qaDisposition} /><span>{r.itemCode} — {r.itemName} · {fmtNum(n(r.onHand))} {r.uom} on hand</span></span>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Card title="Batch record">
            <KeyValues items={[['Batch', <Link key="b" className="text-primary" to={`/production/batches/${r.batchId}`}>{r.batchNo}</Link>], ['Production order', <Link key="o" className="text-primary" to={`/production/orders/${r.orderId}`}>{r.orderNo}</Link>],
              ['Formulation', `${r.bomCode} v${r.bomVersionNo}`], ['Run by', `${r.startedBy}${r.completedBy && r.completedBy !== r.startedBy ? `, completed by ${r.completedBy}` : ''} · ${r.operators.join(', ')}`],
              ['Started → completed', `${fmtDateTime(r.startedAt)} → ${fmtDateTime(r.completedAt)}`], ['Output and yield', `${fmtNum(n(r.outputQty))} ${r.uom} · ${fmtNum(n(r.yieldPct))}% (standard ${fmtNum(n(r.standardYieldPct))}%)`],
              ['Mass balance', r.balanceBasis ? `${fmtNum(n(r.unaccountedQty))} ${r.balanceBasis} unaccounted` : 'Not computed'], ['Manufactured / expiry', `${fmtDate(r.mfgDate)} / ${fmtDate(r.expiryDate)}`],
              ['In-process QC', r.ipqc.map((t) => `${t.docNo} ${t.status}`).join(' · ') || '—']]} />
          </Card>
          <Card title="Input lots" padded={false}>
            <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Lot</th><th className="px-3 py-3">Item</th><th className="px-3 py-3 text-right">Used</th><th className="px-3 py-3">QC</th></tr></thead>
              <tbody>{r.inputs.map((x) => <tr key={x.lotId} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="text-primary" to={`/stores/lots/${x.lotId}`}>{x.lotNo}</Link></td>
                <td className="px-3 py-3">{x.itemCode}</td><td className="px-3 py-3 text-right num">{fmtNum(n(x.qty))} {x.uom}</td>
                <td className="px-3 py-3"><StatusBadge status={x.qcStatus === 'Released' ? 'Approved' : 'Pending'} label={x.qcStatus} /></td></tr>)}</tbody></table></div>
          </Card>
          <Card title="QC results">
            {!r.results.length ? <p className="text-ink-2">{r.inspectionId ? <>No results yet on <Link className="text-primary" to={`/qc/inspections/${r.inspectionId}`}>{r.inspectionNo}</Link>.</> : 'No inspection.'}</p> : (
              <>
                <p className="mb-3 text-[14px]"><Link className="text-primary" to={`/qc/inspections/${r.inspectionId}`}>{r.inspectionNo}</Link> · tested by {r.testedBy}{r.qcDecidedBy ? ` · approved by ${r.qcDecidedBy}` : ''}</p>
                <ul className="space-y-1">{r.results.map((x) => <li key={x.parameter} className="text-[14px]">{x.pass ? '✓' : '✗'} {x.parameter}: <span className="num">{x.result}</span> <span className="text-ink-2">(spec {x.specification})</span></li>)}</ul>
              </>
            )}
          </Card>
          <Card title="Deviations">
            {!r.deviations.length ? <p className="text-ink-2">None raised for this batch.</p> : <ul className="space-y-2">{r.deviations.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 text-[14px]"><span><Link className="text-primary" to={`/qa/deviations/${d.id}`}>{d.docNo}</Link> {d.title}</span>
                <StatusBadge status={d.status === 'Open' ? 'Pending' : 'Closed'} label={d.status} /></li>))}</ul>}
          </Card>
        </div>
        <aside className="space-y-6">
          <Card title="Release checklist">
            <ul className="space-y-2">
              <Check ok={c.qcApproved} label="QC results approved" /><Check ok={c.batchRecordComplete} label="Batch completed, in-process QC passed" />
              <Check ok={c.deviationsClosed} label="Every deviation closed" /><Check ok={c.inputLotsReleased} label="Every input lot released by QC" />
              <Check ok={c.independentReleaser} label="You did not run this batch" />
            </ul>
            {r.blockers.length > 0 && <div className="mt-4 rounded-md bg-danger-bg px-4 py-3 text-[14px] text-danger-text"><p className="mb-1 font-semibold">Release is blocked</p><ul className="list-disc pl-5">{r.blockers.map((b) => <li key={b.message}>{b.message}</li>)}</ul></div>}
          </Card>
          {r.allowedDecisions.length > 0 && (
            <Card title="Disposition">
              <ErrorBanner error={error} />
              <div className="space-y-4">
                <Field label="Decision" htmlFor="qa-dec" required><Select id="qa-dec" value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
                  <option value="">Select…</option>{r.allowedDecisions.map((d) => <option key={d} value={d}>{LABEL[d]}</option>)}</Select></Field>
                {f.decision === 'Released' && <label className="flex items-start gap-2 text-[14px]"><input type="checkbox" className="mt-1" checked={f.bmrReviewed} onChange={(e) => setF({ ...f, bmrReviewed: e.target.checked })} />
                  I have reviewed the batch record (dosing, readings, in-process QC and yield) and the QC results.</label>}
                <Field label={f.decision === 'Released' ? 'Remarks' : 'Reason'} htmlFor="qa-rem" required={!!f.decision && f.decision !== 'Released'}><Textarea id="qa-rem" rows={3} maxLength={1000} value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
                <Button className="w-full" variant={f.decision === 'Rejected' ? 'danger' : 'primary'} loading={busy}
                  disabled={!f.decision || (f.decision === 'Released' ? !f.bmrReviewed : !f.remarks.trim())} onClick={save}>{f.decision ? LABEL[f.decision] : 'Record decision'}</Button>
              </div>
            </Card>
          )}
          {r.history.length > 0 && <Card title="History"><ul className="space-y-2">{r.history.map((h) => <li key={h.decidedAt} className="text-[14px]"><span className="font-semibold">{LABEL[h.decision] ?? h.decision}</span> by {h.decidedBy}, {fmtDateTime(h.decidedAt)}{h.remarks ? ` — ${h.remarks}` : ''}</li>)}</ul></Card>}
        </aside>
      </div>
    </>
  );
}
