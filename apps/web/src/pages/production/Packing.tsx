import { CheckCircle, Plus, Printer, XCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR, fmtNum, humanize } from '../../lib/format';

const n = (v: string | number | null | undefined) => Number(v ?? 0);
interface RunRow { id: string; docNo: string; lotId: string; lotNo: string; itemCode: string; itemName: string; packCode: string; packSize: string; packUom: string; container: string;
  packsFilled: number; packsRejected: number; spillageQty: string; packedQty: string; boxCount: number; pmCost: string; postedAt: string; postedBy: string }
interface PackOpt { id: string; packCode: string; packSize: number; packUom: string; container: string; unitsPerBox: number }
interface PackableLot { id: string; lotNo: string; qcStatus: string; itemId: string; itemCode: string; itemName: string; uom: string; onHand: string; packed: string; packs: PackOpt[] }

// ---------------------------------------------------------------- packing runs (MFG-011)
export function PackingRunsPage() {
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const [open, setOpen] = useState(!!sp.get('lotId'));
  const q = useQuery({ queryKey: ['packing-runs'], queryFn: () => api<{ data: RunRow[] }>('/packing-runs') });
  return (
    <>
      <PageHeader title="Packing" subtitle="Finished-goods lots filled into packs: packaging material drawn from the packaging store, rejected packs and spillage booked as loss, and each box serialised with a signed QR label."
        actions={can('mfg.packing:post') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>New packing run</Button>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="No packing runs yet" text="Pack a completed batch's lot into its pack sizes; boxes and labels are created as you post the run." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-[14px]">
            <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
              <th className="px-5 py-3">Run</th><th className="px-3 py-3">Lot</th><th className="px-3 py-3">Pack</th><th className="px-3 py-3 text-right">Packs filled / rejected</th>
              <th className="px-3 py-3 text-right">Boxes</th><th className="px-3 py-3 text-right">Packaging cost</th><th className="px-3 py-3">Posted</th></tr></thead>
            <tbody>{q.data.data.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-5 py-3"><Link className="font-semibold text-primary num" to={`/production/packing/${r.id}`}>{r.docNo}</Link></td>
                <td className="px-3 py-3"><Link className="text-primary" to={`/stores/lots/${r.lotId}`}>{r.lotNo}</Link> <span className="text-ink-2">{r.itemCode}</span></td>
                <td className="px-3 py-3">{fmtNum(n(r.packSize))} {r.packUom} {r.container}</td><td className="px-3 py-3 text-right num">{r.packsFilled} / {r.packsRejected}</td>
                <td className="px-3 py-3 text-right num">{r.boxCount}</td><td className="px-3 py-3 text-right num">{fmtINR(r.pmCost)}</td><td className="px-3 py-3">{r.postedBy}, {fmtDateTime(r.postedAt)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Card>
      {open && <PackingDialog lotId={sp.get('lotId')} onClose={() => setOpen(false)} />}
    </>
  );
}

function PackingDialog({ lotId, onClose }: { lotId: string | null; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const lots = useQuery({ queryKey: ['packable-lots'], queryFn: () => api<{ data: PackableLot[] }>('/packing-runs/packable-lots') });
  const pmItems = useQuery({ queryKey: ['items-active'], queryFn: () => api<Page<{ id: string; code: string; name: string; itemType: string; baseUom: string }>>('/items?status=Active&limit=100') });
  const plants = useQuery({ queryKey: ['production-plants'], queryFn: () => api<{ data: { legalEntityId: string; lines: { id: string; code: string; name: string; lineType: string; status: string }[] }[] }>('/production/plants') });
  const whs = useQuery({ queryKey: ['warehouses-pm'], queryFn: () => api<Page<{ id: string; code: string; name: string; type: string }>>('/warehouses?status=Active&limit=100') });
  const [f, setF] = useState({ lotId: lotId ?? '', itemPackId: '', lineId: '', packsFilled: '', packsRejected: '0', spillageQty: '0', pmWarehouseId: '', remarks: '' });
  const [mats, setMats] = useState<{ itemId: string; qty: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const lot = lots.data?.data.find((l) => l.id === f.lotId);
  const pack = lot?.packs.find((p) => p.id === f.itemPackId);
  useEffect(() => { if (lot && lot.packs.length === 1 && !f.itemPackId) setF((x) => ({ ...x, itemPackId: lot.packs[0]!.id })); }, [lot, f.itemPackId]);
  const left = lot ? n(lot.onHand) - n(lot.packed) : 0;
  const filled = Number(f.packsFilled) || 0;
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ id: string; docNo: string; boxes: number }>('/packing-runs', { body: { lotId: f.lotId, itemPackId: f.itemPackId, lineId: f.lineId || null, packsFilled: filled,
        packsRejected: Number(f.packsRejected) || 0, spillageQty: Number(f.spillageQty) || 0, pmWarehouseId: f.pmWarehouseId || null, remarks: f.remarks || null,
        materials: mats.filter((m) => m.itemId && Number(m.qty) > 0).map((m) => ({ itemId: m.itemId, qty: Number(m.qty) })) } });
      toast('success', `${r.docNo} posted: ${r.boxes} box${r.boxes === 1 ? '' : 'es'} labelled.`); nav(`/production/packing/${r.id}`);
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="New packing run" width={760}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.lotId || !f.itemPackId || filled <= 0} onClick={save}>Post packing run</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Lot to pack" htmlFor="pk-lot" required><Select id="pk-lot" value={f.lotId} onChange={(e) => setF({ ...f, lotId: e.target.value, itemPackId: '' })}><option value="">Select…</option>
          {(lots.data?.data ?? []).map((l) => <option key={l.id} value={l.id}>{l.lotNo} — {l.itemCode} · {fmtNum(n(l.onHand) - n(l.packed))} {l.uom} to pack · QC {l.qcStatus}</option>)}</Select></Field>
        <Field label="Pack" htmlFor="pk-pack" required><Select id="pk-pack" value={f.itemPackId} disabled={!lot} onChange={(e) => setF({ ...f, itemPackId: e.target.value })}><option value="">Select…</option>
          {(lot?.packs ?? []).map((p) => <option key={p.id} value={p.id}>{fmtNum(p.packSize)} {p.packUom} {p.container} · {p.unitsPerBox} per box</option>)}</Select></Field>
        <Field label="Packs filled" htmlFor="pk-filled" required hint={pack ? `${Math.ceil(filled / pack.unitsPerBox) || 0} boxes · ${fmtNum(left)} ${lot?.uom} left in the lot` : undefined}>
          <Input id="pk-filled" type="number" min="1" step="1" value={f.packsFilled} onChange={(e) => setF({ ...f, packsFilled: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Packs rejected" htmlFor="pk-rej"><Input id="pk-rej" type="number" min="0" step="1" value={f.packsRejected} onChange={(e) => setF({ ...f, packsRejected: e.target.value })} /></Field>
          <Field label={`Spillage (${lot?.uom ?? 'unit'})`} htmlFor="pk-spill"><Input id="pk-spill" type="number" min="0" step="any" value={f.spillageQty} onChange={(e) => setF({ ...f, spillageQty: e.target.value })} /></Field>
        </div>
        <Field label="Filling line" htmlFor="pk-line"><Select id="pk-line" value={f.lineId} onChange={(e) => setF({ ...f, lineId: e.target.value })}><option value="">—</option>
          {(plants.data?.data ?? []).flatMap((p) => p.lines).filter((l) => l.status === 'Active' && ['FILLING', 'PACKING'].includes(l.lineType)).map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}</Select></Field>
        <Field label="Packaging store" htmlFor="pk-pmwh" hint="Bottles, caps and labels are drawn from here, earliest expiry first"><Select id="pk-pmwh" value={f.pmWarehouseId} onChange={(e) => setF({ ...f, pmWarehouseId: e.target.value })}><option value="">—</option>
          {(whs.data?.data ?? []).filter((w) => ['PM', 'GENERAL'].includes(w.type)).map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</Select></Field>
      </div>
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between"><span className="font-semibold">Packaging material used</span>
          <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setMats([...mats, { itemId: '', qty: filled + (Number(f.packsRejected) || 0) ? String(filled + (Number(f.packsRejected) || 0)) : '' }])}>Add material</Button></div>
        {mats.map((m, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_140px_40px] gap-2">
            <Select aria-label={`Packaging material ${i + 1}`} value={m.itemId} onChange={(e) => setMats(mats.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}><option value="">Select…</option>
              {(pmItems.data?.data ?? []).filter((it) => it.itemType === 'PM').map((it) => <option key={it.id} value={it.id}>{it.code} — {it.name}</option>)}</Select>
            <Input aria-label={`Quantity of packaging material ${i + 1}`} type="number" min="0" step="any" value={m.qty} onChange={(e) => setMats(mats.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
            <Button size="sm" variant="ghost" aria-label={`Remove packaging material ${i + 1}`} onClick={() => setMats(mats.filter((_, j) => j !== i))}><XCircle size={16} /></Button>
          </div>))}
        {!mats.length && <p className="text-ink-2">None added.</p>}
      </div>
    </Modal>
  );
}

interface RunDetail extends RunRow { lotStatus: string; mfgDate: string; expiryDate: string | null; uom: string; unitsPerBox: number; remarks: string | null; lineCode: string | null;
  materials: { qty: string; unitCost: string; lotNo: string; itemCode: string; uom: string }[]; boxes: { serial: string; units: number; status: string }[];
  labels?: { serial: string; units: number; url: string; svg: string }[] }

export function PackingRunDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['packing-run', id], queryFn: () => api<RunDetail>(`/packing-runs/${id}`) });
  if (q.isLoading) return <Skeleton className="h-96" />;
  const r = q.data;
  if (!r) return <ErrorBanner error={q.error} />;
  return (
    <>
      <PageHeader title={r.docNo} crumbs={<Link to="/production/packing" className="hover:text-primary">Packing</Link>}
        subtitle={`${r.itemCode} — ${r.itemName} · lot ${r.lotNo} · ${fmtNum(n(r.packSize))} ${r.packUom} ${r.container}`}
        actions={<Button icon={<Printer size={18} />} onClick={() => window.open(`/production/packing/${id}/labels`, '_blank')}>Print box labels</Button>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card title="Run">
          <KeyValues items={[['Lot', <Link key="l" className="text-primary" to={`/stores/lots/${r.lotId}`}>{r.lotNo}</Link>], ['Packs filled', `${r.packsFilled} = ${fmtNum(n(r.packedQty))} ${r.uom}`],
            ['Rejected / spillage', `${r.packsRejected} packs · ${fmtNum(n(r.spillageQty))} ${r.uom}`], ['Boxes', `${r.boxCount} (${r.unitsPerBox} per box)`], ['Line', r.lineCode ?? '—'],
            ['Packaging cost', fmtINR(r.pmCost)], ['Posted', `${r.postedBy}, ${fmtDateTime(r.postedAt)}`], ['Remarks', r.remarks ?? '—']]} />
        </Card>
        <Card title="Packaging material">
          {!r.materials.length ? <p className="text-ink-2">None recorded.</p> : <ul className="space-y-1 text-[14px]">{r.materials.map((m, i) => <li key={i}>{m.itemCode} lot {m.lotNo}: {fmtNum(n(m.qty))} {m.uom} at {fmtINR(m.unitCost)}</li>)}</ul>}
        </Card>
      </div>
      <Card title="Boxes" padded={false} className="mt-6">
        <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
          <th className="px-5 py-3">Serial</th><th className="px-3 py-3 text-right">Packs</th><th className="px-3 py-3">Status</th></tr></thead>
          <tbody>{r.boxes.map((b) => <tr key={b.serial} className="border-b border-line last:border-0"><td className="px-5 py-3 font-semibold num">{b.serial}</td><td className="px-3 py-3 text-right num">{b.units}</td>
            <td className="px-3 py-3"><StatusBadge status="Active" label={b.status} /></td></tr>)}</tbody></table></div>
      </Card>
    </>
  );
}

/** Printable box labels: product, pack, lot, dates, serial and the signed QR (D24 box level). */
export function PackingLabelsPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['packing-labels', id], queryFn: () => api<RunDetail>(`/packing-runs/${id}?labels=1`) });
  useEffect(() => { document.title = q.data ? `Labels ${q.data.docNo}` : 'Labels'; }, [q.data]);
  if (q.isLoading) return <Skeleton className="m-8 h-96" />;
  const r = q.data;
  if (!r) return <ErrorBanner error={q.error} />;
  return (
    <div className="bg-white p-6 text-black">
      <div className="mb-4 flex items-center justify-between print:hidden"><p>{r.labels?.length} labels for {r.docNo}</p><Button icon={<Printer size={18} />} onClick={() => window.print()}>Print</Button></div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">{(r.labels ?? []).map((l) => (
        <div key={l.serial} className="flex break-inside-avoid gap-3 rounded border border-black p-3 text-[12px] leading-snug">
          <div className="h-28 w-28 shrink-0" dangerouslySetInnerHTML={{ __html: l.svg }} aria-label={`QR code for ${l.serial}`} />
          <div className="min-w-0">
            <p className="text-[14px] font-bold">{r.itemName}</p>
            <p>{l.units} × {fmtNum(n(r.packSize))} {r.packUom} {r.container}</p>
            <p>Batch / lot <b>{r.lotNo}</b></p><p>Mfg {fmtDate(r.mfgDate)} · Exp {fmtDate(r.expiryDate)}</p>
            <p className="mt-1 font-mono text-[11px]">{l.serial}</p><p className="text-[10px]">Scan to check it is genuine</p>
          </div>
        </div>))}</div>
    </div>
  );
}

/** Public label check (no sign-in): the QR opens this page. */
export function VerifyPage() {
  const { serial } = useParams();
  const [sp] = useSearchParams();
  const q = useQuery({ queryKey: ['verify', serial, sp.get('s')], queryFn: () => api<{ genuine: boolean; product?: string; pack?: string; units?: number; lotNo?: string; mfgDate?: string; expiryDate?: string | null; released?: boolean }>(
    `/public/verify/${encodeURIComponent(serial ?? '')}?s=${encodeURIComponent(sp.get('s') ?? '')}`) });
  const v = q.data;
  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-4">
      <div className="card w-full max-w-md p-8 text-center">
        <p className="mb-6 text-[14px] font-semibold text-ink-2">Dhruv Agro — product check</p>
        {q.isLoading ? <Skeleton className="h-40" /> : v?.genuine ? (
          <>
            <CheckCircle size={56} weight="fill" className="mx-auto text-success-text" aria-hidden /><h1 className="mt-3 text-[24px] font-semibold">Genuine product</h1>
            <dl className="mt-6 space-y-2 text-left text-[14px]">{[['Product', v.product], ['Box', `${v.units} × ${v.pack}`], ['Batch / lot', v.lotNo], ['Manufactured', fmtDate(v.mfgDate)], ['Expiry', fmtDate(v.expiryDate)], ['Serial', serial]].map(([k, val]) => (
              <div key={k} className="flex justify-between gap-4"><dt className="text-ink-2">{k}</dt><dd className="font-semibold">{val}</dd></div>))}</dl>
            {v.released === false && <p className="mt-4 rounded-md bg-warning-bg px-3 py-2 text-[13px] text-warning-text">This batch has not been released for sale yet.</p>}
          </>
        ) : (
          <><XCircle size={56} weight="fill" className="mx-auto text-danger-text" aria-hidden /><h1 className="mt-3 text-[24px] font-semibold">Not recognised</h1>
            <p className="mt-3 text-ink-2">This label could not be verified. Do not use the product; contact your dealer or Dhruv Agro.</p></>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- downtime (MFG-014)
const REASONS = ['BREAKDOWN', 'CLEANING_CIP', 'CHANGEOVER', 'NO_MATERIAL', 'POWER', 'PLANNED_MAINTENANCE', 'QUALITY_HOLD', 'OTHER'];
const reasonLabel = (r: string) => (r === 'CLEANING_CIP' ? 'Cleaning (CIP)' : humanize(r.toLowerCase()));

export function DowntimePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['downtime'], queryFn: () => api<{ data: { id: string; lineCode: string; lineName: string; startedAt: string; endedAt: string; reason: string; remarks: string | null; hours: string; batchNo: string | null; recordedBy: string }[] }>('/production/downtime') });
  const plants = useQuery({ queryKey: ['production-plants'], queryFn: () => api<{ data: { code: string; lines: { id: string; code: string; name: string; status: string }[] }[] }>('/production/plants') });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ lineId: '', startedAt: '', endedAt: '', reason: 'BREAKDOWN', remarks: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setError(null);
    try { await api('/production/downtime', { body: { lineId: f.lineId, startedAt: new Date(f.startedAt).toISOString(), endedAt: new Date(f.endedAt).toISOString(), reason: f.reason, remarks: f.remarks || null } });
      toast('success', 'Downtime recorded.'); setOpen(false); setF({ lineId: '', startedAt: '', endedAt: '', reason: 'BREAKDOWN', remarks: '' }); await qc.invalidateQueries({ queryKey: ['downtime'] }); }
    catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Downtime" subtitle="Stoppages of each line with their reason: they feed line availability on the production dashboard."
        actions={can('mfg.batch:execute') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>Record downtime</Button>} />
      <Card padded={false}>
        {q.isLoading ? <Skeleton className="h-40" /> : !q.data?.data.length ? <div className="p-5"><EmptyState title="No downtime recorded" text="Record each stoppage once it ends: line, from and to, and why." /></div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2">
            <th className="px-5 py-3">Line</th><th className="px-3 py-3">From → to</th><th className="px-3 py-3 text-right">Hours</th><th className="px-3 py-3">Reason</th><th className="px-3 py-3">Remarks</th><th className="px-3 py-3">Recorded by</th></tr></thead>
            <tbody>{q.data.data.map((d) => <tr key={d.id} className="border-b border-line last:border-0"><td className="px-5 py-3 font-semibold">{d.lineCode}</td>
              <td className="px-3 py-3 num">{fmtDateTime(d.startedAt)} → {fmtDateTime(d.endedAt)}</td><td className="px-3 py-3 text-right num">{fmtNum(n(d.hours))}</td>
              <td className="px-3 py-3">{reasonLabel(d.reason)}</td><td className="px-3 py-3">{d.remarks ?? '—'}</td><td className="px-3 py-3">{d.recordedBy}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Record downtime"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={busy} disabled={!f.lineId || !f.startedAt || !f.endedAt} onClick={save}>Record</Button></>}>
        <ErrorBanner error={error} />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Line" htmlFor="dt-line" required><Select id="dt-line" value={f.lineId} onChange={(e) => setF({ ...f, lineId: e.target.value })}><option value="">Select…</option>
            {(plants.data?.data ?? []).flatMap((p) => p.lines.map((l) => ({ ...l, plant: p.code }))).filter((l) => l.status === 'Active').map((l) => <option key={l.id} value={l.id}>{l.plant} · {l.code} — {l.name}</option>)}</Select></Field>
          <Field label="Reason" htmlFor="dt-reason" required><Select id="dt-reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}</Select></Field>
          <Field label="From" htmlFor="dt-from" required><Input id="dt-from" type="datetime-local" value={f.startedAt} onChange={(e) => setF({ ...f, startedAt: e.target.value })} /></Field>
          <Field label="To" htmlFor="dt-to" required><Input id="dt-to" type="datetime-local" value={f.endedAt} onChange={(e) => setF({ ...f, endedAt: e.target.value })} /></Field>
          <div className="md:col-span-2"><Field label="Remarks" htmlFor="dt-rem"><Input id="dt-rem" maxLength={500} value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- dashboard (MFG-002, D23 provisional)
interface Dash { month: string; output: { itemCode: string; itemName: string; uom: string; output: string; batches: number; avgYield: string; stdYield: string }[];
  plan: { itemCode: string; uom: string; planned: string; produced: string }[]; downtime: { reason: string; hours: string; events: number }[];
  counts: { inProgress: number; awaitingQa: number; openDeviations: number; activeOrders: number };
  kpis: { rightFirstTimePct: number | null; completedBatches: number; qualityRatePct: number | null; availabilityPct: number | null; scheduledHours: number; downtimeHours: number }; provisional: string }

const Tile = ({ label, value, note, to }: { label: string; value: string; note?: string; to?: string }) => {
  const body = <><p className="text-[13px] font-semibold text-ink-2">{label}</p><p className="mt-2 text-[32px] font-semibold leading-none num">{value}</p>{note && <p className="mt-2 text-[13px] text-ink-2">{note}</p>}</>;
  return to ? <Link to={to} className="card block p-5 transition hover:-translate-y-0.5">{body}</Link> : <div className="card p-5">{body}</div>;
};
const Bar = ({ pct }: { pct: number }) => <div className="h-2 w-full rounded-full bg-primary-soft" aria-hidden><div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;

export function ProductionDashboardPage() {
  const [month, setMonth] = useState(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7));
  const q = useQuery({ queryKey: ['production-dashboard', month], queryFn: () => api<Dash>(`/production/dashboard?month=${month}`) });
  const d = q.data;
  const pct = (v: number | null) => (v === null ? '—' : `${fmtNum(v)}%`);
  return (
    <>
      <PageHeader title="Production Dashboard" subtitle={d?.provisional ?? 'Output, yield, quality and line availability for the month.'}
        actions={<Input aria-label="Month" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="w-44" />} />
      {q.isLoading || !d ? <Skeleton className="h-96" /> : (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Tile label="Right first time" value={pct(d.kpis.rightFirstTimePct)} note={`Share of the ${d.kpis.completedBatches} batch${d.kpis.completedBatches === 1 ? '' : 'es'} completed this month with no deviation`} to="/production/batches" />
            <Tile label="Quality rate" value={pct(d.kpis.qualityRatePct)} note="Output released by QA ÷ output completed" to="/qa/releases" />
            <Tile label="Line availability" value={pct(d.kpis.availabilityPct)} note={`${fmtNum(d.kpis.downtimeHours)} h down of ${fmtNum(d.kpis.scheduledHours)} h scheduled`} to="/production/downtime" />
            <Tile label="Now" value={`${d.counts.inProgress}`} note={`batches running · ${d.counts.awaitingQa} awaiting QA · ${d.counts.openDeviations} open deviations · ${d.counts.activeOrders} active orders`} to="/production/orders" />
          </div>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Plan vs actual (orders due this month)">
              {!d.plan.length ? <p className="text-ink-2">No orders due this month.</p> : <ul className="space-y-4">{d.plan.map((p) => {
                const v = n(p.planned) ? n(p.produced) / n(p.planned) * 100 : 0;
                return <li key={p.itemCode}><div className="mb-1 flex justify-between text-[14px]"><span className="font-semibold">{p.itemCode}</span><span className="num">{fmtNum(n(p.produced))} / {fmtNum(n(p.planned))} {p.uom} · {fmtNum(Math.round(v))}%</span></div><Bar pct={v} /></li>;
              })}</ul>}
            </Card>
            <Card title="Output and yield (batches completed this month)">
              {!d.output.length ? <p className="text-ink-2">No batch completed this month.</p> : (
                <table className="w-full text-[14px]"><thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="py-2">Product</th><th className="py-2 text-right">Output</th><th className="py-2 text-right">Batches</th><th className="py-2 text-right">Yield (std)</th></tr></thead>
                  <tbody>{d.output.map((o) => <tr key={o.itemCode} className="border-b border-line last:border-0"><td className="py-2"><span className="font-semibold">{o.itemCode}</span> <span className="text-ink-2">{o.itemName}</span></td>
                    <td className="py-2 text-right num">{fmtNum(n(o.output))} {o.uom}</td><td className="py-2 text-right num">{o.batches}</td><td className="py-2 text-right num">{fmtNum(n(o.avgYield))}% ({fmtNum(n(o.stdYield))}%)</td></tr>)}</tbody></table>
              )}
            </Card>
          </div>
          <Card title="Downtime by reason">
            {!d.downtime.length ? <p className="text-ink-2">No downtime recorded this month.</p> : <ul className="space-y-3">{d.downtime.map((x) => (
              <li key={x.reason}><div className="mb-1 flex justify-between text-[14px]"><span>{reasonLabel(x.reason)}</span><span className="num">{fmtNum(n(x.hours))} h · {x.events} event{x.events === 1 ? '' : 's'}</span></div>
                <Bar pct={d.kpis.downtimeHours ? n(x.hours) / d.kpis.downtimeHours * 100 : 0} /></li>))}</ul>}
          </Card>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- batch cost sheet (MFG-015, D32 provisional)
export function CostSheetCard({ batchId }: { batchId: string }) {
  const q = useQuery({ queryKey: ['cost-sheet', batchId], queryFn: () => api<{ available: boolean; reason?: string; lines: { element: string; amount: number }[]; total: number; perUnit: number; perMt: number | null; uom: string; ratesConfigured: boolean }>(`/production/cost-sheet/${batchId}`) });
  const c = q.data;
  if (!c?.available) return null;
  return (
    <Card title="Cost sheet" className="mt-6">
      <ul className="space-y-2 text-[14px]">{c.lines.map((l) => <li key={l.element} className="flex justify-between gap-4"><span>{l.element}</span><span className="num">{fmtINR(l.amount)}</span></li>)}</ul>
      <div className="mt-3 flex justify-between border-t border-line pt-3 text-[14px] font-semibold"><span>Total</span><span className="num">{fmtINR(c.total)} · {fmtINR(c.perUnit)} per {c.uom}{c.perMt ? ` · ${fmtINR(c.perMt)} per MT` : ''}</span></div>
      {!c.ratesConfigured && <p className="mt-3 text-[13px] text-warning-text">Energy, labour and overhead rates are not set yet (setting “mfg.conversionCost”, D32): the total covers material and packaging only.</p>}
    </Card>
  );
}
