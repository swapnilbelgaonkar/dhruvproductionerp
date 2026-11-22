import { Plus, Printer } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, KeyValues, PageHeader, Skeleton, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR } from '../../lib/format';
import { addressText, LinesTable, Row, SalesDocFormPage, SalesDocPrintPage, state, type Address, type Line, type Totals } from './Quotations';

interface OrderRow extends Totals {
  id: string; docNo: string; partyId: string; partyCode: string; partyName: string; partyGstin: string | null; legalEntityName: string; orderDate: string;
  requiredBy: string | null; dealerPoNo: string | null; dealerPoDate: string | null; quotationId: string | null; quotationNo: string | null; quotationRevision: number | null;
  priceListCode: string | null; contactPerson: string | null; paymentTerms: string; deliveryTerms: string; notes: string | null; salesOwner: string; territory: string;
  opportunityId: string | null; opportunityCode: string | null; placeOfSupply: string; interState: boolean; status: string; statusReason: string | null;
  maxExtraDiscount: string; creditLimit: string | null; openOrderValue: string | null; overCreditLimit: boolean; approvedAt: string | null; createdAt: string; updatedAt: string; version: number;
}
interface OrderDetail extends OrderRow {
  lines: (Line & { dispatchedQty: string })[]; allowedActions: string[]; billTo: Address | null; shipTo: Address | null;
  approval: { id: string; docNo: string; status: string; ruleName: string; steps: { seq: number; label: string; kind: string; status: string }[] | null } | null;
  liveCredit: { creditLimit: number; openOrderValue: number; exposure: number; advancePayment: boolean; overCreditLimit: boolean } | null;
  print: { amountInWords: string };
}

const STATUSES = ['Draft', 'Submitted', 'Approved', 'Rejected', 'Cancelled', 'Closed'];
const columns: Column<OrderRow>[] = [
  { key: 'doc', header: 'Order', render: (r) => <span className="font-semibold num">{r.docNo}</span> },
  { key: 'dealer', header: 'Dealer', render: (r) => <span>{r.partyName} <span className="text-ink-2">{r.partyCode}</span></span> },
  { key: 'date', header: 'Order date', render: (r) => <span className="num">{fmtDate(r.orderDate)}</span> },
  { key: 'req', header: 'Required by', render: (r) => <span className="num">{r.requiredBy ? fmtDate(r.requiredBy) : '—'}</span> },
  { key: 'po', header: 'Dealer PO', render: (r) => r.dealerPoNo ?? '—' },
  { key: 'src', header: 'Source', render: (r) => (r.quotationNo ? <span className="num">{r.quotationNo} R{r.quotationRevision}</span> : 'Direct') },
  { key: 'total', header: 'Amount', className: 'text-right', render: (r) => <span className="num font-semibold">{fmtINR(r.grandTotal)}</span> },
  { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
];

export function SalesOrdersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('sales.order:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/sales/orders/new')}>New sales order</Button> : undefined;
  return (
    <>
      <PageHeader title="Sales Orders" subtitle="Orders from dealers, converted from an approved quotation or entered directly. Approval follows the sales hierarchy (D01), then accounts." actions={create} />
      <DataTable<OrderRow> queryKey="sales-orders" path="/sales-orders" columns={columns} rowHref={(r) => `/sales/orders/${r.id}`} statusOptions={STATUSES}
        searchPlaceholder="Search order, dealer or dealer PO"
        empty={{ title: 'No sales orders yet', text: 'Convert an approved quotation, or enter an order directly for an active dealer.', action: create }} />
    </>
  );
}

export const SalesOrderFormPage = () => <SalesDocFormPage kind="order" />;
export const SalesOrderPrintPage = () => <SalesDocPrintPage kind="order" />;

export function SalesOrderDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['order', id], queryFn: () => api<OrderDetail>(`/sales-orders/${id}`) });
  const [cancel, setCancel] = useState(false);
  const submit = useMutation({
    mutationFn: () => api<{ status: string; approvalDocNo: string; overCreditLimit: boolean }>(`/sales-orders/${id}/submit`, { method: 'POST', body: {} }),
    onSuccess: async (r) => {
      toast('success', r.status === 'Approved' ? 'Order approved.' : `Sent for approval as ${r.approvalDocNo}${r.overCreditLimit ? ' — over the credit limit, so the finance head must also approve' : ''}.`);
      await qc.invalidateQueries();
    },
  });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const credit = d.liveCredit
    ? { limit: d.liveCredit.creditLimit, open: d.liveCredit.openOrderValue, over: d.liveCredit.overCreditLimit, advance: d.liveCredit.advancePayment, live: true }
    : d.creditLimit !== null ? { limit: Number(d.creditLimit), open: Number(d.openOrderValue), over: d.overCreditLimit, advance: false, live: false } : null;
  return (
    <>
      <PageHeader title={d.docNo} crumbs={<Link to="/sales/orders" className="hover:text-primary">Sales Orders</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status} /><span>{d.partyName} · {fmtINR(d.grandTotal)} · ordered {fmtDate(d.orderDate)}</span></span>}
        actions={<>
          <Button variant="secondary" icon={<Printer size={18} />} onClick={() => nav(`/sales/orders/${id}/print`)}>Print / PDF</Button>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/sales/orders/${id}/edit`)}>Edit</Button>}
          {a.includes('cancel') && <Button variant="danger" onClick={() => setCancel(true)}>Cancel order</Button>}
          {a.includes('submit') && <Button loading={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
        </>} />
      <ErrorBanner error={submit.error} />
      {d.status === 'Submitted' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Waiting for approval{d.approval ? <> — <Link className="font-semibold underline" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link></> : null}. It cannot be edited until a decision is made.</div>}
      {d.statusReason && ['Cancelled', 'Rejected'].includes(d.status) && <div className="mb-6 rounded-md bg-neutral-bg px-4 py-3 text-neutral-text">{d.status}: {d.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card title="Details">
            <KeyValues items={[
              ['Dealer', <Link key="d" className="font-semibold text-primary" to={`/sales/dealers/${d.partyId}`}>{d.partyName} ({d.partyCode})</Link>], ['Dealer GSTIN', d.partyGstin ?? 'Unregistered'],
              ['Dealer PO', d.dealerPoNo ? `${d.dealerPoNo}${d.dealerPoDate ? ` · ${fmtDate(d.dealerPoDate)}` : ''}` : '—'],
              ['Order date', fmtDate(d.orderDate)], ['Required by', d.requiredBy ? fmtDate(d.requiredBy) : '—'],
              ['Source', d.quotationId ? <Link key="q" className="text-primary" to={`/sales/quotations/${d.quotationId}`}>Quotation {d.quotationNo} R{d.quotationRevision} (prices locked)</Link> : `Direct order · price list ${d.priceListCode ?? '—'}`],
              ['Bill to', addressText(d.billTo)], ['Ship to', addressText(d.shipTo)], ['Place of supply', `${state(d.placeOfSupply)} · ${d.interState ? 'IGST' : 'CGST + SGST'}`],
              ['Issued by', d.legalEntityName], ['Sales owner', `${d.salesOwner} · ${d.territory}`], ['Contact person', d.contactPerson],
              ['Payment terms', d.paymentTerms], ['Delivery terms', d.deliveryTerms], ['Notes', d.notes],
              ...(d.opportunityId ? [['Opportunity', <Link key="o" className="text-primary" to={`/sales/opportunities/${d.opportunityId}`}>{d.opportunityCode}</Link>] as [string, ReactNode]] : []),
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
          <Card title="Credit position">
            {!credit ? <p className="text-ink-2">Shown when the order is submitted.</p> : credit.advance ? (
              <p className="text-[14px]">Advance-payment dealer (no credit limit or credit days). Accounts confirm payment before dispatch.</p>
            ) : (
              <dl className="space-y-2 text-[14px]">
                <Row k="Credit limit" v={fmtINR(credit.limit)} />
                <Row k="Other open orders" v={fmtINR(credit.open)} />
                <Row k="This order" v={fmtINR(d.grandTotal)} />
                <div className="border-t border-line pt-2"><Row k="Exposure" v={fmtINR(credit.open + Number(d.grandTotal))} strong /></div>
                <p className={`rounded-md px-3 py-2 text-[13px] ${credit.over ? 'bg-danger-bg text-danger-text' : 'bg-success-bg text-success-text'}`}>
                  {credit.over ? 'Over the credit limit — the finance head must approve a credit override.' : 'Within the credit limit.'}
                </p>
                <p className="text-[12px] text-ink-2">{credit.live ? 'Live figure.' : 'As at submission.'} Outstanding invoices are added once invoicing is live (Stage 6).</p>
              </dl>
            )}
          </Card>
          <Card title="Approval">
            {!d.approval ? <p className="text-ink-2">Not submitted yet. It goes to your sales manager (per the D01 hierarchy), then accounts.</p> : (
              <>
                <p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${d.approval.id}`}>{d.approval.docNo}</Link> · {d.approval.ruleName}</p>
                <ol className="space-y-2">{(d.approval.steps ?? []).map((s) => (
                  <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>))}</ol>
              </>
            )}
            <p className="mt-3 text-[12px] text-ink-2">Created {fmtDateTime(d.createdAt)}{d.approvedAt ? ` · approved ${fmtDateTime(d.approvedAt)}` : ''}</p>
          </Card>
        </aside>
      </div>
      <Card title="Products" padded={false} className="mt-6">
        <LinesTable lines={d.lines} interState={d.interState} />
      </Card>
      {['Approved', 'Closed'].includes(d.status) && <OrderShipments orderId={d.id} lines={d.lines} />}
      <ReasonDialog open={cancel} danger title={`Cancel ${d.docNo}`} confirmLabel="Cancel order" onClose={() => setCancel(false)}
        description={d.quotationId ? 'The quotation becomes convertible again while it is still valid.' : 'The order can no longer be approved or dispatched.'}
        onConfirm={async (reason) => { await api(`/sales-orders/${id}/cancel`, { body: { reason } }); toast('success', 'Order cancelled.'); await qc.invalidateQueries(); }} />
    </>
  );
}

/** Dispatch progress of an approved order and its shipments (LOG-001, LOG-009). */
function OrderShipments({ orderId, lines }: { orderId: string; lines: (Line & { dispatchedQty: string })[] }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['order-shipments', orderId], enabled: can('logistics.shipment:view'),
    queryFn: () => api<{ data: { id: string; docNo: string; plannedDate: string; status: string; statusReason: string | null; vehicleNo: string | null; lrNo: string | null }[] }>(`/shipments?salesOrderId=${orderId}`) });
  const ordered = lines.reduce((a, l) => a + Number(l.qty), 0);
  const sent = lines.reduce((a, l) => a + Number(l.dispatchedQty), 0);
  return (
    <Card title="Dispatch" className="mt-6" actions={can('logistics.shipment:create') && sent < ordered && <Link className="font-semibold text-primary" to="/logistics/queue">Plan in the dispatch queue</Link>}>
      <p className="text-[14px]">{sent} of {ordered} packs dispatched.</p>
      {can('logistics.shipment:view') && (q.data?.data.length ? (
        <ul className="mt-3 space-y-2">{q.data.data.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 text-[14px]"><Link className="font-semibold text-primary num" to={`/logistics/shipments/${s.id}`}>{s.docNo}</Link>
            <span className="text-ink-2">{fmtDate(s.plannedDate)}{s.vehicleNo ? ` · ${s.vehicleNo} · LR ${s.lrNo}` : ''}</span><StatusBadge status={s.status} label={s.statusReason === 'Delivered short' ? 'Delivered short' : undefined} /></li>))}</ul>
      ) : <p className="mt-2 text-ink-2">No shipments yet.</p>)}
    </Card>
  );
}
