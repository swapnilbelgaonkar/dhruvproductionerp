import { Router } from 'express';
import type { Db } from '../../db/pool';
import { asyncHandler } from '../../lib/http';
import { getSetting } from '../../lib/settings';
import { requirePermission } from '../../middleware/auth';
import { todayIST } from '../sales/quotations';

/**
 * Executive dashboard (MIS-007, MIS-004; BRD p.6). The six BRD KPI cards with their thresholds, company-wide, plus trend panels.
 * Formulas and thresholds are provisional until the KPI workshop (D23): thresholds live in setting `mis.kpiThresholds` and every card carries
 * its formula, owner and refresh in the KPI dictionary returned with the data.
 */
type Rag = 'green' | 'amber' | 'red' | 'neutral';
interface Thresholds {
  pipelineGreenAbove: number; pipelineRedBelow: number; activeOrdersAmberAbove: number; oeeGreenAbove: number; oeeAmberAbove: number;
  quarantineRedHours: number; overdueRedAbove: number; pendingDispatchAmberAbove: number;
}
const DEFAULTS: Thresholds = { pipelineGreenAbove: 5_000_000, pipelineRedBelow: 2_000_000, activeOrdersAmberAbove: 15, oeeGreenAbove: 85, oeeAmberAbove: 65,
  quarantineRedHours: 48, overdueRedAbove: 1_000_000, pendingDispatchAmberAbove: 10 };
const r2 = (n: number) => Math.round(n * 100) / 100;

export function executiveRoutes(db: Db) {
  const r = Router();
  r.get('/executive', requirePermission('mis.executive:view'), asyncHandler(async (_req, res) => {
    const t: Thresholds = { ...DEFAULTS, ...(await getSetting<Partial<Thresholds>>(db, 'mis.kpiThresholds', {})) };
    const today = todayIST();
    const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0];
    const all = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;

    const pipeline = Number((await one(`select coalesce(sum(value), 0) as v from sales.opportunities where stage not in ('WON','LOST')`)).v);
    const activeOrders = Number((await one(`select count(*)::int as n from sales.sales_orders so where so.status in ('Submitted','Approved')
        and exists (select 1 from sales.sales_order_lines l where l.sales_order_id = so.id and l.dispatched_qty < l.qty)`)).n);
    const pendingDispatch = Number((await one(`select count(*)::int as n from sales.sales_orders so where so.status = 'Approved'
        and exists (select 1 from sales.sales_order_lines l where l.sales_order_id = so.id and l.dispatched_qty < l.qty)`)).n);
    const overdue = Number((await one(`select coalesce(sum(grand_total - amount_settled), 0) as v from sales.invoices where status = 'Posted' and due_date < $1 and grand_total - amount_settled > 0.004`, [today])).v);
    const q = await one(`select count(*) filter (where hours > $1)::int as over, count(*)::int as lots, coalesce(max(hours), 0) as oldest from (
        select sl.lot_id, extract(epoch from now() - min(sl.posted_at)) / 3600.0 as hours from inv.stock_ledger sl where sl.bucket = 'QUARANTINE' group by sl.lot_id having sum(sl.qty) > 0) x`, [t.quarantineRedHours]);

    // OEE (provisional, last 30 days) = availability × performance × quality
    const from30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const b = await one(`select coalesce(sum(output_qty), 0) as output, coalesce(sum(planned_qty), 0) as planned,
        coalesce(sum(b.output_qty) filter (where l.qa_disposition = 'Released'), 0) as released, count(*)::int as batches
        from mfg.batches b left join inv.lots l on l.id = b.fg_lot_id where b.status = 'Completed' and b.completed_at >= $1`, [from30]);
    const down = Number((await one(`select coalesce(sum(extract(epoch from least(ended_at, now()) - greatest(started_at, $1::timestamptz)) / 3600.0), 0) as h from mfg.downtime_events where ended_at > $1`, [from30])).h);
    const sched = Number((await one(`select coalesce(sum((select coalesce(sum(case when s.end_time > s.start_time then extract(epoch from s.end_time - s.start_time) else extract(epoch from s.end_time - s.start_time) + 86400 end) / 3600.0, 0)
        from mfg.shifts s where s.plant_id = ln.plant_id and s.status = 'Active')), 0) * 30 as h from mfg.lines ln where ln.status = 'Active' and ln.line_type <> 'PACKING'`)).h);
    const availability = sched > 0 ? Math.max(0, 1 - down / sched) : null;
    const performance = Number(b.planned) > 0 ? Math.min(1, Number(b.output) / Number(b.planned)) : null;
    const quality = Number(b.output) > 0 ? Number(b.released) / Number(b.output) : null;
    const oee = availability !== null && performance !== null && quality !== null ? r2(availability * performance * quality * 100) : null;

    const rag = {
      pipeline: (pipeline > t.pipelineGreenAbove ? 'green' : pipeline < t.pipelineRedBelow ? 'red' : 'amber') as Rag,
      activeOrders: (activeOrders > t.activeOrdersAmberAbove ? 'amber' : 'green') as Rag,
      oee: (oee === null ? 'neutral' : oee > t.oeeGreenAbove ? 'green' : oee > t.oeeAmberAbove ? 'amber' : 'red') as Rag,
      quarantine: (Number(q.over) > 0 ? 'red' : 'green') as Rag,
      overdue: (overdue > t.overdueRedAbove ? 'red' : overdue > 0 ? 'amber' : 'green') as Rag,
      pendingDispatch: (pendingDispatch > t.pendingDispatchAmberAbove ? 'amber' : 'green') as Rag,
    };
    const kpis = [
      { key: 'pipeline', label: 'Sales pipeline', value: r2(pipeline), unit: 'inr', rag: rag.pipeline, link: '/sales/opportunities', report: 'pipeline',
        formula: 'Sum of expected value of open opportunities (stage before Won/Lost)', target: `Green above ₹${t.pipelineGreenAbove.toLocaleString('en-IN')}; red below ₹${t.pipelineRedBelow.toLocaleString('en-IN')}`, owner: 'Sales head' },
      { key: 'activeOrders', label: 'Active orders', value: activeOrders, unit: 'count', rag: rag.activeOrders, link: '/sales/orders', report: 'sales-orders',
        formula: 'Sales orders submitted or approved with packs still to dispatch', target: `Amber above ${t.activeOrdersAmberAbove}`, owner: 'Sales operations' },
      { key: 'oee', label: 'OEE (30 days)', value: oee, unit: 'pct', rag: rag.oee, link: '/production/dashboard', report: 'batch-register',
        detail: { availability: availability === null ? null : r2(availability * 100), performance: performance === null ? null : r2(performance * 100), quality: quality === null ? null : r2(quality * 100), batches: b.batches },
        formula: 'Availability (1 − downtime ÷ scheduled shift hours) × performance (output ÷ planned of completed batches) × quality (QA-released ÷ output)', target: `Green above ${t.oeeGreenAbove}%`, owner: 'Plant head' },
      { key: 'quarantine', label: 'Quarantine hold', value: Number(q.over), unit: 'count', rag: rag.quarantine, link: '/stores/stock', report: 'quarantine-ageing',
        detail: { lotsInQuarantine: q.lots, oldestHours: Math.floor(Number(q.oldest)) },
        formula: `Lots held in quarantine longer than ${t.quarantineRedHours} hours awaiting a QC/QA decision`, target: `Red when any lot exceeds ${t.quarantineRedHours} h`, owner: 'QC head' },
      { key: 'overdue', label: 'Overdue debt', value: r2(overdue), unit: 'inr', rag: rag.overdue, link: '/finance/ageing', report: 'credit-exposure',
        formula: 'Unpaid balance of invoices past their due date', target: `Red above ₹${t.overdueRedAbove.toLocaleString('en-IN')}`, owner: 'Finance head' },
      { key: 'pendingDispatch', label: 'Pending dispatch', value: pendingDispatch, unit: 'count', rag: rag.pendingDispatch, link: '/logistics/queue', report: 'pending-dispatch',
        formula: 'Approved orders with packs not yet dispatched', target: `Amber above ${t.pendingDispatchAmberAbove}`, owner: 'Logistics head' },
    ];

    // trends: last six months
    const months = await all(`select to_char(m, 'YYYY-MM') as month, to_char(m, 'Mon') as label,
        coalesce((select sum(taxable_total) from sales.invoices i where i.status = 'Posted' and date_trunc('month', i.invoice_date) = m), 0)
          - coalesce((select sum(taxable_total) from sales.credit_notes c where c.status = 'Approved' and date_trunc('month', c.note_date) = m), 0) as sales,
        coalesce((select sum(amount) from fin.receipts r where r.status = 'Posted' and date_trunc('month', r.receipt_date) = m), 0) as collections,
        coalesce((select sum(grand_total) from sales.sales_orders o where o.status in ('Approved','Closed') and date_trunc('month', o.order_date) = m), 0) as orders,
        coalesce((select sum(output_qty) from mfg.batches b where b.status = 'Completed' and date_trunc('month', b.completed_at at time zone 'Asia/Kolkata') = m), 0) as output
      from generate_series(date_trunc('month', $1::date) - interval '5 months', date_trunc('month', $1::date), interval '1 month') m order by m`, [today]);
    const topDealers = await all(`select p.legal_name as name, sum(i.taxable_total) as sales, sum(i.grand_total - i.amount_settled) as outstanding
        from sales.invoices i join mdm.parties p on p.id = i.party_id where i.status = 'Posted' and i.invoice_date >= $1 group by p.legal_name order by 2 desc limit 5`,
      [`${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0)}-04-01`]);
    const ar = await one(`select coalesce(sum(o) filter (where d <= 0), 0) as "notDue", coalesce(sum(o) filter (where d between 1 and 30), 0) as d30,
        coalesce(sum(o) filter (where d between 31 and 60), 0) as d60, coalesce(sum(o) filter (where d between 61 and 90), 0) as d90, coalesce(sum(o) filter (where d > 90), 0) as over90
      from (select grand_total - amount_settled as o, ($1::date - due_date) as d from sales.invoices where status = 'Posted' and grand_total - amount_settled > 0.004) x`, [today]);
    const ops = await one(`select
        (select count(*)::int from wf.approval_requests where status = 'Pending') as "pendingApprovals",
        (select count(*)::int from purchase.purchase_orders where status in ('Issued','Acknowledged','PartiallyReceived')) as "openPos",
        (select coalesce(sum(grand_total), 0) from purchase.purchase_orders where status in ('Issued','Acknowledged','PartiallyReceived')) as "openPoValue",
        (select count(*)::int from qc.inspections where status in ('Pending','Sampled','Tested')) as "qcPending",
        (select count(*)::int from mfg.batches where status in ('InProgress','OnHold')) as "batchesRunning",
        (select count(*)::int from qa.deviations where status = 'Open') as "openDeviations",
        (select count(*)::int from qa.capas where status in ('Open','EffectivenessCheck') and due_date < $1) as "capasOverdue",
        (select count(*)::int from qa.complaints where status <> 'Closed') as "openComplaints",
        (select count(*)::int from logistics.shipments where status = 'Dispatched') as "inTransit",
        (select count(*)::int from qc.instruments where status = 'Active' and calibration_due < $1) as "calibrationOverdue",
        (select coalesce(sum(si.grand_total - si.amount_settled), 0) from purchase.supplier_invoices si where si.status in ('Matched','Approved') and si.due_date < $1) as "payablesOverdue"`, [today]);
    res.json({ asOf: new Date().toISOString(), kpis, months, topDealers, receivablesAgeing: ar, operations: ops, thresholds: t,
      provisional: 'KPI formulas and thresholds are provisional until the KPI workshop (D23); thresholds are in Admin → Configuration (mis.kpiThresholds).' });
  }));
  return r;
}
