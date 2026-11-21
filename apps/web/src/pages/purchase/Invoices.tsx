import { CheckCircle, Plus, WarningCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { FilePick } from '../../components/parties/PartyParts';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, uploadFile, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { Row } from '../sales/Quotations';

interface InvRow { id: string; docNo: string; partyId: string; vendorName: string; purchaseOrderId: string; poNo: string; invoiceNo: string; invoiceDate: string; dueDate: string;
  taxableTotal: string; taxTotal: string; roundOff: string; grandTotal: string; status: string; statusReason: string | null; exceptionNote: string | null; createdAt: string; createdBy: string; version: number; documentId: string | null }
interface InvLine { lineNo: number; poLineId: string; itemCode: string; itemName: string; uom: string; qty: string; rate: string; gstRate: string; taxable: string; tax: string; poRate: string;
  poGstRate: string; billableQty: string; qtyVariance: string; priceVariancePct: string; taxVariance: string; withinTolerance: boolean; matchNotes: string | null }
interface Billable { poLineId: string; itemCode: string; itemName: string; uom: string; orderedQty: string; rate: string; gstRate: string; acceptedQty: number; pendingQcQty: number; invoicedQty: number; billableQty: number }
const badge = (s: string) => <StatusBadge status={s === 'Matched' || s === 'Approved' ? 'Approved' : s === 'Exception' || s === 'Rejected' ? 'Rejected' : s === 'Submitted' ? 'Submitted' : s} label={s} />;

const columns: Column<InvRow>[] = [
  { key: 'doc', header: 'Reference', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'inv', header: "Vendor's invoice", render: (r) => <span>{r.invoiceNo}<span className="block text-[13px] text-ink-2">{fmtDate(r.invoiceDate)}</span></span> },
  { key: 'vendor', header: 'Vendor', render: (r) => r.vendorName },
  { key: 'po', header: 'PO', render: (r) => <span className="num">{r.poNo}</span> },
  { key: 'due', header: 'Due', render: (r) => <span className="num">{fmtDate(r.dueDate)}</span> },
  { key: 'amt', header: 'Amount', className: 'text-right', render: (r) => <span className="num font-semibold">{fmtINR(r.grandTotal)}</span> },
  { key: 'status', header: 'Match', render: (r) => badge(r.status) },
];

export function InvoicesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('purchase.invoice:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/purchase/invoices/new')}>Book supplier invoice</Button> : undefined;
  return (
    <>
      <PageHeader title="Supplier Invoices" subtitle="Each invoice is matched to its PO and the QC-accepted receipts (three-way match). Matched invoices are ready for payment; exceptions need a justification and approval." actions={create} />
      <DataTable<InvRow> queryKey="supplier-invoices" path="/supplier-invoices" columns={columns} rowHref={(r) => `/purchase/invoices/${r.id}`}
        statusOptions={['Matched', 'Exception', 'Submitted', 'Approved', 'Rejected', 'Cancelled']} searchPlaceholder="Search reference, invoice number, vendor or PO"
        empty={{ title: 'No supplier invoices yet', text: 'Book the vendor’s tax invoice against its PO once the goods are received and QC has released them.', action: create }} />
    </>
  );
}

export function InvoiceFormPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const pos = useQuery({ queryKey: ['pos-billable'], queryFn: () => api<Page<{ id: string; docNo: string; vendorName: string; status: string }>>('/purchase-orders?limit=100') });
  const [poId, setPoId] = useState(params.get('poId') ?? '');
  const bill = useQuery({ queryKey: ['billable', poId], enabled: !!poId, queryFn: () => api<{ data: Billable[] }>(`/supplier-invoices/billable?purchaseOrderId=${poId}`) });
  const [h, setH] = useState({ invoiceNo: '', invoiceDate: new Date().toISOString().slice(0, 10), dueDate: '' });
  const [ls, setLs] = useState<Record<string, { include: boolean; qty: string; rate: string; gstRate: string; tax: string }>>({});
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!bill.data) return;
    setLs(Object.fromEntries(bill.data.data.map((l) => [l.poLineId, { include: l.billableQty > 0, qty: l.billableQty ? String(l.billableQty) : '', rate: String(Number(l.rate)), gstRate: String(Number(l.gstRate)), tax: '' }])));
  }, [bill.data]);
  const receivable = (pos.data?.data ?? []).filter((p) => ['PartiallyReceived', 'Received', 'Closed', 'Acknowledged', 'Issued'].includes(p.status));
  const chosen = Object.entries(ls).filter(([, v]) => v.include && Number(v.qty) > 0 && Number(v.rate) > 0);
  const save = async () => {
    setError(null); setSaving(true);
    try {
      // book first, then attach the scan to the booked invoice (documents belong to a record)
      const r = await api<{ id: string; docNo: string; status: string }>('/supplier-invoices', { body: { purchaseOrderId: poId, invoiceNo: h.invoiceNo, invoiceDate: h.invoiceDate, dueDate: h.dueDate || null,
        lines: chosen.map(([poLineId, v]) => ({ poLineId, qty: Number(v.qty), rate: Number(v.rate), gstRate: Number(v.gstRate), tax: v.tax === '' ? null : Number(v.tax) })) } });
      if (file) await uploadFile('/documents', file, { documentType: 'SUPPLIER_INVOICE', entityType: 'purchase.supplier_invoice', entityId: r.id, title: `Invoice ${h.invoiceNo}` });
      toast(r.status === 'Matched' ? 'success' : 'error', r.status === 'Matched' ? `${r.docNo} matched — ready for payment.` : `${r.docNo} is outside tolerance. Review the exceptions.`);
      nav(`/purchase/invoices/${r.id}`);
    } catch (e) { setError(e); } finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader title="Book supplier invoice" crumbs={<Link to="/purchase/invoices" className="hover:text-primary">Supplier Invoices</Link>} subtitle="Enter the invoice as the vendor issued it — quantities, rates and GST charged. The system matches it to the PO and the QC-accepted receipts." />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="Invoice">
          <div className="grid gap-5 md:grid-cols-3">
            <div className="md:col-span-3"><Field label="Purchase order" htmlFor="si-po" required><Select id="si-po" value={poId} onChange={(e) => setPoId(e.target.value)}>
              <option value="">Select…</option>{receivable.map((p) => <option key={p.id} value={p.id}>{p.docNo} — {p.vendorName} ({p.status})</option>)}</Select></Field></div>
            <Field label="Vendor's invoice number" htmlFor="si-no" required><Input id="si-no" maxLength={60} value={h.invoiceNo} onChange={(e) => setH({ ...h, invoiceNo: e.target.value })} /></Field>
            <Field label="Invoice date" htmlFor="si-date" required><Input id="si-date" type="date" value={h.invoiceDate} onChange={(e) => setH({ ...h, invoiceDate: e.target.value })} /></Field>
            <Field label="Due date" htmlFor="si-due" hint="Blank = invoice date + PO payment terms"><Input id="si-due" type="date" value={h.dueDate} onChange={(e) => setH({ ...h, dueDate: e.target.value })} /></Field>
            <div className="flex items-center gap-3 md:col-span-3"><FilePick onFile={setFile} label="Attach invoice scan (PDF/image)" />{file && <span className="text-[14px]">{file.name}</span>}</div>
          </div>
        </Card>
        {poId && <Card title="Lines" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Bill</th><th className="px-3 py-3">Item</th>
              <th className="px-3 py-3 text-right">QC-accepted</th><th className="px-3 py-3 text-right">Invoiced</th><th className="px-3 py-3 text-right">Billable</th>
              <th className="w-28 px-2 py-3">Qty</th><th className="w-28 px-2 py-3">Rate</th><th className="w-20 px-2 py-3">GST %</th><th className="w-28 px-2 py-3">GST charged</th></tr></thead>
            <tbody>{(bill.data?.data ?? []).map((l) => {
              const v = ls[l.poLineId] ?? { include: false, qty: '', rate: '', gstRate: '', tax: '' };
              const set = (p: Partial<typeof v>) => setLs((s) => ({ ...s, [l.poLineId]: { ...v, ...p } }));
              return (
                <tr key={l.poLineId} className="border-b border-line align-top last:border-0">
                  <td className="px-5 py-3"><input type="checkbox" aria-label={`Bill ${l.itemCode}`} className="h-5 w-5 accent-[#5B38F5]" checked={v.include} onChange={(e) => set({ include: e.target.checked })} /></td>
                  <td className="px-3 py-3"><span className="font-semibold">{l.itemCode}</span> <span className="text-ink-2">{l.itemName}</span><span className="block text-[12px] text-ink-2">PO rate {fmtINR(l.rate)} · GST {fmtNum(Number(l.gstRate))}%</span></td>
                  <td className="px-3 py-3 text-right num">{fmtNum(l.acceptedQty)}{l.pendingQcQty ? <span className="block text-[12px] text-warning-text">{fmtNum(l.pendingQcQty)} in QC</span> : null}</td>
                  <td className="px-3 py-3 text-right num">{fmtNum(l.invoicedQty)}</td><td className="px-3 py-3 text-right num font-semibold">{fmtNum(l.billableQty)} {l.uom}</td>
                  <td className="px-2 py-2"><Input aria-label={`Quantity for ${l.itemCode}`} type="number" min="0" step="any" value={v.qty} disabled={!v.include} onChange={(e) => set({ qty: e.target.value })} /></td>
                  <td className="px-2 py-2"><Input aria-label={`Rate for ${l.itemCode}`} type="number" min="0" step="0.0001" value={v.rate} disabled={!v.include} onChange={(e) => set({ rate: e.target.value })} /></td>
                  <td className="px-2 py-2"><Input aria-label={`GST rate for ${l.itemCode}`} type="number" min="0" max="100" step="0.01" value={v.gstRate} disabled={!v.include} onChange={(e) => set({ gstRate: e.target.value })} /></td>
                  <td className="px-2 py-2"><Input aria-label={`GST charged for ${l.itemCode}`} type="number" min="0" step="0.01" placeholder="calculated" value={v.tax} disabled={!v.include} onChange={(e) => set({ tax: e.target.value })} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <div className="flex gap-2 border-t border-line px-5 py-4"><Button loading={saving} disabled={!h.invoiceNo.trim() || chosen.length === 0} onClick={save}>Book and match</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
        </Card>}
      </div>
    </>
  );
}

export function InvoiceDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['supplier-invoice', id], queryFn: () => api<InvRow & { lines: InvLine[]; allowedActions: string[]; tolerances: { qtyPct: number; pricePct: number; taxAbs: number };
    approval: { id: string; docNo: string; status: string; steps: { seq: number; label: string; status: string }[] | null } | null }>(`/supplier-invoices/${id}`) });
  const [justify, setJustify] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const rematch = useMutation({ mutationFn: () => api<{ status: string }>(`/supplier-invoices/${id}/rematch`, { method: 'POST', body: {} }), onSuccess: async (r) => { toast('success', `Re-matched: ${r.status}.`); await qc.invalidateQueries(); } });
  const submit = useMutation({ mutationFn: () => api<{ approvalDocNo: string }>(`/supplier-invoices/${id}/submit`, { body: { note: justify } }),
    onSuccess: async (r) => { toast('success', `Sent for approval as ${r.approvalDocNo}.`); setJustify(null); await qc.invalidateQueries(); } });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  return (
    <>
      <PageHeader title={`${d.docNo} · ${d.invoiceNo}`} crumbs={<Link to="/purchase/invoices" className="hover:text-primary">Supplier Invoices</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2">{badge(d.status)}<span>{d.vendorName} · {fmtINR(d.grandTotal)} · due {fmtDate(d.dueDate)}</span></span>}
        actions={<>
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel</Button>}
          {a.includes('rematch') && <Button variant="secondary" loading={rematch.isPending} onClick={() => rematch.mutate()}>Re-run match</Button>}
          {a.includes('submit') && <Button onClick={() => setJustify('')}>Justify and send for approval</Button>}
        </>} />
      <ErrorBanner error={rematch.error} />
      {d.status === 'Matched' && <div className="mb-6 flex items-center gap-2 rounded-md bg-success-bg px-4 py-3 text-success-text"><CheckCircle size={20} weight="fill" />Matched within tolerance — ready for payment (payables, Stage 6).</div>}
      {d.status === 'Exception' && <div className="mb-6 flex items-center gap-2 rounded-md bg-danger-bg px-4 py-3 text-danger-text"><WarningCircle size={20} weight="fill" />Outside tolerance. Re-run the match after QC or a return, or justify the variance for the purchase head and finance head.</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Invoice">
          <KeyValues items={[['Vendor', d.vendorName], ['PO', <Link key="p" className="text-primary" to={`/purchase/orders/${d.purchaseOrderId}`}>{d.poNo}</Link>], ["Vendor's invoice", `${d.invoiceNo} · ${fmtDate(d.invoiceDate)}`],
            ['Due', fmtDate(d.dueDate)], ['Booked by', `${d.createdBy}, ${fmtDateTime(d.createdAt)}`], ['Justification', d.exceptionNote], ['Outcome', d.statusReason]]} />
        </Card>
        <aside className="space-y-6">
          <Card title="Amount"><dl className="space-y-2 text-[14px]"><Row k="Taxable value" v={fmtINR(d.taxableTotal)} /><Row k="GST charged" v={fmtINR(d.taxTotal)} /><Row k="Round-off" v={fmtINR(d.roundOff)} />
            <div className="border-t border-line pt-2"><Row k="Total" v={fmtINR(d.grandTotal)} strong big /></div></dl></Card>
          {d.approval && <Card title="Exception approval"><p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link></p>
            <ol className="space-y-2">{(d.approval.steps ?? []).map((s) => <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>)}</ol></Card>}
        </aside>
      </div>
      <Card title={`Three-way match (tolerances: quantity +${d.tolerances.qtyPct}%, price ±${d.tolerances.pricePct}%, GST ±₹${d.tolerances.taxAbs})`} padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Item</th><th className="px-3 py-3 text-right">Invoiced qty</th><th className="px-3 py-3 text-right">Billable (QC-accepted)</th>
            <th className="px-3 py-3 text-right">Rate / PO rate</th><th className="px-3 py-3 text-right">Price var.</th><th className="px-3 py-3 text-right">GST % / PO</th><th className="px-3 py-3 text-right">GST charged</th><th className="px-3 py-3 text-right">GST var.</th><th className="px-3 py-3">Result</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-line align-top last:border-0">
              <td className="px-5 py-3"><span className="font-semibold">{l.itemCode}</span> <span className="text-ink-2">{l.itemName}</span></td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.qty))} {l.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(l.billableQty))}</td>
              <td className="px-3 py-3 text-right num">{fmtINR(l.rate)} / {fmtINR(l.poRate)}</td><td className="px-3 py-3 text-right num">{Number(l.priceVariancePct) > 0 ? '+' : ''}{Number(l.priceVariancePct).toFixed(2)}%</td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.gstRate))}% / {fmtNum(Number(l.poGstRate))}%</td><td className="px-3 py-3 text-right num">{fmtINR(l.tax)}</td><td className="px-3 py-3 text-right num">{fmtINR(l.taxVariance)}</td>
              <td className="px-3 py-3">{l.withinTolerance ? <span className="inline-flex items-center gap-1 text-success-text"><CheckCircle size={16} weight="fill" />Within</span>
                : <span className="text-danger-text"><span className="inline-flex items-center gap-1 font-semibold"><WarningCircle size={16} weight="fill" />Exception</span><span className="block text-[13px]">{l.matchNotes}</span></span>}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      <Modal open={justify !== null} onClose={() => setJustify(null)} title="Justify the variance" width={560} description="Explain why the invoice should be accepted as it is. The purchase head, then the finance head, decide."
        footer={<><Button variant="secondary" onClick={() => setJustify(null)}>Cancel</Button><Button loading={submit.isPending} disabled={!justify?.trim()} onClick={() => submit.mutate()}>Send for approval</Button></>}>
        <ErrorBanner error={submit.error} />
        <Field label="Justification" htmlFor="si-just" required><Textarea id="si-just" rows={4} maxLength={1000} value={justify ?? ''} onChange={(e) => setJustify(e.target.value)} /></Field>
      </Modal>
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel invoice" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/supplier-invoices/${id}/cancel`, { body: { reason } }); toast('success', 'Invoice cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}
