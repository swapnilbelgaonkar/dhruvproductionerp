import { zodResolver } from '@hookform/resolvers/zod';
import { gstRegistrationSchema, INDIAN_STATES, ITEM_TYPES, itemPackSchema, itemSchema, legalEntitySchema, plantSchema, WAREHOUSE_TYPES, warehouseSchema } from '@dhruv/contracts';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { Plus } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { forwardRef, useState, type ReactNode } from 'react';
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

type RefKind = 'legalEntity' | 'plant' | 'gst' | 'category' | 'hsn' | 'uom';
interface FieldDef { name: string; label: string; kind: 'text' | 'textarea' | 'state' | 'select' | 'ref' | 'number' | 'checkbox'; required?: boolean; hint?: string; options?: readonly string[]; ref?: RefKind; upper?: boolean; defaultValue?: unknown }
export interface MasterConfig {
  key: string; api: string; base: string; title: string; singular: string; perm: string; subtitle: string; entityType: string;
  schema: ZodObject<ZodRawShape>; fields: FieldDef[]; columns: Column<Row>[]; details: (r: Row) => [string, ReactNode][];
}

const stateName = (c?: string | number | null) => (c ? `${INDIAN_STATES[String(c)] ?? 'Unknown'} (${c})` : '—');

export const MASTERS: Record<string, MasterConfig> = {
  legalEntities: {
    key: 'legal-entities', entityType: 'org.legal_entity', api: '/legal-entities', base: '/masters/legal-entities', title: 'Legal Entities', singular: 'Legal entity', perm: 'org.legal_entity',
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
    key: 'plants', entityType: 'org.plant', api: '/plants', base: '/masters/plants', title: 'Plants', singular: 'Plant', perm: 'org.plant',
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
    key: 'warehouses', entityType: 'org.warehouse', api: '/warehouses', base: '/masters/warehouses', title: 'Warehouses', singular: 'Warehouse', perm: 'org.warehouse',
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
  items: {
    key: 'items', entityType: 'mdm.item', api: '/items', base: '/products/items', title: 'Items & Products', singular: 'Item', perm: 'mdm.item',
    subtitle: 'Finished goods, raw materials and packaging. Only approved items can be used in quotations, orders and stock.', schema: itemSchema,
    fields: [
      { name: 'code', label: 'Item code', kind: 'text', required: true, upper: true, hint: 'e.g. PRD-CHEL-01 (BRD p.9)' },
      { name: 'name', label: 'Name', kind: 'text', required: true },
      { name: 'itemType', label: 'Type', kind: 'select', options: ITEM_TYPES, required: true, hint: 'FG finished good · RM raw material · PM packaging' },
      { name: 'categoryId', label: 'Product category', kind: 'ref', ref: 'category', hint: 'Decides which dealer licence is needed' },
      { name: 'baseUom', label: 'Base unit', kind: 'ref', ref: 'uom', required: true },
      { name: 'hsnId', label: 'HSN code', kind: 'ref', ref: 'hsn' },
      { name: 'shelfLifeDays', label: 'Shelf life (days)', kind: 'number', hint: 'Required for FG and RM' },
      { name: 'storageClass', label: 'Storage class', kind: 'text', hint: 'e.g. Cool & dry, Flammable' },
      { name: 'formulation', label: 'Formulation / technical description', kind: 'textarea' },
      { name: 'lotControlled', label: 'Lot / batch controlled', kind: 'checkbox', defaultValue: true },
      { name: 'serialControlled', label: 'Box serial (QR) controlled', kind: 'checkbox' },
      { name: 'hazardous', label: 'Hazardous material', kind: 'checkbox' },
    ],
    columns: [
      { key: 'code', header: 'Code', render: (r) => <span className="font-semibold">{r.code}</span> },
      { key: 'name', header: 'Name', render: (r) => r.name },
      { key: 'type', header: 'Type', render: (r) => r.itemType },
      { key: 'cat', header: 'Category', render: (r) => r.categoryName ?? '—' },
      { key: 'hsn', header: 'HSN', render: (r) => <span className="num">{r.hsnCode ?? '—'}</span> },
      { key: 'packs', header: 'Packs', render: (r) => <span className="num">{r.packCount}</span> },
      { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    ],
    details: (r) => [['Code', r.code], ['Name', r.name], ['Type', r.itemType], ['Category', r.categoryName ? `${r.categoryName} (licence: ${r.licenceRequired})` : '—'], ['Base unit', r.baseUom],
      ['HSN', r.hsnCode], ['Shelf life', r.shelfLifeDays ? `${r.shelfLifeDays} days` : '—'], ['Storage class', r.storageClass],
      ['Controls', [r.lotControlled && 'Lot', r.serialControlled && 'Box serial', r.hazardous && 'Hazardous'].filter(Boolean).join(' · ') || '—'], ['Formulation', r.formulation]],
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

interface Pack { id: string; packCode: string; packSize: string; packUom: string; container: string; unitsPerBox: number; gtin: string | null; status: string }

function ItemPacks({ itemId, packs, editable }: { itemId: string; packs: Pack[]; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState<Pack | null>(null);
  const f = useForm<Record<string, unknown>>({ resolver: zodResolver(itemPackSchema), defaultValues: { unitsPerBox: 1, packUom: 'KG' } });
  const add = useMutation({
    mutationFn: (v: Record<string, unknown>) => api(`/items/${itemId}/packs`, { body: v }),
    onSuccess: async () => { toast('success', 'Pack size added.'); setOpen(false); f.reset({ unitsPerBox: 1, packUom: 'KG' }); await qc.invalidateQueries(); },
  });
  const num = { setValueAs: (v: string) => (v === '' ? undefined : Number(v)) };
  const err = (k: string) => f.formState.errors[k]?.message as string | undefined;
  return (
    <Card title="Pack sizes (SKUs)" actions={editable && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add pack</Button>}>
      {packs.length === 0 ? <p className="text-ink-2">No pack sizes yet. Finished goods need at least one before approval.</p> : (
        <ul className="divide-y divide-line">{packs.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
            <span className="w-28 font-semibold">{p.packCode}</span>
            <span className="flex-1 text-ink-2 num">{Number(p.packSize)} {p.packUom} {p.container} · {p.unitsPerBox} per box{p.gtin ? ` · GTIN ${p.gtin}` : ''}</span>
            <StatusBadge status={p.status} />
            {editable && p.status === 'Active' && <Button size="sm" variant="ghost" onClick={() => setRemove(p)}>Remove</Button>}
          </li>))}</ul>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add pack size"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.isPending} onClick={f.handleSubmit((v) => add.mutate(v))}>Add</Button></>}>
        <ErrorBanner error={add.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Pack code" htmlFor="pcode" required error={err('packCode')} hint="e.g. 1KG, 25KG"><Input id="pcode" className="uppercase" {...f.register('packCode', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>
          <Field label="Container" htmlFor="pcont" required error={err('container')} hint="Pouch, Bag, Bucket, Drum…"><Input id="pcont" {...f.register('container')} /></Field>
          <Field label="Pack size" htmlFor="psize" required error={err('packSize')}><Input id="psize" type="number" step="any" {...f.register('packSize', num)} /></Field>
          <Field label="Unit" htmlFor="puom" required error={err('packUom')}><RefSelect id="puom" kind="uom" value={f.watch('packUom') as string} {...f.register('packUom')} /></Field>
          <Field label="Units per box" htmlFor="pbox" required error={err('unitsPerBox')}><Input id="pbox" type="number" {...f.register('unitsPerBox', num)} /></Field>
          <Field label="GTIN / barcode (optional)" htmlFor="pgtin" error={err('gtin')}><Input id="pgtin" inputMode="numeric" {...f.register('gtin', { setValueAs: (v: string) => v || null })} /></Field>
        </div>
      </Modal>
      <ReasonDialog open={!!remove} title={`Remove pack ${remove?.packCode ?? ''}`} confirmLabel="Remove" danger onClose={() => setRemove(null)}
        onConfirm={async (reason) => { await api(`/items/${itemId}/packs/${remove!.id}/deactivate`, { body: { reason } }); toast('success', 'Pack removed.'); await qc.invalidateQueries(); }} />
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
        {c.key === 'items' && <ItemPacks itemId={r.id} packs={(r as unknown as { packs: Pack[] }).packs} editable={a.includes('edit')} />}
        <DocumentsPanel entityType={c.entityType} entityId={r.id} />
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

const REF_PATH: Record<RefKind, (le?: string) => string> = {
  legalEntity: () => '/legal-entities?limit=100', plant: (le) => `/plants?limit=100&legalEntityId=${le ?? ''}`, gst: (le) => `/legal-entities/${le}/gst-registrations`,
  category: () => '/product-categories', hsn: () => '/hsn-codes', uom: () => '/uom',
};
type RefOpt = { id?: string; code?: string; name?: string; gstin?: string; description?: string; status: string };

const RefSelect = forwardRef<HTMLSelectElement, { kind: RefKind; value?: string; legalEntityId?: string } & React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function RefSelect({ kind, value, legalEntityId, ...rest }, ref) {
  const needsLe = kind === 'plant' || kind === 'gst';
  const q = useQuery({ queryKey: ['ref', kind, needsLe ? legalEntityId : null], queryFn: () => api<Page<RefOpt>>(REF_PATH[kind](legalEntityId)), enabled: !needsLe || !!legalEntityId });
  const opts = (q.data?.data ?? []).filter((o) => o.status !== 'Inactive');
  const label = (o: RefOpt) => o.gstin ?? (kind === 'hsn' ? `${o.code} — ${o.description}` : kind === 'uom' ? `${o.code} — ${o.name}` : `${o.code} — ${o.name}`);
  return (
    <Select ref={ref} value={value ?? ''} {...rest}>
      <option value="">{['legalEntity', 'uom'].includes(kind) ? 'Select…' : '— None —'}</option>
      {opts.map((o) => <option key={o.id ?? o.code} value={kind === 'uom' ? o.code : o.id}>{label(o)}{o.status !== 'Active' ? ` (${o.status})` : ''}</option>)}
    </Select>
  );
});

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
  const f = useForm<Record<string, unknown>>({
    resolver: zodResolver(schema),
    defaultValues: Object.fromEntries(c.fields.map((x) => [x.name, x.defaultValue ?? (x.kind === 'checkbox' ? false : '')])),
    values: existing.data ? Object.fromEntries(c.fields.map((x) => [x.name, existing.data[x.name] ?? (x.kind === 'checkbox' ? false : '')])) : undefined,
  });
  const le = f.watch('legalEntityId') as string | undefined;
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
            const reg = f.register(fd.name, fd.upper ? { setValueAs: (v: string) => v?.toUpperCase() } : fd.kind === 'number' ? { setValueAs: (v: string) => (v === '' || v === null ? '' : Number(v)) } : undefined);
            if (fd.kind === 'checkbox') {
              return <label key={fd.name} className="flex items-center gap-3 self-end py-3 text-[14px]"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" {...reg} />{fd.label}{fd.hint && <span className="text-[12px] text-ink-2">— {fd.hint}</span>}</label>;
            }
            const control =
              fd.kind === 'textarea' ? <Textarea id={fd.name} invalid={!!err} {...reg} />
              : fd.kind === 'state' ? <Select id={fd.name} invalid={!!err} {...reg}><option value="">Select…</option>{Object.entries(INDIAN_STATES).map(([k, n]) => <option key={k} value={k}>{n} ({k})</option>)}</Select>
              : fd.kind === 'select' ? <Select id={fd.name} invalid={!!err} {...reg}><option value="">Select…</option>{fd.options!.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
              : fd.kind === 'ref' ? <RefSelect id={fd.name} kind={fd.ref!} legalEntityId={le} invalid={!!err} value={(f.watch(fd.name) as string) ?? ''} {...reg} />
              : fd.kind === 'number' ? <Input id={fd.name} type="number" inputMode="numeric" invalid={!!err} {...reg} />
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
