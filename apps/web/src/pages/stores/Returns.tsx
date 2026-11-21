import { ArrowLeft, Plus, Printer } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { Row } from '../sales/Quotations';

interface ReturnRow { id: string; docNo: string; partyId: string; vendorName: string; vendorGstin: string | null; goodsReceiptId: string; grnNo: string; purchaseOrderId: string; poNo: string;
  warehouseCode: string; returnDate: string; reason: string; transporter: string | null; vehicleNo: string | null; status: string; statusReason: string | null; postedAt: string | null;
  postedBy: string | null; createdAt: string; createdBy: string; interState: boolean }
interface ReturnDetail extends ReturnRow {
  lines: { lineNo: number; lotId: string; lotNo: string; vendorLotNo: string | null; itemCode: string; itemName: string; uom: string; hsnCode: string | null; bucket: string; qty: string; rate: string; gstRate: string }[];
  debitNote: { id: string; docNo: string; noteDate: string; taxableTotal: string; cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; grandTotal: string; status: string } | null;
  allowedActions: string[]; amountInWords: string | null;
}
interface ReturnableLot { lotId: string; lotNo: string; vendorLotNo: string | null; qcStatus: string; itemCode: string; itemName: string; uom: string; rejected: string; unrestricted: string; blocked: string; rate: string }
const BUCKET: Record<string, string> = { REJECTED: 'Rejected stock', UNRESTRICTED: 'Released stock', BLOCKED: 'Blocked (on hold)' };

const columns: Column<ReturnRow>[] = [
  { key: 'doc', header: 'Return', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'vendor', header: 'Vendor', render: (r) => r.vendorName },
  { key: 'grn', header: 'Against receipt', render: (r) => <span className="num">{r.grnNo}</span> },
  { key: 'date', header: 'Date', render: (r) => <span className="num">{fmtDate(r.returnDate)}</span> },
  { key: 'reason', header: 'Reason', render: (r) => <span className="block max-w-[320px] truncate">{r.reason}</span> },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status === 'Posted' ? 'Approved' : r.status} label={r.status} /> },
];

export function ReturnsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('purchase.return:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/stores/returns/new')}>Return goods</Button> : undefined;
  return (
    <>
      <PageHeader title="Supplier Returns" subtitle="Goods sent back to the vendor against the original receipt and lot — usually QC-rejected stock. Posting raises a debit note." actions={create} />
      <DataTable<ReturnRow> queryKey="supplier-returns" path="/supplier-returns" columns={columns} rowHref={(r) => `/stores/returns/${r.id}`} statusOptions={['Draft', 'Posted', 'Cancelled']}
        searchPlaceholder="Search return, receipt or vendor" empty={{ title: 'No returns yet', text: 'Lots that QC rejects appear here to be returned.', action: create }} />
    </>
  );
}

export function ReturnFormPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const grns = useQuery({ queryKey: ['returnable-grns'], queryFn: () => api<{ data: { id: string; docNo: string; vendorName: string; receiptDate: string; rejectedLots: number }[] }>('/supplier-returns/returnable') });
  const [grnId, setGrnId] = useState(params.get('goodsReceiptId') ?? '');
  const lots = useQuery({ queryKey: ['returnable-lots', grnId], enabled: !!grnId, queryFn: () => api<{ data: ReturnableLot[] }>(`/supplier-returns/returnable?goodsReceiptId=${grnId}`) });
  const [h, setH] = useState({ reason: '', transporter: '', vehicleNo: '' });
  const [sel, setSel] = useState<Record<string, { include: boolean; bucket: string; qty: string }>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  // default each lot to its rejected quantity, else nothing
  useEffect(() => {
    if (!lots.data) return;
    setSel(Object.fromEntries(lots.data.data.map((l) => [l.lotId, Number(l.rejected) > 0 ? { include: true, bucket: 'REJECTED', qty: String(Number(l.rejected)) } : { include: false, bucket: Number(l.unrestricted) > 0 ? 'UNRESTRICTED' : 'BLOCKED', qty: '' }])));
  }, [lots.data]);
  const chosen = Object.entries(sel).filter(([, v]) => v.include && Number(v.qty) > 0);
  const save = async () => {
    setError(null); setSaving(true);
    try {
      const r = await api<{ id: string; docNo: string }>('/supplier-returns', { body: { goodsReceiptId: grnId, reason: h.reason, transporter: h.transporter || null, vehicleNo: h.vehicleNo || null,
        lines: chosen.map(([lotId, v]) => ({ lotId, bucket: v.bucket, qty: Number(v.qty) })) } });
      toast('success', `Saved as Draft ${r.docNo}. Purchase posts it, which raises the debit note.`); nav(`/stores/returns/${r.id}`);
    } catch (e) { setError(e); } finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader title="Return goods to the vendor" crumbs={<Link to="/stores/returns" className="hover:text-primary">Supplier Returns</Link>} subtitle="Choose the receipt, then the lots and quantities going back." />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="Return">
          <div className="grid gap-5 md:grid-cols-3">
            <div className="md:col-span-3"><Field label="Against goods receipt" htmlFor="sr-grn" required><Select id="sr-grn" value={grnId} onChange={(e) => setGrnId(e.target.value)}>
              <option value="">Select…</option>{(grns.data?.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.docNo} — {g.vendorName} · {fmtDate(g.receiptDate)}{g.rejectedLots ? ` · ${g.rejectedLots} rejected lot(s)` : ''}</option>)}</Select></Field></div>
            <div className="md:col-span-3"><Field label="Reason (printed on the return challan and debit note)" htmlFor="sr-reason" required><Textarea id="sr-reason" rows={2} maxLength={500} value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} /></Field></div>
            <Field label="Transporter" htmlFor="sr-tr"><Input id="sr-tr" maxLength={120} value={h.transporter} onChange={(e) => setH({ ...h, transporter: e.target.value })} /></Field>
            <Field label="Vehicle" htmlFor="sr-veh"><Input id="sr-veh" className="uppercase" maxLength={20} value={h.vehicleNo} onChange={(e) => setH({ ...h, vehicleNo: e.target.value.toUpperCase() })} /></Field>
          </div>
        </Card>
        {grnId && <Card title="Lots" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Return</th><th className="px-3 py-3">Lot</th><th className="px-3 py-3 text-right">Rejected</th><th className="px-3 py-3 text-right">Released</th><th className="px-3 py-3 text-right">Blocked</th><th className="w-48 px-2 py-3">From</th><th className="w-32 px-2 py-3">Quantity</th></tr></thead>
            <tbody>{(lots.data?.data ?? []).map((l) => {
              const v = sel[l.lotId] ?? { include: false, bucket: 'REJECTED', qty: '' };
              const set = (p: Partial<typeof v>) => setSel((s) => ({ ...s, [l.lotId]: { ...v, ...p } }));
              return (
                <tr key={l.lotId} className="border-b border-line align-top last:border-0">
                  <td className="px-5 py-3"><input type="checkbox" aria-label={`Return lot ${l.lotNo}`} className="h-5 w-5 accent-[#5B38F5]" checked={v.include} onChange={(e) => set({ include: e.target.checked })} /></td>
                  <td className="px-3 py-3"><span className="font-semibold num">{l.lotNo}</span> · {l.itemCode}<span className="block text-[12px] text-ink-2">{l.vendorLotNo ?? ''} · QC {l.qcStatus}</span></td>
                  <td className="px-3 py-3 text-right num text-danger-text">{fmtNum(Number(l.rejected))}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(l.unrestricted))}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(l.blocked))}</td>
                  <td className="px-2 py-2"><Select aria-label={`Bucket for ${l.lotNo}`} value={v.bucket} disabled={!v.include} onChange={(e) => set({ bucket: e.target.value })}>{Object.entries(BUCKET).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</Select></td>
                  <td className="px-2 py-2"><Input aria-label={`Quantity for ${l.lotNo}`} type="number" min="0" step="any" value={v.qty} disabled={!v.include} onChange={(e) => set({ qty: e.target.value })} /></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          <div className="flex gap-2 border-t border-line px-5 py-4"><Button loading={saving} disabled={!h.reason.trim() || chosen.length === 0} onClick={save}>Save draft</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
        </Card>}
      </div>
    </>
  );
}

export function ReturnDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['supplier-return', id], queryFn: () => api<ReturnDetail>(`/supplier-returns/${id}`) });
  const [cancel, setCancel] = useState(false);
  const post = useMutation({ mutationFn: () => api<{ debitNote: string; amount: number }>(`/supplier-returns/${id}/post`, { method: 'POST', body: {} }),
    onSuccess: async (r) => { toast('success', `Posted. Debit note ${r.debitNote} for ${fmtINR(r.amount)} raised on the vendor.`); await qc.invalidateQueries(); } });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/stores/returns" className="hover:text-primary">Supplier Returns</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status === 'Posted' ? 'Approved' : d.status} label={d.status} /><span>{d.vendorName} · {fmtDate(d.returnDate)}</span></span>}
        actions={<>
          {d.debitNote && <Button variant="secondary" icon={<Printer size={18} />} onClick={() => nav(`/stores/returns/${id}/print`)}>Print challan & debit note</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel</Button>}
          {a.includes('post') && <Button loading={post.isPending} onClick={() => post.mutate()}>Post and raise debit note</Button>}
        </>} />
      <ErrorBanner error={post.error} />
      {d.status === 'Draft' && !a.includes('post') && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Draft — purchase posts it, which takes the stock out and raises the debit note.</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Return">
          <KeyValues items={[['Vendor', d.vendorName], ['Against receipt', <Link key="g" className="text-primary" to={`/stores/receipts/${d.goodsReceiptId}`}>{d.grnNo}</Link>],
            ['Purchase order', <Link key="p" className="text-primary" to={`/purchase/orders/${d.purchaseOrderId}`}>{d.poNo}</Link>], ['From warehouse', d.warehouseCode], ['Reason', d.reason],
            ['Transporter / vehicle', [d.transporter, d.vehicleNo].filter(Boolean).join(' · ') || '—'], ['Raised by', `${d.createdBy}, ${fmtDateTime(d.createdAt)}`], ['Posted', d.postedAt ? `${d.postedBy}, ${fmtDateTime(d.postedAt)}` : '—']]} />
        </Card>
        <Card title="Debit note">
          {!d.debitNote ? <p className="text-ink-2">Raised when the return is posted.</p> : (
            <dl className="space-y-2 text-[14px]">
              <Row k="Number" v={d.debitNote.docNo} strong /><Row k="Taxable value" v={fmtINR(d.debitNote.taxableTotal)} />
              {d.interState ? <Row k="IGST" v={fmtINR(d.debitNote.igstTotal)} /> : <><Row k="CGST" v={fmtINR(d.debitNote.cgstTotal)} /><Row k="SGST" v={fmtINR(d.debitNote.sgstTotal)} /></>}
              <div className="border-t border-line pt-2"><Row k="Total" v={fmtINR(d.debitNote.grandTotal)} strong big /></div>
              <p className="text-[12px] text-ink-2">Status {d.debitNote.status} — adjusted against the vendor's invoice or payment when finance is live (Stage 6).</p>
            </dl>
          )}
        </Card>
      </div>
      <Card title="Lots returned" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-6 py-3">Lot</th><th className="px-3 py-3">Item</th><th className="px-3 py-3">From</th><th className="px-3 py-3 text-right">Quantity</th><th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3 text-right">Value</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-line last:border-0"><td className="px-6 py-3"><Link className="text-primary num" to={`/stores/lots/${l.lotId}`}>{l.lotNo}</Link><span className="block text-[12px] text-ink-2">{l.vendorLotNo ?? ''}</span></td>
              <td className="px-3 py-3">{l.itemCode} <span className="text-ink-2">{l.itemName}</span></td><td className="px-3 py-3">{BUCKET[l.bucket]}</td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.qty))} {l.uom}</td><td className="px-3 py-3 text-right num">{fmtINR(l.rate)}</td><td className="px-3 py-3 text-right num">{fmtINR(Number(l.qty) * Number(l.rate))}</td></tr>))}</tbody>
        </table></div>
      </Card>
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel return" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/supplier-returns/${id}/cancel`, { body: { reason } }); toast('success', 'Return cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}

/** A4 return challan with the debit note (goods leave with it). */
export function ReturnPrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['supplier-return', id], queryFn: () => api<ReturnDetail>(`/supplier-returns/${id}`) });
  const d = q.data;
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (!d || !d.debitNote) return <div className="p-8"><ErrorBanner error={q.error ?? new Error('Not posted yet')} /></div>;
  const dn = d.debitNote;
  const cell = 'px-1.5 py-1.5';
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-3 px-4 py-4 print:hidden">
        <Link to={`/stores/returns/${id}`} className="inline-flex items-center gap-2 font-semibold text-primary"><ArrowLeft size={18} /> Back to the return</Link>
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="mx-auto mb-8 max-w-[210mm] bg-white p-[12mm] text-[12px] text-ink shadow-card print:m-0 print:max-w-none print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-3">
          <div><p className="text-[20px] font-extrabold tracking-wide">RETURN CHALLAN & DEBIT NOTE</p><p>Return {d.docNo} · {fmtDate(d.returnDate)}</p></div>
          <div className="text-right"><p className="num font-semibold">Debit note {dn.docNo}</p><p>Against receipt {d.grnNo} · PO {d.poNo}</p></div>
        </header>
        <section className="grid grid-cols-2 gap-6 border-b border-line py-3">
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">To (vendor)</p><p className="font-semibold">{d.vendorName}</p><p>{d.vendorGstin ? `GSTIN ${d.vendorGstin}` : 'Not GST registered'}</p></div>
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Dispatched from</p><p>{d.warehouseCode}</p><p>{[d.transporter, d.vehicleNo].filter(Boolean).join(' · ')}</p></div>
        </section>
        <p className="py-2"><span className="font-semibold">Reason:</span> {d.reason}</p>
        <table className="my-2 w-full text-[11px]">
          <thead><tr className="border-b border-line text-left text-[10px] uppercase text-ink-2"><th className={cell}>Item</th><th className={cell}>HSN</th><th className={cell}>Our lot / your batch</th><th className={`${cell} text-right`}>Qty</th><th className={`${cell} text-right`}>Rate</th><th className={`${cell} text-right`}>GST</th><th className={`${cell} text-right`}>Taxable</th></tr></thead>
          <tbody>{d.lines.map((l) => <tr key={l.lineNo} className="border-b border-line"><td className={cell}>{l.itemCode} {l.itemName}</td><td className={cell}>{l.hsnCode ?? '—'}</td><td className={cell}>{l.lotNo} / {l.vendorLotNo ?? '—'}</td>
            <td className={`${cell} text-right num`}>{fmtNum(Number(l.qty))} {l.uom}</td><td className={`${cell} text-right num`}>{fmtINR(l.rate)}</td><td className={`${cell} text-right num`}>{fmtNum(Number(l.gstRate))}%</td><td className={`${cell} text-right num`}>{fmtINR(Number(l.qty) * Number(l.rate))}</td></tr>)}</tbody>
        </table>
        <section className="flex justify-between gap-6 border-t border-line pt-3">
          <p className="max-w-[105mm]"><span className="font-semibold">Amount in words:</span> {d.amountInWords}<br /><span className="text-ink-2">Your account is debited with this amount. Please issue a credit note or adjust it against your next invoice.</span></p>
          <dl className="w-[70mm] space-y-1"><Row k="Taxable value" v={fmtINR(dn.taxableTotal)} />
            {d.interState ? <Row k="IGST" v={fmtINR(dn.igstTotal)} /> : <><Row k="CGST" v={fmtINR(dn.cgstTotal)} /><Row k="SGST" v={fmtINR(dn.sgstTotal)} /></>}
            <Row k="Round-off" v={fmtINR(dn.roundOff)} /><div className="border-t-2 border-ink pt-1"><Row k="Total debit" v={fmtINR(dn.grandTotal)} strong big /></div></dl>
        </section>
        <footer className="mt-10 flex justify-between"><div className="text-center"><div className="h-12" /><p className="border-t border-ink px-8 pt-1">Received by (vendor / transporter)</p></div>
          <div className="text-center"><div className="h-12" /><p className="border-t border-ink px-8 pt-1">Authorised signatory</p></div></footer>
      </article>
    </div>
  );
}
