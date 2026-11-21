import { PR_PRIORITIES } from '@dhruv/contracts';
import { Plus, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';

const PRIORITY_LABEL: Record<string, string> = { NORMAL: 'Normal', URGENT: 'Urgent', EMERGENCY: 'Emergency (line stoppage)' };
const PriorityBadge = ({ p }: { p: string }) => (p === 'NORMAL' ? <span className="text-ink-2">Normal</span>
  : <StatusBadge status={p === 'EMERGENCY' ? 'Rejected' : 'Pending'} label={p === 'EMERGENCY' ? 'Emergency' : 'Urgent'} />);

interface PrRow { id: string; docNo: string; legalEntityName: string; warehouseCode: string; warehouseName: string; departmentName: string | null; requestedBy: string; requestedById: string;
  requiredBy: string; priority: string; purpose: string; status: string; statusReason: string | null; estimatedTotal: string; lineCount: number; createdAt: string; approvedAt: string | null;
  legalEntityId: string; warehouseId: string; departmentId: string | null; version: number }
interface PrLine { lineNo: number; itemId: string; itemCode: string; itemName: string; itemType: string; uom: string; qty: string; estimatedRate: string | null; requiredBy: string | null;
  suggestedVendorId: string | null; suggestedVendor: string | null; remarks: string | null; orderedQty: string; approvedVendors: number }
interface PrDetail extends PrRow {
  lines: PrLine[]; allowedActions: string[];
  approval: { id: string; docNo: string; status: string; ruleName: string; steps: { seq: number; label: string; status: string }[] | null } | null;
}

const columns: Column<PrRow>[] = [
  { key: 'doc', header: 'Requisition', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'purpose', header: 'Purpose', render: (r) => <span className="block max-w-[340px] truncate">{r.purpose}</span> },
  { key: 'by', header: 'Requested by', render: (r) => <span><span className="block">{r.requestedBy}</span><span className="text-[13px] text-ink-2">{r.departmentName ?? r.warehouseName}</span></span> },
  { key: 'req', header: 'Required by', render: (r) => <span className="num">{fmtDate(r.requiredBy)}</span> },
  { key: 'pri', header: 'Priority', render: (r) => <PriorityBadge p={r.priority} /> },
  { key: 'val', header: 'Estimated value', className: 'text-right', render: (r) => <span className="num">{Number(r.estimatedTotal) ? fmtINR(r.estimatedTotal) : '—'}</span> },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
];

export function RequisitionsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('purchase.requisition:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/purchase/requisitions/new')}>New requisition</Button> : undefined;
  return (
    <>
      <PageHeader title="Purchase Requisitions" subtitle={can('purchase.requisition:view_all')
        ? 'Every requisition of your legal entities. Approved requisitions become purchase orders.'
        : 'Your requests for material. Your department head approves them; purchase then orders.'} actions={create} />
      <DataTable<PrRow> queryKey="purchase-requisitions" path="/purchase-requisitions" columns={columns} rowHref={(r) => `/purchase/requisitions/${r.id}`}
        statusOptions={['Draft', 'Submitted', 'Approved', 'Rejected', 'Cancelled', 'Closed']} searchPlaceholder="Search number, purpose or requester"
        empty={{ title: 'No requisitions yet', text: 'Raise a requisition for the material you need, with the quantity and the date you need it by.', action: create }} />
    </>
  );
}

// ---------------------------------------------------------------- editor
interface DraftLine { key: number; itemId: string; qty: string; estimatedRate: string; requiredBy: string; suggestedVendorId: string; remarks: string }
let k = 0;
const blank = (): DraftLine => ({ key: ++k, itemId: '', qty: '', estimatedRate: '', requiredBy: '', suggestedVendorId: '', remarks: '' });
const todayISO = () => new Date().toISOString().slice(0, 10);

export function RequisitionFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['requisition', id], enabled: editing, queryFn: () => api<PrDetail>(`/purchase-requisitions/${id}`) });
  const entities = useQuery({ queryKey: ['legal-entities-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/legal-entities?status=Active&limit=100') });
  const [h, setH] = useState({ legalEntityId: '', warehouseId: '', departmentId: '', requiredBy: '', priority: 'NORMAL', purpose: '' });
  const [lines, setLines] = useState<DraftLine[]>([blank()]);
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const warehouses = useQuery({ queryKey: ['warehouses', h.legalEntityId], enabled: !!h.legalEntityId,
    queryFn: () => api<Page<{ id: string; code: string; name: string; type: string }>>(`/warehouses?status=Active&limit=100&legalEntityId=${h.legalEntityId}`) });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api<{ data: { id: string; code: string; name: string; status: string }[] }>('/departments').catch(() => ({ data: [] })) });
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; itemType: string; baseUom: string }>>('/items?status=Active&limit=100') });
  const vendors = useQuery({ queryKey: ['vendors-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/vendors?status=Active&limit=100').catch(() => ({ data: [], total: 0 })) });

  useEffect(() => {
    if (loaded || !existing.data) return;
    const p = existing.data;
    setH({ legalEntityId: p.legalEntityId, warehouseId: p.warehouseId, departmentId: p.departmentId ?? '', requiredBy: p.requiredBy, priority: p.priority, purpose: p.purpose });
    setLines(p.lines.map((l) => ({ key: ++k, itemId: l.itemId, qty: String(Number(l.qty)), estimatedRate: l.estimatedRate ? String(Number(l.estimatedRate)) : '',
      requiredBy: l.requiredBy ?? '', suggestedVendorId: l.suggestedVendorId ?? '', remarks: l.remarks ?? '' })));
    setLoaded(true);
  }, [existing.data, loaded]);
  useEffect(() => { if (!h.legalEntityId && entities.data?.data.length === 1) setH((x) => ({ ...x, legalEntityId: entities.data!.data[0]!.id })); }, [entities.data, h.legalEntityId]);

  const itemById = useMemo(() => new Map((items.data?.data ?? []).map((i) => [i.id, i])), [items.data]);
  const total = lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.estimatedRate) || 0), 0);
  const dup = new Set(lines.map((l) => l.itemId).filter((x, i, a) => x && a.indexOf(x) !== i));
  if (editing && (existing.isLoading || !loaded)) return <Skeleton className="h-96" />;
  if (editing && existing.data && !existing.data.allowedActions.includes('edit')) return <Card><EmptyState title="This requisition cannot be edited" text={`It is ${existing.data.status}.`} /></Card>;
  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const valid = h.legalEntityId && h.warehouseId && h.requiredBy && h.purpose.trim() && lines.some((l) => l.itemId && Number(l.qty) > 0) && dup.size === 0;
  const save = async () => {
    setError(null); setSaving(true);
    const body = {
      legalEntityId: h.legalEntityId, warehouseId: h.warehouseId, departmentId: h.departmentId || null, requiredBy: h.requiredBy, priority: h.priority, purpose: h.purpose,
      lines: lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => ({ itemId: l.itemId, qty: Number(l.qty), estimatedRate: l.estimatedRate === '' ? null : Number(l.estimatedRate),
        requiredBy: l.requiredBy || null, suggestedVendorId: l.suggestedVendorId || null, remarks: l.remarks || null })),
    };
    try {
      if (editing) { await api(`/purchase-requisitions/${id}`, { method: 'PUT', body: { ...body, version: existing.data!.version } }); toast('success', 'Requisition saved.'); await qc.invalidateQueries(); nav(`/purchase/requisitions/${id}`); }
      else { const r = await api<{ id: string; docNo: string }>('/purchase-requisitions', { body }); toast('success', `Saved as Draft ${r.docNo}.`); nav(`/purchase/requisitions/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data!.docNo}` : 'New purchase requisition'} crumbs={<Link to="/purchase/requisitions" className="hover:text-primary">Purchase Requisitions</Link>}
        subtitle="Say what you need, how much and by when. Your department head approves it; purchase finds the vendor and raises the order." />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="Request">
          <div className="grid gap-5 md:grid-cols-3">
            <Field label="Legal entity" htmlFor="pr-le" required><Select id="pr-le" value={h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, legalEntityId: e.target.value, warehouseId: '' }))}>
              <option value="">Select…</option>{(entities.data?.data ?? []).map((le) => <option key={le.id} value={le.id}>{le.code} — {le.name}</option>)}</Select></Field>
            <Field label="Deliver to (warehouse)" htmlFor="pr-wh" required><Select id="pr-wh" value={h.warehouseId} disabled={!h.legalEntityId} onChange={(e) => setH((x) => ({ ...x, warehouseId: e.target.value }))}>
              <option value="">Select…</option>{(warehouses.data?.data ?? []).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name} ({w.type})</option>)}</Select></Field>
            <Field label="Department" htmlFor="pr-dep"><Select id="pr-dep" value={h.departmentId} onChange={(e) => setH((x) => ({ ...x, departmentId: e.target.value }))}>
              <option value="">—</option>{(departments.data?.data ?? []).filter((d) => d.status === 'Active').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
            <Field label="Required by" htmlFor="pr-req" required><Input id="pr-req" type="date" min={todayISO()} value={h.requiredBy} onChange={(e) => setH((x) => ({ ...x, requiredBy: e.target.value }))} /></Field>
            <Field label="Priority" htmlFor="pr-pri" required hint={h.priority === 'EMERGENCY' ? 'Goes straight to the purchase head' : undefined}>
              <Select id="pr-pri" value={h.priority} onChange={(e) => setH((x) => ({ ...x, priority: e.target.value }))}>{PR_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</Select></Field>
            <div className="md:col-span-3"><Field label="Purpose / justification" htmlFor="pr-purpose" required><Textarea id="pr-purpose" rows={2} maxLength={500} value={h.purpose} onChange={(e) => setH((x) => ({ ...x, purpose: e.target.value }))} /></Field></div>
          </div>
        </Card>
        <Card title="Items" padded={false} actions={<Button size="sm" variant="secondary" icon={<Plus size={16} />} disabled={lines.length >= 100} onClick={() => setLines([...lines, blank()])}>Add line</Button>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[14px]">
              <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                <th className="px-5 py-3">Item</th><th className="w-28 px-2 py-3">Quantity</th><th className="w-28 px-2 py-3">Est. rate (₹)</th><th className="w-40 px-2 py-3">Needed by</th>
                <th className="px-2 py-3">Suggested vendor</th><th className="px-2 py-3">Remarks</th><th className="px-2 py-3 text-right">Est. value</th><th className="px-3 py-3" />
              </tr></thead>
              <tbody>{lines.map((l, i) => {
                const it = itemById.get(l.itemId);
                return (
                  <tr key={l.key} className="border-b border-line align-top last:border-0">
                    <td className="px-5 py-2"><Select aria-label={`Item for line ${i + 1}`} value={l.itemId} invalid={dup.has(l.itemId)} onChange={(e) => setLine(l.key, { itemId: e.target.value })}>
                      <option value="">Select…</option>{(items.data?.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name} ({x.itemType})</option>)}</Select>
                      {dup.has(l.itemId) && <p className="mt-1 text-[12px] text-danger-text">Already on another line.</p>}</td>
                    <td className="px-2 py-2"><div className="flex items-center gap-1"><Input aria-label={`Quantity for line ${i + 1}`} type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      <span className="text-[12px] text-ink-2">{it?.baseUom}</span></div></td>
                    <td className="px-2 py-2"><Input aria-label={`Estimated rate for line ${i + 1}`} type="number" min="0" step="0.01" value={l.estimatedRate} onChange={(e) => setLine(l.key, { estimatedRate: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`Needed by for line ${i + 1}`} type="date" min={todayISO()} value={l.requiredBy} onChange={(e) => setLine(l.key, { requiredBy: e.target.value })} /></td>
                    <td className="px-2 py-2"><Select aria-label={`Suggested vendor for line ${i + 1}`} value={l.suggestedVendorId} onChange={(e) => setLine(l.key, { suggestedVendorId: e.target.value })}>
                      <option value="">—</option>{(vendors.data?.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.legalName}</option>)}</Select></td>
                    <td className="px-2 py-2"><Input aria-label={`Remarks for line ${i + 1}`} maxLength={300} value={l.remarks} onChange={(e) => setLine(l.key, { remarks: e.target.value })} /></td>
                    <td className="px-2 py-2 pt-4 text-right num">{Number(l.qty) && Number(l.estimatedRate) ? fmtINR(Number(l.qty) * Number(l.estimatedRate)) : '—'}</td>
                    <td className="px-3 py-2"><Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash size={16} /></Button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
            <span className="text-ink-2">Estimated value <span className="ml-2 font-semibold text-ink num">{total ? fmtINR(total) : '—'}</span></span>
            <div className="flex gap-2"><Button loading={saving} disabled={!valid} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
          </div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- detail
export function RequisitionDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['requisition', id], queryFn: () => api<PrDetail>(`/purchase-requisitions/${id}`) });
  const [cancel, setCancel] = useState(false);
  const submit = useMutation({ mutationFn: () => api<{ status: string; approvalDocNo: string }>(`/purchase-requisitions/${id}/submit`, { method: 'POST', body: {} }),
    onSuccess: async (r) => { toast('success', r.status === 'Approved' ? 'Approved.' : `Sent for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/purchase/requisitions" className="hover:text-primary">Purchase Requisitions</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status} /><PriorityBadge p={d.priority} /><span>{d.requestedBy} · needed by {fmtDate(d.requiredBy)}</span></span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/purchase/requisitions/${id}/edit`)}>Edit</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel</Button>}
          {a.includes('submit') && <Button loading={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
        </>} />
      <ErrorBanner error={submit.error} />
      {d.statusReason && ['Cancelled', 'Rejected', 'Draft'].includes(d.status) && <div className="mb-6 rounded-md bg-neutral-bg px-4 py-3 text-neutral-text">{d.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Request">
          <KeyValues items={[['Purpose', d.purpose], ['Legal entity', d.legalEntityName], ['Deliver to', `${d.warehouseCode} — ${d.warehouseName}`], ['Department', d.departmentName],
            ['Requested by', d.requestedBy], ['Raised', fmtDateTime(d.createdAt)], ['Required by', fmtDate(d.requiredBy)], ['Priority', PRIORITY_LABEL[d.priority]],
            ['Estimated value', Number(d.estimatedTotal) ? fmtINR(d.estimatedTotal) : 'Not estimated']]} />
        </Card>
        <Card title="Approval">
          {!d.approval ? <p className="text-ink-2">Not submitted yet. {d.priority === 'EMERGENCY' ? 'Emergencies go to the purchase head.' : 'It goes to your department head (reporting manager).'}</p> : (
            <>
              <p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link> · {d.approval.ruleName}</p>
              <ol className="space-y-2">{(d.approval.steps ?? []).map((s) => <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>)}</ol>
            </>
          )}
          {d.approvedAt && <p className="mt-3 text-[12px] text-ink-2">Approved {fmtDateTime(d.approvedAt)}</p>}
        </Card>
      </div>
      <Card title="Items" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">#</th><th className="px-3 py-3">Item</th><th className="px-3 py-3 text-right">Quantity</th><th className="px-3 py-3 text-right">Ordered</th><th className="px-3 py-3 text-right">Est. rate</th>
            <th className="px-3 py-3">Needed by</th><th className="px-3 py-3">Suggested vendor</th><th className="px-3 py-3">Approved vendors</th><th className="px-3 py-3">Remarks</th></tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-line align-top last:border-0">
              <td className="px-5 py-3">{l.lineNo}</td><td className="px-3 py-3"><span className="font-semibold">{l.itemCode}</span><br /><span className="text-ink-2">{l.itemName}</span></td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.qty))} {l.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(l.orderedQty))}</td>
              <td className="px-3 py-3 text-right num">{l.estimatedRate ? fmtINR(l.estimatedRate) : '—'}</td><td className="px-3 py-3 num">{l.requiredBy ? fmtDate(l.requiredBy) : fmtDate(d.requiredBy)}</td>
              <td className="px-3 py-3">{l.suggestedVendor ?? '—'}</td>
              <td className="px-3 py-3">{l.approvedVendors ? <span className="num">{l.approvedVendors}</span> : <span className="text-warning-text">None yet — purchase must onboard one</span>}</td>
              <td className="px-3 py-3">{l.remarks ?? '—'}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel requisition" onClose={() => setCancel(false)}
        onConfirm={async (reason) => { await api(`/purchase-requisitions/${id}/cancel`, { body: { reason } }); toast('success', 'Requisition cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}
