import { Router, type Request } from 'express';
import type { Db } from '../../db/pool';
import { Errors } from '../../lib/errors';
import { asyncHandler } from '../../lib/http';
import { can, legalEntityScope } from '../../middleware/context';
import { syncLedger } from '../finance/ledger';
import { creditExposure } from '../finance/receivables';
import { scopeSql as territorySql, todayIST } from '../sales/quotations';

/**
 * Report catalogue (MIS-002, MIS-003, MIS-008; doc 06 §4). Every report declares the permission that opens it, its filters and columns, and
 * applies the same row scope as the screens: legal-entity scope for entity documents, territory scope for sales. Output is a table for the
 * viewer, CSV for Excel, or print. Screens that already are reports (ageing, trial balance, GST working) are listed as links.
 */
type ColType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'pct' | 'int';
interface Column { key: string; label: string; type?: ColType; total?: boolean; link?: string }
type Source = 'entities' | 'warehouses' | 'territories' | 'categories' | 'dealers' | 'vendors' | 'items' | 'transporters';
interface Filter { key: string; label: string; type: 'date' | 'select' | 'text' | 'number'; options?: { value: string; label: string }[]; source?: Source; default?: string | (() => string) }
type F = Record<string, string | undefined>;
interface Ctx { db: Db; req: Request; f: F; args: unknown[]; p: (v: unknown) => string; le: (col: string) => string; terr: (col: string) => Promise<string> }
interface Report { id: string; area: string; title: string; description: string; perm: string; filters?: Filter[]; columns?: Column[]; link?: string; brd?: string;
  run?: (c: Ctx) => Promise<Record<string, unknown>[]> }

const fyStart = () => `${Number(todayIST().slice(0, 4)) - (Number(todayIST().slice(5, 7)) < 4 ? 1 : 0)}-04-01`;
const FROM: Filter = { key: 'from', label: 'From', type: 'date', default: fyStart };
const TO: Filter = { key: 'to', label: 'To', type: 'date', default: todayIST };
const ENTITY: Filter = { key: 'legalEntityId', label: 'Entity', type: 'select', source: 'entities' };
const WH: Filter = { key: 'warehouseId', label: 'Warehouse', type: 'select', source: 'warehouses' };
const st = (...v: string[]) => v.map((x) => ({ value: x, label: x.replace(/([a-z])([A-Z])/g, '$1 $2') }));
const range = (c: Ctx, col: string) => `${col} between ${c.p(c.f.from ?? fyStart())}::date and ${c.p(c.f.to ?? todayIST())}::date`;
const eq = (c: Ctx, col: string, key: string) => (c.f[key] ? ` and ${col} = ${c.p(c.f[key])}` : '');
const rows = async (c: Ctx, sql: string) => (await c.db.query(sql, c.args)).rows;
const INV = `('Matched','Approved')`;

const REPORTS: Report[] = [
  // ================================================================ Sales
  { id: 'sales-orders', area: 'Sales', title: 'Sales order grid', brd: 'BRD p.19 (MIS-008)', perm: 'sales.order:view',
    description: 'Order lines filtered by sales tier, territory, product category, quantity (MT), value and approval status.',
    filters: [FROM, TO, { key: 'tier', label: 'Sales tier', type: 'select', options: ['BH', 'NSM', 'DSM', 'ZSM', 'RSM', 'SASM', 'ASM', 'TSM', 'SE'].map((t) => ({ value: t, label: t })) },
      { key: 'territoryId', label: 'Region / state', type: 'select', source: 'territories' }, { key: 'categoryId', label: 'Product category', type: 'select', source: 'categories' },
      { key: 'minMt', label: 'Qty from (MT)', type: 'number' }, { key: 'maxMt', label: 'Qty to (MT)', type: 'number' }, { key: 'minValue', label: 'Value from (₹)', type: 'number' },
      { key: 'maxValue', label: 'Value to (₹)', type: 'number' }, { key: 'status', label: 'Approval status', type: 'select', options: st('Draft', 'Submitted', 'Approved', 'Rejected', 'Closed', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'Order', link: '/sales/orders/{id}' }, { key: 'orderDate', label: 'Date', type: 'date' }, { key: 'partyName', label: 'Dealer' }, { key: 'territory', label: 'Territory' },
      { key: 'owner', label: 'Sales owner' }, { key: 'tier', label: 'Tier' }, { key: 'category', label: 'Category' }, { key: 'product', label: 'Product' },
      { key: 'packs', label: 'Packs', type: 'number', total: true }, { key: 'mt', label: 'Qty (MT)', type: 'number', total: true }, { key: 'value', label: 'Value (₹)', type: 'money', total: true },
      { key: 'dispatched', label: 'Dispatched packs', type: 'number', total: true }, { key: 'status', label: 'Status' }],
    run: async (c) => {
      const mt = `(sl.qty * ip.pack_size / 1000.0)`;
      return rows(c, `select so.id, so.doc_no as "docNo", so.order_date as "orderDate", p.legal_name as "partyName", t.name as territory, e.full_name as owner, e.sales_tier as tier,
          pc.name as category, sl.description as product, sl.qty as packs, round(${mt}, 4) as mt, sl.line_total as value, sl.dispatched_qty as dispatched, so.status
        from sales.sales_orders so join sales.sales_order_lines sl on sl.sales_order_id = so.id join mdm.parties p on p.id = so.party_id join org.territories t on t.id = so.territory_id
        join org.employees e on e.id = so.sales_owner_id join mdm.item_packs ip on ip.id = sl.item_pack_id join mdm.items i on i.id = ip.item_id left join mdm.product_categories pc on pc.id = i.category_id
        where ${range(c, 'so.order_date')} and ${await c.terr('so.territory_id')} and ${c.le('so.legal_entity_id')}${eq(c, 'e.sales_tier', 'tier')}${eq(c, 'i.category_id', 'categoryId')}${eq(c, 'so.status', 'status')}
          ${c.f.territoryId ? `and exists (select 1 from org.territories rt join org.territories ft on rt.path <@ ft.path where rt.id = so.territory_id and ft.id = ${c.p(c.f.territoryId)})` : ''}
          ${c.f.minMt ? `and ${mt} >= ${c.p(Number(c.f.minMt))}` : ''} ${c.f.maxMt ? `and ${mt} <= ${c.p(Number(c.f.maxMt))}` : ''}
          ${c.f.minValue ? `and sl.line_total >= ${c.p(Number(c.f.minValue))}` : ''} ${c.f.maxValue ? `and sl.line_total <= ${c.p(Number(c.f.maxValue))}` : ''}
        order by so.order_date desc, so.doc_no, sl.line_no`);
    } },
  { id: 'quotation-conversion', area: 'Sales', title: 'Quotation conversion', perm: 'sales.quotation:view', description: 'Quotations raised and converted to orders, by sales owner.',
    filters: [FROM, TO], columns: [{ key: 'owner', label: 'Sales owner' }, { key: 'quotes', label: 'Quotations', type: 'int', total: true }, { key: 'quoteValue', label: 'Quoted (₹)', type: 'money', total: true },
      { key: 'converted', label: 'Converted', type: 'int', total: true }, { key: 'orderValue', label: 'Ordered (₹)', type: 'money', total: true }, { key: 'conversionPct', label: 'Conversion', type: 'pct' }],
    run: async (c) => rows(c, `select e.full_name as owner, count(*)::int as quotes, sum(q.grand_total) as "quoteValue",
        count(*) filter (where exists (select 1 from sales.sales_orders so where so.quotation_id = q.id and so.status <> 'Cancelled'))::int as converted,
        coalesce(sum((select so.grand_total from sales.sales_orders so where so.quotation_id = q.id and so.status <> 'Cancelled' limit 1)), 0) as "orderValue",
        round(100.0 * count(*) filter (where exists (select 1 from sales.sales_orders so where so.quotation_id = q.id and so.status <> 'Cancelled')) / count(*), 1) as "conversionPct"
      from sales.quotations q join org.employees e on e.id = q.sales_owner_id where ${range(c, 'q.quote_date')} and ${await c.terr('q.territory_id')} and q.status <> 'Cancelled'
      group by e.full_name order by 2 desc`) },
  { id: 'pipeline', area: 'Sales', title: 'Lead and opportunity pipeline', perm: 'crm.opportunity:view', description: 'Open opportunities by stage with value and probability-weighted value; lead counts by status.',
    columns: [{ key: 'kind', label: 'Record' }, { key: 'stage', label: 'Stage / status' }, { key: 'count', label: 'Count', type: 'int', total: true }, { key: 'value', label: 'Value (₹)', type: 'money', total: true },
      { key: 'weighted', label: 'Weighted (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select 'Opportunity' as kind, o.stage, count(*)::int as count, coalesce(sum(o.value), 0) as value, coalesce(round(sum(o.value * o.probability / 100.0), 2), 0) as weighted
        from sales.opportunities o where ${await c.terr('o.territory_id')} group by o.stage
      union all select 'Lead', l.status, count(*)::int, null, null from sales.leads l where ${await c.terr('l.territory_id')} group by l.status order by 1 desc, 2`) },
  { id: 'territory-performance', area: 'Sales', title: 'Territory performance', perm: 'sales.invoice:view', description: 'Invoiced value and quantity, collections and outstanding by dealer territory.',
    filters: [FROM, TO, ENTITY], columns: [{ key: 'territory', label: 'Territory' }, { key: 'dealers', label: 'Dealers billed', type: 'int', total: true }, { key: 'invoices', label: 'Invoices', type: 'int', total: true },
      { key: 'taxable', label: 'Net sales (₹)', type: 'money', total: true }, { key: 'collected', label: 'Collected (₹)', type: 'money', total: true }, { key: 'outstanding', label: 'Outstanding (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select t.name as territory, count(distinct i.party_id)::int as dealers, count(*)::int as invoices, sum(i.taxable_total) as taxable,
        coalesce(sum((select sum(a.amount) from fin.receipt_allocations a where a.invoice_id = i.id and a.status = 'Active')), 0) as collected, sum(i.grand_total - i.amount_settled) as outstanding
      from sales.invoices i join mdm.dealer_profiles dp on dp.party_id = i.party_id join org.territories t on t.id = dp.territory_id
      where i.status = 'Posted' and ${range(c, 'i.invoice_date')} and ${c.le('i.legal_entity_id')}${eq(c, 'i.legal_entity_id', 'legalEntityId')} group by t.name order by 4 desc`) },
  { id: 'target-achievement', area: 'Sales', title: 'Target vs achievement', perm: 'sales.invoice:view', description: 'Each dealer\'s annual target against net sales invoiced in the financial year.',
    columns: [{ key: 'partyName', label: 'Dealer' }, { key: 'territory', label: 'Territory' }, { key: 'owner', label: 'Sales owner' }, { key: 'target', label: 'Annual target (₹)', type: 'money', total: true },
      { key: 'achieved', label: 'Net sales FY (₹)', type: 'money', total: true }, { key: 'achievementPct', label: 'Achieved', type: 'pct' }],
    run: async (c) => rows(c, `select p.legal_name as "partyName", t.name as territory, e.full_name as owner, dp.annual_target as target,
        coalesce((select sum(i.taxable_total) from sales.invoices i where i.party_id = p.id and i.status = 'Posted' and i.invoice_date >= ${c.p(fyStart())}::date), 0) -
        coalesce((select sum(cn.taxable_total) from sales.credit_notes cn where cn.party_id = p.id and cn.status = 'Approved' and cn.note_date >= ${c.p(fyStart())}::date), 0) as achieved,
        case when dp.annual_target > 0 then round(100.0 * coalesce((select sum(i.taxable_total) from sales.invoices i where i.party_id = p.id and i.status = 'Posted' and i.invoice_date >= ${c.p(fyStart())}::date), 0) / dp.annual_target, 1) end as "achievementPct"
      from mdm.dealer_profiles dp join mdm.parties p on p.id = dp.party_id join org.territories t on t.id = dp.territory_id join org.employees e on e.id = dp.sales_owner_id
      where dp.status = 'Active' and ${await c.terr('dp.territory_id')} order by 5 desc`) },
  { id: 'collections', area: 'Sales', title: 'Collections register', perm: 'finance.receipt:view', description: 'Receipts from dealers with mode, reference and allocation.',
    filters: [FROM, TO, ENTITY, { key: 'mode', label: 'Mode', type: 'select', options: st('NEFT', 'RTGS', 'IMPS', 'UPI', 'CHEQUE', 'DD', 'CASH') }, { key: 'status', label: 'Status', type: 'select', options: st('Posted', 'Bounced', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'Receipt', link: '/finance/receipts/{id}' }, { key: 'receiptDate', label: 'Date', type: 'date' }, { key: 'partyName', label: 'Dealer' }, { key: 'mode', label: 'Mode' },
      { key: 'reference', label: 'Reference' }, { key: 'amount', label: 'Amount (₹)', type: 'money', total: true }, { key: 'allocated', label: 'Allocated (₹)', type: 'money', total: true },
      { key: 'onAccount', label: 'On account (₹)', type: 'money', total: true }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select r.id, r.doc_no as "docNo", r.receipt_date as "receiptDate", p.legal_name as "partyName", r.mode, r.reference, r.amount, r.allocated,
        case when r.status = 'Posted' then r.amount - r.allocated else 0 end as "onAccount", r.status from fin.receipts r join mdm.parties p on p.id = r.party_id
      where ${range(c, 'r.receipt_date')} and ${c.le('r.legal_entity_id')}${eq(c, 'r.legal_entity_id', 'legalEntityId')}${eq(c, 'r.mode', 'mode')}${eq(c, 'r.status', 'status')} order by r.receipt_date desc, r.doc_no desc`) },
  { id: 'receivables-ageing', area: 'Sales', title: 'Outstanding and ageing', perm: 'finance.receivable:view', description: 'What each dealer owes by days past due.', link: '/finance/ageing' },
  { id: 'employee-performance', area: 'Sales', title: 'Sales owner performance', perm: 'sales.order:view', description: 'Orders booked and net sales invoiced by sales owner.',
    filters: [FROM, TO], columns: [{ key: 'owner', label: 'Sales owner' }, { key: 'tier', label: 'Tier' }, { key: 'orders', label: 'Orders', type: 'int', total: true }, { key: 'booked', label: 'Booked (₹)', type: 'money', total: true },
      { key: 'invoiced', label: 'Invoiced (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select e.full_name as owner, e.sales_tier as tier, count(*)::int as orders, sum(so.grand_total) as booked,
        coalesce(sum((select sum(i.grand_total) from sales.invoices i where i.sales_order_id = so.id and i.status = 'Posted')), 0) as invoiced
      from sales.sales_orders so join org.employees e on e.id = so.sales_owner_id where so.status in ('Approved','Closed') and ${range(c, 'so.order_date')} and ${await c.terr('so.territory_id')}
      group by e.full_name, e.sales_tier order by 4 desc`) },

  // ================================================================ Procurement
  { id: 'pr-status', area: 'Procurement', title: 'Requisition status', perm: 'purchase.requisition:view', description: 'Requisition lines with quantity ordered so far.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('Draft', 'Submitted', 'Approved', 'Rejected', 'Cancelled', 'Closed') }],
    columns: [{ key: 'docNo', label: 'Requisition', link: '/purchase/requisitions/{id}' }, { key: 'createdAt', label: 'Raised', type: 'date' }, { key: 'priority', label: 'Priority' }, { key: 'item', label: 'Item' },
      { key: 'qty', label: 'Qty', type: 'number' }, { key: 'ordered', label: 'Ordered', type: 'number' }, { key: 'requiredBy', label: 'Required by', type: 'date' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select r.id, r.doc_no as "docNo", r.created_at as "createdAt", r.priority, i.code || ' ' || i.name as item, l.qty, l.ordered_qty as ordered, coalesce(l.required_by, r.required_by) as "requiredBy", r.status
      from purchase.requisitions r join purchase.requisition_lines l on l.requisition_id = r.id join mdm.items i on i.id = l.item_id
      where ${range(c, 'r.created_at::date')} and ${c.le('r.legal_entity_id')}${eq(c, 'r.status', 'status')} order by r.created_at desc, l.line_no`) },
  { id: 'pending-pos', area: 'Procurement', title: 'Pending purchase orders', perm: 'purchase.order:view', description: 'Issued PO lines not yet fully received, with delivery date and days late.',
    filters: [ENTITY], columns: [{ key: 'docNo', label: 'PO', link: '/purchase/orders/{id}' }, { key: 'vendor', label: 'Vendor' }, { key: 'item', label: 'Item' }, { key: 'qty', label: 'Ordered', type: 'number' },
      { key: 'received', label: 'Received', type: 'number' }, { key: 'pending', label: 'Pending', type: 'number' }, { key: 'pendingValue', label: 'Pending value (₹)', type: 'money', total: true },
      { key: 'deliveryDate', label: 'Due', type: 'date' }, { key: 'daysLate', label: 'Days late', type: 'int' }],
    run: async (c) => rows(c, `select po.id, po.doc_no as "docNo", p.legal_name as vendor, i.code || ' ' || i.name as item, l.qty, l.received_qty as received, l.qty - l.received_qty as pending,
        round((l.qty - l.received_qty) * l.net_rate, 2) as "pendingValue", coalesce(l.delivery_date, po.delivery_date) as "deliveryDate",
        greatest(${c.p(todayIST())}::date - coalesce(l.delivery_date, po.delivery_date), 0) as "daysLate"
      from purchase.purchase_orders po join purchase.purchase_order_lines l on l.purchase_order_id = po.id join mdm.parties p on p.id = po.party_id join mdm.items i on i.id = l.item_id
      where po.status in ('Issued','Acknowledged','PartiallyReceived') and l.received_qty < l.qty and ${c.le('po.legal_entity_id')}${eq(c, 'po.legal_entity_id', 'legalEntityId')} order by 9`) },
  { id: 'supplier-performance', area: 'Procurement', title: 'Supplier performance', perm: 'purchase.grn:view', description: 'Receipts on time against the PO delivery date, and QC rejection by quantity.',
    filters: [FROM, TO], columns: [{ key: 'vendor', label: 'Vendor' }, { key: 'receipts', label: 'Receipts', type: 'int', total: true }, { key: 'onTimePct', label: 'On time', type: 'pct' },
      { key: 'received', label: 'Qty received', type: 'number', total: true }, { key: 'rejected', label: 'Qty rejected', type: 'number', total: true }, { key: 'rejectionPct', label: 'Rejection', type: 'pct' }],
    run: async (c) => rows(c, `select p.legal_name as vendor, count(distinct g.id)::int as receipts,
        round(100.0 * count(distinct g.id) filter (where g.receipt_date <= coalesce(po.delivery_date, g.receipt_date)) / nullif(count(distinct g.id), 0), 1) as "onTimePct",
        sum(gl.received_qty) as received, coalesce(sum(gl.received_qty) filter (where lt.qc_status = 'Rejected'), 0) as rejected,
        round(100.0 * coalesce(sum(gl.received_qty) filter (where lt.qc_status = 'Rejected'), 0) / nullif(sum(gl.received_qty), 0), 1) as "rejectionPct"
      from purchase.goods_receipts g join purchase.goods_receipt_lines gl on gl.goods_receipt_id = g.id join purchase.purchase_orders po on po.id = g.purchase_order_id
      join mdm.parties p on p.id = g.party_id left join inv.lots lt on lt.id = gl.lot_id where g.status = 'Posted' and ${range(c, 'g.receipt_date')} and ${c.le('po.legal_entity_id')}
      group by p.legal_name order by 2 desc`) },
  { id: 'purchase-register', area: 'Procurement', title: 'Purchase register', perm: 'purchase.invoice:view', description: 'Supplier invoices booked with tax and what is paid.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('Matched', 'Exception', 'Submitted', 'Approved', 'Rejected', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'Invoice', link: '/purchase/invoices/{id}' }, { key: 'invoiceNo', label: 'Bill no.' }, { key: 'invoiceDate', label: 'Bill date', type: 'date' }, { key: 'vendor', label: 'Vendor' },
      { key: 'gstin', label: 'GSTIN' }, { key: 'taxable', label: 'Taxable (₹)', type: 'money', total: true }, { key: 'tax', label: 'GST (₹)', type: 'money', total: true }, { key: 'total', label: 'Total (₹)', type: 'money', total: true },
      { key: 'settled', label: 'Settled (₹)', type: 'money', total: true }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select si.id, si.doc_no as "docNo", si.invoice_no as "invoiceNo", si.invoice_date as "invoiceDate", p.legal_name as vendor, p.gstin, si.taxable_total as taxable,
        si.tax_total as tax, si.grand_total as total, si.amount_settled as settled, si.status from purchase.supplier_invoices si join mdm.parties p on p.id = si.party_id
        join purchase.purchase_orders po on po.id = si.purchase_order_id where ${range(c, 'si.invoice_date')} and ${c.le('po.legal_entity_id')}${eq(c, 'si.status', 'status')} order by si.invoice_date desc`) },
  { id: 'vendor-price-history', area: 'Procurement', title: 'Vendor price history', perm: 'purchase.order:view', description: 'Net rates paid per item and vendor on purchase orders.',
    filters: [FROM, TO, { key: 'itemId', label: 'Item', type: 'select', source: 'items' }],
    columns: [{ key: 'item', label: 'Item' }, { key: 'vendor', label: 'Vendor' }, { key: 'docNo', label: 'PO', link: '/purchase/orders/{id}' }, { key: 'poDate', label: 'Date', type: 'date' },
      { key: 'qty', label: 'Qty', type: 'number' }, { key: 'uom', label: 'Unit' }, { key: 'netRate', label: 'Net rate (₹)', type: 'money' }],
    run: async (c) => rows(c, `select po.id, i.code || ' ' || i.name as item, p.legal_name as vendor, po.doc_no as "docNo", po.po_date as "poDate", l.qty, l.uom, l.net_rate as "netRate"
      from purchase.purchase_orders po join purchase.purchase_order_lines l on l.purchase_order_id = po.id join mdm.items i on i.id = l.item_id join mdm.parties p on p.id = po.party_id
      where po.status not in ('Draft','Rejected','Cancelled') and ${range(c, 'po.po_date')} and ${c.le('po.legal_entity_id')}${eq(c, 'l.item_id', 'itemId')} order by i.code, po.po_date desc`) },

  // ================================================================ Inventory
  { id: 'stock-summary', area: 'Inventory', title: 'Stock by item and warehouse', perm: 'inv.stock:view', description: 'Quantity and value on hand by status bucket.',
    filters: [WH, { key: 'itemType', label: 'Item type', type: 'select', options: [{ value: 'RM', label: 'Raw material' }, { value: 'PM', label: 'Packing material' }, { value: 'FG', label: 'Finished goods' }] }],
    columns: [{ key: 'item', label: 'Item' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'uom', label: 'Unit' }, { key: 'unrestricted', label: 'Unrestricted', type: 'number' }, { key: 'quarantine', label: 'Quarantine', type: 'number' },
      { key: 'rejected', label: 'Rejected', type: 'number' }, { key: 'blocked', label: 'Blocked', type: 'number' }, { key: 'value', label: 'Value (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select i.code || ' ' || i.name as item, w.code as warehouse, i.base_uom as uom,
        sum(sl.qty) filter (where sl.bucket = 'UNRESTRICTED') as unrestricted, sum(sl.qty) filter (where sl.bucket = 'QUARANTINE') as quarantine,
        sum(sl.qty) filter (where sl.bucket = 'REJECTED') as rejected, sum(sl.qty) filter (where sl.bucket = 'BLOCKED') as blocked, round(sum(sl.qty * sl.unit_cost), 2) as value
      from inv.stock_ledger sl join mdm.items i on i.id = sl.item_id join org.warehouses w on w.id = sl.warehouse_id where ${c.le('w.legal_entity_id')}${eq(c, 'sl.warehouse_id', 'warehouseId')}${eq(c, 'i.item_type', 'itemType')}
      group by i.code, i.name, w.code, i.base_uom having sum(sl.qty) <> 0 order by i.code, w.code`) },
  { id: 'lot-stock', area: 'Inventory', title: 'Lot stock with expiry', perm: 'inv.stock:view', description: 'Every lot with stock, its QC status and days to expiry.',
    filters: [WH], columns: [{ key: 'lotNo', label: 'Lot', link: '/stores/lots/{id}' }, { key: 'item', label: 'Item' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'qcStatus', label: 'QC status' },
      { key: 'qty', label: 'Qty', type: 'number' }, { key: 'uom', label: 'Unit' }, { key: 'expiryDate', label: 'Expiry', type: 'date' }, { key: 'daysToExpiry', label: 'Days to expiry', type: 'int' }, { key: 'value', label: 'Value (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select lt.id, lt.lot_no as "lotNo", i.code || ' ' || i.name as item, w.code as warehouse, lt.qc_status as "qcStatus", sum(sl.qty) as qty, i.base_uom as uom, lt.expiry_date as "expiryDate",
        lt.expiry_date - ${c.p(todayIST())}::date as "daysToExpiry", round(sum(sl.qty * sl.unit_cost), 2) as value
      from inv.stock_ledger sl join inv.lots lt on lt.id = sl.lot_id join mdm.items i on i.id = sl.item_id join org.warehouses w on w.id = sl.warehouse_id
      where ${c.le('w.legal_entity_id')}${eq(c, 'sl.warehouse_id', 'warehouseId')} group by lt.id, i.code, i.name, w.code, i.base_uom having sum(sl.qty) <> 0 order by lt.expiry_date nulls last, lt.lot_no`) },
  { id: 'stock-movements', area: 'Inventory', title: 'Stock movement ledger', perm: 'inv.stock:view', description: 'Every stock posting in the period: receipts, issues, output, transfers, dispatches, returns.',
    filters: [FROM, TO, WH, { key: 'itemId', label: 'Item', type: 'select', source: 'items' },
      { key: 'txnType', label: 'Movement', type: 'select', options: ['GRN', 'QC_RELEASE', 'QC_REJECT', 'SAMPLE', 'SUPPLIER_RETURN', 'ISSUE_TO_PROD', 'RETURN_FROM_PROD', 'PRODUCTION_OUTPUT', 'QA_RELEASE', 'QA_REJECT',
        'PACKING_LOSS', 'PACKING_ISSUE', 'DISPATCH', 'CUSTOMER_RETURN', 'OPENING'].map((x) => ({ value: x, label: x.replace(/_/g, ' ').toLowerCase() })) }],
    columns: [{ key: 'postedAt', label: 'When', type: 'datetime' }, { key: 'txnType', label: 'Movement' }, { key: 'item', label: 'Item' }, { key: 'lotNo', label: 'Lot' }, { key: 'warehouse', label: 'Warehouse' },
      { key: 'bucket', label: 'Bucket' }, { key: 'qty', label: 'Qty', type: 'number' }, { key: 'unitCost', label: 'Unit cost (₹)', type: 'money' }, { key: 'value', label: 'Value (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select sl.posted_at as "postedAt", sl.txn_type as "txnType", i.code as item, lt.lot_no as "lotNo", w.code as warehouse, sl.bucket, sl.qty, sl.unit_cost as "unitCost", round(sl.qty * sl.unit_cost, 2) as value
      from inv.stock_ledger sl join mdm.items i on i.id = sl.item_id join inv.lots lt on lt.id = sl.lot_id join org.warehouses w on w.id = sl.warehouse_id
      where ${range(c, `(sl.posted_at at time zone 'Asia/Kolkata')::date`)} and ${c.le('w.legal_entity_id')}${eq(c, 'sl.warehouse_id', 'warehouseId')}${eq(c, 'sl.item_id', 'itemId')}${eq(c, 'sl.txn_type', 'txnType')}
      order by sl.id desc limit 5000`) },
  { id: 'quarantine-ageing', area: 'Inventory', title: 'Quarantine ageing', brd: 'BRD p.6 KPI (red > 48 h)', perm: 'inv.stock:view', description: 'Stock waiting in quarantine for a QC or QA decision, oldest first.',
    filters: [WH], columns: [{ key: 'lotNo', label: 'Lot', link: '/stores/lots/{id}' }, { key: 'item', label: 'Item' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'qty', label: 'Qty', type: 'number' },
      { key: 'since', label: 'In quarantine since', type: 'datetime' }, { key: 'hours', label: 'Hours held', type: 'int' }, { key: 'value', label: 'Value (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select lt.id, lt.lot_no as "lotNo", i.code || ' ' || i.name as item, w.code as warehouse, sum(sl.qty) as qty, min(sl.posted_at) as since,
        floor(extract(epoch from now() - min(sl.posted_at)) / 3600)::int as hours, round(sum(sl.qty * sl.unit_cost), 2) as value
      from inv.stock_ledger sl join inv.lots lt on lt.id = sl.lot_id join mdm.items i on i.id = sl.item_id join org.warehouses w on w.id = sl.warehouse_id
      where sl.bucket = 'QUARANTINE' and ${c.le('w.legal_entity_id')}${eq(c, 'sl.warehouse_id', 'warehouseId')} group by lt.id, i.code, i.name, w.code having sum(sl.qty) > 0 order by since`) },
  { id: 'near-expiry', area: 'Inventory', title: 'Near-expiry and expired stock', perm: 'inv.stock:view', description: 'Lots with stock expiring within the chosen days, or already expired.',
    filters: [{ key: 'days', label: 'Within (days)', type: 'number', default: '90' }, WH],
    columns: [{ key: 'lotNo', label: 'Lot', link: '/stores/lots/{id}' }, { key: 'item', label: 'Item' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'qty', label: 'Qty', type: 'number' },
      { key: 'expiryDate', label: 'Expiry', type: 'date' }, { key: 'daysToExpiry', label: 'Days left', type: 'int' }, { key: 'value', label: 'Value (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select lt.id, lt.lot_no as "lotNo", i.code || ' ' || i.name as item, w.code as warehouse, sum(sl.qty) as qty, lt.expiry_date as "expiryDate",
        lt.expiry_date - ${c.p(todayIST())}::date as "daysToExpiry", round(sum(sl.qty * sl.unit_cost), 2) as value
      from inv.stock_ledger sl join inv.lots lt on lt.id = sl.lot_id join mdm.items i on i.id = sl.item_id join org.warehouses w on w.id = sl.warehouse_id
      where lt.expiry_date is not null and lt.expiry_date <= ${c.p(todayIST())}::date + ${c.p(Number(c.f.days ?? 90))}::int and ${c.le('w.legal_entity_id')}${eq(c, 'sl.warehouse_id', 'warehouseId')}
      group by lt.id, i.code, i.name, w.code having sum(sl.qty) > 0 order by lt.expiry_date`) },
  { id: 'stock-valuation', area: 'Inventory', title: 'Stock valuation', perm: 'inv.stock:view', description: 'Value of stock by item type and warehouse at the posted costs.',
    columns: [{ key: 'itemType', label: 'Item type' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'items', label: 'Items', type: 'int' }, { key: 'value', label: 'Value (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select i.item_type as "itemType", w.code as warehouse, count(distinct i.id)::int as items, round(sum(sl.qty * sl.unit_cost), 2) as value
      from inv.stock_ledger sl join mdm.items i on i.id = sl.item_id join org.warehouses w on w.id = sl.warehouse_id where ${c.le('w.legal_entity_id')}
      group by i.item_type, w.code having round(sum(sl.qty * sl.unit_cost), 2) <> 0 order by 1, 2`) },

  // ================================================================ Production
  { id: 'batch-register', area: 'Production', title: 'Batch production register', perm: 'mfg.batch:view', description: 'Batches with planned and actual output, yield, losses and material cost.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('InProgress', 'Completed', 'OnHold', 'Scrapped') }],
    columns: [{ key: 'batchNo', label: 'Batch', link: '/production/batches/{id}' }, { key: 'orderNo', label: 'Order' }, { key: 'item', label: 'Product' }, { key: 'line', label: 'Line' },
      { key: 'startedAt', label: 'Started', type: 'datetime' }, { key: 'plannedQty', label: 'Planned', type: 'number', total: true }, { key: 'outputQty', label: 'Output', type: 'number', total: true },
      { key: 'yieldPct', label: 'Yield', type: 'pct' }, { key: 'lossQty', label: 'Process loss', type: 'number', total: true }, { key: 'materialCost', label: 'Material cost (₹)', type: 'money', total: true }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select b.id, b.batch_no as "batchNo", o.doc_no as "orderNo", i.code as item, ln.code as line, b.started_at as "startedAt", b.planned_qty as "plannedQty", b.output_qty as "outputQty",
        b.yield_pct as "yieldPct", b.process_loss_qty as "lossQty", b.material_cost as "materialCost", b.status
      from mfg.batches b join mfg.production_orders o on o.id = b.production_order_id join mdm.items i on i.id = o.item_id left join mfg.lines ln on ln.id = b.line_id
      where ${range(c, `(b.started_at at time zone 'Asia/Kolkata')::date`)} and ${c.le('o.legal_entity_id')}${eq(c, 'b.status', 'status')} order by b.started_at desc`) },
  { id: 'planned-vs-actual', area: 'Production', title: 'Planned vs actual production', perm: 'mfg.order:view', description: 'Production orders due in the period: planned against produced and the gap.',
    filters: [FROM, TO], columns: [{ key: 'docNo', label: 'Order', link: '/production/orders/{id}' }, { key: 'item', label: 'Product' }, { key: 'dueDate', label: 'Due', type: 'date' }, { key: 'planned', label: 'Planned', type: 'number', total: true },
      { key: 'produced', label: 'Produced', type: 'number', total: true }, { key: 'achievementPct', label: 'Achieved', type: 'pct' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select o.id, o.doc_no as "docNo", i.code || ' ' || i.name as item, o.due_date as "dueDate", o.planned_qty as planned,
        coalesce((select sum(b.output_qty) from mfg.batches b where b.production_order_id = o.id and b.status = 'Completed'), 0) as produced,
        round(100.0 * coalesce((select sum(b.output_qty) from mfg.batches b where b.production_order_id = o.id and b.status = 'Completed'), 0) / o.planned_qty, 1) as "achievementPct", o.status
      from mfg.production_orders o join mdm.items i on i.id = o.item_id where o.status not in ('Draft','Rejected','Cancelled') and ${range(c, 'o.due_date')} and ${c.le('o.legal_entity_id')} order by o.due_date`) },
  { id: 'rm-consumption', area: 'Production', title: 'Material consumption vs formulation', perm: 'mfg.batch:view', description: 'Material dosed into each order against the formulation requirement.',
    filters: [FROM, TO], columns: [{ key: 'orderNo', label: 'Order', link: '/production/orders/{id}' }, { key: 'material', label: 'Material' }, { key: 'required', label: 'Required', type: 'number' },
      { key: 'dosed', label: 'Dosed', type: 'number' }, { key: 'uom', label: 'Unit' }, { key: 'variancePct', label: 'Variance', type: 'pct' }, { key: 'cost', label: 'Cost (₹)', type: 'money', total: true }],
    run: async (c) => rows(c, `select o.id, o.doc_no as "orderNo", i.code || ' ' || i.name as material, m.required_qty as required, coalesce(sum(bc.qty * bc.factor), 0) as dosed, m.uom,
        case when m.required_qty > 0 then round(100.0 * (coalesce(sum(bc.qty * bc.factor), 0) - m.required_qty) / m.required_qty, 2) end as "variancePct", round(coalesce(sum(bc.qty * bc.unit_cost), 0), 2) as cost
      from mfg.order_materials m join mfg.production_orders o on o.id = m.production_order_id join mdm.items i on i.id = m.item_id
      left join mfg.batch_consumptions bc on bc.order_material_id = m.id and bc.status in ('Accepted','Approved')
      where o.status in ('InProgress','Completed','Closed') and ${range(c, 'o.planned_start')} and ${c.le('o.legal_entity_id')} group by o.id, o.doc_no, i.code, i.name, m.required_qty, m.uom, m.line_no order by o.doc_no, m.line_no`) },
  { id: 'downtime', area: 'Production', title: 'Downtime register', perm: 'mfg.batch:view', description: 'Line stoppages by reason and duration.',
    filters: [FROM, TO], columns: [{ key: 'line', label: 'Line' }, { key: 'startedAt', label: 'From', type: 'datetime' }, { key: 'endedAt', label: 'To', type: 'datetime' }, { key: 'reason', label: 'Reason' },
      { key: 'hours', label: 'Hours', type: 'number', total: true }, { key: 'remarks', label: 'Remarks' }],
    run: async (c) => rows(c, `select ln.code as line, d.started_at as "startedAt", d.ended_at as "endedAt", d.reason, round(extract(epoch from d.ended_at - d.started_at) / 3600.0, 2) as hours, d.remarks
      from mfg.downtime_events d join mfg.lines ln on ln.id = d.line_id where ${range(c, `(d.started_at at time zone 'Asia/Kolkata')::date`)} order by d.started_at desc`) },
  { id: 'production-cost', area: 'Production', title: 'Production cost per batch', perm: 'mfg.batch:view', description: 'Material cost and cost per unit of output for completed batches (full cost sheet on each batch).',
    filters: [FROM, TO], columns: [{ key: 'batchNo', label: 'Batch', link: '/production/batches/{id}' }, { key: 'item', label: 'Product' }, { key: 'outputQty', label: 'Output', type: 'number', total: true },
      { key: 'uom', label: 'Unit' }, { key: 'materialCost', label: 'Material cost (₹)', type: 'money', total: true }, { key: 'perUnit', label: 'Per unit (₹)', type: 'money' }],
    run: async (c) => rows(c, `select b.id, b.batch_no as "batchNo", i.code as item, b.output_qty as "outputQty", b.uom, b.material_cost as "materialCost", round(b.material_cost / nullif(b.output_qty, 0), 2) as "perUnit"
      from mfg.batches b join mfg.production_orders o on o.id = b.production_order_id join mdm.items i on i.id = o.item_id
      where b.status = 'Completed' and ${range(c, `(b.completed_at at time zone 'Asia/Kolkata')::date`)} and ${c.le('o.legal_entity_id')} order by b.completed_at desc`) },
  { id: 'production-dashboard', area: 'Production', title: 'Production dashboard (OEE components)', perm: 'mfg.order:view', description: 'Output, plan, availability, quality rate and downtime for a month.', link: '/production/dashboard' },

  // ================================================================ QC
  { id: 'inspections', area: 'QC', title: 'Inspections and turnaround', perm: 'qc.inspection:view', description: 'Incoming and finished-goods inspections with the time from lot creation to decision.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('Pending', 'Sampled', 'Tested', 'Released', 'Rejected', 'Hold') }],
    columns: [{ key: 'docNo', label: 'Inspection', link: '/qc/inspections/{id}' }, { key: 'lotNo', label: 'Lot' }, { key: 'item', label: 'Item' }, { key: 'createdAt', label: 'Opened', type: 'datetime' },
      { key: 'decidedAt', label: 'Decided', type: 'datetime' }, { key: 'tatHours', label: 'TAT (hours)', type: 'number' }, { key: 'decision', label: 'Decision' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select q.id, q.doc_no as "docNo", lt.lot_no as "lotNo", i.code || ' ' || i.name as item, q.created_at as "createdAt", q.decided_at as "decidedAt",
        round(extract(epoch from coalesce(q.decided_at, now()) - q.created_at) / 3600.0, 1) as "tatHours", q.decision, q.status
      from qc.inspections q join inv.lots lt on lt.id = q.lot_id join mdm.items i on i.id = q.item_id where ${range(c, `(q.created_at at time zone 'Asia/Kolkata')::date`)}${eq(c, 'q.status', 'status')} order by q.created_at desc`) },
  { id: 'coa-register', area: 'QC', title: 'Certificate of analysis register', perm: 'qc.inspection:view', description: 'CoAs issued, with version and approver.',
    filters: [FROM, TO], columns: [{ key: 'docNo', label: 'CoA' }, { key: 'version', label: 'Version', type: 'int' }, { key: 'lotNo', label: 'Lot' }, { key: 'item', label: 'Item' }, { key: 'issuedAt', label: 'Issued', type: 'datetime' },
      { key: 'approver', label: 'Approved by' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select co.doc_no as "docNo", co.version_no as version, lt.lot_no as "lotNo", i.code as item, co.issued_at as "issuedAt", u.full_name as approver, co.status
      from qc.coas co join qc.inspections q on q.id = co.inspection_id join inv.lots lt on lt.id = q.lot_id join mdm.items i on i.id = q.item_id left join iam.users u on u.id = co.approver_id
      where ${range(c, `(co.issued_at at time zone 'Asia/Kolkata')::date`)} order by co.issued_at desc`) },
  { id: 'oos-register', area: 'QC', title: 'OOS investigations', perm: 'qc.inspection:view', description: 'Out-of-specification cases with status, root cause and conclusion.',
    filters: [FROM, TO], columns: [{ key: 'docNo', label: 'Case' }, { key: 'inspectionNo', label: 'Inspection', link: '/qc/inspections/{inspectionId}' }, { key: 'lotNo', label: 'Lot' }, { key: 'openedAt', label: 'Opened', type: 'datetime' },
      { key: 'status', label: 'Status' }, { key: 'rootCause', label: 'Root cause' }, { key: 'conclusion', label: 'Conclusion' }, { key: 'closedAt', label: 'Closed', type: 'datetime' }],
    run: async (c) => rows(c, `select o.doc_no as "docNo", q.id as "inspectionId", q.doc_no as "inspectionNo", lt.lot_no as "lotNo", o.opened_at as "openedAt", o.status, o.root_cause as "rootCause", o.conclusion, o.closed_at as "closedAt"
      from qc.oos_cases o join qc.inspections q on q.id = o.inspection_id join inv.lots lt on lt.id = q.lot_id where ${range(c, `(o.opened_at at time zone 'Asia/Kolkata')::date`)} order by o.opened_at desc`) },
  { id: 'calibration-status', area: 'QC', title: 'Instrument calibration status', perm: 'qc.instrument:view', description: 'Every instrument with last calibration, due date and days to due.',
    columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Instrument' }, { key: 'technique', label: 'Technique' }, { key: 'location', label: 'Location' }, { key: 'lastCalibrated', label: 'Last calibrated', type: 'date' },
      { key: 'calibrationDue', label: 'Due', type: 'date' }, { key: 'daysToDue', label: 'Days to due', type: 'int' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select code, name, technique, location, last_calibrated as "lastCalibrated", calibration_due as "calibrationDue", calibration_due - ${c.p(todayIST())}::date as "daysToDue",
        case when status = 'Active' and calibration_due < ${c.p(todayIST())}::date then 'Overdue' else status end as status from qc.instruments where status <> 'Retired' order by calibration_due nulls last`) },

  // ================================================================ QA
  { id: 'batch-release', area: 'QA', title: 'Batch release register', perm: 'qa.release:view', description: 'QA dispositions of finished-goods lots.',
    filters: [FROM, TO], columns: [{ key: 'lotNo', label: 'Lot', link: '/qa/releases/{lotId}' }, { key: 'item', label: 'Product' }, { key: 'batchNo', label: 'Batch' }, { key: 'decision', label: 'Decision' },
      { key: 'decidedBy', label: 'By' }, { key: 'decidedAt', label: 'When', type: 'datetime' }, { key: 'remarks', label: 'Remarks' }],
    run: async (c) => rows(c, `select d.lot_id as "lotId", lt.lot_no as "lotNo", i.code || ' ' || i.name as item, b.batch_no as "batchNo", d.decision, u.full_name as "decidedBy", d.decided_at as "decidedAt", d.remarks
      from qa.batch_dispositions d join inv.lots lt on lt.id = d.lot_id join mdm.items i on i.id = lt.item_id left join mfg.batches b on b.id = d.batch_id left join iam.users u on u.id = d.decided_by
      where ${range(c, `(d.decided_at at time zone 'Asia/Kolkata')::date`)} order by d.decided_at desc`) },
  { id: 'deviations', area: 'QA', title: 'Deviations', perm: 'qa.deviation:view', description: 'Deviations raised, their category and how long they stayed open.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('Open', 'Closed') }],
    columns: [{ key: 'docNo', label: 'Deviation', link: '/qa/deviations/{id}' }, { key: 'category', label: 'Category' }, { key: 'title', label: 'Title' }, { key: 'createdAt', label: 'Raised', type: 'datetime' },
      { key: 'status', label: 'Status' }, { key: 'daysOpen', label: 'Days open', type: 'int' }],
    run: async (c) => rows(c, `select d.id, d.doc_no as "docNo", d.category, d.title, d.created_at as "createdAt", d.status,
        floor(extract(epoch from coalesce(d.closed_at, now()) - d.created_at) / 86400)::int as "daysOpen" from qa.deviations d
      where ${range(c, `(d.created_at at time zone 'Asia/Kolkata')::date`)}${eq(c, 'd.status', 'status')} order by d.created_at desc`) },
  { id: 'capa-ageing', area: 'QA', title: 'CAPA ageing and effectiveness', perm: 'qa.capa:view', description: 'CAPAs with owner, due date, days overdue and the effectiveness verdict.',
    filters: [{ key: 'status', label: 'Status', type: 'select', options: st('Open', 'EffectivenessCheck', 'Closed', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'CAPA', link: '/qa/capas/{id}' }, { key: 'title', label: 'Title' }, { key: 'sourceRef', label: 'Source' }, { key: 'owner', label: 'Owner' }, { key: 'dueDate', label: 'Due', type: 'date' },
      { key: 'daysOverdue', label: 'Days overdue', type: 'int' }, { key: 'status', label: 'Status' }, { key: 'effective', label: 'Effective' }],
    run: async (c) => rows(c, `select cp.id, cp.doc_no as "docNo", cp.title, cp.source_ref as "sourceRef", u.full_name as owner, cp.due_date as "dueDate",
        case when cp.status in ('Open','EffectivenessCheck') then greatest(${c.p(todayIST())}::date - cp.due_date, 0) end as "daysOverdue", cp.status,
        case when cp.effective is null then '' when cp.effective then 'Yes' else 'No' end as effective
      from qa.capas cp left join iam.users u on u.id = cp.owner_id where true${eq(c, 'cp.status', 'status')} order by cp.due_date`) },
  { id: 'complaints', area: 'QA', title: 'Customer complaints', perm: 'qa.complaint:view', description: 'Complaints by dealer, product and lot, with severity and status.',
    filters: [FROM, TO], columns: [{ key: 'docNo', label: 'Complaint', link: '/qa/complaints/{id}' }, { key: 'receivedOn', label: 'Received', type: 'date' }, { key: 'dealer', label: 'Dealer' }, { key: 'item', label: 'Product' },
      { key: 'lotNo', label: 'Lot' }, { key: 'category', label: 'Category' }, { key: 'severity', label: 'Severity' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select q.id, q.doc_no as "docNo", q.received_on as "receivedOn", p.legal_name as dealer, i.code as item, lt.lot_no as "lotNo", q.category, q.severity, q.status
      from qa.complaints q left join mdm.parties p on p.id = q.party_id left join mdm.items i on i.id = q.item_id left join inv.lots lt on lt.id = q.lot_id
      where ${range(c, 'q.received_on')} order by q.received_on desc`) },
  { id: 'audit-findings', area: 'QA', title: 'Audit findings', perm: 'qa.audit:view', description: 'Findings of internal, supplier and customer audits and their CAPA.',
    filters: [FROM, TO], columns: [{ key: 'auditNo', label: 'Audit', link: '/qa/audits/{auditId}' }, { key: 'auditType', label: 'Type' }, { key: 'plannedDate', label: 'Date', type: 'date' }, { key: 'classification', label: 'Classification' },
      { key: 'clause', label: 'Clause' }, { key: 'description', label: 'Finding' }, { key: 'capaNo', label: 'CAPA' }],
    run: async (c) => rows(c, `select a.id as "auditId", a.doc_no as "auditNo", a.audit_type as "auditType", a.planned_date as "plannedDate", f.classification, f.clause, f.description, cp.doc_no as "capaNo"
      from qa.audit_findings f join qa.audits a on a.id = f.audit_id left join qa.capas cp on cp.id = f.capa_id where ${range(c, 'a.planned_date')} order by a.planned_date desc, f.seq`) },
  { id: 'recalls', area: 'QA', title: 'Recalls and drills', perm: 'qa.recall:view', description: 'Recalls and mock drills with time to trace.',
    columns: [{ key: 'docNo', label: 'Recall', link: '/qa/recalls/{id}' }, { key: 'mode', label: 'Mode' }, { key: 'reason', label: 'Reason' }, { key: 'initiatedAt', label: 'Started', type: 'datetime' },
      { key: 'traceSeconds', label: 'Trace time (s)', type: 'int' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select id, doc_no as "docNo", mode, reason, initiated_at as "initiatedAt", trace_seconds as "traceSeconds", status from qa.recalls order by initiated_at desc`) },

  // ================================================================ Logistics
  { id: 'pending-dispatch', area: 'Logistics', title: 'Pending dispatch', brd: 'BRD p.6 KPI (amber > 10)', perm: 'logistics.shipment:view', description: 'Approved order lines with packs still to ship.',
    filters: [ENTITY], columns: [{ key: 'docNo', label: 'Order', link: '/sales/orders/{id}' }, { key: 'orderDate', label: 'Ordered', type: 'date' }, { key: 'requiredBy', label: 'Required by', type: 'date' },
      { key: 'partyName', label: 'Dealer' }, { key: 'product', label: 'Product' }, { key: 'ordered', label: 'Ordered', type: 'number' }, { key: 'dispatched', label: 'Dispatched', type: 'number' },
      { key: 'pending', label: 'Pending', type: 'number', total: true }, { key: 'pendingValue', label: 'Pending value (₹)', type: 'money', total: true }, { key: 'daysWaiting', label: 'Days waiting', type: 'int' }],
    run: async (c) => rows(c, `select so.id, so.doc_no as "docNo", so.order_date as "orderDate", so.required_by as "requiredBy", p.legal_name as "partyName", sl.description || ' ' || sl.pack_label as product,
        sl.qty as ordered, sl.dispatched_qty as dispatched, sl.qty - sl.dispatched_qty as pending, round((sl.qty - sl.dispatched_qty) * sl.line_total / sl.qty, 2) as "pendingValue",
        ${c.p(todayIST())}::date - coalesce(so.approved_at::date, so.order_date) as "daysWaiting"
      from sales.sales_orders so join sales.sales_order_lines sl on sl.sales_order_id = so.id join mdm.parties p on p.id = so.party_id
      where so.status = 'Approved' and sl.dispatched_qty < sl.qty and ${c.le('so.legal_entity_id')}${eq(c, 'so.legal_entity_id', 'legalEntityId')} order by coalesce(so.required_by, so.order_date), so.doc_no`) },
  { id: 'shipment-status', area: 'Logistics', title: 'Shipment status', perm: 'logistics.shipment:view', description: 'Every shipment with transporter, LR, e-way bill, invoice and status.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('Planned', 'Picked', 'Dispatched', 'Delivered', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'Shipment', link: '/logistics/shipments/{id}' }, { key: 'plannedDate', label: 'Planned', type: 'date' }, { key: 'partyName', label: 'Dealer' }, { key: 'transporter', label: 'Transporter' },
      { key: 'vehicleNo', label: 'Vehicle' }, { key: 'lrNo', label: 'LR' }, { key: 'ewbNo', label: 'E-way bill' }, { key: 'invoiceNo', label: 'Invoice' }, { key: 'dispatchedAt', label: 'Dispatched', type: 'datetime' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select s.id, s.doc_no as "docNo", s.planned_date as "plannedDate", p.legal_name as "partyName", t.name as transporter, s.vehicle_no as "vehicleNo", s.lr_no as "lrNo", s.ewb_no as "ewbNo",
        (select i.doc_no from sales.invoices i where i.shipment_id = s.id and i.status <> 'Cancelled') as "invoiceNo", s.dispatched_at as "dispatchedAt", s.status
      from logistics.shipments s join mdm.parties p on p.id = s.party_id left join logistics.transporters t on t.id = s.transporter_id
      where ${range(c, 's.planned_date')} and ${c.le('s.legal_entity_id')}${eq(c, 's.status', 'status')} order by s.planned_date desc, s.doc_no desc`) },
  { id: 'pod-pending', area: 'Logistics', title: 'POD pending', perm: 'logistics.shipment:view', description: 'Dispatched shipments without proof of delivery, oldest first.',
    columns: [{ key: 'docNo', label: 'Shipment', link: '/logistics/shipments/{id}' }, { key: 'partyName', label: 'Dealer' }, { key: 'transporter', label: 'Transporter' }, { key: 'lrNo', label: 'LR' },
      { key: 'dispatchedAt', label: 'Dispatched', type: 'datetime' }, { key: 'daysInTransit', label: 'Days since dispatch', type: 'int' }],
    run: async (c) => rows(c, `select s.id, s.doc_no as "docNo", p.legal_name as "partyName", t.name as transporter, s.lr_no as "lrNo", s.dispatched_at as "dispatchedAt",
        floor(extract(epoch from now() - s.dispatched_at) / 86400)::int as "daysInTransit" from logistics.shipments s join mdm.parties p on p.id = s.party_id left join logistics.transporters t on t.id = s.transporter_id
      where s.status = 'Dispatched' and ${c.le('s.legal_entity_id')} order by s.dispatched_at`) },
  { id: 'delivery-performance', area: 'Logistics', title: 'Delivery performance', perm: 'logistics.shipment:view', description: 'Transit days and short deliveries by transporter.',
    filters: [FROM, TO], columns: [{ key: 'transporter', label: 'Transporter' }, { key: 'delivered', label: 'Delivered', type: 'int', total: true }, { key: 'avgDays', label: 'Avg transit (days)', type: 'number' },
      { key: 'short', label: 'Delivered short', type: 'int', total: true }, { key: 'shortPct', label: 'Short', type: 'pct' }],
    run: async (c) => rows(c, `select coalesce(t.name, '—') as transporter, count(*)::int as delivered, round(avg(s.pod_received_on - (s.dispatched_at at time zone 'Asia/Kolkata')::date), 1) as "avgDays",
        count(*) filter (where s.status_reason = 'Delivered short')::int as short, round(100.0 * count(*) filter (where s.status_reason = 'Delivered short') / count(*), 1) as "shortPct"
      from logistics.shipments s left join logistics.transporters t on t.id = s.transporter_id where s.status = 'Delivered' and ${range(c, 's.pod_received_on')} and ${c.le('s.legal_entity_id')} group by t.name order by 2 desc`) },
  { id: 'freight-cost', area: 'Logistics', title: 'Freight cost', perm: 'logistics.freight_bill:view', description: 'Freight billed per shipment against the freight agreed at dispatch and the invoice value.',
    filters: [FROM, TO], columns: [{ key: 'billNo', label: 'Freight bill', link: '/logistics/freight-bills/{billId}' }, { key: 'transporter', label: 'Transporter' }, { key: 'shipmentNo', label: 'Shipment' }, { key: 'partyName', label: 'Dealer' },
      { key: 'agreed', label: 'Agreed (₹)', type: 'money', total: true }, { key: 'billed', label: 'Billed (₹)', type: 'money', total: true }, { key: 'invoiceValue', label: 'Invoice value (₹)', type: 'money', total: true }, { key: 'freightPct', label: 'Freight % of sales', type: 'pct' }],
    run: async (c) => rows(c, `select fb.id as "billId", fb.doc_no as "billNo", t.name as transporter, s.doc_no as "shipmentNo", p.legal_name as "partyName", l.agreed, l.amount as billed,
        (select i.taxable_total from sales.invoices i where i.shipment_id = s.id and i.status = 'Posted') as "invoiceValue",
        round(100.0 * l.amount / nullif((select i.taxable_total from sales.invoices i where i.shipment_id = s.id and i.status = 'Posted'), 0), 2) as "freightPct"
      from logistics.freight_bill_lines l join logistics.freight_bills fb on fb.id = l.freight_bill_id join logistics.shipments s on s.id = l.shipment_id join logistics.transporters t on t.id = fb.transporter_id
      join mdm.parties p on p.id = s.party_id where fb.status not in ('Cancelled','Rejected') and ${range(c, 'fb.bill_date')} and ${c.le('fb.legal_entity_id')} order by fb.bill_date desc`) },
  { id: 'customer-returns', area: 'Logistics', title: 'Customer returns', perm: 'sales.return:view', description: 'Goods returned by dealers, by lot, with the QA decision.',
    filters: [FROM, TO], columns: [{ key: 'docNo', label: 'Return', link: '/logistics/returns/{id}' }, { key: 'receivedOn', label: 'Received', type: 'date' }, { key: 'partyName', label: 'Dealer' }, { key: 'reason', label: 'Reason' },
      { key: 'lotNo', label: 'Lot' }, { key: 'packs', label: 'Packs', type: 'number', total: true }, { key: 'disposition', label: 'QA decision' }],
    run: async (c) => rows(c, `select r.id, r.doc_no as "docNo", r.received_on as "receivedOn", p.legal_name as "partyName", r.reason, lt.lot_no as "lotNo", l.packs, coalesce(l.disposition, 'Awaiting QA') as disposition
      from sales.customer_returns r join sales.customer_return_lines l on l.return_id = r.id join mdm.parties p on p.id = r.party_id join inv.lots lt on lt.id = l.lot_id
      where ${range(c, 'r.received_on')} and ${c.le('r.legal_entity_id')} order by r.received_on desc`) },

  // ================================================================ Finance
  { id: 'invoice-register', area: 'Finance', title: 'Sales invoice register', perm: 'sales.invoice:view', description: 'Tax invoices with GSTIN, place of supply, taxable value and tax heads.',
    filters: [FROM, TO, ENTITY, { key: 'status', label: 'Status', type: 'select', options: st('Posted', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'Invoice', link: '/finance/invoices/{id}' }, { key: 'invoiceDate', label: 'Date', type: 'date' }, { key: 'partyName', label: 'Dealer' }, { key: 'gstin', label: 'GSTIN' },
      { key: 'pos', label: 'POS' }, { key: 'taxable', label: 'Taxable (₹)', type: 'money', total: true }, { key: 'cgst', label: 'CGST (₹)', type: 'money', total: true }, { key: 'sgst', label: 'SGST (₹)', type: 'money', total: true },
      { key: 'igst', label: 'IGST (₹)', type: 'money', total: true }, { key: 'total', label: 'Total (₹)', type: 'money', total: true }, { key: 'outstanding', label: 'Outstanding (₹)', type: 'money', total: true }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select i.id, i.doc_no as "docNo", i.invoice_date as "invoiceDate", p.legal_name as "partyName", i.party_gstin as gstin, i.place_of_supply as pos, i.taxable_total as taxable,
        i.cgst_total as cgst, i.sgst_total as sgst, i.igst_total as igst, i.grand_total as total, case when i.status = 'Posted' then i.grand_total - i.amount_settled else 0 end as outstanding, i.status
      from sales.invoices i join mdm.parties p on p.id = i.party_id where ${range(c, 'i.invoice_date')} and ${c.le('i.legal_entity_id')}${eq(c, 'i.legal_entity_id', 'legalEntityId')}${eq(c, 'i.status', 'status')}
      order by i.invoice_date desc, i.doc_no desc`) },
  { id: 'credit-exposure', area: 'Finance', title: 'Credit exposure', brd: 'D18', perm: 'finance.receivable:view', description: 'Each dealer\'s limit, unpaid and overdue invoices, uninvoiced orders, exposure, headroom and freeze.',
    columns: [{ key: 'partyName', label: 'Dealer' }, { key: 'creditLimit', label: 'Limit (₹)', type: 'money' }, { key: 'creditDays', label: 'Days', type: 'int' }, { key: 'outstanding', label: 'Unpaid (₹)', type: 'money', total: true },
      { key: 'overdue', label: 'Overdue (₹)', type: 'money', total: true }, { key: 'uninvoicedOrders', label: 'Uninvoiced orders (₹)', type: 'money', total: true }, { key: 'onAccount', label: 'Unapplied (₹)', type: 'money', total: true },
      { key: 'exposure', label: 'Exposure (₹)', type: 'money', total: true }, { key: 'headroom', label: 'Headroom (₹)', type: 'money' }, { key: 'frozen', label: 'Order freeze' }],
    run: async (c) => {
      const dealers = await rows(c, `select dp.party_id, p.legal_name from mdm.dealer_profiles dp join mdm.parties p on p.id = dp.party_id where dp.status = 'Active' and ${await c.terr('dp.territory_id')} order by p.legal_name`);
      const out = [];
      for (const d of dealers) {
        const e = await creditExposure(c.db, d.party_id);
        if (e.outstanding || e.uninvoicedOrders || e.onAccount) out.push({ partyName: d.legal_name, ...e, overdueInvoices: undefined, frozen: e.frozen ? 'Frozen' : '' });
      }
      return out.sort((a, b) => b.exposure - a.exposure);
    } },
  { id: 'collection-efficiency', area: 'Finance', title: 'Collection efficiency', perm: 'finance.receivable:view', description: 'By month: invoiced, collected, and collections as a share of what fell due.',
    columns: [{ key: 'month', label: 'Month' }, { key: 'invoiced', label: 'Invoiced (₹)', type: 'money', total: true }, { key: 'fellDue', label: 'Fell due (₹)', type: 'money', total: true },
      { key: 'collected', label: 'Collected (₹)', type: 'money', total: true }, { key: 'efficiencyPct', label: 'Collected ÷ due', type: 'pct' }],
    run: async (c) => rows(c, `with m as (select generate_series(date_trunc('month', ${c.p(fyStart())}::date), date_trunc('month', ${c.p(todayIST())}::date), interval '1 month')::date as m)
      select to_char(m.m, 'Mon YYYY') as month,
        coalesce((select sum(grand_total) from sales.invoices i where i.status = 'Posted' and date_trunc('month', i.invoice_date) = m.m and ${c.le('i.legal_entity_id')}), 0) as invoiced,
        coalesce((select sum(grand_total) from sales.invoices i where i.status = 'Posted' and date_trunc('month', i.due_date) = m.m and ${c.le('i.legal_entity_id')}), 0) as "fellDue",
        coalesce((select sum(amount) from fin.receipts r where r.status = 'Posted' and date_trunc('month', r.receipt_date) = m.m and ${c.le('r.legal_entity_id')}), 0) as collected,
        round(100.0 * coalesce((select sum(amount) from fin.receipts r where r.status = 'Posted' and date_trunc('month', r.receipt_date) = m.m and ${c.le('r.legal_entity_id')}), 0)
          / nullif((select sum(grand_total) from sales.invoices i where i.status = 'Posted' and date_trunc('month', i.due_date) = m.m and ${c.le('i.legal_entity_id')}), 0), 1) as "efficiencyPct"
      from m order by m.m`) },
  { id: 'payables-ageing', area: 'Finance', title: 'Payables ageing', perm: 'finance.payable:view', description: 'What we owe vendors and transporters by days past due.', link: '/finance/payables' },
  { id: 'payment-register', area: 'Finance', title: 'Payment register', perm: 'finance.payment:view', description: 'Payments to vendors and transporters with TDS and UTR.',
    filters: [FROM, TO, { key: 'status', label: 'Status', type: 'select', options: st('Draft', 'Submitted', 'Approved', 'Paid', 'Rejected', 'Cancelled') }],
    columns: [{ key: 'docNo', label: 'Payment', link: '/finance/payments/{id}' }, { key: 'paymentDate', label: 'Date', type: 'date' }, { key: 'payee', label: 'Payee' }, { key: 'mode', label: 'Mode' },
      { key: 'amount', label: 'Gross (₹)', type: 'money', total: true }, { key: 'tdsSection', label: 'TDS u/s' }, { key: 'tds', label: 'TDS (₹)', type: 'money', total: true }, { key: 'net', label: 'Net (₹)', type: 'money', total: true },
      { key: 'reference', label: 'UTR' }, { key: 'status', label: 'Status' }],
    run: async (c) => rows(c, `select p.id, p.doc_no as "docNo", coalesce(p.paid_on, p.payment_date) as "paymentDate", coalesce(pt.legal_name, t.name) as payee, p.mode, p.amount, p.tds_section as "tdsSection",
        p.tds_amount as tds, p.net_amount as net, p.reference, p.status from fin.payments p left join mdm.parties pt on pt.id = p.party_id left join logistics.transporters t on t.id = p.transporter_id
      where ${range(c, 'coalesce(p.paid_on, p.payment_date)')} and ${c.le('p.legal_entity_id')}${eq(c, 'p.status', 'status')} order by 2 desc`) },
  { id: 'posting-reconciliation', area: 'Finance', title: 'Posting reconciliation', perm: 'finance.gl:view', description: 'Ledger control accounts against the sub-ledgers they summarise: receivables, payables and inventory.',
    filters: [ENTITY], columns: [{ key: 'area', label: 'Control' }, { key: 'ledger', label: 'General ledger (₹)', type: 'money' }, { key: 'subledger', label: 'Sub-ledger (₹)', type: 'money' }, { key: 'difference', label: 'Difference (₹)', type: 'money' },
      { key: 'note', label: 'Sub-ledger basis' }],
    run: async (c) => {
      const le = c.f.legalEntityId;
      if (!le) throw Errors.validation({ legalEntityId: 'Choose the entity' });
      const s = legalEntityScope(c.req, 'finance.gl:view');
      if (s && !s.includes(le)) throw Errors.forbidden('finance.gl:view');
      await syncLedger(c.db);   // compare against everything posted up to now
      const gl = async (keys: string[]) => Number((await c.db.query(`select coalesce(sum(l.debit - l.credit), 0) as v from fin.journal_lines l join fin.journals j on j.id = l.journal_id join fin.accounts a on a.id = l.account_id
          where j.legal_entity_id = $1 and j.status in ('Posted','Reversed') and a.system_key = any($2)`, [le, keys])).rows[0].v);
      const one = async (sql: string) => Number((await c.db.query(sql, [le])).rows[0].v);
      const ar = await one(`select (select coalesce(sum(grand_total - amount_settled), 0) from sales.invoices where legal_entity_id = $1 and status = 'Posted')
          - (select coalesce(sum(amount - allocated), 0) from fin.receipts where legal_entity_id = $1 and status = 'Posted') as v`);
      const ap = await one(`select (select coalesce(sum(si.grand_total - si.amount_settled), 0) from purchase.supplier_invoices si join purchase.purchase_orders po on po.id = si.purchase_order_id where po.legal_entity_id = $1 and si.status in ${INV})
          - (select coalesce(sum(dn.grand_total), 0) from purchase.debit_notes dn join purchase.supplier_returns sr on sr.id = dn.supplier_return_id where sr.purchase_order_id in (select id from purchase.purchase_orders where legal_entity_id = $1) and dn.status = 'Open') as v`);
      const apt = await one(`select coalesce(sum(grand_total - amount_settled), 0) as v from logistics.freight_bills where legal_entity_id = $1 and status = 'Approved'`);
      const inv = await one(`select coalesce(round(sum(sl.qty * sl.unit_cost), 2), 0) as v from inv.stock_ledger sl join org.warehouses w on w.id = sl.warehouse_id where w.legal_entity_id = $1`);
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const line = (area: string, ledger: number, sub: number, note: string) => ({ area, ledger: r2(ledger), subledger: r2(sub), difference: r2(ledger - sub), note });
      return [
        line('Trade receivables (Dr)', await gl(['AR_TRADE']), ar, 'Unpaid invoices less unapplied receipts'),
        line('Trade payables — vendors (Cr)', -(await gl(['AP_TRADE'])), ap, 'Unpaid approved supplier invoices less open debit notes'),
        line('Trade payables — transporters (Cr)', -(await gl(['AP_TRANSPORT'])), apt, 'Unpaid approved freight bills'),
        line('Inventories and WIP (Dr)', await gl(['INV_RM', 'INV_PM', 'INV_FG', 'INV_OTHER']), inv, 'Stock ledger value (WIP is in production, not in stores)'),
      ];
    } },
  { id: 'trial-balance', area: 'Finance', title: 'Trial balance', perm: 'finance.gl:view', description: 'Every account\'s movement and closing balance.', link: '/finance/trial-balance' },
  { id: 'financial-statements', area: 'Finance', title: 'Profit and loss, balance sheet', perm: 'finance.gl:view', description: 'Statements from the posted journals.', link: '/finance/statements' },
  { id: 'gst-summary', area: 'Finance', title: 'GST summary', perm: 'finance.gst:view', description: 'GSTR-1 tables and the GSTR-3B working for a month.', link: '/finance/gst' },
];

const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function runReport(db: Db, req: Request, x: Report) {
  const f: F = {};
  for (const flt of x.filters ?? []) {
    const v = typeof req.query[flt.key] === 'string' ? (req.query[flt.key] as string).trim() : '';
    if (v) {
      if (flt.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw Errors.validation({ [flt.key]: 'YYYY-MM-DD' });
      if (flt.type === 'number' && !Number.isFinite(Number(v))) throw Errors.validation({ [flt.key]: 'A number' });
      if (flt.options && !flt.source && !flt.options.some((o) => o.value === v)) throw Errors.validation({ [flt.key]: 'Not an allowed value' });
      f[flt.key] = v;
    } else if (flt.default) f[flt.key] = typeof flt.default === 'function' ? flt.default() : flt.default;
  }
  const args: unknown[] = [];
  const p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const le = (col: string) => { const s = legalEntityScope(req, x.perm); return s ? `${col} = any(${p(s)}::uuid[])` : 'true'; };
  const terr = (col: string) => territorySql(db, req, x.perm, col, args);
  const data = await x.run!({ db, req, f, args, p, le, terr });
  const columns = x.columns ?? [];
  const totals: Record<string, number> = {};
  for (const col of columns.filter((k) => k.total)) totals[col.key] = Math.round(data.reduce((a, row) => a + Number(row[col.key] ?? 0), 0) * 10000) / 10000;
  return { columns, rows: data, totals, filters: f, count: data.length, truncated: data.length >= 5000 };
}


function toCsv(out: Awaited<ReturnType<typeof runReport>>) {
  const lines = [out.columns.map((k) => csvCell(k.label)).join(',')];
  for (const row of out.rows) lines.push(out.columns.map((k) => csvCell(row[k.key])).join(','));
  if (Object.keys(out.totals).length) lines.push(out.columns.map((k, i) => (i === 0 ? 'Total' : k.key in out.totals ? csvCell(out.totals[k.key]) : '')).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Runs a report for a request (a signed-in user, or a scheduled run acting as its owner) and returns it as CSV. */
export async function reportCsv(db: Db, req: Request, id: string) {
  const x = REPORTS.find((y) => y.id === id);
  if (!x || !can(req, x.perm) || !x.run) throw Errors.notFound('Report');
  const out = await runReport(db, req, x);
  return { title: x.title, csv: toCsv(out), count: out.count, fileName: `${x.id}-${todayIST()}.csv` };
}

export function reportRoutes(db: Db) {
  const r = Router();
  const byId = (id: string) => REPORTS.find((x) => x.id === id);
  const visible = (req: Request) => REPORTS.filter((x) => can(req, x.perm));

  async function options(req: Request, s: Source, perm: string) {
    const le = legalEntityScope(req, perm);
    const q = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows as { value: string; label: string }[];
    switch (s) {
      case 'entities': return q(`select id as value, name as label from org.legal_entities where status = 'Active' ${le ? 'and id = any($1)' : ''} order by name`, le ? [le] : []);
      case 'warehouses': return q(`select id as value, code || ' — ' || name as label from org.warehouses where status = 'Active' ${le ? 'and legal_entity_id = any($1)' : ''} order by code`, le ? [le] : []);
      case 'territories': return q(`select t.id as value, repeat('  ', greatest(nlevel(t.path) - 1, 0)) || t.name as label from org.territories t where t.status = 'Active' order by t.path`);
      case 'categories': return q(`select id as value, name as label from mdm.product_categories where status = 'Active' order by name`);
      case 'items': return q(`select id as value, code || ' ' || name as label from mdm.items where status = 'Active' order by code limit 500`);
      case 'dealers': return q(`select p.id as value, p.legal_name as label from mdm.dealer_profiles d join mdm.parties p on p.id = d.party_id where d.status = 'Active' order by 2`);
      case 'vendors': return q(`select p.id as value, p.legal_name as label from mdm.vendor_profiles v join mdm.parties p on p.id = v.party_id where v.status = 'Active' order by 2`);
      case 'transporters': return q(`select id as value, name as label from logistics.transporters where status = 'Active' order by name`);
    }
  }
  const def = (x: Report) => ({ id: x.id, area: x.area, title: x.title, description: x.description, brd: x.brd ?? null, link: x.link ?? null, columns: x.columns ?? [],
    filters: (x.filters ?? []).map((f) => ({ ...f, default: typeof f.default === 'function' ? f.default() : f.default ?? null, source: undefined })) });

  r.get('/', asyncHandler(async (req, res) => {
    const list = visible(req);
    res.json({ data: list.map((x) => ({ id: x.id, area: x.area, title: x.title, description: x.description, brd: x.brd ?? null, link: x.link ?? null })), total: list.length, catalogue: REPORTS.length });
  }));

  r.get('/:id', asyncHandler(async (req, res) => {
    const x = byId(req.params.id!);
    if (!x || !can(req, x.perm)) throw Errors.notFound('Report');
    const d = def(x);
    for (const [i, f] of (x.filters ?? []).entries()) if (f.source) (d.filters[i] as Filter).options = await options(req, f.source, x.perm);
    res.json(d);
  }));

  r.get('/:id/run', asyncHandler(async (req, res) => {
    const x = byId(req.params.id!);
    if (!x || !can(req, x.perm) || !x.run) throw Errors.notFound('Report');
    res.json(await runReport(db, req, x));
  }));

  // CSV for Excel: UTF-8 with BOM so ₹ and Indian names open correctly
  r.get('/:id/export', asyncHandler(async (req, res) => {
    const x = byId(req.params.id!);
    if (!x || !can(req, x.perm) || !x.run) throw Errors.notFound('Report');
    const out = await runReport(db, req, x);
    res.send(toCsv(out));
  }));
  return r;
}
export const REPORT_IDS = REPORTS.filter((x) => x.run).map((x) => x.id);
