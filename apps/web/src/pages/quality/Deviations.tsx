import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, KeyValues, Modal, PageHeader, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDateTime, humanize } from '../../lib/format';

interface DevRow { id: string; docNo: string; category: string; title: string; description: string; status: string; productionOrderId: string | null; productionOrderNo: string | null;
  lotId: string | null; lotNo: string | null; lotStatus: string | null; itemCode: string | null; raisedBy: string | null; createdAt: string; closureNote: string | null; closedBy: string | null; closedAt: string | null }
interface DevDetail extends DevRow { waitingForQc: boolean; allowedActions: string[] }

const CATEGORY: Record<string, string> = { QUARANTINE_OVERRIDE: 'Quarantine override', DOSING_TOLERANCE: 'Dosing outside tolerance', IPQC_FAILURE: 'In-process QC failure', PROCESS: 'Process', OTHER: 'Other' };
const DevStatus = ({ s }: { s: string }) => <StatusBadge status={s === 'Open' ? 'Pending' : 'Closed'} label={s} />;

const columns: Column<DevRow>[] = [
  { key: 'doc', header: 'Deviation', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'cat', header: 'Type', render: (r) => CATEGORY[r.category] ?? humanize(r.category) },
  { key: 'title', header: 'What happened', render: (r) => <span className="block max-w-[420px] truncate">{r.title}</span> },
  { key: 'order', header: 'Production order', render: (r) => r.productionOrderNo ?? '—' },
  { key: 'raised', header: 'Raised', render: (r) => <span className="num">{fmtDateTime(r.createdAt)}</span> },
  { key: 'status', header: 'Status', render: (r) => <DevStatus s={r.status} /> },
];

/** Deviation register (QA-005). An open deviation blocks the release of its batch. */
export function DeviationsPage() {
  return (
    <>
      <PageHeader title="Deviations" subtitle="Departures from the approved process: quarantine overrides, dosing outside tolerance and in-process failures. QA closes each one with its conclusion; an open deviation blocks the batch release." />
      <DataTable<DevRow> queryKey="deviations" path="/qa/deviations" columns={columns} rowHref={(r) => `/qa/deviations/${r.id}`} statusOptions={['Open', 'Closed']}
        searchPlaceholder="Search deviation, order or lot" empty={{ title: 'No deviations', text: 'Deviations are raised automatically by production and QC events.' }} />
    </>
  );
}

export function DeviationDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['deviation', id], queryFn: () => api<DevDetail>(`/qa/deviations/${id}`) });
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const d = q.data;
  if (!d) return <ErrorBanner error={q.error} />;
  const close = async () => {
    setBusy(true); setError(null);
    try { await api(`/qa/deviations/${id}/close`, { body: { note } }); toast('success', 'Deviation closed.'); await qc.invalidateQueries(); setClosing(false); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/qa/deviations" className="hover:text-primary">Deviations</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><DevStatus s={d.status} /><span>{CATEGORY[d.category] ?? d.category}</span></span>}
        actions={d.allowedActions.includes('close') && <Button onClick={() => setClosing(true)}>Close deviation</Button>} />
      {d.waitingForQc && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Lot {d.lotNo} is still in quarantine. This deviation can be closed once QC has released or rejected the lot.</div>}
      <Card title={d.title}>
        <KeyValues items={[['Description', <span className="whitespace-pre-line">{d.description}</span>],
          ['Production order', d.productionOrderId ? <Link className="text-primary" to={`/production/orders/${d.productionOrderId}`}>{d.productionOrderNo}</Link> : '—'],
          ['Lot', d.lotId ? <span><Link className="text-primary" to={`/stores/lots/${d.lotId}`}>{d.lotNo}</Link> {d.itemCode} · QC {d.lotStatus}</span> : '—'],
          ['Raised', `${d.raisedBy ?? 'System'}, ${fmtDateTime(d.createdAt)}`],
          ['Closed', d.closedAt ? `${d.closedBy}, ${fmtDateTime(d.closedAt)}` : '—'], ['Conclusion', d.closureNote ?? '—']]} />
      </Card>
      <Modal open={closing} onClose={() => setClosing(false)} title={`Close ${d.docNo}`} description="Record the investigation and its conclusion, including any impact on the batch."
        footer={<><Button variant="secondary" onClick={() => setClosing(false)}>Cancel</Button><Button loading={busy} disabled={!note.trim()} onClick={close}>Close deviation</Button></>}>
        <ErrorBanner error={error} />
        <Field label="Conclusion" htmlFor="dev-note" required><Textarea id="dev-note" rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
