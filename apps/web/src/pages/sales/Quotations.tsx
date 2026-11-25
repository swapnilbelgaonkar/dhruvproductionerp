import { INDIAN_STATES } from '@dhruv/contracts';
import { ArrowLeft, Copy, PaperPlaneTilt, Plus, Printer, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';
import { packLabel } from './PriceLists';

// ------------------------------------------------------------------ types
export interface Address { id: string; kind: string; label: string | null; line1: string; line2: string | null; city: string; district: string; stateCode: string; pincode: string }
export interface Line {
  lineNo: number; itemPackId: string; itemCode: string; description: string; hsnCode: string; packLabel: string; qty: string | number; listRate: string | number;
  schemeDiscountPct: string | number; extraDiscountPct: string | number; rate: string | number; taxable: string | number; gstRate: string | number;
  cgst: string | number; sgst: string | number; igst: string | number; lineTotal: string | number;
}
export interface Totals { subTotal: number | string; discountTotal: number | string; taxableTotal: number | string; cgstTotal: number | string; sgstTotal: number | string; igstTotal: number | string; roundOff: number | string; grandTotal: number | string }
interface QuoteRow extends Totals {
  id: string; docNo: string; revision: number; partyId: string; partyCode: string; partyName: string; partyGstin: string | null; legalEntityId: string; legalEntityName: string;
  billToId: string; shipToId: string; placeOfSupply: string; sellerState: string; interState: boolean; quoteDate: string; validUntil: string; priceListCode: string | null;
  contactPerson: string | null; paymentTerms: string; deliveryTerms: string; notes: string | null; salesOwner: string; territory: string; opportunityId: string | null;
  opportunityCode: string | null; status: string; statusReason: string | null; needsApproval: boolean; maxExtraDiscount: string; createdAt: string; updatedAt: string; version: number;
}
interface QuoteDetail extends QuoteRow {
  lines: Line[]; allowedActions: string[]; billTo: Address | null; shipTo: Address | null;
  revisions: { id: string; revision: number; status: string; grandTotal: string; createdAt: string }[];
  approval: { id: string; docNo: string; status: string; ruleName: string; steps: { seq: number; label: string; kind: string; status: string }[] | null } | null;
  salesOrder?: { id: string; docNo: string; status: string } | null;
  print: { seller: { name: string; address: string | null; pan: string | null; gstin: string | null } | null; bankDetails: string; amountInWords: string };
}
interface PricedPack { id: string; itemCode: string; itemName: string; packCode: string; packSize: string; packUom: string; container: string; rate: string; priceListCode: string; slabs: { minQty: string; discountPct: string }[] }
interface Calc { lines: Line[]; totals: Totals; interState: boolean; placeOfSupply: string; validUntil: string; maxExtraDiscount: number; warnings: string[]; amountInWords: string }

const STATUSES = ['Draft', 'Submitted', 'Approved', 'Sent', 'Accepted', 'Converted', 'Rejected', 'Expired', 'Cancelled', 'Superseded'];
export const state = (c?: string | null) => (c ? `${INDIAN_STATES[c] ?? c} (${c})` : '—');
export const addressText = (a: Address | null | undefined) => (a ? [a.line1, a.line2, a.city, a.district, `${INDIAN_STATES[a.stateCode] ?? a.stateCode} ${a.pincode}`].filter(Boolean).join(', ') : '—');
const addrLabel = (a: Address) => `${a.kind === 'REGISTERED' ? 'Registered' : a.kind === 'BILLING' ? 'Billing' : `Shipping${a.label ? ` — ${a.label}` : ''}`}: ${a.city}, ${INDIAN_STATES[a.stateCode] ?? a.stateCode}`;
const pct = (v: string | number) => (Number(v) ? `${fmtNum(Number(v))}%` : '—');

// ------------------------------------------------------------------ register
const columns: Column<QuoteRow>[] = [
  { key: 'doc', header: 'Quotation', render: (r) => <span className="font-semibold num">{r.docNo} <span className="text-ink-2">R{r.revision}</span></span> },
  { key: 'dealer', header: 'Dealer', render: (r) => <span>{r.partyName} <span className="text-ink-2">{r.partyCode}</span></span> },
  { key: 'date', header: 'Date', render: (r) => <span className="num">{fmtDate(r.quoteDate)}</span> },
  { key: 'valid', header: 'Valid until', render: (r) => <span className="num">{fmtDate(r.validUntil)}</span> },
  { key: 'total', header: 'Amount', className: 'text-right', render: (r) => <span className="num font-semibold">{fmtINR(r.grandTotal)}</span> },
  { key: 'owner', header: 'Sales owner', render: (r) => r.salesOwner },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
];

export function QuotationsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('sales.quotation:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/sales/quotations/new')}>New quotation</Button> : undefined;
  return (
    <>
      <PageHeader title="Quotations" subtitle="Priced from the approved price list of each dealer’s price group, with GST from the HSN rate. Extra discount needs approval." actions={create} />
      <DataTable<QuoteRow> queryKey="quotations" path="/quotations" columns={columns} rowHref={(r) => `/sales/quotations/${r.id}`} statusOptions={STATUSES}
        searchPlaceholder="Search number or dealer"
        empty={{ title: 'No quotations yet', text: 'Create a quotation for an active dealer. Prices come from the approved price list.', action: create }} />
    </>
  );
}

// ------------------------------------------------------------------ editor
interface DraftLine { key: number; itemPackId: string; qty: string; extraDiscountPct: string }
let lineKey = 0;
const newLine = (): DraftLine => ({ key: ++lineKey, itemPackId: '', qty: '', extraDiscountPct: '' });

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** The two sales documents share one editor (MP Parts 8 and 9). */
export type DocKind = 'quotation' | 'order';
export const DOCS = {
  quotation: { api: '/quotations', base: '/sales/quotations', list: 'Quotations', noun: 'quotation', dateKey: 'quoteDate', dateLabel: 'Quotation date' },
  order: { api: '/sales-orders', base: '/sales/orders', list: 'Sales Orders', noun: 'sales order', dateKey: 'orderDate', dateLabel: 'Order date' },
} as const;

export const QuotationFormPage = () => <SalesDocFormPage kind="quotation" />;

export function SalesDocFormPage({ kind }: { kind: DocKind }) {
  const cfg = DOCS[kind];
  const isOrder = kind === 'order';
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  type Existing = QuoteDetail & { orderDate?: string; requiredBy?: string | null; dealerPoNo?: string | null; dealerPoDate?: string | null; quotationId?: string | null; quotationNo?: string | null };
  const existing = useQuery({ queryKey: [kind, id], queryFn: () => api<Existing>(`${cfg.api}/${id}`), enabled: editing });
  const defaults = useQuery({ queryKey: [kind, 'defaults'], queryFn: () => api<{ paymentTerms: string; deliveryTerms: string; validityDays?: number; today: string }>(`${cfg.api}/defaults`) });
  const [dealerSearch, setDealerSearch] = useState('');
  const dq = useDebounced(dealerSearch, 300);
  const dealers = useQuery({ queryKey: ['dealers-active', dq], queryFn: () => api<Page<{ id: string; code: string; legalName: string; territory: string }>>(`/dealers?usable=1&limit=50&q=${encodeURIComponent(dq)}`) });
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; status: string }>>('/legal-entities?status=Active&limit=100') });

  const [h, setH] = useState({ partyId: params.get('partyId') ?? '', legalEntityId: '', billToId: '', shipToId: '', quoteDate: '', contactPerson: '', paymentTerms: '', deliveryTerms: '', notes: '',
    opportunityId: params.get('opportunityId') ?? '', requiredBy: '', dealerPoNo: '', dealerPoDate: '' });
  /** an order converted from a quotation keeps the quotation's products and prices */
  const locked = isOrder && !!existing.data?.quotationId;
  const [lines, setLines] = useState<DraftLine[]>([newLine()]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  // initialise from the existing quotation, or from defaults
  useEffect(() => {
    if (loaded) return;
    if (editing && existing.data) {
      const q = existing.data;
      setH({ partyId: q.partyId, legalEntityId: q.legalEntityId, billToId: q.billToId, shipToId: q.shipToId, quoteDate: (q.orderDate ?? q.quoteDate).slice(0, 10), contactPerson: q.contactPerson ?? '',
        paymentTerms: q.paymentTerms, deliveryTerms: q.deliveryTerms, notes: q.notes ?? '', opportunityId: q.opportunityId ?? '',
        requiredBy: q.requiredBy ?? '', dealerPoNo: q.dealerPoNo ?? '', dealerPoDate: q.dealerPoDate ?? '' });
      setLines(q.lines.map((l) => ({ key: ++lineKey, itemPackId: l.itemPackId, qty: String(Number(l.qty)), extraDiscountPct: Number(l.extraDiscountPct) ? String(Number(l.extraDiscountPct)) : '' })));
      setLoaded(true);
    } else if (!editing && defaults.data) {
      setH((x) => ({ ...x, quoteDate: defaults.data.today, paymentTerms: defaults.data.paymentTerms, deliveryTerms: defaults.data.deliveryTerms }));
      setLoaded(true);
    }
  }, [editing, existing.data, defaults.data, loaded]);
  useEffect(() => { if (!h.legalEntityId && entities.data?.data.length === 1) setH((x) => ({ ...x, legalEntityId: entities.data!.data[0]!.id })); }, [entities.data, h.legalEntityId]);

  const dealer = useQuery({
    queryKey: ['dealer', h.partyId], enabled: !!h.partyId,
    queryFn: () => api<{ id: string; code: string; legalName: string; contactPerson: string; priceGroup: string; creditDays: number; territory: string; addresses: Address[] }>(`/dealers/${h.partyId}`),
  });
  // default the addresses and contact when a dealer is chosen
  useEffect(() => {
    const d = dealer.data;
    if (!d || d.id !== h.partyId) return;
    setH((x) => {
      const ok = (aid: string) => d.addresses.some((a) => a.id === aid);
      const bill = d.addresses.find((a) => a.kind === 'BILLING') ?? d.addresses.find((a) => a.kind === 'REGISTERED');
      const ship = d.addresses.find((a) => a.kind === 'SHIPPING') ?? bill;
      return { ...x, billToId: ok(x.billToId) ? x.billToId : bill?.id ?? '', shipToId: ok(x.shipToId) ? x.shipToId : ship?.id ?? '', contactPerson: x.contactPerson || d.contactPerson };
    });
  }, [dealer.data, h.partyId]);
  const packs = useQuery({ queryKey: ['priced-packs', h.partyId, h.quoteDate], enabled: !!h.partyId && !!h.quoteDate,
    queryFn: () => api<{ data: PricedPack[] }>(`${cfg.api}/priced-packs?partyId=${h.partyId}&date=${h.quoteDate}`) });

  const body = useMemo(() => ({
    partyId: h.partyId, legalEntityId: h.legalEntityId, billToId: h.billToId, shipToId: h.shipToId, [cfg.dateKey]: h.quoteDate || undefined,
    contactPerson: h.contactPerson || undefined, paymentTerms: h.paymentTerms, deliveryTerms: h.deliveryTerms, notes: h.notes || undefined, opportunityId: h.opportunityId || null,
    ...(isOrder ? { requiredBy: h.requiredBy || null, dealerPoNo: h.dealerPoNo || undefined, dealerPoDate: h.dealerPoDate || null } : {}),
    lines: lines.filter((l) => l.itemPackId && Number(l.qty) > 0).map((l) => ({ itemPackId: l.itemPackId, qty: Number(l.qty), extraDiscountPct: Number(l.extraDiscountPct || 0) })),
  }), [h, lines, cfg.dateKey, isOrder]);
  const ready = !!(body.partyId && body.legalEntityId && body.billToId && body.shipToId && body.lines.length && body.paymentTerms && body.deliveryTerms);
  const debounced = useDebounced(body);
  const calc = useQuery({ queryKey: [kind, 'calc', debounced], enabled: ready && !locked, retry: false, placeholderData: (p) => p,
    queryFn: () => api<Calc>(`${cfg.api}/calculate`, { body: debounced }) });
  // locked lines are shown as saved; header edits do not change the amounts
  const shown: Calc | undefined = locked && existing.data
    ? { lines: existing.data.lines, totals: existing.data, interState: existing.data.interState, placeOfSupply: existing.data.placeOfSupply, validUntil: '',
        maxExtraDiscount: Number(existing.data.maxExtraDiscount), warnings: [], amountInWords: existing.data.print.amountInWords }
    : calc.data;
  const calcByPack = new Map((shown?.lines ?? []).map((l) => [l.itemPackId, l]));
  const dupPacks = new Set(lines.map((l) => l.itemPackId).filter((p, i, a) => p && a.indexOf(p) !== i));

  if ((editing && existing.isLoading) || !loaded) return <Skeleton className="h-96" />;
  if (editing && existing.data && !existing.data.allowedActions.includes('edit')) {
    return <Card><EmptyState title={`This ${cfg.noun} cannot be edited`} text={`It is ${existing.data.status}.${isOrder ? '' : ' Use Revise on the quotation to make a new revision.'}`} /></Card>;
  }
  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const save = async () => {
    setError(null); setSaving(true);
    try {
      if (editing) {
        const { lines: _l, partyId: _p, legalEntityId: _le, billToId: _b, shipToId: _s, opportunityId: _o, ...header } = body;
        await api(`${cfg.api}/${id}`, { method: 'PUT', body: { ...(locked ? header : body), version: existing.data!.version } });
        toast('success', `${cfg.noun[0]!.toUpperCase()}${cfg.noun.slice(1)} saved.`); await qc.invalidateQueries(); nav(`${cfg.base}/${id}`);
      } else { const r = await api<{ id: string; docNo: string }>(cfg.api, { body }); toast('success', `Saved as Draft ${r.docNo}.`); nav(`${cfg.base}/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  const t = shown?.totals;
  const addresses = dealer.data?.addresses ?? [];
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data!.docNo}${isOrder ? '' : ` R${existing.data!.revision}`}` : `New ${cfg.noun}`} crumbs={<Link to={cfg.base} className="hover:text-primary">{cfg.list}</Link>}
        subtitle={locked ? `Converted from quotation ${existing.data!.quotationNo}: products and prices are locked; you can change the order details.`
          : 'Rates, schemes and GST are calculated by the server from approved masters. You enter packs, quantities and any extra discount.'} />
      <ErrorBanner error={error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card title="Dealer and terms">
            <div className="grid gap-5 md:grid-cols-2">
              {editing ? (
                <Field label="Dealer" htmlFor="q-dealer"><Input id="q-dealer" value={`${existing.data!.partyName} (${existing.data!.partyCode})`} disabled /></Field>
              ) : (
                <div className="grid gap-2">
                  <Field label="Dealer" htmlFor="q-dealer" required hint="Only active dealers are listed">
                    <Select id="q-dealer" value={h.partyId} onChange={(e) => setH((x) => ({ ...x, partyId: e.target.value, billToId: '', shipToId: '', contactPerson: '' }))}>
                      <option value="">Select…</option>
                      {(dealers.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.legalName} — {d.code} · {d.territory}</option>)}
                      {h.partyId && dealer.data && !dealers.data?.data.some((d) => d.id === h.partyId) && <option value={h.partyId}>{dealer.data.legalName} — {dealer.data.code}</option>}
                    </Select>
                  </Field>
                  <Input aria-label="Search dealers" placeholder="Search dealer name, code or GSTIN" value={dealerSearch} onChange={(e) => setDealerSearch(e.target.value)} />
                </div>
              )}
              <Field label="Issuing legal entity" htmlFor="q-le" required>
                <Select id="q-le" value={h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, legalEntityId: e.target.value }))} disabled={locked}>
                  <option value="">Select…</option>
                  {(entities.data?.data ?? []).map((le) => <option key={le.id} value={le.id}>{le.code} — {le.name}</option>)}
                </Select>
              </Field>
              <Field label="Bill to" htmlFor="q-bill" required>
                <Select id="q-bill" value={h.billToId} onChange={(e) => setH((x) => ({ ...x, billToId: e.target.value }))} disabled={!h.partyId || locked}>
                  <option value="">Select…</option>
                  {addresses.filter((a) => a.kind !== 'SHIPPING').map((a) => <option key={a.id} value={a.id}>{addrLabel(a)}</option>)}
                </Select>
              </Field>
              <Field label="Ship to" htmlFor="q-ship" required hint="Decides the place of supply and the GST split">
                <Select id="q-ship" value={h.shipToId} onChange={(e) => setH((x) => ({ ...x, shipToId: e.target.value }))} disabled={!h.partyId || locked}>
                  <option value="">Select…</option>
                  {addresses.map((a) => <option key={a.id} value={a.id}>{addrLabel(a)}</option>)}
                </Select>
              </Field>
              <Field label={cfg.dateLabel} htmlFor="q-date" required hint={isOrder ? (editing ? 'Fixed once the order is saved' : undefined) : `Valid for ${defaults.data?.validityDays ?? 7} days`}>
                <Input id="q-date" type="date" max={defaults.data?.today} value={h.quoteDate} disabled={isOrder && editing} onChange={(e) => setH((x) => ({ ...x, quoteDate: e.target.value }))} />
              </Field>
              {isOrder && <>
                <Field label="Required by" htmlFor="o-req" hint="Delivery date the dealer needs"><Input id="o-req" type="date" min={h.quoteDate} value={h.requiredBy} onChange={(e) => setH((x) => ({ ...x, requiredBy: e.target.value }))} /></Field>
                <Field label="Dealer PO number" htmlFor="o-po"><Input id="o-po" maxLength={60} value={h.dealerPoNo} onChange={(e) => setH((x) => ({ ...x, dealerPoNo: e.target.value }))} /></Field>
                <Field label="Dealer PO date" htmlFor="o-pod"><Input id="o-pod" type="date" max={defaults.data?.today} value={h.dealerPoDate} onChange={(e) => setH((x) => ({ ...x, dealerPoDate: e.target.value }))} /></Field>
              </>}
              <Field label="Contact person" htmlFor="q-contact"><Input id="q-contact" value={h.contactPerson} maxLength={100} onChange={(e) => setH((x) => ({ ...x, contactPerson: e.target.value }))} /></Field>
              <Field label="Payment terms" htmlFor="q-pay" required><Textarea id="q-pay" rows={2} maxLength={300} value={h.paymentTerms} onChange={(e) => setH((x) => ({ ...x, paymentTerms: e.target.value }))} /></Field>
              <Field label="Delivery terms" htmlFor="q-del" required><Textarea id="q-del" rows={2} maxLength={300} value={h.deliveryTerms} onChange={(e) => setH((x) => ({ ...x, deliveryTerms: e.target.value }))} /></Field>
              <div className="md:col-span-2"><Field label={`Notes printed on the ${cfg.noun}`} htmlFor="q-notes"><Textarea id="q-notes" rows={2} maxLength={1000} value={h.notes} onChange={(e) => setH((x) => ({ ...x, notes: e.target.value }))} /></Field></div>
            </div>
            {dealer.data && <p className="mt-4 text-[13px] text-ink-2">Price group <span className="font-semibold text-ink">{dealer.data.priceGroup}</span> · credit {dealer.data.creditDays} days · {dealer.data.territory}</p>}
          </Card>

          <Card title="Products" padded={false} actions={!locked && <Button size="sm" variant="secondary" icon={<Plus size={16} />} disabled={lines.length >= 100} onClick={() => setLines([...lines, newLine()])}>Add line</Button>}>
            {h.partyId && packs.data && packs.data.data.length === 0 && (
              <div className="mx-5 mb-4 rounded-md bg-warning-bg px-4 py-3 text-warning-text">No approved price list covers price group {dealer.data?.priceGroup} on this date. Ask sales operations to publish one.</div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-[14px]">
                <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                  <th className="px-5 py-3">Product pack</th><th className="w-24 px-2 py-3">Qty (packs)</th><th className="px-2 py-3 text-right">List rate</th><th className="px-2 py-3 text-right">Scheme</th>
                  <th className="w-24 px-2 py-3">Extra disc. %</th><th className="px-2 py-3 text-right">Net rate</th><th className="px-2 py-3 text-right">GST</th><th className="px-2 py-3 text-right">Amount</th><th className="px-3 py-3" />
                </tr></thead>
                <tbody>{lines.map((l, i) => {
                  const c = calcByPack.get(l.itemPackId);
                  return (
                    <tr key={l.key} className="border-b border-line align-top last:border-0">
                      <td className="px-5 py-2">
                        <Select aria-label={`Product for line ${i + 1}`} value={l.itemPackId} onChange={(e) => setLine(l.key, { itemPackId: e.target.value })} disabled={!h.partyId || locked} invalid={dupPacks.has(l.itemPackId)}>
                          <option value="">{h.partyId ? 'Select…' : 'Choose a dealer first'}</option>
                          {(packs.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.itemCode} — {p.itemName} · {packLabel(p)}</option>)}
                          {l.itemPackId && packs.data && !packs.data.data.some((p) => p.id === l.itemPackId) && <option value={l.itemPackId}>{c?.description ?? 'Not priced on this date'}</option>}
                        </Select>
                        {dupPacks.has(l.itemPackId) && <p className="mt-1 text-[12px] text-danger-text">This pack is already on another line.</p>}
                        {c && <p className="mt-1 text-[12px] text-ink-2">HSN {c.hsnCode}</p>}
                      </td>
                      <td className="px-2 py-2"><Input aria-label={`Quantity for line ${i + 1}`} type="number" min="0" step="any" inputMode="decimal" value={l.qty} disabled={locked} onChange={(e) => setLine(l.key, { qty: e.target.value })} /></td>
                      <td className="px-2 py-2 pt-4 text-right num">{c ? fmtINR(c.listRate) : '—'}</td>
                      <td className="px-2 py-2 pt-4 text-right num">{c ? pct(c.schemeDiscountPct) : '—'}</td>
                      <td className="px-2 py-2"><Input aria-label={`Extra discount for line ${i + 1}`} type="number" min="0" max="100" step="0.01" inputMode="decimal" placeholder="0" value={l.extraDiscountPct} disabled={locked} onChange={(e) => setLine(l.key, { extraDiscountPct: e.target.value })} /></td>
                      <td className="px-2 py-2 pt-4 text-right num">{c ? fmtINR(c.rate) : '—'}</td>
                      <td className="px-2 py-2 pt-4 text-right num">{c ? `${fmtNum(Number(c.gstRate))}%` : '—'}</td>
                      <td className="px-2 py-2 pt-4 text-right num font-semibold">{c ? fmtINR(c.lineTotal) : '—'}</td>
                      <td className="px-3 py-2"><Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1 || locked} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash size={16} /></Button></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </Card>
        </div>

        <aside className="space-y-6 xl:sticky xl:top-24 xl:self-start">
          <Card title="Summary">
            {!ready ? <p className="text-ink-2">Choose the dealer, addresses and at least one product with a quantity to see the price.</p>
              : calc.error && !locked ? <p className="rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger-text">{calc.error instanceof ApiError ? calc.error.message : 'Could not calculate.'}</p>
              : !t ? <Skeleton className="h-40" /> : (
                <dl className="space-y-2 text-[14px]">
                  <Row k="At list rates" v={fmtINR(t.subTotal)} />
                  <Row k="Scheme and extra discount" v={`− ${fmtINR(t.discountTotal)}`} />
                  <Row k="Taxable value" v={fmtINR(t.taxableTotal)} strong />
                  {shown!.interState ? <Row k="IGST" v={fmtINR(t.igstTotal)} /> : <><Row k="CGST" v={fmtINR(t.cgstTotal)} /><Row k="SGST" v={fmtINR(t.sgstTotal)} /></>}
                  <Row k="Round-off" v={fmtINR(t.roundOff)} />
                  <div className="border-t border-line pt-3"><Row k="Total" v={fmtINR(t.grandTotal)} strong big /></div>
                  <p className="pt-1 text-[12px] text-ink-2">{shown!.amountInWords}</p>
                  <p className="text-[12px] text-ink-2">Place of supply {state(shown!.placeOfSupply)} · {shown!.interState ? 'inter-state (IGST)' : 'intra-state (CGST + SGST)'}{isOrder ? '' : ` · valid until ${fmtDate(shown!.validUntil)}`}</p>
                  {shown!.maxExtraDiscount > 0 && <p className="rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning-text">Extra discount up to {shown!.maxExtraDiscount}% — {isOrder ? 'the approval chain will include it.' : 'this quotation will need approval before it can be sent.'}</p>}
                  {shown!.warnings.length > 0 && <div className="rounded-md bg-danger-bg px-3 py-2 text-[13px] text-danger-text">Cannot be saved yet: {shown!.warnings.join('; ')}.</div>}
                </dl>
              )}
            <div className="mt-5 flex gap-2">
              <Button loading={saving} disabled={!ready || dupPacks.size > 0} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button>
              <Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button>
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}

export function Row({ k, v, strong, big }: { k: string; v: string; strong?: boolean; big?: boolean }) {
  return <div className="flex items-baseline justify-between gap-3"><dt className="text-ink-2">{k}</dt><dd className={`num ${strong ? 'font-semibold text-ink' : ''} ${big ? 'text-[20px]' : ''}`}>{v}</dd></div>;
}

// ------------------------------------------------------------------ detail
export function QuotationDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['quotation', id], queryFn: () => api<QuoteDetail>(`/quotations/${id}`) });
  const [cancel, setCancel] = useState(false);
  const [convert, setConvert] = useState(false);
  const act = useMutation({
    mutationFn: ({ path }: { path: string; ok: string }) => api<{ status?: string; approvalDocNo?: string; id?: string; docNo?: string; revision?: number }>(`/quotations/${id}/${path}`, { method: 'POST', body: {} }),
    onSuccess: async (r, v) => {
      if (v.path === 'submit') toast('success', r.status === 'Approved' ? 'No extra discount — approved. You can send it now.' : `Sent for discount approval as ${r.approvalDocNo}.`);
      else toast('success', v.ok);
      await qc.invalidateQueries();
      if (r?.id && r.id !== id) nav(`/sales/quotations/${r.id}`);
    },
  });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const run = (path: string, ok: string) => act.mutate({ path, ok });
  const busy = (p: string) => act.isPending && act.variables?.path === p;
  return (
    <>
      <PageHeader title={`${d.docNo} R${d.revision}`} crumbs={<Link to="/sales/quotations" className="hover:text-primary">Quotations</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status} /><span>{d.partyName} · {fmtINR(d.grandTotal)} · valid until {fmtDate(d.validUntil)}</span></span>}
        actions={<>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => nav(`/sales/quotations/${id}/print`)}>Print / PDF</Button>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/sales/quotations/${id}/edit`)}>Edit</Button>}
          {a.includes('duplicate') && <Button variant="secondary" icon={<Copy size={18} />} loading={busy('duplicate')} onClick={() => run('duplicate', 'Copied as a new Draft.')}>Duplicate</Button>}
          {a.includes('convert') && <Button variant="secondary" onClick={() => setConvert(true)}>Convert to sales order</Button>}
          {a.includes('revise') && <Button variant="secondary" loading={busy('revise')} onClick={() => run('revise', `Revision R${d.revision + 1} created as Draft.`)}>Revise</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel</Button>}
          {a.includes('submit') && <Button loading={busy('submit')} onClick={() => run('submit', '')}>Submit</Button>}
          {a.includes('send') && <Button icon={<PaperPlaneTilt size={18} />} loading={busy('send')} onClick={() => run('send', 'Marked as sent to the dealer.')}>Mark as sent</Button>}
          {a.includes('accept') && <Button loading={busy('accept')} onClick={() => run('accept', 'Dealer acceptance recorded.')}>Record acceptance</Button>}
        </>} />
      <ErrorBanner error={act.error} />
      {d.status === 'Submitted' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Waiting for discount approval{d.approval ? <> — <Link className="font-semibold underline" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link></> : null}. It cannot be edited until a decision is made.</div>}
      {d.statusReason && ['Cancelled', 'Expired', 'Superseded', 'Accepted'].includes(d.status) && <div className="mb-6 rounded-md bg-neutral-bg px-4 py-3 text-neutral-text">{d.status}: {d.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card title="Details">
            <KeyValues items={[
              ['Dealer', <Link key="d" className="font-semibold text-primary" to={`/sales/dealers/${d.partyId}`}>{d.partyName} ({d.partyCode})</Link>], ['Dealer GSTIN', d.partyGstin ?? 'Unregistered'],
              ['Contact person', d.contactPerson], ['Bill to', addressText(d.billTo)], ['Ship to', addressText(d.shipTo)],
              ['Place of supply', `${state(d.placeOfSupply)} · ${d.interState ? 'IGST' : 'CGST + SGST'}`], ['Issued by', d.legalEntityName], ['Quotation date', fmtDate(d.quoteDate)],
              ['Valid until', fmtDate(d.validUntil)], ['Price list', d.priceListCode], ['Sales owner', `${d.salesOwner} · ${d.territory}`],
              ['Opportunity', d.opportunityId ? <Link key="o" className="text-primary" to={`/sales/opportunities/${d.opportunityId}`}>{d.opportunityCode}</Link> : '—'],
              ['Payment terms', d.paymentTerms], ['Delivery terms', d.deliveryTerms], ['Notes', d.notes],
              ...(d.salesOrder ? [['Sales order', <Link key="so" className="font-semibold text-primary" to={`/sales/orders/${d.salesOrder.id}`}>{d.salesOrder.docNo} ({d.salesOrder.status})</Link>] as [string, ReactNode]] : []),
            ]} />
          </Card>
        </div>
        <aside className="space-y-6">
          <Card title="Amount">
            <dl className="space-y-2 text-[14px]">
              <Row k="At list rates" v={fmtINR(d.subTotal)} />
              <Row k="Scheme and extra discount" v={`− ${fmtINR(d.discountTotal)}`} />
              <Row k="Taxable value" v={fmtINR(d.taxableTotal)} strong />
              {d.interState ? <Row k="IGST" v={fmtINR(d.igstTotal)} /> : <><Row k="CGST" v={fmtINR(d.cgstTotal)} /><Row k="SGST" v={fmtINR(d.sgstTotal)} /></>}
              <Row k="Round-off" v={fmtINR(d.roundOff)} />
              <div className="border-t border-line pt-3"><Row k="Total" v={fmtINR(d.grandTotal)} strong big /></div>
              <p className="pt-1 text-[12px] text-ink-2">{d.print.amountInWords}</p>
            </dl>
          </Card>
          <Card title="Approval">
            {!d.approval ? <p className="text-ink-2">Not submitted yet.{Number(d.maxExtraDiscount) > 0 ? ` Extra discount ${Number(d.maxExtraDiscount)}% will need approval.` : ' No extra discount, so it is approved on submission.'}</p> : (
              <>
                <p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link> · {d.approval.ruleName}</p>
                {(d.approval.steps ?? []).length === 0 ? <p className="text-[13px] text-ink-2">No approval step was needed.</p> : (
                  <ol className="space-y-2">{d.approval.steps!.map((s) => (
                    <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>))}</ol>
                )}
              </>
            )}
          </Card>
          <Card title="Revisions">
            <ul className="divide-y divide-line">{d.revisions.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 py-2 text-[14px]">
                {r.id === d.id ? <span className="font-semibold">R{r.revision} (this)</span> : <Link className="font-semibold text-primary" to={`/sales/quotations/${r.id}`}>R{r.revision}</Link>}
                <span className="num text-ink-2">{fmtINR(r.grandTotal)}</span><StatusBadge status={r.status} />
              </li>))}</ul>
            <p className="mt-3 text-[12px] text-ink-2">Created {fmtDateTime(d.createdAt)} · updated {fmtDateTime(d.updatedAt)}</p>
          </Card>
        </aside>
      </div>
      <Card title="Products" padded={false} className="mt-6">
        <LinesTable lines={d.lines} interState={d.interState} />
      </Card>
      <ConvertDialog open={convert} onClose={() => setConvert(false)} quotationId={d.id} label={`${d.docNo} R${d.revision}`} />
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo} R${d.revision}`} confirmLabel="Cancel quotation" onClose={() => setCancel(false)}
        description="The quotation can no longer be sent, accepted or converted."
        onConfirm={async (reason) => { await api(`/quotations/${id}/cancel`, { body: { reason } }); toast('success', 'Quotation cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}

export function LinesTable({ lines, interState, print }: { lines: Line[]; interState: boolean; print?: boolean }) {
  const cell = print ? 'px-1.5 py-1.5' : 'px-3 py-3';
  return (
    <div className={print ? '' : 'overflow-x-auto'}>
      <table className={`w-full ${print ? 'text-[11px]' : 'min-w-[860px] text-[14px]'}`}>
        <thead><tr className={`border-b border-line text-left ${print ? 'text-[10px]' : 'text-[12px]'} uppercase tracking-wide text-ink-2`}>
          <th className={cell}>#</th><th className={cell}>Product</th><th className={cell}>HSN</th><th className={`${cell} text-right`}>Qty</th><th className={`${cell} text-right`}>List rate</th>
          <th className={`${cell} text-right`}>Scheme</th><th className={`${cell} text-right`}>Extra</th><th className={`${cell} text-right`}>Net rate</th><th className={`${cell} text-right`}>Taxable</th>
          <th className={`${cell} text-right`}>GST</th><th className={`${cell} text-right`}>{interState ? 'IGST' : 'CGST + SGST'}</th><th className={`${cell} text-right`}>Amount</th>
        </tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.lineNo} className="border-b border-line align-top last:border-0">
            <td className={cell}>{l.lineNo}</td><td className={cell}><span className="whitespace-nowrap font-semibold">{l.itemCode}</span><br /><span className="text-ink-2">{l.description}</span></td><td className={`${cell} num`}>{l.hsnCode}</td>
            <td className={`${cell} text-right num`}>{fmtNum(Number(l.qty))}</td><td className={`${cell} text-right num`}>{fmtINR(l.listRate)}</td>
            <td className={`${cell} text-right num`}>{pct(l.schemeDiscountPct)}</td><td className={`${cell} text-right num`}>{pct(l.extraDiscountPct)}</td>
            <td className={`${cell} text-right num`}>{fmtINR(l.rate)}</td><td className={`${cell} text-right num`}>{fmtINR(l.taxable)}</td><td className={`${cell} text-right num`}>{fmtNum(Number(l.gstRate))}%</td>
            <td className={`${cell} text-right num`}>{fmtINR(interState ? l.igst : Number(l.cgst) + Number(l.sgst))}</td><td className={`${cell} text-right num font-semibold`}>{fmtINR(l.lineTotal)}</td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}

/** SO-002: an approved quotation becomes a sales order with the same products and prices. */
function ConvertDialog({ open, onClose, quotationId, label }: { open: boolean; onClose: () => void; quotationId: string; label: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [v, setV] = useState({ dealerPoNo: '', dealerPoDate: '', requiredBy: '' });
  const go = useMutation({
    mutationFn: () => api<{ id: string; docNo: string }>(`/sales-orders/from-quotation/${quotationId}`,
      { body: { dealerPoNo: v.dealerPoNo || undefined, dealerPoDate: v.dealerPoDate || null, requiredBy: v.requiredBy || null } }),
    onSuccess: (r) => { toast('success', `Sales order ${r.docNo} created as Draft. Review and submit it.`); onClose(); nav(`/sales/orders/${r.id}`); },
  });
  return (
    <Modal open={open} onClose={onClose} title={`Convert ${label} to a sales order`}
      description="Products, quantities, prices and discounts carry over unchanged. GST is applied at the rate in force today."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={go.isPending} onClick={() => go.mutate()}>Create sales order</Button></>}>
      <ErrorBanner error={go.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Dealer PO number" htmlFor="cv-po"><Input id="cv-po" maxLength={60} value={v.dealerPoNo} onChange={(e) => setV({ ...v, dealerPoNo: e.target.value })} /></Field>
        <Field label="Dealer PO date" htmlFor="cv-pod"><Input id="cv-pod" type="date" value={v.dealerPoDate} onChange={(e) => setV({ ...v, dealerPoDate: e.target.value })} /></Field>
        <Field label="Required by" htmlFor="cv-req"><Input id="cv-req" type="date" value={v.requiredBy} onChange={(e) => setV({ ...v, requiredBy: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ A4 print (browser print → PDF)
const PRINTABLE: Record<DocKind, string[]> = { quotation: ['Approved', 'Sent', 'Accepted', 'Converted'], order: ['Approved', 'Closed'] };

export const QuotationPrintPage = () => <SalesDocPrintPage kind="quotation" />;

/** A4 quotation or order acknowledgement (QUO-007, SO-009). */
export function SalesDocPrintPage({ kind }: { kind: DocKind }) {
  const cfg = DOCS[kind];
  const isOrder = kind === 'order';
  const { id } = useParams();
  type Doc = QuoteDetail & { orderDate?: string; requiredBy?: string | null; dealerPoNo?: string | null; dealerPoDate?: string | null; quotationNo?: string | null; quotationRevision?: number };
  const q = useQuery({ queryKey: [kind, id], queryFn: () => api<Doc>(`${cfg.api}/${id}`) });
  const d = q.data;
  const ref = d ? (isOrder ? d.docNo : `${d.docNo} R${d.revision}`) : '';
  useEffect(() => { if (d) document.title = ref.replace(/[/ ]/g, '-'); return () => { document.title = 'Dhruv Agro ERP'; }; }, [d, ref]);
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (!d) return <div className="p-8"><ErrorBanner error={q.error} /></div>;
  const s = d.print.seller;
  const valid = PRINTABLE[kind].includes(d.status);
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-3 px-4 py-4 print:hidden">
        <Link to={`${cfg.base}/${id}`} className="inline-flex items-center gap-2 font-semibold text-primary"><ArrowLeft size={18} /> Back to {cfg.noun}</Link>
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="relative mx-auto mb-8 max-w-[210mm] bg-white p-[12mm] text-[12px] text-ink shadow-card print:m-0 print:max-w-none print:p-0 print:shadow-none">
        {!valid && <div className="mb-4 rounded border-2 border-danger-text px-3 py-2 text-center font-bold uppercase tracking-wide text-danger-text">{d.status} — {isOrder ? 'not an approved order' : 'not a valid offer'}</div>}
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-3">
          <div>
            <h1 className="text-[18px] font-extrabold">{s?.name ?? d.legalEntityName}</h1>
            {s?.address && <p className="max-w-[95mm] whitespace-pre-line">{s.address}</p>}
            <p>{s?.gstin ? `GSTIN ${s.gstin}` : 'GSTIN not registered for this state'}{s?.pan ? ` · PAN ${s.pan}` : ''}</p>
          </div>
          <div className="text-right">
            <p className="text-[20px] font-extrabold tracking-wide">{isOrder ? 'SALES ORDER' : 'QUOTATION'}</p>
            <p className="num font-semibold">{ref}</p>
            {isOrder ? <>
              <p>Order date {fmtDate(d.orderDate)}</p>
              {d.requiredBy && <p>Required by {fmtDate(d.requiredBy)}</p>}
              {d.dealerPoNo && <p>Your PO {d.dealerPoNo}{d.dealerPoDate ? ` dated ${fmtDate(d.dealerPoDate)}` : ''}</p>}
              {d.quotationNo && <p>Against quotation {d.quotationNo} R{d.quotationRevision}</p>}
            </> : <>
              <p>Date {fmtDate(d.quoteDate)}</p>
              <p>Valid until {fmtDate(d.validUntil)}</p>
            </>}
          </div>
        </header>
        <section className="grid grid-cols-2 gap-6 border-b border-line py-3">
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Bill to</p><p className="font-semibold">{d.partyName}</p><p>{addressText(d.billTo)}</p>
            <p>{d.partyGstin ? `GSTIN ${d.partyGstin}` : 'Unregistered dealer'}</p>{d.contactPerson && <p>Attn: {d.contactPerson}</p>}</div>
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Ship to</p><p>{addressText(d.shipTo)}</p>
            <p>Place of supply: {state(d.placeOfSupply)}</p></div>
        </section>
        <section className="py-3"><LinesTable lines={d.lines} interState={d.interState} print /></section>
        <section className="flex justify-between gap-6 border-t border-line pt-3">
          <div className="max-w-[105mm] space-y-2">
            <p><span className="font-semibold">Amount in words:</span> {d.print.amountInWords}</p>
            <p><span className="font-semibold">Payment terms:</span> {d.paymentTerms}</p>
            <p><span className="font-semibold">Delivery terms:</span> {d.deliveryTerms}</p>
            {d.notes && <p><span className="font-semibold">Notes:</span> {d.notes}</p>}
            {d.print.bankDetails && <p className="whitespace-pre-line"><span className="font-semibold">Bank details:</span> {d.print.bankDetails}</p>}
            <p className="text-ink-2">{isOrder ? 'Thank you for your order. GST is charged at the rate in force on the date of invoice. Delivery is subject to stock and credit approval.'
              : `Prices are subject to the GST rate in force on the date of invoice. This quotation is valid until ${fmtDate(d.validUntil)}.`}</p>
          </div>
          <dl className="w-[70mm] space-y-1">
            <Row k="At list rates" v={fmtINR(d.subTotal)} /><Row k="Discount" v={`− ${fmtINR(d.discountTotal)}`} /><Row k="Taxable value" v={fmtINR(d.taxableTotal)} strong />
            {d.interState ? <Row k="IGST" v={fmtINR(d.igstTotal)} /> : <><Row k="CGST" v={fmtINR(d.cgstTotal)} /><Row k="SGST" v={fmtINR(d.sgstTotal)} /></>}
            <Row k="Round-off" v={fmtINR(d.roundOff)} />
            <div className="border-t-2 border-ink pt-1"><Row k="Total" v={fmtINR(d.grandTotal)} strong big /></div>
          </dl>
        </section>
        <footer className="mt-10 flex justify-end">
          <div className="text-center"><p>For {s?.name ?? d.legalEntityName}</p><div className="h-12" /><p className="border-t border-ink px-8 pt-1">Authorised signatory</p></div>
        </footer>
      </article>
    </div>
  );
}
