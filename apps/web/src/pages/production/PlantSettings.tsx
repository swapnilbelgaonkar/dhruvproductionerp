import { LINE_TYPES } from '@dhruv/contracts';
import { PencilSimple, Plus, Trash } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtNum, humanize } from '../../lib/format';

interface Param { name: string; value: string; unit: string | null }
interface Line { id: string; plantId: string; code: string; name: string; lineType: string; capacityPerShift: string | null; capacityUom: string | null; parameters: Param[]; status: string; statusReason: string | null; version: number }
interface Shift { id: string; plantId: string; code: string; name: string; startTime: string; endTime: string; status: string; version: number }
interface Plant { id: string; code: string; name: string; legalEntityName: string; lines: Line[]; shifts: Shift[] }

const hours = (s: Shift) => {
  const [sh, sm] = s.startTime.split(':').map(Number); const [eh, em] = s.endTime.split(':').map(Number);
  let m = (eh! * 60 + em!) - (sh! * 60 + sm!); if (m <= 0) m += 1440;
  return `${fmtNum(m / 60)} h${m + (sh! * 60 + sm!) > 1440 ? ' · crosses midnight' : ''}`;
};

/** Plant & line settings (BRD p.18 sub-module 16; MFG-019): production lines with machine parameters, and shifts per plant. */
export function PlantSettingsPage() {
  const { can } = useAuth();
  const manage = can('mfg.settings:configure');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['production-plants'], queryFn: () => api<{ data: Plant[] }>('/production/plants') });
  const [line, setLine] = useState<{ plant: Plant; line?: Line } | null>(null);
  const [shift, setShift] = useState<{ plant: Plant; shift?: Shift } | null>(null);
  const [toggle, setToggle] = useState<{ kind: 'lines' | 'shifts'; id: string; label: string; to: 'Active' | 'Inactive' } | null>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorBanner error={q.error} />;
  const plants = q.data!.data;
  return (
    <>
      <PageHeader title="Plant & Line Settings" subtitle="Production lines with their capacity and machine parameters, and the shifts each plant runs. Production orders and batches are planned on these." />
      {!plants.length && <Card><EmptyState title="No active plants" text="Plants are created and approved under Masters → Plants. Once a plant is active, its lines and shifts are set up here." /></Card>}
      <div className="space-y-6">
        {plants.map((p) => (
          <section key={p.id} aria-label={p.name} className="space-y-4">
            <h2 className="text-[18px] font-semibold">{p.code} — {p.name} <span className="ml-2 text-[14px] font-normal text-ink-2">{p.legalEntityName}</span></h2>
            <Card title="Production lines" padded={false} actions={manage && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setLine({ plant: p })}>Add line</Button>}>
              {!p.lines.length ? <div className="p-5"><EmptyState title="No lines yet" text="Add the reactors, blenders and filling or packing lines of this plant." /></div> : (
                <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[14px]">
                  <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                    <th className="px-5 py-3">Line</th><th className="px-3 py-3">Type</th><th className="px-3 py-3 text-right">Capacity / shift</th><th className="px-3 py-3">Machine parameters</th><th className="px-3 py-3">Status</th><th className="px-3 py-3" /></tr></thead>
                  <tbody>{p.lines.map((l) => (
                    <tr key={l.id} className="border-b border-line align-top last:border-0">
                      <td className="px-5 py-3"><span className="font-semibold">{l.code}</span><br /><span className="text-ink-2">{l.name}</span></td>
                      <td className="px-3 py-3">{humanize(l.lineType.toLowerCase())}</td>
                      <td className="px-3 py-3 text-right num">{l.capacityPerShift ? `${fmtNum(Number(l.capacityPerShift))} ${l.capacityUom}` : '—'}</td>
                      <td className="px-3 py-3">{l.parameters.length ? <ul className="space-y-0.5">{l.parameters.map((x) => <li key={x.name}>{x.name}: <span className="num">{x.value}</span> {x.unit}</li>)}</ul> : '—'}</td>
                      <td className="px-3 py-3"><StatusBadge status={l.status} />{l.statusReason && l.status === 'Inactive' && <p className="mt-1 text-[12px] text-ink-2">{l.statusReason}</p>}</td>
                      <td className="px-3 py-3 text-right">{manage && <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Edit ${l.code}`} onClick={() => setLine({ plant: p, line: l })}><PencilSimple size={16} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setToggle({ kind: 'lines', id: l.id, label: l.code, to: l.status === 'Active' ? 'Inactive' : 'Active' })}>{l.status === 'Active' ? 'Deactivate' : 'Reactivate'}</Button></div>}</td>
                    </tr>))}</tbody>
                </table></div>
              )}
            </Card>
            <Card title="Shifts" padded={false} actions={manage && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setShift({ plant: p })}>Add shift</Button>}>
              {!p.shifts.length ? <div className="p-5"><EmptyState title="No shifts yet" text="Add the shifts the plant runs, for example A, B and Night." /></div> : (
                <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-[14px]">
                  <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
                    <th className="px-5 py-3">Shift</th><th className="px-3 py-3">Timing</th><th className="px-3 py-3">Duration</th><th className="px-3 py-3">Status</th><th className="px-3 py-3" /></tr></thead>
                  <tbody>{p.shifts.map((s) => (
                    <tr key={s.id} className="border-b border-line last:border-0">
                      <td className="px-5 py-3"><span className="font-semibold">{s.code}</span> · {s.name}</td>
                      <td className="px-3 py-3 num">{s.startTime} – {s.endTime}</td><td className="px-3 py-3">{hours(s)}</td><td className="px-3 py-3"><StatusBadge status={s.status} /></td>
                      <td className="px-3 py-3 text-right">{manage && <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Edit shift ${s.code}`} onClick={() => setShift({ plant: p, shift: s })}><PencilSimple size={16} /></Button>
                        <Button size="sm" variant="ghost" onClick={() => setToggle({ kind: 'shifts', id: s.id, label: `shift ${s.code}`, to: s.status === 'Active' ? 'Inactive' : 'Active' })}>{s.status === 'Active' ? 'Deactivate' : 'Reactivate'}</Button></div>}</td>
                    </tr>))}</tbody>
                </table></div>
              )}
            </Card>
          </section>
        ))}
      </div>
      {line && <LineDialog plant={line.plant} line={line.line} onClose={() => setLine(null)} />}
      {shift && <ShiftDialog plant={shift.plant} shift={shift.shift} onClose={() => setShift(null)} />}
      <ReasonDialog open={!!toggle} danger={toggle?.to === 'Inactive'} title={toggle ? `${toggle.to === 'Inactive' ? 'Deactivate' : 'Reactivate'} ${toggle.label}` : ''}
        confirmLabel={toggle?.to === 'Inactive' ? 'Deactivate' : 'Reactivate'} onClose={() => setToggle(null)}
        onConfirm={async (reason) => { await api(`/production/${toggle!.kind}/${toggle!.id}/status`, { body: { status: toggle!.to, reason } }); toast('success', `Marked ${toggle!.to}.`); await qc.invalidateQueries({ queryKey: ['production-plants'] }); }} />
    </>
  );
}

function LineDialog({ plant, line, onClose }: { plant: Plant; line?: Line; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ code: line?.code ?? '', name: line?.name ?? '', lineType: line?.lineType ?? 'REACTOR', capacity: line?.capacityPerShift ? String(Number(line.capacityPerShift)) : '', uom: line?.capacityUom ?? '' });
  const [params, setParams] = useState<Param[]>(line?.parameters ?? []);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const uoms = useQuery({ queryKey: ['uom'], queryFn: () => api<{ data: { code: string; name: string; status: string }[] }>('/uom') });
  const save = async () => {
    setSaving(true); setError(null);
    const body = { plantId: plant.id, code: f.code, name: f.name, lineType: f.lineType, capacityPerShift: f.capacity ? Number(f.capacity) : null, capacityUom: f.uom || null,
      parameters: params.filter((x) => x.name.trim() && x.value.trim()).map((x) => ({ ...x, unit: x.unit || null })) };
    try {
      if (line) await api(`/production/lines/${line.id}`, { method: 'PUT', body: { ...body, version: line.version } });
      else await api('/production/lines', { body });
      toast('success', line ? 'Line saved.' : 'Line added.'); await qc.invalidateQueries({ queryKey: ['production-plants'] }); onClose();
    } catch (e) { setError(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={line ? `Edit ${line.code}` : `Add a line to ${plant.code}`} width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} disabled={!f.code || !f.name || (!!f.capacity !== !!f.uom)} onClick={save}>Save line</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Code" htmlFor="ln-code" required hint="Letters, digits and hyphens"><Input id="ln-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="ln-name" required><Input id="ln-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type" htmlFor="ln-type" required><Select id="ln-type" value={f.lineType} onChange={(e) => setF({ ...f, lineType: e.target.value })}>
          {LINE_TYPES.map((t) => <option key={t} value={t}>{humanize(t.toLowerCase())}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capacity per shift" htmlFor="ln-cap"><Input id="ln-cap" type="number" min="0" step="any" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
          <Field label="Unit" htmlFor="ln-uom"><Select id="ln-uom" value={f.uom} onChange={(e) => setF({ ...f, uom: e.target.value })}><option value="">—</option>
            {(uoms.data?.data ?? []).filter((u) => u.status === 'Active').map((u) => <option key={u.code} value={u.code}>{u.code}</option>)}</Select></Field>
        </div>
      </div>
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between"><span className="font-semibold">Machine parameters</span>
          <Button size="sm" variant="secondary" icon={<Plus size={16} />} disabled={params.length >= 30} onClick={() => setParams([...params, { name: '', value: '', unit: '' }])}>Add parameter</Button></div>
        {!params.length && <p className="text-ink-2">None recorded. Add set points such as jacket temperature, agitator speed or fill weight.</p>}
        {params.map((x, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_120px_100px_40px] gap-2">
            <Input aria-label={`Parameter ${i + 1} name`} placeholder="Name" value={x.name} onChange={(e) => setParams(params.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
            <Input aria-label={`Parameter ${i + 1} value`} placeholder="Value" value={x.value} onChange={(e) => setParams(params.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
            <Input aria-label={`Parameter ${i + 1} unit`} placeholder="Unit" value={x.unit ?? ''} onChange={(e) => setParams(params.map((y, j) => (j === i ? { ...y, unit: e.target.value } : y)))} />
            <Button size="sm" variant="ghost" aria-label={`Remove parameter ${i + 1}`} onClick={() => setParams(params.filter((_, j) => j !== i))}><Trash size={16} /></Button>
          </div>))}
      </div>
    </Modal>
  );
}

function ShiftDialog({ plant, shift, onClose }: { plant: Plant; shift?: Shift; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ code: shift?.code ?? '', name: shift?.name ?? '', startTime: shift?.startTime ?? '', endTime: shift?.endTime ?? '' });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true); setError(null);
    try {
      const body = { plantId: plant.id, ...f };
      if (shift) await api(`/production/shifts/${shift.id}`, { method: 'PUT', body: { ...body, version: shift.version } });
      else await api('/production/shifts', { body });
      toast('success', shift ? 'Shift saved.' : 'Shift added.'); await qc.invalidateQueries({ queryKey: ['production-plants'] }); onClose();
    } catch (e) { setError(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={shift ? `Edit shift ${shift.code}` : `Add a shift to ${plant.code}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={saving} disabled={!f.code || !f.name || !f.startTime || !f.endTime || f.startTime === f.endTime} onClick={save}>Save shift</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Code" htmlFor="sh-code" required hint="For example A, B or N"><Input id="sh-code" maxLength={6} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
        <Field label="Name" htmlFor="sh-name" required><Input id="sh-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Starts" htmlFor="sh-start" required><Input id="sh-start" type="time" value={f.startTime} onChange={(e) => setF({ ...f, startTime: e.target.value })} /></Field>
        <Field label="Ends" htmlFor="sh-end" required hint="An end before the start means the shift runs past midnight"><Input id="sh-end" type="time" value={f.endTime} onChange={(e) => setF({ ...f, endTime: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
