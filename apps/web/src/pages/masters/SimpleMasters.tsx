import { zodResolver } from '@hookform/resolvers/zod';
import { departmentSchema, employeeSchema, SALES_TIERS, territorySchema } from '@dhruv/contracts';
import { CaretDown, CaretRight, Plus } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const blankToNull = (schema: z.ZodTypeAny, required: string[]) =>
  z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? (required.includes(k) ? undefined : null) : v])), schema);

// ---------------------------------------------------------------- Territories
interface Territory { id: string; parentId: string | null; code: string; name: string; level: number; levelName: string; status: string; employees: number; version: number }

export function TerritoriesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [params] = useSearchParams();
  const tq = useQuery({ queryKey: ['territories'], queryFn: () => api<{ data: Territory[] }>('/territories') });
  const lq = useQuery({ queryKey: ['territory-levels'], queryFn: () => api<{ data: { level: number; name: string; tierHint: string }[] }>('/territory-levels') });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Territory | 'root' | null>(null);
  const [toggle, setToggle] = useState<Territory | null>(null);
  const children = useMemo(() => {
    const m = new Map<string | null, Territory[]>();
    for (const t of tq.data?.data ?? []) m.set(t.parentId, [...(m.get(t.parentId) ?? []), t]);
    return m;
  }, [tq.data]);
  const focus = params.get('focus');
  const f = useForm<{ code: string; name: string; level: number }>({ resolver: zodResolver(territorySchema.omit({ parentId: true })) });
  const add = useMutation({
    mutationFn: (v: { code: string; name: string; level: number }) => api('/territories', { body: { ...v, parentId: adding === 'root' ? null : adding?.id } }),
    onSuccess: async () => { toast('success', 'Territory added.'); setAdding(null); f.reset(); await qc.invalidateQueries({ queryKey: ['territories'] }); },
  });

  const render = (parent: string | null, depth: number): React.ReactNode =>
    (children.get(parent) ?? []).map((t) => {
      const kids = children.get(t.id) ?? [];
      const open = !collapsed.has(t.id);
      return (
        <li key={t.id}>
          <div className={clsx('group flex items-center gap-2 rounded-md py-2 pr-2 hover:bg-[#FAF9FF]', focus === t.id && 'bg-primary-tint')} style={{ paddingLeft: depth * 24 + 8 }}>
            <button aria-label={open ? 'Collapse' : 'Expand'} disabled={!kids.length} onClick={() => setCollapsed((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })}
              className="grid h-7 w-7 place-items-center rounded-sm text-ink-2 hover:bg-white disabled:opacity-0">{open ? <CaretDown size={14} /> : <CaretRight size={14} />}</button>
            <span className="min-w-0 flex-1"><span className="font-medium">{t.name}</span><span className="ml-2 text-[13px] text-ink-2">{t.code} · {t.levelName}{t.employees ? ` · ${t.employees} staff` : ''}</span></span>
            {t.status !== 'Active' && <StatusBadge status={t.status} />}
            <span className="flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
              {can('org.territory:create') && t.status === 'Active' && <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={() => { setAdding(t); f.reset({ level: Math.min(t.level + 1, 8) }); }}>Child</Button>}
              {can('org.territory:deactivate') && <Button size="sm" variant="ghost" onClick={() => setToggle(t)}>{t.status === 'Active' ? 'Deactivate' : 'Activate'}</Button>}
            </span>
          </div>
          {open && kids.length > 0 && <ul>{render(t.id, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <>
      <PageHeader title="Territories" subtitle="Sales jurisdictions from National down to Beat. Levels follow BRD p.3–4 and are configurable (D37)."
        actions={can('org.territory:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => { setAdding('root'); f.reset({ level: 1 }); }}>Top-level territory</Button>} />
      <ErrorBanner error={tq.error} />
      <Card padded={false} className="p-3">
        {tq.isLoading ? <Skeleton className="m-3 h-64" /> : tq.data?.data.length ? <ul>{render(null, 0)}</ul>
          : <EmptyState title="No territories yet" text="Start with the national level, then add zones, states and districts." />}
      </Card>
      <Modal open={!!adding} onClose={() => setAdding(null)} title={adding === 'root' ? 'Add top-level territory' : `Add under ${adding?.name ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setAdding(null)}>Cancel</Button><Button loading={add.isPending} onClick={f.handleSubmit((v) => add.mutate(v))}>Add</Button></>}>
        <ErrorBanner error={add.error} />
        <div className="space-y-4">
          <Field label="Level" htmlFor="tlevel" required error={f.formState.errors.level?.message}>
            <Select id="tlevel" {...f.register('level', { valueAsNumber: true })}>{lq.data?.data.map((l) => <option key={l.level} value={l.level}>{l.level}. {l.name} ({l.tierHint})</option>)}</Select>
          </Field>
          <Field label="Code" htmlFor="tcode" required error={f.formState.errors.code?.message} hint="Cannot be changed later."><Input id="tcode" className="uppercase" {...f.register('code', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>
          <Field label="Name" htmlFor="tname" required error={f.formState.errors.name?.message}><Input id="tname" {...f.register('name')} /></Field>
        </div>
      </Modal>
      <ReasonDialog open={!!toggle} title={`${toggle?.status === 'Active' ? 'Deactivate' : 'Activate'} ${toggle?.name ?? ''}`} confirmLabel={toggle?.status === 'Active' ? 'Deactivate' : 'Activate'} danger={toggle?.status === 'Active'}
        onClose={() => setToggle(null)}
        onConfirm={async (reason) => { await api(`/territories/${toggle!.id}/${toggle!.status === 'Active' ? 'deactivate' : 'activate'}`, { body: { reason } }); toast('success', 'Updated.'); await qc.invalidateQueries({ queryKey: ['territories'] }); }} />
    </>
  );
}

// ---------------------------------------------------------------- Departments
interface Dept { id: string; code: string; name: string; status: string }
export function DepartmentsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['departments'], queryFn: () => api<{ data: Dept[] }>('/departments') });
  const [open, setOpen] = useState(false);
  const [toggle, setToggle] = useState<Dept | null>(null);
  const f = useForm<{ code: string; name: string }>({ resolver: zodResolver(departmentSchema) });
  const add = useMutation({ mutationFn: (v: { code: string; name: string }) => api('/departments', { body: v }),
    onSuccess: async () => { toast('success', 'Department added.'); setOpen(false); f.reset(); await qc.invalidateQueries({ queryKey: ['departments'] }); } });
  return (
    <>
      <PageHeader title="Departments" subtitle="Organisational departments used by employees and cost reporting."
        actions={can('org.department:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>New department</Button>} />
      <ErrorBanner error={q.error} />
      <div className="card overflow-hidden">
        {q.isLoading ? <Skeleton className="m-5 h-40" /> : !q.data?.data.length ? <EmptyState title="No departments yet" text="Add Sales, Purchase, Stores, Plant, QC, QA, Logistics, Finance…" /> : (
          <table className="w-full text-left"><thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className="px-5 py-3 font-medium">Code</th><th className="px-5 py-3 font-medium">Name</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{q.data.data.map((d) => (
              <tr key={d.id} className="h-14 border-t border-line"><td className="px-5 font-semibold">{d.code}</td><td className="px-5">{d.name}</td><td className="px-5"><StatusBadge status={d.status} /></td>
                <td className="px-5 text-right">{can('org.department:deactivate') && <Button size="sm" variant="ghost" onClick={() => setToggle(d)}>{d.status === 'Active' ? 'Deactivate' : 'Activate'}</Button>}</td></tr>))}</tbody></table>
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="New department"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.isPending} onClick={f.handleSubmit((v) => add.mutate(v))}>Add</Button></>}>
        <ErrorBanner error={add.error} />
        <div className="space-y-4">
          <Field label="Code" htmlFor="dcode" required error={f.formState.errors.code?.message}><Input id="dcode" className="uppercase" {...f.register('code', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>
          <Field label="Name" htmlFor="dname" required error={f.formState.errors.name?.message}><Input id="dname" {...f.register('name')} /></Field>
        </div>
      </Modal>
      <ReasonDialog open={!!toggle} title={`${toggle?.status === 'Active' ? 'Deactivate' : 'Activate'} ${toggle?.name ?? ''}`} confirmLabel="Confirm" danger={toggle?.status === 'Active'} onClose={() => setToggle(null)}
        onConfirm={async (reason) => { await api(`/departments/${toggle!.id}/${toggle!.status === 'Active' ? 'deactivate' : 'activate'}`, { body: { reason } }); toast('success', 'Updated.'); await qc.invalidateQueries({ queryKey: ['departments'] }); }} />
    </>
  );
}

// ---------------------------------------------------------------- Employees
interface Emp { id: string; empCode: string; fullName: string; email: string | null; mobile: string | null; departmentId: string | null; departmentName: string | null; designation: string | null;
  salesTier: string | null; managerId: string | null; managerName: string | null; territoryId: string | null; territoryName: string | null; legalEntityId: string | null; status: string; version: number; userEmail: string | null;
  serialNo: number | null; team: string | null; headquarters: string | null; district: string | null; area: string | null; reportingTo: string | null;
  phoneNumbers?: string | null; education?: string | null; dateOfJoining?: string | null; dateOfJoiningText?: string | null; idCardNo?: string | null; bloodGroup?: string | null }
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export function EmployeesPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('org.employee:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/masters/employees/new')}>New employee</Button> : undefined;
  return (
    <>
      <PageHeader title="Employees" subtitle="People, their reporting line and sales tier. The reporting line drives approval routing (D01). An employee signs in only once a user account is created for them." actions={create} />
      <DataTable<Emp> queryKey="employees" path="/employees" rowHref={(r) => `/masters/employees/${r.id}`} statusOptions={['Active', 'Inactive']} searchPlaceholder="Search code or name"
        empty={{ title: 'No employees yet', text: 'Add employees, then link them to user accounts.', action: create }}
        columns={[
          { key: 'code', header: 'Code', render: (r) => <span className="font-semibold">{r.empCode}</span> },
          { key: 'name', header: 'Name', render: (r) => <span><span className="block">{r.fullName}</span><span className="text-[13px] text-ink-2">{r.designation ?? ''}</span></span> },
          { key: 'team', header: 'Team · HQ', render: (r) => <span><span className="block">{r.team ?? '—'}</span><span className="text-[13px] text-ink-2">{[r.headquarters, r.area].filter(Boolean).join(' · ')}</span></span> },
          { key: 'tier', header: 'Sales tier', render: (r) => r.salesTier ?? '—' },
          { key: 'mgr', header: 'Reports to', render: (r) => r.managerName ?? (r.reportingTo ? <span className="text-warning-text" title="Not linked to an employee">{r.reportingTo}</span> : '—') },
          { key: 'user', header: 'User account', render: (r) => r.userEmail ?? <span className="text-ink-2">None</span> },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />
    </>
  );
}

export function EmployeeDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [toggle, setToggle] = useState(false);
  const q = useQuery({ queryKey: ['employee', id], queryFn: () => api<Emp & { canViewPersonal: boolean; allowedActions: string[]; directReports: { id: string; empCode: string; fullName: string; salesTier: string | null; status: string }[] }>(`/employees/${id}`) });
  const e = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!e) return <ErrorBanner error={q.error} />;
  const deact = e.allowedActions.includes('deactivate');
  return (
    <>
      <PageHeader title={e.fullName} crumbs={<Link to="/masters/employees" className="hover:text-primary">Employees</Link>} subtitle={<StatusBadge status={e.status} />}
        actions={<>
          {e.allowedActions.includes('edit') && <Button variant="secondary" onClick={() => nav(`/masters/employees/${id}/edit`)}>Edit</Button>}
          {(deact || e.allowedActions.includes('activate')) && <Button variant={deact ? 'danger' : 'primary'} onClick={() => setToggle(true)}>{deact ? 'Deactivate' : 'Activate'}</Button>}
        </>} />
      <div className="space-y-6">
        <Card title="Details"><KeyValues items={[['Employee code', e.empCode], ['Sr. no. in staff list', e.serialNo], ['Designation', e.designation], ['Team', e.team], ['Headquarters', e.headquarters],
          ['District', e.district], ['Area', e.area], ['Email', e.email], ['Mobile', e.mobile], ['Department', e.departmentName], ['Sales tier', e.salesTier],
          ['Reports to', e.managerId ? <Link className="text-primary" to={`/masters/employees/${e.managerId}`}>{e.managerName}</Link> : '—'],
          ['Reporting to (as listed)', e.reportingTo], ['Territory', e.territoryName], ['User account', e.userEmail ?? 'None — no sign-in yet']]} /></Card>
        {e.canViewPersonal && <Card title="Personal details"><KeyValues items={[['Other phone numbers', e.phoneNumbers], ['Educational details', e.education],
          ['Date of joining', e.dateOfJoining ?? e.dateOfJoiningText], ['ID card', e.idCardNo], ['Blood group', e.bloodGroup]]} /></Card>}
        <Card title="Direct reports">
          {e.directReports.length === 0 ? <p className="text-ink-2">None.</p> : <ul className="divide-y divide-line">{e.directReports.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-3"><Link to={`/masters/employees/${r.id}`} className="font-medium text-primary">{r.fullName}</Link><span className="text-ink-2">{r.empCode} · {r.salesTier ?? '—'}</span></li>))}</ul>}
        </Card>
      </div>
      <ReasonDialog open={toggle} title={deact ? 'Deactivate employee' : 'Activate employee'} confirmLabel="Confirm" danger={deact} onClose={() => setToggle(false)}
        onConfirm={async (reason) => { await api(`/employees/${id}/${deact ? 'deactivate' : 'activate'}`, { body: { reason } }); toast('success', 'Updated.'); await qc.invalidateQueries(); }} />
    </>
  );
}

export function EmployeeFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['employee', id], queryFn: () => api<Emp>(`/employees/${id}`), enabled: !!id });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api<{ data: Dept[] }>('/departments') });
  const terrs = useQuery({ queryKey: ['territories'], queryFn: () => api<{ data: Territory[] }>('/territories') });
  const mgrs = useQuery({ queryKey: ['employees-all'], queryFn: () => api<Page<Emp>>('/employees?limit=500&status=Active') });
  const { can } = useAuth();
  const personalOk = can('org.employee:view_personal');
  const [error, setError] = useState<unknown>(null);
  type Form = Record<string, string>;
  const f = useForm<Form>({
    resolver: zodResolver(blankToNull(employeeSchema, ['empCode', 'fullName'])),
    values: existing.data ? Object.fromEntries(Object.entries(existing.data).map(([k, v]) => [k, v === null ? '' : String(v)])) : undefined,
  });
  if (id && existing.isLoading) return <Skeleton className="h-96" />;
  const save = f.handleSubmit(async (v) => {
    setError(null);
    try {
      if (id) { await api(`/employees/${id}`, { method: 'PUT', body: { ...v, version: existing.data!.version } }); await qc.invalidateQueries(); toast('success', 'Saved.'); nav(`/masters/employees/${id}`); }
      else { const r = await api<{ id: string }>('/employees', { body: v }); toast('success', 'Employee created.'); nav(`/masters/employees/${r.id}`); }
    } catch (e) { if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k, { message: m })); setError(e); }
  });
  const err = (k: string) => f.formState.errors[k]?.message as string | undefined;
  return (
    <>
      <PageHeader title={id ? 'Edit employee' : 'New employee'} crumbs={<Link to="/masters/employees" className="hover:text-primary">Employees</Link>} />
      <Card className="max-w-4xl">
        <ErrorBanner error={error} />
        <form noValidate onSubmit={save} className="grid gap-5 md:grid-cols-2">
          <Field label="Employee code" htmlFor="empCode" required error={err('empCode')}><Input id="empCode" className="uppercase" {...f.register('empCode', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>
          <Field label="Full name" htmlFor="fullName" required error={err('fullName')}><Input id="fullName" {...f.register('fullName')} /></Field>
          <Field label="Email" htmlFor="email" error={err('email')}><Input id="email" type="email" {...f.register('email')} /></Field>
          <Field label="Mobile" htmlFor="mobile" error={err('mobile')} hint="10 digits, used for WhatsApp alerts later"><Input id="mobile" inputMode="numeric" maxLength={10} {...f.register('mobile')} /></Field>
          <Field label="Department" htmlFor="departmentId" error={err('departmentId')}><Select id="departmentId" {...f.register('departmentId')}><option value="">—</option>{depts.data?.data.filter((d) => d.status === 'Active').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          <Field label="Designation" htmlFor="designation" error={err('designation')}><Input id="designation" {...f.register('designation')} /></Field>
          <Field label="Sales tier" htmlFor="salesTier" error={err('salesTier')} hint="Only for the nine-tier sales hierarchy"><Select id="salesTier" {...f.register('salesTier')}><option value="">Not in sales hierarchy</option>{SALES_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
          <Field label="Reports to" htmlFor="managerId" error={err('managerId')}><Select id="managerId" {...f.register('managerId')}><option value="">—</option>{mgrs.data?.data.filter((m) => m.id !== id).map((m) => <option key={m.id} value={m.id}>{m.fullName} ({m.empCode}{m.salesTier ? ` · ${m.salesTier}` : ''})</option>)}</Select></Field>
          <Field label="Territory" htmlFor="territoryId" error={err('territoryId')}><Select id="territoryId" {...f.register('territoryId')}><option value="">—</option>{terrs.data?.data.filter((t) => t.status === 'Active').map((t) => <option key={t.id} value={t.id}>{'· '.repeat(t.level - 1)}{t.name} ({t.levelName})</option>)}</Select></Field>
          <Field label="Team" htmlFor="team" error={err('team')} hint="Section of the staff list"><Input id="team" {...f.register('team')} /></Field>
          <Field label="Headquarters" htmlFor="headquarters" error={err('headquarters')}><Input id="headquarters" {...f.register('headquarters')} /></Field>
          <Field label="District" htmlFor="district" error={err('district')}><Input id="district" {...f.register('district')} /></Field>
          <Field label="Area" htmlFor="area" error={err('area')}><Input id="area" {...f.register('area')} /></Field>
          <Field label="Reporting to (as listed)" htmlFor="reportingTo" error={err('reportingTo')} hint="Text from the staff list; the linked manager is set above"><Input id="reportingTo" {...f.register('reportingTo')} /></Field>
          {personalOk && <>
            <Field label="Other phone numbers" htmlFor="phoneNumbers" error={err('phoneNumbers')}><Input id="phoneNumbers" {...f.register('phoneNumbers')} /></Field>
            <Field label="Educational details" htmlFor="education" error={err('education')}><Input id="education" {...f.register('education')} /></Field>
            <Field label="Date of joining" htmlFor="dateOfJoining" error={err('dateOfJoining')}><Input id="dateOfJoining" type="date" {...f.register('dateOfJoining')} /></Field>
            <Field label="ID card" htmlFor="idCardNo" error={err('idCardNo')}><Input id="idCardNo" {...f.register('idCardNo')} /></Field>
            <Field label="Blood group" htmlFor="bloodGroup" error={err('bloodGroup')}><Select id="bloodGroup" {...f.register('bloodGroup')}><option value="">—</option>{BLOOD_GROUPS.map((b) => <option key={b}>{b}</option>)}</Select></Field>
          </>}
          <div className="flex gap-2 md:col-span-2"><Button type="submit" loading={f.formState.isSubmitting}>Save</Button><Button type="button" variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
        </form>
      </Card>
    </>
  );
}
