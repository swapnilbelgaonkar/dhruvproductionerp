import { Plus } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';

interface GrnRow { id: string; docNo: string; purchaseOrderId: string; poNo: string; poStatus: string; partyId: string; vendorCode: string; vendorName: string; warehouseCode: string;
  warehouseName: string; receiptDate: string; challanNo: string; challanDate: string | null; vendorInvoiceNo: string | null; vehicleNo: string | null; remarks: string | null;
  status: string; statusReason: string | null; postedAt: string | null; postedBy: string | null; createdAt: string; createdBy: string; version: number }
interface GrnLine { lineNo: number; poLineId: string; itemId: string; itemCode: string; itemName: string; uom: string; challanQty: string; receivedQty: string; orderedQty: string;
  vendorLotNo: string | null; mfgDate: string | null; expiryDate: string | null; lotId: string | null; lotNo: string | null; qcStatus: string | null; inspectionId: string | null;
  inspectionNo: string | null; inspectionStatus: string | null }
interface OpenLine { poLineId: string; purchaseOrderId: string; poNo: string; poStatus: string; vendorName: string; warehouseCode: string; lineNo: number; itemId: string; itemCode: string;
  itemName: string; lotControlled: boolean; shelfLifeDays: number | null; uom: string; orderedQty: string; receivedQty: string; pendingQty: string; dueDate: string }

const columns: Column<GrnRow>[] = [
  { key: 'doc', header: 'Receipt', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'po', header: 'PO', render: (r) => <span className="num">{r.poNo}</span> },
  { key: 'vendor', header: 'Vendor', render: (r) => r.vendorName },
  { key: 'date', header: 'Received', render: (r) => <span className="num">{fmtDate(r.receiptDate)}</span> },
  { key: 'challan', header: 'Challan', render: (r) => r.challanNo },
  { key: 'wh', header: 'Warehouse', render: (r) => r.warehouseCode },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status === 'Posted' ? 'Approved' : r.status} label={r.status} /> },
];

export function ReceiptsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('purchase.grn:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/stores/receipts/new')}>Receive goods</Button> : undefined;
  return (
    <>
      <PageHeader title="Goods Receipts" subtitle="Material received against purchase orders. Every receipt goes into quarantine until QC releases the lot." actions={create} />
      <DataTable<GrnRow> queryKey="goods-receipts" path="/goods-receipts" columns={columns} rowHref={(r) => `/stores/receipts/${r.id}`} statusOptions={['Draft', 'Posted', 'Cancelled']}
        searchPlaceholder="Search receipt, PO, vendor or challan" empty={{ title: 'No receipts yet', text: 'Receive goods against an issued purchase order.', action: create }} />
    </>
  );
}

// ---------------------------------------------------------------- new / edit
interface DraftLine { poLineId: string; include: boolean; challanQty: string; receivedQty: string; vendorLotNo: string; mfgDate: string; expiryDate: string }

export function ReceiptFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['grn', id], enabled: editing, queryFn: () => api<GrnRow & { lines: GrnLine[]; allowedActions: string[] }>(`/goods-receipts/${id}`) });
  const [poId, setPoId] = useState(params.get('poId') ?? '');
  const allOpen = useQuery({ queryKey: ['open-po-lines-all'], queryFn: () => api<{ data: OpenLine[]; tolerancePct: number }>('/goods-receipts/open-po-lines') });
  const pos = useMemo(() => [...new Map((allOpen.data?.data ?? []).map((l) => [l.purchaseOrderId, l])).values()], [allOpen.data]);
  const lines = useMemo(() => (allOpen.data?.data ?? []).filter((l) => l.purchaseOrderId === poId), [allOpen.data, poId]);
  const today = new Date().toISOString().slice(0, 10);
  const [h, setH] = useState({ receiptDate: today, challanNo: '', challanDate: '', vendorInvoiceNo: '', vehicleNo: '', remarks: '' });
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loaded || !existing.data) return;
    const g = existing.data;
    setPoId(g.purchaseOrderId);
    setH({ receiptDate: g.receiptDate, challanNo: g.challanNo, challanDate: g.challanDate ?? '', vendorInvoiceNo: g.vendorInvoiceNo ?? '', vehicleNo: g.vehicleNo ?? '', remarks: g.remarks ?? '' });
    setDraft(Object.fromEntries(g.lines.map((l) => [l.poLineId, { poLineId: l.poLineId, include: true, challanQty: String(Number(l.challanQty)), receivedQty: String(Number(l.receivedQty)),
      vendorLotNo: l.vendorLotNo ?? '', mfgDate: l.mfgDate ?? '', expiryDate: l.expiryDate ?? '' }])));
    setLoaded(true);
  }, [existing.data, loaded]);
  const row = (l: OpenLine): DraftLine => draft[l.poLineId] ?? { poLineId: l.poLineId, include: true, challanQty: '', receivedQty: '', vendorLotNo: '', mfgDate: '', expiryDate: '' };
  const set = (l: OpenLine, patch: Partial<DraftLine>) => setDraft((d) => ({ ...d, [l.poLineId]: { ...row(l), ...patch } }));

  if (editing && (!loaded || existing.isLoading)) return <Skeleton className="h-96" />;
  if (editing && existing.data && !existing.data.allowedActions.includes('edit')) return <Card><EmptyState title="This receipt cannot be edited" text={`It is ${existing.data.status}.`} /></Card>;
  const chosen = lines.map(row).filter((d) => d.include && Number(d.receivedQty) > 0);
  const valid = poId && h.challanNo.trim() && chosen.length > 0;
  const save = async () => {
    setError(null); setSaving(true);
    const body = { purchaseOrderId: poId, receiptDate: h.receiptDate, challanNo: h.challanNo, challanDate: h.challanDate || null, vendorInvoiceNo: h.vendorInvoiceNo || null,
      vehicleNo: h.vehicleNo || null, remarks: h.remarks || null,
      lines: chosen.map((d) => ({ poLineId: d.poLineId, challanQty: Number(d.challanQty || d.receivedQty), receivedQty: Number(d.receivedQty), vendorLotNo: d.vendorLotNo || null,
        mfgDate: d.mfgDate || null, expiryDate: d.expiryDate || null })) };
    try {
      if (editing) { await api(`/goods-receipts/${id}`, { method: 'PUT', body: { ...body, version: existing.data!.version } }); toast('success', 'Receipt saved.'); await qc.invalidateQueries(); nav(`/stores/receipts/${id}`); }
      else { const r = await api<{ id: string; docNo: string }>('/goods-receipts', { body }); toast('success', `Saved as Draft ${r.docNo}. Check it and post it to put the goods in quarantine.`); nav(`/stores/receipts/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  const editingLines = editing && existing.data ? existing.data.lines : [];
  // when editing, the receipt's own lines may no longer appear as "open" — fall back to them
  const shown: OpenLine[] = lines.length ? lines : editingLines.map((l) => ({ poLineId: l.poLineId, purchaseOrderId: poId, poNo: existing.data!.poNo, poStatus: existing.data!.poStatus,
    vendorName: existing.data!.vendorName, warehouseCode: existing.data!.warehouseCode, lineNo: l.lineNo, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, lotControlled: true,
    shelfLifeDays: null, uom: l.uom, orderedQty: l.orderedQty, receivedQty: '0', pendingQty: l.orderedQty, dueDate: '' }));
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data!.docNo}` : 'Receive goods'} crumbs={<Link to="/stores/receipts" className="hover:text-primary">Goods Receipts</Link>}
        subtitle={`Enter what was physically counted or weighed. Up to ${allOpen.data?.tolerancePct ?? 2}% over the ordered quantity is accepted (D06).`} />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="Delivery">
          <div className="grid gap-5 md:grid-cols-3">
            <div className="md:col-span-3"><Field label="Purchase order" htmlFor="g-po" required hint="Issued or acknowledged POs with quantity still to come">
              <Select id="g-po" value={poId} disabled={editing} onChange={(e) => { setPoId(e.target.value); setDraft({}); }}>
                <option value="">Select…</option>{pos.map((p) => <option key={p.purchaseOrderId} value={p.purchaseOrderId}>{p.poNo} — {p.vendorName} · deliver to {p.warehouseCode}{p.poStatus === 'Issued' ? ' (not yet acknowledged)' : ''}</option>)}
                {editing && existing.data && <option value={existing.data.purchaseOrderId}>{existing.data.poNo} — {existing.data.vendorName}</option>}
              </Select></Field></div>
            <Field label="Receipt date" htmlFor="g-date" required><Input id="g-date" type="date" max={today} value={h.receiptDate} onChange={(e) => setH((x) => ({ ...x, receiptDate: e.target.value }))} /></Field>
            <Field label="Vendor's challan number" htmlFor="g-challan" required><Input id="g-challan" maxLength={60} value={h.challanNo} onChange={(e) => setH((x) => ({ ...x, challanNo: e.target.value }))} /></Field>
            <Field label="Challan date" htmlFor="g-cdate"><Input id="g-cdate" type="date" value={h.challanDate} onChange={(e) => setH((x) => ({ ...x, challanDate: e.target.value }))} /></Field>
            <Field label="Vendor invoice number" htmlFor="g-inv" hint="If the invoice came with the goods"><Input id="g-inv" maxLength={60} value={h.vendorInvoiceNo} onChange={(e) => setH((x) => ({ ...x, vendorInvoiceNo: e.target.value }))} /></Field>
            <Field label="Vehicle number" htmlFor="g-veh"><Input id="g-veh" className="uppercase" maxLength={20} value={h.vehicleNo} onChange={(e) => setH((x) => ({ ...x, vehicleNo: e.target.value.toUpperCase() }))} /></Field>
            <Field label="Remarks" htmlFor="g-rem"><Input id="g-rem" maxLength={500} value={h.remarks} onChange={(e) => setH((x) => ({ ...x, remarks: e.target.value }))} /></Field>
          </div>
        </Card>
        <Card title="Items received" padded={false}>
          {!poId ? <p className="px-6 pb-6 text-ink-2">Choose the purchase order first.</p> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[1080px] text-[14px]">
              <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                <th className="px-5 py-3">Receive</th><th className="px-3 py-3">Item</th><th className="px-3 py-3 text-right">Still to come</th><th className="w-28 px-2 py-3">Challan qty</th>
                <th className="w-28 px-2 py-3">Counted qty</th><th className="w-36 px-2 py-3">Vendor batch</th><th className="w-40 px-2 py-3">Mfg date</th><th className="w-40 px-2 py-3">Expiry</th></tr></thead>
              <tbody>{shown.map((l) => {
                const d = row(l);
                const diff = d.challanQty !== '' && d.receivedQty !== '' && Number(d.challanQty) !== Number(d.receivedQty);
                return (
                  <tr key={l.poLineId} className="border-b border-line align-top last:border-0">
                    <td className="px-5 py-3"><input type="checkbox" aria-label={`Receive ${l.itemCode}`} className="h-5 w-5 accent-[#5B38F5]" checked={d.include} onChange={(e) => set(l, { include: e.target.checked })} /></td>
                    <td className="px-3 py-3"><span className="font-semibold">{l.itemCode}</span><br /><span className="text-ink-2">{l.itemName}</span></td>
                    <td className="px-3 py-3 text-right num">{fmtNum(Number(l.pendingQty))} {l.uom}<span className="block text-[12px] text-ink-2">of {fmtNum(Number(l.orderedQty))}</span></td>
                    <td className="px-2 py-2"><Input aria-label={`Challan quantity for ${l.itemCode}`} type="number" min="0" step="any" value={d.challanQty} disabled={!d.include} onChange={(e) => set(l, { challanQty: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`Counted quantity for ${l.itemCode}`} type="number" min="0" step="any" value={d.receivedQty} disabled={!d.include} invalid={diff} onChange={(e) => set(l, { receivedQty: e.target.value })} />
                      {diff && <p className="mt-1 text-[12px] text-warning-text">Differs from the challan</p>}</td>
                    <td className="px-2 py-2"><Input aria-label={`Vendor batch for ${l.itemCode}`} maxLength={60} value={d.vendorLotNo} disabled={!d.include} placeholder={l.lotControlled ? 'Required' : ''} onChange={(e) => set(l, { vendorLotNo: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`Manufacturing date for ${l.itemCode}`} type="date" max={today} value={d.mfgDate} disabled={!d.include} onChange={(e) => set(l, { mfgDate: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`Expiry date for ${l.itemCode}`} type="date" value={d.expiryDate} disabled={!d.include} onChange={(e) => set(l, { expiryDate: e.target.value })} />
                      {!d.expiryDate && l.shelfLifeDays && <p className="mt-1 text-[12px] text-ink-2">From mfg date + {l.shelfLifeDays} days</p>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
          <div className="flex gap-2 border-t border-line px-5 py-4"><Button loading={saving} disabled={!valid} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- detail
export function ReceiptDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['grn', id], queryFn: () => api<GrnRow & { lines: GrnLine[]; allowedActions: string[] }>(`/goods-receipts/${id}`) });
  const [cancel, setCancel] = useState(false);
  const post = useMutation({ mutationFn: () => api<{ lots: { lotNo: string }[]; poStatus: string }>(`/goods-receipts/${id}/post`, { method: 'POST', body: {} }),
    onSuccess: async (r) => { toast('success', `Posted. ${r.lots.length} lot(s) in quarantine for QC: ${r.lots.map((l) => l.lotNo).join(', ')}.`); await qc.invalidateQueries(); } });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/stores/receipts" className="hover:text-primary">Goods Receipts</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status === 'Posted' ? 'Approved' : d.status} label={d.status} /><span>{d.vendorName} · challan {d.challanNo} · {fmtDate(d.receiptDate)}</span></span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/stores/receipts/${id}/edit`)}>Edit</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel</Button>}
          {a.includes('post') && <Button loading={post.isPending} onClick={() => post.mutate()}>Post to quarantine</Button>}
        </>} />
      <ErrorBanner error={post.error} />
      {d.status === 'Draft' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Draft — no stock yet. Check the counted quantities and batch details, then post: the goods go into quarantine and QC is notified.</div>}
      <Card title="Delivery">
        <KeyValues items={[['Purchase order', <Link key="po" className="font-semibold text-primary" to={`/purchase/orders/${d.purchaseOrderId}`}>{d.poNo} ({d.poStatus})</Link>],
          ['Vendor', d.vendorName], ['Warehouse', `${d.warehouseCode} — ${d.warehouseName}`], ['Receipt date', fmtDate(d.receiptDate)], ['Challan', `${d.challanNo}${d.challanDate ? ` · ${fmtDate(d.challanDate)}` : ''}`],
          ['Vendor invoice', d.vendorInvoiceNo], ['Vehicle', d.vehicleNo], ['Recorded by', `${d.createdBy}, ${fmtDateTime(d.createdAt)}`], ['Posted', d.postedAt ? `${d.postedBy}, ${fmtDateTime(d.postedAt)}` : '—'], ['Remarks', d.remarks]]} />
      </Card>
      <Card title="Items" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">Item</th><th className="px-3 py-3 text-right">Ordered</th><th className="px-3 py-3 text-right">Challan</th><th className="px-3 py-3 text-right">Counted</th>
            <th className="px-3 py-3">Vendor batch</th><th className="px-3 py-3">Mfg / expiry</th><th className="px-3 py-3">Lot</th><th className="px-3 py-3">QC</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-line align-top last:border-0">
              <td className="px-5 py-3"><span className="font-semibold">{l.itemCode}</span><br /><span className="text-ink-2">{l.itemName}</span></td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.orderedQty))} {l.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(l.challanQty))}</td>
              <td className="px-3 py-3 text-right num font-semibold">{fmtNum(Number(l.receivedQty))}</td><td className="px-3 py-3">{l.vendorLotNo ?? '—'}</td>
              <td className="px-3 py-3 num">{l.mfgDate ? fmtDate(l.mfgDate) : '—'} / {l.expiryDate ? fmtDate(l.expiryDate) : '—'}</td>
              <td className="px-3 py-3">{l.lotId ? <Link className="text-primary num" to={`/stores/lots/${l.lotId}`}>{l.lotNo}</Link> : '—'}</td>
              <td className="px-3 py-3">{l.inspectionId ? <Link to={`/qc/inspections/${l.inspectionId}`}><StatusBadge status={l.qcStatus === 'Released' ? 'Approved' : l.qcStatus === 'Rejected' ? 'Rejected' : l.qcStatus === 'Hold' ? 'OnHold' : 'Pending'} label={l.qcStatus ?? ''} /></Link> : '—'}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      <div className="mt-6"><DocumentsPanel entityType="purchase.goods_receipt" entityId={d.id} /></div>
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel receipt" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/goods-receipts/${id}/cancel`, { body: { reason } }); toast('success', 'Receipt cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}
