import { zodResolver } from '@hookform/resolvers/zod';
import { gstRegistrationSchema, INDIAN_STATES, legalEntitySchema, plantSchema, WAREHOUSE_TYPES, warehouseSchema } from '@dhruv/contracts';
import { Plus } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z, type ZodObject, type ZodRawShape } from 'zod';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

type Row = Record<string, string | number | null> & { id: string; code: string; name: string; status: string; version: number };

interface FieldDef { name: string; label: string; kind: 'text' | 'textarea' | 'state' | 'select' | 'ref'; required?: boolean; hint?: string; options?: readonly string[]; ref?: 'legalEntity' | 'plant' | 'gst'; upper?: boolean; editableOnCreateOnly?: boolean }
export interface MasterConfig {
  key: string; api: string; base: string; title: string; singular: string; perm: string; subtitle: string;
  schema: ZodObject<ZodRawShape>; fields: FieldDef[]; columns: Column<Row>[]; details: (r: Row) => [string, ReactNode][];
}

const stateName = (c?: string | number | null) => (c ? `${INDIAN_STATES[String(c)] ?? 'Unknown'} (${c})` : '—');

export const MASTERS: Record<string, MasterConfig> = {
  legalEntities: {
    key: 'legal-entities', api: '/legal-entities', base: '/masters/legal-entities', title: 'Legal Entities', singular: 'Legal entity', perm: 'org.legal_entity',
    subtitle: 'Companies that issue invoices and hold GST registrations.', schema: legalEntitySchema,
    fields: [
      { name: 'code', label: 'Code', kind: 'text', required: true, upper: true, hint: 'Short unique code, e.g. DAT' },
      { name: 'name', label: 'Registered name', kind: 'text', required: true },
      { name: 'pan', label: 'PAN', kind: 'text', upper: true, hint: 'Required before submission. Format AAAAA9999A' },
      { name: 'cin', label: 'CIN / LLPIN', kind: 'text', upper: true },
      { name: 'stateCode', label: 'Registered state', kind: 'state' },
      { name: 'registeredAddress', label: 'Registered address', kind: 'textarea' },
    ],
    columns: [
      { key: 'code', header: 'Code', render: (r) => <span className="font-semibold">{r.code}</span> },
      { key: 'name', header: 'Name', render: (r) => r.name },
      { key: 'pan', header: 'PAN', render: (r) => r.pan ?? '—' },
      { key: 'gst', header: 'GST registrations', render: (r) => <span className="num">{r.gstRegistrations}</span> },
      { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    ],
    details: (r) => [['Code', r.code], ['Registered name', r.name], ['PAN', r.pan], ['CIN / LLPIN', r.cin], ['Registered state', stateName(r.stateCode)], ['Registered address', r.registeredAddress]],
  },
  plants: {
    key: 'plants', api: '/plants', base: '/masters/plants', title: 'Plants', singular: 'Plant', perm: 'org.plant',
    subtitle: 'Manufacturing units (BRD p.18: Chakan Plant 1, Baramati Unit 2).', schema: plantSchema,
    fields: [
      { name: 'legalEntityId', label: 'Legal entity', kind: 'ref', ref: 'legalEntity', required: true },
      { name: 'code', label: 'Code', kind: 'text', required: true, upper: true },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'stateCode', label: 'State', kind: 'state' },
      { name: 'address', label: 'Address', kind: 'textarea' },
    ],
    columns: [
      { key: 'code', header: 'Code', render: (r) => <span className="font-semibold">{r.code}</span> },
      { key: 'name', header: 'Name', render: (r) => r.name },
      { key: 'le', header: 'Legal entity', render: (r) => r.legalEntityName },
      { key: 'state', header: 'State', render: (r) => stateName(r.stateCode) },
      { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    ],
    details: (r) => [['Code', r.code], ['Name', r.name], ['Legal entity', r.legalEntityName], ['State', stateName(r.stateCode)], ['Address', r.address]],
  },
  warehouses: {
    key: 'warehouses', api: '/warehouses', base: '/masters/warehouses', title: 'Warehouses', singular: 'Warehouse', perm: 'org.warehouse',
    subtitle: 'Godowns and storage locations (BRD p.14: WH-01 FG, WH-02 RM, WH-03 PM, WH-04 Lab).', schema: warehouseSchema,
    fields: [
      { name: 'legalEntityId', label: 'Legal entity', kind: 'ref', ref: 'legalEntity', required: true },
      { name: 'plantId', label: 'Plant (optional)', kind: 'ref', ref: 'plant' },
      { name: 'code', label: 'Code', kind: 'text', required: true, upper: true },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'type', label: 'Type', kind: 'select', options: WAREHOUSE_TYPES, required: true },
      { name: 'stateCode', label: 'State', kind: 'state' },
      { name: 'gstRegistrationId', label: 'GST registration', kind: 'ref', ref: 'gst', hint: 'Must be in the same state (D36 for Hyderabad)' },
      { name: 'address', label: 'Address', kind: 'textarea' },
    ],
    columns: [
      { key: 'code', header: 'Code', render: (r) => <span className="font-semibold">{r.code}</span> },
      { key: 'name', header: 'Name', render: (r) => r.name },
      { key: 'type', header: 'Type', render: (r) => r.type },
      { key: 'plant', header: 'Plant', render: (r) => r.plantName ?? '—' },
      { key: 'state', header: 'State', render: (r) => stateName(r.stateCode) },
      { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    ],
    details: (r) => [['Code', r.code], ['Name', r.name], ['Type', r.type], ['Legal entity', r.legalEntityName], ['Plant', r.plantName], ['State', stateName(r.stateCode)], ['GSTIN', r.gstin], ['Address', r.address]],
  },
};

export function MasterListPage({ c }: { c: MasterConfig }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can(`${c.perm}:create`) ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav(`${c.base}/new`)}>New {c.singular.toLowerCase()}</Button> : undefined;
  return (
    <>
      <PageHeader title={c.title} subtitle={c.subtitle} actions={create} />
      <DataTable<Row> queryKey={c.key} path={c.api} columns={c.columns} rowHref={(r) => `${c.base}/${r.id}`}
        statusOptions={['Draft', 'Submitted', 'Active', 'Rejected', 'Inactive']}
        empty={{ title: `No ${c.title.toLowerCase()} yet`, text: `Create the first ${c.singular.toLowerCase()} and submit it for approval.`, action: create }} />
    </>
  );
}

function GstRegistrations({ leId, editable }: { leId: string; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['gst', leId], queryFn: () => api<{ data: { id: string; gstin: string; stateCode: string; status: string }[] }>(`/legal-entities/${leId}/gst-registrations`) });
  const f = useForm<{ gstin: string; address?: string }>({ resolver: zodResolver(gstRegistrationSchema) });
  const add = useMutation({
    mutationFn: (v: { gstin: string; address?: string }) => api(`/legal-entities/${leId}/gst-registrations`, { body: v }),
    onSuccess: async () => { toast('success', 'GST registration added.'); setOpen(false); f.reset(); await qc.invalidateQueries({ queryKey: ['gst', leId] }); },
  });
  return (
    <Card title="GST registrations" actions={editable && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add GSTIN</Button>}>
      {q.data?.data.length ? (
        <ul className="divide-y divide-line">{q.data.data.map((g) => (
          <li key={g.id} className="flex items-center justify-between py-3"><span><span className="font-semibold num">{g.gstin}</span><span className="ml-3 text-ink-2">{stateName(g.stateCode)}</span></span><StatusBadge status={g.status} /></li>))}</ul>
      ) : <p className="text-ink-2">No GST registrations. {editable ? 'Add one per state where the entity is registered.' : ''}</p>}
      <Modal open={open} onClose={() => setOpen(false)} title="Add GST registration" description="The GSTIN must contain the legal entity's PAN (characters 3–12)."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.isPending} onClick={f.handleSubmit((v) => add.mutate(v))}>Add</Button></>}>
        <ErrorBanner error={add.error} />
        <div className="space-y-4">
          <Field label="GSTIN" htmlFor="gstin" required error={f.formState.errors.gstin?.message}><Input id="gstin" maxLength={15} className="uppercase num" {...f.register('gstin')} /></Field>
          <Field label="Address of principal place of business" htmlFor="gaddr"><Textarea id="gaddr" {...f.register('address')} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

export function MasterDetailPage({ c }: { c: MasterConfig }) {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: [c.key, id], queryFn: () => api<Row & { allowedActions: string[]; approvals: { id: string; doc_no: string; status: string; submitted_at: string; initiator: string }[] }>(`${c.api}/${id}`) });
  const [deactivate, setDeactivate] = useState(false);
  const act = useMutation({
    mutationFn: (path: string) => api<{ approvalDocNo?: string }>(`${c.api}/${id}/${path}`, { method: 'POST' }),
    onSuccess: async (r) => { toast('success', r?.approvalDocNo ? `Submitted for approval as ${r.approvalDocNo}.` : 'Done.'); await qc.invalidateQueries(); },
  });
  const r = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!r) return <ErrorBanner error={q.error} />;
  const a = r.allowedActions;
  return (
    <>
      <PageHeader title={`${r.code} — ${r.name}`} crumbs={<Link to={c.base} className="hover:text-primary">{c.title}</Link>}
        subtitle={<span className="inline-flex items-center gap-2"><StatusBadge status={r.status} /> <span>Version {r.version} · updated {fmtDateTime(r.updatedAt as string)}</span></span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`${c.base}/${id}/edit`)}>Edit</Button>}
          {a.includes('submit') && <Button loading={act.isPending} onClick={() => act.mutate('submit')}>Submit for approval</Button>}
          {a.includes('reactivate') && <Button loading={act.isPending} onClick={() => act.mutate('reactivate')}>Request reactivation</Button>}
          {a.includes('deactivate') && <Button variant="danger" onClick={() => setDeactivate(true)}>Deactivate</Button>}
        </>} />
      <ErrorBanner error={act.error} />
      {r.status === 'Submitted' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Waiting for approval. It cannot be edited until a decision is made.</div>}
      <div className="space-y-6">
        <Card title="Details"><KeyValues items={c.details(r)} /></Card>
        {c.key === 'legal-entities' && <GstRegistrations leId={r.id} editable={a.includes('edit')} />}
        <Card title="Approval history">
          {r.approvals.length === 0 ? <p className="text-ink-2">Not yet submitted.</p> : (
            <ul className="divide-y divide-line">{r.approvals.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <Link to={`/approvals/${x.id}`} className="font-semibold text-primary hover:text-primary-hover">{x.doc_no}</Link>
                <span className="text-ink-2">{x.initiator} · {fmtDateTime(x.submitted_at)}</span><StatusBadge status={x.status} />
              </li>))}</ul>
          )}
        </Card>
      </div>
      <ReasonDialog open={deactivate} danger title={`Deactivate ${c.singular.toLowerCase()}`} confirmLabel="Deactivate" onClose={() => setDeactivate(false)}
        description="It can no longer be used in new transactions. Reactivation needs a fresh approval."
        onConfirm={async (reason) => { await api(`${c.api}/${id}/deactivate`, { body: { reason } }); toast('success', 'Deactivated.'); await qc.invalidateQueries(); }} />
    </>
  );
}

function RefSelect({ kind, value, legalEntityId, ...rest }: { kind: 'legalEntity' | 'plant' | 'gst'; value?: string; legalEntityId?: string } & React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const path = kind === 'legalEntity' ? '/legal-entities?limit=100' : kind === 'plant' ? `/plants?limit=100&legalEntityId=${legalEntityId ?? ''}` : `/legal-entities/${legalEntityId}/gst-registrations`;
  const q = useQuery({ queryKey: ['ref', kind, legalEntityId], queryFn: () => api<Page<{ id: string; code?: string; name?: string; gstin?: string; status: string }>>(path), enabled: kind === 'legalEntity' || !!legalEntityId });
  const opts = (q.data?.data ?? []).filter((o) => o.status !== 'Inactive');
  return (
    <Select value={value ?? ''} {...rest}>
      <option value="">{kind === 'legalEntity' ? 'Select…' : '— None —'}</option>
      {opts.map((o) => <option key={o.id} value={o.id}>{o.gstin ?? `${o.code} — ${o.name}`}{o.status !== 'Active' ? ` (${o.status})` : ''}</option>)}
    </Select>
  );
}

export function MasterFormPage({ c }: { c: MasterConfig }) {
  const { id } = useParams();
  const editing = !!id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: [c.key, id], queryFn: () => api<Row>(`${c.api}/${id}`), enabled: editing });
  const [error, setError] = useState<unknown>(null);
  const required = new Set(c.fields.filter((x) => x.required).map((x) => x.name));
  const schema = z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? (required.has(k) ? undefined : null) : v])), c.schema);
  const f = useForm<Record<string, string>>({ resolver: zodResolver(schema), values: existing.data ? Object.fromEntries(c.fields.map((x) => [x.name, (existing.data[x.name] as string) ?? ''])) : undefined });
  const le = f.watch('legalEntityId');
  if (editing && existing.isLoading) return <Skeleton className="h-96" />;
  const submit = f.handleSubmit(async (v) => {
    setError(null);
    const body = v;
    try {
      if (editing) { await api(`${c.api}/${id}`, { method: 'PUT', body: { ...body, version: existing.data!.version } }); toast('success', 'Saved.'); await qc.invalidateQueries(); nav(`${c.base}/${id}`); }
      else { const r = await api<{ id: string }>(c.api, { body }); toast('success', `${c.singular} saved as Draft.`); nav(`${c.base}/${r.id}`); }
    } catch (e) {
      if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k, { message: m }));
      setError(e);
    }
  });
  return (
    <>
      <PageHeader title={editing ? `Edit ${c.singular.toLowerCase()}` : `New ${c.singular.toLowerCase()}`} crumbs={<Link to={c.base} className="hover:text-primary">{c.title}</Link>}
        subtitle="Saved as Draft. Submit it for approval from the detail page." />
      <Card className="max-w-4xl">
        <ErrorBanner error={error} />
        <form noValidate onSubmit={submit} className="grid gap-5 md:grid-cols-2">
          {c.fields.map((fd) => {
            const err = f.formState.errors[fd.name]?.message as string | undefined;
            const reg = f.register(fd.name, fd.upper ? { setValueAs: (v: string) => v?.toUpperCase() } : undefined);
            const control =
              fd.kind === 'textarea' ? <Textarea id={fd.name} invalid={!!err} {...reg} />
              : fd.kind === 'state' ? <Select id={fd.name} invalid={!!err} {...reg}><option value="">Select…</option>{Object.entries(INDIAN_STATES).map(([k, n]) => <option key={k} value={k}>{n} ({k})</option>)}</Select>
              : fd.kind === 'select' ? <Select id={fd.name} invalid={!!err} {...reg}><option value="">Select…</option>{fd.options!.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
              : fd.kind === 'ref' ? <RefSelect id={fd.name} kind={fd.ref!} legalEntityId={le} invalid={!!err} value={f.watch(fd.name)} {...reg} />
              : <Input id={fd.name} invalid={!!err} className={fd.upper ? 'uppercase' : undefined} {...reg} />;
            return <div key={fd.name} className={fd.kind === 'textarea' ? 'md:col-span-2' : undefined}><Field label={fd.label} htmlFor={fd.name} required={fd.required} error={err} hint={fd.hint}>{control}</Field></div>;
          })}
          <div className="flex gap-2 md:col-span-2">
            <Button type="submit" loading={f.formState.isSubmitting}>Save draft</Button>
            <Button type="button" variant="secondary" onClick={() => nav(-1)}>Cancel</Button>
          </div>
        </form>
      </Card>
    </>
  );
}
