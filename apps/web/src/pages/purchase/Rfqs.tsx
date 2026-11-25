import { Plus, Trash, Trophy } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';

const rate4 = (v: number | string) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
interface RfqRow { id: string; docNo: string; responseDue: string; status: string; warehouseCode: string; lineCount: number; vendorCount: number; quoteCount: number; createdAt: string }
interface Bid { vendorQuoteId: string; partyId: string; vendorCode: string; vendorName: string; quoteRef: string; rate: number; discountPct: number; netRate: number; freightPerUnit: number;
  landedRate: number; leadDays: number; paymentTermsDays: number; rating: number | null; compliant: boolean; validQuote: boolean; eligible: boolean; reasons: string[]; qualified: boolean;
  scores: { price: number; leadTime: number; quality: number }; score: number; rank: number }
interface CmpLine { id: string; lineNo: number; itemId: string; itemCode: string; itemName: string; uom: string; qty: string; requiredBy: string | null; specification: string | null;
  bids: Bid[]; recommended: string | null; award: { vendorQuoteId: string; rank: number; score: number; overrideReason: string | null } | null }
interface RfqDetail {
  id: string; docNo: string; legalEntityId: string; legalEntityName: string; warehouseId: string; warehouseCode: string; warehouseName: string; responseDue: string; notes: string | null;
  status: string; statusReason: string | null; issuedAt: string | null; awardedAt: string | null; createdAt: string; createdBy: string; version: number;
  vendors: { id: string; code: string; legalName: string; rating: string | null; quoteId: string | null; quoteRef: string | null; quoteDate: string | null; validUntil: string | null;
    paymentTermsDays: number | null; deliveryDays: number | null; freight: string | null; remarks: string | null }[];
  weights: { price: number; leadTime: number; quality: number }; lines: CmpLine[];
  purchaseOrders: { id: string; docNo: string; status: string; vendorName: string; grandTotal: string }[]; allowedActions: string[];
}

const columns: Column<RfqRow>[] = [
  { key: 'doc', header: 'RFQ', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'due', header: 'Responses due', render: (r) => <span className="num">{fmtDate(r.responseDue)}</span> },
  { key: 'wh', header: 'Deliver to', render: (r) => r.warehouseCode },
  { key: 'items', header: 'Items', render: (r) => <span className="num">{r.lineCount}</span> },
  { key: 'quotes', header: 'Quotes', render: (r) => <span className="num">{r.quoteCount} of {r.vendorCount}</span> },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status === 'Awarded' ? 'Approved' : r.status === 'Issued' ? 'Pending' : r.status} label={r.status} /> },
];

export function RfqsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('purchase.rfq:manage') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/purchase/rfqs/new')}>New RFQ</Button> : undefined;
  return (
    <>
      <PageHeader title="Requests for Quotation" subtitle="Invite approved vendors to quote, compare landed cost, lead time and quality, and award — the top-ranked bid is pre-selected; choosing another needs a reason." actions={create} />
      <DataTable<RfqRow> queryKey="rfqs" path="/rfqs" columns={columns} rowHref={(r) => `/purchase/rfqs/${r.id}`} statusOptions={['Draft', 'Issued', 'Awarded', 'Cancelled']} searchPlaceholder="Search RFQ number"
        empty={{ title: 'No RFQs yet', text: 'Start one from an approved requisition, or add items directly.', action: create }} />
    </>
  );
}

// ---------------------------------------------------------------- editor
interface DraftLine { key: number; itemId: string; qty: string; requiredBy: string; specification: string; requisitionLineId: string; prLabel: string }
let k = 0;
const blank = (): DraftLine => ({ key: ++k, itemId: '', qty: '', requiredBy: '', specification: '', requisitionLineId: '', prLabel: '' });

export function RfqFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['rfq', id], enabled: editing, queryFn: () => api<RfqDetail>(`/rfqs/${id}`) });
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/legal-entities?status=Active&limit=100') });
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; itemType: string; baseUom: string }>>('/items?status=Active&limit=100') });
  const vendors = useQuery({ queryKey: ['vendors-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string; rating: string | null; itemCount: number }>>('/vendors?usable=1&limit=100') });
  const [h, setH] = useState({ legalEntityId: '', warehouseId: '', responseDue: '', notes: '' });
  const [lines, setLines] = useState<DraftLine[]>([blank()]);
  const [invited, setInvited] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const warehouses = useQuery({ queryKey: ['warehouses', h.legalEntityId], enabled: !!h.legalEntityId,
    queryFn: () => api<Page<{ id: string; code: string; name: string; type: string }>>(`/warehouses?status=Active&limit=100&legalEntityId=${h.legalEntityId}`) });
  const prId = params.get('requisitionId');
  const pr = useQuery({ queryKey: ['requisition', prId], enabled: !!prId && !editing,
    queryFn: () => api<{ docNo: string; legalEntityId: string; warehouseId: string; requiredBy: string; lines: { itemId: string; qty: string; orderedQty: string; requiredBy: string | null; remarks: string | null; lineNo: number }[] }>(`/purchase-requisitions/${prId}`) });
  const prLineIds = useQuery({ queryKey: ['open-pr-lines', pr.data?.legalEntityId], enabled: !!pr.data,
    queryFn: () => api<{ data: { id: string; requisitionId: string; itemId: string }[] }>(`/purchase-orders/open-requisition-lines?legalEntityId=${pr.data!.legalEntityId}`) });

  useEffect(() => {
    if (loaded || !existing.data) return;
    const r = existing.data;
    setH({ legalEntityId: r.legalEntityId, warehouseId: r.warehouseId, responseDue: r.responseDue, notes: r.notes ?? '' });
    setLines(r.lines.map((l) => ({ key: ++k, itemId: l.itemId, qty: String(Number(l.qty)), requiredBy: l.requiredBy ?? '', specification: l.specification ?? '', requisitionLineId: '', prLabel: '' })));
    setInvited(r.vendors.map((v) => v.id));
    setLoaded(true);
  }, [existing.data, loaded]);
  useEffect(() => {
    if (!pr.data || !prLineIds.data || editing) return;
    const ids = new Map(prLineIds.data.data.filter((x) => x.requisitionId === prId).map((x) => [x.itemId, x.id]));
    setH((x) => ({ ...x, legalEntityId: pr.data!.legalEntityId, warehouseId: pr.data!.warehouseId }));
    setLines(pr.data.lines.filter((l) => ids.has(l.itemId)).map((l) => ({ key: ++k, itemId: l.itemId, qty: String(Number(l.qty) - Number(l.orderedQty)), requiredBy: l.requiredBy ?? pr.data!.requiredBy,
      specification: l.remarks ?? '', requisitionLineId: ids.get(l.itemId)!, prLabel: pr.data!.docNo })));
  }, [pr.data, prLineIds.data, prId, editing]);
  useEffect(() => { if (!h.legalEntityId && entities.data?.data.length === 1) setH((x) => ({ ...x, legalEntityId: entities.data!.data[0]!.id })); }, [entities.data, h.legalEntityId]);
  const itemById = useMemo(() => new Map((items.data?.data ?? []).map((i) => [i.id, i])), [items.data]);
  if (editing && (!loaded || existing.isLoading)) return <Skeleton className="h-96" />;
  if (editing && existing.data && !existing.data.allowedActions.includes('edit')) return <Card><EmptyState title="This RFQ cannot be edited" text={`It is ${existing.data.status}.`} /></Card>;
  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const valid = h.legalEntityId && h.warehouseId && h.responseDue && invited.length > 0 && lines.some((l) => l.itemId && Number(l.qty) > 0);
  const save = async () => {
    setError(null); setSaving(true);
    const body = { ...h, notes: h.notes || null, vendorIds: invited,
      lines: lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty), requiredBy: l.requiredBy || null, specification: l.specification || null, requisitionLineId: l.requisitionLineId || null })) };
    try {
      if (editing) { await api(`/rfqs/${id}`, { method: 'PUT', body: { ...body, version: existing.data!.version } }); toast('success', 'RFQ saved.'); await qc.invalidateQueries(); nav(`/purchase/rfqs/${id}`); }
      else { const r = await api<{ id: string; docNo: string }>('/rfqs', { body }); toast('success', `Saved as Draft ${r.docNo}.`); nav(`/purchase/rfqs/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data!.docNo}` : 'New request for quotation'} crumbs={<Link to="/purchase/rfqs" className="hover:text-primary">RFQs</Link>}
        subtitle="Invite at least two approved vendors where possible. Only vendors approved for an item can win it." />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="Request">
          <div className="grid gap-5 md:grid-cols-3">
            <Field label="Legal entity" htmlFor="rq-le" required><Select id="rq-le" value={h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, legalEntityId: e.target.value, warehouseId: '' }))}>
              <option value="">Select…</option>{(entities.data?.data ?? []).map((le) => <option key={le.id} value={le.id}>{le.code} — {le.name}</option>)}</Select></Field>
            <Field label="Deliver to" htmlFor="rq-wh" required><Select id="rq-wh" value={h.warehouseId} disabled={!h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, warehouseId: e.target.value }))}>
              <option value="">Select…</option>{(warehouses.data?.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></Field>
            <Field label="Responses due by" htmlFor="rq-due" required><Input id="rq-due" type="date" value={h.responseDue} onChange={(e) => setH((x) => ({ ...x, responseDue: e.target.value }))} /></Field>
            <div className="md:col-span-3"><Field label="Notes to vendors" htmlFor="rq-notes"><Textarea id="rq-notes" rows={2} maxLength={1000} value={h.notes} onChange={(e) => setH((x) => ({ ...x, notes: e.target.value }))} /></Field></div>
          </div>
        </Card>
        <Card title="Items" padded={false} actions={<Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setLines([...lines, blank()])}>Add line</Button>}>
          <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-5 py-3">Item</th><th className="w-32 px-2 py-3">Quantity</th><th className="w-40 px-2 py-3">Needed by</th><th className="px-2 py-3">Specification</th><th className="px-3 py-3" /></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.key} className="border-b border-line align-top last:border-0">
                <td className="px-5 py-2"><Select aria-label={`Item for line ${i + 1}`} value={l.itemId} disabled={!!l.requisitionLineId} onChange={(e) => setLine(l.key, { itemId: e.target.value })}>
                  <option value="">Select…</option>{(items.data?.data ?? []).filter((x) => x.itemType !== 'FG').map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</Select>
                  {l.prLabel && <p className="mt-1 text-[12px] text-ink-2">From {l.prLabel}</p>}</td>
                <td className="px-2 py-2"><div className="flex items-center gap-1"><Input aria-label={`Quantity for line ${i + 1}`} type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} /><span className="text-[12px] text-ink-2">{itemById.get(l.itemId)?.baseUom}</span></div></td>
                <td className="px-2 py-2"><Input aria-label={`Needed by for line ${i + 1}`} type="date" value={l.requiredBy} onChange={(e) => setLine(l.key, { requiredBy: e.target.value })} /></td>
                <td className="px-2 py-2"><Input aria-label={`Specification for line ${i + 1}`} maxLength={500} value={l.specification} onChange={(e) => setLine(l.key, { specification: e.target.value })} placeholder="e.g. Zn ≥ 33%, moisture ≤ 1%" /></td>
                <td className="px-3 py-2"><Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash size={16} /></Button></td>
              </tr>))}</tbody>
          </table></div>
        </Card>
        <Card title={`Vendors to invite (${invited.length})`}>
          {(vendors.data?.data ?? []).length === 0 ? <p className="text-ink-2">No active vendors yet.</p> : (
            <ul className="grid gap-2 md:grid-cols-2">{vendors.data!.data.map((v) => (
              <li key={v.id}><label className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
                <input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={invited.includes(v.id)} onChange={(e) => setInvited((x) => (e.target.checked ? [...x, v.id] : x.filter((y) => y !== v.id)))} />
                <span className="flex-1">{v.legalName} <span className="text-ink-2">{v.code} · {v.itemCount} item(s){v.rating ? ` · rated ${v.rating}` : ''}</span></span></label></li>))}</ul>
          )}
          <div className="mt-5 flex gap-2"><Button loading={saving} disabled={!valid} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- detail: quotes, comparison, award
export function RfqDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['rfq', id], queryFn: () => api<RfqDetail>(`/rfqs/${id}`) });
  const [quoteFor, setQuoteFor] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const [choice, setChoice] = useState<Record<string, { vendorQuoteId: string; reason: string }>>({});
  const issue = useMutation({ mutationFn: () => api(`/rfqs/${id}/issue`, { method: 'POST' }), onSuccess: async () => { toast('success', 'RFQ issued. Record each vendor’s quotation as it arrives.'); await qc.invalidateQueries(); } });
  const award = useMutation({
    mutationFn: () => api<{ purchaseOrders: { id: string; docNo: string }[] }>(`/rfqs/${id}/award`, { body: { lines: Object.entries(choice).map(([rfqLineId, c]) => ({ rfqLineId, vendorQuoteId: c.vendorQuoteId, overrideReason: c.reason || null })) } }),
    onSuccess: async (r) => { toast('success', `Awarded. Draft ${r.purchaseOrders.map((p) => p.docNo).join(', ')} created — review and submit.`); await qc.invalidateQueries(); if (r.purchaseOrders.length === 1) nav(`/purchase/orders/${r.purchaseOrders[0]!.id}`); },
  });
  const d = q.data;
  // pre-select the recommended bid per line
  useEffect(() => {
    if (!d) return;
    setChoice((c) => (Object.keys(c).length ? c : Object.fromEntries(d.lines.filter((l) => l.recommended).map((l) => [l.id, { vendorQuoteId: l.recommended!, reason: '' }]))));
  }, [d]);
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const canAward = a.includes('award') && Object.keys(choice).length > 0 && d.lines.every((l) => {
    const c = choice[l.id]; if (!c) return true;
    const bid = l.bids.find((b) => b.vendorQuoteId === c.vendorQuoteId);
    return bid?.qualified && (bid.rank === 1 || c.reason.trim());
  });
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/purchase/rfqs" className="hover:text-primary">RFQs</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status === 'Awarded' ? 'Approved' : d.status === 'Issued' ? 'Pending' : d.status} label={d.status} /><span>Responses due {fmtDate(d.responseDue)} · deliver to {d.warehouseCode}</span></span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/purchase/rfqs/${id}/edit`)}>Edit</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel RFQ</Button>}
          {a.includes('issue') && <Button loading={issue.isPending} onClick={() => issue.mutate()}>Issue to vendors</Button>}
          {a.includes('award') && <Button icon={<Trophy size={18} />} loading={award.isPending} disabled={!canAward} onClick={() => award.mutate()}>Award selected</Button>}
        </>} />
      <ErrorBanner error={issue.error ?? award.error} />
      {d.purchaseOrders.length > 0 && <div className="mb-6 rounded-md bg-success-bg px-4 py-3 text-success-text">Purchase orders: {d.purchaseOrders.map((p, i) => <span key={p.id}>{i ? ', ' : ''}<Link className="font-semibold underline" to={`/purchase/orders/${p.id}`}>{p.docNo}</Link> ({p.vendorName}, {p.status})</span>)}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {d.lines.map((l) => (
            <Card key={l.id} title={<span>Line {l.lineNo}: {l.itemCode} {l.itemName} — {fmtNum(Number(l.qty))} {l.uom}</span>} padded={false}>
              {l.specification && <p className="px-6 pb-3 text-[13px] text-ink-2">Specification: {l.specification}</p>}
              {l.bids.length === 0 ? <p className="px-6 pb-6 text-ink-2">No quotes yet.</p> : (
                <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
                  <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                    {a.includes('award') && <th className="px-4 py-3">Award</th>}<th className="px-4 py-3">Rank</th><th className="px-3 py-3">Vendor</th><th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3 text-right">Freight / unit</th>
                    <th className="px-3 py-3 text-right">Landed rate</th><th className="px-3 py-3 text-right">Lead time</th><th className="px-3 py-3 text-right">Rating</th><th className="px-3 py-3 text-right">Score</th><th className="px-3 py-3">Notes</th></tr></thead>
                  <tbody>{l.bids.map((b) => {
                    const picked = (l.award?.vendorQuoteId ?? choice[l.id]?.vendorQuoteId) === b.vendorQuoteId;
                    return (
                      <tr key={b.vendorQuoteId} className={clsx('border-b border-line align-top last:border-0', picked && 'bg-primary-soft/50', !b.qualified && 'text-ink-2')}>
                        {a.includes('award') && <td className="px-4 py-3"><input type="radio" aria-label={`Award line ${l.lineNo} to ${b.vendorName}`} name={`award-${l.id}`} className="h-5 w-5 accent-[#5B38F5]" disabled={!b.qualified}
                          checked={choice[l.id]?.vendorQuoteId === b.vendorQuoteId} onChange={() => setChoice((c) => ({ ...c, [l.id]: { vendorQuoteId: b.vendorQuoteId, reason: '' } }))} /></td>}
                        <td className="px-4 py-3 font-semibold">{b.rank || '—'}{b.rank === 1 && <span className="ml-1 text-[12px] font-normal text-primary">recommended</span>}</td>
                        <td className="px-3 py-3"><span className="font-medium">{b.vendorName}</span><br /><span className="text-[12px] text-ink-2">{b.quoteRef} · {b.paymentTermsDays} days credit</span></td>
                        <td className="px-3 py-3 text-right num">{rate4(b.rate)}{b.discountPct ? <span className="block text-[12px] text-ink-2">−{b.discountPct}% → {rate4(b.netRate)}</span> : null}</td>
                        <td className="px-3 py-3 text-right num">{b.freightPerUnit ? rate4(b.freightPerUnit) : '—'}</td>
                        <td className="px-3 py-3 text-right num font-semibold">{rate4(b.landedRate)}</td>
                        <td className="px-3 py-3 text-right num">{b.leadDays} days</td>
                        <td className="px-3 py-3 text-right num">{b.rating ?? 'new'}</td>
                        <td className="px-3 py-3 text-right num" title={`Price ${b.scores.price.toFixed(1)} + lead time ${b.scores.leadTime.toFixed(1)} + quality ${b.scores.quality.toFixed(1)}`}>{b.qualified ? b.score.toFixed(2) : '—'}</td>
                        <td className="px-3 py-3 text-[13px]">{b.reasons.length ? <span className="text-danger-text">{b.reasons.join('; ')}</span> : b.compliant ? 'Compliant' : ''}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              )}
              {a.includes('award') && choice[l.id] && l.bids.find((b) => b.vendorQuoteId === choice[l.id]!.vendorQuoteId)?.rank !== 1 && (
                <div className="border-t border-line px-6 py-4"><Field label="Reason for not choosing the top-ranked bid" htmlFor={`why-${l.id}`} required>
                  <Input id={`why-${l.id}`} maxLength={500} value={choice[l.id]!.reason} onChange={(e) => setChoice((c) => ({ ...c, [l.id]: { ...c[l.id]!, reason: e.target.value } }))} /></Field></div>
              )}
              {l.award && <p className="border-t border-line px-6 py-3 text-[13px]">Awarded to rank {l.award.rank} (score {l.award.score}){l.award.overrideReason ? ` — reason: ${l.award.overrideReason}` : ''}.</p>}
            </Card>
          ))}
        </div>
        <aside className="space-y-6">
          <Card title="Invited vendors">
            <ul className="divide-y divide-line">{d.vendors.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 py-3">
                <span className="min-w-0 flex-1"><span className="font-medium">{v.legalName}</span><span className="block text-[12px] text-ink-2">{v.quoteId ? `${v.quoteRef} · valid to ${fmtDate(v.validUntil)} · ${v.deliveryDays} days` : 'No quote yet'}</span></span>
                {v.quoteId ? <StatusBadge status="Active" label="Quoted" /> : <StatusBadge status="Waiting" label="Awaited" />}
                {a.includes('record_quote') && <Button size="sm" variant="secondary" onClick={() => setQuoteFor(v.id)}>{v.quoteId ? 'Replace' : 'Record quote'}</Button>}
              </li>))}</ul>
          </Card>
          <Card title="How bids are ranked">
            <p className="text-[14px]">Score out of 100: landed cost {d.weights.price}, lead time {d.weights.leadTime}, vendor quality rating {d.weights.quality} (setting <span className="num">purchase.rfq.weights</span>, D34).
              Landed rate = net rate + share of the vendor's freight (spread by value). A new vendor is scored as average (3 of 5) until receipts and QC rate it. Non-compliant bids, expired quotes and vendors not eligible are not ranked.</p>
          </Card>
          <Card title="Details"><KeyValues items={[['Legal entity', d.legalEntityName], ['Deliver to', `${d.warehouseCode} — ${d.warehouseName}`], ['Raised', `${d.createdBy}, ${fmtDateTime(d.createdAt)}`], ['Issued', fmtDateTime(d.issuedAt)], ['Notes', d.notes]]} columns="narrow" /></Card>
        </aside>
      </div>
      {quoteFor && <QuoteDialog rfq={d} partyId={quoteFor} onClose={() => setQuoteFor(null)} onDone={async () => { setQuoteFor(null); setChoice({}); await qc.invalidateQueries(); }} />}
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel RFQ" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/rfqs/${id}/cancel`, { body: { reason } }); toast('success', 'RFQ cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}

function QuoteDialog({ rfq, partyId, onClose, onDone }: { rfq: RfqDetail; partyId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const vendor = rfq.vendors.find((v) => v.id === partyId)!;
  const today = new Date().toISOString().slice(0, 10);
  const [h, setH] = useState({ quoteRef: '', quoteDate: today, validUntil: '', paymentTermsDays: '30', deliveryDays: '7', freight: '0', remarks: '' });
  const [ls, setLs] = useState(Object.fromEntries(rfq.lines.map((l) => [l.id, { rate: '', discountPct: '', compliant: true, include: true }])));
  const m = useMutation({
    mutationFn: () => api(`/rfqs/${rfq.id}/quotes`, { body: { partyId, quoteRef: h.quoteRef, quoteDate: h.quoteDate, validUntil: h.validUntil, paymentTermsDays: Number(h.paymentTermsDays),
      deliveryDays: Number(h.deliveryDays), freight: Number(h.freight || 0), remarks: h.remarks || null,
      lines: Object.entries(ls).filter(([, v]) => v.include && Number(v.rate) > 0).map(([rfqLineId, v]) => ({ rfqLineId, rate: Number(v.rate), discountPct: Number(v.discountPct || 0), compliant: v.compliant })) } }),
    onSuccess: () => { toast('success', `Quote from ${vendor.legalName} recorded.`); onDone(); },
  });
  const ok = h.quoteRef && h.quoteDate && h.validUntil && Object.values(ls).some((v) => v.include && Number(v.rate) > 0);
  return (
    <Modal open onClose={onClose} title={`Quote from ${vendor.legalName}`} width={760} description="Key in the vendor's quotation as received (rates per unit, before GST)."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!ok} onClick={() => m.mutate()}>Save quote</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Vendor's quote reference" htmlFor="vq-ref" required><Input id="vq-ref" value={h.quoteRef} onChange={(e) => setH({ ...h, quoteRef: e.target.value })} /></Field>
        <Field label="Quote date" htmlFor="vq-date" required><Input id="vq-date" type="date" value={h.quoteDate} onChange={(e) => setH({ ...h, quoteDate: e.target.value })} /></Field>
        <Field label="Valid until" htmlFor="vq-valid" required><Input id="vq-valid" type="date" value={h.validUntil} onChange={(e) => setH({ ...h, validUntil: e.target.value })} /></Field>
        <Field label="Payment terms (days)" htmlFor="vq-pay" required><Input id="vq-pay" type="number" min={0} max={180} value={h.paymentTermsDays} onChange={(e) => setH({ ...h, paymentTermsDays: e.target.value })} /></Field>
        <Field label="Delivery (days)" htmlFor="vq-lead" required><Input id="vq-lead" type="number" min={0} max={365} value={h.deliveryDays} onChange={(e) => setH({ ...h, deliveryDays: e.target.value })} /></Field>
        <Field label="Freight (₹, total)" htmlFor="vq-freight" hint="0 if delivered free"><Input id="vq-freight" type="number" min={0} value={h.freight} onChange={(e) => setH({ ...h, freight: e.target.value })} /></Field>
      </div>
      <table className="mt-5 w-full text-[14px]">
        <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="py-2">Quoted</th><th className="py-2">Item</th><th className="w-32 py-2">Rate (₹/unit)</th><th className="w-24 py-2">Disc. %</th><th className="py-2">Meets spec</th></tr></thead>
        <tbody>{rfq.lines.map((l) => {
          const v = ls[l.id]!;
          const set = (p: Partial<typeof v>) => setLs((x) => ({ ...x, [l.id]: { ...x[l.id]!, ...p } }));
          return (
            <tr key={l.id} className="border-b border-line last:border-0">
              <td className="py-2"><input type="checkbox" aria-label={`Quoted line ${l.lineNo}`} className="h-5 w-5 accent-[#5B38F5]" checked={v.include} onChange={(e) => set({ include: e.target.checked })} /></td>
              <td className="py-2">{l.itemCode} <span className="text-ink-2">{fmtNum(Number(l.qty))} {l.uom}</span></td>
              <td className="py-2 pr-2"><Input aria-label={`Rate for line ${l.lineNo}`} type="number" min="0" step="0.0001" value={v.rate} disabled={!v.include} onChange={(e) => set({ rate: e.target.value })} /></td>
              <td className="py-2 pr-2"><Input aria-label={`Discount for line ${l.lineNo}`} type="number" min="0" max="100" step="0.01" value={v.discountPct} disabled={!v.include} onChange={(e) => set({ discountPct: e.target.value })} /></td>
              <td className="py-2"><input type="checkbox" aria-label={`Meets specification line ${l.lineNo}`} className="h-5 w-5 accent-[#5B38F5]" checked={v.compliant} disabled={!v.include} onChange={(e) => set({ compliant: e.target.checked })} /></td>
            </tr>
          );
        })}</tbody>
      </table>
      <div className="mt-4"><Field label="Remarks" htmlFor="vq-rem"><Textarea id="vq-rem" rows={2} value={h.remarks} onChange={(e) => setH({ ...h, remarks: e.target.value })} /></Field></div>
      <p className="mt-2 text-[12px] text-ink-2">Value at these rates: {fmtINR(rfq.lines.reduce((a, l) => a + (ls[l.id]!.include ? Number(ls[l.id]!.rate || 0) * (1 - Number(ls[l.id]!.discountPct || 0) / 100) * Number(l.qty) : 0), 0))}</p>
    </Modal>
  );
}
