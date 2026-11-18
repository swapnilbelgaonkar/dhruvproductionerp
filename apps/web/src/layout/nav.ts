import { Buildings, CheckSquareOffset, ClockCounterClockwise, Factory, FlowArrow, Gauge, Hash, IdentificationBadge, MapTrifold, Scales, ShieldCheck, SlidersHorizontal, TreeStructure, UsersThree, Warehouse, type Icon } from '@phosphor-icons/react';

export interface NavItem { to: string; label: string; icon: Icon; perm?: string }
export interface NavGroup { label?: string; items: NavItem[] }

/** Only modules that are built appear here (no placeholder menu items — MP Part 28). */
export const NAV: NavGroup[] = [
  { items: [
    { to: '/', label: 'Overview', icon: Gauge },
    { to: '/approvals', label: 'Approvals', icon: CheckSquareOffset },
  ] },
  { label: 'Masters', items: [
    { to: '/masters/legal-entities', label: 'Legal Entities', icon: Buildings, perm: 'org.legal_entity:view' },
    { to: '/masters/plants', label: 'Plants', icon: Factory, perm: 'org.plant:view' },
    { to: '/masters/warehouses', label: 'Warehouses', icon: Warehouse, perm: 'org.warehouse:view' },
    { to: '/masters/territories', label: 'Territories', icon: MapTrifold, perm: 'org.territory:view' },
    { to: '/masters/departments', label: 'Departments', icon: TreeStructure, perm: 'org.department:view' },
    { to: '/masters/employees', label: 'Employees', icon: IdentificationBadge, perm: 'org.employee:view' },
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
