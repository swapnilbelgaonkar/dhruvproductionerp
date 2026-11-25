import { Plus, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, Modal, Select } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtINR } from '../../lib/format';

interface Slab { minQty: number | string; discountPct: number | string }
interface PriceRow { id: string; itemPackId: string; itemCode: string; itemName: string; packCode: string; packSize: string; packUom: string; container: string; rate: string; slabs: Slab[] }
interface SaleablePack { id: string; itemCode: string; itemName: string; packCode: string; packSize: string; packUom: string; container: string }

export const packLabel = (p: { packSize: string | number; packUom: string; container: string | null }) => `${Number(p.packSize)} ${p.packUom}${p.container ? ` ${p.container}` : ''}`;

/** Prices and volume slabs of a price list; editable while the list is Draft or Rejected. */
export function PriceListItems({ listId, editable }: { listId: string; editable: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const items = useQuery({ queryKey: ['price-list-items', listId], queryFn: () => api<{ data: PriceRow[] }>(`/price-lists/${listId}/items`) });
  const packs = useQuery({ queryKey: ['saleable-packs'], queryFn: () => api<{ data: SaleablePack[] }>('/price-lists/saleable-packs'), enabled: editable });
  const [edit, setEdit] = useState<{ itemPackId: string; rate: string; slabs: { minQty: string; discountPct: string }[] } | null>(null);
  const save = useMutation({
    mutationFn: () => api(`/price-lists/${listId}/items`, { body: {
      itemPackId: edit!.itemPackId, rate: Number(edit!.rate),
      slabs: edit!.slabs.filter((s) => s.minQty !== '' || s.discountPct !== '').map((s) => ({ minQty: Number(s.minQty), discountPct: Number(s.discountPct) })),
    } }),
    onSuccess: async () => { toast('success', 'Price saved.'); setEdit(null); await qc.invalidateQueries(); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/price-lists/${listId}/items/${id}/remove`, { method: 'POST' }),
    onSuccess: async () => { toast('success', 'Price removed.'); await qc.invalidateQueries(); },
  });
  const rows = items.data?.data ?? [];
  const open = (r?: PriceRow) => { save.reset(); setEdit(r
    ? { itemPackId: r.itemPackId, rate: String(Number(r.rate)), slabs: r.slabs.map((s) => ({ minQty: String(Number(s.minQty)), discountPct: String(Number(s.discountPct)) })) }
    : { itemPackId: '', rate: '', slabs: [] }); };
  const setSlab = (i: number, k: 'minQty' | 'discountPct', v: string) => setEdit((e) => e && { ...e, slabs: e.slabs.map((s, j) => (j === i ? { ...s, [k]: v } : s)) });
  return (
    <Card title="Prices" padded={false}
      actions={editable && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => open()}>Add price</Button>}>
      <ErrorBanner error={remove.error} />
      {rows.length === 0 ? <p className="px-5 py-4 text-ink-2">{editable ? 'No prices yet. Add the rate per pack before submitting.' : 'No prices in this list.'}</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Product</th><th className="px-3 py-3">Pack</th><th className="px-3 py-3 text-right">Rate per pack (before GST)</th><th className="px-3 py-3">Volume slabs</th>{editable && <th className="px-5 py-3" />}
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><span className="font-semibold">{r.itemCode}</span> <span className="text-ink-2">{r.itemName}</span></td>
                <td className="px-3 py-3">{packLabel(r)}</td>
                <td className="px-3 py-3 text-right num">{fmtINR(r.rate)}</td>
                <td className="px-3 py-3 text-ink-2">{r.slabs.length ? r.slabs.map((s) => `${Number(s.minQty)}+ packs: ${Number(s.discountPct)}% off`).join(' · ') : '—'}</td>
                {editable && <td className="whitespace-nowrap px-5 py-3 text-right">
                  <Button size="sm" variant="ghost" onClick={() => open(r)}>Edit</Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${r.itemCode} ${packLabel(r)}`} loading={remove.isPending && remove.variables === r.id} onClick={() => remove.mutate(r.id)}><Trash size={16} /></Button>
                </td>}
              </tr>))}</tbody>
          </table>
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Price per pack" description="Rates are before GST. GST is added on the quotation from the HSN rate."
        footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button>
          <Button loading={save.isPending} disabled={!edit?.itemPackId || !(Number(edit?.rate) > 0)} onClick={() => save.mutate()}>Save price</Button></>}>
        {edit && <>
          <ErrorBanner error={save.error} />
          <div className="grid gap-4">
            <Field label="Product pack" htmlFor="pl-pack" required>
              <Select id="pl-pack" value={edit.itemPackId} onChange={(e) => setEdit({ ...edit, itemPackId: e.target.value })}>
                <option value="">Select…</option>
                {(packs.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.itemCode} — {p.itemName} · {packLabel(p)}</option>)}
                {/* keep the current pack selectable while editing even if the pick list has not loaded */}
                {edit.itemPackId && !packs.data?.data.some((p) => p.id === edit.itemPackId) && <option value={edit.itemPackId}>Current pack</option>}
              </Select>
            </Field>
            <Field label="Rate per pack (₹, before GST)" htmlFor="pl-rate" required>
              <Input id="pl-rate" type="number" step="0.01" min="0" inputMode="decimal" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} />
            </Field>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-medium">Volume slabs (scheme discount)</span>
                <Button size="sm" variant="ghost" icon={<Plus size={14} />} disabled={edit.slabs.length >= 10} onClick={() => setEdit({ ...edit, slabs: [...edit.slabs, { minQty: '', discountPct: '' }] })}>Add slab</Button>
              </div>
              {edit.slabs.length === 0 && <p className="text-[13px] text-ink-2">None. Dealers pay the list rate at every quantity.</p>}
              {edit.slabs.map((s, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                  <Field label="From quantity (packs)" htmlFor={`slab-q-${i}`}><Input id={`slab-q-${i}`} type="number" min="0" value={s.minQty} onChange={(e) => setSlab(i, 'minQty', e.target.value)} /></Field>
                  <Field label="Discount %" htmlFor={`slab-d-${i}`}><Input id={`slab-d-${i}`} type="number" step="0.01" min="0" max="99.99" value={s.discountPct} onChange={(e) => setSlab(i, 'discountPct', e.target.value)} /></Field>
                  <Button size="sm" variant="ghost" aria-label={`Remove slab ${i + 1}`} onClick={() => setEdit({ ...edit, slabs: edit.slabs.filter((_, j) => j !== i) })}><Trash size={16} /></Button>
                </div>))}
            </div>
          </div>
        </>}
      </Modal>
    </Card>
  );
}

/** "Copy as new version": the way to change prices of an active list. */
export function PriceListCopy({ list }: { list: { id: string; code: string; name: string; priceGroup?: unknown } }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ code: '', name: '', validFrom: '', validTo: '' });
  const copy = useMutation({
    mutationFn: () => api<{ id: string }>(`/price-lists/${list.id}/copy`, { body: { code: v.code, name: v.name, priceGroup: list.priceGroup, validFrom: v.validFrom, validTo: v.validTo || null } }),
    onSuccess: (r) => { toast('success', 'Copied as a Draft. Change the prices, then submit.'); setOpen(false); nav(`/sales/price-lists/${r.id}`); },
  });
  if (!can('sales.price_list:create')) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => { setV({ code: '', name: `${list.name} (revised)`, validFrom: '', validTo: '' }); copy.reset(); setOpen(true); }}>Copy as new version</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Copy as new version" description="All prices and slabs are copied into a new Draft for the same price group."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={copy.isPending} disabled={!v.code || !v.name || !v.validFrom} onClick={() => copy.mutate()}>Copy</Button></>}>
        <ErrorBanner error={copy.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New code" htmlFor="cp-code" required><Input id="cp-code" className="uppercase" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name" htmlFor="cp-name" required><Input id="cp-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="Valid from" htmlFor="cp-from" required hint="Must be later than the current list’s start. On approval the current list closes the day before."><Input id="cp-from" type="date" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} /></Field>
          <Field label="Valid to (optional)" htmlFor="cp-to"><Input id="cp-to" type="date" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} /></Field>
        </div>
      </Modal>
    </>
  );
}
