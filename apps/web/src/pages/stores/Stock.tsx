import { MagnifyingGlass } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { Card, EmptyState, ErrorBanner, KeyValues, PageHeader, Skeleton, StatusBadge, Tabs } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtINR, fmtNum } from '../../lib/format';

interface Balance { itemId: string; itemCode: string; itemName: string; itemType: string; uom: string; warehouseId: string; warehouseCode: string; quarantine: string | null;
  unrestricted: string | null; rejected: string | null; blocked: string | null; unrestrictedValue: string | null; lots: number; nearestExpiry: string | null }
interface LotRow { id: string; lotNo: string; itemId: string; itemCode: string; itemName: string; uom: string; vendorLotNo: string | null; vendorName: string | null; mfgDate: string | null;
  expiryDate: string | null; status: string; createdAt: string; onHand: string }
export const lotBadge = (s: string) => <StatusBadge status={s === 'Released' ? 'Approved' : s === 'Rejected' ? 'Rejected' : s === 'Hold' ? 'OnHold' : 'Pending'} label={s === 'Quarantine' ? 'Quarantine' : s} />;
const q = (v: string | null) => (v && Number(v) ? fmtNum(Number(v)) : '—');

export function StockPage() {
  const [tab, setTab] = useState<'balances' | 'lots'>('balances');
  const [search, setSearch] = useState('');
  const balances = useQuery({ queryKey: ['stock-balances', search], queryFn: () => api<{ data: Balance[] }>(`/stock/balances?q=${encodeURIComponent(search)}`), placeholderData: (p) => p });
  const today = new Date().toISOString().slice(0, 10);
  const lotColumns: Column<LotRow>[] = [
    { key: 'lot', header: 'Lot', render: (r) => <span className="font-semibold num">{r.lotNo}</span> },
    { key: 'item', header: 'Item', render: (r) => <span><span className="font-medium">{r.itemCode}</span> <span className="text-ink-2">{r.itemName}</span></span> },
    { key: 'vendor', header: 'Vendor / batch', render: (r) => <span>{r.vendorName ?? '—'}<span className="block text-[13px] text-ink-2">{r.vendorLotNo ?? ''}</span></span> },
    { key: 'qty', header: 'On hand', className: 'text-right', render: (r) => <span className="num">{fmtNum(Number(r.onHand))} {r.uom}</span> },
    { key: 'exp', header: 'Expiry', render: (r) => <span className={clsx('num', r.expiryDate && r.expiryDate < today && 'font-semibold text-danger-text')}>{r.expiryDate ? fmtDate(r.expiryDate) : '—'}</span> },
    { key: 'status', header: 'QC status', render: (r) => lotBadge(r.status) },
  ];
  const rows = balances.data?.data ?? [];
  return (
    <>
      <PageHeader title="Stock" subtitle="From the append-only stock ledger. Only released (unrestricted) stock can be used; quarantine, blocked and rejected stock is held by QC." />
      <div className="mb-4"><Tabs value={tab} onChange={setTab} tabs={[{ value: 'balances', label: 'Balances' }, { value: 'lots', label: 'Lots' }]} /></div>
      {tab === 'balances' ? (
        <div className="card overflow-hidden">
          <div className="border-b border-line p-4"><div className="relative max-w-md">
            <MagnifyingGlass size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-2" aria-hidden />
            <input aria-label="Search items" className="input h-11 pl-11" placeholder="Search item code or name" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div>
          {balances.isLoading ? <Skeleton className="m-4 h-40" /> : balances.error ? <div className="p-4"><ErrorBanner error={balances.error} /></div> : rows.length === 0 ? (
            <EmptyState title="No stock yet" text="Stock appears when goods receipts are posted." />
          ) : (
            <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
              <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                <th className="px-5 py-3">Item</th><th className="px-3 py-3">Warehouse</th><th className="px-3 py-3 text-right">Released</th><th className="px-3 py-3 text-right">Quarantine</th>
                <th className="px-3 py-3 text-right">Blocked</th><th className="px-3 py-3 text-right">Rejected</th><th className="px-3 py-3 text-right">Value (released)</th><th className="px-3 py-3">Nearest expiry</th><th className="px-3 py-3 text-right">Lots</th></tr></thead>
              <tbody>{rows.map((b) => (
                <tr key={`${b.itemId}-${b.warehouseId}`} className="border-b border-line last:border-0">
                  <td className="px-5 py-3"><span className="font-semibold">{b.itemCode}</span> <span className="text-ink-2">{b.itemName} · {b.itemType}</span></td>
                  <td className="px-3 py-3">{b.warehouseCode}</td>
                  <td className="px-3 py-3 text-right num font-semibold">{q(b.unrestricted)} <span className="font-normal text-ink-2">{b.uom}</span></td>
                  <td className="px-3 py-3 text-right num text-warning-text">{q(b.quarantine)}</td><td className="px-3 py-3 text-right num">{q(b.blocked)}</td>
                  <td className="px-3 py-3 text-right num text-danger-text">{q(b.rejected)}</td><td className="px-3 py-3 text-right num">{b.unrestrictedValue ? fmtINR(b.unrestrictedValue) : '—'}</td>
                  <td className="px-3 py-3 num">{b.nearestExpiry ? fmtDate(b.nearestExpiry) : '—'}</td><td className="px-3 py-3 text-right num">{b.lots}</td>
                </tr>))}</tbody>
            </table></div>
          )}
        </div>
      ) : (
        <DataTable<LotRow> queryKey="lots" path="/stock/lots" columns={lotColumns} rowHref={(r) => `/stores/lots/${r.id}`} statusOptions={['Quarantine', 'Released', 'Hold', 'Rejected']}
          searchPlaceholder="Search lot, vendor batch or item" empty={{ title: 'No lots yet', text: 'Lots are created when goods receipts are posted.' }} />
      )}
    </>
  );
}

const TXN: Record<string, string> = { GRN: 'Received (goods receipt)', SAMPLE: 'QC sample drawn', QC_RELEASE: 'QC release', QC_REJECT: 'QC rejection', QC_HOLD: 'QC hold', GRN_REVERSAL: 'Receipt reversed',
  SUPPLIER_RETURN: 'Returned to vendor', ISSUE_TO_PROD: 'Issued to production', RETURN_FROM_PROD: 'Returned from production', PRODUCTION_OUTPUT: 'Produced (batch output)', OPENING: 'Opening stock',
  QA_RELEASE: 'QA release', QA_REJECT: 'QA rejection', QA_HOLD: 'QA hold' };

interface TraceNode { lotId: string; lotNo: string; itemCode: string; itemName: string; uom: string; qcStatus: string; sourceType: string; qty?: number; origin?: string | null;
  batchId?: string | null; batchNo?: string | null; orderNo?: string | null; children: TraceNode[] }

/** One level of the genealogy tree, indented; each lot links to its own page. */
function TraceTree({ node, direction, depth = 0 }: { node: TraceNode; direction: 'back' | 'forward'; depth?: number }) {
  return (
    <li className="text-[14px]">
      <div className="flex flex-wrap items-center gap-2 py-1" style={{ paddingLeft: depth * 20 }}>
        {depth > 0 && <span className="text-ink-3" aria-hidden>{direction === 'back' ? '↳' : '→'}</span>}
        {node.lotId ? <Link className="font-semibold text-primary num" to={`/stores/lots/${node.lotId}`}>{node.lotNo}</Link> : <span className="font-semibold num">{node.lotNo}</span>}
        {node.itemCode && <span>{node.itemCode}</span>}
        {node.qty !== undefined && <span className="num text-ink-2">{fmtNum(node.qty)} {node.uom}{direction === 'back' ? ' used' : ' of this lot used'}</span>}
        {node.sourceType !== 'BATCH' && lotBadge(node.qcStatus)}
        <span className="text-ink-2">{node.sourceType === 'PRODUCTION' && node.batchNo ? `made in batch ${node.batchNo} (${node.orderNo})` : node.origin ?? ''}</span>
      </div>
      {node.children.length > 0 && <ul>{node.children.map((c, i) => <TraceTree key={`${c.lotId}-${i}`} node={c} direction={direction} depth={depth + 1} />)}</ul>}
    </li>
  );
}

export function LotDetailPage() {
  const { id } = useParams();
  const lq = useQuery({ queryKey: ['lot', id], queryFn: () => api<{
    id: string; lotNo: string; itemId: string; itemCode: string; itemName: string; uom: string; vendorLotNo: string | null; partyId: string | null; vendorName: string | null;
    mfgDate: string | null; expiryDate: string | null; status: string; decidedAt: string | null; decidedBy: string | null; grnId: string | null; grnNo: string | null; receiptDate: string | null;
    poId: string | null; poNo: string | null; inspectionId: string | null; inspectionNo: string | null; inspectionStatus: string | null; createdAt: string;
    ledger: { id: number; postedAt: string; warehouseCode: string; bucket: string; qty: string; unitCost: string; txnType: string; by: string | null }[]; balances: { bucket: string; qty: string }[];
  }>(`/stock/lots/${id}`) });
  const tq = useQuery({ queryKey: ['lot-trace', id], queryFn: () => api<{ backward: TraceNode; forward: TraceNode }>(`/stock/lots/${id}/trace`) });
  const l = lq.data;
  if (lq.isLoading) return <Skeleton className="h-96" />;
  if (!l) return <ErrorBanner error={lq.error} />;
  return (
    <>
      <PageHeader title={l.lotNo} crumbs={<Link to="/stores/stock" className="hover:text-primary">Stock</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2">{lotBadge(l.status)}<span>{l.itemCode} — {l.itemName}</span></span>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Origin (genealogy)">
          <KeyValues items={tq.data?.backward.batchId ? [['Item', `${l.itemCode} — ${l.itemName}`],
            ['Made in batch', <Link key="b" className="text-primary" to={`/production/batches/${tq.data.backward.batchId}`}>{tq.data.backward.batchNo}</Link>], ['Production order', tq.data.backward.orderNo ?? '—'],
            ['Manufactured', l.mfgDate ? fmtDate(l.mfgDate) : '—'], ['Expiry', l.expiryDate ? fmtDate(l.expiryDate) : '—'],
            ['QC inspection', l.inspectionId ? <Link key="i" className="text-primary" to={`/qc/inspections/${l.inspectionId}`}>{l.inspectionNo} ({l.inspectionStatus})</Link> : '—'],
            ['Release', l.decidedAt ? `${l.status} by ${l.decidedBy}, ${fmtDateTime(l.decidedAt)}` : 'Waiting for QC and QA']] : [['Item', `${l.itemCode} — ${l.itemName}`], ['Vendor', l.partyId ? <Link key="v" className="text-primary" to={`/purchase/vendors/${l.partyId}`}>{l.vendorName}</Link> : '—'],
            ['Vendor batch', l.vendorLotNo], ['Manufactured', l.mfgDate ? fmtDate(l.mfgDate) : '—'], ['Expiry', l.expiryDate ? fmtDate(l.expiryDate) : '—'],
            ['Purchase order', l.poId ? <Link key="p" className="text-primary" to={`/purchase/orders/${l.poId}`}>{l.poNo}</Link> : '—'],
            ['Goods receipt', l.grnId ? <Link key="g" className="text-primary" to={`/stores/receipts/${l.grnId}`}>{l.grnNo}</Link> : '—'], ['Received', l.receiptDate ? fmtDate(l.receiptDate) : '—'],
            ['QC inspection', l.inspectionId ? <Link key="i" className="text-primary" to={`/qc/inspections/${l.inspectionId}`}>{l.inspectionNo} ({l.inspectionStatus})</Link> : '—'],
            ['QC decision', l.decidedAt ? `${l.status} by ${l.decidedBy}, ${fmtDateTime(l.decidedAt)}` : 'Pending']]} />
        </Card>
        <Card title="Balance">
          {l.balances.length === 0 ? <p className="text-ink-2">Nothing on hand.</p> : (
            <dl className="space-y-2 text-[14px]">{l.balances.map((b) => <div key={b.bucket} className="flex justify-between"><dt className="text-ink-2">{b.bucket === 'UNRESTRICTED' ? 'Released (usable)' : b.bucket[0] + b.bucket.slice(1).toLowerCase()}</dt><dd className="num font-semibold">{fmtNum(Number(b.qty))} {l.uom}</dd></div>)}</dl>
          )}
        </Card>
      </div>
      <Card title="Movements" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-6 py-3">When</th><th className="px-3 py-3">Movement</th><th className="px-3 py-3">Warehouse</th><th className="px-3 py-3">Bucket</th><th className="px-3 py-3 text-right">Quantity</th><th className="px-3 py-3">By</th></tr></thead>
          <tbody>{l.ledger.map((e) => (
            <tr key={e.id} className="border-b border-line last:border-0"><td className="px-6 py-3 num">{fmtDateTime(e.postedAt)}</td><td className="px-3 py-3">{TXN[e.txnType] ?? e.txnType}</td><td className="px-3 py-3">{e.warehouseCode}</td>
              <td className="px-3 py-3">{e.bucket.toLowerCase()}</td><td className={clsx('px-3 py-3 text-right num', Number(e.qty) < 0 ? 'text-danger-text' : 'text-success-text')}>{Number(e.qty) > 0 ? '+' : ''}{fmtNum(Number(e.qty))}</td><td className="px-3 py-3">{e.by ?? 'system'}</td></tr>))}</tbody>
        </table></div>
      </Card>
      {tq.data && (
        <div className="mt-6 grid gap-6 xl:grid-cols-2">
          <Card title="Traceability — what went into it">
            {tq.data.backward.children.length ? <ul><TraceTree node={tq.data.backward} direction="back" /></ul>
              : <p className="text-ink-2">{tq.data.backward.origin ?? 'A purchased or opening lot: its origin is shown above.'}</p>}
          </Card>
          <Card title="Traceability — where it went">
            {tq.data.forward.children.length ? <ul><TraceTree node={tq.data.forward} direction="forward" /></ul> : <p className="text-ink-2">Not used in production yet. Dispatches appear here with logistics.</p>}
          </Card>
        </div>
      )}
    </>
  );
}
