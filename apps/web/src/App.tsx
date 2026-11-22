import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { FormulationDetailPage, FormulationsPage, FormulationVersionFormPage, FormulationVersionLink, FormulationVersionPage } from './pages/production/Formulations';
import { PlantSettingsPage } from './pages/production/PlantSettings';
import { CreditNoteDetailPage, CreditNotePrintPage, CreditNotesPage, CustomerReturnDetailPage, CustomerReturnsPage, SalesInvoiceDetailPage, SalesInvoicePrintPage, SalesInvoicesPage } from './pages/finance/SalesInvoices';
import { DispatchQueuePage, ShipmentChallanPage, ShipmentDetailPage, ShipmentsPage, TransportersPage } from './pages/logistics/Dispatch';
import { BatchDetailPage, BatchesPage, IpqcWorklistPage } from './pages/production/Batches';
import { DowntimePage, PackingLabelsPage, PackingRunDetailPage, PackingRunsPage, ProductionDashboardPage, VerifyPage } from './pages/production/Packing';
import { OverrideLink, ProductionOrderDetailPage, ProductionOrderFormPage, ProductionOrdersPage } from './pages/production/ProductionOrders';
import { DeviationDetailPage, DeviationsPage } from './pages/quality/Deviations';
import { ReleaseReviewPage, ReleasesPage } from './pages/quality/Releases';
import { CapaDetailPage, CapasPage, ChangeDetailPage, ChangesPage, ComplaintDetailPage, ComplaintsPage, NcDetailPage, NcsPage, RecallDetailPage, RecallsPage } from './pages/quality/QaCore';
import { AuditDetailPage, AuditsPage, DocumentDetailPage, DocumentsPage, LineClearancePage, QualityDashboardPage, RisksPage } from './pages/quality/QaSystem';
import { CoaPrintPage, InstrumentDetailPage, OosDetailPage, OosListPage, QcMasterPage, SpecDetailPage, VerifyCoaPage } from './pages/quality/QcSpecs';
import { EmptyState, Skeleton } from './components/ui';
import { AppShell } from './layout/AppShell';
import { useAuth } from './lib/auth';
import { AuditPage, AuthorityLimitsPage, NumberSeriesPage, PoliciesPage, ProfilePage, SettingsPage } from './pages/admin/Config';
import { RolesPage, UserDetailPage, UsersPage } from './pages/admin/Users';
import { ApprovalDetailPage, ApprovalsPage } from './pages/approvals/Approvals';
import { MfaEnrol, MfaVerify, PasswordChangeGate } from './pages/auth/Gate';
import { LoginPage } from './pages/auth/Login';
import { MASTERS, MasterDetailPage, MasterFormPage, MasterListPage } from './pages/masters/LifecycleMaster';
import { DepartmentsPage, EmployeeDetailPage, EmployeeFormPage, EmployeesPage, TerritoriesPage } from './pages/masters/SimpleMasters';
import { OverviewPage } from './pages/Overview';
import { DealerDetailPage, DealerFormPage, DealersPage } from './pages/sales/Dealers';
import { ActivitiesPage, LeadDetailPage, LeadsPage, OpportunityDetailPage, PipelinePage } from './pages/sales/Crm';
import { QuotationDetailPage, QuotationFormPage, QuotationPrintPage, QuotationsPage } from './pages/sales/Quotations';
import { VendorDetailPage, VendorFormPage, VendorsPage } from './pages/purchase/Vendors';
import { PurchaseOrderDetailPage, PurchaseOrderFormPage, PurchaseOrderPrintPage, PurchaseOrdersPage } from './pages/purchase/PurchaseOrders';
import { ReceiptDetailPage, ReceiptFormPage, ReceiptsPage } from './pages/stores/Receipts';
import { LotDetailPage, StockPage } from './pages/stores/Stock';
import { ReturnDetailPage, ReturnFormPage, ReturnPrintPage, ReturnsPage } from './pages/stores/Returns';
import { InvoiceDetailPage, InvoiceFormPage, InvoicesPage } from './pages/purchase/Invoices';
import { InspectionDetailPage, InspectionsPage } from './pages/quality/Inspections';
import { RfqDetailPage, RfqFormPage, RfqsPage } from './pages/purchase/Rfqs';
import { RequisitionDetailPage, RequisitionFormPage, RequisitionsPage } from './pages/purchase/Requisitions';
import { SalesOrderDetailPage, SalesOrderFormPage, SalesOrderPrintPage, SalesOrdersPage } from './pages/sales/SalesOrders';
import { CategoriesPage, HsnPage, UomPage } from './pages/masters/ProductMasters';

function Protected({ perm, children }: { perm?: string; children: JSX.Element }) {
  const { can } = useAuth();
  if (perm && !can(perm)) return <div className="card mt-6"><EmptyState title="You don't have access to this page" text={`Ask your Security Administrator for the permission “${perm}” if you need it.`} /></div>;
  return children;
}

export function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  // the public label check needs no sign-in (QR-001)
  if (loc.pathname.startsWith('/verify/')) return <Routes><Route path="/verify/:serial" element={<VerifyPage />} /></Routes>;
  if (loc.pathname.startsWith('/verify-coa/')) return <Routes><Route path="/verify-coa/:docNo" element={<VerifyCoaPage />} /></Routes>;
  if (loading) return <div className="grid min-h-screen place-items-center bg-canvas"><Skeleton className="h-12 w-48" /></div>;
  if (!me) return loc.pathname === '/login' ? <LoginPage /> : <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (me.gate === 'MFA_VERIFY') return <MfaVerify />;
  if (me.gate === 'MFA_ENROL') return <MfaEnrol />;
  if (me.gate === 'PASSWORD_CHANGE') return <PasswordChangeGate />;

  const master = (key: keyof typeof MASTERS) => {
    const c = MASTERS[key]!;
    return (
      <Route path={c.base.slice(1)}>
        <Route index element={<Protected perm={`${c.perm}:view`}><MasterListPage c={c} /></Protected>} />
        <Route path="new" element={<Protected perm={`${c.perm}:create`}><MasterFormPage c={c} /></Protected>} />
        <Route path=":id" element={<Protected perm={`${c.perm}:view`}><MasterDetailPage c={c} /></Protected>} />
        <Route path=":id/edit" element={<Protected perm={`${c.perm}:edit_draft`}><MasterFormPage c={c} /></Protected>} />
      </Route>
    );
  };

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="qc/inspections/:id/coa" element={<Protected perm="qc.inspection:view"><CoaPrintPage /></Protected>} />
      <Route path="production/packing/:id/labels" element={<Protected perm="mfg.packing:view"><PackingLabelsPage /></Protected>} />
      <Route path="sales/quotations/:id/print" element={<Protected perm="sales.quotation:view"><QuotationPrintPage /></Protected>} />
      <Route path="stores/returns/:id/print" element={<Protected perm="purchase.return:view"><ReturnPrintPage /></Protected>} />
      <Route path="purchase/orders/:id/print" element={<Protected perm="purchase.order:view"><PurchaseOrderPrintPage /></Protected>} />
      <Route path="finance/invoices/:id/print" element={<Protected perm="sales.invoice:view"><SalesInvoicePrintPage /></Protected>} />
      <Route path="finance/credit-notes/:id/print" element={<Protected perm="sales.credit_note:view"><CreditNotePrintPage /></Protected>} />
      <Route path="logistics/shipments/:id/challan" element={<Protected perm="logistics.shipment:view"><ShipmentChallanPage /></Protected>} />
      <Route path="sales/orders/:id/print" element={<Protected perm="sales.order:view"><SalesOrderPrintPage /></Protected>} />
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/:id" element={<ApprovalDetailPage />} />
        <Route path="sales/leads" element={<Protected perm="crm.lead:view"><LeadsPage /></Protected>} />
        <Route path="sales/leads/:id" element={<Protected perm="crm.lead:view"><LeadDetailPage /></Protected>} />
        <Route path="sales/opportunities" element={<Protected perm="crm.opportunity:view"><PipelinePage /></Protected>} />
        <Route path="sales/opportunities/:id" element={<Protected perm="crm.opportunity:view"><OpportunityDetailPage /></Protected>} />
        <Route path="sales/activities" element={<Protected perm="crm.activity:view"><ActivitiesPage /></Protected>} />
        <Route path="sales/dealers" element={<Protected perm="mdm.dealer:view"><DealersPage /></Protected>} />
        <Route path="sales/dealers/new" element={<Protected perm="mdm.dealer:create"><DealerFormPage /></Protected>} />
        <Route path="sales/dealers/:id" element={<Protected perm="mdm.dealer:view"><DealerDetailPage /></Protected>} />
        <Route path="sales/dealers/:id/edit" element={<Protected perm="mdm.dealer:edit_draft"><DealerFormPage /></Protected>} />
        <Route path="sales/quotations" element={<Protected perm="sales.quotation:view"><QuotationsPage /></Protected>} />
        <Route path="sales/quotations/new" element={<Protected perm="sales.quotation:create"><QuotationFormPage /></Protected>} />
        <Route path="sales/quotations/:id" element={<Protected perm="sales.quotation:view"><QuotationDetailPage /></Protected>} />
        <Route path="sales/quotations/:id/edit" element={<Protected perm="sales.quotation:edit"><QuotationFormPage /></Protected>} />
        <Route path="sales/orders" element={<Protected perm="sales.order:view"><SalesOrdersPage /></Protected>} />
        <Route path="sales/orders/new" element={<Protected perm="sales.order:create"><SalesOrderFormPage /></Protected>} />
        <Route path="sales/orders/:id" element={<Protected perm="sales.order:view"><SalesOrderDetailPage /></Protected>} />
        <Route path="sales/orders/:id/edit" element={<Protected perm="sales.order:edit"><SalesOrderFormPage /></Protected>} />
        <Route path="purchase/vendors" element={<Protected perm="mdm.vendor:view"><VendorsPage /></Protected>} />
        <Route path="purchase/vendors/new" element={<Protected perm="mdm.vendor:create"><VendorFormPage /></Protected>} />
        <Route path="purchase/vendors/:id" element={<Protected perm="mdm.vendor:view"><VendorDetailPage /></Protected>} />
        <Route path="purchase/vendors/:id/edit" element={<Protected perm="mdm.vendor:edit_draft"><VendorFormPage /></Protected>} />
        <Route path="purchase/requisitions" element={<Protected perm="purchase.requisition:view"><RequisitionsPage /></Protected>} />
        <Route path="purchase/requisitions/new" element={<Protected perm="purchase.requisition:create"><RequisitionFormPage /></Protected>} />
        <Route path="purchase/requisitions/:id" element={<Protected perm="purchase.requisition:view"><RequisitionDetailPage /></Protected>} />
        <Route path="purchase/requisitions/:id/edit" element={<Protected perm="purchase.requisition:edit"><RequisitionFormPage /></Protected>} />
        <Route path="purchase/rfqs" element={<Protected perm="purchase.rfq:view"><RfqsPage /></Protected>} />
        <Route path="purchase/rfqs/new" element={<Protected perm="purchase.rfq:manage"><RfqFormPage /></Protected>} />
        <Route path="purchase/rfqs/:id" element={<Protected perm="purchase.rfq:view"><RfqDetailPage /></Protected>} />
        <Route path="purchase/rfqs/:id/edit" element={<Protected perm="purchase.rfq:manage"><RfqFormPage /></Protected>} />
        <Route path="purchase/orders" element={<Protected perm="purchase.order:view"><PurchaseOrdersPage /></Protected>} />
        <Route path="purchase/orders/new" element={<Protected perm="purchase.order:create"><PurchaseOrderFormPage /></Protected>} />
        <Route path="purchase/orders/:id" element={<Protected perm="purchase.order:view"><PurchaseOrderDetailPage /></Protected>} />
        <Route path="purchase/orders/:id/edit" element={<Protected perm="purchase.order:edit"><PurchaseOrderFormPage /></Protected>} />
        <Route path="stores/receipts" element={<Protected perm="purchase.grn:view"><ReceiptsPage /></Protected>} />
        <Route path="stores/receipts/new" element={<Protected perm="purchase.grn:create"><ReceiptFormPage /></Protected>} />
        <Route path="stores/receipts/:id" element={<Protected perm="purchase.grn:view"><ReceiptDetailPage /></Protected>} />
        <Route path="stores/receipts/:id/edit" element={<Protected perm="purchase.grn:create"><ReceiptFormPage /></Protected>} />
        <Route path="stores/returns" element={<Protected perm="purchase.return:view"><ReturnsPage /></Protected>} />
        <Route path="stores/returns/new" element={<Protected perm="purchase.return:create"><ReturnFormPage /></Protected>} />
        <Route path="stores/returns/:id" element={<Protected perm="purchase.return:view"><ReturnDetailPage /></Protected>} />
        <Route path="purchase/invoices" element={<Protected perm="purchase.invoice:view"><InvoicesPage /></Protected>} />
        <Route path="purchase/invoices/new" element={<Protected perm="purchase.invoice:create"><InvoiceFormPage /></Protected>} />
        <Route path="purchase/invoices/:id" element={<Protected perm="purchase.invoice:view"><InvoiceDetailPage /></Protected>} />
        <Route path="stores/stock" element={<Protected perm="inv.stock:view"><StockPage /></Protected>} />
        <Route path="stores/lots/:id" element={<Protected perm="inv.stock:view"><LotDetailPage /></Protected>} />
        <Route path="qc/inspections" element={<Protected perm="qc.inspection:view"><InspectionsPage /></Protected>} />
        <Route path="qc/inspections/:id" element={<Protected perm="qc.inspection:view"><InspectionDetailPage /></Protected>} />
        <Route path="production/formulations" element={<Protected perm="mfg.bom:view"><FormulationsPage /></Protected>} />
        <Route path="production/formulations/:id" element={<Protected perm="mfg.bom:view"><FormulationDetailPage /></Protected>} />
        <Route path="production/formulations/:id/versions/new" element={<Protected perm="mfg.bom:create"><FormulationVersionFormPage /></Protected>} />
        <Route path="production/formulations/:id/versions/:vid" element={<Protected perm="mfg.bom:view"><FormulationVersionPage /></Protected>} />
        <Route path="production/formulations/:id/versions/:vid/edit" element={<Protected perm="mfg.bom:edit"><FormulationVersionFormPage /></Protected>} />
        <Route path="production/formulation-versions/:vid" element={<Protected perm="mfg.bom:view"><FormulationVersionLink /></Protected>} />
        <Route path="production/orders" element={<Protected perm="mfg.order:view"><ProductionOrdersPage /></Protected>} />
        <Route path="production/orders/new" element={<Protected perm="mfg.order:create"><ProductionOrderFormPage /></Protected>} />
        <Route path="production/orders/:id" element={<Protected perm="mfg.order:view"><ProductionOrderDetailPage /></Protected>} />
        <Route path="production/orders/:id/edit" element={<Protected perm="mfg.order:edit"><ProductionOrderFormPage /></Protected>} />
        <Route path="production/overrides/:oid" element={<Protected perm="mfg.order:view"><OverrideLink /></Protected>} />
        <Route path="production/dashboard" element={<Protected perm="mfg.order:view"><ProductionDashboardPage /></Protected>} />
        <Route path="finance/invoices" element={<Protected perm="sales.invoice:view"><SalesInvoicesPage /></Protected>} />
        <Route path="finance/invoices/:id" element={<Protected perm="sales.invoice:view"><SalesInvoiceDetailPage /></Protected>} />
        <Route path="finance/credit-notes" element={<Protected perm="sales.credit_note:view"><CreditNotesPage /></Protected>} />
        <Route path="finance/credit-notes/:id" element={<Protected perm="sales.credit_note:view"><CreditNoteDetailPage /></Protected>} />
        <Route path="logistics/returns" element={<Protected perm="sales.return:view"><CustomerReturnsPage /></Protected>} />
        <Route path="logistics/returns/:id" element={<Protected perm="sales.return:view"><CustomerReturnDetailPage /></Protected>} />
        <Route path="logistics/queue" element={<Protected perm="logistics.shipment:view"><DispatchQueuePage /></Protected>} />
        <Route path="logistics/shipments" element={<Protected perm="logistics.shipment:view"><ShipmentsPage /></Protected>} />
        <Route path="logistics/shipments/:id" element={<Protected perm="logistics.shipment:view"><ShipmentDetailPage /></Protected>} />
        <Route path="logistics/transporters" element={<Protected perm="logistics.shipment:view"><TransportersPage /></Protected>} />
        <Route path="production/packing" element={<Protected perm="mfg.packing:view"><PackingRunsPage /></Protected>} />
        <Route path="production/packing/:id" element={<Protected perm="mfg.packing:view"><PackingRunDetailPage /></Protected>} />
        <Route path="production/downtime" element={<Protected perm="mfg.batch:view"><DowntimePage /></Protected>} />
        <Route path="production/batches" element={<Protected perm="mfg.batch:view"><BatchesPage /></Protected>} />
        <Route path="production/batches/:id" element={<Protected perm="mfg.batch:view"><BatchDetailPage /></Protected>} />
        <Route path="qc/ipqc" element={<Protected perm="qc.ipqc:record"><IpqcWorklistPage /></Protected>} />
        <Route path="qc/master" element={<Protected perm="qc.spec:view"><QcMasterPage /></Protected>} />
        <Route path="qc/specs/:id" element={<Protected perm="qc.spec:view"><SpecDetailPage /></Protected>} />
        <Route path="qc/instruments/:id" element={<Protected perm="qc.instrument:view"><InstrumentDetailPage /></Protected>} />
        <Route path="qc/oos" element={<Protected perm="qc.inspection:view"><OosListPage /></Protected>} />
        <Route path="qc/oos/:id" element={<Protected perm="qc.inspection:view"><OosDetailPage /></Protected>} />
        <Route path="qa/dashboard" element={<Protected perm="qa.capa:view"><QualityDashboardPage /></Protected>} />
        <Route path="qa/documents" element={<Protected perm="qa.document:view"><DocumentsPage /></Protected>} />
        <Route path="qa/documents/:id" element={<Protected perm="qa.document:view"><DocumentDetailPage /></Protected>} />
        <Route path="qa/audits" element={<Protected perm="qa.audit:view"><AuditsPage /></Protected>} />
        <Route path="qa/audits/:id" element={<Protected perm="qa.audit:view"><AuditDetailPage /></Protected>} />
        <Route path="qa/risks" element={<Protected perm="qa.risk:view"><RisksPage /></Protected>} />
        <Route path="qa/line-clearance" element={<Protected perm="qa.clearance:view"><LineClearancePage /></Protected>} />
        <Route path="qa/capas" element={<Protected perm="qa.capa:view"><CapasPage /></Protected>} />
        <Route path="qa/capas/:id" element={<Protected perm="qa.capa:view"><CapaDetailPage /></Protected>} />
        <Route path="qa/ncs" element={<Protected perm="qa.nc:view"><NcsPage /></Protected>} />
        <Route path="qa/ncs/:id" element={<Protected perm="qa.nc:view"><NcDetailPage /></Protected>} />
        <Route path="qa/changes" element={<Protected perm="qa.change:view"><ChangesPage /></Protected>} />
        <Route path="qa/changes/:id" element={<Protected perm="qa.change:view"><ChangeDetailPage /></Protected>} />
        <Route path="qa/complaints" element={<Protected perm="qa.complaint:view"><ComplaintsPage /></Protected>} />
        <Route path="qa/complaints/:id" element={<Protected perm="qa.complaint:view"><ComplaintDetailPage /></Protected>} />
        <Route path="qa/recalls" element={<Protected perm="qa.recall:view"><RecallsPage /></Protected>} />
        <Route path="qa/recalls/:id" element={<Protected perm="qa.recall:view"><RecallDetailPage /></Protected>} />
        <Route path="qa/releases" element={<Protected perm="qa.release:view"><ReleasesPage /></Protected>} />
        <Route path="qa/releases/:id" element={<Protected perm="qa.release:view"><ReleaseReviewPage /></Protected>} />
        <Route path="qa/deviations" element={<Protected perm="qa.deviation:view"><DeviationsPage /></Protected>} />
        <Route path="qa/deviations/:id" element={<Protected perm="qa.deviation:view"><DeviationDetailPage /></Protected>} />
        <Route path="production/settings" element={<Protected perm="mfg.settings:view"><PlantSettingsPage /></Protected>} />
        {master('legalEntities')}
        {master('plants')}
        {master('warehouses')}
        {master('items')}
        {master('priceLists')}
        <Route path="products/categories" element={<Protected perm="mdm.product_category:view"><CategoriesPage /></Protected>} />
        <Route path="products/hsn" element={<Protected perm="mdm.hsn:view"><HsnPage /></Protected>} />
        <Route path="products/uom" element={<Protected perm="mdm.uom:view"><UomPage /></Protected>} />
        <Route path="masters/territories" element={<Protected perm="org.territory:view"><TerritoriesPage /></Protected>} />
        <Route path="masters/departments" element={<Protected perm="org.department:view"><DepartmentsPage /></Protected>} />
        <Route path="masters/employees" element={<Protected perm="org.employee:view"><EmployeesPage /></Protected>} />
        <Route path="masters/employees/new" element={<Protected perm="org.employee:create"><EmployeeFormPage /></Protected>} />
        <Route path="masters/employees/:id" element={<Protected perm="org.employee:view"><EmployeeDetailPage /></Protected>} />
        <Route path="masters/employees/:id/edit" element={<Protected perm="org.employee:edit"><EmployeeFormPage /></Protected>} />
        <Route path="admin/users" element={<Protected perm="iam.user:view"><UsersPage /></Protected>} />
        <Route path="admin/users/:id" element={<Protected perm="iam.user:view"><UserDetailPage /></Protected>} />
        <Route path="admin/roles" element={<Protected perm="iam.role:view"><RolesPage /></Protected>} />
        <Route path="admin/policies" element={<Protected perm="wf.policy:view"><PoliciesPage /></Protected>} />
        <Route path="admin/authority-limits" element={<Protected perm="iam.authority_limit:view"><AuthorityLimitsPage /></Protected>} />
        <Route path="admin/number-series" element={<Protected perm="sys.number_series:view"><NumberSeriesPage /></Protected>} />
        <Route path="admin/settings" element={<Protected perm="sys.settings:view"><SettingsPage /></Protected>} />
        <Route path="admin/audit" element={<Protected perm="sys.audit:view"><AuditPage /></Protected>} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="*" element={<div className="card mt-6"><EmptyState title="Page not found" text="The link may be wrong or the page was moved." /></div>} />
      </Route>
    </Routes>
  );
}
