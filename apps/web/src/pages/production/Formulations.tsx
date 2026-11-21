import { Copy, Plus, Trash } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DataTable, type Column } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';

interface BomRow { id: string; code: string; name: string; status: string; itemCode: string; itemName: string; itemType: string; currentVersion: number | null; batchSize: string | null;
  batchUom: string | null; standardYieldPct: string | null; effectiveFrom: string | null; versionCount: number; pendingCount: number; ingredientCount: number }
interface VersionRow { id: string; versionNo: number; batchSize: string; batchUom: string; standardYieldPct: string; effectiveFrom: string; effectiveTo: string | null; changeNote: string;
  status: string; state: string; statusReason: string | null; approvedAt: string | null; createdBy: string; createdAt: string; ingredientCount?: number; version: number;
  reactionTempC: string | null; reactionTimeMin: number | null; processNotes: string | null }
interface BomDetail { id: string; code: string; name: string; itemId: string; itemCode: string; itemName: string; itemType: string; itemUom: string; status: string; versions: VersionRow[]; canCreateVersion: boolean }
interface Alt { itemId: string; itemCode: string; itemName: string; factor: number; notes: string | null }
interface VLine { id: string; lineNo: number; stepNo: number; itemId: string; itemCode: string; itemName: string; itemType: string; qty: string; uom: string; tolerancePct: string; notes: string | null; alternates: Alt[] }
interface VersionDetail extends VersionRow { bom: BomDetail; lines: VLine[]; inputTotal: number; allowedActions: string[];
  approval: { id: string; docNo: string; status: string; ruleName: string; steps: { seq: number; label: string; status: string }[] | null } | null }
interface Item { id: string; code: string; name: string; itemType: string; baseUom: string }

/** Version state: approved versions are Current, Scheduled (future date) or Superseded; others show their workflow status. */
const StateBadge = ({ s }: { s: string }) => <StatusBadge status={s === 'Current' ? 'Active' : s === 'Scheduled' ? 'Issued' : s === 'Withdrawn' ? 'Cancelled' : s} label={s} />;

const columns: Column<BomRow>[] = [
  { key: 'code', header: 'Formulation', render: (r) => <span><span className="block font-semibold">{r.code}</span><span className="text-[13px] text-ink-2">{r.name}</span></span> },
  { key: 'item', header: 'Produces', render: (r) => <span><span className="block">{r.itemCode}</span><span className="text-[13px] text-ink-2">{r.itemName}</span></span> },
  { key: 'ver', header: 'Version in force', render: (r) => (r.currentVersion ? <span className="num">v{r.currentVersion} · since {fmtDate(r.effectiveFrom)}</span> : <span className="text-warning-text">None — cannot be produced</span>) },
  { key: 'batch', header: 'Batch', className: 'text-right', render: (r) => (r.batchSize ? <span className="num">{fmtNum(Number(r.batchSize))} {r.batchUom}</span> : '—') },
  { key: 'yield', header: 'Std. yield', className: 'text-right', render: (r) => (r.standardYieldPct ? <span className="num">{fmtNum(Number(r.standardYieldPct))}%</span> : '—') },
  { key: 'ing', header: 'Ingredients', className: 'text-right', render: (r) => <span className="num">{r.currentVersion ? r.ingredientCount : '—'}</span> },
  { key: 'status', header: 'Status', render: (r) => (r.pendingCount ? <StatusBadge status="Pending" label="Version pending approval" /> : <StatusBadge status={r.status} />) },
];

export function FormulationsPage() {
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  const create = can('mfg.bom:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => setCreating(true)}>New formulation</Button> : undefined;
  return (
    <>
      <PageHeader title="Formulations (BOM)" subtitle="The recipe for each product per batch: ingredients and their dosing tolerance, approved substitutes, process conditions and standard yield. A version takes effect only after the plant head and QA approve it." actions={create} />
      <DataTable<BomRow> queryKey="boms" path="/boms" columns={columns} rowHref={(r) => `/production/formulations/${r.id}`}
        statusOptions={['Active', 'Inactive', 'Pending', 'No current version']} searchPlaceholder="Search formulation or product"
        empty={{ title: 'No formulations yet', text: 'Create a formulation for each finished or semi-finished product, then add its first version.', action: create }} />
      {creating && <NewFormulationDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewFormulationDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<Item>>('/items?status=Active&limit=100') });
  const existing = useQuery({ queryKey: ['boms-all'], queryFn: () => api<Page<BomRow>>('/boms?limit=100') });
  const [f, setF] = useState({ itemId: '', code: '', name: '' });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const taken = new Set((existing.data?.data ?? []).map((b) => b.itemCode));
  const outputs = (items.data?.data ?? []).filter((i) => ['FG', 'SEMI'].includes(i.itemType) && !taken.has(i.code));
  const save = async () => {
    setSaving(true); setError(null);
    try { const r = await api<{ id: string }>('/boms', { body: f }); toast('success', 'Formulation created. Add its first version.'); nav(`/production/formulations/${r.id}/versions/new`); }
    catch (e) { setError(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title="New formulation" description="One formulation per product. Its recipe is kept in versions."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} disabled={!f.itemId || !f.code || !f.name} onClick={save}>Create</Button></>}>
      <ErrorBanner error={error} />
      <div className="space-y-4">
        <Field label="Product made" htmlFor="bom-item" required hint="Approved finished or semi-finished items without a formulation">
          <Select id="bom-item" value={f.itemId} onChange={(e) => { const it = outputs.find((x) => x.id === e.target.value); setF({ itemId: e.target.value, code: f.code || (it ? `F-${it.code}`.slice(0, 20) : ''), name: f.name || (it ? `${it.name} formulation` : '') }); }}>
            <option value="">Select…</option>{outputs.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name} ({i.itemType})</option>)}</Select></Field>
        <Field label="Formulation code" htmlFor="bom-code" required><Input id="bom-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="bom-name" required><Input id="bom-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- formulation and its versions
export function FormulationDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['bom', id], queryFn: () => api<BomDetail>(`/boms/${id}`) });
  if (q.isLoading) return <Skeleton className="h-96" />;
  const b = q.data;
  if (!b) return <ErrorBanner error={q.error} />;
  const open = b.versions.find((v) => ['Draft', 'Submitted', 'Rejected'].includes(v.status));
  const base = b.versions.find((v) => v.state === 'Current') ?? b.versions.find((v) => v.status === 'Approved') ?? b.versions[0];
  return (
    <>
      <PageHeader title={b.code} crumbs={<Link to="/production/formulations" className="hover:text-primary">Formulations</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={b.status} /><span>{b.name} · produces {b.itemCode} — {b.itemName}</span></span>}
        actions={b.canCreateVersion && !open && <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav(`/production/formulations/${id}/versions/new${base ? `?from=${base.id}` : ''}`)}>
          {b.versions.length ? 'New version' : 'Add first version'}</Button>} />
      {open && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">Version {open.versionNo} is {open.status === 'Submitted' ? 'awaiting approval' : `in ${open.status.toLowerCase()}`}. Finish or withdraw it before starting another.</div>}
      <Card title="Versions" padded={false}>
        {!b.versions.length ? <div className="p-5"><EmptyState title="No versions yet" text="Add the first version with the ingredients per batch. It can be produced once the plant head and QA approve it." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Version</th><th className="px-3 py-3">Effective</th><th className="px-3 py-3 text-right">Batch</th><th className="px-3 py-3 text-right">Std. yield</th>
              <th className="px-3 py-3 text-right">Ingredients</th><th className="px-3 py-3">Change</th><th className="px-3 py-3">State</th></tr></thead>
            <tbody>{b.versions.map((v) => (
              <tr key={v.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface-2" onClick={() => nav(`/production/formulations/${id}/versions/${v.id}`)}>
                <td className="px-5 py-3"><Link className="font-semibold text-primary" to={`/production/formulations/${id}/versions/${v.id}`} onClick={(e) => e.stopPropagation()}>v{v.versionNo}</Link></td>
                <td className="px-3 py-3 num">{fmtDate(v.effectiveFrom)}{v.effectiveTo ? ` – ${fmtDate(v.effectiveTo)}` : ' onwards'}</td>
                <td className="px-3 py-3 text-right num">{fmtNum(Number(v.batchSize))} {v.batchUom}</td><td className="px-3 py-3 text-right num">{fmtNum(Number(v.standardYieldPct))}%</td>
                <td className="px-3 py-3 text-right num">{v.ingredientCount}</td><td className="px-3 py-3"><span className="block max-w-[320px] truncate">{v.changeNote}</span><span className="text-[12px] text-ink-2">{v.createdBy}</span></td>
                <td className="px-3 py-3"><StateBadge s={v.state} /></td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- version editor
interface DraftAlt { key: number; itemId: string; factor: string; notes: string }
interface DraftLine { key: number; stepNo: string; itemId: string; qty: string; tolerancePct: string; notes: string; alternates: DraftAlt[] }
let k = 0;
const blank = (step = 1): DraftLine => ({ key: ++k, stepNo: String(step), itemId: '', qty: '', tolerancePct: '2', notes: '', alternates: [] });
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function FormulationVersionFormPage() {
  const { id, vid } = useParams();
  const [sp] = useSearchParams();
  const from = sp.get('from');
  const editing = !!vid;
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const bom = useQuery({ queryKey: ['bom', id], queryFn: () => api<BomDetail>(`/boms/${id}`) });
  const src = useQuery({ queryKey: ['bom-version', id, vid ?? from], enabled: !!(vid ?? from), queryFn: () => api<VersionDetail>(`/boms/${id}/versions/${vid ?? from}`) });
  const items = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<Item>>('/items?status=Active&limit=100') });
  const [h, setH] = useState({ batchSize: '', standardYieldPct: '', reactionTempC: '', reactionTimeMin: '', effectiveFrom: todayISO(), changeNote: '', processNotes: '' });
  const [lines, setLines] = useState<DraftLine[]>([blank()]);
  const [loaded, setLoaded] = useState(!(vid ?? from));
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (loaded || !src.data) return;
    const v = src.data;
    setH({ batchSize: String(Number(v.batchSize)), standardYieldPct: String(Number(v.standardYieldPct)), reactionTempC: v.reactionTempC ? String(Number(v.reactionTempC)) : '',
      reactionTimeMin: v.reactionTimeMin ? String(v.reactionTimeMin) : '', effectiveFrom: editing ? v.effectiveFrom : todayISO(), changeNote: editing ? v.changeNote : '', processNotes: v.processNotes ?? '' });
    setLines(v.lines.map((l) => ({ key: ++k, stepNo: String(l.stepNo), itemId: l.itemId, qty: String(Number(l.qty)), tolerancePct: String(Number(l.tolerancePct)), notes: l.notes ?? '',
      alternates: l.alternates.map((a) => ({ key: ++k, itemId: a.itemId, factor: String(a.factor), notes: a.notes ?? '' })) })));
    setLoaded(true);
  }, [src.data, loaded, editing]);
  const inputs = useMemo(() => (items.data?.data ?? []).filter((i) => ['RM', 'SEMI'].includes(i.itemType)), [items.data]);
  const itemById = useMemo(() => new Map((items.data?.data ?? []).map((i) => [i.id, i])), [items.data]);
  if (bom.isLoading || !loaded) return <Skeleton className="h-96" />;
  const b = bom.data;
  if (!b) return <ErrorBanner error={bom.error} />;
  if (editing && src.data && !src.data.allowedActions.includes('edit')) return <Card><EmptyState title="This version cannot be edited" text={`It is ${src.data.status}. Start a new version instead.`} /></Card>;
  const setLine = (key: number, patch: Partial<DraftLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const dup = new Set(lines.map((l) => l.itemId).filter((x, i, a) => x && a.indexOf(x) !== i));
  const sameUnit = lines.filter((l) => itemById.get(l.itemId)?.baseUom === b.itemUom).reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const expected = (Number(h.batchSize) || 0);
  const valid = Number(h.batchSize) > 0 && Number(h.standardYieldPct) > 0 && Number(h.standardYieldPct) <= 100 && h.effectiveFrom && h.changeNote.trim()
    && lines.some((l) => l.itemId && Number(l.qty) > 0) && dup.size === 0 && lines.every((l) => !l.itemId || l.tolerancePct !== '');
  const save = async () => {
    setError(null); setSaving(true);
    const body = {
      batchSize: Number(h.batchSize), standardYieldPct: Number(h.standardYieldPct), reactionTempC: h.reactionTempC === '' ? null : Number(h.reactionTempC),
      reactionTimeMin: h.reactionTimeMin === '' ? null : Number(h.reactionTimeMin), effectiveFrom: h.effectiveFrom, changeNote: h.changeNote, processNotes: h.processNotes || null,
      lines: lines.filter((l) => l.itemId && Number(l.qty) > 0).map((l) => ({ stepNo: Number(l.stepNo) || 1, itemId: l.itemId, qty: Number(l.qty), tolerancePct: Number(l.tolerancePct), notes: l.notes || null,
        alternates: l.alternates.filter((a) => a.itemId).map((a) => ({ itemId: a.itemId, factor: Number(a.factor) || 1, notes: a.notes || null })) })),
    };
    try {
      if (editing) { await api(`/boms/${id}/versions/${vid}`, { method: 'PUT', body: { ...body, version: src.data!.version } }); toast('success', 'Version saved.'); await qc.invalidateQueries(); nav(`/production/formulations/${id}/versions/${vid}`); }
      else { const r = await api<{ id: string; versionNo: number }>(`/boms/${id}/versions`, { body }); toast('success', `Saved as Draft version ${r.versionNo}.`); await qc.invalidateQueries(); nav(`/production/formulations/${id}/versions/${r.id}`); }
    } catch (e) { setError(e); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setSaving(false); }
  };
  return (
    <>
      <PageHeader title={editing ? `Edit ${b.code} v${src.data!.versionNo}` : `New version of ${b.code}`} crumbs={<Link to={`/production/formulations/${id}`} className="hover:text-primary">{b.code}</Link>}
        subtitle={`Recipe for one batch of ${b.itemCode} — ${b.itemName}. Quantities are per batch, in each ingredient's unit.${from && !editing ? ' Copied from the version in force; change what is new.' : ''}`} />
      <ErrorBanner error={error} />
      <div className="space-y-6">
        <Card title="Batch and process">
          <div className="grid gap-5 md:grid-cols-4">
            <Field label={`Batch size (${b.itemUom})`} htmlFor="v-batch" required hint="Planned output of one batch"><Input id="v-batch" type="number" min="0" step="any" value={h.batchSize} onChange={(e) => setH((x) => ({ ...x, batchSize: e.target.value }))} /></Field>
            <Field label="Standard yield %" htmlFor="v-yield" required><Input id="v-yield" type="number" min="0" max="100" step="0.01" value={h.standardYieldPct} onChange={(e) => setH((x) => ({ ...x, standardYieldPct: e.target.value }))} /></Field>
            <Field label="Reaction temperature (°C)" htmlFor="v-temp"><Input id="v-temp" type="number" step="0.1" value={h.reactionTempC} onChange={(e) => setH((x) => ({ ...x, reactionTempC: e.target.value }))} /></Field>
            <Field label="Reaction time (minutes)" htmlFor="v-time"><Input id="v-time" type="number" min="1" step="1" value={h.reactionTimeMin} onChange={(e) => setH((x) => ({ ...x, reactionTimeMin: e.target.value }))} /></Field>
            <Field label="Effective from" htmlFor="v-from" required hint="Approval ends the previous version the day before"><Input id="v-from" type="date" min={todayISO()} value={h.effectiveFrom} onChange={(e) => setH((x) => ({ ...x, effectiveFrom: e.target.value }))} /></Field>
            <div className="md:col-span-3"><Field label="What changed and why" htmlFor="v-change" required><Input id="v-change" maxLength={500} value={h.changeNote} onChange={(e) => setH((x) => ({ ...x, changeNote: e.target.value }))} /></Field></div>
            <div className="md:col-span-4"><Field label="Process instructions" htmlFor="v-notes"><Textarea id="v-notes" rows={3} maxLength={2000} value={h.processNotes} onChange={(e) => setH((x) => ({ ...x, processNotes: e.target.value }))} /></Field></div>
          </div>
        </Card>
        <Card title="Ingredients per batch" padded={false} actions={<Button size="sm" variant="secondary" icon={<Plus size={16} />} disabled={lines.length >= 60}
          onClick={() => setLines([...lines, blank(Math.max(...lines.map((l) => Number(l.stepNo) || 1)) + 1)])}>Add ingredient</Button>}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] text-[14px]">
              <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                <th className="w-24 px-5 py-3">Step</th><th className="px-2 py-3">Ingredient</th><th className="w-36 px-2 py-3">Quantity</th><th className="w-28 px-2 py-3">Tolerance ±%</th>
                <th className="px-2 py-3">Notes</th><th className="px-2 py-3">Approved substitutes</th><th className="px-3 py-3" /></tr></thead>
              <tbody>{lines.map((l, i) => {
                const it = itemById.get(l.itemId);
                return (
                  <tr key={l.key} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pl-5 pr-2"><Input className="min-w-[64px]" aria-label={`Step for line ${i + 1}`} type="number" min="1" step="1" value={l.stepNo} onChange={(e) => setLine(l.key, { stepNo: e.target.value })} /></td>
                    <td className="px-2 py-2"><Select aria-label={`Ingredient for line ${i + 1}`} value={l.itemId} invalid={dup.has(l.itemId)} onChange={(e) => setLine(l.key, { itemId: e.target.value })}>
                      <option value="">Select…</option>{inputs.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.name}</option>)}</Select>
                      {dup.has(l.itemId) && <p className="mt-1 text-[12px] text-danger-text">Already on another line.</p>}</td>
                    <td className="px-2 py-2"><div className="flex items-center gap-1"><Input aria-label={`Quantity for line ${i + 1}`} type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
                      <span className="text-[12px] text-ink-2">{it?.baseUom}</span></div></td>
                    <td className="px-2 py-2"><Input aria-label={`Tolerance for line ${i + 1}`} type="number" min="0" max="100" step="0.1" value={l.tolerancePct} onChange={(e) => setLine(l.key, { tolerancePct: e.target.value })} /></td>
                    <td className="px-2 py-2"><Input aria-label={`Notes for line ${i + 1}`} maxLength={300} value={l.notes} onChange={(e) => setLine(l.key, { notes: e.target.value })} /></td>
                    <td className="px-2 py-2">
                      {l.alternates.map((a, j) => (
                        <div key={a.key} className="mb-1 grid grid-cols-[1fr_80px_32px] gap-1">
                          <Select aria-label={`Substitute ${j + 1} for line ${i + 1}`} value={a.itemId} onChange={(e) => setLine(l.key, { alternates: l.alternates.map((x) => (x.key === a.key ? { ...x, itemId: e.target.value } : x)) })}>
                            <option value="">Select…</option>{inputs.filter((x) => x.id !== l.itemId).map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}</Select>
                          <Input aria-label={`Factor for substitute ${j + 1} of line ${i + 1}`} title="Quantity of the substitute per unit of the ingredient" type="number" min="0" step="any" value={a.factor}
                            onChange={(e) => setLine(l.key, { alternates: l.alternates.map((x) => (x.key === a.key ? { ...x, factor: e.target.value } : x)) })} />
                          <Button size="sm" variant="ghost" aria-label={`Remove substitute ${j + 1} of line ${i + 1}`} onClick={() => setLine(l.key, { alternates: l.alternates.filter((x) => x.key !== a.key) })}><Trash size={14} /></Button>
                        </div>))}
                      {l.alternates.length < 5 && <Button size="sm" variant="ghost" icon={<Plus size={14} />} disabled={!l.itemId}
                        onClick={() => setLine(l.key, { alternates: [...l.alternates, { key: ++k, itemId: '', factor: '1', notes: '' }] })}>Substitute</Button>}
                    </td>
                    <td className="px-3 py-2"><Button size="sm" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines(lines.filter((x) => x.key !== l.key))}><Trash size={16} /></Button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
            <span className="text-ink-2">Ingredients in {b.itemUom}: <span className="font-semibold text-ink num">{fmtNum(sameUnit)}</span>
              {expected > 0 && sameUnit > 0 && <> · expected output at standard yield <span className="font-semibold text-ink num">{fmtNum(expected * (Number(h.standardYieldPct) || 0) / 100)} {b.itemUom}</span></>}</span>
            <div className="flex gap-2"><Button loading={saving} disabled={!valid} onClick={save}>{editing ? 'Save changes' : 'Save draft'}</Button><Button variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
          </div>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- version detail
export function FormulationVersionPage() {
  const { id, vid } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['bom-version', id, vid], queryFn: () => api<VersionDetail>(`/boms/${id}/versions/${vid}`) });
  const [withdraw, setWithdraw] = useState(false);
  const submit = useMutation({ mutationFn: () => api<{ status: string; approvalDocNo: string }>(`/boms/${id}/versions/${vid}/submit`, { method: 'POST', body: {} }),
    onSuccess: async (r) => { toast('success', r.status === 'Approved' ? 'Approved.' : `Sent for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } });
  if (q.isLoading) return <Skeleton className="h-96" />;
  const v = q.data;
  if (!v) return <ErrorBanner error={q.error} />;
  const a = v.allowedActions;
  return (
    <>
      <PageHeader title={`${v.bom.code} v${v.versionNo}`} crumbs={<><Link to="/production/formulations" className="hover:text-primary">Formulations</Link> / <Link to={`/production/formulations/${id}`} className="hover:text-primary">{v.bom.code}</Link></>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StateBadge s={v.state} /><span>{v.bom.itemCode} — {v.bom.itemName} · effective {fmtDate(v.effectiveFrom)}{v.effectiveTo ? ` to ${fmtDate(v.effectiveTo)}` : ' onwards'}</span></span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/production/formulations/${id}/versions/${vid}/edit`)}>Edit</Button>}
          {a.includes('withdraw') && <Button variant="danger" onClick={() => setWithdraw(true)}>Withdraw</Button>}
          {a.includes('submit') && <Button loading={submit.isPending} onClick={() => submit.mutate()}>Submit for approval</Button>}
          {a.includes('copy') && v.status === 'Approved' && <Button variant="secondary" icon={<Copy size={16} />} onClick={() => nav(`/production/formulations/${id}/versions/new?from=${vid}`)}>Copy to new version</Button>}
        </>} />
      <ErrorBanner error={submit.error} />
      {v.statusReason && ['Rejected', 'Draft', 'Withdrawn'].includes(v.status) && <div className="mb-6 rounded-md bg-neutral-bg px-4 py-3 text-neutral-text">{v.statusReason}</div>}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card title="Batch and process">
          <KeyValues items={[['Batch size', `${fmtNum(Number(v.batchSize))} ${v.batchUom}`], ['Standard yield', `${fmtNum(Number(v.standardYieldPct))}% · ${fmtNum(Number(v.batchSize) * Number(v.standardYieldPct) / 100)} ${v.batchUom} expected`],
            ['Reaction temperature', v.reactionTempC ? `${fmtNum(Number(v.reactionTempC))} °C` : '—'], ['Reaction time', v.reactionTimeMin ? `${v.reactionTimeMin} minutes` : '—'],
            ['Ingredients', `${v.lines.length} · ${fmtNum(v.inputTotal)} ${v.batchUom} in the batch unit`], ['Change', v.changeNote], ['Prepared by', `${v.createdBy}, ${fmtDateTime(v.createdAt)}`],
            ['Process instructions', v.processNotes ? <span className="whitespace-pre-line">{v.processNotes}</span> : '—']]} />
        </Card>
        <Card title="Approval">
          {!v.approval ? <p className="text-ink-2">Not submitted yet. The plant head approves it, then QA.</p> : (
            <>
              <p className="mb-3 text-[14px]"><Link className="font-semibold text-primary" to={`/approvals/${v.approval.id}`}>{v.approval.docNo}</Link> · {v.approval.ruleName}</p>
              <ol className="space-y-2">{(v.approval.steps ?? []).map((s) => <li key={s.seq} className="flex items-center justify-between gap-2 text-[14px]"><span>{s.label}</span><StatusBadge status={s.status} /></li>)}</ol>
            </>
          )}
          {v.approvedAt && <p className="mt-3 text-[12px] text-ink-2">Approved {fmtDateTime(v.approvedAt)}</p>}
        </Card>
      </div>
      <Card title="Ingredients per batch" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[860px] text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">Step</th><th className="px-3 py-3">Ingredient</th><th className="px-3 py-3 text-right">Quantity</th><th className="px-3 py-3 text-right">Tolerance</th>
            <th className="px-3 py-3 text-right">Per 1,000 {v.batchUom} of batch</th><th className="px-3 py-3">Approved substitutes</th><th className="px-3 py-3">Notes</th></tr></thead>
          <tbody>{v.lines.map((l) => (
            <tr key={l.id} className="border-b border-line align-top last:border-0">
              <td className="px-5 py-3 num">{l.stepNo}</td><td className="px-3 py-3"><span className="font-semibold">{l.itemCode}</span><br /><span className="text-ink-2">{l.itemName}</span></td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.qty))} {l.uom}</td><td className="px-3 py-3 text-right num">±{fmtNum(Number(l.tolerancePct))}%</td>
              <td className="px-3 py-3 text-right num">{fmtNum(Number(l.qty) * 1000 / Number(v.batchSize))} {l.uom}</td>
              <td className="px-3 py-3">{l.alternates.length ? l.alternates.map((x) => <span key={x.itemId} className="block">{x.itemCode} × <span className="num">{fmtNum(x.factor)}</span></span>) : '—'}</td>
              <td className="px-3 py-3">{l.notes ?? '—'}</td>
            </tr>))}</tbody>
        </table></div>
      </Card>
      <ReasonDialog open={withdraw} danger title={`Withdraw v${v.versionNo}`} confirmLabel="Withdraw version" onClose={() => setWithdraw(false)}
        onConfirm={async (reason) => { await api(`/boms/${id}/versions/${vid}/withdraw`, { body: { reason } }); toast('success', 'Version withdrawn.'); await qc.invalidateQueries(); }} />
    </>
  );
}

/** Approval links carry the version id only; find its formulation and open it. */
export function FormulationVersionLink() {
  const { vid } = useParams();
  const q = useQuery({ queryKey: ['bom-version-locate', vid], queryFn: () => api<{ bomId: string }>(`/boms/versions/${vid}`) });
  if (q.data) return <Navigate replace to={`/production/formulations/${q.data.bomId}/versions/${vid}`} />;
  return q.error ? <ErrorBanner error={q.error} /> : <Skeleton className="h-96" />;
}
