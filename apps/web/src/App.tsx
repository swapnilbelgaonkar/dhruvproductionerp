import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
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
import { CategoriesPage, HsnPage, UomPage } from './pages/masters/ProductMasters';

function Protected({ perm, children }: { perm?: string; children: JSX.Element }) {
  const { can } = useAuth();
  if (perm && !can(perm)) return <div className="card mt-6"><EmptyState title="You don't have access to this page" text={`Ask your Security Administrator for the permission “${perm}” if you need it.`} /></div>;
  return children;
}

export function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
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
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/:id" element={<ApprovalDetailPage />} />
        {master('legalEntities')}
        {master('plants')}
        {master('warehouses')}
        {master('items')}
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
