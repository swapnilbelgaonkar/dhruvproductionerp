import { Stack, Microscope, TrayArrowDown, ArrowUUpLeft, Receipt, Barcode, FileText, Tag, ShoppingCart, Truck, ClipboardText, ListChecks, Package, Buildings, CalendarCheck, Funnel, Kanban, Storefront, Flask, Percent, Ruler, CheckSquareOffset, ClockCounterClockwise, Factory, FlowArrow, Gauge, Hash, IdentificationBadge, MapTrifold, Scales, ShieldCheck, SlidersHorizontal, TreeStructure, UsersThree, Warehouse, Warning, TestTube, ChartBar, Timer, Cube, WarningOctagon, ArrowsClockwise, XSquare, GitDiff, ChatCircleText, Siren, type Icon } from '@phosphor-icons/react';

export interface NavItem { to: string; label: string; icon: Icon; perm?: string }
export interface NavGroup { label?: string; items: NavItem[] }

/** Only modules that are built appear here (no placeholder menu items — MP Part 28). */
export const NAV: NavGroup[] = [
  { items: [
    { to: '/', label: 'Overview', icon: Gauge },
    { to: '/approvals', label: 'Approvals', icon: CheckSquareOffset },
  ] },
  { label: 'Sales', items: [
    { to: '/sales/leads', label: 'Leads', icon: Funnel, perm: 'crm.lead:view' },
    { to: '/sales/opportunities', label: 'Pipeline', icon: Kanban, perm: 'crm.opportunity:view' },
    { to: '/sales/activities', label: 'My Activities', icon: CalendarCheck, perm: 'crm.activity:view' },
    { to: '/sales/dealers', label: 'Dealers', icon: Storefront, perm: 'mdm.dealer:view' },
    { to: '/sales/quotations', label: 'Quotations', icon: FileText, perm: 'sales.quotation:view' },
    { to: '/sales/orders', label: 'Sales Orders', icon: ShoppingCart, perm: 'sales.order:view' },
    { to: '/sales/price-lists', label: 'Price Lists', icon: Tag, perm: 'sales.price_list:view' },
  ] },
  { label: 'Purchase', items: [
    { to: '/purchase/requisitions', label: 'Requisitions', icon: ClipboardText, perm: 'purchase.requisition:view' },
    { to: '/purchase/rfqs', label: 'RFQs & Comparison', icon: ListChecks, perm: 'purchase.rfq:view' },
    { to: '/purchase/orders', label: 'Purchase Orders', icon: Package, perm: 'purchase.order:view' },
    { to: '/purchase/invoices', label: 'Supplier Invoices', icon: Receipt, perm: 'purchase.invoice:view' },
    { to: '/purchase/vendors', label: 'Vendors', icon: Truck, perm: 'mdm.vendor:view' },
  ] },
  { label: 'Stores & Quality', items: [
    { to: '/stores/receipts', label: 'Goods Receipts', icon: TrayArrowDown, perm: 'purchase.grn:view' },
    { to: '/qc/inspections', label: 'QC — Incoming Lots', icon: Microscope, perm: 'qc.inspection:view' },
    { to: '/qc/ipqc', label: 'QC — In-process', icon: Microscope, perm: 'qc.ipqc:record' },
    { to: '/qc/oos', label: 'OOS Investigations', icon: WarningOctagon, perm: 'qc.inspection:view' },
    { to: '/qc/master', label: 'QC Masters', icon: ListChecks, perm: 'qc.spec:view' },

    { to: '/stores/returns', label: 'Supplier Returns', icon: ArrowUUpLeft, perm: 'purchase.return:view' },
    { to: '/stores/stock', label: 'Stock & Lots', icon: Stack, perm: 'inv.stock:view' },
  ] },
  { label: 'Quality Assurance', items: [
    { to: '/qa/releases', label: 'Batch Release', icon: ShieldCheck, perm: 'qa.release:view' },
    { to: '/qa/deviations', label: 'Deviations', icon: Warning, perm: 'qa.deviation:view' },
    { to: '/qa/capas', label: 'CAPA', icon: ArrowsClockwise, perm: 'qa.capa:view' },
    { to: '/qa/ncs', label: 'Non-conformances', icon: XSquare, perm: 'qa.nc:view' },
    { to: '/qa/changes', label: 'Change Control', icon: GitDiff, perm: 'qa.change:view' },
    { to: '/qa/complaints', label: 'Complaints', icon: ChatCircleText, perm: 'qa.complaint:view' },
    { to: '/qa/recalls', label: 'Recalls', icon: Siren, perm: 'qa.recall:view' },
  ] },
  { label: 'Production', items: [
    { to: '/production/dashboard', label: 'Production Dashboard', icon: ChartBar, perm: 'mfg.order:view' },
    { to: '/production/orders', label: 'Production Orders', icon: Factory, perm: 'mfg.order:view' },
    { to: '/production/batches', label: 'Batches', icon: TestTube, perm: 'mfg.batch:view' },
    { to: '/production/packing', label: 'Packing', icon: Cube, perm: 'mfg.packing:view' },
    { to: '/production/downtime', label: 'Downtime', icon: Timer, perm: 'mfg.batch:view' },
    { to: '/production/formulations', label: 'Formulations (BOM)', icon: Flask, perm: 'mfg.bom:view' },
    { to: '/production/settings', label: 'Plant & Line Settings', icon: SlidersHorizontal, perm: 'mfg.settings:view' },
  ] },
  { label: 'Masters', items: [
    { to: '/masters/legal-entities', label: 'Legal Entities', icon: Buildings, perm: 'org.legal_entity:view' },
    { to: '/masters/plants', label: 'Plants', icon: Factory, perm: 'org.plant:view' },
    { to: '/masters/warehouses', label: 'Warehouses', icon: Warehouse, perm: 'org.warehouse:view' },
    { to: '/masters/territories', label: 'Territories', icon: MapTrifold, perm: 'org.territory:view' },
    { to: '/masters/departments', label: 'Departments', icon: TreeStructure, perm: 'org.department:view' },
    { to: '/masters/employees', label: 'Employees', icon: IdentificationBadge, perm: 'org.employee:view' },
  ] },
  { label: 'Products', items: [
    { to: '/products/items', label: 'Items & Products', icon: Barcode, perm: 'mdm.item:view' },
    { to: '/products/categories', label: 'Categories', icon: Flask, perm: 'mdm.product_category:view' },
    { to: '/products/hsn', label: 'HSN & GST Rates', icon: Percent, perm: 'mdm.hsn:view' },
    { to: '/products/uom', label: 'Units of Measure', icon: Ruler, perm: 'mdm.uom:view' },
  ] },
  { label: 'Administration', items: [
    { to: '/admin/users', label: 'Users', icon: UsersThree, perm: 'iam.user:view' },
    { to: '/admin/roles', label: 'Roles & Permissions', icon: ShieldCheck, perm: 'iam.role:view' },
    { to: '/admin/policies', label: 'Approval Policies', icon: FlowArrow, perm: 'wf.policy:view' },
    { to: '/admin/authority-limits', label: 'Authority Limits', icon: Scales, perm: 'iam.authority_limit:view' },
    { to: '/admin/number-series', label: 'Number Series', icon: Hash, perm: 'sys.number_series:view' },
    { to: '/admin/settings', label: 'Settings', icon: SlidersHorizontal, perm: 'sys.settings:view' },
    { to: '/admin/audit', label: 'Audit Log', icon: ClockCounterClockwise, perm: 'sys.audit:view' },
  ] },
];
