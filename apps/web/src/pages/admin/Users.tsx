import { zodResolver } from '@hookform/resolvers/zod';
import { createUserSchema } from '@dhruv/contracts';
import { Plus, ShieldWarning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

interface UserRow { id: string; email: string; fullName: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null; lockedUntil: string | null; empCode: string | null; roles: string[] }

export function UsersPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const create = can('iam.user:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>New user</Button> : undefined;
  return (
    <>
      <PageHeader title="Users" subtitle="Sign-in accounts. Roles decide what each person can do; privileged roles need executive approval." actions={create} />
      <DataTable<UserRow> queryKey="users" path="/users" rowHref={(r) => `/admin/users/${r.id}`} statusOptions={['Active', 'Suspended', 'Deactivated']} searchPlaceholder="Search name or email"
        empty={{ title: 'No users', text: 'Create user accounts for your team.', action: create }}
        columns={[
          { key: 'name', header: 'User', render: (r) => <span><span className="block font-medium">{r.fullName}</span><span className="text-[13px] text-ink-2">{r.email}</span></span> },
          { key: 'roles', header: 'Roles', render: (r) => r.roles.length ? r.roles.join(', ') : <span className="text-ink-2">None</span> },
          { key: 'mfa', header: 'MFA', render: (r) => r.mfaEnabled ? <StatusBadge status="Active" label="Enrolled" /> : <StatusBadge status="Draft" label="Not enrolled" /> },
          { key: 'last', header: 'Last sign-in', render: (r) => fmtDateTime(r.lastLoginAt) },
          { key: 'status', header: 'Status', render: (r) => r.lockedUntil && new Date(r.lockedUntil) > new Date() ? <StatusBadge status="OnHold" label="Locked" /> : <StatusBadge status={r.status} /> },
        ]} />
      <CreateUserDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateUserDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [error, setError] = useState<unknown>(null);
  const f = useForm<z.infer<typeof createUserSchema>>({ resolver: zodResolver(createUserSchema) });
  const save = f.handleSubmit(async (v) => {
    setError(null);
    try { const r = await api<{ id: string }>('/users', { body: v }); toast('success', 'User created. Share the initial password securely; it must be changed at first sign-in.'); f.reset(); onClose(); nav(`/admin/users/${r.id}`); }
    catch (e) { if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k as 'email', { message: m })); setError(e); }
  });
  return (
    <Modal open={open} onClose={onClose} title="New user" description="The user must change this password at first sign-in. Never send it over WhatsApp or email in plain text."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.formState.isSubmitting} onClick={save}>Create user</Button></>}>
      <ErrorBanner error={error} />
      <div className="space-y-4">
        <Field label="Full name" htmlFor="ufn" required error={f.formState.errors.fullName?.message}><Input id="ufn" {...f.register('fullName')} /></Field>
        <Field label="Email" htmlFor="uem" required error={f.formState.errors.email?.message}><Input id="uem" type="email" {...f.register('email')} /></Field>
        <Field label="Initial password" htmlFor="upw" required error={f.formState.errors.initialPassword?.message} hint="At least 12 characters with letters and digits."><Input id="upw" type="password" autoComplete="new-password" {...f.register('initialPassword')} /></Field>
      </div>
    </Modal>
  );
}

interface UserDetail {
  id: string; email: string; fullName: string; status: string; mfaEnabled: boolean; mustChangePassword: boolean; lastLoginAt: string | null; lockedUntil: string | null;
  failedLoginCount: number; employeeId: string | null; empCode: string | null; employeeName: string | null; version: number; createdAt: string;
  roles: { id: string; roleId: string; code: string; name: string; privileged: boolean; scope: { all?: true; legalEntityIds?: string[] }; status: string; reason: string; grantedAt: string | null; grantedBy: string | null; approvalRequestId: string | null }[];
  sessions: { id: string; createdAt: string; lastSeenAt: string; ip: string; userAgent: string }[];
  allowedActions: string[]; canRevokeRoles: boolean;
}

const ACTION_LABEL: Record<string, { label: string; path: string; danger?: boolean; text: string }> = {
  suspend: { label: 'Suspend', path: 'suspend', danger: true, text: 'The user is signed out and cannot sign in until reactivated.' },
  reactivate: { label: 'Reactivate', path: 'reactivate', text: 'The user can sign in again.' },
  deactivate: { label: 'Deactivate permanently', path: 'deactivate', danger: true, text: 'All roles are revoked and the account can never sign in again. History is kept.' },
  resetMfa: { label: 'Reset MFA', path: 'reset-mfa', danger: true, text: 'The user must enrol a new authenticator at next sign-in.' },
  unlock: { label: 'Unlock', path: 'unlock', text: 'Clears the failed-login lock.' },
  revokeSessions: { label: 'Sign out everywhere', path: 'revoke-sessions', text: 'Ends all of this user’s active sessions.' },
};

export function UserDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['user', id], queryFn: () => api<UserDetail>(`/users/${id}`) });
  const [action, setAction] = useState<string | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [revoke, setRevoke] = useState<UserDetail['roles'][number] | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const u = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!u) return <ErrorBanner error={q.error} />;
  const a = ACTION_LABEL[action ?? ''];
  return (
    <>
      <PageHeader title={u.fullName} crumbs={<Link to="/admin/users" className="hover:text-primary">Users</Link>}
        subtitle={<span className="inline-flex items-center gap-2"><StatusBadge status={u.status} /> {u.email}</span>}
        actions={<>
          {u.allowedActions.includes('edit') && <Button variant="secondary" onClick={() => setLinkOpen(true)}>Edit</Button>}
          {u.allowedActions.filter((x) => ACTION_LABEL[x]).map((x) => <Button key={x} variant={ACTION_LABEL[x]!.danger ? 'danger' : 'secondary'} onClick={() => setAction(x)}>{ACTION_LABEL[x]!.label}</Button>)}
        </>} />
      <div className="space-y-6">
        <Card title="Account">
          <KeyValues items={[['Email', u.email], ['Employee', u.employeeName ? <Link to={`/masters/employees/${u.employeeId}`} className="text-primary">{u.employeeName} ({u.empCode})</Link> : 'Not linked'],
            ['MFA', u.mfaEnabled ? 'Enrolled' : 'Not enrolled'], ['Password', u.mustChangePassword ? 'Must change at next sign-in' : 'Set by user'],
            ['Last sign-in', fmtDateTime(u.lastLoginAt)], ['Locked until', fmtDateTime(u.lockedUntil)], ['Created', fmtDateTime(u.createdAt)]]} />
        </Card>
        <Card title="Roles" actions={u.allowedActions.includes('grantRole') && <Button size="sm" icon={<Plus size={16} />} onClick={() => setGrantOpen(true)}>Grant role</Button>}>
          {u.roles.length === 0 ? <p className="text-ink-2">No roles. The user can sign in but sees nothing.</p> : (
            <ul className="divide-y divide-line">{u.roles.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{r.name}</span>{r.privileged && <span className="ml-2 inline-flex items-center gap-1 text-[12px] font-semibold text-primary-hover"><ShieldWarning size={14} />Privileged</span>}
                  <span className="block text-[13px] text-ink-2">{r.scope.all ? 'All legal entities' : `${r.scope.legalEntityIds?.length ?? 0} legal entit${r.scope.legalEntityIds?.length === 1 ? 'y' : 'ies'}`} · {r.reason}{r.grantedBy ? ` · granted by ${r.grantedBy}` : ''}</span>
                </span>
                {r.approvalRequestId && r.status === 'PendingApproval' && <Link to={`/approvals/${r.approvalRequestId}`} className="text-[13px] font-semibold text-primary">View approval</Link>}
                <StatusBadge status={r.status} />
                {u.canRevokeRoles && r.status === 'Active' && <Button size="sm" variant="ghost" onClick={() => setRevoke(r)}>Revoke</Button>}
              </li>))}</ul>
          )}
        </Card>
        {u.sessions.length > 0 && (
          <Card title="Active sessions">
            <ul className="divide-y divide-line">{u.sessions.map((s) => <li key={s.id} className="py-3 text-[14px]"><span className="font-medium">{s.ip}</span> · last seen {fmtDateTime(s.lastSeenAt)}<span className="block truncate text-[12px] text-ink-2">{s.userAgent}</span></li>)}</ul>
          </Card>
        )}
      </div>
      <ReasonDialog open={!!action} title={a?.label ?? ''} description={a?.text} confirmLabel={a?.label ?? ''} danger={a?.danger} onClose={() => setAction(null)}
        onConfirm={async (reason) => { await api(`/users/${id}/${a!.path}`, { body: { reason } }); toast('success', 'Done.'); await qc.invalidateQueries(); }} />
      <ReasonDialog open={!!revoke} title={`Revoke ${revoke?.name ?? ''}`} confirmLabel="Revoke" danger onClose={() => setRevoke(null)}
        onConfirm={async (reason) => { await api(`/users/${id}/roles/${revoke!.id}/revoke`, { body: { reason } }); toast('success', 'Role revoked.'); await qc.invalidateQueries(); }} />
      <GrantRoleDialog open={grantOpen} onClose={() => setGrantOpen(false)} userId={u.id} />
      <EditUserDialog open={linkOpen} onClose={() => setLinkOpen(false)} user={u} />
    </>
  );
}

function GrantRoleDialog({ open, onClose, userId }: { open: boolean; onClose: () => void; userId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: { id: string; name: string; department: string; privileged: boolean }[] }>('/roles'), enabled: open });
  const les = useQuery({ queryKey: ['ref', 'legalEntity'], queryFn: () => api<Page<{ id: string; code: string; name: string; status: string }>>('/legal-entities?limit=100'), enabled: open });
  const [roleId, setRoleId] = useState('');
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const role = roles.data?.data.find((r) => r.id === roleId);
  const grouped = useMemo(() => Object.entries((roles.data?.data ?? []).reduce<Record<string, typeof roles.data extends undefined ? never : { id: string; name: string; privileged: boolean }[]>>((m, r) => ({ ...m, [r.department]: [...(m[r.department] ?? []), r] }), {})), [roles.data]);
  const m = useMutation({
    mutationFn: () => api<{ status: string; approvalDocNo?: string }>(`/users/${userId}/roles`, { body: { roleId, reason, scope: all ? { all: true } : { legalEntityIds: selected, plantIds: [], warehouseIds: [], territoryIds: [] } } }),
    onSuccess: async (r) => { toast('success', r.status === 'Active' ? 'Role granted.' : `Sent for executive approval (${r.approvalDocNo}).`); setRoleId(''); setReason(''); onClose(); await qc.invalidateQueries(); },
  });
  return (
    <Modal open={open} onClose={onClose} title="Grant role" width={620}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!roleId || !reason.trim() || (!all && !selected.length)} onClick={() => m.mutate()}>{role?.privileged ? 'Request approval' : 'Grant'}</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        <Field label="Role" htmlFor="grole" required>
          <Select id="grole" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
            <option value="">Select…</option>
            {grouped.map(([dept, rs]) => <optgroup key={dept} label={dept}>{rs.map((r) => <option key={r.id} value={r.id}>{r.name}{r.privileged ? ' (privileged)' : ''}</option>)}</optgroup>)}
          </Select>
        </Field>
        {role?.privileged && <p className="rounded-md bg-primary-soft px-4 py-3 text-[14px] text-primary-hover">Privileged role: it becomes active only after an Executive Administrator approves it.</p>}
        <fieldset>
          <legend className="label">Data scope</legend>
          <label className="flex items-center gap-2 py-1"><input type="radio" checked={all} onChange={() => setAll(true)} /> All legal entities</label>
          <label className="flex items-center gap-2 py-1"><input type="radio" checked={!all} onChange={() => setAll(false)} /> Selected legal entities</label>
          {!all && <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border border-line p-3">{les.data?.data.map((l) => (
            <label key={l.id} className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(l.id)} onChange={(e) => setSelected((s) => e.target.checked ? [...s, l.id] : s.filter((x) => x !== l.id))} />{l.code} — {l.name}</label>))}</div>}
        </fieldset>
        <Field label="Reason" htmlFor="greason" required><Textarea id="greason" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function EditUserDialog({ open, onClose, user }: { open: boolean; onClose: () => void; user: UserDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const emps = useQuery({ queryKey: ['employees-all'], queryFn: () => api<Page<{ id: string; empCode: string; fullName: string; status: string }>>('/employees?limit=100&status=Active'), enabled: open });
  const [fullName, setFullName] = useState(user.fullName);
  const [employeeId, setEmployeeId] = useState(user.employeeId ?? '');
  const m = useMutation({ mutationFn: () => api(`/users/${user.id}`, { method: 'PUT', body: { fullName, employeeId: employeeId || null, version: user.version } }),
    onSuccess: async () => { toast('success', 'Saved.'); onClose(); await qc.invalidateQueries(); } });
  return (
    <Modal open={open} onClose={onClose} title="Edit user" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={() => m.mutate()}>Save</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        <Field label="Full name" htmlFor="efn" required><Input id="efn" value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        <Field label="Linked employee" htmlFor="eemp" hint="Links the account to the reporting hierarchy used for approvals."><Select id="eemp" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Not linked</option>{emps.data?.data.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.empCode})</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

export function RolesPage() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ data: { id: string; code: string; name: string; description: string; department: string; privileged: boolean; requiresMfa: boolean; permissions: number; users: number }[] }>('/roles') });
  const matrix = useQuery({ queryKey: ['roles-matrix'], queryFn: () => api<{ permissions: { code: string; module: string; resource: string; action: string }[]; grants: { role: string; permission: string }[] }>('/roles/matrix') });
  const [role, setRole] = useState<string>('SUPER_ADMIN');
  const granted = new Set(matrix.data?.grants.filter((g) => g.role === role).map((g) => g.permission));
  const resources = useMemo(() => {
    const m = new Map<string, { module: string; actions: string[] }>();
    for (const p of matrix.data?.permissions ?? []) { const e = m.get(p.resource) ?? { module: p.module, actions: [] }; e.actions.push(p.action); m.set(p.resource, e); }
    return [...m];
  }, [matrix.data]);
  return (
    <>
      <PageHeader title="Roles & Permissions" subtitle="Roles are defined in version-controlled configuration and change through the release process (doc 07). Assign them to users from the Users screen." />
      <ErrorBanner error={roles.error ?? matrix.error} />
      <div className="grid gap-6 xl:grid-cols-[minmax(320px,420px)_1fr]">
        <Card title="Roles" padded={false} className="overflow-hidden p-0">
          <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
            {roles.data?.data.map((r) => (
              <li key={r.id}><button onClick={() => setRole(r.code)} className={`w-full px-6 py-3 text-left hover:bg-[#FAF9FF] ${role === r.code ? 'bg-primary-tint' : ''}`}>
                <span className="flex items-center justify-between gap-2"><span className="font-medium">{r.name}</span><span className="text-[12px] text-ink-2 num">{r.users} users</span></span>
                <span className="block text-[12px] text-ink-2">{r.department}{r.privileged ? ' · privileged · MFA required' : ''}</span>
              </button></li>))}
          </ul>
        </Card>
        <Card title={`Permissions — ${roles.data?.data.find((r) => r.code === role)?.name ?? ''}`}>
          <p className="mb-4 text-[14px] text-ink-2">{roles.data?.data.find((r) => r.code === role)?.description}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[14px]">
              <thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className="px-4 py-2 font-medium">Resource</th><th className="px-4 py-2 font-medium">Allowed actions</th></tr></thead>
              <tbody>{resources.map(([res, e]) => {
                const allowed = e.actions.filter((x) => granted.has(`${res}:${x}`));
                return (
                  <tr key={res} className="border-t border-line"><td className="px-4 py-2.5"><span className="font-medium">{res}</span><span className="block text-[12px] text-ink-2">{e.module}</span></td>
                    <td className="px-4 py-2.5">{allowed.length ? <span className="flex flex-wrap gap-1">{allowed.map((x) => <span key={x} className="rounded-full bg-success-bg px-2 py-0.5 text-[12px] font-medium text-success-text">{x}</span>)}</span> : <span className="text-ink-2">—</span>}</td></tr>
                );
              })}</tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
