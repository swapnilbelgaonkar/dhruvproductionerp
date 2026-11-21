import { INDIAN_STATES } from '@dhruv/contracts';
import { ArrowLeft, ListPlus, PaperPlaneTilt, Plus, Printer, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { Row } from '../sales/Quotations';

const state = (c?: string | null) => (c ? `${INDIAN_STATES[c] ?? c} (${c})` : '—');
const rate4 = (v: string | number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const STATUSES = ['Draft', 'Submitted', 'Approved', 'Rejected', 'Issued', 'Lapsed', 'Acknowledged', 'PartiallyReceived', 'Received', 'Closed', 'Cancelled'];

interface PoRow {
  id: string; docNo: string; partyId: string; vendorCode: string; vendorName: string; vendorGstin: string | null; legalEntityId: string; legalEntityName: string; warehouseId: string;
  warehouseCode: string; warehouseName: string; vendorState: string; placeOfSupply: string; interState: boolean; vendorGstRegistered: boolean; poDate: string; deliveryDate: string;
  paymentTermsDays: number; deliveryTerms: string; notes: string | null; rfqId: string | null; rfqNo: string | null; emergency: boolean; status: string; statusReason: string | null;
  issuedAt: string | null; ackDue: string | null; acknowledgedAt: string | null; vendorAckRef: string | null; subTotal: string; discountTotal: string; taxableTotal: string;
  cgstTotal: string; sgstTotal: string; igstTotal: string; roundOff: string; grandTotal: string; approvedAt: string | null; createdAt: string; createdByName: string; version: number;
}
interface PoLine { lineNo: number; itemId: string; itemCode: string; description: string; hsnCode: string | null; uom: string; qty: string; rate: string; discountPct: string; netRate: string;
  taxable: string; gstRate: string; cgst: string; sgst: string; igst: string; lineTotal: string; deliveryDate: string | null; requisitionLineId: string | null; requisitionId: string | null;
  requisitionNo: string | null; receivedQty: string }
interface PoDetail extends PoRow {
  lines: PoLine[]; allowedActions: string[]; eligibility: { eligible: boolean; reasons: string[] } | null;
  approval: { id: string; docNo: string; status: string; ruleName: string; steps: { seq: number; label: string; status: string }[] | null } | null;
  print: { vendor: { line1: string | null; line2: string | null; city: string | null; district: string | null; stateCode: string | null; pincode: string | null; contactPerson: string; mobile: string; email: string | null } | null;
    buyer: { name: string; address: string | null; pan: string | null; gstin: string | null; shipAddress: string | null } | null; amountInWords: string; acceptanceDays: number };
}

const columns: Column<PoRow>[] = [
  { key: 'doc', header: 'PO', render: (r) => <span className="font-semibold num">{r.docNo}{r.emergency && <span className="ml-2"><StatusBadge status="Rejected" label="Emergency" /></span>}</span> },
  { key: 'vendor', header: 'Vendor', render: (r) => <span>{r.vendorName} <span className="text-ink-2">{r.vendorCode}</span></span> },
  { key: 'date', header: 'PO date', render: (r) => <span className="num">{fmtDate(r.poDate)}</span> },
  { key: 'del', header: 'Delivery', render: (r) => <span className="num">{fmtDate(r.deliveryDate)}</span> },
  { key: 'to', header: 'Ship to', render: (r) => r.warehouseCode },
  { key: 'total', header: 'Amount', className: 'text-right', render: (r) => <span className="num font-semibold">{fmtINR(r.grandTotal)}</span> },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
];

export function PurchaseOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('purchase.order:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/purchase/orders/new')}>New purchase order</Button> : undefined;
  return (
    <>
      <PageHeader title="Purchase Orders" subtitle="Approval by value (D06): purchase head; finance head from ₹1 lakh; executive director above ₹10 lakh. The vendor must acknowledge an issued PO within the acceptance period." actions={create} />
      <DataTable<PoRow> queryKey="purchase-orders" path="/purchase-orders" columns={columns} rowHref={(r) => `/purchase/orders/${r.id}`} statusOptions={STATUSES}
        searchPlaceholder="Search PO number or vendor"
        empty={{ title: 'No purchase orders yet', text: 'Raise one from an approved requisition, award an RFQ, or order directly from an approved vendor.', action: create }} />
    </>
  );
}

// ---------------------------------------------------------------- editor
interface OpenLine { id: string; requisitionId: string; requisitionNo: string; priority: string; warehouseId: string; legalEntityId: string; itemId: string; itemCode: string; itemName: string;
  uom: string; qty: string; remaining: string; estimatedRate: string | null; requiredBy: string; suggestedVendorId: string | null; suggestedVendor: string | null }
interface DraftLine { key: number; itemId: string; qty: string; rate: string; discountPct: string; deliveryDate: string; requisitionLineId: string; prLabel: string }
interface Calc { lines: { itemId: string; description: string; uom: string; netRate: number; taxable: number; gstRate: number; cgst: number; sgst: number; igst: number; lineTotal: number }[];
  totals: Record<string, number>; interState: boolean; vendorState: string; placeOfSupply: string; gstApplies: boolean; warnings: string[]; amountInWords: string }
let k = 0;
const blank = (): DraftLine => ({ key: ++k, itemId: '', qty: '', rate: '', discountPct: '', deliveryDate: '', requisitionLineId: '', prLabel: '' });
function useDebounced<T>(v: T, ms = 400) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]); return d; }

export function PurchaseOrderFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['purchase-order', id], enabled: editing, queryFn: () => api<PoDetail>(`/purchase-orders/${id}`) });
  const defaults = useQuery({ queryKey: ['po-defaults'], queryFn: () => api<{ deliveryTerms: string; acceptanceDays: number; today: string }>('/purchase-orders/defaults') });
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/legal-entities?status=Active&limit=100') });
  const vendors = useQuery({ queryKey: ['vendors-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string; paymentTermsDays: number }>>('/vendors?status=Active&limit=100') });
  const [h, setH] = useState({ partyId: '', legalEntityId: '', warehouseId: '', deliveryDate: '', paymentTermsDays: '30', deliveryTerms: '', notes: '', emergency: false });
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const warehouses = useQuery({ queryKey: ['warehouses', h.legalEntityId], enabled: !!h.legalEntityId,
    queryFn: () => api<Page<{ id: string; code: string; name: string; type: string; stateCode: string | null }>>(`/warehouses?status=Active&limit=100&legalEntityId=${h.legalEntityId}`) });
  const vendor = useQuery({ queryKey: ['vendor', h.partyId], enabled: !!h.partyId,
    queryFn: () => api<{ id: string; paymentTermsDays: number; items: { itemId: string; itemCode: string; itemName: string; uom: string; leadTimeDays: number }[] }>(`/vendors/${h.partyId}`) });
  const open = useQuery({ queryKey: ['open-pr-lines', h.legalEntityId], enabled: !!h.legalEntityId,
    queryFn: () => api<{ data: OpenLine[] }>(`/purchase-orders/open-requisition-lines?legalEntityId=${h.legalEntityId}`) });

  // initialise: existing PO, or defaults (optionally pre-filled from a requisition)
  useEffect(() => {
    if (loaded) return;
    if (editing) {
      if (!existing.data) return;
      const o = existing.data;
      setH({ partyId: o.partyId, legalEntityId: o.legalEntityId, warehouseId: o.warehouseId, deliveryDate: o.deliveryDate, paymentTermsDays: String(o.paymentTermsDays),
        deliveryTerms: o.deliveryTerms, notes: o.notes ?? '', emergency: o.emergency });
      setLines(o.lines.map((l) => ({ key: ++k, itemId: l.itemId, qty: String(Number(l.qty)), rate: String(Number(l.rate)), discountPct: Number(l.discountPct) ? String(Number(l.discountPct)) : '',
        deliveryDate: l.deliveryDate ?? '', requisitionLineId: l.requisitionLineId ?? '', prLabel: l.requisitionNo ?? '' })));
      setLoaded(true);
    } else if (defaults.data) {
      setH((x) => ({ ...x, deliveryTerms: defaults.data.deliveryTerms, partyId: params.get('vendorId') ?? '' }));
      setLines(params.get('requisitionId') ? [] : [blank()]);
      setLoaded(true);
    }
  }, [editing, existing.data, defaults.data, loaded, params]);
  useEffect(() => { if (!h.legalEntityId && entities.data?.data.length === 1) setH((x) => ({ ...x, legalEntityId: entities.data!.data[0]!.id })); }, [entities.data, h.legalEntityId]);
  useEffect(() => { if (!editing && vendor.data) setH((x) => ({ ...x, paymentTermsDays: String(vendor.data!.paymentTermsDays) })); }, [vendor.data, editing]);
  // pre-fill from ?requisitionId= once its open lines are known
  const prefill = params.get('requisitionId');
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (editing || prefilled || !prefill || !open.data) return;
    const ls = open.data.data.filter((l) => l.requisitionId === prefill);
    if (ls.length) {
      setLines(ls.map((l) => fromOpen(l)));
      setH((x) => ({ ...x, warehouseId: x.warehouseId || ls[0]!.warehouseId, deliveryDate: x.deliveryDate || ls[0]!.requiredBy, partyId: x.partyId || (ls[0]!.suggestedVendorId ?? '') }));
    }
    setPrefilled(true);
  }, [open.data, prefill, prefilled, editing]);

  const body = useMemo(() => ({
    partyId: h.partyId, legalEntityId: h.legalEntityId, warehouseId: h.warehouseId, deliveryDate: h.deliveryDate, paymentTermsDays: Number(h.paymentTermsDays || 0),
    deliveryTerms: h.deliveryTerms, notes: h.notes || null, emergency: h.emergency,
    lines: lines.filter((l) => l.itemId && Number(l.qty) > 0 && Number(l.rate) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty), rate: Number(l.rate),
      discountPct: Number(l.discountPct || 0), deliveryDate: l.deliveryDate || null, requisitionLineId: l.requisitionLineId || null })),
  }), [h, lines]);
  const ready = !!(body.partyId && body.legalEntityId && body.warehouseId && body.deliveryDate && body.deliveryTerms && body.lines.length);
  const debounced = useDebounced(body);
  const calc = useQuery({ queryKey: ['po-calc', debounced, id], enabled: ready, retry: false, placeholderData: (p) => p,
    queryFn: () => api<Calc>(`/purchase-orders/calculate${editing ? `?excludeId=${id}` : ''}`, { body: debounced }) });
  const byItem = new Map((calc.data?.lines ?? []).map((l) => [l.itemId, l]));
  const dup = new Set(lines.map((l) => l.itemId).filter((x, i, a) => x && a.indexOf(x) !== i));

  if ((editing && existing.isLoading) || !loaded) return <Skeleton className="h-96" />;
  if (editing && existing.data && !existing.data.allowedActions.includes('edit')) return <Card><EmptyState title="This purchase order cannot be edited" text={`It is ${existing.data.status}.`} /></Card>;
  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const supplied = vendor.data?.items ?? [];
  const t = calc.data?.totals;
  const save = async () => {
    setError(null); setSaving(true);
    try {
      if (editing) { await api(`/purchase-orders/${id}`, { method: 'PUT', body: { ...body, version: existing.data!.version } }); toast('success', 'Purchase order saved.'); await qc.invalidateQueries(); nav(`/purchase/orders/${id}`); }
      else { const r = await api<{ id: string; docNo: string }>('/purchase-orders', { body }); toast('success', `Saved as Draft ${r.docNo}.`); nav(`/purchase/orders/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data!.docNo}` : 'New purchase order'} crumbs={<Link to="/purchase/orders" className="hover:text-primary">Purchase Orders</Link>}
        subtitle="Order from an approved vendor, for items it is approved to supply. Linking requisition lines keeps their ordered quantity up to date." />
      <ErrorBanner error={error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card title="Vendor and delivery">
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="Vendor" htmlFor="po-vendor" required hint="Active vendors only">
                <Select id="po-vendor" value={h.partyId} disabled={editing} onChange={(e) => setH((x) => ({ ...x, partyId: e.target.value }))}>
                  <option value="">Select…</option>{(vendors.data?.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.legalName} — {v.code}</option>)}</Select></Field>
              <Field label="Legal entity" htmlFor="po-le" required><Select id="po-le" value={h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, legalEntityId: e.target.value, warehouseId: '' }))}>
                <option value="">Select…</option>{(entities.data?.data ?? []).map((le) => <option key={le.id} value={le.id}>{le.code} — {le.name}</option>)}</Select></Field>
              <Field label="Ship to (warehouse)" htmlFor="po-wh" required hint="Its state decides CGST+SGST or IGST"><Select id="po-wh" value={h.warehouseId} disabled={!h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, warehouseId: e.target.value }))}>
                <option value="">Select…</option>{(warehouses.data?.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name} ({w.type})</option>)}</Select></Field>
              <Field label="Delivery date" htmlFor="po-del" required><Input id="po-del" type="date" min={defaults.data?.today} value={h.deliveryDate} onChange={(e) => setH((x) => ({ ...x, deliveryDate: e.target.value }))} /></Field>
              <Field label="Payment terms (days)" htmlFor="po-pay" required><Input id="po-pay" type="number" min={0} max={180} value={h.paymentTermsDays} onChange={(e) => setH((x) => ({ ...x, paymentTermsDays: e.target.value }))} /></Field>
              <label className="flex items-center gap-3 self-end py-3 text-[14px]"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={h.emergency} onChange={(e) => setH((x) => ({ ...x, emergency: e.target.checked }))} />
                Emergency purchase — purchase head approves now; finance head reviews afterwards</label>
              <div className="md:col-span-2"><Field label="Delivery terms" htmlFor="po-terms" required><Textarea id="po-terms" rows={2} maxLength={300} value={h.deliveryTerms} onChange={(e) => setH((x) => ({ ...x, deliveryTerms: e.target.value }))} /></Field></div>
              <div className="md:col-span-2"><Field label="Notes printed on the PO" htmlFor="po-notes"><Textarea id="po-notes" rows={2} maxLength={1000} value={h.notes} onChange={(e) => setH((x) => ({ ...x, notes: e.target.value }))} /></Field></div>
            </div>
          </Card>
          <Card title="Items" padded={false} actions={<div className="flex gap-2">
            <Button size="sm" variant="secondary" icon={<ListPlus size={16} />} disabled={!h.legalEntityId} onClick={() => setPicker(true)}>From requisitions</Button>
            <Button size="sm" variant="secondary" icon={<Plus size={16} />} disabled={lines.length >= 100} onClick={() => setLines([...lines, blank()])}>Add line</Button></div>}>
            {lines.length === 0 ? <p className="px-6 pb-6 text-ink-2">Add lines from approved requisitions, or add an item the vendor supplies.</p> : (
              <div className="overflow-x-auto"><table className="w-full min-w-[1000px] text-[14px]">
                <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                  <th className="px-5 py-3">Item</th><th className="w-28 px-2 py-3">Quantity</th><th className="w-28 px-2 py-3">Rate (₹/unit)</th><th className="w-20 px-2 py-3">Disc. %</th>
                  <th className="w-40 px-2 py-3">Line delivery</th><th className="px-2 py-3 text-right">Taxable</th><th className="px-2 py-3 text-right">GST</th><th className="px-2 py-3 text-right">Amount</th><th className="px-3 py-3" /></tr></thead>
                <tbody>{lines.map((l, i) => {
                  const c = byItem.get(l.itemId);
                  return (
                    <tr key={l.key} className="border-b border-line align-top last:border-0">
                      <td className="px-5 py-2">
                        <Select aria-label={`Item for line ${i + 1}`} value={l.itemId} disabled={!!l.requisitionLineId || !h.partyId} invalid={dup.has(l.itemId)} onChange={(e) => setLine(l.key, { itemId: e.target.value })}>
                          <option value="">{h.partyId ? 'Select…' : 'Choose the vendor first'}</option>
                          {supplied.map((x) => <option key={x.itemId} value={x.itemId}>{x.itemCode} — {x.itemName}</option>)}
                          {l.itemId && !supplied.some((x) => x.itemId === l.itemId) && <option value={l.itemId}>{c?.description ?? 'Item not approved for this vendor'}</option>}
                        </Select>
                        {l.prLabel && <p className="mt-1 text-[12px] text-ink-2">From {l.prLabel}</p>}
                        {dup.has(l.itemId) && <p className="mt-1 text-[12px] text-danger-text">Already on another line.</p>}
                      </td>
                      <td className="px-2 py-2"><div className="flex items-center gap-1"><Input aria-label={`Quantity for line ${i + 1}`} type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} /><span className="text-[12px] text-ink-2">{c?.uom}</span></div></td>
                      <td className="px-2 py-2"><Input aria-label={`Rate for line ${i + 1}`} type="number" min="0" step="0.0001" value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} /></td>
                      <td className="px-2 py-2"><Input aria-label={`Discount for line ${i + 1}`} type="number" min="0" max="100" step="0.01" placeholder="0" value={l.discountPct} onChange={(e) => setLine(l.key, { discountPct: e.target.value })} /></td>
                      <td className="px-2 py-2"><Input aria-label={`Delivery date for line ${i + 1}`} type="date" value={l.deliveryDate} onChange={(e) => setLine(l.key, { deliveryDate: e.target.value })} /></td>
                      <td className="px-2 py-2 pt-4 text-right num">{c ? fmtINR(c.taxable) : '—'}</td>
                      <td className="px-2 py-2 pt-4 text-right num">{c ? `${fmtNum(c.gstRate)}%` : '—'}</td>
                      <td className="px-2 py-2 pt-4 text-right num font-semibold">{c ? fmtINR(c.lineTotal) : '—'}</td>
                      <td className="px-3 py-2"><Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash size={16} /></Button></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        <aside className="space-y-6 xl:sticky xl:top-24 xl:self-start">
          <Card title="Summary">
            {!ready ? <p className="text-ink-2">Choose the vendor, ship-to warehouse, delivery date and at least one priced line.</p>
              : calc.error ? <p className="rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger-text">{calc.error instanceof ApiError ? calc.error.message : 'Could not calculate.'}</p>
              : !t ? <Skeleton className="h-40" /> : (
                <dl className="space-y-2 text-[14px]">
                  <Row k="At quoted rates" v={fmtINR(t.subTotal!)} />
                  <Row k="Discount" v={`− ${fmtINR(t.discountTotal!)}`} />
                  <Row k="Taxable value" v={fmtINR(t.taxableTotal!)} strong />
                  {!calc.data!.gstApplies ? <Row k="GST" v="Vendor not GST registered" /> : calc.data!.interState ? <Row k="IGST" v={fmtINR(t.igstTotal!)} /> : <><Row k="CGST" v={fmtINR(t.cgstTotal!)} /><Row k="SGST" v={fmtINR(t.sgstTotal!)} /></>}
                  <Row k="Round-off" v={fmtINR(t.roundOff!)} />
                  <div className="border-t border-line pt-3"><Row k="Total" v={fmtINR(t.grandTotal!)} strong big /></div>
                  <p className="pt-1 text-[12px] text-ink-2">{calc.data!.amountInWords}</p>
                  <p className="text-[12px] text-ink-2">Vendor {state(calc.data!.vendorState)} → ship to {state(calc.data!.placeOfSupply)} · {calc.data!.interState ? 'IGST' : 'CGST + SGST'}</p>
                  <p className="rounded-md bg-canvas px-3 py-2 text-[13px]">Approval: {h.emergency ? 'purchase head (emergency); finance head reviews afterwards' : t.grandTotal! > 1000000 ? 'purchase head → finance head → executive director'
                    : t.grandTotal! > 100000 ? 'purchase head → finance head' : 'purchase head'}</p>
                  {calc.data!.warnings.length > 0 && <div className="rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger-text">Cannot be saved: {calc.data!.warnings.join('; ')}.</div>}
                </dl>
              )}
            <div className="mt-5 flex gap-2">
              <Button loading={saving} disabled={!ready || dup.size > 0} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button>
              <Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button>
            </div>
          </Card>
        </aside>
      </div>
      <Modal open={picker} onClose={() => setPicker(false)} title="Add from approved requisitions" width={860} description="Quantities still to be ordered. Pick the lines this vendor should supply.">
        {(open.data?.data ?? []).length === 0 ? <p className="text-ink-2">No approved requisition lines are waiting to be ordered.</p> : (
          <ul className="divide-y divide-line">{open.data!.data.map((l) => {
            const added = lines.some((x) => x.requisitionLineId === l.id);
            const ok = supplied.some((s) => s.itemId === l.itemId);
            return (
              <li key={l.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1"><span className="font-semibold num">{l.requisitionNo}</span> · {l.itemCode} {l.itemName}
                  <span className="block text-[13px] text-ink-2">{fmtNum(Number(l.remaining))} {l.uom} to order · needed by {fmtDate(l.requiredBy)}{l.suggestedVendor ? ` · suggested: ${l.suggestedVendor}` : ''}{l.priority !== 'NORMAL' ? ` · ${l.priority}` : ''}</span></span>
                {!ok && h.partyId && <span className="text-[13px] text-warning-text">Vendor not approved for this item</span>}
                <Button size="sm" variant="secondary" disabled={added} onClick={() => { setLines((ls) => [...ls.filter((x) => x.itemId || x.qty), fromOpen(l)]); if (!h.warehouseId) setH((x) => ({ ...x, warehouseId: l.warehouseId })); }}>{added ? 'Added' : 'Add'}</Button>
              </li>
            );
          })}</ul>
        )}
      </Modal>
    </>
  );
}
const fromOpen = (l: OpenLine): DraftLine => ({ key: ++k, itemId: l.itemId, qty: String(Number(l.remaining)), rate: l.estimatedRate ? String(Number(l.estimatedRate)) : '', discountPct: '',
  deliveryDate: l.requiredBy, requisitionLineId: l.id, prLabel: l.requisitionNo });

// ---------------------------------------------------------------- detail
export function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [close, setClose] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api<PoDetail>(`/purchase-orders/${id}`) });
  const [cancel, setCancel] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; ok: string; body?: object }) => api<{ status?: string; approvalDocNo?: string; ackDue?: string }>(`/purchase-orders/${id}/${path}`, { method: 'POST', body: body ?? {} }),
    onSuccess: async (r, v) => { toast('success', v.path === 'submit' ? (r.status === 'Approved' ? 'Approved.' : `Sent for approval as ${r.approvalDocNo}.`) : v.path.includes('issue') ? `Issued. The vendor must acknowledge by ${fmtDate(r.ackDue)}.` : v.ok); setAck(null); await qc.invalidateQueries(); },
  });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const busy = (p: string) => act.isPending && act.variables?.path === p;
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/purchase/orders" className="hover:text-primary">Purchase Orders</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status} />{d.emergency && <StatusBadge status="Rejected" label="Emergency" />}<span>{d.vendorName} · {fmtINR(d.grandTotal)} · deliver by {fmtDate(d.deliveryDate)}</span></span>}
        actions={<>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => nav(`/purchase/orders/${id}/print`)}>Print / PDF</Button>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/purchase/orders/${id}/edit`)}>Edit</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel PO</Button>}
          {a.includes('submit') && <Button loading={busy('submit')} onClick={() => act.mutate({ path: 'submit', ok: '' })}>Submit for approval</Button>}
          {a.includes('issue') && <Button icon={<PaperPlaneTilt size={18} />} loading={busy('issue')} onClick={() => act.mutate({ path: 'issue', ok: '' })}>Issue to vendor</Button>}
          {a.includes('reissue') && <Button icon={<PaperPlaneTilt size={18} />} loading={busy('reissue')} onClick={() => act.mutate({ path: 'reissue', ok: '' })}>Re-issue</Button>}
          {a.includes('acknowledge') && <Button onClick={() => setAck('')}>Record acknowledgement</Button>}
          {a.includes('close') && <Button variant="secondary" onClick={() => setClose(true)}>Close balance</Button>}
          {['Issued', 'Acknowledged', 'PartiallyReceived'].includes(d.status) && can('purchase.grn:create') && <Button onClick={() => nav(`/stores/receipts/new?poId=${id}`)}>Receive goods</Button>}
        </>} />
      <ErrorBanner error={act.error} />
      {d.status === 'Submitted' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Waiting for approval{d.approval ? <> — <Link className="font-semibold underline" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link></> : null}.</div>}
      {d.status === 'Issued' && <div className="mb-6 rounded-md bg-primary-soft px-4 py-3 text-primary-hover">Issued {fmtDateTime(d.issuedAt)}. Waiting for the vendor to acknowledge by <span className="font-semibold">{fmtDate(d.ackDue)}</span>; if not, it lapses and must be re-issued (PUR-013).</div>}
      {d.status === 'Lapsed' && <div className="mb-6 rounded-md bg-danger-bg px-4 py-3 text-danger-text">The vendor did not acknowledge by {fmtDate(d.ackDue)}. Re-issue it (after confirming with the vendor) or cancel it.</div>}
      {d.eligibility && !d.eligibility.eligible && <div className="mb-6 rounded-md bg-danger-bg px-4 py-3 text-danger-text">The vendor cannot be ordered from now: {d.eligibility.reasons.join('; ')}.</div>}
      {d.statusReason && ['Cancelled', 'Rejected'].includes(d.status) && <div className="mb-6 rounded-md bg-neutral-bg px-4 py-3 text-neutral-text">{d.status}: {d.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Details">
          <KeyValues items={[
            ['Vendor', <Link key="v" className="font-semibold text-primary" to={`/purchase/vendors/${d.partyId}`}>{d.vendorName} ({d.vendorCode})</Link>], ['Vendor GSTIN', d.vendorGstin ?? 'Not registered — no GST charged'],
            ['Ship to', `${d.warehouseCode} — ${d.warehouseName}`], ['Tax', `${state(d.vendorState)} → ${state(d.placeOfSupply)} · ${!d.vendorGstRegistered ? 'no GST' : d.interState ? 'IGST' : 'CGST + SGST'}`],
            ['PO date', fmtDate(d.poDate)], ['Delivery date', fmtDate(d.deliveryDate)], ['Payment terms', `${d.paymentTermsDays} days`], ['Delivery terms', d.deliveryTerms],
            ['Raised by', `${d.createdByName}, ${fmtDateTime(d.createdAt)}`], ['Source', d.rfqId ? <Link key="r" className="text-primary" to={`/purchase/rfqs/${d.rfqId}`}>{d.rfqNo}</Link> : 'Direct'],
            ['Acknowledged', d.acknowledgedAt ? `${fmtDateTime(d.acknowledgedAt)} — ${d.vendorAckRef}` : '—'], ['Notes', d.notes],
          ]} />
        </Card>
        <aside className="space-y-6">
          <Card title="Amount">
            <dl className="space-y-2 text-[14px]">
              <Row k="Taxable value" v={fmtINR(d.taxableTotal)} strong />
              {d.interState ? <Row k="IGST" v={fmtINR(d.igstTotal)} /> : <><Row k="CGST" v={fmtINR(d.cgstTotal)} /><Row k="SGST" v={fmtINR(d.sgstTotal)} /></>}
              <Row k="Round-off" v={fmtINR(d.roundOff)} />
              <div className="border-t border-line pt-3"><Row k="Total" v={fmtINR(d.grandTotal)} strong big /></div>
              <p className="pt-1 text-[12px] text-ink-2">{d.print.amountInWords}</p>
            </dl>
          </Card>
          <Card title="Approval">
            {!d.approval ? <p className="text-ink-2">Not submitted yet.</p> : (
              <>
                <p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link> · {d.approval.ruleName}</p>
                <ol className="space-y-2">{(d.approval.steps ?? []).map((s) => <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>)}</ol>
              </>
            )}
          </Card>
        </aside>
      </div>
      <Card title="Items" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[960px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">#</th><th className="px-3 py-3">Item</th><th className="px-3 py-3 text-right">Quantity</th><th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3 text-right">Disc.</th>
            <th className="px-3 py-3 text-right">Taxable</th><th className="px-3 py-3 text-right">GST</th><th className="px-3 py-3 text-right">Amount</th><th className="px-3 py-3">Requisition</th><th className="px-3 py-3 text-right">Received</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-line align-top last:border-0">
              <td className="px-5 py-3">{l.lineNo}</td><td className="px-3 py-3"><span className="font-semibold">{l.itemCode}</span><br /><span className="text-ink-2">{l.description}{l.hsnCode ? ` · HSN ${l.hsnCode}` : ''}</span></td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.qty))} {l.uom}</td><td className="px-3 py-3 text-right num">{rate4(l.rate)}</td>
              <td className="px-3 py-3 text-right num">{Number(l.discountPct) ? `${fmtNum(Number(l.discountPct))}%` : '—'}</td><td className="px-3 py-3 text-right num">{fmtINR(l.taxable)}</td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.gstRate))}%</td><td className="px-3 py-3 text-right num font-semibold">{fmtINR(l.lineTotal)}</td>
              <td className="px-3 py-3">{l.requisitionId ? <Link className="text-primary" to={`/purchase/requisitions/${l.requisitionId}`}>{l.requisitionNo}</Link> : '—'}</td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.receivedQty))}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      <Modal open={ack !== null} onClose={() => setAck(null)} title="Vendor acknowledgement" width={520} description="Record how the vendor confirmed the order (email, signed copy, portal reference)."
        footer={<><Button variant="secondary" onClick={() => setAck(null)}>Cancel</Button><Button loading={busy('acknowledge')} disabled={!ack?.trim()} onClick={() => act.mutate({ path: 'acknowledge', ok: 'Acknowledgement recorded.', body: { vendorAckRef: ack } })}>Record</Button></>}>
        <ErrorBanner error={act.error} />
        <Field label="Vendor's confirmation reference" htmlFor="ack-ref" required><Input id="ack-ref" maxLength={100} value={ack ?? ''} onChange={(e) => setAck(e.target.value)} /></Field>
      </Modal>
      <ReasonDialog open={close} title={`Close the balance of ${d.docNo}`} confirmLabel="Close PO" onClose={() => setClose(false)}
        description="No more deliveries are expected; the quantity not yet received is closed (PUR-007)."
        onConfirm={async (reason) => { await api(`/purchase-orders/${id}/close`, { body: { reason } }); toast('success', 'Purchase order closed.'); await qc.invalidateQueries(); }} />
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel PO" onClose={() => setCancel(false)} description="Linked requisition quantities become open to order again."
        onConfirm={async (reason) => { await api(`/purchase-orders/${id}/cancel`, { body: { reason } }); toast('success', 'Purchase order cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}

// ---------------------------------------------------------------- A4 print
export function PurchaseOrderPrintPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api<PoDetail>(`/purchase-orders/${id}`) });
  const d = q.data;
  useEffect(() => { if (d) document.title = d.docNo.replace(/\//g, '-'); return () => { document.title = 'Dhruv Agro ERP'; }; }, [d]);
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (!d) return <div className="p-8"><ErrorBanner error={q.error} /></div>;
  const b = d.print.buyer; const v = d.print.vendor;
  const valid = ['Approved', 'Issued', 'Acknowledged', 'PartiallyReceived', 'Received', 'Closed'].includes(d.status);
  const cell = 'px-1.5 py-1.5';
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-3 px-4 py-4 print:hidden">
        <Link to={`/purchase/orders/${id}`} className="inline-flex items-center gap-2 font-semibold text-primary"><ArrowLeft size={18} /> Back to purchase order</Link>
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="mx-auto mb-8 max-w-[210mm] bg-white p-[12mm] text-[12px] text-ink shadow-card print:m-0 print:max-w-none print:p-0 print:shadow-none">
        {!valid && <div className="mb-4 rounded border-2 border-danger-text px-3 py-2 text-center font-bold uppercase tracking-wide text-danger-text">{d.status} — not an approved purchase order</div>}
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-3">
          <div><h1 className="text-[18px] font-extrabold">{b?.name ?? d.legalEntityName}</h1>{b?.address && <p className="max-w-[95mm] whitespace-pre-line">{b.address}</p>}
            <p>{b?.gstin ? `GSTIN ${b.gstin}` : 'GSTIN not registered for the ship-to state'}{b?.pan ? ` · PAN ${b.pan}` : ''}</p></div>
          <div className="text-right"><p className="text-[20px] font-extrabold tracking-wide">PURCHASE ORDER</p><p className="num font-semibold">{d.docNo}</p>
            <p>Date {fmtDate(d.poDate)}</p><p>Deliver by {fmtDate(d.deliveryDate)}</p>{d.emergency && <p className="font-semibold">Emergency order</p>}</div>
        </header>
        <section className="grid grid-cols-2 gap-6 border-b border-line py-3">
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Vendor</p><p className="font-semibold">{d.vendorName}</p>
            {v && <p>{[v.line1, v.line2, v.city, v.district, v.stateCode ? `${INDIAN_STATES[v.stateCode] ?? v.stateCode} ${v.pincode ?? ''}` : null].filter(Boolean).join(', ')}</p>}
            <p>{d.vendorGstin ? `GSTIN ${d.vendorGstin}` : 'Not GST registered'}</p>{v && <p>Attn: {v.contactPerson} · {v.mobile}{v.email ? ` · ${v.email}` : ''}</p>}</div>
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Ship to</p><p className="font-semibold">{d.warehouseCode} — {d.warehouseName}</p>{b?.shipAddress && <p className="whitespace-pre-line">{b.shipAddress}</p>}
            <p>Place of supply: {state(d.placeOfSupply)}</p></div>
        </section>
        <table className="my-3 w-full text-[11px]">
          <thead><tr className="border-b border-line text-left text-[10px] uppercase text-ink-2"><th className={cell}>#</th><th className={cell}>Item</th><th className={cell}>HSN</th><th className={`${cell} text-right`}>Qty</th>
            <th className={`${cell} text-right`}>Rate</th><th className={`${cell} text-right`}>Disc.</th><th className={`${cell} text-right`}>Taxable</th><th className={`${cell} text-right`}>GST</th><th className={`${cell} text-right`}>Amount</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-line align-top"><td className={cell}>{l.lineNo}</td><td className={cell}><span className="font-semibold">{l.itemCode}</span> {l.description}{l.deliveryDate ? ` (by ${fmtDate(l.deliveryDate)})` : ''}</td>
              <td className={`${cell} num`}>{l.hsnCode ?? '—'}</td><td className={`${cell} text-right num`}>{fmtNum(Number(l.qty))} {l.uom}</td><td className={`${cell} text-right num`}>{rate4(l.rate)}</td>
              <td className={`${cell} text-right num`}>{Number(l.discountPct) ? `${fmtNum(Number(l.discountPct))}%` : '—'}</td><td className={`${cell} text-right num`}>{fmtINR(l.taxable)}</td>
              <td className={`${cell} text-right num`}>{fmtNum(Number(l.gstRate))}%</td><td className={`${cell} text-right num font-semibold`}>{fmtINR(l.lineTotal)}</td></tr>))}</tbody>
        </table>
        <section className="flex justify-between gap-6 border-t border-line pt-3">
          <div className="max-w-[105mm] space-y-2">
            <p><span className="font-semibold">Amount in words:</span> {d.print.amountInWords}</p>
            <p><span className="font-semibold">Payment terms:</span> {d.paymentTermsDays} days from receipt of goods and a valid tax invoice.</p>
            <p><span className="font-semibold">Delivery terms:</span> {d.deliveryTerms}</p>
            {d.notes && <p><span className="font-semibold">Notes:</span> {d.notes}</p>}
            <p className="font-semibold">Please acknowledge this order within {d.print.acceptanceDays} days of issue{d.ackDue ? ` (by ${fmtDate(d.ackDue)})` : ''}; an unacknowledged order lapses.</p>
            <p className="text-ink-2">Quote the PO number on the delivery challan and tax invoice. Goods are subject to inspection and QC release at our store; quantities beyond the order are not accepted.</p>
          </div>
          <dl className="w-[70mm] space-y-1">
            <Row k="Taxable value" v={fmtINR(d.taxableTotal)} strong />
            {d.interState ? <Row k="IGST" v={fmtINR(d.igstTotal)} /> : <><Row k="CGST" v={fmtINR(d.cgstTotal)} /><Row k="SGST" v={fmtINR(d.sgstTotal)} /></>}
            <Row k="Round-off" v={fmtINR(d.roundOff)} />
            <div className="border-t-2 border-ink pt-1"><Row k="Total" v={fmtINR(d.grandTotal)} strong big /></div>
          </dl>
        </section>
        <footer className="mt-10 flex justify-between">
          <div className="text-center"><div className="h-12" /><p className="border-t border-ink px-8 pt-1">Vendor's acceptance (sign and stamp)</p></div>
          <div className="text-center"><p>For {b?.name ?? d.legalEntityName}</p><div className="h-12" /><p className="border-t border-ink px-8 pt-1">Authorised signatory</p></div>
        </footer>
      </article>
    </div>
  );
}
