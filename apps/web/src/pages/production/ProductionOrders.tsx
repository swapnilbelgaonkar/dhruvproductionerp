import { Plus } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';
import { StartBatchDialog } from './Batches';

interface OrderRow { id: string; docNo: string; plantCode: string; plantName: string; lineCode: string; lineName: string; itemId: string; itemCode: string; itemName: string; bomId: string; bomCode: string;
  bomVersionId: string | null; bomVersionNo: number | null; plannedQty: string; uom: string; batchCount: number; orderType: string; salesOrderId: string | null; salesOrderNo: string | null; priority: string;
  plannedStart: string; dueDate: string; shiftId: string | null; shiftCode: string | null; issueWarehouseId: string; issueWarehouseCode: string; issueWarehouseName: string;
  fgWarehouseId: string; fgWarehouseCode: string; fgWarehouseName: string; remarks: string | null; status: string; statusReason: string | null; shortageAccepted: boolean;
  approvedAt: string | null; releasedAt: string | null; releasedBy: string | null; createdAt: string; createdBy: string; plantId: string; lineId: string; version: number }
interface Material { id: string; lineNo: number; stepNo: number; itemId: string; itemCode: string; itemName: string; requiredQty: string; uom: string; tolerancePct: string; coveredQty: string; netIssuedQty: string }
interface Reservation { id: string; orderMaterialId: string; lotId: string; lotNo: string; vendorLotNo: string | null; expiryDate: string | null; lotStatus: string; itemId: string; itemCode: string;
  uom: string; bucket: string; qty: string; issuedQty: string; factor: string; status: string; overrideId: string | null; lotOnHand: string }
interface Movement { id: string; docNo: string; direction: string; postedAt: string; postedBy: string; remarks: string | null; lines: { lotNo: string; itemCode: string; qty: number; uom: string; bucket: string }[] }
interface Override { id: string; docNo: string; orderMaterialId: string; lotNo: string; qty: string; reason: string; status: string; statusReason: string | null; requestedBy: string; createdAt: string; deviationNo: string | null; approvalId: string | null }
interface Deviation { id: string; docNo: string; category: string; title: string; status: string; createdAt: string; lotNo: string | null; lotStatus: string | null }
interface BatchSummary { id: string; batchNo: string; seq: number; plannedQty: string; status: string; startedAt: string; completedAt: string | null; outputQty: string | null; yieldPct: string | null; fgLotNo: string | null; fgLotStatus: string | null }
interface OrderDetail extends OrderRow { batches: BatchSummary[]; materials: Material[]; reservations: Reservation[]; movements: Movement[]; overrides: Override[]; deviations: Deviation[]; allowedActions: string[];
  approval: { id: string; docNo: string; status: string; ruleName: string; steps: { seq: number; label: string; status: string }[] | null } | null }
interface Shortage { itemCode: string; required: number; covered: number; short: number; uom: string }

const STATUS_LABEL: Record<string, string> = { InProgress: 'In progress', OnHold: 'On hold' };
export const OrderStatus = ({ s }: { s: string }) => <StatusBadge status={s === 'Released' ? 'Issued' : s === 'InProgress' ? 'Pending' : s === 'Completed' ? 'Approved' : s} label={STATUS_LABEL[s] ?? s} />;
const n = (v: string | number) => Number(v);

const columns: Column<OrderRow>[] = [
  { key: 'doc', header: 'Order', render: (r) => <span><span className="block font-semibold num">{r.docNo}</span>{r.priority === 'URGENT' && <StatusBadge status="Pending" label="Urgent" />}</span> },
  { key: 'item', header: 'Product', render: (r) => <span><span className="block">{r.itemCode}</span><span className="text-[13px] text-ink-2">{r.itemName}</span></span> },
  { key: 'qty', header: 'Quantity', className: 'text-right', render: (r) => <span className="num">{fmtNum(n(r.plannedQty))} {r.uom} · {r.batchCount} batch{r.batchCount > 1 ? 'es' : ''}</span> },
  { key: 'where', header: 'Plant / line', render: (r) => <span>{r.plantCode} · {r.lineCode}</span> },
  { key: 'type', header: 'For', render: (r) => (r.orderType === 'MTO' ? <span>Order {r.salesOrderNo}</span> : <span className="text-ink-2">Stock</span>) },
  { key: 'dates', header: 'Start → due', render: (r) => <span className="num">{fmtDate(r.plannedStart)} → {fmtDate(r.dueDate)}</span> },
  { key: 'status', header: 'Status', render: (r) => <OrderStatus s={r.status} /> },
];

export function ProductionOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('mfg.order:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/production/orders/new')}>New production order</Button> : undefined;
  return (
    <>
      <PageHeader title="Production Orders" subtitle="Planned production per product and line. Once the plant head approves, release fixes the formulation in force and reserves QC-released lots; stores then issues them." actions={create} />
      <DataTable<OrderRow> queryKey="production-orders" path="/production-orders" columns={columns} rowHref={(r) => `/production/orders/${r.id}`}
        statusOptions={['Draft', 'Submitted', 'Approved', 'Released', 'InProgress', 'OnHold', 'Completed', 'Closed', 'Cancelled', 'Rejected']} searchPlaceholder="Search order, product or sales order"
        empty={{ title: 'No production orders yet', text: 'Plan production for a product with an approved formulation: quantity, line, dates and the stores to draw from and deliver to.', action: create }} />
    </>
  );
}

// ---------------------------------------------------------------- editor
interface PlantOpt { id: string; code: string; name: string; legalEntityId: string; lines: { id: string; code: string; name: string; status: string }[]; shifts: { id: string; code: string; name: string; status: string }[] }
interface CheckLine { lineNo: number; stepNo: number; itemCode: string; itemName: string; uom: string; required: string; available: string; quarantine: string; substitutes: number }
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function ProductionOrderFormPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['production-order', id], enabled: editing, queryFn: () => api<OrderDetail>(`/production-orders/${id}`) });
  const plants = useQuery({ queryKey: ['production-plants'], queryFn: () => api<{ data: PlantOpt[] }>('/production/plants') });
  const boms = useQuery({ queryKey: ['boms-all'], queryFn: () => api<Page<{ itemCode: string; currentVersion: number | null }>>('/boms?limit=100') });
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; itemType: string; baseUom: string }>>('/items?status=Active&limit=100') });
  const sos = useQuery({ queryKey: ['sales-orders-approved'], queryFn: () => api<Page<{ id: string; docNo: string; partyName: string }>>('/sales-orders?status=Approved&limit=100').catch(() => ({ data: [], total: 0 })) });
  const [f, setF] = useState({ plantId: '', lineId: '', shiftId: '', itemId: sp.get('itemId') ?? '', plannedQty: '', orderType: 'MTS', salesOrderId: '', priority: 'NORMAL',
    plannedStart: todayISO(), dueDate: '', issueWarehouseId: '', fgWarehouseId: '', remarks: '' });
  const [loaded, setLoaded] = useState(!editing);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const plant = plants.data?.data.find((p) => p.id === f.plantId);
  const warehouses = useQuery({ queryKey: ['warehouses', plant?.legalEntityId], enabled: !!plant,
    queryFn: () => api<Page<{ id: string; code: string; name: string; type: string }>>(`/warehouses?status=Active&limit=100&legalEntityId=${plant!.legalEntityId}`) });
  const check = useQuery({ queryKey: ['material-check', f.itemId, f.issueWarehouseId, f.plannedQty, f.plannedStart],
    enabled: !!(f.itemId && f.issueWarehouseId && Number(f.plannedQty) > 0 && f.plannedStart),
    queryFn: () => api<{ version: { versionNo: number; batchSize: string; batchUom: string; batches: number; bomCode: string } | null; lines: CheckLine[] }>(
      `/production-orders/material-check?itemId=${f.itemId}&issueWarehouseId=${f.issueWarehouseId}&plannedQty=${Number(f.plannedQty)}&onDate=${f.plannedStart}`) });
  useEffect(() => {
    if (loaded || !existing.data) return;
    const o = existing.data;
    setF({ plantId: o.plantId, lineId: o.lineId, shiftId: o.shiftId ?? '', itemId: o.itemId, plannedQty: String(n(o.plannedQty)), orderType: o.orderType, salesOrderId: o.salesOrderId ?? '',
      priority: o.priority, plannedStart: o.plannedStart, dueDate: o.dueDate, issueWarehouseId: o.issueWarehouseId, fgWarehouseId: o.fgWarehouseId, remarks: o.remarks ?? '' });
    setLoaded(true);
  }, [existing.data, loaded]);
  useEffect(() => { if (!f.plantId && plants.data?.data.length === 1) setF((x) => ({ ...x, plantId: plants.data!.data[0]!.id })); }, [plants.data, f.plantId]);
  const withBom = useMemo(() => new Set((boms.data?.data ?? []).filter((b) => b.currentVersion).map((b) => b.itemCode)), [boms.data]);
  const products = (items.data?.data ?? []).filter((i) => ['FG', 'SEMI'].includes(i.itemType) && withBom.has(i.code));
  const product = products.find((i) => i.id === f.itemId);
  if (editing && (existing.isLoading || !loaded)) return <Skeleton className="h-96" />;
  if (editing && existing.data && !existing.data.allowedActions.includes('edit')) return <Card><EmptyState title="This order cannot be edited" text={`It is ${existing.data.status}.`} /></Card>;
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const whs = warehouses.data?.data ?? [];
  const valid = f.plantId && f.lineId && f.itemId && Number(f.plannedQty) > 0 && f.plannedStart && f.dueDate && f.dueDate >= f.plannedStart && f.issueWarehouseId && f.fgWarehouseId
    && (f.orderType === 'MTS' || f.salesOrderId);
  const save = async () => {
    setSaving(true); setError(null);
    const body = { plantId: f.plantId, lineId: f.lineId, shiftId: f.shiftId || null, itemId: f.itemId, plannedQty: Number(f.plannedQty), orderType: f.orderType,
      salesOrderId: f.orderType === 'MTO' ? f.salesOrderId : null, priority: f.priority, plannedStart: f.plannedStart, dueDate: f.dueDate,
      issueWarehouseId: f.issueWarehouseId, fgWarehouseId: f.fgWarehouseId, remarks: f.remarks || null };
    try {
      if (editing) { await api(`/production-orders/${id}`, { method: 'PUT', body: { ...body, version: existing.data!.version } }); toast('success', 'Production order saved.'); await qc.invalidateQueries(); nav(`/production/orders/${id}`); }
      else { const r = await api<{ id: string; docNo: string }>('/production-orders', { body }); toast('success', `Saved as Draft ${r.docNo}.`); nav(`/production/orders/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  const ver = check.data?.version;
  return (
    <>
      <PageHeader title={editing ? `Edit ${existing.data!.docNo}` : 'New production order'} crumbs={<Link to="/production/orders" className="hover:text-primary">Production Orders</Link>}
        subtitle="Only products with an approved formulation in force can be planned. The plant head approves; release then reserves the material." />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="What and where">
          <div className="grid gap-5 md:grid-cols-3">
            <Field label="Product" htmlFor="po-item" required hint={products.length ? undefined : 'No product has an approved formulation in force yet'}>
              <Select id="po-item" value={f.itemId} onChange={(e) => set({ itemId: e.target.value })}><option value="">Select…</option>
                {products.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}</Select></Field>
            <Field label={`Quantity${product ? ` (${product.baseUom})` : ''}`} htmlFor="po-qty" required><Input id="po-qty" type="number" min="0" step="any" value={f.plannedQty} onChange={(e) => set({ plannedQty: e.target.value })} /></Field>
            <Field label="Priority" htmlFor="po-pri"><Select id="po-pri" value={f.priority} onChange={(e) => set({ priority: e.target.value })}><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option></Select></Field>
            <Field label="Plant" htmlFor="po-plant" required><Select id="po-plant" value={f.plantId} onChange={(e) => set({ plantId: e.target.value, lineId: '', shiftId: '', issueWarehouseId: '', fgWarehouseId: '' })}>
              <option value="">Select…</option>{(plants.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}</Select></Field>
            <Field label="Production line" htmlFor="po-line" required><Select id="po-line" value={f.lineId} disabled={!plant} onChange={(e) => set({ lineId: e.target.value })}>
              <option value="">Select…</option>{(plant?.lines ?? []).filter((l) => l.status === 'Active').map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}</Select></Field>
            <Field label="Shift" htmlFor="po-shift"><Select id="po-shift" value={f.shiftId} disabled={!plant} onChange={(e) => set({ shiftId: e.target.value })}>
              <option value="">Any</option>{(plant?.shifts ?? []).filter((s) => s.status === 'Active').map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}</Select></Field>
            <Field label="Draw material from" htmlFor="po-iwh" required><Select id="po-iwh" value={f.issueWarehouseId} disabled={!plant} onChange={(e) => set({ issueWarehouseId: e.target.value })}>
              <option value="">Select…</option>{whs.filter((w) => ['RM', 'PM', 'GENERAL'].includes(w.type)).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name} ({w.type})</option>)}</Select></Field>
            <Field label="Deliver output to" htmlFor="po-fwh" required><Select id="po-fwh" value={f.fgWarehouseId} disabled={!plant} onChange={(e) => set({ fgWarehouseId: e.target.value })}>
              <option value="">Select…</option>{whs.filter((w) => ['FG', 'GENERAL'].includes(w.type)).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name} ({w.type})</option>)}</Select></Field>
            <div />
            <Field label="Planned start" htmlFor="po-start" required><Input id="po-start" type="date" min={todayISO()} value={f.plannedStart} onChange={(e) => set({ plannedStart: e.target.value })} /></Field>
            <Field label="Due" htmlFor="po-due" required><Input id="po-due" type="date" min={f.plannedStart || todayISO()} value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></Field>
            <Field label="Made for" htmlFor="po-type" required><Select id="po-type" value={f.orderType} onChange={(e) => set({ orderType: e.target.value, salesOrderId: '' })}>
              <option value="MTS">Stock (make to stock)</option><option value="MTO">A sales order (make to order)</option></Select></Field>
            {f.orderType === 'MTO' && <Field label="Sales order" htmlFor="po-so" required><Select id="po-so" value={f.salesOrderId} onChange={(e) => set({ salesOrderId: e.target.value })}>
              <option value="">Select…</option>{(sos.data?.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.docNo} — {s.partyName}</option>)}</Select></Field>}
            <div className="md:col-span-3"><Field label="Remarks" htmlFor="po-rem"><Textarea id="po-rem" rows={2} maxLength={1000} value={f.remarks} onChange={(e) => set({ remarks: e.target.value })} /></Field></div>
          </div>
        </Card>
        <Card title="Material check" padded={false}>
          {!ver ? <p className="p-5 text-ink-2">{f.itemId && f.issueWarehouseId && Number(f.plannedQty) > 0 ? (check.isLoading ? 'Checking…' : 'No approved formulation is in force on the planned start.') : 'Choose the product, quantity and the store to draw from to see the material needed and what is free.'}</p> : (
            <>
              <p className="px-5 pt-5 text-ink-2">{ver.bomCode} v{ver.versionNo}: {ver.batches} batch{ver.batches > 1 ? 'es' : ''} of {fmtNum(n(ver.batchSize))} {ver.batchUom}. Free stock is QC-released, unexpired and not reserved.</p>
              <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[760px] text-[14px]">
                <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                  <th className="px-5 py-3">Step</th><th className="px-3 py-3">Material</th><th className="px-3 py-3 text-right">Needed</th><th className="px-3 py-3 text-right">Free released</th>
                  <th className="px-3 py-3 text-right">In quarantine</th><th className="px-3 py-3">Check</th></tr></thead>
                <tbody>{check.data!.lines.map((l) => {
                  const short = n(l.required) - n(l.available);
                  return (
                    <tr key={l.lineNo} className="border-b border-line last:border-0">
                      <td className="px-5 py-3 num">{l.stepNo}</td><td className="px-3 py-3"><span className="font-semibold">{l.itemCode}</span> <span className="text-ink-2">{l.itemName}</span></td>
                      <td className="px-3 py-3 text-right num">{fmtNum(n(l.required))} {l.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(n(l.available))}</td>
                      <td className="px-3 py-3 text-right num">{n(l.quarantine) ? fmtNum(n(l.quarantine)) : '—'}</td>
                      <td className="px-3 py-3">{short > 0 ? <StatusBadge status="Rejected" label={`Short ${fmtNum(short)}${l.substitutes ? ' · substitutes may cover' : ''}`} /> : <StatusBadge status="Approved" label="Enough" />}</td>
                    </tr>);
                })}</tbody>
              </table></div>
            </>
          )}
          <div className="flex justify-end gap-2 border-t border-line px-5 py-4"><Button loading={saving} disabled={!valid} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- detail
export function ProductionOrderDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['production-order', id], queryFn: () => api<OrderDetail>(`/production-orders/${id}`) });
  const [dialog, setDialog] = useState<null | 'cancel' | 'hold' | 'resume' | 'issue' | 'return' | 'release-short' | 'batch' | 'close'>(null);
  const plants = useQuery({ queryKey: ['production-plants'], queryFn: () => api<{ data: PlantOpt[] }>('/production/plants') });
  const [shortages, setShortages] = useState<Shortage[]>([]);
  const [override, setOverride] = useState<Material | null>(null);
  const refresh = () => qc.invalidateQueries();
  const submit = useMutation({ mutationFn: () => api<{ status: string; approvalDocNo: string }>(`/production-orders/${id}/submit`, { method: 'POST', body: {} }),
    onSuccess: async (r) => { toast('success', r.status === 'Approved' ? 'Approved.' : `Sent for approval as ${r.approvalDocNo}.`); await refresh(); } });
  const release = useMutation({ mutationFn: () => api<{ bomVersionNo: number }>(`/production-orders/${id}/release`, { body: {} }),
    onSuccess: async (r) => { toast('success', `Released on formulation v${r.bomVersionNo}; material reserved.`); await refresh(); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'MATERIAL_SHORTAGE') { setShortages((e.body.details as { shortages: Shortage[] }).shortages); setDialog('release-short'); } } });
  const reserve = useMutation({ mutationFn: () => api<{ shortages: Shortage[] }>(`/production-orders/${id}/reserve`, { body: {} }),
    onSuccess: async (r) => { toast(r.shortages.length ? 'error' : 'success', r.shortages.length ? `Still short: ${r.shortages.map((s) => `${s.itemCode} ${fmtNum(s.short)} ${s.uom}`).join(', ')}.` : 'All material is reserved.'); await refresh(); } });
  if (q.isLoading) return <Skeleton className="h-96" />;
  const o = q.data;
  if (!o) return <ErrorBanner error={q.error} />;
  const a = o.allowedActions;
  const shortOf = (m: Material) => Math.max(0, Math.round((n(m.requiredQty) - n(m.coveredQty)) * 10000) / 10000);
  const pendingOverride = (m: Material) => o.overrides.some((x) => x.orderMaterialId === m.id && x.status === 'Submitted');
  return (
    <>
      <PageHeader title={o.docNo} crumbs={<Link to="/production/orders" className="hover:text-primary">Production Orders</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><OrderStatus s={o.status} />{o.priority === 'URGENT' && <StatusBadge status="Pending" label="Urgent" />}
          <span>{fmtNum(n(o.plannedQty))} {o.uom} {o.itemCode} — {o.itemName} · {o.plantCode} {o.lineCode}</span></span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/production/orders/${id}/edit`)}>Edit</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setDialog('cancel')}>Cancel order</Button>}
          {a.includes('hold') && <Button variant="secondary" onClick={() => setDialog('hold')}>Put on hold</Button>}
          {a.includes('resume') && <Button variant="secondary" onClick={() => setDialog('resume')}>Resume</Button>}
          {a.includes('reserve') && o.materials.some((m) => shortOf(m) > 0) && <Button variant="secondary" loading={reserve.isPending} onClick={() => reserve.mutate()}>Reserve again</Button>}
          {a.includes('return') && <Button variant="secondary" onClick={() => setDialog('return')}>Return material</Button>}
          {a.includes('issue') && o.reservations.some((r) => r.status === 'Active') && <Button onClick={() => setDialog('issue')}>Issue material</Button>}
          {a.includes('submit') && <Button loading={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
          {a.includes('release') && <Button loading={release.isPending} onClick={() => release.mutate()}>Release to production</Button>}
          {a.includes('close') && <Button variant="secondary" onClick={() => setDialog('close')}>Close order</Button>}
          {a.includes('start_batch') && <Button onClick={() => setDialog('batch')}>Start batch {o.batches.filter((x) => x.status === 'Completed').length + 1} of {o.batchCount}</Button>}
        </>} />
      <ErrorBanner error={submit.error ?? (release.error instanceof ApiError && release.error.code === 'MATERIAL_SHORTAGE' ? null : release.error) ?? reserve.error} />
      {o.statusReason && <div className="mb-6 rounded-md bg-neutral-bg px-4 py-3 text-neutral-text">{o.shortageAccepted && o.statusReason && ['Released', 'InProgress'].includes(o.status) ? 'At release, short of material: ' : ''}{o.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Order">
          <KeyValues items={[['Product', `${o.itemCode} — ${o.itemName}`], ['Quantity', `${fmtNum(n(o.plannedQty))} ${o.uom} in ${o.batchCount} batch${o.batchCount > 1 ? 'es' : ''}`],
            ['Formulation', o.bomVersionNo ? <Link className="text-primary" to={`/production/formulations/${o.bomId}/versions/${o.bomVersionId}`}>{o.bomCode} v{o.bomVersionNo}</Link> : `${o.bomCode} — version fixed at release`],
            ['Plant and line', `${o.plantCode} ${o.plantName} · ${o.lineCode} ${o.lineName}`], ['Shift', o.shiftCode ?? 'Any'], ['Planned start', fmtDate(o.plannedStart)], ['Due', fmtDate(o.dueDate)],
            ['Made for', o.orderType === 'MTO' ? <Link className="text-primary" to={`/sales/orders/${o.salesOrderId}`}>{o.salesOrderNo}</Link> : 'Stock'],
            ['Material from', `${o.issueWarehouseCode} — ${o.issueWarehouseName}`], ['Output to', `${o.fgWarehouseCode} — ${o.fgWarehouseName}`],
            ['Planned by', `${o.createdBy}, ${fmtDateTime(o.createdAt)}`], ['Released', o.releasedAt ? `${o.releasedBy}, ${fmtDateTime(o.releasedAt)}` : '—'], ['Remarks', o.remarks ?? '—']]} />
        </Card>
        <Card title="Approval">
          {!o.approval ? <p className="text-ink-2">Not submitted yet. The plant head approves it.</p> : (
            <>
              <p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${o.approval.id}`}>{o.approval.docNo}</Link> · {o.approval.ruleName}</p>
              <ol className="space-y-2">{(o.approval.steps ?? []).map((s) => <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>)}</ol>
            </>
          )}
          {o.deviations.length > 0 && <div className="mt-5 border-t border-line pt-4"><p className="mb-2 font-semibold">Deviations</p>
            <ul className="space-y-2">{o.deviations.map((d) => <li key={d.id} className="flex items-center justify-between gap-2 text-[14px]">
              <Link className="text-primary" to={`/qa/deviations/${d.id}`}>{d.docNo}</Link><StatusBadge status={d.status === 'Open' ? 'Pending' : 'Closed'} label={d.status} /></li>)}</ul></div>}
        </Card>
      </div>
      <Card title="Material" padded={false} className="mt-6">
        {!o.materials.length ? <p className="p-5 text-ink-2">The material list is fixed from the formulation in force when the order is released.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Step</th><th className="px-3 py-3">Material</th><th className="px-3 py-3 text-right">Required</th><th className="px-3 py-3 text-right">Reserved</th>
              <th className="px-3 py-3 text-right">Issued (net)</th><th className="px-3 py-3 text-right">Tolerance</th><th className="px-3 py-3">Cover</th></tr></thead>
            <tbody>{o.materials.map((m) => {
              const s = shortOf(m);
              return (
                <tr key={m.id} className="border-b border-line align-top last:border-0">
                  <td className="px-5 py-3 num">{m.stepNo}</td><td className="px-3 py-3"><span className="font-semibold">{m.itemCode}</span><br /><span className="text-ink-2">{m.itemName}</span></td>
                  <td className="px-3 py-3 text-right num">{fmtNum(n(m.requiredQty))} {m.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(n(m.coveredQty))}</td>
                  <td className="px-3 py-3 text-right num">{fmtNum(n(m.netIssuedQty))}</td><td className="px-3 py-3 text-right num">±{fmtNum(n(m.tolerancePct))}%</td>
                  <td className="px-3 py-3">{s > 0 ? <div className="space-y-2"><StatusBadge status="Rejected" label={`Short ${fmtNum(s)} ${m.uom}`} />
                    {a.includes('override') && !pendingOverride(m) && <div><Button size="sm" variant="secondary" onClick={() => setOverride(m)}>Use a quarantined lot…</Button></div>}
                    {pendingOverride(m) && <p className="text-[12px] text-warning-text">Override awaiting approval</p>}</div> : <StatusBadge status="Approved" label="Covered" />}</td>
                </tr>);
            })}</tbody>
          </table></div>
        )}
      </Card>
      {o.batches.length > 0 && (
        <Card title="Batches" padded={false} className="mt-6">
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Batch</th><th className="px-3 py-3 text-right">Planned</th><th className="px-3 py-3 text-right">Output</th><th className="px-3 py-3 text-right">Yield</th>
              <th className="px-3 py-3">Finished-goods lot</th><th className="px-3 py-3">Started</th><th className="px-3 py-3">Status</th></tr></thead>
            <tbody>{o.batches.map((x) => (
              <tr key={x.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/production/batches/${x.id}`}>{x.batchNo}</Link></td>
                <td className="px-3 py-3 text-right num">{fmtNum(n(x.plannedQty))} {o.uom}</td><td className="px-3 py-3 text-right num">{x.outputQty ? fmtNum(n(x.outputQty)) : '—'}</td>
                <td className="px-3 py-3 text-right num">{x.yieldPct ? `${fmtNum(n(x.yieldPct))}%` : '—'}</td><td className="px-3 py-3">{x.fgLotNo ? `${x.fgLotNo} · ${x.fgLotStatus}` : '—'}</td>
                <td className="px-3 py-3 num">{fmtDateTime(x.startedAt)}</td><td className="px-3 py-3"><StatusBadge status={x.status === 'InProgress' ? 'Pending' : x.status === 'Completed' ? 'Approved' : x.status === 'Scrapped' ? 'Rejected' : x.status} label={x.status === 'InProgress' ? 'In progress' : x.status === 'OnHold' ? 'On hold' : x.status} /></td>
              </tr>))}</tbody>
          </table></div>
        </Card>
      )}
      {o.reservations.length > 0 && (
        <Card title="Reserved lots" padded={false} className="mt-6">
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Lot</th><th className="px-3 py-3">Item</th><th className="px-3 py-3">Expiry</th><th className="px-3 py-3">Stock</th><th className="px-3 py-3 text-right">Reserved</th>
              <th className="px-3 py-3 text-right">Issued</th><th className="px-3 py-3 text-right">Open</th><th className="px-3 py-3">State</th></tr></thead>
            <tbody>{o.reservations.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/stores/lots/${r.lotId}`}>{r.lotNo}</Link>{r.vendorLotNo && <span className="block text-[12px] text-ink-2">Vendor lot {r.vendorLotNo}</span>}</td>
                <td className="px-3 py-3">{r.itemCode}{n(r.factor) !== 1 && <span className="block text-[12px] text-ink-2">Approved substitute × {fmtNum(n(r.factor))}</span>}</td>
                <td className="px-3 py-3 num">{fmtDate(r.expiryDate)}</td>
                <td className="px-3 py-3">{r.bucket === 'QUARANTINE' ? <StatusBadge status="OnHold" label="Quarantine (override)" /> : <span>Released</span>}</td>
                <td className="px-3 py-3 text-right num">{fmtNum(n(r.qty))} {r.uom}</td><td className="px-3 py-3 text-right num">{fmtNum(n(r.issuedQty))}</td>
                <td className="px-3 py-3 text-right num">{fmtNum(n(r.qty) - n(r.issuedQty))}</td>
                <td className="px-3 py-3"><StatusBadge status={r.status === 'Consumed' ? 'Closed' : r.lotStatus === 'Released' || r.bucket === 'QUARANTINE' ? 'Active' : 'OnHold'} label={r.status === 'Consumed' ? 'Issued' : r.lotStatus === 'Released' || r.bucket === 'QUARANTINE' ? 'Open' : `Lot ${r.lotStatus}`} /></td>
              </tr>))}</tbody>
          </table></div>
        </Card>
      )}
      {(o.movements.length > 0 || o.overrides.length > 0) && (
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card title="Issues and returns">
            {!o.movements.length ? <p className="text-ink-2">Nothing issued yet.</p> : <ul className="space-y-3">{o.movements.map((m) => (
              <li key={m.id} className="text-[14px]"><p><span className="font-semibold num">{m.docNo}</span> · {m.direction === 'ISSUE' ? 'Issued' : 'Returned'} by {m.postedBy}, {fmtDateTime(m.postedAt)}</p>
                <p className="text-ink-2">{m.lines.map((l) => `${l.itemCode} ${l.lotNo} ${fmtNum(l.qty)} ${l.uom}${l.bucket === 'QUARANTINE' ? ' (quarantine)' : ''}`).join(' · ')}</p></li>))}</ul>}
          </Card>
          <Card title="Quarantine overrides">
            {!o.overrides.length ? <p className="text-ink-2">None requested.</p> : <ul className="space-y-3">{o.overrides.map((x) => (
              <li key={x.id} className="text-[14px]"><p className="flex flex-wrap items-center gap-2"><span className="font-semibold num">{x.docNo}</span><StatusBadge status={x.status} />
                {x.approvalId && <Link className="text-primary" to={`/approvals/${x.approvalId}`}>approval</Link>}</p>
                <p>Lot {x.lotNo}, {fmtNum(n(x.qty))} — {x.reason}</p><p className="text-ink-2">{x.requestedBy}, {fmtDateTime(x.createdAt)}{x.statusReason ? ` · ${x.statusReason}` : ''}</p></li>))}</ul>}
          </Card>
        </div>
      )}
      <ReasonDialog open={dialog === 'cancel'} danger title={`Cancel ${o.docNo}`} confirmLabel="Cancel order" description="Reservations are released. Material already issued must be returned first."
        onClose={() => setDialog(null)} onConfirm={async (reason) => { await api(`/production-orders/${id}/cancel`, { body: { reason } }); toast('success', 'Order cancelled.'); await refresh(); }} />
      <ReasonDialog open={dialog === 'hold' || dialog === 'resume'} title={dialog === 'hold' ? `Put ${o.docNo} on hold` : `Resume ${o.docNo}`} confirmLabel={dialog === 'hold' ? 'Put on hold' : 'Resume'}
        onClose={() => setDialog(null)} onConfirm={async (reason) => { await api(`/production-orders/${id}/${dialog}`, { body: { reason } }); toast('success', dialog === 'hold' ? 'Order on hold.' : 'Order resumed.'); await refresh(); }} />
      <ReasonDialog open={dialog === 'release-short'} title="Release short of material?" confirmLabel="Release with shortage"
        description="Lots for the rest can be reserved later with Reserve again, once QC releases them."
        onClose={() => setDialog(null)} onConfirm={async (reason) => { const r = await api<{ bomVersionNo: number }>(`/production-orders/${id}/release`, { body: { acceptShortage: true, reason } }); toast('success', `Released on formulation v${r.bomVersionNo} with a shortage.`); await refresh(); }}>
        <ul className="space-y-1 rounded-md bg-warning-bg px-4 py-3 text-warning-text">{shortages.map((s) => <li key={s.itemCode}>{s.itemCode}: needs {fmtNum(s.required)} {s.uom}, {fmtNum(s.covered)} free — short <span className="font-semibold">{fmtNum(s.short)}</span></li>)}</ul>
      </ReasonDialog>
      {dialog === 'issue' && <IssueDialog o={o} onClose={() => setDialog(null)} />}
      {dialog === 'return' && <ReturnDialog o={o} onClose={() => setDialog(null)} />}
      <ReasonDialog open={dialog === 'close'} title={`Close ${o.docNo}`} confirmLabel="Close order" description="All batches are complete. Unused material must be back in stores first."
        onClose={() => setDialog(null)} onConfirm={async (reason) => { await api(`/production-orders/${id}/close`, { body: { reason } }); toast('success', 'Order closed.'); await refresh(); }} />
      {dialog === 'batch' && <StartBatchDialog orderId={o.id} defaultShiftId={o.shiftId} onClose={() => setDialog(null)}
        shifts={(plants.data?.data.find((p) => p.id === o.plantId)?.shifts ?? []).filter((x) => x.status === 'Active')} />}
      {override && <OverrideDialog o={o} m={override} short={shortOf(override)} onClose={() => setOverride(null)} />}
    </>
  );
}

function IssueDialog({ o, onClose }: { o: OrderDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const open = o.reservations.filter((r) => r.status === 'Active');
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(open.map((r) => [r.id, String(n(r.qty) - n(r.issuedQty))])));
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = open.filter((r) => Number(qty[r.id]) > 0).map((r) => ({ reservationId: r.id, qty: Number(qty[r.id]) }));
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await api<{ docNo: string }>(`/production-orders/${o.id}/issue`, { body: { lines, remarks: remarks || null } }); toast('success', `Issued as ${r.docNo}.`); await qc.invalidateQueries(); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Issue material to ${o.docNo}`} description={`From ${o.issueWarehouseCode}. Weigh or count each lot; issue less if less is handed over.`} width={760}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!lines.length} onClick={save}>Post issue</Button></>}>
      <ErrorBanner error={error} />
      <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
        <th className="py-2">Lot</th><th className="py-2">Item</th><th className="py-2 text-right">Open</th><th className="w-36 py-2 pl-3">Issue now</th></tr></thead>
        <tbody>{open.map((r) => (
          <tr key={r.id} className="border-b border-line last:border-0">
            <td className="py-2"><span className="font-semibold">{r.lotNo}</span>{r.bucket === 'QUARANTINE' && <span className="block text-[12px] text-warning-text">Quarantine — approved override</span>}
              {r.lotStatus !== 'Released' && r.bucket !== 'QUARANTINE' && <span className="block text-[12px] text-danger-text">Lot is {r.lotStatus} — cannot be issued</span>}</td>
            <td className="py-2">{r.itemCode}</td><td className="py-2 text-right num">{fmtNum(n(r.qty) - n(r.issuedQty))} {r.uom}</td>
            <td className="py-2 pl-3"><Input aria-label={`Issue quantity for lot ${r.lotNo}`} type="number" min="0" step="any" value={qty[r.id] ?? ''} onChange={(e) => setQty({ ...qty, [r.id]: e.target.value })} /></td>
          </tr>))}</tbody></table>
      <div className="mt-4"><Field label="Remarks" htmlFor="iss-rem"><Input id="iss-rem" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>
    </Modal>
  );
}

function ReturnDialog({ o, onClose }: { o: OrderDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // net issued per material and lot, from the movement history
  const held = useMemo(() => {
    const m = new Map<string, { orderMaterialId: string; lotId: string; lotNo: string; itemCode: string; uom: string; qty: number }>();
    for (const r of o.reservations) {
      const key = `${r.orderMaterialId}|${r.lotId}`;
      if (n(r.issuedQty) > 0) m.set(key, { orderMaterialId: r.orderMaterialId, lotId: r.lotId, lotNo: r.lotNo, itemCode: r.itemCode, uom: r.uom, qty: (m.get(key)?.qty ?? 0) + n(r.issuedQty) });
    }
    for (const mv of o.movements.filter((x) => x.direction === 'RETURN')) for (const l of mv.lines) {
      const e = [...m.values()].find((x) => x.lotNo === l.lotNo && x.itemCode === l.itemCode);
      if (e) e.qty -= l.qty;
    }
    return [...m.values()].filter((x) => x.qty > 0);
  }, [o]);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = held.filter((h) => Number(qty[h.lotId]) > 0).map((h) => ({ orderMaterialId: h.orderMaterialId, lotId: h.lotId, qty: Number(qty[h.lotId]) }));
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await api<{ docNo: string }>(`/production-orders/${o.id}/return`, { body: { lines, remarks: remarks || null } }); toast('success', `Returned as ${r.docNo}.`); await qc.invalidateQueries(); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Return material from ${o.docNo}`} description="Unused material goes back to the store, into the stock status of its lot (released, quarantine, blocked or rejected)." width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!lines.length} onClick={save}>Post return</Button></>}>
      <ErrorBanner error={error} />
      <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
        <th className="py-2">Lot</th><th className="py-2">Item</th><th className="py-2 text-right">With production</th><th className="w-36 py-2 pl-3">Return</th></tr></thead>
        <tbody>{held.map((h) => (
          <tr key={h.lotId} className="border-b border-line last:border-0">
            <td className="py-2 font-semibold">{h.lotNo}</td><td className="py-2">{h.itemCode}</td><td className="py-2 text-right num">{fmtNum(h.qty)} {h.uom}</td>
            <td className="py-2 pl-3"><Input aria-label={`Return quantity for lot ${h.lotNo}`} type="number" min="0" step="any" value={qty[h.lotId] ?? ''} onChange={(e) => setQty({ ...qty, [h.lotId]: e.target.value })} /></td>
          </tr>))}</tbody></table>
      <div className="mt-4"><Field label="Remarks" htmlFor="ret-rem"><Input id="ret-rem" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field></div>
    </Modal>
  );
}

function OverrideDialog({ o, m, short, onClose }: { o: OrderDetail; m: Material; short: number; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const lots = useQuery({ queryKey: ['quarantined-lots', o.id, m.id], queryFn: () => api<{ data: { id: string; lotNo: string; vendorLotNo: string | null; vendorName: string | null; free: string; inspectionStatus: string | null }[] }>(
    `/production-orders/${o.id}/quarantined-lots?orderMaterialId=${m.id}`) });
  const [f, setF] = useState({ lotId: '', qty: String(short), reason: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lot = lots.data?.data.find((l) => l.id === f.lotId);
  const save = async () => {
    setBusy(true); setError(null);
    try { const r = await api<{ docNo: string; approvalDocNo: string }>(`/production-orders/${o.id}/overrides`, { body: { orderMaterialId: m.id, lotId: f.lotId, qty: Number(f.qty), reason: f.reason } });
      toast('success', `${r.docNo} sent to the QC head and the plant head as ${r.approvalDocNo}.`); await qc.invalidateQueries(); onClose(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Use a quarantined lot of ${m.itemCode}`} width={640}
      description="Exceptional use before QC release (BRD p.15). The QC head and the plant head must both approve. A deviation is raised for QA, and the batch cannot be released until this lot passes QC."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!f.lotId || !(Number(f.qty) > 0) || !f.reason.trim()} onClick={save}>Request override</Button></>}>
      <ErrorBanner error={error} />
      {lots.data && !lots.data.data.length ? <EmptyState title="No quarantined lot is free" text={`There is no stock of ${m.itemCode} in quarantine in ${o.issueWarehouseCode}.`} /> : (
        <div className="space-y-4">
          <Field label="Quarantined lot" htmlFor="ov-lot" required><Select id="ov-lot" value={f.lotId} onChange={(e) => setF({ ...f, lotId: e.target.value })}><option value="">Select…</option>
            {(lots.data?.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.lotNo}{l.vendorName ? ` — ${l.vendorName}` : ''} · {fmtNum(n(l.free))} free · QC {l.inspectionStatus ?? 'not started'}</option>)}</Select></Field>
          <Field label={`Quantity (${m.uom})`} htmlFor="ov-qty" required hint={`Uncovered: ${fmtNum(short)}${lot ? ` · free in lot: ${fmtNum(n(lot.free))}` : ''}`}><Input id="ov-qty" type="number" min="0" step="any" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
          <Field label="Why it cannot wait for QC" htmlFor="ov-reason" required><Textarea id="ov-reason" rows={3} maxLength={1000} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </div>
      )}
    </Modal>
  );
}

/** Approval links carry the override id only; open its production order. */
export function OverrideLink() {
  const { oid } = useParams();
  const q = useQuery({ queryKey: ['override-locate', oid], queryFn: () => api<{ productionOrderId: string }>(`/production-orders/overrides/${oid}`) });
  if (q.data) return <Navigate replace to={`/production/orders/${q.data.productionOrderId}`} />;
  return q.error ? <ErrorBanner error={q.error} /> : <Skeleton className="h-96" />;
}
