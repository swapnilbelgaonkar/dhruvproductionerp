import type { PolicyDefinition } from '@dhruv/contracts';
import type { Tx } from '../../db/pool';

/** Permission catalogue for the modules built so far. Codes are `resource:action` (MP §4.5). */
const P = (module: string, resource: string, actions: string[], what: string) =>
  actions.map((action) => ({ code: `${resource}:${action}`, module, resource, action, description: `${action} ${what}` }));

export const PERMISSIONS = [
  ...P('Administration', 'iam.user', ['view', 'create', 'edit', 'deactivate'], 'users'),
  ...P('Administration', 'iam.role', ['view', 'configure'], 'roles and permissions'),
  ...P('Administration', 'iam.user_role', ['grant', 'revoke'], 'role assignments'),
  ...P('Administration', 'iam.session', ['view', 'revoke'], 'other users’ sessions'),
  ...P('Administration', 'iam.authority_limit', ['view', 'configure'], 'sales authority limits'),
  ...P('Administration', 'sys.audit', ['view', 'export', 'verify'], 'the audit log'),
  ...P('Administration', 'sys.settings', ['view', 'configure'], 'system settings'),
  ...P('Administration', 'sys.number_series', ['view', 'configure'], 'document number series'),
  ...P('Administration', 'wf.policy', ['view', 'configure', 'simulate'], 'approval policies'),
  ...P('Administration', 'wf.approval', ['view_all'], 'all approval requests'),
  ...P('Administration', 'sys.dashboard', ['view_admin'], 'the administration dashboard'),
  ...P('Masters', 'org.legal_entity', ['view', 'create', 'edit_draft', 'submit', 'approve', 'deactivate'], 'legal entities'),
  ...P('Masters', 'org.plant', ['view', 'create', 'edit_draft', 'submit', 'approve', 'deactivate'], 'plants'),
  ...P('Masters', 'org.warehouse', ['view', 'create', 'edit_draft', 'submit', 'approve', 'deactivate'], 'warehouses'),
  ...P('Masters', 'org.department', ['view', 'create', 'edit', 'deactivate'], 'departments'),
  ...P('Masters', 'org.territory', ['view', 'create', 'edit', 'deactivate'], 'territories'),
  ...P('Masters', 'org.employee', ['view', 'create', 'edit', 'deactivate'], 'employees'),
  ...P('Product masters', 'mdm.uom', ['view', 'configure'], 'units of measure and conversions'),
  ...P('Product masters', 'mdm.hsn', ['view', 'create', 'edit'], 'HSN/SAC codes'),
  ...P('Product masters', 'mdm.tax_rate', ['configure'], 'effective-dated GST rates'),
  ...P('Product masters', 'mdm.product_category', ['view', 'create', 'edit', 'deactivate'], 'product categories'),
  ...P('Product masters', 'mdm.item', ['view', 'create', 'edit_draft', 'submit', 'approve', 'deactivate'], 'items and pack sizes'),
  ...P('Sales', 'crm.lead', ['view', 'create', 'edit', 'assign'], 'leads'),
  ...P('Sales', 'crm.opportunity', ['view', 'create', 'edit', 'reopen'], 'opportunities'),
  ...P('Sales', 'crm.activity', ['view', 'create'], 'sales activities'),
  ...P('Sales', 'mdm.dealer', ['view', 'create', 'edit_draft', 'submit', 'verify_documents', 'view_sensitive', 'suspend'], 'dealers and their KYC'),
  ...P('Sales', 'sales.price_list', ['view', 'create', 'edit_draft', 'submit', 'approve', 'deactivate'], 'price lists and volume slabs'),
  ...P('Sales', 'sales.quotation', ['view', 'create', 'edit', 'submit', 'send', 'cancel'], 'quotations'),
  ...P('Sales', 'sales.order', ['view', 'create', 'edit', 'submit', 'cancel'], 'sales orders'),
  ...P('Purchase', 'mdm.vendor', ['view', 'create', 'edit_draft', 'submit', 'verify_documents', 'verify_bank', 'view_sensitive', 'suspend'], 'vendors, their KYC and bank accounts'),
  ...P('Purchase', 'purchase.requisition', ['view', 'view_all', 'create', 'edit', 'submit', 'cancel'], 'purchase requisitions'),
  ...P('Purchase', 'purchase.rfq', ['view', 'manage'], 'requests for quotation, vendor quotes and awards'),
  ...P('Purchase', 'purchase.order', ['view', 'create', 'edit', 'submit', 'issue', 'cancel'], 'purchase orders'),
  ...P('Stores', 'purchase.grn', ['view', 'create', 'post', 'cancel'], 'goods receipts'),
  ...P('Stores', 'inv.stock', ['view'], 'stock balances, lots and the stock ledger'),
  ...P('Stores', 'purchase.return', ['view', 'create', 'post'], 'supplier returns and their debit notes'),
  ...P('Purchase', 'purchase.invoice', ['view', 'create', 'submit', 'cancel'], 'supplier invoices and the three-way match'),
  ...P('Quality', 'qc.inspection', ['view', 'record', 'decide'], 'QC inspection of received lots (record = sample and test; decide = release, reject or hold)'),
  ...P('Production', 'mfg.settings', ['view', 'configure'], 'plant lines, machine parameters and shifts'),
  ...P('Production', 'mfg.bom', ['view', 'create', 'edit', 'submit'], 'formulations (BOM) and their versions'),
  ...P('Production', 'mfg.order', ['view', 'create', 'edit', 'submit', 'release', 'cancel'], 'production orders (release = fix the formulation and reserve material; also hold and resume)'),
  ...P('Stores', 'mfg.issue', ['post'], 'issue of reserved material to production and its return'),
  ...P('Production', 'mfg.override', ['request'], 'requests to use a quarantined lot (approved by the QC head and the plant head)'),
  ...P('Quality', 'qa.deviation', ['view', 'close'], 'deviations'),
  ...P('Production', 'mfg.batch', ['view', 'execute', 'scrap'], 'batches (execute = start, dose, record readings, ask for IPQC, complete, hold)'),
  ...P('Quality', 'qc.ipqc', ['record'], 'in-process QC results'),
  ...P('Production', 'mfg.packing', ['view', 'post'], 'packing runs, box serials and QR labels'),
  ...P('Quality', 'qc.spec', ['view', 'manage'], 'test methods and item specifications'),
  ...P('Quality', 'qc.instrument', ['view', 'manage'], 'laboratory instruments and their calibration'),
  ...P('Quality', 'qa.capa', ['view', 'manage', 'verify'], 'corrective and preventive actions (verify = effectiveness check)'),
  ...P('Quality', 'qa.nc', ['view', 'create', 'manage'], 'non-conformances'),
  ...P('Quality', 'qa.change', ['view', 'create', 'manage'], 'change control'),
  ...P('Quality', 'qa.complaint', ['view', 'create', 'manage'], 'customer complaints'),
  ...P('Quality', 'qa.recall', ['view', 'drill', 'actual'], 'recalls (drill = mock recall; actual = trace and lock stock)'),
  ...P('Quality', 'qa.document', ['view', 'manage'], 'controlled documents (SOPs, STPs, policies) and their versions'),
  ...P('Quality', 'qa.training', ['record'], 'training records'),
  ...P('Quality', 'qa.audit', ['view', 'manage'], 'internal, supplier and customer audits'),
  ...P('Quality', 'qa.risk', ['view', 'manage'], 'the quality risk register'),
  ...P('Quality', 'qa.clearance', ['view', 'record'], 'line clearance before a batch or packing run'),
  ...P('Quality', 'qa.release', ['view', 'decide'], 'QA batch review and the disposition of finished goods (release, hold, reject, rework)'),
  ...P('Logistics', 'logistics.shipment', ['view', 'create', 'pick', 'dispatch', 'pod'], 'shipments (plan, pick by box scan, load and dispatch, proof of delivery)'),
  ...P('Logistics', 'logistics.transporter', ['manage'], 'the transporter master'),
];

const ALL = PERMISSIONS.map((p) => p.code);
const VIEW = ALL.filter((c) => c.endsWith(':view'));
// dealer data is sales-owned and territory-scoped, so it is granted explicitly below rather than with the general master views
// dealer and vendor data are owned by sales and purchase, so they are granted explicitly below rather than with the general master views
const PARTY = (c: string) => c.startsWith('mdm.dealer') || c.startsWith('mdm.vendor');
const ORG_VIEW = VIEW.filter((c) => (c.startsWith('org.') || c.startsWith('mdm.')) && !PARTY(c));
const MASTER = (c: string) => (c.startsWith('org.') || c.startsWith('mdm.')) && !PARTY(c);
/** Anyone who needs material can raise a requisition; purchase, stores heads and finance see all of them. */
const PR_RAISE = ['purchase.requisition:view', 'purchase.requisition:create', 'purchase.requisition:edit', 'purchase.requisition:submit'];
const VENDOR_BUY = ['mdm.vendor:view', 'mdm.vendor:create', 'mdm.vendor:edit_draft', 'mdm.vendor:submit'];
const BUYING = ['purchase.rfq:view', 'purchase.rfq:manage', 'purchase.order:view', 'purchase.order:create', 'purchase.order:edit', 'purchase.order:submit',
  'purchase.order:issue', 'purchase.order:cancel'];
const RECEIVE = ['purchase.grn:view', 'purchase.grn:create', 'purchase.grn:post', 'purchase.grn:cancel', 'inv.stock:view', 'qc.inspection:view', 'purchase.return:view', 'purchase.return:create'];
const INVOICING = ['purchase.invoice:view', 'purchase.invoice:create', 'purchase.invoice:submit', 'purchase.invoice:cancel'];
const QC_TEST = ['qc.inspection:view', 'qc.inspection:record', 'inv.stock:view', 'purchase.grn:view', 'mdm.vendor:view', 'qc.spec:view', 'qc.instrument:view'];
const PURCHASE_EXTRA: Record<string, string[]> = {
  PURCHASE_EXEC: [...VENDOR_BUY, ...PR_RAISE, 'purchase.requisition:view_all', 'purchase.requisition:cancel', ...BUYING, 'purchase.grn:view', 'inv.stock:view', 'qc.inspection:view', 'purchase.return:view', 'purchase.return:create', 'purchase.return:post', ...INVOICING],
  PURCHASE_HEAD: [...VENDOR_BUY, 'mdm.vendor:suspend', ...PR_RAISE, 'purchase.requisition:view_all', 'purchase.requisition:cancel', ...BUYING, 'purchase.grn:view', 'inv.stock:view', 'qc.inspection:view',
    'purchase.return:view', 'purchase.return:create', 'purchase.return:post', ...INVOICING],
  DOC_VERIFIER: ['mdm.vendor:view', 'mdm.vendor:verify_documents', 'mdm.vendor:view_sensitive'],
  FINANCE_HEAD: ['mdm.vendor:view', 'mdm.vendor:verify_bank', 'mdm.vendor:view_sensitive', 'purchase.requisition:view', 'purchase.requisition:view_all', 'purchase.rfq:view', 'purchase.order:view', 'purchase.grn:view', 'inv.stock:view', 'purchase.return:view', 'purchase.invoice:view'],
  ACCOUNTS_EXEC: ['mdm.vendor:view', 'mdm.vendor:verify_bank', 'mdm.vendor:view_sensitive', 'purchase.order:view', 'purchase.grn:view', 'inv.stock:view', 'purchase.return:view', ...INVOICING],
  STORES_HEAD: ['mdm.vendor:view', ...PR_RAISE, 'purchase.requisition:view_all', 'purchase.requisition:cancel', 'purchase.order:view', ...RECEIVE],
  STOREKEEPER: ['mdm.vendor:view', ...PR_RAISE, 'purchase.order:view', ...RECEIVE],
  PRODUCTION_PLANNER: [...PR_RAISE, 'inv.stock:view'], PRODUCTION_SUPERVISOR: [...PR_RAISE, 'inv.stock:view'], PLANT_HEAD: [...PR_RAISE, 'inv.stock:view', 'qc.inspection:view'],
  QC_ANALYST: [...PR_RAISE, ...QC_TEST], QC_MANAGER: [...PR_RAISE, ...QC_TEST, 'qc.inspection:decide', 'qc.spec:manage', 'qc.instrument:manage'], QC_HEAD: [...PR_RAISE, ...QC_TEST, 'qc.inspection:decide', 'qc.spec:manage', 'qc.instrument:manage'],
  QA_EXECUTIVE: [...PR_RAISE, 'qc.inspection:view'], QA_MANAGER: ['mdm.vendor:view', ...PR_RAISE, 'qc.inspection:view', 'inv.stock:view'], QA_HEAD: ['mdm.vendor:view', ...PR_RAISE, 'qc.inspection:view', 'inv.stock:view'],
  LOGISTICS_EXEC: [...PR_RAISE], LOGISTICS_HEAD: [...PR_RAISE],
  MANAGEMENT_VIEWER: ['mdm.vendor:view', 'purchase.requisition:view', 'purchase.requisition:view_all', 'purchase.rfq:view', 'purchase.order:view', 'purchase.grn:view', 'inv.stock:view', 'qc.inspection:view', 'purchase.return:view', 'purchase.invoice:view'],
};
/** Production (Stage 4). Formulations are drafted by planning; the plant head and QA approve them through the approval policy. */
const BOM_AUTHOR = ['mfg.settings:view', 'mfg.bom:view', 'mfg.bom:create', 'mfg.bom:edit', 'mfg.bom:submit'];
const ORDER_PLAN = ['mfg.order:view', 'mfg.order:create', 'mfg.order:edit', 'mfg.order:submit', 'mfg.order:release', 'mfg.order:cancel', 'mfg.override:request', 'qa.deviation:view', 'inv.stock:view'];
const PROD_VIEW = ['mfg.order:view', 'qa.deviation:view', 'mfg.batch:view', 'qa.release:view', 'mfg.packing:view'];
/** QA core (Stage 5 part 2): QA runs the registers; plant, QC, stores and purchase can raise non-conformances and change requests. */
const QA_SEE = ['qa.capa:view', 'qa.nc:view', 'qa.change:view', 'qa.complaint:view', 'qa.recall:view', 'qa.document:view', 'qa.audit:view', 'qa.risk:view', 'qa.clearance:view'];
const QA_RAISE = [...QA_SEE, 'qa.nc:create', 'qa.change:create'];
const QA_EXEC = [...QA_RAISE, 'qa.capa:manage', 'qa.nc:manage', 'qa.complaint:create', 'qa.complaint:manage', 'qa.training:record', 'qa.clearance:record'];
const QA_MGR = [...QA_EXEC, 'qa.capa:verify', 'qa.change:manage', 'qa.recall:drill', 'qa.document:manage', 'qa.audit:manage', 'qa.risk:manage'];
const PRODUCTION_EXTRA: Record<string, string[]> = {
  PRODUCTION_PLANNER: [...BOM_AUTHOR, ...ORDER_PLAN, 'mfg.batch:view', 'mfg.packing:view', ...QA_RAISE],
  PRODUCTION_SUPERVISOR: ['mfg.settings:view', 'mfg.bom:view', ...PROD_VIEW, 'mfg.override:request', 'inv.stock:view', 'mfg.batch:execute', 'mfg.packing:post', ...QA_RAISE],
  PLANT_HEAD: [...BOM_AUTHOR, 'mfg.settings:configure', ...ORDER_PLAN, 'mfg.batch:view', 'mfg.batch:execute', 'mfg.batch:scrap', 'mfg.packing:view', 'mfg.packing:post', ...QA_RAISE],
  QA_EXECUTIVE: ['mfg.settings:view', 'mfg.bom:view', ...PROD_VIEW, ...QA_EXEC],
  QA_MANAGER: ['mfg.settings:view', 'mfg.bom:view', ...PROD_VIEW, 'qa.deviation:close', 'inv.stock:view', 'qc.spec:view', 'qc.instrument:view', ...QA_MGR],
  QA_HEAD: ['mfg.settings:view', 'mfg.bom:view', ...PROD_VIEW, 'qa.deviation:close', 'qa.release:decide', 'inv.stock:view', 'qc.spec:view', 'qc.instrument:view', ...QA_MGR, 'qa.recall:actual'],
  QC_ANALYST: ['mfg.bom:view', ...PROD_VIEW, 'qc.ipqc:record', ...QA_RAISE], QC_MANAGER: ['mfg.bom:view', ...PROD_VIEW, 'qc.ipqc:record', ...QA_RAISE], QC_HEAD: ['mfg.bom:view', ...PROD_VIEW, 'qc.ipqc:record', ...QA_RAISE],
  STOREKEEPER: ['mfg.order:view', 'mfg.issue:post', 'mfg.batch:view', 'mfg.packing:view', ...QA_RAISE], STORES_HEAD: ['mfg.bom:view', 'mfg.order:view', 'mfg.issue:post', 'mfg.batch:view', 'mfg.packing:view'],
  PURCHASE_HEAD: ['mfg.bom:view', 'mfg.order:view', ...QA_RAISE], FINANCE_HEAD: ['mfg.bom:view', ...PROD_VIEW],
  MANAGEMENT_VIEWER: ['mfg.settings:view', 'mfg.bom:view', ...PROD_VIEW, ...QA_SEE],
};
/** Logistics (Stage 6 part 1): logistics plans and dispatches; stores picks by scanning boxes; sales and finance see shipments. */
const SHIP_RUN = ['logistics.shipment:view', 'logistics.shipment:create', 'logistics.shipment:dispatch', 'logistics.shipment:pod', 'sales.order:view', 'inv.stock:view', 'mfg.packing:view'];
const LOGISTICS_EXTRA: Record<string, string[]> = {
  LOGISTICS_EXEC: SHIP_RUN, LOGISTICS_HEAD: [...SHIP_RUN, 'logistics.transporter:manage'],
  STOREKEEPER: ['logistics.shipment:view', 'logistics.shipment:pick'], STORES_HEAD: ['logistics.shipment:view', 'logistics.shipment:pick'], SCANNER_OPERATOR: ['logistics.shipment:view', 'logistics.shipment:pick', 'mfg.packing:view'],
  SALES_OPS: ['logistics.shipment:view'], ACCOUNTS_EXEC: ['logistics.shipment:view'], FINANCE_HEAD: ['logistics.shipment:view'], CREDIT_CONTROLLER: ['logistics.shipment:view'],
  MANAGEMENT_VIEWER: ['logistics.shipment:view'], QA_HEAD: ['logistics.shipment:view'], QA_MANAGER: ['logistics.shipment:view'],
};
const CRM_BASE = ['crm.lead:view', 'crm.lead:create', 'crm.lead:edit', 'crm.opportunity:view', 'crm.opportunity:create', 'crm.opportunity:edit', 'crm.activity:view', 'crm.activity:create'];
const QUOTE_SALES = ['sales.price_list:view', 'sales.quotation:view', 'sales.quotation:create', 'sales.quotation:edit', 'sales.quotation:submit',
  'sales.quotation:send', 'sales.quotation:cancel',
  'sales.order:view', 'sales.order:create', 'sales.order:edit', 'sales.order:submit', 'sales.order:cancel'];
const PRICE_MANAGE = ['sales.price_list:view', 'sales.price_list:create', 'sales.price_list:edit_draft', 'sales.price_list:submit', 'sales.price_list:deactivate'];
const DEALER_SALES = ['mdm.dealer:view', 'mdm.dealer:create', 'mdm.dealer:edit_draft', 'mdm.dealer:submit', ...CRM_BASE, ...QUOTE_SALES, 'qa.complaint:view', 'qa.complaint:create'];
/** BRD p.3: lead allocation from ASM upward; reopening closed opportunities from RSM upward. */
const tierCrm = (t: string) => [...(['BH', 'NSM', 'DSM', 'ZSM', 'RSM', 'SASM', 'ASM'].includes(t) ? ['crm.lead:assign'] : []),
  ...(['BH', 'NSM', 'DSM', 'ZSM', 'RSM'].includes(t) ? ['crm.opportunity:reopen'] : []),
  ...(['BH', 'NSM'].includes(t) ? PRICE_MANAGE : [])];
const DEALER_EXTRA: Record<string, string[]> = {
  SALES_OPS: [...DEALER_SALES, 'crm.lead:assign', ...PRICE_MANAGE],
  DOC_VERIFIER: ['mdm.dealer:view', 'mdm.dealer:verify_documents', 'mdm.dealer:view_sensitive'],
  CREDIT_CONTROLLER: ['mdm.dealer:view', 'mdm.dealer:view_sensitive', 'mdm.dealer:suspend', 'sales.quotation:view', 'sales.order:view'],
  FINANCE_HEAD: ['mdm.dealer:view', 'mdm.dealer:view_sensitive', 'mdm.dealer:suspend', 'mdm.tax_rate:configure', 'mdm.hsn:create', 'mdm.hsn:edit',
    'sales.price_list:view', 'sales.quotation:view', 'sales.order:view'],
  ACCOUNTS_EXEC: ['mdm.dealer:view', 'sales.price_list:view', 'sales.quotation:view', 'sales.order:view'],
  MANAGEMENT_VIEWER: ['mdm.dealer:view', 'crm.lead:view', 'crm.opportunity:view', 'crm.activity:view', 'sales.price_list:view', 'sales.quotation:view', 'sales.order:view'],
};

interface RoleDef { code: string; name: string; department: string; description: string; privileged?: boolean; requiresMfa?: boolean; permissions: string[] }

export const ROLES: RoleDef[] = [
  // Controlled administrative model (doc 07 §2; D14 provisional)
  { code: 'SUPER_ADMIN', name: 'Super Administrator', department: 'IT', privileged: true, requiresMfa: true,
    description: 'Platform settings and break-glass custodian (BRD Admin 04). Cannot bypass business approvals.', permissions: ALL },
  { code: 'EXEC_ADMIN', name: 'Executive Administrator', department: 'Executive', privileged: true, requiresMfa: true,
    description: 'Approves policies, authority limits and privileged role grants (BRD Admins 01/02).',
    permissions: [...VIEW, 'iam.authority_limit:configure', 'sys.settings:configure', 'sys.number_series:configure', 'wf.policy:configure',
      'wf.policy:simulate', 'wf.approval:view_all', 'sys.dashboard:view_admin', 'sys.audit:verify', 'mdm.dealer:suspend', 'mdm.dealer:view_sensitive'] },
  { code: 'SECURITY_ADMIN', name: 'Security Administrator', department: 'IT', privileged: true, requiresMfa: true,
    description: 'Users, roles, sessions and audit forensics (BRD Admin 03). Role grants of privileged roles need executive approval.',
    permissions: ['iam.user:view', 'iam.user:create', 'iam.user:edit', 'iam.user:deactivate', 'iam.role:view', 'iam.role:configure',
      'iam.user_role:grant', 'iam.user_role:revoke', 'iam.session:view', 'iam.session:revoke', 'sys.audit:view', 'sys.audit:export',
      'sys.audit:verify', 'sys.dashboard:view_admin', ...ORG_VIEW] },
  { code: 'MASTER_DATA_OWNER', name: 'Master Data Owner', department: 'Administration',
    description: 'Creates and maintains organisation masters; submits them for approval.',
    permissions: [...ORG_VIEW, ...ALL.filter((c) => MASTER(c) && /:(create|edit|edit_draft|submit|deactivate)$/.test(c)), 'mdm.uom:configure'] },
  { code: 'MASTER_DATA_APPROVER', name: 'Master Data Approver', department: 'Administration',
    description: 'Approves organisation masters before activation (maker-checker).',
    permissions: [...ORG_VIEW, ...ALL.filter((c) => MASTER(c) && c.endsWith(':approve'))] },
  { code: 'AUDITOR', name: 'Auditor (read-only)', department: 'Administration', description: 'Read-only access including the audit log.',
    permissions: [...VIEW, 'sys.audit:export', 'sys.audit:verify', 'wf.approval:view_all'] },
  // Business roles (doc 07 §3). Module permissions are added as each module is built.
  ...(['BH', 'NSM', 'DSM', 'ZSM', 'RSM', 'SASM', 'ASM', 'TSM', 'SE'] as const).map((t) => ({
    code: `SALES_${t}`, name: `Sales — ${t}`, department: 'Sales', description: `Sales hierarchy tier ${t}`, permissions: [...ORG_VIEW, ...DEALER_SALES, ...tierCrm(t), 'logistics.shipment:view'] })),
  ...[
    ['MANAGEMENT_VIEWER', 'Management Viewer', 'Executive'], ['SALES_OPS', 'Sales Operations', 'Sales'], ['DOC_VERIFIER', 'Document Verifier', 'Compliance'],
    ['ACCOUNTS_EXEC', 'Accounts Executive', 'Finance'], ['CREDIT_CONTROLLER', 'Credit Controller', 'Finance'], ['FINANCE_HEAD', 'Finance Head', 'Finance'],
    ['PURCHASE_EXEC', 'Purchase Executive', 'Purchase'], ['PURCHASE_HEAD', 'Purchase Head', 'Purchase'],
    ['STOREKEEPER', 'Storekeeper', 'Stores'], ['STORES_HEAD', 'Stores Head', 'Stores'], ['SCANNER_OPERATOR', 'Scanner Operator', 'Stores'],
    ['PRODUCTION_PLANNER', 'Production Planner', 'Plant'], ['PRODUCTION_SUPERVISOR', 'Production Supervisor', 'Plant'], ['PLANT_HEAD', 'Plant Head', 'Plant'],
    ['QC_ANALYST', 'QC Analyst', 'QC'], ['QC_MANAGER', 'QC Manager', 'QC'], ['QC_HEAD', 'QC Head', 'QC'],
    ['QA_EXECUTIVE', 'QA Executive', 'QA'], ['QA_MANAGER', 'QA Manager', 'QA'], ['QA_HEAD', 'QA Head', 'QA'],
    ['LOGISTICS_EXEC', 'Logistics Executive', 'Logistics'], ['LOGISTICS_HEAD', 'Logistics Head', 'Logistics'],
  ].map(([code, name, department]) => ({ code: code!, name: name!, department: department!, description: name!,
    permissions: [...ORG_VIEW, ...(DEALER_EXTRA[code!] ?? []), ...(PURCHASE_EXTRA[code!] ?? []), ...(PRODUCTION_EXTRA[code!] ?? []), ...(LOGISTICS_EXTRA[code!] ?? [])] })),
];

const masterActivation = (label: string): PolicyDefinition => ({
  distinctApprovers: true,
  rules: [{ name: 'Default', steps: [{ kind: 'role', label, roles: ['MASTER_DATA_APPROVER'] }] }],
});

export const DEFAULT_POLICIES: { docType: string; name: string; description: string; definition: PolicyDefinition }[] = [
  { docType: 'org.legal_entity', name: 'Legal entity activation', description: 'Maker-checker before a legal entity becomes active', definition: masterActivation('Master data approval') },
  { docType: 'org.plant', name: 'Plant activation', description: 'Maker-checker before a plant becomes active', definition: masterActivation('Master data approval') },
  { docType: 'org.warehouse', name: 'Warehouse activation', description: 'Maker-checker before a warehouse becomes active', definition: masterActivation('Master data approval') },
  { docType: 'mdm.dealer', name: 'Dealer onboarding', description: 'BRD §3.1 / MP §6.2: document verification, commercial review, finance review, final approval',
    definition: (() => {
      const base = [
        { kind: 'role' as const, key: 'doc_verification', label: 'Document verification', roles: ['DOC_VERIFIER'] },
        { kind: 'reporting_manager' as const, key: 'commercial', label: 'Commercial review (sales manager)' },
        { kind: 'role' as const, key: 'finance', label: 'Finance & credit review', roles: ['CREDIT_CONTROLLER', 'FINANCE_HEAD'] },
      ];
      return { distinctApprovers: true, rules: [
        { name: 'Credit limit above ₹10 lakh', when: { fact: 'creditLimit', op: 'gt' as const, value: 1000000 },
          steps: [...base, { kind: 'role' as const, key: 'final', label: 'Director approval (high credit limit)', roles: ['EXEC_ADMIN'] }] },
        { name: 'Standard', steps: [...base, { kind: 'role' as const, key: 'final', label: 'Final sales approval', roles: ['SALES_RSM', 'SALES_ZSM', 'SALES_DSM', 'SALES_NSM', 'SALES_BH'] }] },
      ] };
    })() },
  { docType: 'mdm.item', name: 'Item activation', description: 'Maker-checker before a product or material can be used in transactions', definition: masterActivation('Master data approval') },
  { docType: 'iam.role_grant', name: 'Privileged role grant', description: 'A privileged role takes effect only after an executive approves it (SEC-018)',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [{ kind: 'role', label: 'Executive approval', roles: ['EXEC_ADMIN', 'SUPER_ADMIN'] }] }] } },
  { docType: 'mdm.vendor', name: 'Vendor onboarding', description: 'BRD §3.2: document verification, purchase head approval, finance bank verification',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'doc_verification', label: 'Document verification', roles: ['DOC_VERIFIER'] },
      { kind: 'role', key: 'purchase', label: 'Purchase head approval', roles: ['PURCHASE_HEAD'] },
      { kind: 'role', key: 'finance', label: 'Finance — bank account verification', roles: ['FINANCE_HEAD', 'ACCOUNTS_EXEC'] },
    ] }] } },
  // Doc 07 §6: the department head approves; an emergency goes straight to the purchase head (D06 default, retrospective finance review on the PO)
  { docType: 'purchase.requisition', name: 'Purchase requisition approval', description: 'Department head (reporting manager); emergencies to the purchase head',
    definition: { distinctApprovers: true, rules: [
      { name: 'Emergency', when: { fact: 'priority', op: 'eq', value: 'EMERGENCY' }, steps: [{ kind: 'role', label: 'Emergency approval (purchase head)', roles: ['PURCHASE_HEAD'] }] },
      { name: 'Default', steps: [{ kind: 'reporting_manager', label: 'Department head approval' }] },
    ] } },
  // Doc 07 §6 / D06 defaults (client may change the bands in Approval Policies): < ₹1 L purchase head; ₹1–10 L + finance head;
  // > ₹10 L + executive director (BRD p.3, Admin 02). Emergency: purchase head now, finance head reviews afterwards (notified).
  { docType: 'purchase.order', name: 'Purchase order approval (D06 value bands)', description: 'Purchase head; finance head from ₹1 lakh; executive director above ₹10 lakh',
    definition: (() => {
      const ph = { kind: 'role' as const, key: 'purchase', label: 'Purchase head approval', roles: ['PURCHASE_HEAD'] };
      const fh = { kind: 'role' as const, key: 'finance', label: 'Finance head approval', roles: ['FINANCE_HEAD'] };
      return { distinctApprovers: true, rules: [
        { name: 'Emergency', when: { fact: 'emergency', op: 'eq' as const, value: true }, steps: [{ ...ph, label: 'Emergency approval (purchase head)' }] },
        { name: 'Above ₹10 lakh', when: { fact: 'amount', op: 'gt' as const, value: 1000000 },
          steps: [ph, fh, { kind: 'role' as const, key: 'executive', label: 'Executive director approval (above ₹10 lakh)', roles: ['EXEC_ADMIN'] }] },
        { name: '₹1–10 lakh', when: { fact: 'amount', op: 'gt' as const, value: 100000 }, steps: [ph, fh] },
        { name: 'Up to ₹1 lakh', steps: [ph] },
      ] };
    })() },
  // Doc 07 §6: a three-way match exception — purchase justifies, then the purchase head and the finance head decide
  { docType: 'purchase.supplier_invoice', name: 'Invoice match exception', description: 'Supplier invoice outside the match tolerances: purchase head, then finance head',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'purchase', label: 'Purchase head review', roles: ['PURCHASE_HEAD'] },
      { kind: 'role', key: 'finance', label: 'Finance head approval', roles: ['FINANCE_HEAD'] },
    ] }] } },
  // Doc 07 §6: a formulation version is approved by the plant head, then QA (escalation to the QA head)
  { docType: 'mfg.bom_version', name: 'Formulation (BOM) version approval', description: 'Plant head, then QA manager or QA head, before a version can take effect',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'plant', label: 'Plant head approval', roles: ['PLANT_HEAD'] },
      { kind: 'role', key: 'qa', label: 'QA approval', roles: ['QA_MANAGER', 'QA_HEAD'] },
    ] }] } },
  // Doc 07 §6: the plant head approves a production order before it can be released
  { docType: 'mfg.production_order', name: 'Production order approval', description: 'The plant head approves a production order before release',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [{ kind: 'role', key: 'plant', label: 'Plant head approval', roles: ['PLANT_HEAD'] }] }] } },
  // BRD p.15 / D33 (provisional "allow with safeguards"): QC head and plant manager both approve; a deviation is raised and QA notified on approval
  { docType: 'mfg.quarantine_override', name: 'Quarantine-lock override (D33)', description: 'Use of a lot before QC release: QC head and plant head, with an automatic deviation',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'qc', label: 'QC head approval', roles: ['QC_HEAD'] },
      { kind: 'role', key: 'plant', label: 'Plant head approval', roles: ['PLANT_HEAD'] },
    ] }] } },
  // TC-11: a dose beyond the ingredient's tolerance continues only after the supervisor level and QA approve its deviation
  { docType: 'mfg.dosing_deviation', name: 'Dosing outside tolerance (TC-11)', description: 'Plant head or another supervisor, then QA, before the batch continues',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'plant', label: 'Production approval (plant head or supervisor)', roles: ['PLANT_HEAD', 'PRODUCTION_SUPERVISOR'] },
      { kind: 'role', key: 'qa', label: 'QA approval', roles: ['QA_MANAGER', 'QA_HEAD'] },
    ] }] } },
  // QA-013 / doc 07: a specification version is approved by QC (manager or head), then QA
  { docType: 'qc.spec_version', name: 'Specification version approval', description: 'QC manager or head, then QA, before a specification takes effect',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'qc', label: 'QC approval', roles: ['QC_MANAGER', 'QC_HEAD'] },
      { kind: 'role', key: 'qa', label: 'QA approval', roles: ['QA_MANAGER', 'QA_HEAD'] },
    ] }] } },
  // QA-009: change control — the QA head approves; a high-risk change also needs the executive director
  { docType: 'qa.change_request', name: 'Change control', description: 'QA head; high-risk changes also the executive director',
    definition: { distinctApprovers: true, rules: [
      { name: 'High risk', when: { fact: 'risk', op: 'eq', value: 'HIGH' }, steps: [
        { kind: 'role', key: 'qa', label: 'QA head approval', roles: ['QA_HEAD'] }, { kind: 'role', key: 'exec', label: 'Executive director approval (high risk)', roles: ['EXEC_ADMIN'] }] },
      { name: 'Default', steps: [{ kind: 'role', key: 'qa', label: 'QA head approval', roles: ['QA_HEAD'] }] },
    ] } },
  // QA-006: a controlled document version is approved by a QA manager, then the QA head
  { docType: 'qa.document_version', name: 'Controlled document approval', description: 'QA manager, then QA head, before a document version becomes effective',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'review', label: 'QA review', roles: ['QA_EXECUTIVE', 'QA_MANAGER'] },
      { kind: 'role', key: 'approve', label: 'QA head approval', roles: ['QA_HEAD'] },
    ] }] } },
  { docType: 'sales.price_list', name: 'Price list approval', description: 'A price list takes effect only after the sales head and the finance head approve it',
    definition: { distinctApprovers: true, rules: [{ name: 'Default', steps: [
      { kind: 'role', key: 'sales', label: 'Sales head approval', roles: ['SALES_BH', 'SALES_NSM'] },
      { kind: 'role', key: 'finance', label: 'Finance approval', roles: ['FINANCE_HEAD'] },
    ] }] } },
  // Quotation discount approval (QUO-005, D01 hybrid). List price and slab schemes need no approval; an extra discount does.
  // Until D15 activates the tier limits, the initiator's reporting manager approves; afterwards the authority ladder decides.
  { docType: 'sales.quotation', name: 'Quotation discount approval', description: 'Extra discount beyond the initiator’s own authority needs approval',
    definition: { distinctApprovers: true, rules: [
      { name: 'No extra discount', when: { fact: 'maxDiscountPct', op: 'lte', value: 0 }, steps: [] },
      { name: 'Within own authority', when: { fact: 'withinOwnAuthority', op: 'eq', value: true }, steps: [] },
      { name: 'Authority ladder', when: { fact: 'limitsActive', op: 'eq', value: true }, steps: [
        { kind: 'authority_ladder', label: 'Discount approval', amountFact: 'ladderAmount', discountFact: 'maxDiscountPct', notifySkipped: true, whenLimitsInactive: 'block' }] },
      { name: 'Reporting manager (limits pending D15)', steps: [{ kind: 'reporting_manager', label: 'Discount approval (reporting manager)' }] },
    ] } },
  // D01 approved: hybrid routing — the lowest tier in the initiator's chain covering the order value and the highest extra discount,
  // skipped tiers notified, then accounts review. While D15 keeps tier limits inactive, the reporting manager approves instead.
  // An order taking the dealer over the credit limit also needs the finance head (credit override).
  { docType: 'sales.order', name: 'Sales order approval (D01 hybrid)', description: 'Lowest covering tier in the initiator’s chain, skipped tiers notified, then Accounts review',
    definition: (() => {
      const base = [
        { kind: 'authority_ladder' as const, key: 'commercial', label: 'Commercial approval', amountFact: 'amount', discountFact: 'maxDiscountPct', notifySkipped: true, whenLimitsInactive: 'reporting_manager' as const },
        { kind: 'role' as const, key: 'accounts', label: 'Accounts review (credit & stock)', roles: ['ACCOUNTS_EXEC', 'CREDIT_CONTROLLER', 'FINANCE_HEAD'] },
      ];
      return { distinctApprovers: true, rules: [
        { name: 'Over credit limit', when: { fact: 'overCreditLimit', op: 'eq' as const, value: true },
          steps: [...base, { kind: 'role' as const, key: 'credit_override', label: 'Credit limit override (finance head)', roles: ['FINANCE_HEAD'] }] },
        { name: 'Hybrid routing', steps: base },
      ] };
    })() },
];

/** Idempotent: brings permissions, system roles and first policy versions in line with the code. */
export async function syncCatalog(tx: Tx): Promise<void> {
  for (const p of PERMISSIONS) {
    await tx.query(
      `insert into iam.permissions (code, module, resource, action, description) values ($1,$2,$3,$4,$5)
       on conflict (code) do update set module = excluded.module, description = excluded.description`,
      [p.code, p.module, p.resource, p.action, p.description]);
  }
  for (const r of ROLES) {
    const res = await tx.query<{ id: string }>(
      `insert into iam.roles (code, name, description, department, privileged, requires_mfa, is_system) values ($1,$2,$3,$4,$5,$6,true)
       on conflict (code) do update set name = excluded.name, description = excluded.description, department = excluded.department,
         privileged = excluded.privileged, requires_mfa = excluded.requires_mfa
       returning id`,
      [r.code, r.name, r.description, r.department, !!r.privileged, !!r.requiresMfa]);
    const roleId = res.rows[0]!.id;
    await tx.query(`delete from iam.role_permissions where role_id = $1`, [roleId]);
    await tx.query(
      `insert into iam.role_permissions (role_id, permission_code) select $1, unnest($2::text[])`, [roleId, [...new Set(r.permissions)]]);
  }
  for (const p of DEFAULT_POLICIES) {
    const pol = await tx.query<{ id: string }>(
      `insert into wf.policies (doc_type, name, description) values ($1,$2,$3)
       on conflict (doc_type) do update set name = excluded.name returning id`, [p.docType, p.name, p.description]);
    const policyId = pol.rows[0]!.id;
    const existing = await tx.query(`select 1 from wf.policy_versions where policy_id = $1`, [policyId]);
    if (existing.rowCount === 0) {
      await tx.query(
        `insert into wf.policy_versions (policy_id, version, definition, status, published_at) values ($1, 1, $2, 'Published', now())`,
        [policyId, JSON.stringify(p.definition)]);
    }
  }
}
