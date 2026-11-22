import { ArrowLeft, Barcode, Plus, Printer, Trash, Truck } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const th = 'px-3 py-3';
const thead = 'border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2';

interface QueueLine { id: string; lineNo: number; itemPackId: string; description: string; packLabel: string; qty: string; dispatchedQty: string; onOpenShipments: string; open: number; availablePacks: number }
interface QueueOrder { id: string; docNo: string; orderDate: string; requiredBy: string | null; legalEntityId: string; partyName: string; partyCode: string; shipToCity: string; shipToState: string; grandTotal: string; lines: QueueLine[] }
interface ShipmentRow { id: string; docNo: string; salesOrderId: string; salesOrderNo: string; partyName: string; partyCode: string; warehouseCode: string; plannedDate: string; status: string;
  statusReason: string | null; transporterName: string | null; vehicleNo: string | null; lrNo: string | null; ewbNo: string | null; dispatchedAt: string | null; shipToAddress: string; invoiceNo: string | null }
interface Pick { id: string; lotId: string; lotNo: string; expiryDate: string | null; boxSerial: string | null; packs: string; qty: string }
interface ShipLine { id: string; soLineId: string; lineNo: number; description: string; packLabel: string; hsnCode: string; plannedPacks: string; pickedPacks: string; deliveredPacks: string | null;
  orderedPacks: string; lineTotal: string; packSize: string; packUom: string; unitsPerBox: number; picks: Pick[] }
interface ShipmentDetail extends ShipmentRow {
  legalEntityName: string; partyGstin: string | null; shipToState: string; warehouseName: string; dealerPoNo: string | null; transporterId: string | null; transporterGstin: string | null;
  driverName: string | null; driverPhone: string | null; freightTerms: string | null; freightAmount: string | null; lrDate: string | null; ewbValidUntil: string | null; dispatchedBy: string | null;
  podReceivedOn: string | null; podReceivedBy: string | null; podRemarks: string | null; remarks: string | null; createdAt: string;
  lines: ShipLine[]; pickedValue: number; ewbRequired: boolean; ewbThreshold: number; allowedActions: string[];
  seller?: { name: string; address: string | null; pan: string | null; gstin: string | null };
  invoice: { id: string; docNo: string; grandTotal: string; status: string } | null; shortageCreditNote: { id: string; docNo: string; status: string } | null;
}
interface Transporter { id: string; code: string; name: string; gstin: string | null; pan: string | null; contact: string | null; phone: string | null; status: string }

// ---------------------------------------------------------------- dispatch queue (LOG-001)
export function DispatchQueuePage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['dispatch-queue'], queryFn: () => api<{ data: QueueOrder[] }>('/shipments/queue') });
  const [plan, setPlan] = useState<QueueOrder | null>(null);
  return (
    <>
      <PageHeader title="Dispatch Queue" subtitle="Approved sales orders with packs still to ship, and how many packs of each are in QA-released boxes ready to pick." />
      {q.isLoading ? <Skeleton className="h-40" /> : q.error ? <ErrorBanner error={q.error} /> : !q.data?.data.length ? (
        <Card><EmptyState title="Nothing waiting to be dispatched" text="Approved sales orders appear here until every line has been shipped." /></Card>
      ) : (
        <div className="space-y-4">{q.data.data.map((o) => (
          <Card key={o.id} title={<span><Link className="text-primary num" to={`/sales/orders/${o.id}`}>{o.docNo}</Link> · {o.partyName} <span className="text-ink-2">({o.partyCode})</span></span>}
            actions={can('logistics.shipment:create') && <Button size="sm" icon={<Plus size={16} weight="bold" />} onClick={() => setPlan(o)}>Plan shipment</Button>} padded={false}>
            <p className="px-5 pb-2 text-[13px] text-ink-2">Ordered {fmtDate(o.orderDate)}{o.requiredBy ? ` · required by ${fmtDate(o.requiredBy)}` : ''} · ship to {o.shipToCity} ({o.shipToState}) · {fmtINR(o.grandTotal)}</p>
            <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]"><thead><tr className={thead}>
              <th className="px-5 py-3">Line</th><th className={th}>Product</th><th className={`${th} text-right`}>Ordered</th><th className={`${th} text-right`}>Dispatched</th>
              <th className={`${th} text-right`}>On open shipments</th><th className={`${th} text-right`}>To plan</th><th className={`${th} text-right`}>Ready in released boxes</th></tr></thead>
              <tbody>{o.lines.map((l) => (
                <tr key={l.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num">{l.lineNo}</td><td className={th}>{l.description} <span className="text-ink-2">{l.packLabel}</span></td>
                  <td className={`${th} text-right num`}>{fmtNum(l.qty)}</td><td className={`${th} text-right num`}>{fmtNum(l.dispatchedQty)}</td><td className={`${th} text-right num`}>{fmtNum(l.onOpenShipments)}</td>
                  <td className={`${th} text-right num font-semibold`}>{fmtNum(l.open)}</td>
                  <td className={`${th} text-right num ${l.availablePacks < l.open ? 'text-warning-text' : ''}`}>{fmtNum(l.availablePacks)}</td></tr>))}</tbody></table></div>
          </Card>))}</div>
      )}
      {plan && <PlanDialog order={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

function PlanDialog({ order, onClose }: { order: QueueOrder; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const whs = useQuery({ queryKey: ['warehouses-fg', order.legalEntityId], queryFn: () => api<Page<{ id: string; code: string; name: string; type: string; legalEntityId: string }>>(`/warehouses?status=Active&limit=100`) });
  const options = (whs.data?.data ?? []).filter((w) => w.legalEntityId === order.legalEntityId && ['FG', 'GENERAL'].includes(w.type));
  const [f, setF] = useState({ warehouseId: '', plannedDate: today(), remarks: '' });
  const [packs, setPacks] = useState<Record<string, string>>(() => Object.fromEntries(order.lines.map((l) => [l.id, String(Math.min(l.open, l.availablePacks) || '')])));
  useEffect(() => { if (options.length === 1 && !f.warehouseId) setF((x) => ({ ...x, warehouseId: options[0]!.id })); }, [options, f.warehouseId]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lines = order.lines.map((l) => ({ soLineId: l.id, packs: Number(packs[l.id]) || 0 })).filter((l) => l.packs > 0);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string }>('/shipments', { body: { salesOrderId: order.id, warehouseId: f.warehouseId, plannedDate: f.plannedDate, remarks: f.remarks || null, lines } });
      toast('success', `${r.docNo} planned. Stores can now scan boxes.`); nav(`/logistics/shipments/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Plan shipment — ${order.docNo}`} description={`${order.partyName}, ${order.shipToCity}`} width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.warehouseId || !lines.length} onClick={save}>Plan shipment</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Dispatch from" htmlFor="pl-wh" required><Select id="pl-wh" value={f.warehouseId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}><option value="">Select…</option>
          {options.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></Field>
        <Field label="Planned date" htmlFor="pl-date" required><Input id="pl-date" type="date" min={today()} value={f.plannedDate} onChange={(e) => setF({ ...f, plannedDate: e.target.value })} /></Field>
      </div>
      <table className="mt-4 w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Product</th><th className="py-2 text-right">To plan</th><th className="py-2 text-right">Ready</th><th className="w-32 py-2 text-right">Packs</th></tr></thead>
        <tbody>{order.lines.map((l) => (
          <tr key={l.id} className="border-b border-line last:border-0"><td className="py-2">{l.description} <span className="text-ink-2">{l.packLabel}</span></td><td className="py-2 text-right num">{fmtNum(l.open)}</td>
            <td className="py-2 text-right num">{fmtNum(l.availablePacks)}</td>
            <td className="py-2 pl-3"><Input aria-label={`Packs of line ${l.lineNo}`} type="number" min="0" max={l.open} step="1" value={packs[l.id] ?? ''} disabled={l.open <= 0}
              onChange={(e) => setPacks({ ...packs, [l.id]: e.target.value })} /></td></tr>))}</tbody></table>
      <p className="mt-2 text-[13px] text-ink-2">Plan whole boxes where you can: stores scans boxes, and a box cannot be split at the dock.</p>
      <Field label="Remarks" htmlFor="pl-rem"><Textarea id="pl-rem" value={f.remarks} maxLength={500} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- shipments
const TABS = ['Open', 'Dispatched', 'Delivered', 'Cancelled', 'All'] as const;
export function ShipmentsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Open');
  const q = useQuery({ queryKey: ['shipments'], queryFn: () => api<{ data: ShipmentRow[] }>('/shipments') });
  const rows = (q.data?.data ?? []).filter((s) => tab === 'All' || (tab === 'Open' ? ['Planned', 'Picked'].includes(s.status) : s.status === tab));
  const count = (t: (typeof TABS)[number]) => (q.data?.data ?? []).filter((s) => t === 'All' || (t === 'Open' ? ['Planned', 'Picked'].includes(s.status) : s.status === t)).length;
  return (
    <>
      <PageHeader title="Shipments" subtitle="Planned, picked, dispatched and delivered consignments. Stock and the sales order move only when a shipment is loaded and dispatched."
        actions={<Link to="/logistics/queue"><Button variant="secondary" icon={<Truck size={18} />}>Dispatch queue</Button></Link>} />
      <Tabs value={tab} onChange={setTab} tabs={TABS.map((t) => ({ value: t, label: t, count: count(t) }))} />
      <Card padded={false} className="mt-4">
        {q.isLoading ? <Skeleton className="h-40" /> : q.error ? <div className="p-5"><ErrorBanner error={q.error} /></div> : !rows.length ? <div className="p-5"><EmptyState title="No shipments here" text="Plan a shipment from the dispatch queue." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[980px] text-[14px]"><thead><tr className={thead}>
            <th className="px-5 py-3">Shipment</th><th className={th}>Order</th><th className={th}>Dealer</th><th className={th}>From</th><th className={th}>Planned</th><th className={th}>Vehicle / LR</th><th className={th}>Invoice</th><th className={th}>Status</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/logistics/shipments/${s.id}`}>{s.docNo}</Link></td>
                <td className={th}><Link className="text-primary num" to={`/sales/orders/${s.salesOrderId}`}>{s.salesOrderNo}</Link></td>
                <td className={th}>{s.partyName}</td><td className={th}>{s.warehouseCode}</td><td className={th}>{fmtDate(s.plannedDate)}</td>
                <td className={th}>{s.vehicleNo ? `${s.vehicleNo} · LR ${s.lrNo}` : '—'}</td><td className={`${th} num`}>{s.invoiceNo ?? '—'}</td>
                <td className={th}><StatusBadge status={s.status} label={s.statusReason === 'Delivered short' ? 'Delivered short' : undefined} /></td>
              </tr>))}</tbody></table></div>
        )}
      </Card>
    </>
  );
}

export function ShipmentDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['shipment', id];
  const q = useQuery({ queryKey: key, queryFn: () => api<ShipmentDetail>(`/shipments/${id}`) });
  const [serial, setSerial] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | 'dispatch' | 'pod' | 'cancel'>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['shipments'] }); void qc.invalidateQueries({ queryKey: ['dispatch-queue'] }); };
  if (q.isLoading) return <Skeleton className="h-96" />;
  const s = q.data;
  if (!s) return <ErrorBanner error={q.error} />;
  const can = (a: string) => s.allowedActions.includes(a);
  const scan = async () => {
    if (!serial.trim()) return;
    setBusy(true); setScanError(null);
    try {
      const r = await api<{ box: string; lotNo: string; packs: number; line: number }>(`/shipments/${id}/pick`, { body: { boxSerial: serial.trim() } });
      toast('success', `${r.box}: ${r.packs} packs of lot ${r.lotNo} on line ${r.line}.`); setSerial(''); refresh();
    } catch (e) { setScanError(e instanceof ApiError ? e.message : 'The scan failed.'); } finally { setBusy(false); scanRef.current?.focus(); }
  };
  const unpick = async (p: Pick) => {
    try { await api(`/shipments/${id}/picks/${p.id}`, { method: 'DELETE' }); toast('success', `${p.boxSerial ?? p.lotNo} taken off the shipment.`); refresh(); } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Could not remove it.'); }
  };
  const planned = s.lines.reduce((a, l) => a + n(l.plannedPacks), 0);
  const picked = s.lines.reduce((a, l) => a + n(l.pickedPacks), 0);
  return (
    <>
      <PageHeader title={s.docNo} crumbs={<Link to="/logistics/shipments" className="hover:text-primary">Shipments</Link>}
        subtitle={<span>{s.partyName} · order <Link className="text-primary" to={`/sales/orders/${s.salesOrderId}`}>{s.salesOrderNo}</Link> · from {s.warehouseCode} · <StatusBadge status={s.status} label={s.statusReason === 'Delivered short' ? 'Delivered short' : undefined} /></span>}
        actions={<>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => window.open(`/logistics/shipments/${id}/challan`, '_blank')}>{['Dispatched', 'Delivered'].includes(s.status) ? 'Delivery challan' : 'Loading slip'}</Button>
          {can('cancel') && <Button variant="secondary" onClick={() => setDialog('cancel')}>Cancel shipment</Button>}
          {can('dispatch') && <Button icon={<Truck size={18} />} onClick={() => setDialog('dispatch')}>Load & dispatch</Button>}
          {can('pod') && <Button onClick={() => setDialog('pod')}>Record delivery (POD)</Button>}
        </>} />
      {s.statusReason === 'Delivered short' && s.invoice && (
        <p className="mb-4 rounded-md bg-warning-bg px-4 py-3 text-[14px] text-warning-text">Delivered short: {s.podRemarks}. {s.shortageCreditNote
          ? <>Credit note <Link className="font-semibold underline" to={`/finance/credit-notes/${s.shortageCreditNote.id}`}>{s.shortageCreditNote.docNo}</Link> ({s.shortageCreditNote.status.toLowerCase()}).</>
          : <>Accounts can credit the shortage from <Link className="font-semibold underline" to={`/finance/invoices/${s.invoice.id}`}>{s.invoice.docNo}</Link>.</>}</p>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          {can('pick') && (
            <Card title="Scan boxes">
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void scan(); }}>
                <Input ref={scanRef} autoFocus aria-label="Box serial" placeholder="Scan or type the box serial" value={serial} onChange={(e) => setSerial(e.target.value)} invalid={!!scanError} />
                <Button type="submit" loading={busy} icon={<Barcode size={18} />}>Add box</Button>
              </form>
              {scanError && <p role="alert" className="mt-2 rounded-md bg-danger-bg px-3 py-2 text-[14px] text-danger-text">{scanError}</p>}
              <p className="mt-2 text-[13px] text-ink-2">Only boxes of QA-released lots, of a pack on this shipment, can be added. {fmtNum(picked)} of {fmtNum(planned)} packs scanned.</p>
              <LoosePacks shipmentId={s.id} onDone={refresh} />
            </Card>
          )}
          <Card title="Lines" padded={false}>
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[14px]"><thead><tr className={thead}>
              <th className="px-5 py-3">Product</th><th className={`${th} text-right`}>Planned</th><th className={`${th} text-right`}>Scanned</th>{s.status === 'Delivered' && <th className={`${th} text-right`}>Delivered</th>}<th className={th}>Boxes and lots</th></tr></thead>
              <tbody>{s.lines.map((l) => (
                <tr key={l.id} className="border-b border-line align-top last:border-0">
                  <td className="px-5 py-3">{l.description}<div className="text-[13px] text-ink-2">{l.packLabel} · {l.unitsPerBox} per box</div></td>
                  <td className={`${th} text-right num`}>{fmtNum(l.plannedPacks)}</td>
                  <td className={`${th} text-right num ${n(l.pickedPacks) < n(l.plannedPacks) ? 'text-warning-text' : 'text-success-text'}`}>{fmtNum(l.pickedPacks)}</td>
                  {s.status === 'Delivered' && <td className={`${th} text-right num`}>{fmtNum(l.deliveredPacks)}</td>}
                  <td className={th}>{!l.picks.length ? <span className="text-ink-2">Nothing scanned</span> : (
                    <ul className="space-y-1">{l.picks.map((p) => (
                      <li key={p.id} className="flex items-center gap-2"><span className="num font-semibold">{p.boxSerial ?? 'Loose'}</span>
                        <span className="text-ink-2">{fmtNum(p.packs)} packs · lot <Link className="text-primary" to={`/stores/lots/${p.lotId}`}>{p.lotNo}</Link>{p.expiryDate ? ` · exp ${fmtDate(p.expiryDate)}` : ''}</span>
                        {can('pick') && <Button size="sm" variant="ghost" aria-label={`Remove ${p.boxSerial ?? p.lotNo}`} onClick={() => unpick(p)}><Trash size={16} /></Button>}</li>))}</ul>)}</td>
                </tr>))}</tbody></table></div>
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Consignment">
            <KeyValues columns="narrow" items={[['Ship to', s.shipToAddress], ['Planned', fmtDate(s.plannedDate)], ['Value scanned', fmtINR(s.pickedValue)],
              ['E-way bill', s.ewbNo ? `${s.ewbNo} (valid to ${fmtDate(s.ewbValidUntil)})` : s.ewbRequired ? `Required (above ${fmtINR(s.ewbThreshold)})` : 'Not required at this value'],
              ['Transporter', s.transporterName ?? '—'], ['Vehicle', s.vehicleNo ? `${s.vehicleNo} · ${s.driverName}${s.driverPhone ? ` (${s.driverPhone})` : ''}` : '—'],
              ['LR', s.lrNo ? `${s.lrNo} dated ${fmtDate(s.lrDate)}` : '—'], ['Freight', s.freightTerms ? `${s.freightTerms.replace('_', ' ')}${s.freightAmount ? ` · ${fmtINR(s.freightAmount)}` : ''}` : '—'],
              ['Dispatched', s.dispatchedAt ? `${s.dispatchedBy}, ${fmtDateTime(s.dispatchedAt)}` : '—'],
              ['Tax invoice', s.invoice ? <Link key="i" className="text-primary" to={`/finance/invoices/${s.invoice.id}`}>{s.invoice.docNo} · {fmtINR(s.invoice.grandTotal)}</Link> : ['Dispatched', 'Delivered'].includes(s.status) ? 'Not raised yet' : '—'],
              ['Delivered', s.podReceivedOn ? `${fmtDate(s.podReceivedOn)} — received by ${s.podReceivedBy}` : '—'], ['POD remarks', s.podRemarks ?? '—'], ['Remarks', s.remarks ?? '—']]} />
          </Card>
          {['Dispatched', 'Delivered'].includes(s.status) && <DocumentsPanel entityType="logistics.shipment" entityId={s.id} />}
        </div>
      </div>
      {dialog === 'dispatch' && <DispatchDialog s={s} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'pod' && <PodDialog s={s} onClose={() => setDialog(null)} onDone={refresh} />}
      <ReasonDialog open={dialog === 'cancel'} title={`Cancel ${s.docNo}`} description="Scanned boxes go back to stock for another shipment." confirmLabel="Cancel shipment" danger
        onClose={() => setDialog(null)} onConfirm={async (reason) => { await api(`/shipments/${id}/cancel`, { body: { reason } }); toast('success', `${s.docNo} cancelled.`); refresh(); }} />
    </>
  );
}

/** Loose packs (returned by a customer and restocked by QA) are picked by lot rather than scanned. */
function LoosePacks({ shipmentId, onDone }: { shipmentId: string; onDone: () => void }) {
  const toast = useToast();
  const q = useQuery({ queryKey: ['loose-lots', shipmentId], queryFn: () => api<{ data: { shipmentLineId: string; lineNo: number; lotId: string; lotNo: string; expiryDate: string | null; packs: number }[] }>(`/shipments/${shipmentId}/loose-lots`) });
  const [qty, setQty] = useState<Record<string, string>>({});
  if (!q.data?.data.length) return null;
  const add = async (x: { shipmentLineId: string; lotId: string; lotNo: string }) => {
    try {
      await api(`/shipments/${shipmentId}/pick`, { body: { shipmentLineId: x.shipmentLineId, lotId: x.lotId, packs: Number(qty[`${x.shipmentLineId}|${x.lotId}`]) || 0 } });
      toast('success', `Loose packs of lot ${x.lotNo} added.`); setQty({}); await q.refetch(); onDone();
    } catch (e) { toast('error', e instanceof ApiError ? e.message : 'Could not add them.'); }
  };
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="mb-2 font-semibold">Loose packs (restocked returns)</p>
      <ul className="space-y-2">{q.data.data.map((x) => {
        const k = `${x.shipmentLineId}|${x.lotId}`;
        return (
          <li key={k} className="flex flex-wrap items-center gap-2 text-[14px]"><span>Line {x.lineNo} · lot {x.lotNo}{x.expiryDate ? ` (exp ${fmtDate(x.expiryDate)})` : ''} · {x.packs} available</span>
            <Input aria-label={`Loose packs of lot ${x.lotNo}`} className="w-24" type="number" min="1" max={x.packs} step="1" value={qty[k] ?? ''} onChange={(e) => setQty({ ...qty, [k]: e.target.value })} />
            <Button size="sm" variant="secondary" disabled={!(Number(qty[k]) > 0)} onClick={() => add(x)}>Add loose packs</Button></li>);
      })}</ul>
    </div>
  );
}

function DispatchDialog({ s, onClose, onDone }: { s: ShipmentDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const trs = useQuery({ queryKey: ['transporters'], queryFn: () => api<{ data: Transporter[] }>('/shipments/transporters') });
  const [f, setF] = useState({ transporterId: '', vehicleNo: '', driverName: '', driverPhone: '', freightTerms: 'PAID', freightAmount: '', lrNo: '', lrDate: today(), ewbNo: '', ewbValidUntil: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const short = s.lines.some((l) => n(l.pickedPacks) < n(l.plannedPacks));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ orderClosed: boolean; invoice: { id: string; docNo: string } | null }>(`/shipments/${s.id}/dispatch`, { body: { transporterId: f.transporterId, vehicleNo: f.vehicleNo.replace(/[\s-]/g, '').toUpperCase(), driverName: f.driverName,
        driverPhone: f.driverPhone || null, freightTerms: f.freightTerms, freightAmount: f.freightAmount ? Number(f.freightAmount) : null, lrNo: f.lrNo, lrDate: f.lrDate,
        ewbNo: f.ewbNo || null, ewbValidUntil: f.ewbValidUntil || null } });
      toast('success', `${s.docNo} dispatched${r.invoice ? ` with tax invoice ${r.invoice.docNo}` : ''}${r.orderClosed ? `; ${s.salesOrderNo} is fully shipped and closed` : ''}.`); onDone(); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Load & dispatch ${s.docNo}`} description={`${fmtINR(s.pickedValue)} scanned. Stock leaves the warehouse and the order is updated now.`} width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.transporterId || !f.vehicleNo || !f.driverName || !f.lrNo || (s.ewbRequired && !f.ewbNo)} onClick={save}>Confirm dispatch</Button></>}>
      <ErrorBanner error={error} />
      {short && <p className="mb-4 rounded-md bg-warning-bg px-3 py-2 text-[14px] text-warning-text">Fewer packs are scanned than planned. Only what was scanned is dispatched; the rest stays open on the order.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Transporter" htmlFor="ds-tr" required><Select id="ds-tr" value={f.transporterId} onChange={(e) => setF({ ...f, transporterId: e.target.value })}><option value="">Select…</option>
          {(trs.data?.data ?? []).filter((t) => t.status === 'Active').map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}</Select></Field>
        <Field label="Vehicle number" htmlFor="ds-veh" required hint="Like MH12AB1234"><Input id="ds-veh" value={f.vehicleNo} onChange={(e) => setF({ ...f, vehicleNo: e.target.value })} /></Field>
        <Field label="Driver" htmlFor="ds-drv" required><Input id="ds-drv" value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} /></Field>
        <Field label="Driver phone" htmlFor="ds-ph"><Input id="ds-ph" inputMode="tel" value={f.driverPhone} onChange={(e) => setF({ ...f, driverPhone: e.target.value })} /></Field>
        <Field label="LR number" htmlFor="ds-lr" required><Input id="ds-lr" value={f.lrNo} onChange={(e) => setF({ ...f, lrNo: e.target.value })} /></Field>
        <Field label="LR date" htmlFor="ds-lrd" required><Input id="ds-lrd" type="date" value={f.lrDate} onChange={(e) => setF({ ...f, lrDate: e.target.value })} /></Field>
        <Field label="Freight terms" htmlFor="ds-ft" required><Select id="ds-ft" value={f.freightTerms} onChange={(e) => setF({ ...f, freightTerms: e.target.value })}>
          <option value="PAID">Paid (by us)</option><option value="TO_PAY">To pay (by consignee)</option><option value="TBB">To be billed</option></Select></Field>
        <Field label="Freight amount (₹)" htmlFor="ds-fa"><Input id="ds-fa" type="number" min="0" step="any" value={f.freightAmount} onChange={(e) => setF({ ...f, freightAmount: e.target.value })} /></Field>
        <Field label="E-way bill number" htmlFor="ds-ewb" required={s.ewbRequired} hint={s.ewbRequired ? `Required: the value is above ${fmtINR(s.ewbThreshold)}` : 'Optional at this value'}>
          <Input id="ds-ewb" inputMode="numeric" maxLength={12} value={f.ewbNo} onChange={(e) => setF({ ...f, ewbNo: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="E-way bill valid until" htmlFor="ds-ewbv" required={!!f.ewbNo}><Input id="ds-ewbv" type="date" min={today()} value={f.ewbValidUntil} onChange={(e) => setF({ ...f, ewbValidUntil: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function PodDialog({ s, onClose, onDone }: { s: ShipmentDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ receivedOn: today(), receivedBy: '', remarks: '' });
  const [got, setGot] = useState<Record<string, string>>(() => Object.fromEntries(s.lines.map((l) => [l.id, String(n(l.pickedPacks))])));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const short = s.lines.some((l) => (Number(got[l.id]) || 0) < n(l.pickedPacks));
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api(`/shipments/${s.id}/pod`, { body: { receivedOn: f.receivedOn, receivedBy: f.receivedBy, remarks: f.remarks || null, lines: s.lines.map((l) => ({ shipmentLineId: l.id, deliveredPacks: Number(got[l.id]) || 0 })) } });
      toast('success', `Delivery of ${s.docNo} recorded. Attach the signed LR or challan below.`); onDone(); onClose();
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`Proof of delivery — ${s.docNo}`} width={680}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.receivedBy || (short && !f.remarks.trim())} onClick={save}>Record delivery</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Received on" htmlFor="pod-on" required><Input id="pod-on" type="date" max={today()} value={f.receivedOn} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} /></Field>
        <Field label="Received by" htmlFor="pod-by" required><Input id="pod-by" value={f.receivedBy} onChange={(e) => setF({ ...f, receivedBy: e.target.value })} /></Field>
      </div>
      <table className="mt-4 w-full text-[14px]"><thead><tr className={thead}><th className="py-2">Product</th><th className="py-2 text-right">Dispatched</th><th className="w-32 py-2 text-right">Received in good order</th></tr></thead>
        <tbody>{s.lines.map((l) => (
          <tr key={l.id} className="border-b border-line last:border-0"><td className="py-2">{l.description} <span className="text-ink-2">{l.packLabel}</span></td><td className="py-2 text-right num">{fmtNum(l.pickedPacks)}</td>
            <td className="py-2 pl-3"><Input aria-label={`Packs received of line ${l.lineNo}`} type="number" min="0" max={n(l.pickedPacks)} step="1" value={got[l.id] ?? ''} onChange={(e) => setGot({ ...got, [l.id]: e.target.value })} /></td></tr>))}</tbody></table>
      <Field label={short ? 'Shortage or damage (required)' : 'Remarks'} htmlFor="pod-rem" required={short}><Textarea id="pod-rem" value={f.remarks} maxLength={1000} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- transporters (LOG-004)
export function TransportersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['transporters'], queryFn: () => api<{ data: Transporter[] }>('/shipments/transporters') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', name: '', gstin: '', pan: '', contact: '', phone: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try {
      await api('/shipments/transporters', { body: { code: f.code, name: f.name, gstin: f.gstin || null, pan: f.pan || null, contact: f.contact || null, phone: f.phone || null } });
      toast('success', `${f.name} added.`); setOpen(false); setF({ code: '', name: '', gstin: '', pan: '', contact: '', phone: '' }); void qc.invalidateQueries({ queryKey: ['transporters'] });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Transporters" subtitle="Carriers chosen at loading; their GSTIN prints on the challan and the e-way bill."
        actions={can('logistics.transporter:manage') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Add transporter</Button>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="No transporters yet" text="Add the carriers you load with." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[14px]"><thead><tr className={thead}><th className="px-5 py-3">Code</th><th className={th}>Name</th><th className={th}>GSTIN</th><th className={th}>Contact</th><th className={th}>Status</th></tr></thead>
            <tbody>{q.data.data.map((t) => <tr key={t.id} className="border-b border-line last:border-0"><td className="px-5 py-3 num font-semibold">{t.code}</td><td className={th}>{t.name}</td><td className={`${th} num`}>{t.gstin ?? '—'}</td>
              <td className={th}>{[t.contact, t.phone].filter(Boolean).join(' · ') || '—'}</td><td className={th}><StatusBadge status={t.status} /></td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Add transporter"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={!f.code || !f.name} onClick={save}>Add</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Code" htmlFor="tr-code" required hint="Capitals, digits and hyphens"><Input id="tr-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name" htmlFor="tr-name" required><Input id="tr-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="GSTIN" htmlFor="tr-gst"><Input id="tr-gst" maxLength={15} value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value.toUpperCase() })} /></Field>
          <Field label="PAN" htmlFor="tr-pan"><Input id="tr-pan" maxLength={10} value={f.pan} onChange={(e) => setF({ ...f, pan: e.target.value.toUpperCase() })} /></Field>
          <Field label="Contact person" htmlFor="tr-ct"><Input id="tr-ct" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} /></Field>
          <Field label="Phone" htmlFor="tr-ph"><Input id="tr-ph" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- delivery challan / loading slip (LOG-007)
export function ShipmentChallanPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['shipment', id], queryFn: () => api<ShipmentDetail>(`/shipments/${id}`) });
  const s = q.data;
  const challan = !!s && ['Dispatched', 'Delivered'].includes(s.status);
  useEffect(() => { if (s) document.title = s.docNo.replace(/[/ ]/g, '-'); return () => { document.title = 'Dhruv Agro ERP'; }; }, [s]);
  if (q.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (!s) return <div className="p-8"><ErrorBanner error={q.error} /></div>;
  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-3 px-4 py-4 print:hidden">
        <Link to={`/logistics/shipments/${id}`} className="inline-flex items-center gap-2 font-semibold text-primary"><ArrowLeft size={18} /> Back to shipment</Link>
        <Button icon={<Printer size={18} />} onClick={() => window.print()}>Print or save as PDF</Button>
      </div>
      <article className="mx-auto mb-8 max-w-[210mm] bg-white p-[12mm] text-[12px] text-ink shadow-card print:m-0 print:max-w-none print:p-0 print:shadow-none">
        {s.status === 'Cancelled' && <div className="mb-4 rounded border-2 border-danger-text px-3 py-2 text-center font-bold uppercase text-danger-text">Cancelled</div>}
        <header className="flex items-start justify-between gap-6 border-b-2 border-ink pb-3">
          <div><h1 className="text-[18px] font-extrabold">{s.seller?.name ?? s.legalEntityName}</h1>{s.seller?.address && <p className="max-w-[95mm] whitespace-pre-line">{s.seller.address}</p>}
            <p>{s.seller?.gstin ? `GSTIN ${s.seller.gstin}` : ''}{s.seller?.pan ? ` · PAN ${s.seller.pan}` : ''}</p><p>Dispatch from {s.warehouseCode} — {s.warehouseName}</p></div>
          <div className="text-right"><p className="text-[20px] font-extrabold tracking-wide">{challan ? 'DELIVERY CHALLAN' : 'LOADING SLIP'}</p><p className="num font-semibold">{s.docNo}</p>
            <p>{challan ? `Dispatched ${fmtDateTime(s.dispatchedAt)}` : `Planned ${fmtDate(s.plannedDate)}`}</p><p>Against order {s.salesOrderNo}</p>{s.dealerPoNo && <p>Your PO {s.dealerPoNo}</p>}</div>
        </header>
        <section className="grid grid-cols-2 gap-6 border-b border-line py-3">
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Consignee</p><p className="font-semibold">{s.partyName}</p><p>{s.shipToAddress}</p><p>{s.partyGstin ? `GSTIN ${s.partyGstin}` : 'Unregistered dealer'}</p></div>
          <div><p className="text-[10px] font-semibold uppercase text-ink-2">Transport</p>
            <p>{s.transporterName ?? '____________________'}{s.transporterGstin ? ` (GSTIN ${s.transporterGstin})` : ''}</p>
            <p>Vehicle {s.vehicleNo ?? '__________'} · Driver {s.driverName ?? '__________'}</p><p>LR {s.lrNo ? `${s.lrNo} dated ${fmtDate(s.lrDate)}` : '__________'}</p>
            <p>E-way bill {s.ewbNo ?? (s.ewbRequired ? '__________ (required)' : 'not required')}</p><p>Freight {s.freightTerms?.replace('_', ' ') ?? '—'}</p></div>
        </section>
        <table className="mt-3 w-full border-collapse text-[11px]"><thead><tr className="border-b-2 border-ink text-left"><th className="py-1">#</th><th className="py-1">Description</th><th className="py-1">HSN</th>
          <th className="py-1">Lot · boxes</th><th className="py-1 pl-2 text-right">{challan ? 'Packs' : 'Planned'}</th><th className="w-20 py-1 pl-2 text-right">Qty</th></tr></thead>
          <tbody>{s.lines.map((l) => {
            const byLot = Object.values(l.picks.reduce<Record<string, { lotNo: string; exp: string | null; boxes: string[]; packs: number }>>((a, p) => {
              const x = (a[p.lotId] ??= { lotNo: p.lotNo, exp: p.expiryDate, boxes: [], packs: 0 }); if (p.boxSerial) x.boxes.push(p.boxSerial); x.packs += n(p.packs); return a; }, {}));
            const packs = challan ? n(l.pickedPacks) : n(l.plannedPacks);
            return (
              <tr key={l.id} className="border-b border-line align-top"><td className="py-1">{l.lineNo}</td><td className="py-1 pr-2">{l.description}</td><td className="py-1 pr-2">{l.hsnCode}</td>
                <td className="py-1">{byLot.length ? byLot.map((x) => <div key={x.lotNo}><b>{x.lotNo}</b>{x.exp ? ` exp ${fmtDate(x.exp)}` : ''} — {x.packs} packs{x.boxes.length ? `: ${x.boxes.join(', ')}` : ''}</div>) : '—'}</td>
                <td className="py-1 pl-2 text-right num">{fmtNum(packs)}</td><td className="whitespace-nowrap py-1 pl-2 text-right num">{fmtNum(packs * n(l.packSize))} {l.packUom}</td></tr>);
          })}</tbody></table>
        <p className="mt-3">{challan ? `Value of goods ${fmtINR(s.pickedValue)} (including GST). The tax invoice follows separately.` : 'Pick only the listed lots; scan every box at loading.'}</p>
        <footer className="mt-12 grid grid-cols-3 gap-6 text-center"><div className="border-t border-ink pt-1">Prepared by</div><div className="border-t border-ink pt-1">Driver</div><div className="border-t border-ink pt-1">Received in good order (sign, stamp, date)</div></footer>
      </article>
    </div>
  );
}
