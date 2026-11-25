import { EinvoicePanel } from '../../components/GstPanels';
import { ArrowLeft, ArrowUUpLeft, Plus, Printer, Receipt } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';
import { addressText, state, type Address } from '../sales/Quotations';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
/** Money on printed documents: two decimals, no symbol. */
const m2 = (v: string | number | null | undefined) => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';

interface InvoiceRow { id: string; docNo: string; partyName: string; partyCode: string; salesOrderId: string; salesOrderNo: string; shipmentId: string; shipmentNo: string; invoiceDate: string; dueDate: string;
  status: string; statusReason: string | null; grandTotal: string; amountSettled: string; outstanding: string; legalEntityId: string }
interface Lot { lotId: string; lotNo: string; expiryDate: string | null; packs: number; qty: number }
interface InvLine { id: string; lineNo: number; description: string; hsnCode: string; packLabel: string; qty: string; listRate: string; schemeDiscountPct: string; extraDiscountPct: string; rate: string;
  taxable: string; gstRate: string; cgst: string; sgst: string; igst: string; lineTotal: string; lots: Lot[]; creditedQty: number; creditedTaxable: number }
interface InvoiceDetail extends InvoiceRow {
  legalEntityName: string; sellerAddress: string | null; sellerPan: string | null; sellerGstin: string | null; sellerState: string; partyGstin: string | null; placeOfSupply: string; interState: boolean;
  dealerPoNo: string | null; dealerPoDate: string | null; vehicleNo: string | null; lrNo: string | null; lrDate: string | null; ewbNo: string | null; transporterName: string | null; paymentTerms: string;
  taxableTotal: string; cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; irn: string | null; einvoice?: { irn: string; ackNo: string; ackDate: string; simulated: boolean; qrDataUrl: string } | null; isOpening?: boolean; openingRef?: string | null; createdAt: string; createdBy: string; cancelledAt: string | null;
  lines: InvLine[]; billTo: Address | null; shipTo: Address | null; creditNotes: { id: string; docNo: string; noteDate: string; reason: string; status: string; grandTotal: string }[];
  returns: { id: string; docNo: string; receivedOn: string; reason: string; status: string }[]; hsnSummary: { hsnCode: string; gstRate: number; taxable: number; cgst: number; sgst: number; igst: number }[];
  amountInWords: string; bankDetails: string; cancelWindowHours: number; allowedActions: string[];
}
const REASON_LABEL: Record<string, string> = { RETURN: 'Goods returned', SHORTAGE: 'Short delivered', DAMAGE: 'Damaged in transit', RATE_DIFFERENCE: 'Rate difference', SCHEME: 'Scheme / discount', OTHER: 'Other' };
const RETURN_REASONS: Record<string, string> = { DAMAGED: 'Damaged', LEAKAGE: 'Leakage', EXPIRED: 'Expired / near expiry', WRONG_PRODUCT: 'Wrong product', QUALITY_COMPLAINT: 'Quality complaint', EXCESS: 'Excess supplied', OTHER: 'Other' };

// ---------------------------------------------------------------- invoices (FIN-001…FIN-003)
export function SalesInvoicesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [tab, setTab] = useState<'Posted' | 'Cancelled'>('Posted');
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['sales-invoices', tab, q], queryFn: () => api<{ data: InvoiceRow[] }>(`/sales-invoices?status=${tab}${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const pending = useQuery({ queryKey: ['to-invoice'], queryFn: () => api<{ data: { id: string; docNo: string; dispatchedAt: string; salesOrderNo: string; partyName: string }[] }>('/sales-invoices/to-invoice') });
  const raise = async (shipmentId: string) => {
    try { const r = await api<{ id: string; docNo: string }>('/sales-invoices', { body: { shipmentId } }); toast('success', `${r.docNo} raised.`); await qc.invalidateQueries({ queryKey: ['to-invoice'] }); nav(`/finance/invoices/${r.id}`); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Could not raise the invoice.'); }
  };
  return (
    <>
      <PageHeader title="Sales Invoices" subtitle="GST tax invoices, raised with each dispatch at the order's prices and tax. Cancel only within the cancellation window; otherwise issue a credit note." />
      {!!pending.data?.data.length && (
        <Card title="Dispatched, not yet invoiced" className="mb-6">
          <ul className="space-y-2">{pending.data.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 text-[14px]"><Link className="font-semibold text-primary num" to={`/logistics/shipments/${s.id}`}>{s.docNo}</Link>
              <span className="text-ink-2">{s.partyName} · {s.salesOrderNo} · dispatched {fmtDateTime(s.dispatchedAt)}</span>
              {can('sales.invoice:create') && <Button size="sm" icon={<Receipt size={16} />} onClick={() => raise(s.id)}>Raise invoice</Button>}</li>))}</ul>
        </Card>
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'Posted', label: 'Posted' }, { value: 'Cancelled', label: 'Cancelled' }]} />
        <Input aria-label="Search invoices" placeholder="Invoice, dealer or order number" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card padded={false}>
        {list.isLoading ? <Skeleton className="h-40" /> : list.error ? <div className="p-5"><ErrorBanner error={list.error} /></div> : !list.data?.data.length ? <div className="p-5"><EmptyState title="No invoices here" text="Invoices are raised when a shipment is dispatched." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-[14px]"><thead><tr className={thead}>
            <th className="px-5 py-3">Invoice</th><th className={th}>Date</th><th className={th}>Dealer</th><th className={th}>Order / shipment</th><th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>Outstanding</th><th className={th}>Due</th><th className={th}>Status</th></tr></thead>
            <tbody>{list.data.data.map((i) => (
              <tr key={i.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/finance/invoices/${i.id}`}>{i.docNo}</Link></td><td className={th}>{fmtDate(i.invoiceDate)}</td>
                <td className={th}>{i.partyName}</td><td className={`${th} num`}>{i.salesOrderNo} · {i.shipmentNo}</td><td className={`${th} text-right num`}>{fmtINR(i.grandTotal)}</td>
                <td className={`${th} text-right num`}>{i.status === 'Posted' ? fmtINR(i.outstanding) : '—'}</td><td className={th}>{fmtDate(i.dueDate)}</td><td className={th}><StatusBadge status={i.status} /></td>
              </tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function SalesInvoiceDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['sales-invoice', id], queryFn: () => api<InvoiceDetail>(`/sales-invoices/${id}`) });
  const [dialog, setDialog] = useState<null | 'cancel' | 'credit' | 'return'>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const d = q.data;
  if (!d) return <ErrorBanner error={q.error} />;
  const can = (a: string) => d.allowedActions.includes(a);
  const refresh = () => qc.invalidateQueries();
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/finance/invoices" className="hover:text-primary">Sales Invoices</Link>}
        subtitle={<span>{d.partyName} · {fmtDate(d.invoiceDate)} · <StatusBadge status={d.status} /></span>}
        actions={<>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.open(`/finance/invoices/${id}/print`, '_blank')}>Print tax invoice</Button>
          {can('cancel') && <Button variant="secondary" onClick={() => setDialog('cancel')}>Cancel invoice</Button>}
          {can('return') && <Button variant="secondary" icon={<ArrowUUpLeft size={18} />} onClick={() => setDialog('return')}>Receive return</Button>}
          {can('credit_note') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setDialog('credit')}>Credit note</Button>}
        </>} />
      {d.status === 'Cancelled' && <p className="mb-4 rounded-md bg-danger-bg px-4 py-3 text-danger-text">Cancelled {fmtDateTime(d.cancelledAt)}: {d.statusReason}. The shipment can be invoiced again.</p>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Lines" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[14px]"><thead><tr className={thead}>
            <th className="px-5 py-3">Product</th><th className={th}>HSN</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Rate</th><th className={`${th} text-right`}>Taxable</th>
            <th className={`${th} text-right`}>GST</th><th className={`${th} text-right`}>Total</th><th className={th}>Lots</th></tr></thead>
            <tbody>{d.lines.map((l) => (
              <tr key={l.id} className="border-b border-line align-top last:border-0">
                <td className="px-5 py-3">{l.description}<div className="text-[13px] text-ink-2">{l.packLabel}{n(l.schemeDiscountPct) || n(l.extraDiscountPct) ? ` · list ${fmtINR(l.listRate)} less ${fmtNum(l.schemeDiscountPct)}% + ${fmtNum(l.extraDiscountPct)}%` : ''}</div>
                  {l.creditedQty > 0 && <div className="text-[13px] text-warning-text">{fmtNum(l.creditedQty)} credited</div>}</td>
                <td className={`${th} num`}>{l.hsnCode}</td><td className={`${th} text-right num`}>{fmtNum(l.qty)}</td><td className={`${th} text-right num`}>{fmtINR(l.rate)}</td>
                <td className={`${th} text-right num`}>{fmtINR(l.taxable)}</td><td className={`${th} text-right num`}>{fmtNum(l.gstRate)}% · {fmtINR(n(l.cgst) + n(l.sgst) + n(l.igst))}</td>
                <td className={`${th} text-right num`}>{fmtINR(l.lineTotal)}</td>
                <td className={th}>{l.lots.map((x) => <div key={x.lotId}><Link className="text-primary" to={`/stores/lots/${x.lotId}`}>{x.lotNo}</Link> <span className="text-ink-2">× {x.packs}</span></div>)}</td>
              </tr>))}</tbody></table></div>
        </Card>
        <div className="space-y-6">
          <Card title="Amount">
            <KeyValues columns="narrow" items={[['Taxable value', fmtINR(d.taxableTotal)], ...(d.interState ? [['IGST', fmtINR(d.igstTotal)] as [string, string]] : [['CGST', fmtINR(d.cgstTotal)] as [string, string], ['SGST', fmtINR(d.sgstTotal)] as [string, string]]),
              ['Round-off', fmtINR(d.roundOff)], ['Invoice total', <b key="t">{fmtINR(d.grandTotal)}</b>], ['Settled (credit notes, receipts)', fmtINR(d.amountSettled)], ['Outstanding', <b key="o">{fmtINR(d.outstanding)}</b>],
              ['Due', `${fmtDate(d.dueDate)} (${d.paymentTerms})`]]} />
          </Card>
          <Card title="References">
            <KeyValues columns="narrow" items={[['Sales order', <Link key="so" className="text-primary" to={`/sales/orders/${d.salesOrderId}`}>{d.salesOrderNo}</Link>],
              ['Shipment', <Link key="s" className="text-primary" to={`/logistics/shipments/${d.shipmentId}`}>{d.shipmentNo}</Link>], ['Place of supply', state(d.placeOfSupply)],
              ['Transport', d.vehicleNo ? `${d.transporterName} · ${d.vehicleNo} · LR ${d.lrNo}` : '—'], ['E-way bill', d.ewbNo ?? '—'], ['Raised', `${d.createdBy}, ${fmtDateTime(d.createdAt)}`]]} />
          </Card>
          <EinvoicePanel kind="invoice" id={d.id} docNo={d.docNo} />
          <Card title="Credit notes and returns">
            {!d.creditNotes.length && !d.returns.length ? <p className="text-ink-2">None.</p> : (
              <ul className="space-y-2 text-[14px]">
                {d.creditNotes.map((c) => <li key={c.id} className="flex flex-wrap items-center gap-2"><Link className="font-semibold text-primary num" to={`/finance/credit-notes/${c.id}`}>{c.docNo}</Link>
                  <span className="text-ink-2">{REASON_LABEL[c.reason]} · {fmtINR(c.grandTotal)}</span><StatusBadge status={c.status} /></li>)}
                {d.returns.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2"><Link className="font-semibold text-primary num" to={`/logistics/returns/${r.id}`}>{r.docNo}</Link>
                  <span className="text-ink-2">{RETURN_REASONS[r.reason]} · {fmtDate(r.receivedOn)}</span><StatusBadge status={r.status === 'Closed' ? 'Closed' : 'Pending'} label={r.status === 'Closed' ? 'Closed' : 'Awaiting QA'} /></li>)}
              </ul>)}
          </Card>
        </div>
      </div>
      <ReasonDialog open={dialog === 'cancel'} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel invoice" onClose={() => setDialog(null)}
        description={`Allowed within ${d.cancelWindowHours} hours of raising it and before anything is settled. The goods stay dispatched; the shipment can be invoiced again.`}
        onConfirm={async (reason) => { await api(`/sales-invoices/${id}/cancel`, { body: { reason } }); toast('success', `${d.docNo} cancelled.`); await refresh(); }} />
      {dialog === 'credit' && <CreditNoteDialog inv={d} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnDialog inv={d} onClose={() => setDialog(null)} />}
    </>
  );
}

function CreditNoteDialog({ inv, onClose }: { inv: InvoiceDetail; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [reason, setReason] = useState('SHORTAGE');
  const [remarks, setRemarks] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const byQty = ['SHORTAGE', 'DAMAGE'].includes(reason);
  const lines = inv.lines.map((l) => ({ invoiceLineId: l.id, v: Number(vals[l.id]) || 0 })).filter((x) => x.v > 0);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string }>('/credit-notes', { body: { invoiceId: inv.id, reason, remarks: remarks || null, shipmentId: inv.shipmentId,
        lines: lines.map((x) => (byQty ? { invoiceLineId: x.invoiceLineId, qty: x.v } : { invoiceLineId: x.invoiceLineId, taxable: x.v })) } });
      toast('success', `${r.docNo} drafted. Submit it for approval.`); nav(`/finance/credit-notes/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Credit note against ${inv.docNo}`} description="GST follows each invoice line. Returned goods get their credit note when stores receives them." width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!lines.length || (!byQty && !remarks.trim())} onClick={save}>Draft credit note</Button></>}>
      <ErrorBanner error={error} />
      <Field label="Reason" htmlFor="cn-reason" required><Select id="cn-reason" value={reason} onChange={(e) => { setReason(e.target.value); setVals({}); }}>
        {['SHORTAGE', 'DAMAGE', 'RATE_DIFFERENCE', 'SCHEME', 'OTHER'].map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}</Select></Field>
      <table className="mt-4 w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Line</th><th className="py-2 text-right">Invoiced</th><th className="py-2 text-right">Already credited</th>
        <th className="w-40 py-2 text-right">{byQty ? 'Packs to credit' : 'Taxable value (₹)'}</th></tr></thead>
        <tbody>{inv.lines.map((l) => (
          <tr key={l.id} className="border-b border-line last:border-0"><td className="py-2">{l.description} <span className="text-ink-2">{l.packLabel} @ {fmtINR(l.rate)}</span></td>
            <td className="py-2 text-right num">{byQty ? fmtNum(l.qty) : fmtINR(l.taxable)}</td><td className="py-2 text-right num">{byQty ? fmtNum(l.creditedQty) : fmtINR(l.creditedTaxable)}</td>
            <td className="py-2 pl-3"><Input aria-label={`${byQty ? 'Packs' : 'Value'} to credit on line ${l.lineNo}`} type="number" min="0" step={byQty ? '1' : '0.01'} value={vals[l.id] ?? ''} onChange={(e) => setVals({ ...vals, [l.id]: e.target.value })} /></td></tr>))}</tbody></table>
      <Field label={byQty ? 'Remarks' : 'Explanation (required)'} htmlFor="cn-rem" required={!byQty}><Textarea id="cn-rem" value={remarks} maxLength={1000} onChange={(e) => setRemarks(e.target.value)} /></Field>
    </Modal>
  );
}

function ReturnDialog({ inv, onClose }: { inv: InvoiceDetail; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const whs = useQuery({ queryKey: ['warehouses-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; type: string; legalEntityId: string }>>('/warehouses?status=Active&limit=100') });
  const options = (whs.data?.data ?? []).filter((w) => w.legalEntityId === inv.legalEntityId && ['FG', 'GENERAL', 'QUARANTINE'].includes(w.type));
  const [f, setF] = useState({ warehouseId: '', receivedOn: today(), reason: 'DAMAGED', remarks: '', transportRef: '' });
  const rows = inv.lines.flatMap((l) => l.lots.map((x) => ({ key: `${l.id}|${x.lotId}`, line: l, lot: x })));
  const [packs, setPacks] = useState<Record<string, string>>({});
  const [cond, setCond] = useState<Record<string, string>>({});
  useEffect(() => { if (options.length === 1 && !f.warehouseId) setF((x) => ({ ...x, warehouseId: options[0]!.id })); }, [options, f.warehouseId]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = rows.filter((r) => Number(packs[r.key]) > 0).map((r) => ({ invoiceLineId: r.line.id, lotId: r.lot.lotId, packs: Number(packs[r.key]), condition: cond[r.key] || null }));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string; creditNoteNo: string }>('/customer-returns', { body: { invoiceId: inv.id, ...f, remarks: f.remarks || null, transportRef: f.transportRef || null, lines } });
      toast('success', `${r.docNo} received into quarantine; ${r.creditNoteNo} drafted for accounts.`); nav(`/logistics/returns/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Receive goods returned against ${inv.docNo}`} description="The goods go into quarantine until QA restocks or rejects them; a credit note is drafted for the packs received." width={760}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.warehouseId || !lines.length} onClick={save}>Receive return</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Received into" htmlFor="rt-wh" required><Select id="rt-wh" value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}><option value="">Select…</option>
          {options.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></Field>
        <Field label="Received on" htmlFor="rt-on" required><Input id="rt-on" type="date" max={today()} value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} /></Field>
        <Field label="Reason" htmlFor="rt-reason" required><Select id="rt-reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>
          {Object.entries(RETURN_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      </div>
      <table className="mt-4 w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Product and lot</th><th className="py-2 text-right">Sent</th><th className="w-28 py-2 text-right">Packs back</th><th className="py-2 pl-3">Condition</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key} className="border-b border-line last:border-0"><td className="py-2">{r.line.description} <span className="text-ink-2">{r.line.packLabel} · lot {r.lot.lotNo}</span></td>
            <td className="py-2 text-right num">{fmtNum(r.lot.packs)}</td>
            <td className="py-2 pl-3"><Input aria-label={`Packs back of lot ${r.lot.lotNo}`} type="number" min="0" max={r.lot.packs} step="1" value={packs[r.key] ?? ''} onChange={(e) => setPacks({ ...packs, [r.key]: e.target.value })} /></td>
            <td className="py-2 pl-3"><Input aria-label={`Condition of lot ${r.lot.lotNo}`} value={cond[r.key] ?? ''} onChange={(e) => setCond({ ...cond, [r.key]: e.target.value })} /></td></tr>))}</tbody></table>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="LR / transport reference" htmlFor="rt-ref"><Input id="rt-ref" value={f.transportRef} onChange={(e) => setF({ ...f, transportRef: e.target.value })} /></Field>
        <Field label="Remarks" htmlFor="rt-rem"><Input id="rt-rem" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** Printable GST tax invoice (rule 46): seller and buyer GSTIN, place of supply, HSN, taxable value, tax by rate, amount in words, lots and transport. */
export function SalesInvoicePrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['sales-invoice', id], queryFn: () => api<InvoiceDetail>(`/sales-invoices/${id}`) });
  const d = q.data;
  useEffect(() => { if (d) document.title = d.docNo.replace(/[/ ]/g, '-'); return () => { document.title = 'Dhruv Agro ERP'; }; }, [d]);
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (!d) return <div className="p-8"><ErrorBanner error={q.error} /></div>;
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-3 px-4 py-4 print:hidden">
        <Link to={`/finance/invoices/${id}`} className="inline-flex items-center gap-2 font-semibold text-primary"><ArrowLeft size={18} /> Back to invoice</Link>
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="mx-auto mb-8 max-w-[210mm] bg-white p-[12mm] text-[11px] text-ink shadow-card print:m-0 print:max-w-none print:p-0 print:shadow-none">
        {d.status === 'Cancelled' && <div className="mb-4 rounded border-2 border-danger-text px-3 py-2 text-center font-bold uppercase text-danger-text">Cancelled — not a valid tax invoice</div>}
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-3">
          <div><h1 className="text-[18px] font-extrabold">{d.legalEntityName}</h1>{d.sellerAddress && <p className="max-w-[95mm] whitespace-pre-line">{d.sellerAddress}</p>}
            <p>GSTIN {d.sellerGstin ?? '—'}{d.sellerPan ? ` · PAN ${d.sellerPan}` : ''} · State {state(d.sellerState)}</p></div>
          <div className="text-right"><p className="text-[20px] font-extrabold tracking-wide">TAX INVOICE</p><p className="text-[10px]">Original for recipient</p><p className="num text-[13px] font-semibold">{d.docNo}</p>
            <p>Date {fmtDate(d.invoiceDate)}</p><p>Due {fmtDate(d.dueDate)}</p></div>
        </header>
        {d.einvoice && <div className="flex items-center gap-3 border-b border-line py-2"><img src={d.einvoice.qrDataUrl} alt="E-invoice signed QR" width={96} height={96} />
            <div className="text-[9px]"><p className="font-semibold">{d.einvoice.simulated ? 'SIMULATED — NOT A VALID IRN' : 'E-invoice'}</p><p className="break-all">IRN {d.einvoice.irn}</p><p>Ack {d.einvoice.ackNo}</p><p>{fmtDateTime(d.einvoice.ackDate)}</p></div></div>}
        <section className="grid grid-cols-3 gap-4 border-b border-line py-3">
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Billed to</p><p className="font-semibold">{d.partyName}</p><p>{addressText(d.billTo)}</p><p>{d.partyGstin ? `GSTIN ${d.partyGstin}` : 'Unregistered (B2C)'}</p></div>
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Shipped to</p><p>{addressText(d.shipTo)}</p><p>Place of supply: {state(d.placeOfSupply)}</p></div>
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Order and transport</p><p>Order {d.salesOrderNo}{d.dealerPoNo ? ` · your PO ${d.dealerPoNo}` : ''}</p><p>Challan {d.shipmentNo}</p>
            <p>{d.transporterName ?? '—'} · {d.vehicleNo ?? '—'}</p><p>LR {d.lrNo ?? '—'}{d.lrDate ? ` dated ${fmtDate(d.lrDate)}` : ''}</p>{d.ewbNo && <p>E-way bill {d.ewbNo}</p>}</div>
        </section>
        <table className="mt-2 w-full border-collapse text-[10px]"><thead><tr className="border-b-2 border-ink text-left">
          <th className="py-1">#</th><th className="py-1">Description · lot</th><th className="py-1">HSN</th><th className="py-1 text-right">Qty</th><th className="py-1 text-right">Rate</th><th className="py-1 text-right">Disc.</th>
          <th className="py-1 text-right">Taxable</th><th className="py-1 text-right">GST %</th>{d.interState ? <th className="py-1 text-right">IGST</th> : <><th className="py-1 text-right">CGST</th><th className="py-1 text-right">SGST</th></>}
          <th className="py-1 text-right">Total</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id} className="border-b border-line align-top"><td className="py-1">{l.lineNo}</td>
              <td className="py-1 pr-2">{l.description} ({l.packLabel})<div className="text-ink-2">{l.lots.map((x) => `${x.lotNo}${x.expiryDate ? ` exp ${fmtDate(x.expiryDate)}` : ''}`).join('; ')}</div></td>
              <td className="py-1">{l.hsnCode}</td><td className="whitespace-nowrap py-1 text-right num">{fmtNum(l.qty)}</td><td className="py-1 text-right num">{m2(l.listRate)}</td>
              <td className="py-1 text-right num">{n(l.schemeDiscountPct) || n(l.extraDiscountPct) ? `${fmtNum(l.schemeDiscountPct)}+${fmtNum(l.extraDiscountPct)}%` : '—'}</td>
              <td className="py-1 text-right num">{m2(l.taxable)}</td><td className="py-1 text-right num">{fmtNum(l.gstRate)}</td>
              {d.interState ? <td className="py-1 text-right num">{m2(l.igst)}</td> : <><td className="py-1 text-right num">{m2(l.cgst)}</td><td className="py-1 text-right num">{m2(l.sgst)}</td></>}
              <td className="py-1 text-right num">{m2(l.lineTotal)}</td></tr>))}</tbody></table>
        <section className="mt-3 grid grid-cols-[1fr_70mm] gap-6">
          <div>
            <table className="w-full border-collapse text-[10px]"><thead><tr className="border-b border-ink text-left"><th className="py-1">HSN</th><th className="py-1 text-right">Taxable</th><th className="py-1 text-right">Rate</th>
              {d.interState ? <th className="py-1 text-right">IGST</th> : <><th className="py-1 text-right">CGST</th><th className="py-1 text-right">SGST</th></>}</tr></thead>
              <tbody>{d.hsnSummary.map((h) => <tr key={`${h.hsnCode}${h.gstRate}`} className="border-b border-line"><td className="py-1">{h.hsnCode}</td><td className="py-1 text-right num">{m2(h.taxable)}</td>
                <td className="py-1 text-right num">{h.gstRate}%</td>{d.interState ? <td className="py-1 text-right num">{m2(h.igst)}</td> : <><td className="py-1 text-right num">{m2(h.cgst)}</td><td className="py-1 text-right num">{m2(h.sgst)}</td></>}</tr>)}</tbody></table>
            <p className="mt-3"><span className="font-semibold">Amount in words:</span> {d.amountInWords}</p>
            <p className="mt-1">Payment terms: {d.paymentTerms}. Tax is not payable on reverse charge.</p>
            {d.bankDetails && <p className="mt-1 whitespace-pre-line"><span className="font-semibold">Bank details:</span> {d.bankDetails}</p>}
          </div>
          <dl className="space-y-1 text-[11px]">
            {[['Taxable value', d.taxableTotal], ...(d.interState ? [['IGST', d.igstTotal]] : [['CGST', d.cgstTotal], ['SGST', d.sgstTotal]]), ['Round-off', d.roundOff]].map(([k, v]) => (
              <div key={k} className="flex justify-between"><dt>{k}</dt><dd className="num">{m2(v)}</dd></div>))}
            <div className="flex justify-between border-t-2 border-ink pt-1 text-[13px] font-bold"><dt>Invoice total</dt><dd className="num">{fmtINR(d.grandTotal)}</dd></div>
          </dl>
        </section>
        <footer className="mt-10 flex items-end justify-between"><p className="max-w-[100mm] text-[10px] text-ink-2">Certified that the particulars given above are true and correct. Goods once sold are subject to the dealer agreement.</p>
          <div className="text-center"><p className="mb-10 font-semibold">For {d.legalEntityName}</p><p className="border-t border-ink px-6 pt-1">Authorised signatory</p></div></footer>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------- credit notes (FIN-004)
interface CreditNote { id: string; docNo: string; invoiceId: string; invoiceNo: string; invoiceDate: string; partyName: string; partyCode: string; partyGstin: string | null; interState: boolean;
  noteDate: string; reason: string; remarks: string | null; customerReturnId: string | null; customerReturnNo: string | null; status: string; statusReason: string | null; taxableTotal: string;
  cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; grandTotal: string; approvedAt: string | null; createdAt: string; createdBy: string }
interface CreditNoteDetail extends CreditNote {
  lines: { id: string; lineNo: number; description: string; hsnCode: string; packLabel: string; rate: string; qty: string | null; taxable: string; gstRate: string; cgst: string; sgst: string; igst: string; lineTotal: string }[];
  approval: { id: string; docNo: string; status: string } | null; seller: { name: string; address: string | null; pan: string | null; gstin: string | null }; amountInWords: string; allowedActions: string[];
}

export function CreditNotesPage() {
  const [tab, setTab] = useState<'Open' | 'Approved' | 'All'>('Open');
  const q = useQuery({ queryKey: ['credit-notes'], queryFn: () => api<{ data: CreditNote[] }>('/credit-notes') });
  const rows = (q.data?.data ?? []).filter((c) => tab === 'All' || (tab === 'Open' ? ['Draft', 'Submitted', 'Rejected'].includes(c.status) : c.status === 'Approved'));
  return (
    <>
      <PageHeader title="Credit Notes" subtitle="Shortages, damage, returns, rate differences and schemes credited against an invoice. A credit note counts only once approved." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'Open', label: 'Open' }, { value: 'Approved', label: 'Approved' }, { value: 'All', label: 'All' }]} />
      <Card padded={false} className="mt-4">
        {q.isLoading ? <Skeleton className="h-40" /> : !rows.length ? <div className="p-5"><EmptyState title="No credit notes here" text="Raise one from an invoice; returns draft their own." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Credit note</th><th className={th}>Date</th><th className={th}>Dealer</th>
            <th className={th}>Invoice</th><th className={th}>Reason</th><th className={`${th} text-right`}>Amount</th><th className={th}>Status</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/finance/credit-notes/${c.id}`}>{c.docNo}</Link></td>
                <td className={th}>{fmtDate(c.noteDate)}</td><td className={th}>{c.partyName}</td><td className={`${th} num`}>{c.invoiceNo}</td><td className={th}>{REASON_LABEL[c.reason]}</td>
                <td className={`${th} text-right num`}>{fmtINR(c.grandTotal)}</td><td className={th}><StatusBadge status={c.status} /></td></tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function CreditNoteDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['credit-note', id], queryFn: () => api<CreditNoteDetail>(`/credit-notes/${id}`) });
  const [cancel, setCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const c = q.data;
  if (!c) return <ErrorBanner error={q.error} />;
  const submit = async () => {
    setBusy(true);
    try { const r = await api<{ approvalDocNo: string; status: string }>(`/credit-notes/${id}/submit`, { body: {} }); toast('success', r.status === 'Approved' ? 'Approved.' : `Sent for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); }
    catch (e) { toast('error', e instanceof Error ? e.message : 'Could not submit.'); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={c.docNo} crumbs={<Link to="/finance/credit-notes" className="hover:text-primary">Credit Notes</Link>}
        subtitle={<span>{c.partyName} · against <Link className="text-primary" to={`/finance/invoices/${c.invoiceId}`}>{c.invoiceNo}</Link> · <StatusBadge status={c.status} /></span>}
        actions={<>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.open(`/finance/credit-notes/${id}/print`, '_blank')}>Print</Button>
          {c.allowedActions.includes('cancel') && <Button variant="secondary" onClick={() => setCancel(true)}>Cancel</Button>}
          {c.allowedActions.includes('submit') && <Button loading={busy} onClick={submit}>Submit for approval</Button>}
        </>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Lines" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Invoice line</th><th className={`${th} text-right`}>Qty</th>
            <th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>GST</th><th className={`${th} text-right`}>Total</th></tr></thead>
            <tbody>{c.lines.map((l) => (
              <tr key={l.id} className="border-b border-line last:border-0"><td className="px-5 py-3">{l.lineNo}. {l.description} <span className="text-ink-2">{l.packLabel}</span></td>
                <td className={`${th} text-right num`}>{l.qty ? fmtNum(l.qty) : 'Value only'}</td><td className={`${th} text-right num`}>{fmtINR(l.taxable)}</td>
                <td className={`${th} text-right num`}>{fmtNum(l.gstRate)}% · {fmtINR(n(l.cgst) + n(l.sgst) + n(l.igst))}</td><td className={`${th} text-right num`}>{fmtINR(l.lineTotal)}</td></tr>))}</tbody></table></div>
        </Card>
        {c.status === 'Approved' && <EinvoicePanel kind="credit-note" id={c.id} docNo={c.docNo} />}
        <Card title="Summary">
          <KeyValues columns="narrow" items={[['Reason', REASON_LABEL[c.reason] ?? c.reason], ['Remarks', c.remarks ?? '—'],
            ['Customer return', c.customerReturnId ? <Link key="r" className="text-primary" to={`/logistics/returns/${c.customerReturnId}`}>{c.customerReturnNo}</Link> : '—'],
            ['Taxable value', fmtINR(c.taxableTotal)], ['GST', fmtINR(n(c.cgstTotal) + n(c.sgstTotal) + n(c.igstTotal))], ['Total', <b key="t">{fmtINR(c.grandTotal)}</b>],
            ['Approval', c.approval ? <Link key="a" className="text-primary" to={`/approvals/${c.approval.id}`}>{c.approval.docNo} · {humanize(c.approval.status)}</Link> : 'Not submitted'],
            ['Drafted', `${c.createdBy}, ${fmtDateTime(c.createdAt)}`], ['Status note', c.statusReason ?? '—']]} />
        </Card>
      </div>
      <ReasonDialog open={cancel} danger title={`Cancel ${c.docNo}`} confirmLabel="Cancel credit note" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/credit-notes/${id}/cancel`, { body: { reason } }); toast('success', `${c.docNo} cancelled.`); await qc.invalidateQueries(); }} />
    </>
  );
}

export function CreditNotePrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['credit-note', id], queryFn: () => api<CreditNoteDetail>(`/credit-notes/${id}`) });
  const c = q.data;
  useEffect(() => { if (c) document.title = c.docNo.replace(/[/ ]/g, '-'); return () => { document.title = 'Dhruv Agro ERP'; }; }, [c]);
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (!c) return <div className="p-8"><ErrorBanner error={q.error} /></div>;
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-3 px-4 py-4 print:hidden">
        <Link to={`/finance/credit-notes/${id}`} className="inline-flex items-center gap-2 font-semibold text-primary"><ArrowLeft size={18} /> Back to credit note</Link>
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="mx-auto mb-8 max-w-[210mm] bg-white p-[12mm] text-[11px] text-ink shadow-card print:m-0 print:max-w-none print:p-0 print:shadow-none">
        {c.status !== 'Approved' && <div className="mb-4 rounded border-2 border-danger-text px-3 py-2 text-center font-bold uppercase text-danger-text">{c.status} — not yet a valid credit note</div>}
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-3">
          <div><h1 className="text-[18px] font-extrabold">{c.seller.name}</h1>{c.seller.address && <p className="max-w-[95mm] whitespace-pre-line">{c.seller.address}</p>}<p>GSTIN {c.seller.gstin ?? '—'}</p></div>
          <div className="text-right"><p className="text-[20px] font-extrabold">CREDIT NOTE</p><p className="num text-[13px] font-semibold">{c.docNo}</p><p>Date {fmtDate(c.noteDate)}</p>
            <p>Against invoice {c.invoiceNo} dated {fmtDate(c.invoiceDate)}</p></div>
        </header>
        <section className="border-b border-line py-3"><p className="font-semibold">{c.partyName}</p><p>{c.partyGstin ? `GSTIN ${c.partyGstin}` : 'Unregistered'}</p><p>Reason: {REASON_LABEL[c.reason]}{c.remarks ? ` — ${c.remarks}` : ''}</p></section>
        <table className="mt-2 w-full border-collapse text-[10px]"><thead><tr className="border-b-2 border-ink text-left"><th className="py-1">Description</th><th className="py-1">HSN</th><th className="py-1 text-right">Qty</th>
          <th className="py-1 text-right">Taxable</th><th className="py-1 text-right">GST %</th><th className="py-1 text-right">Tax</th><th className="py-1 text-right">Total</th></tr></thead>
          <tbody>{c.lines.map((l) => <tr key={l.id} className="border-b border-line"><td className="py-1">{l.description} ({l.packLabel})</td><td className="py-1">{l.hsnCode}</td>
            <td className="py-1 text-right num">{l.qty ? fmtNum(l.qty) : '—'}</td><td className="py-1 text-right num">{m2(l.taxable)}</td><td className="py-1 text-right num">{fmtNum(l.gstRate)}</td>
            <td className="py-1 text-right num">{m2(n(l.cgst) + n(l.sgst) + n(l.igst))}</td><td className="py-1 text-right num">{m2(l.lineTotal)}</td></tr>)}</tbody></table>
        <dl className="ml-auto mt-3 w-[70mm] space-y-1">
          {[['Taxable value', c.taxableTotal], ...(c.interState ? [['IGST', c.igstTotal]] : [['CGST', c.cgstTotal], ['SGST', c.sgstTotal]]), ['Round-off', c.roundOff]].map(([k, v]) => (
            <div key={k} className="flex justify-between"><dt>{k}</dt><dd className="num">{m2(v)}</dd></div>))}
          <div className="flex justify-between border-t-2 border-ink pt-1 text-[13px] font-bold"><dt>Credit total</dt><dd className="num">{fmtINR(c.grandTotal)}</dd></div>
        </dl>
        <p className="mt-3"><span className="font-semibold">Amount in words:</span> {c.amountInWords}</p>
        <footer className="mt-10 text-right"><p className="mb-10 font-semibold">For {c.seller.name}</p><p className="inline-block border-t border-ink px-6 pt-1">Authorised signatory</p></footer>
      </article>
    </div>
  );
}

// ---------------------------------------------------------------- customer returns (LOG-012)
interface ReturnRow { id: string; docNo: string; invoiceId: string; invoiceNo: string; partyName: string; warehouseCode: string; receivedOn: string; reason: string; remarks: string | null;
  transportRef: string | null; status: string; createdAt: string; createdBy: string; creditNoteId: string | null; creditNoteNo: string | null }
interface ReturnDetail extends ReturnRow { lines: { id: string; lineNo: number; description: string; packLabel: string; lotId: string; lotNo: string; packs: string; qty: string; uom: string; condition: string | null;
  disposition: string | null; decidedBy: string | null; decidedAt: string | null; decisionRemarks: string | null }[]; allowedActions: string[] }

export function CustomerReturnsPage() {
  const q = useQuery({ queryKey: ['customer-returns'], queryFn: () => api<{ data: ReturnRow[] }>('/customer-returns') });
  return (
    <>
      <PageHeader title="Customer Returns" subtitle="Goods sent back by dealers, received against the invoice into quarantine. QA restocks or rejects them; accounts credits the dealer." />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="No returns" text="Receive a return from the invoice it was sold on." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Return</th><th className={th}>Received</th><th className={th}>Dealer</th>
            <th className={th}>Invoice</th><th className={th}>Reason</th><th className={th}>Credit note</th><th className={th}>Status</th></tr></thead>
            <tbody>{q.data.data.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0"><td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/logistics/returns/${r.id}`}>{r.docNo}</Link></td>
                <td className={th}>{fmtDate(r.receivedOn)} · {r.warehouseCode}</td><td className={th}>{r.partyName}</td><td className={`${th} num`}>{r.invoiceNo}</td><td className={th}>{RETURN_REASONS[r.reason]}</td>
                <td className={`${th} num`}>{r.creditNoteNo ?? '—'}</td><td className={th}><StatusBadge status={r.status === 'Closed' ? 'Closed' : 'Pending'} label={r.status === 'Closed' ? 'Closed' : 'Awaiting QA'} /></td></tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function CustomerReturnDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['customer-return', id], queryFn: () => api<ReturnDetail>(`/customer-returns/${id}`) });
  const [pick, setPick] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Skeleton className="h-96" />;
  const r = q.data;
  if (!r) return <ErrorBanner error={q.error} />;
  const deciding = r.allowedActions.includes('decide');
  const chosen = r.lines.filter((l) => !l.disposition && pick[l.id]).map((l) => ({ lineId: l.id, disposition: pick[l.id], remarks: note[l.id] || null }));
  const decide = async () => {
    setBusy(true); setError(null);
    try { const o = await api<{ status: string }>(`/customer-returns/${id}/decide`, { body: { lines: chosen } }); toast('success', o.status === 'Closed' ? `${r.docNo} closed.` : 'Decision recorded.'); setPick({}); await qc.invalidateQueries(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={r.docNo} crumbs={<Link to="/logistics/returns" className="hover:text-primary">Customer Returns</Link>}
        subtitle={<span>{r.partyName} · against <Link className="text-primary" to={`/finance/invoices/${r.invoiceId}`}>{r.invoiceNo}</Link> · {RETURN_REASONS[r.reason]} · <StatusBadge status={r.status === 'Closed' ? 'Closed' : 'Pending'} label={r.status === 'Closed' ? 'Closed' : 'Awaiting QA'} /></span>}
        actions={deciding && <Button loading={busy} disabled={!chosen.length} onClick={decide}>Record QA decision</Button>} />
      <ErrorBanner error={error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Goods received" padded={false}>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Product and lot</th><th className={`${th} text-right`}>Packs</th>
            <th className={th}>Condition</th><th className={th}>QA decision</th></tr></thead>
            <tbody>{r.lines.map((l) => (
              <tr key={l.id} className="border-b border-line align-top last:border-0">
                <td className="px-5 py-3">{l.description} <span className="text-ink-2">{l.packLabel}</span><div className="text-[13px]">lot <Link className="text-primary" to={`/stores/lots/${l.lotId}`}>{l.lotNo}</Link> · {fmtNum(l.qty)} {l.uom}</div></td>
                <td className={`${th} text-right num`}>{fmtNum(l.packs)}</td><td className={th}>{l.condition ?? '—'}</td>
                <td className={th}>{l.disposition ? <span><StatusBadge status={l.disposition === 'Restock' ? 'Approved' : 'Rejected'} label={l.disposition === 'Restock' ? 'Restocked' : 'Rejected'} />
                  <div className="mt-1 text-[13px] text-ink-2">{l.decidedBy}, {fmtDateTime(l.decidedAt)}{l.decisionRemarks ? ` — ${l.decisionRemarks}` : ''}</div></span> : deciding ? (
                  <div className="space-y-2"><Select aria-label={`Decision for lot ${l.lotNo}`} value={pick[l.id] ?? ''} onChange={(e) => setPick({ ...pick, [l.id]: e.target.value })}>
                    <option value="">Decide…</option><option value="Restock">Restock (saleable)</option><option value="Reject">Reject (to rejected stock)</option></Select>
                    <Input aria-label={`QA remarks for lot ${l.lotNo}`} placeholder="Remarks" value={note[l.id] ?? ''} onChange={(e) => setNote({ ...note, [l.id]: e.target.value })} /></div>
                ) : <span className="text-ink-2">In quarantine</span>}</td></tr>))}</tbody></table></div>
        </Card>
        <div className="space-y-6">
          <Card title="Return">
            <KeyValues columns="narrow" items={[['Received', `${fmtDate(r.receivedOn)} into ${r.warehouseCode}`], ['By', `${r.createdBy}, ${fmtDateTime(r.createdAt)}`], ['Transport reference', r.transportRef ?? '—'],
              ['Remarks', r.remarks ?? '—'], ['Credit note', r.creditNoteId ? <Link key="c" className="text-primary" to={`/finance/credit-notes/${r.creditNoteId}`}>{r.creditNoteNo}</Link> : '—']]} />
          </Card>
          <DocumentsPanel entityType="sales.customer_return" entityId={r.id} />
        </div>
      </div>
    </>
  );
}
