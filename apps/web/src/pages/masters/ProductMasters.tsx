import { zodResolver } from '@hookform/resolvers/zod';
import { hsnSchema, LICENCE_TYPES, productCategorySchema, UOM_DIMENSIONS } from '@dhruv/contracts';
import { Plus, Warning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime } from '../../lib/format';

const th = 'px-5 py-3 font-medium';
const LICENCE_LABEL: Record<string, string> = { NONE: 'No licence', FERTILIZER: 'Fertilizer licence (FCO)', PESTICIDE: 'Pesticide licence (Insecticides Act)', BIOSTIMULANT: 'Bio-stimulant registration (FCO Sch. VI)' };

// ---------------------------------------------------------------- Units of measure
interface Uom { code: string; name: string; dimension: string; decimals: number; status: string }
interface Conv { id: string; itemId: string | null; itemCode: string | null; fromUom: string; toUom: string; factor: string }

export function UomPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['uom'], queryFn: () => api<{ data: Uom[]; conversions: Conv[] }>('/uom') });
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<{ id: string; code: string; name: string }>>('/items?limit=100&status=Active'), enabled: can('mdm.uom:configure') });
  const [unitOpen, setUnitOpen] = useState(false);
  const [convOpen, setConvOpen] = useState(false);
  const [unit, setUnit] = useState({ code: '', name: '', dimension: 'COUNT', decimals: 0 });
  const [conv, setConv] = useState({ fromUom: '', toUom: '', factor: '', itemId: '' });
  const addUnit = useMutation({ mutationFn: () => api('/uom', { body: unit }), onSuccess: async () => { toast('success', 'Unit added.'); setUnitOpen(false); await qc.invalidateQueries({ queryKey: ['uom'] }); } });
  const addConv = useMutation({ mutationFn: () => api('/uom/conversions', { body: { ...conv, factor: Number(conv.factor), itemId: conv.itemId || null } }),
    onSuccess: async () => { toast('success', 'Conversion added.'); setConvOpen(false); await qc.invalidateQueries({ queryKey: ['uom'] }); } });
  const units = q.data?.data ?? [];
  return (
    <>
      <PageHeader title="Units of Measure" subtitle="Physical units and conversions. Mass ↔ volume conversions are set per product because they depend on density."
        actions={can('mdm.uom:configure') && <><Button variant="secondary" onClick={() => setConvOpen(true)}>Add conversion</Button><Button icon={<Plus size={18} weight="bold" />} onClick={() => setUnitOpen(true)}>New unit</Button></>} />
      <ErrorBanner error={q.error} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Units" padded={false} className="overflow-hidden p-0">
          {q.isLoading ? <Skeleton className="m-5 h-40" /> : (
            <table className="w-full text-left"><thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className={th}>Code</th><th className={th}>Name</th><th className={th}>Dimension</th><th className={th}>Decimals</th></tr></thead>
              <tbody>{units.map((u) => <tr key={u.code} className="h-12 border-t border-line"><td className="px-5 font-semibold">{u.code}</td><td className="px-5">{u.name}</td><td className="px-5 text-ink-2">{u.dimension}</td><td className="px-5 num">{u.decimals}</td></tr>)}</tbody></table>
          )}
        </Card>
        <Card title="Conversions" padded={false} className="overflow-hidden p-0">
          <table className="w-full text-left"><thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className={th}>Applies to</th><th className={th}>Conversion</th></tr></thead>
            <tbody>{q.data?.conversions.map((c) => <tr key={c.id} className="h-12 border-t border-line"><td className="px-5">{c.itemCode ?? <span className="text-ink-2">All items</span>}</td><td className="px-5 num">1 {c.fromUom} = {Number(c.factor)} {c.toUom}</td></tr>)}</tbody></table>
        </Card>
      </div>
      <Modal open={unitOpen} onClose={() => setUnitOpen(false)} title="New unit" footer={<><Button variant="secondary" onClick={() => setUnitOpen(false)}>Cancel</Button><Button loading={addUnit.isPending} onClick={() => addUnit.mutate()}>Add</Button></>}>
        <ErrorBanner error={addUnit.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" htmlFor="ucode" required><Input id="ucode" className="uppercase" value={unit.code} onChange={(e) => setUnit({ ...unit, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name" htmlFor="uname" required><Input id="uname" value={unit.name} onChange={(e) => setUnit({ ...unit, name: e.target.value })} /></Field>
          <Field label="Dimension" htmlFor="udim" required><Select id="udim" value={unit.dimension} onChange={(e) => setUnit({ ...unit, dimension: e.target.value })}>{UOM_DIMENSIONS.map((d) => <option key={d}>{d}</option>)}</Select></Field>
          <Field label="Decimal places" htmlFor="udec" required><Input id="udec" type="number" min={0} max={6} value={unit.decimals} onChange={(e) => setUnit({ ...unit, decimals: Number(e.target.value) })} /></Field>
        </div>
      </Modal>
      <Modal open={convOpen} onClose={() => setConvOpen(false)} title="Add conversion" footer={<><Button variant="secondary" onClick={() => setConvOpen(false)}>Cancel</Button><Button loading={addConv.isPending} onClick={() => addConv.mutate()}>Add</Button></>}>
        <ErrorBanner error={addConv.error} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="1 ×" htmlFor="cfrom" required><Select id="cfrom" value={conv.fromUom} onChange={(e) => setConv({ ...conv, fromUom: e.target.value })}><option value="">Unit…</option>{units.map((u) => <option key={u.code}>{u.code}</option>)}</Select></Field>
          <Field label="equals" htmlFor="cfac" required><Input id="cfac" type="number" step="any" value={conv.factor} onChange={(e) => setConv({ ...conv, factor: e.target.value })} /></Field>
          <Field label="×" htmlFor="cto" required><Select id="cto" value={conv.toUom} onChange={(e) => setConv({ ...conv, toUom: e.target.value })}><option value="">Unit…</option>{units.map((u) => <option key={u.code}>{u.code}</option>)}</Select></Field>
        </div>
        <div className="mt-4"><Field label="For item (needed for kg ↔ litre)" htmlFor="citem"><Select id="citem" value={conv.itemId} onChange={(e) => setConv({ ...conv, itemId: e.target.value })}><option value="">All items</option>{items.data?.data.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}</Select></Field></div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- HSN & GST rates
interface Hsn { id: string; code: string; kind: string; description: string; status: string; currentRate: string | null; rateFrom: string | null }
interface HsnDetail extends Hsn { rates: { id: string; gstRate: string; cessRate: string; validFrom: string; validTo: string | null; notes: string; createdAt: string; createdBy: string }[]; canAddRate: boolean }

export function HsnPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['hsn', q], queryFn: () => api<{ data: Hsn[] }>(`/hsn-codes${q ? `?q=${encodeURIComponent(q)}` : ''}`), placeholderData: (p) => p });
  const [sel, setSel] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['hsn-detail', sel], queryFn: () => api<HsnDetail>(`/hsn-codes/${sel}`), enabled: !!sel });
  const [newOpen, setNewOpen] = useState(false);
  const [rate, setRate] = useState<{ gstRate: string; cessRate: string; validFrom: string } | null>(null);
  const f = useForm<{ code: string; kind: 'HSN' | 'SAC'; description: string }>({ resolver: zodResolver(hsnSchema), defaultValues: { kind: 'HSN' } });
  const add = useMutation({ mutationFn: (v: object) => api<{ id: string }>('/hsn-codes', { body: v }),
    onSuccess: async (r) => { toast('success', 'HSN code added. Add its GST rate next.'); setNewOpen(false); f.reset({ kind: 'HSN' }); setSel(r.id); await qc.invalidateQueries({ queryKey: ['hsn'] }); } });
  const d = detail.data;
  return (
    <>
      <PageHeader title="HSN Codes & GST Rates" subtitle="Rates are effective-dated and never overwritten. Confirm every rate with your tax adviser (D27): the BRD's sample rates predate the 2025 GST rate changes."
        actions={can('mdm.hsn:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setNewOpen(true)}>New HSN code</Button>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <div className="card overflow-hidden">
          <div className="border-b border-line p-4"><Input aria-label="Search HSN" placeholder="Search code or description" value={q} onChange={(e) => setQ(e.target.value)} className="h-11" /></div>
          {list.data?.data.length === 0 ? <EmptyState title="No HSN codes" text="Add the HSN codes your products and materials use." /> : (
            <table className="w-full text-left"><thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className={th}>Code</th><th className={th}>Description</th><th className={`${th} text-right`}>GST today</th></tr></thead>
              <tbody>{list.data?.data.map((h) => (
                <tr key={h.id} tabIndex={0} onClick={() => setSel(h.id)} onKeyDown={(e) => e.key === 'Enter' && setSel(h.id)} className={`h-14 cursor-pointer border-t border-line hover:bg-[#FAF9FF] ${sel === h.id ? 'bg-primary-tint' : ''}`}>
                  <td className="px-5 font-semibold num">{h.code}</td><td className="px-5">{h.description}</td>
                  <td className="px-5 text-right num">{h.currentRate !== null ? `${Number(h.currentRate)}%` : <span className="inline-flex items-center gap-1 text-warning-text"><Warning size={14} />Not set</span>}</td></tr>))}</tbody></table>
          )}
        </div>
        <Card title={d ? `${d.code} — rate history` : 'Rate history'} actions={d?.canAddRate && <Button size="sm" onClick={() => setRate({ gstRate: '', cessRate: '0', validFrom: new Date().toISOString().slice(0, 10) })}>Add rate</Button>}>
          {!sel ? <p className="text-ink-2">Select an HSN code to see its rates.</p> : !d ? <Skeleton className="h-32" /> : (
            <>
              <p className="mb-4 text-ink-2">{d.description}</p>
              {d.rates.length === 0 ? <p className="text-warning-text">No GST rate yet. It cannot be used on invoices until a rate is added.</p> : (
                <ol className="space-y-3">{d.rates.map((r) => (
                  <li key={r.id} className="rounded-md bg-canvas p-3">
                    <p className="flex items-center justify-between"><span className="text-[18px] font-bold num">{Number(r.gstRate)}%{Number(r.cessRate) ? ` + ${Number(r.cessRate)}% cess` : ''}</span>{!r.validTo && <StatusBadge status="Active" label="Current" />}</p>
                    <p className="text-[13px] text-ink-2">{fmtDate(r.validFrom)} → {r.validTo ? fmtDate(r.validTo) : 'open'}</p>
                    <p className="mt-1 text-[13px]">{r.notes}</p>
                    <p className="text-[12px] text-ink-2">{r.createdBy ?? 'system'}, {fmtDateTime(r.createdAt)}</p>
                  </li>))}</ol>
              )}
            </>
          )}
        </Card>
      </div>
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New HSN / SAC code" footer={<><Button variant="secondary" onClick={() => setNewOpen(false)}>Cancel</Button><Button loading={add.isPending} onClick={f.handleSubmit((v) => add.mutate(v))}>Add</Button></>}>
        <ErrorBanner error={add.error} />
        <div className="space-y-4">
          <Field label="Code" htmlFor="hcode" required error={f.formState.errors.code?.message}><Input id="hcode" inputMode="numeric" {...f.register('code')} /></Field>
          <Field label="Kind" htmlFor="hkind"><Select id="hkind" {...f.register('kind')}><option>HSN</option><option>SAC</option></Select></Field>
          <Field label="Description" htmlFor="hdesc" required error={f.formState.errors.description?.message}><Input id="hdesc" {...f.register('description')} /></Field>
        </div>
      </Modal>
      <ReasonDialog open={!!rate} title={`New GST rate for ${d?.code ?? ''}`} confirmLabel="Add rate" onClose={() => setRate(null)}
        description="The current rate is closed automatically the day before the new one starts."
        onConfirm={async (notes) => { await api(`/hsn-codes/${sel}/rates`, { body: { gstRate: Number(rate!.gstRate), cessRate: Number(rate!.cessRate || 0), validFrom: rate!.validFrom, notes } }); toast('success', 'Rate added.'); await qc.invalidateQueries(); }}>
        {rate && <div className="grid gap-4 sm:grid-cols-3">
          <Field label="GST %" htmlFor="rg" required><Input id="rg" type="number" step="any" value={rate.gstRate} onChange={(e) => setRate({ ...rate, gstRate: e.target.value })} /></Field>
          <Field label="Cess %" htmlFor="rc"><Input id="rc" type="number" step="any" value={rate.cessRate} onChange={(e) => setRate({ ...rate, cessRate: e.target.value })} /></Field>
          <Field label="Effective from" htmlFor="rf" required><Input id="rf" type="date" value={rate.validFrom} onChange={(e) => setRate({ ...rate, validFrom: e.target.value })} /></Field>
        </div>}
      </ReasonDialog>
    </>
  );
}

// ---------------------------------------------------------------- Product categories
interface Cat { id: string; code: string; name: string; licenceRequired: string; status: string; version: number; items: number }
export function CategoriesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['categories'], queryFn: () => api<{ data: Cat[] }>('/product-categories') });
  const [open, setOpen] = useState<null | 'new' | Cat>(null);
  const [reasonFor, setReasonFor] = useState<Record<string, unknown> | null>(null);
  const f = useForm<{ code: string; name: string; licenceRequired: string }>({ resolver: zodResolver(productCategorySchema) });
  const create = useMutation({ mutationFn: (v: object) => api('/product-categories', { body: v }), onSuccess: async () => { toast('success', 'Category added.'); setOpen(null); await qc.invalidateQueries({ queryKey: ['categories'] }); } });
  const openForm = (c: 'new' | Cat) => { create.reset(); f.reset(c === 'new' ? { licenceRequired: 'NONE' } : { code: c.code, name: c.name, licenceRequired: c.licenceRequired }); setOpen(c); };
  return (
    <>
      <PageHeader title="Product Categories" subtitle="Each category states which dealer licence is needed to buy it (BRD p.7). Mapping to be confirmed by your regulatory adviser (D08)."
        actions={can('mdm.product_category:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => openForm('new')}>New category</Button>} />
      <ErrorBanner error={q.error} />
      <div className="card overflow-hidden">
        {q.isLoading ? <Skeleton className="m-5 h-40" /> : !q.data?.data.length ? <EmptyState title="No categories yet" text="BRD examples: Micronutrient, Soil Nutrition, Biostimulant, Organic Soil Additive, Technical (active ingredient)." /> : (
          <table className="w-full text-left"><thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2"><th className={th}>Code</th><th className={th}>Name</th><th className={th}>Dealer licence needed</th><th className={th}>Items</th><th className={th}>Status</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{q.data.data.map((c) => (
              <tr key={c.id} className="h-14 border-t border-line"><td className="px-5 font-semibold">{c.code}</td><td className="px-5">{c.name}</td><td className="px-5">{LICENCE_LABEL[c.licenceRequired]}</td>
                <td className="px-5 num">{c.items}</td><td className="px-5"><StatusBadge status={c.status} /></td>
                <td className="px-5 text-right">{can('mdm.product_category:edit') && <Button size="sm" variant="ghost" onClick={() => openForm(c)}>Edit</Button>}</td></tr>))}</tbody></table>
        )}
      </div>
      <Modal open={!!open} onClose={() => setOpen(null)} title={open === 'new' ? 'New category' : 'Edit category'}
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button><Button loading={create.isPending} onClick={f.handleSubmit((v) => (open === 'new' ? create.mutate(v) : setReasonFor({ ...v, version: (open as Cat).version })))}>Save</Button></>}>
        <ErrorBanner error={create.error} />
        <div className="space-y-4">
          <Field label="Code" htmlFor="ccode" required error={f.formState.errors.code?.message}><Input id="ccode" className="uppercase" {...f.register('code', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>
          <Field label="Name" htmlFor="cname" required error={f.formState.errors.name?.message}><Input id="cname" {...f.register('name')} /></Field>
          <Field label="Dealer licence required" htmlFor="clic" required><Select id="clic" {...f.register('licenceRequired')}>{LICENCE_TYPES.map((l) => <option key={l} value={l}>{LICENCE_LABEL[l]}</option>)}</Select></Field>
        </div>
      </Modal>
      <ReasonDialog open={!!reasonFor} title="Reason for the change" confirmLabel="Save" onClose={() => setReasonFor(null)} description="Changing the licence rule affects which dealers can buy these products."
        onConfirm={async (reason) => { await api(`/product-categories/${(open as Cat).id}`, { method: 'PUT', body: { ...reasonFor, reason } }); toast('success', 'Saved.'); setOpen(null); await qc.invalidateQueries({ queryKey: ['categories'] }); }} />
    </>
  );
}
