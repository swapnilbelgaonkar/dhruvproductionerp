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
  ...P('Sales', 'mdm.dealer', ['view', 'create', 'edit_draft', 'submit', 'verify_documents', 'view_sensitive', 'suspend'], 'dealers and their KYC'),
];

const ALL = PERMISSIONS.map((p) => p.code);
const VIEW = ALL.filter((c) => c.endsWith(':view'));
// dealer data is sales-owned and territory-scoped, so it is granted explicitly below rather than with the general master views
const ORG_VIEW = VIEW.filter((c) => (c.startsWith('org.') || c.startsWith('mdm.')) && !c.startsWith('mdm.dealer'));
const MASTER = (c: string) => (c.startsWith('org.') || c.startsWith('mdm.')) && !c.startsWith('mdm.dealer');
const DEALER_SALES = ['mdm.dealer:view', 'mdm.dealer:create', 'mdm.dealer:edit_draft', 'mdm.dealer:submit'];
const DEALER_EXTRA: Record<string, string[]> = {
  SALES_OPS: DEALER_SALES,
  DOC_VERIFIER: ['mdm.dealer:view', 'mdm.dealer:verify_documents', 'mdm.dealer:view_sensitive'],
  CREDIT_CONTROLLER: ['mdm.dealer:view', 'mdm.dealer:view_sensitive', 'mdm.dealer:suspend'],
  FINANCE_HEAD: ['mdm.dealer:view', 'mdm.dealer:view_sensitive', 'mdm.dealer:suspend', 'mdm.tax_rate:configure', 'mdm.hsn:create', 'mdm.hsn:edit'],
  ACCOUNTS_EXEC: ['mdm.dealer:view'],
  MANAGEMENT_VIEWER: ['mdm.dealer:view'],
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
    code: `SALES_${t}`, name: `Sales — ${t}`, department: 'Sales', description: `Sales hierarchy tier ${t}`, permissions: [...ORG_VIEW, ...DEALER_SALES] })),
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
    permissions: [...ORG_VIEW, ...(DEALER_EXTRA[code!] ?? [])] })),
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
  // D01 approved: hybrid routing. Used by sales orders in Stage 2; simulation is available now.
  { docType: 'sales.order', name: 'Sales order approval (D01 hybrid)', description: 'Lowest covering tier in the initiator’s chain, skipped tiers notified, then Accounts review',
    definition: { distinctApprovers: true, rules: [{ name: 'Hybrid routing', steps: [
      { kind: 'authority_ladder', label: 'Commercial approval', amountFact: 'amount', discountFact: 'maxDiscountPct', notifySkipped: true },
      { kind: 'role', label: 'Accounts review (credit & stock)', roles: ['ACCOUNTS_EXEC', 'CREDIT_CONTROLLER', 'FINANCE_HEAD'] },
    ] }] } },
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
