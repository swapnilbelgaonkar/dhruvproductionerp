import { CheckCircle, Plus, Trash, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { DataTable, type Column } from '../../components/DataTable';
import { FilePick } from '../../components/parties/PartyParts';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, uploadFile } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';

interface InsRow { id: string; docNo: string; status: string; lotId: string; lotNo: string; vendorLotNo: string | null; mfgDate: string | null; expiryDate: string | null; lotStatus: string;
  itemId: string; itemCode: string; itemName: string; itemType: string; uom: string; partyId: string | null; vendorName: string | null; grnId: string | null; grnNo: string | null;
  receiptDate: string | null; poId: string | null; poNo: string | null; warehouseCode: string | null; sampleQty: string | null; sampledBy: string | null; sampledAt: string | null;
  coaReceived: boolean; coaDocumentId: string | null; testedBy: string | null; testedAt: string | null; recommendation: string | null; decision: string | null;
  decisionRemarks: string | null; decidedBy: string | null; decidedAt: string | null; createdAt: string; receivedQty: string; sourceType: string }
interface InsDetail extends InsRow {
  results: { seq: number; parameter: string; specification: string; result: string; pass: boolean }[]; stock: { bucket: string; qty: string }[];
  template: { parameter: string; specification: string }[]; allowedActions: string[];
}
const badge = (s: string) => <StatusBadge status={s === 'Released' ? 'Approved' : s === 'Rejected' ? 'Rejected' : s === 'Hold' ? 'OnHold' : s === 'Tested' ? 'Submitted' : s === 'QcApproved' ? 'Issued' : 'Pending'}
  label={s === 'QcApproved' ? 'QC approved · awaiting QA' : s} />;

const columns: Column<InsRow>[] = [
  { key: 'doc', header: 'Inspection', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'lot', header: 'Lot', render: (r) => <span className="num">{r.lotNo}{r.vendorLotNo ? <span className="text-ink-2"> · {r.vendorLotNo}</span> : null}</span> },
  { key: 'item', header: 'Item', render: (r) => <span><span className="font-medium">{r.itemCode}</span> <span className="text-ink-2">{r.itemName}</span></span> },
  { key: 'vendor', header: 'Vendor', render: (r) => r.vendorName ?? '—' },
  { key: 'qty', header: 'Received', className: 'text-right', render: (r) => <span className="num">{fmtNum(Number(r.receivedQty))} {r.uom}</span> },
  { key: 'date', header: 'Received on', render: (r) => <span className="num">{r.receiptDate ? fmtDate(r.receiptDate) : '—'}</span> },
  { key: 'status', header: 'Status', render: (r) => badge(r.status) },
];

export function InspectionsPage() {
  return (
    <>
      <PageHeader title="Quality Control — Incoming Lots" subtitle="Every received lot stays in quarantine until QC samples it, tests it and a QC manager releases it (BRD p.15). Rejected lots go to rejected stock for return." />
      <DataTable<InsRow> queryKey="qc-inspections" path="/qc/inspections" columns={columns} rowHref={(r) => `/qc/inspections/${r.id}`}
        statusOptions={['open', 'Pending', 'Sampled', 'Tested', 'Hold', 'Released', 'Rejected']} searchPlaceholder="Search inspection, lot, item or vendor"
        empty={{ title: 'Nothing to inspect', text: 'Lots appear here as soon as stores post a goods receipt.' }} />
    </>
  );
}

interface ResultRow { key: number; parameter: string; specification: string; result: string; pass: boolean }
let k = 0;

export function InspectionDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['inspection', id], queryFn: () => api<InsDetail>(`/qc/inspections/${id}`) });
  const [sample, setSample] = useState('');
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [coaReceived, setCoaReceived] = useState(false);
  const [coaFile, setCoaFile] = useState<File | null>(null);
  const [recommendation, setRecommendation] = useState('Release');
  const [decide, setDecide] = useState<null | 'Release' | 'Reject' | 'Hold'>(null);
  const [remarks, setRemarks] = useState('');
  const d = q.data;
  useEffect(() => {
    if (!d) return;
    const src = d.results.length ? d.results : d.template.map((t) => ({ ...t, result: '', pass: true }));
    setRows(src.length ? src.map((r) => ({ key: ++k, parameter: r.parameter, specification: r.specification, result: r.result, pass: r.pass })) : [{ key: ++k, parameter: '', specification: '', result: '', pass: true }]);
    setCoaReceived(d.coaReceived);
    if (d.recommendation) setRecommendation(d.recommendation);
  }, [d]);
  const refresh = () => qc.invalidateQueries();
  const doSample = useMutation({ mutationFn: () => api(`/qc/inspections/${id}/sample`, { body: { sampleQty: Number(sample || 0) } }), onSuccess: async () => { toast('success', 'Sample drawn from quarantine.'); await refresh(); } });
  const doResults = useMutation({
    mutationFn: async () => {
      let coaDocumentId = d!.coaDocumentId;
      if (coaFile) coaDocumentId = (await uploadFile<{ id: string }>('/documents', coaFile, { documentType: 'COA', entityType: 'qc.inspection', entityId: id!, title: `CoA — ${d!.vendorLotNo ?? d!.lotNo}` })).id;
      return api(`/qc/inspections/${id}/results`, { body: { results: rows.filter((r) => r.parameter.trim()).map(({ key: _k, ...r }) => r), coaReceived, coaDocumentId, recommendation } });
    },
    onSuccess: async () => { toast('success', 'Results saved. A QC manager decides the lot.'); setCoaFile(null); await refresh(); },
  });
  const doDecide = useMutation({
    mutationFn: () => api<{ lotStatus: string; vendorRating: number | null; qcApproved?: boolean }>(`/qc/inspections/${id}/decide`, { body: { decision: decide, remarks } }),
    onSuccess: async (r) => { toast('success', r.qcApproved ? 'Results approved. The lot waits for the QA release.' : `Lot ${r.lotStatus.toLowerCase()}.${r.vendorRating !== null ? ` Vendor rating now ${r.vendorRating} / 5.` : ''}`); setDecide(null); setRemarks(''); await refresh(); },
  });
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const stock = (b: string) => Number(d.stock.find((s) => s.bucket === b)?.qty ?? 0);
  const editResults = a.includes('results');
  const allPass = rows.every((r) => !r.parameter.trim() || r.pass);
  return (
    <>
      <PageHeader title={`${d.docNo} — ${d.itemCode}`} crumbs={<Link to="/qc/inspections" className="hover:text-primary">Quality Control</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2">{badge(d.status)}<span>Lot <Link className="font-semibold text-primary num" to={`/stores/lots/${d.lotId}`}>{d.lotNo}</Link> · {d.itemName}{d.vendorName ? ` · ${d.vendorName}` : ''}</span></span>}
        actions={d.status === 'Rejected' && d.grnId && can('purchase.return:create') ? <Button onClick={() => nav(`/stores/returns/new?goodsReceiptId=${d.grnId}`)}>Return to vendor</Button> : a.includes('decide') ? <>
          <Button variant="danger" onClick={() => setDecide('Reject')}>Reject lot</Button>
          {d.status !== 'Hold' && <Button variant="secondary" onClick={() => setDecide('Hold')}>Hold</Button>}
          <Button icon={<CheckCircle size={18} />} onClick={() => setDecide('Release')}>{d.sourceType === 'PRODUCTION' ? 'Approve results' : 'Release lot'}</Button>
        </> : undefined} />
      <ErrorBanner error={doSample.error ?? doResults.error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          {d.status === 'Pending' && a.includes('sample') && (
            <Card title="1. Draw the sample">
              <p className="mb-4 text-ink-2">The sample quantity is taken out of quarantine stock ({fmtNum(stock('QUARANTINE'))} {d.uom} now). Enter 0 if the test is non-destructive.</p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label={`Sample quantity (${d.uom})`} htmlFor="qc-sample" required><Input id="qc-sample" type="number" min="0" step="any" value={sample} onChange={(e) => setSample(e.target.value)} /></Field>
                <Button loading={doSample.isPending} disabled={sample === ''} onClick={() => doSample.mutate()}>Record sampling</Button>
              </div>
            </Card>
          )}
          {d.status !== 'Pending' && (
            <Card title={editResults ? '2. Test results' : 'Test results'} padded={false}
              actions={editResults && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setRows([...rows, { key: ++k, parameter: '', specification: '', result: '', pass: true }])}>Add test</Button>}>
              {d.template.length > 0 && !d.results.length && editResults && <p className="px-6 pb-3 text-[13px] text-ink-2">Parameters pre-filled from this item's last inspection.</p>}
              <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]">
                <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-6 py-3">Parameter</th><th className="px-2 py-3">Specification</th><th className="px-2 py-3">Result</th><th className="px-2 py-3">Pass</th>{editResults && <th className="px-3 py-3" />}</tr></thead>
                <tbody>{(editResults ? rows : d.results.map((r) => ({ ...r, key: r.seq }))).map((r, i) => (
                  <tr key={r.key} className="border-b border-line last:border-0">
                    {editResults ? <>
                      <td className="px-6 py-2"><Input aria-label={`Parameter ${i + 1}`} value={r.parameter} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, parameter: e.target.value } : x)))} placeholder="e.g. Zinc (Zn)" /></td>
                      <td className="px-2 py-2"><Input aria-label={`Specification ${i + 1}`} value={r.specification} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, specification: e.target.value } : x)))} placeholder="e.g. ≥ 33.0%" /></td>
                      <td className="px-2 py-2"><Input aria-label={`Result ${i + 1}`} value={r.result} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, result: e.target.value } : x)))} /></td>
                      <td className="px-2 py-2"><Select aria-label={`Pass ${i + 1}`} value={r.pass ? 'yes' : 'no'} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, pass: e.target.value === 'yes' } : x)))}><option value="yes">Pass</option><option value="no">Fail</option></Select></td>
                      <td className="px-3 py-2"><Button size="sm" variant="ghost" aria-label={`Remove test ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}><Trash size={16} /></Button></td>
                    </> : <>
                      <td className="px-6 py-3 font-medium">{r.parameter}</td><td className="px-2 py-3">{r.specification}</td><td className="px-2 py-3 num">{r.result}</td>
                      <td className="px-2 py-3">{r.pass ? <span className="inline-flex items-center gap-1 text-success-text"><CheckCircle size={16} weight="fill" />Pass</span> : <span className="inline-flex items-center gap-1 text-danger-text"><XCircle size={16} weight="fill" />Fail</span>}</td>
                    </>}
                  </tr>))}</tbody>
              </table></div>
              {editResults && (
                <div className="grid gap-4 border-t border-line px-6 py-5 md:grid-cols-3">
                  <label className="flex items-center gap-3 text-[14px]"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={coaReceived} onChange={(e) => setCoaReceived(e.target.checked)} />Vendor's certificate of analysis received</label>
                  <div className="flex items-center gap-3"><FilePick onFile={setCoaFile} label={d.coaDocumentId ? 'Replace CoA file' : 'Attach CoA (PDF/image)'} />{coaFile && <span className="text-[13px]">{coaFile.name}</span>}</div>
                  <Field label="Recommendation" htmlFor="qc-rec"><Select id="qc-rec" value={recommendation} onChange={(e) => setRecommendation(e.target.value)}>
                    <option value="Release" disabled={!allPass}>Release</option><option value="Reject">Reject</option><option value="Hold">Hold</option></Select></Field>
                  <div className="md:col-span-3"><Button loading={doResults.isPending} disabled={!rows.some((r) => r.parameter.trim() && r.specification.trim() && r.result.trim())} onClick={() => doResults.mutate()}>Save results</Button></div>
                </div>
              )}
            </Card>
          )}
        </div>
        <aside className="space-y-6">
          <Card title="Lot">
            <KeyValues items={[['Lot', d.lotNo], ['Vendor batch', d.vendorLotNo], ['Item', `${d.itemCode} — ${d.itemName}`], ['Vendor', d.vendorName],
              ['Mfg / expiry', `${d.mfgDate ? fmtDate(d.mfgDate) : '—'} / ${d.expiryDate ? fmtDate(d.expiryDate) : '—'}`],
              ['Receipt', d.grnId ? <Link key="g" className="text-primary" to={`/stores/receipts/${d.grnId}`}>{d.grnNo}</Link> : '—'], ['PO', d.poId ? <Link key="p" className="text-primary" to={`/purchase/orders/${d.poId}`}>{d.poNo}</Link> : '—']]} columns="narrow" />
          </Card>
          <Card title="Stock of this lot">
            <dl className="space-y-2 text-[14px]">
              {['QUARANTINE', 'UNRESTRICTED', 'BLOCKED', 'REJECTED'].map((b) => <div key={b} className="flex justify-between"><dt className="text-ink-2">{b === 'UNRESTRICTED' ? 'Released (usable)' : b[0] + b.slice(1).toLowerCase()}</dt><dd className="num">{fmtNum(stock(b))} {d.uom}</dd></div>)}
              <div className="flex justify-between border-t border-line pt-2"><dt className="text-ink-2">Received</dt><dd className="num">{fmtNum(Number(d.receivedQty))} {d.uom}</dd></div>
            </dl>
          </Card>
          <Card title="Trail">
            <ul className="space-y-2 text-[14px]">
              <li>Received {d.receiptDate ? fmtDate(d.receiptDate) : '—'} into {d.warehouseCode ?? '—'} (quarantine)</li>
              {d.sampledAt && <li>Sampled {fmtNum(Number(d.sampleQty))} {d.uom} by {d.sampledBy}, {fmtDateTime(d.sampledAt)}</li>}
              {d.testedAt && <li>Tested by {d.testedBy}, {fmtDateTime(d.testedAt)} — recommends <span className="font-semibold">{d.recommendation}</span>; CoA {d.coaReceived ? 'received' : 'not received'}</li>}
              {d.decidedAt && <li>Decision: <span className="font-semibold">{d.decision}</span> by {d.decidedBy}, {fmtDateTime(d.decidedAt)}{d.decisionRemarks ? ` — ${d.decisionRemarks}` : ''}</li>}
            </ul>
            {d.status === 'Tested' && !a.includes('decide') && <p className="mt-3 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning-text">Waiting for a QC manager's decision (not the analyst who tested it).</p>}
          </Card>
        </aside>
      </div>
      <Modal open={!!decide} onClose={() => setDecide(null)} title={decide === 'Release' && d.sourceType === 'PRODUCTION' ? `Approve the results for ${d.lotNo}` : `${decide} lot ${d.lotNo}`} width={520}
        description={decide === 'Release' && d.sourceType === 'PRODUCTION' ? 'QC approves the results. The finished-goods lot stays in quarantine until the QA head reviews the batch and releases it.'
          : decide === 'Release' ? 'The lot moves to usable stock. Every test must have passed and the vendor CoA must be received.' : decide === 'Reject' ? 'The lot moves to rejected stock for return to the vendor.' : 'The lot is blocked until a further decision.'}
        footer={<><Button variant="secondary" onClick={() => setDecide(null)}>Cancel</Button><Button variant={decide === 'Reject' ? 'danger' : 'primary'} loading={doDecide.isPending} disabled={decide !== 'Release' && !remarks.trim()} onClick={() => doDecide.mutate()}>{decide === 'Release' && d.sourceType === 'PRODUCTION' ? 'Approve results' : decide}</Button></>}>
        <ErrorBanner error={doDecide.error} />
        <p className="mb-3 text-[14px]">Analyst's recommendation: <span className="font-semibold">{d.recommendation ?? '—'}</span>{!d.coaReceived && decide === 'Release' ? ' · CoA not received' : ''}</p>
        <Field label={decide === 'Release' ? 'Remarks (optional)' : 'Reason (recorded in the audit trail)'} htmlFor="qc-rem" required={decide !== 'Release'}><Textarea id="qc-rem" rows={3} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
      </Modal>
    </>
  );
}
