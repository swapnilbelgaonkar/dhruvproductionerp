import { zodResolver } from '@hookform/resolvers/zod';
import { ACTIVITY_KINDS, LEAD_SOURCES, leadSchema, LOSS_REASONS, OPEN_STAGES } from '@dhruv/contracts';
import { CalendarCheck, CheckCircle, Phone, Plus, Trophy, UserSwitch, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable } from '../../components/DataTable';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, EmptyState, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR } from '../../lib/format';

const STAGE_LABEL: Record<string, string> = { REQUIREMENT: 'Requirement', SAMPLE_TRIAL: 'Sample / trial', QUOTE_SENT: 'Quote sent', PO_EXPECTED: 'PO expected', WON: 'Won', LOST: 'Lost' };
const SOURCE_LABEL: Record<string, string> = { EXHIBITION: 'Exhibition', INDIAMART: 'IndiaMART', FIELD_VISIT: 'Field visit', REFERRAL: 'Referral', DEALER_ENQUIRY: 'Dealer enquiry', WEBSITE: 'Website', OTHER: 'Other' };
const KIND_LABEL: Record<string, string> = { CALL: 'Call', MEETING: 'Meeting', DEALER_VISIT: 'Dealer visit', FIELD_VISIT: 'Field visit', AGRONOMIST: 'Agronomist discussion', FOLLOW_UP: 'Follow-up', TASK: 'Task' };
const LOSS_LABEL: Record<string, string> = { PRICE: 'Price', COMPETITOR: 'Lost to competitor', NO_BUDGET: 'No budget', NO_NEED: 'No need', TIMING: 'Timing', PRODUCT_FIT: 'Product fit', NO_RESPONSE: 'No response', OTHER: 'Other' };
const LEAD_STATUS_BADGE: Record<string, string> = { New: 'Draft', Contacted: 'Pending', Qualified: 'Approved', Disqualified: 'Rejected', Converted: 'Notified' };
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => new Date(v).toISOString();

// ---------------------------------------------------------------- summary cards (BRD §4 #1)
interface Summary { leads: { open: number; qualified: number; overdueFollowUp: number; conversionRate90: number }; pipeline: { count: number; value: number; weighted: number; byStage: { stage: string; count: number; value: number }[] };
  thisMonth: { won: number; wonCount: number; lostCount: number }; myActivities: { today: number; overdue: number } }

export function CrmSummary() {
  const q = useQuery({ queryKey: ['crm-summary'], queryFn: () => api<Summary>('/crm/summary') });
  const s = q.data;
  const k = (v: number) => fmtINR(Math.round(v)).replace('.00', '');
  const cards: [string, string, string?][] = s ? [
    ['Open leads', String(s.leads.open), s.leads.overdueFollowUp ? `${s.leads.overdueFollowUp} follow-ups overdue` : undefined],
    ['Qualified leads', String(s.leads.qualified), `${s.leads.conversionRate90}% converted (90 days)`],
    ['Open pipeline', k(s.pipeline.value), `${s.pipeline.count} opportunities · weighted ${k(s.pipeline.weighted)}`],
    ['Won this month', k(s.thisMonth.won), `${s.thisMonth.wonCount} won · ${s.thisMonth.lostCount} lost`],
    ['My activities today', String(s.myActivities.today), s.myActivities.overdue ? `${s.myActivities.overdue} overdue` : 'Nothing overdue'],
  ] : [];
  return (
    <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {q.isLoading && Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
      {cards.map(([label, value, hint], i) => (
        <div key={label} className={clsx('rounded-xl p-5 shadow-card', i === 2 ? 'bg-gradient-to-br from-[#6843FF] to-[#572CF4] text-white' : 'bg-white')}>
          <p className={clsx('text-[13px]', i === 2 ? 'text-white/80' : 'text-ink-2')}>{label}</p>
          <p className="mt-1 font-display text-[26px] font-extrabold num">{value}</p>
          {hint && <p className={clsx('mt-1 text-[12px]', i === 2 ? 'text-white/75' : hint.includes('overdue') ? 'font-medium text-warning-text' : 'text-ink-2')}>{hint}</p>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- shared pickers
function useSalesPeople() {
  return useQuery({ queryKey: ['sales-employees'], queryFn: () => api<Page<{ id: string; fullName: string; salesTier: string | null; territoryId: string | null }>>('/employees?limit=100&status=Active') });
}
function useTerritories() {
  return useQuery({ queryKey: ['territories'], queryFn: () => api<{ data: { id: string; name: string; level: number; levelName: string; status: string }[] }>('/territories') });
}

// ---------------------------------------------------------------- leads
interface LeadRow { id: string; code: string; company: string; contactPerson: string; mobile: string; source: string; owner: string; territory: string; status: string; bantScore: number | null; followUpAt: string | null }

export function LeadsPage() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<'all' | 'mine'>('all');
  const create = can('crm.lead:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => setOpen(true)}>New lead</Button> : undefined;
  return (
    <>
      <PageHeader title="Leads" subtitle="Enquiries from exhibitions, IndiaMART, field visits, referrals and dealers — qualified with BANT before they become opportunities." actions={create} />
      <CrmSummary />
      <Tabs value={mine} onChange={setMine} tabs={[{ value: 'all', label: 'All in my territory' }, { value: 'mine', label: 'Owned by me' }]} />
      <DataTable<LeadRow> key={mine} queryKey={`leads-${mine}`} path="/crm/leads" filters={{ mine: mine === 'mine' ? 'true' : undefined }} rowHref={(r) => `/sales/leads/${r.id}`}
        searchPlaceholder="Search code, company, contact or mobile" statusOptions={['New', 'Contacted', 'Qualified', 'Disqualified', 'Converted']}
        empty={{ title: 'No leads', text: 'Capture enquiries as leads so nothing is lost between visits.', action: create }}
        columns={[
          { key: 'code', header: 'Lead', render: (r) => <span><span className="block font-semibold num">{r.code}</span><span className="text-[13px] text-ink-2">{SOURCE_LABEL[r.source]}</span></span> },
          { key: 'co', header: 'Company / contact', render: (r) => <span><span className="block font-medium">{r.company}</span><span className="text-[13px] text-ink-2">{r.contactPerson} · {r.mobile}</span></span> },
          { key: 'owner', header: 'Owner', render: (r) => <span><span className="block">{r.owner}</span><span className="text-[13px] text-ink-2">{r.territory}</span></span> },
          { key: 'bant', header: 'BANT', render: (r) => r.bantScore === null ? <span className="text-ink-2">—</span> : <span className="font-semibold num">{r.bantScore}</span> },
          { key: 'fu', header: 'Follow-up', render: (r) => r.followUpAt ? <span className={clsx(new Date(r.followUpAt) < new Date() && ['New', 'Contacted', 'Qualified'].includes(r.status) && 'font-semibold text-danger-text')}>{fmtDateTime(r.followUpAt)}</span> : '—' },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={LEAD_STATUS_BADGE[r.status] ?? r.status} label={r.status} /> },
        ]} />
      {open && <LeadFormDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function LeadFormDialog({ onClose, lead }: { onClose: () => void; lead?: LeadDetail }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const people = useSalesPeople();
  const terrs = useTerritories();
  const self = people.data?.data.find((p) => p.id === me?.user.employeeId);
  const [error, setError] = useState<unknown>(null);
  type F = z.input<typeof leadSchema>;
  const f = useForm<F>({
    resolver: zodResolver(z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? null : v])), lead ? leadSchema.partial({ ownerId: true, territoryId: true }) : leadSchema)),
    values: lead ? { ...lead, email: lead.email ?? '', expectedQty: lead.expectedQty === null ? null : Number(lead.expectedQty), followUpAt: lead.followUpAt ?? null } as F
      : { source: 'FIELD_VISIT', ownerId: me?.user.employeeId ?? '', territoryId: self?.territoryId ?? '' } as F,
  });
  const err = (k: string) => (f.formState.errors as Record<string, { message?: string }>)[k]?.message;
  const [followLocal, setFollowLocal] = useState(lead?.followUpAt ? toLocalInput(new Date(lead.followUpAt)) : '');
  const save = f.handleSubmit(async (v) => {
    setError(null);
    const body = { ...v, followUpAt: followLocal ? fromLocalInput(followLocal) : null };
    try {
      if (lead) { await api(`/crm/leads/${lead.id}`, { method: 'PUT', body: { ...body, version: lead.version } }); toast('success', 'Saved.'); await qc.invalidateQueries(); onClose(); }
      else {
        const r = await api<{ id: string; code: string; linkedDealer: { code: string; name: string } | null }>('/crm/leads', { body });
        toast('success', r.linkedDealer ? `${r.code} created and linked to existing dealer ${r.linkedDealer.code}.` : `${r.code} created.`);
        await qc.invalidateQueries(); nav(`/sales/leads/${r.id}`);
      }
    } catch (e) { if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k as 'mobile', { message: m })); setError(e); }
  });
  return (
    <Modal open onClose={onClose} title={lead ? `Edit ${lead.code}` : 'New lead'} width={720}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={f.formState.isSubmitting} onClick={save}>{lead ? 'Save' : 'Create lead'}</Button></>}>
      <ErrorBanner error={error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company / farmer group" htmlFor="lco" required error={err('company')}><Input id="lco" {...f.register('company')} /></Field>
        <Field label="Contact person" htmlFor="lcp" required error={err('contactPerson')}><Input id="lcp" {...f.register('contactPerson')} /></Field>
        <Field label="Mobile" htmlFor="lmob" required error={err('mobile')} hint="Duplicate open leads are blocked"><Input id="lmob" inputMode="numeric" maxLength={10} {...f.register('mobile')} /></Field>
        <Field label="Email" htmlFor="lem" error={err('email')}><Input id="lem" type="email" {...f.register('email')} /></Field>
        <Field label="Source" htmlFor="lsrc" required><Select id="lsrc" {...f.register('source')}>{LEAD_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</Select></Field>
        <Field label="Source detail" htmlFor="lsd" hint="e.g. exhibition name, referrer"><Input id="lsd" {...f.register('sourceDetail')} /></Field>
        <div className="sm:col-span-2"><Field label="Product requirement" htmlFor="lpi" required error={err('productInterest')}><Input id="lpi" {...f.register('productInterest')} /></Field></div>
        <Field label="Expected quantity" htmlFor="lqty" error={err('expectedQty')}><Input id="lqty" type="number" min={0} step="any" {...f.register('expectedQty', { setValueAs: (v: string) => (v === '' ? null : Number(v)) })} /></Field>
        <Field label="Unit" htmlFor="luom"><Select id="luom" {...f.register('expectedUom')}><option value="">—</option>{['KG', 'MT', 'L', 'KL', 'BAG', 'NOS'].map((u) => <option key={u}>{u}</option>)}</Select></Field>
        {!lead && <>
          <Field label="Territory" htmlFor="lter" required error={err('territoryId')}><Select id="lter" {...f.register('territoryId')}><option value="">Select…</option>{terrs.data?.data.filter((t) => t.status === 'Active').map((t) => <option key={t.id} value={t.id}>{'· '.repeat(t.level - 1)}{t.name}</option>)}</Select></Field>
          <Field label="Owner" htmlFor="lown" required error={err('ownerId')}><Select id="lown" {...f.register('ownerId')}><option value="">Select…</option>{people.data?.data.filter((p) => p.salesTier).map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.salesTier})</option>)}</Select></Field>
        </>}
        <Field label="Next follow-up" htmlFor="lfu"><Input id="lfu" type="datetime-local" value={followLocal} onChange={(e) => setFollowLocal(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Notes" htmlFor="lnotes"><Textarea id="lnotes" {...f.register('notes')} /></Field></div>
      </div>
    </Modal>
  );
}

interface Activity { id: string; kind: string; title: string; notes: string | null; plannedAt: string; doneAt: string | null; outcome: string | null; status: string; owner: string }
interface LeadDetail {
  id: string; code: string; company: string; contactPerson: string; mobile: string; email: string | null; source: string; sourceDetail: string | null; territoryId: string; territory: string;
  ownerId: string; owner: string; productInterest: string; expectedQty: string | null; expectedUom: string | null; status: string; bantBudget: boolean | null; bantAuthority: boolean | null;
  decisionMaker: string | null; bantNeedScore: number | null; bantTimeline: string | null; bantScore: number | null; disqualifyReason: string | null; followUpAt: string | null;
  partyId: string | null; partyName: string | null; opportunityId: string | null; notes: string | null; version: number; qualifyThreshold: number;
  activities: Activity[]; allowedActions: string[]; canLogActivity: boolean;
}

export function LeadDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['lead', id], queryFn: () => api<LeadDetail>(`/crm/leads/${id}`) });
  const [dialog, setDialog] = useState<null | 'edit' | 'bant' | 'convert' | 'disqualify' | 'transfer' | 'activity'>(null);
  const act = async (path: string, msg: string) => { try { await api(`/crm/leads/${id}/${path}`, { method: 'POST' }); toast('success', msg); await qc.invalidateQueries(); } catch (e) { toast('error', (e as Error).message); } };
  const l = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!l) return <ErrorBanner error={q.error} />;
  const a = l.allowedActions;
  const score = l.bantScore ?? 0;
  return (
    <>
      <PageHeader title={l.company} crumbs={<Link to="/sales/leads" className="hover:text-primary">Leads</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><span className="font-semibold num">{l.code}</span><StatusBadge status={LEAD_STATUS_BADGE[l.status] ?? l.status} label={l.status} />
          {l.opportunityId && <Link to={`/sales/opportunities/${l.opportunityId}`} className="font-semibold text-primary">Open opportunity →</Link>}</span>}
        actions={<>
          {a.includes('contacted') && <Button variant="secondary" icon={<Phone size={18} />} onClick={() => act('contacted', 'Marked as contacted.')}>Mark contacted</Button>}
          {a.includes('transfer') && <Button variant="secondary" icon={<UserSwitch size={18} />} onClick={() => setDialog('transfer')}>Reassign</Button>}
          {a.includes('edit') && <Button variant="secondary" onClick={() => setDialog('edit')}>Edit</Button>}
          {a.includes('disqualify') && <Button variant="danger" onClick={() => setDialog('disqualify')}>Disqualify</Button>}
          {a.includes('qualify') && <Button onClick={() => act('qualify', 'Lead qualified.')}>Qualify</Button>}
          {a.includes('convert') && <Button icon={<Trophy size={18} />} onClick={() => setDialog('convert')}>Convert to opportunity</Button>}
        </>} />
      {l.disqualifyReason && <div className="mb-6 rounded-md bg-danger-bg px-4 py-3 text-danger-text">Disqualified: {l.disqualifyReason}</div>}
      <div className="grid gap-6 2xl:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Card title="Lead details">
            <KeyValues items={[['Contact', l.contactPerson], ['Mobile', l.mobile], ['Email', l.email], ['Source', `${SOURCE_LABEL[l.source]}${l.sourceDetail ? ` — ${l.sourceDetail}` : ''}`],
              ['Requirement', l.productInterest], ['Expected quantity', l.expectedQty ? `${Number(l.expectedQty)} ${l.expectedUom ?? ''}` : '—'], ['Owner', l.owner], ['Territory', l.territory],
              ['Next follow-up', fmtDateTime(l.followUpAt)], ['Existing dealer', l.partyName ? <Link className="text-primary" to={`/sales/dealers/${l.partyId}`}>{l.partyName}</Link> : '—'], ['Notes', l.notes]]} />
          </Card>
          <ActivityTimeline activities={l.activities} canLog={l.canLogActivity} onLog={() => setDialog('activity')} />
        </div>
        <Card title="BANT qualification" actions={a.includes('bant') && <Button size="sm" variant="secondary" onClick={() => setDialog('bant')}>{l.bantScore === null ? 'Assess' : 'Update'}</Button>}>
          <div className="flex items-center gap-5">
            <div className="relative grid h-24 w-24 place-items-center rounded-full" style={{ background: `conic-gradient(#5B38F5 ${score * 3.6}deg, #E9E8F0 0)` }} role="img" aria-label={`BANT score ${score} of 100`}>
              <span className="grid h-[76px] w-[76px] place-items-center rounded-full bg-white font-display text-[24px] font-extrabold num">{l.bantScore ?? '—'}</span>
            </div>
            <p className="text-[14px] text-ink-2">Qualifies at <b className="text-ink">{l.qualifyThreshold}</b> or more.<br />Budget 25 · Authority 25 · Need 5 per point · Timeline up to 25.</p>
          </div>
          {l.bantScore !== null && (
            <ul className="mt-5 space-y-2 text-[14px]">
              {[['Budget confirmed', l.bantBudget], ['Decision maker known', l.bantAuthority]].map(([k, v]) => (
                <li key={k as string} className="flex items-center gap-2">{v ? <CheckCircle size={18} weight="fill" className="text-success-text" /> : <XCircle size={18} weight="fill" className="text-danger-text" />}{k}{k === 'Decision maker known' && l.decisionMaker ? ` — ${l.decisionMaker}` : ''}</li>
              ))}
              <li>Need: <b>{l.bantNeedScore}/5</b></li>
              <li>Buying by: <b>{fmtDate(l.bantTimeline)}</b></li>
            </ul>
          )}
        </Card>
      </div>
      {dialog === 'edit' && <LeadFormDialog lead={l} onClose={() => setDialog(null)} />}
      {dialog === 'bant' && <BantDialog lead={l} onClose={() => setDialog(null)} />}
      {dialog === 'convert' && <ConvertDialog lead={l} onClose={() => setDialog(null)} onDone={(oid) => nav(`/sales/opportunities/${oid}`)} />}
      {dialog === 'transfer' && <TransferDialog lead={l} onClose={() => setDialog(null)} />}
      {dialog === 'activity' && <LogActivityDialog subjectType="lead" subjectId={l.id} onClose={() => setDialog(null)} />}
      <ReasonDialog open={dialog === 'disqualify'} danger title="Disqualify lead" confirmLabel="Disqualify" onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`/crm/leads/${id}/disqualify`, { body: { reason } }); toast('success', 'Lead disqualified.'); await qc.invalidateQueries(); }} />
    </>
  );
}

function BantDialog({ lead, onClose }: { lead: LeadDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ budget: !!lead.bantBudget, authority: !!lead.bantAuthority, decisionMaker: lead.decisionMaker ?? '', needScore: lead.bantNeedScore ?? 3, timeline: lead.bantTimeline?.slice(0, 10) ?? '' });
  const m = useMutation({ mutationFn: () => api<{ score: number }>(`/crm/leads/${lead.id}/bant`, { body: { ...v, decisionMaker: v.decisionMaker || null } }),
    onSuccess: async (r) => { toast('success', `BANT score ${r.score}.`); onClose(); await qc.invalidateQueries(); } });
  return (
    <Modal open onClose={onClose} title="BANT assessment" width={560} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!v.timeline} onClick={() => m.mutate()}>Save score</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={v.budget} onChange={(e) => setV({ ...v, budget: e.target.checked })} /><span><b>Budget</b> — funds are approved for this purchase</span></label>
        <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={v.authority} onChange={(e) => setV({ ...v, authority: e.target.checked })} /><span><b>Authority</b> — we are talking to the decision maker</span></label>
        <Field label="Decision maker" htmlFor="bdm"><Input id="bdm" value={v.decisionMaker} onChange={(e) => setV({ ...v, decisionMaker: e.target.value })} /></Field>
        <Field label={`Need — how strong is the requirement? (${v.needScore}/5)`} htmlFor="bneed"><input id="bneed" type="range" min={1} max={5} value={v.needScore} onChange={(e) => setV({ ...v, needScore: Number(e.target.value) })} className="w-full accent-[#5B38F5]" /></Field>
        <Field label="Timeline — expected purchase date" htmlFor="btl" required><Input id="btl" type="date" value={v.timeline} onChange={(e) => setV({ ...v, timeline: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function ConvertDialog({ lead, onClose, onDone }: { lead: LeadDetail; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ title: `${lead.productInterest}`.slice(0, 200), value: '', expectedClose: lead.bantTimeline?.slice(0, 10) ?? '' });
  const m = useMutation({ mutationFn: () => api<{ id: string; code: string }>(`/crm/leads/${lead.id}/convert`, { body: { title: v.title, value: Number(v.value), expectedClose: v.expectedClose || null } }),
    onSuccess: async (r) => { toast('success', `Opportunity ${r.code} created.`); await qc.invalidateQueries(); onDone(r.id); } });
  return (
    <Modal open onClose={onClose} title="Convert to opportunity" width={560} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!v.title || v.value === ''} onClick={() => m.mutate()}>Create opportunity</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        <Field label="Opportunity title" htmlFor="otitle" required><Input id="otitle" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Estimated value (₹)" htmlFor="oval" required><Input id="oval" type="number" min={0} value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} /></Field>
        <Field label="Expected close" htmlFor="oclose"><Input id="oclose" type="date" value={v.expectedClose} onChange={(e) => setV({ ...v, expectedClose: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function TransferDialog({ lead, onClose }: { lead: LeadDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const people = useSalesPeople();
  const terrs = useTerritories();
  const [owner, setOwner] = useState('');
  const [terr, setTerr] = useState(lead.territoryId);
  return (
    <ReasonDialog open title="Reassign lead" confirmLabel="Reassign" onClose={onClose} description="The new owner is notified. The previous owner is kept in the audit log."
      onConfirm={async (reason) => { await api(`/crm/leads/${lead.id}/transfer`, { body: { ownerId: owner, territoryId: terr, reason } }); toast('success', 'Lead reassigned.'); await qc.invalidateQueries(); }}>
      <Field label="New owner" htmlFor="town" required><Select id="town" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Select…</option>{people.data?.data.filter((p) => p.salesTier && p.id !== lead.ownerId).map((p) => <option key={p.id} value={p.id}>{p.fullName} ({p.salesTier})</option>)}</Select></Field>
      <Field label="Territory" htmlFor="tter"><Select id="tter" value={terr} onChange={(e) => setTerr(e.target.value)}>{terrs.data?.data.filter((t) => t.status === 'Active').map((t) => <option key={t.id} value={t.id}>{'· '.repeat(t.level - 1)}{t.name}</option>)}</Select></Field>
    </ReasonDialog>
  );
}

// ---------------------------------------------------------------- activities
export function ActivityTimeline({ activities, canLog, onLog }: { activities: Activity[]; canLog: boolean; onLog: () => void }) {
  return (
    <Card title="Activities" actions={canLog && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={onLog}>Log activity</Button>}>
      {activities.length === 0 ? <p className="text-ink-2">No calls, visits or meetings recorded yet.</p> : (
        <ol className="relative space-y-5 border-l-2 border-line pl-6">
          {activities.map((a) => {
            const overdue = a.status === 'Planned' && new Date(a.plannedAt) < new Date();
            return (
              <li key={a.id} className="relative">
                <span className={clsx('absolute -left-[31px] top-1 h-3.5 w-3.5 rounded-full ring-4 ring-white', a.status === 'Done' ? 'bg-success' : a.status === 'Cancelled' ? 'bg-ink-muted' : overdue ? 'bg-danger' : 'bg-primary')} aria-hidden />
                <p className="font-medium">{KIND_LABEL[a.kind]} — {a.title}</p>
                <p className="text-[13px] text-ink-2">{a.owner} · {a.status === 'Done' ? `done ${fmtDateTime(a.doneAt)}` : `${a.status === 'Planned' ? 'planned' : 'was planned'} ${fmtDateTime(a.plannedAt)}`}{overdue && <b className="ml-1 text-danger-text">overdue</b>}</p>
                {a.outcome && <p className="mt-1 rounded-sm bg-canvas px-3 py-2 text-[14px]">{a.outcome}</p>}
                {a.notes && <p className="mt-1 text-[14px] text-ink-2">{a.notes}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function LogActivityDialog({ subjectType, subjectId, onClose }: { subjectType: 'lead' | 'opportunity' | 'dealer'; subjectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({ kind: 'CALL', title: '', notes: '', when: toLocalInput(new Date()), done: true, outcome: '' });
  const m = useMutation({
    mutationFn: async () => {
      let pos: GeolocationPosition | null = null;
      if (v.done && ['DEALER_VISIT', 'FIELD_VISIT'].includes(v.kind) && 'geolocation' in navigator) {
        pos = await new Promise((res) => navigator.geolocation.getCurrentPosition(res, () => res(null), { timeout: 4000 }));
      }
      return api('/crm/activities', { body: { subjectType, subjectId, kind: v.kind, title: v.title, notes: v.notes || null, plannedAt: fromLocalInput(v.when), done: v.done,
        outcome: v.done ? v.outcome : null, latitude: pos?.coords.latitude ?? null, longitude: pos?.coords.longitude ?? null } });
    },
    onSuccess: async () => { toast('success', v.done ? 'Activity recorded.' : 'Activity planned.'); onClose(); await qc.invalidateQueries(); },
  });
  return (
    <Modal open onClose={onClose} title="Log activity" width={600} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!v.title || (v.done && !v.outcome)} onClick={() => m.mutate()}>{v.done ? 'Record' : 'Plan'}</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="akind2"><Select id="akind2" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select></Field>
        <Field label="When" htmlFor="awhen"><Input id="awhen" type="datetime-local" value={v.when} onChange={(e) => setV({ ...v, when: e.target.value })} /></Field>
        <div className="sm:col-span-2"><Field label="Subject" htmlFor="atitle" required><Input id="atitle" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field></div>
        <fieldset className="flex gap-6 sm:col-span-2"><legend className="sr-only">Status</legend>
          <label className="flex items-center gap-2"><input type="radio" checked={v.done} onChange={() => setV({ ...v, done: true })} />Already done</label>
          <label className="flex items-center gap-2"><input type="radio" checked={!v.done} onChange={() => setV({ ...v, done: false })} />Plan for later</label>
        </fieldset>
        {v.done && <div className="sm:col-span-2"><Field label="Outcome" htmlFor="aout" required hint="Visits record your GPS position if the browser allows it"><Textarea id="aout" value={v.outcome} onChange={(e) => setV({ ...v, outcome: e.target.value })} /></Field></div>}
        <div className="sm:col-span-2"><Field label="Notes" htmlFor="anotes"><Input id="anotes" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field></div>
      </div>
    </Modal>
  );
}

interface ActRow extends Activity { subjectType: string; subjectId: string; subjectName: string; subjectCode: string }
export function ActivitiesPage() {
  const q = useQuery({ queryKey: ['my-activities'], queryFn: () => api<{ data: ActRow[] }>('/crm/activities?view=mine') });
  const [done, setDone] = useState<ActRow | null>(null);
  const now = new Date();
  const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
  const groups: [string, ActRow[]][] = [
    ['Overdue', (q.data?.data ?? []).filter((a) => new Date(a.plannedAt) < now)],
    ['Today', (q.data?.data ?? []).filter((a) => new Date(a.plannedAt) >= now && new Date(a.plannedAt) <= endToday)],
    ['Upcoming', (q.data?.data ?? []).filter((a) => new Date(a.plannedAt) > endToday)],
  ];
  const link = (a: ActRow) => (a.subjectType === 'lead' ? `/sales/leads/${a.subjectId}` : a.subjectType === 'opportunity' ? `/sales/opportunities/${a.subjectId}` : `/sales/dealers/${a.subjectId}`);
  return (
    <>
      <PageHeader title="My activities" subtitle="Calls, visits and follow-ups you have planned (BRD §4 #5)." />
      <ErrorBanner error={q.error} />
      {q.isLoading ? <Skeleton className="h-64" /> : q.data?.data.length === 0 ? <div className="card"><EmptyState title="Nothing planned" text="Plan follow-ups from a lead or opportunity." /></div> : (
        <div className="grid gap-6 xl:grid-cols-3">
          {groups.map(([label, items]) => (
            <Card key={label} title={<span className={clsx(label === 'Overdue' && items.length && 'text-danger-text')}>{label} <span className="text-ink-2 num">({items.length})</span></span>}>
              {items.length === 0 ? <p className="text-ink-2">None.</p> : (
                <ul className="space-y-3">{items.map((a) => (
                  <li key={a.id} className="rounded-md border border-line p-4">
                    <p className="font-medium">{KIND_LABEL[a.kind]} — {a.title}</p>
                    <Link to={link(a)} className="text-[13px] font-semibold text-primary">{a.subjectCode} · {a.subjectName}</Link>
                    <p className="text-[13px] text-ink-2">{fmtDateTime(a.plannedAt)}</p>
                    <Button size="sm" className="mt-2" icon={<CalendarCheck size={16} />} onClick={() => setDone(a)}>Complete</Button>
                  </li>))}</ul>
              )}
            </Card>
          ))}
        </div>
      )}
      {done && <CompleteDialog a={done} onClose={() => setDone(null)} />}
    </>
  );
}

function CompleteDialog({ a, onClose }: { a: ActRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState(false);
  const [n, setN] = useState({ kind: 'FOLLOW_UP', title: '', when: toLocalInput(new Date(Date.now() + 3 * 86_400_000)) });
  const m = useMutation({ mutationFn: () => api(`/crm/activities/${a.id}/complete`, { body: { outcome, nextAction: next ? { kind: n.kind, title: n.title, plannedAt: fromLocalInput(n.when) } : null } }),
    onSuccess: async () => { toast('success', 'Activity completed.'); onClose(); await qc.invalidateQueries(); } });
  return (
    <Modal open onClose={onClose} title={`Complete: ${a.title}`} width={560} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!outcome || (next && !n.title)} onClick={() => m.mutate()}>Complete</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        <Field label="Outcome" htmlFor="cout" required><Textarea id="cout" value={outcome} onChange={(e) => setOutcome(e.target.value)} /></Field>
        <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" checked={next} onChange={(e) => setNext(e.target.checked)} />Plan the next action</label>
        {next && <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" htmlFor="nkind"><Select id="nkind" value={n.kind} onChange={(e) => setN({ ...n, kind: e.target.value })}>{ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</Select></Field>
          <Field label="When" htmlFor="nwhen"><Input id="nwhen" type="datetime-local" value={n.when} onChange={(e) => setN({ ...n, when: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Subject" htmlFor="ntitle" required><Input id="ntitle" value={n.title} onChange={(e) => setN({ ...n, title: e.target.value })} /></Field></div>
        </div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- pipeline (BRD §4 #4, Kanban)
interface Opp { id: string; code: string; company: string; title: string; partyId: string | null; partyName: string | null; owner: string; stage: string; value: string; probability: number; expectedClose: string | null; lossReason: string | null; closedAt: string | null; version: number; territory: string; productInterest: string | null }

export function PipelinePage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [mine, setMine] = useState<'all' | 'mine'>('all');
  const [newOpen, setNewOpen] = useState(false);
  const q = useQuery({ queryKey: ['pipeline', mine], queryFn: () => api<{ data: Opp[] }>(`/crm/opportunities${mine === 'mine' ? '?mine=true' : ''}`) });
  const [closing, setClosing] = useState<{ opp: Opp; stage: 'WON' | 'LOST' } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const move = async (opp: Opp, stage: string) => {
    if (stage === opp.stage) return;
    if (stage === 'WON' || stage === 'LOST') { setClosing({ opp, stage }); return; }
    try { await api(`/crm/opportunities/${opp.id}/stage`, { body: { stage } }); toast('success', `${opp.code} moved to ${STAGE_LABEL[stage]}.`); await qc.invalidateQueries(); }
    catch (e) { toast('error', (e as Error).message); }
  };
  const opps = q.data?.data ?? [];
  const cols = [...OPEN_STAGES, 'WON', 'LOST'];
  return (
    <>
      <PageHeader title="Opportunity pipeline" subtitle="Drag a card to move it, or use “Move to”. Won needs an active dealer; lost needs a reason. Closed cards stay visible for 30 days."
        actions={can('crm.opportunity:create') && <Button icon={<Plus size={18} weight="bold" />} onClick={() => setNewOpen(true)}>Opportunity for a dealer</Button>} />
      <CrmSummary />
      <Tabs value={mine} onChange={setMine} tabs={[{ value: 'all', label: 'All in my territory' }, { value: 'mine', label: 'Owned by me' }]} />
      <ErrorBanner error={q.error} />
      <div className="flex gap-4 overflow-x-auto pb-4">
        {cols.map((stage) => {
          const items = opps.filter((o) => o.stage === stage);
          const total = items.reduce((a, o) => a + Number(o.value), 0);
          return (
            <section key={stage} aria-label={STAGE_LABEL[stage]} onDragOver={(e) => e.preventDefault()}
              onDrop={() => { const o = opps.find((x) => x.id === dragging); if (o && OPEN_STAGES.includes(o.stage as never)) void move(o, stage); setDragging(null); }}
              className={clsx('flex w-[290px] shrink-0 flex-col rounded-xl p-3', stage === 'WON' ? 'bg-success-bg/60' : stage === 'LOST' ? 'bg-danger-bg/60' : 'bg-[#EFEDF8]')}>
              <header className="mb-3 flex items-center justify-between px-1">
                <h2 className="font-semibold">{STAGE_LABEL[stage]} <span className="text-ink-2 num">{items.length}</span></h2>
                <span className="text-[13px] font-semibold text-ink-2 num">{fmtINR(total).replace('.00', '')}</span>
              </header>
              <ul className="flex min-h-[80px] flex-col gap-3">
                {items.map((o) => {
                  const open = OPEN_STAGES.includes(o.stage as never);
                  return (
                    <li key={o.id} draggable={open && can('crm.opportunity:edit')} onDragStart={() => setDragging(o.id)}
                      className={clsx('rounded-lg bg-white p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-hover', open && 'cursor-grab')}>
                      <Link to={`/sales/opportunities/${o.id}`} className="block font-semibold hover:text-primary">{o.title}</Link>
                      <p className="text-[13px] text-ink-2">{o.code} · {o.partyName ?? o.company}</p>
                      <p className="mt-2 flex items-center justify-between"><span className="font-display text-[18px] font-extrabold num">{fmtINR(o.value).replace('.00', '')}</span><span className="rounded-full bg-primary-soft px-2 py-0.5 text-[12px] font-semibold text-primary-hover num">{o.probability}%</span></p>
                      <p className="mt-1 text-[12px] text-ink-2">{o.owner}{o.expectedClose ? ` · close ${fmtDate(o.expectedClose)}` : ''}</p>
                      {o.lossReason && <p className="mt-1 text-[12px] font-medium text-danger-text">{LOSS_LABEL[o.lossReason]}</p>}
                      {open && can('crm.opportunity:edit') && (
                        <Select aria-label={`Move ${o.code} to`} className="mt-3 h-9 text-[13px]" value="" onChange={(e) => e.target.value && move(o, e.target.value)}>
                          <option value="">Move to…</option>{cols.filter((s) => s !== o.stage).map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                        </Select>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {closing && <CloseDialog opp={closing.opp} stage={closing.stage} onClose={() => setClosing(null)} />}
      {newOpen && <NewDealerOpportunityDialog onClose={() => setNewOpen(false)} />}
    </>
  );
}

function CloseDialog({ opp, stage, onClose }: { opp: Opp; stage: 'WON' | 'LOST'; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/crm/opportunities/${opp.id}/stage`, { body: { stage, lossReason: stage === 'LOST' ? reason : null, note } }),
    onSuccess: async () => { toast('success', stage === 'WON' ? `${opp.code} won.` : `${opp.code} closed as lost.`); onClose(); await qc.invalidateQueries(); } });
  return (
    <Modal open onClose={onClose} title={stage === 'WON' ? `Mark ${opp.code} as won` : `Mark ${opp.code} as lost`} width={520}
      description={stage === 'WON' ? 'Needs the registered, active dealer linked on the opportunity.' : 'The reason feeds win/loss analysis.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={stage === 'LOST' ? 'danger' : 'primary'} loading={m.isPending} disabled={stage === 'LOST' && !reason} onClick={() => m.mutate()}>Confirm</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        {stage === 'LOST' && <Field label="Why was it lost?" htmlFor="lreason" required><Select id="lreason" value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Select…</option>{LOSS_REASONS.map((r) => <option key={r} value={r}>{LOSS_LABEL[r]}</option>)}</Select></Field>}
        <Field label={stage === 'WON' ? 'Note (e.g. PO reference)' : 'Details'} htmlFor="lnote"><Textarea id="lnote" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function useActiveDealers() {
  return useQuery({ queryKey: ['dealers-active'], queryFn: () => api<Page<{ id: string; code: string; legalName: string }>>('/dealers?limit=100&status=Active') });
}

function NewDealerOpportunityDialog({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const dealers = useActiveDealers();
  const [v, setV] = useState({ partyId: '', title: '', value: '', probability: '10', expectedClose: '' });
  const m = useMutation({ mutationFn: () => api<{ id: string }>('/crm/opportunities', { body: { partyId: v.partyId, title: v.title, value: Number(v.value), probability: Number(v.probability), expectedClose: v.expectedClose || null } }),
    onSuccess: async (r) => { await qc.invalidateQueries(); nav(`/sales/opportunities/${r.id}`); } });
  return (
    <Modal open onClose={onClose} title="Opportunity for an existing dealer" width={560} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!v.partyId || !v.title || v.value === ''} onClick={() => m.mutate()}>Create</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="space-y-4">
        <Field label="Dealer" htmlFor="ndl" required><Select id="ndl" value={v.partyId} onChange={(e) => setV({ ...v, partyId: e.target.value })}><option value="">Select…</option>{dealers.data?.data.map((d) => <option key={d.id} value={d.id}>{d.code} — {d.legalName}</option>)}</Select></Field>
        <Field label="Title" htmlFor="ntl" required><Input id="ntl" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Value (₹)" htmlFor="nvl" required><Input id="nvl" type="number" min={0} value={v.value} onChange={(e) => setV({ ...v, value: e.target.value })} /></Field>
          <Field label="Win %" htmlFor="npr"><Input id="npr" type="number" min={0} max={100} value={v.probability} onChange={(e) => setV({ ...v, probability: e.target.value })} /></Field>
          <Field label="Expected close" htmlFor="ncl"><Input id="ncl" type="date" value={v.expectedClose} onChange={(e) => setV({ ...v, expectedClose: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}

interface OppDetail extends Opp { leadId: string | null; lossNotes: string | null; history: { fromStage: string | null; toStage: string; value: string; changedAt: string; changedBy: string; note: string | null }[]; activities: Activity[]; allowedActions: string[]; canLogActivity: boolean }

export function OpportunityDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const dealers = useActiveDealers();
  const { can } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['opportunity', id], queryFn: () => api<OppDetail>(`/crm/opportunities/${id}`) });
  const [dialog, setDialog] = useState<null | 'edit' | 'activity' | 'reopen' | 'WON' | 'LOST'>(null);
  const [e, setE] = useState({ title: '', value: '', probability: '', expectedClose: '', partyId: '' });
  const save = useMutation({ mutationFn: () => api(`/crm/opportunities/${id}`, { method: 'PUT', body: { title: e.title, value: Number(e.value), probability: Number(e.probability), expectedClose: e.expectedClose || null, partyId: e.partyId || null, version: q.data!.version } }),
    onSuccess: async () => { toast('success', 'Saved.'); setDialog(null); await qc.invalidateQueries(); } });
  const o = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!o) return <ErrorBanner error={q.error} />;
  const a = o.allowedActions;
  const stageMove = async (stage: string) => { try { await api(`/crm/opportunities/${id}/stage`, { body: { stage } }); toast('success', `Moved to ${STAGE_LABEL[stage]}.`); await qc.invalidateQueries(); } catch (err) { toast('error', (err as Error).message); } };
  return (
    <>
      <PageHeader title={o.title} crumbs={<Link to="/sales/opportunities" className="hover:text-primary">Pipeline</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><span className="font-semibold num">{o.code}</span><StatusBadge status={o.stage === 'WON' ? 'Approved' : o.stage === 'LOST' ? 'Rejected' : 'Pending'} label={STAGE_LABEL[o.stage]} />
          {o.leadId && <Link to={`/sales/leads/${o.leadId}`} className="font-semibold text-primary">From lead →</Link>}</span>}
        actions={<>
          {o.partyId && (OPEN_STAGES as readonly string[]).includes(o.stage) && can('sales.quotation:create') &&
            <Button variant="secondary" onClick={() => nav(`/sales/quotations/new?partyId=${o.partyId}&opportunityId=${o.id}`)}>Create quotation</Button>}
          {a.includes('edit') && <Button variant="secondary" onClick={() => { setE({ title: o.title, value: String(Number(o.value)), probability: String(o.probability), expectedClose: o.expectedClose?.slice(0, 10) ?? '', partyId: o.partyId ?? '' }); setDialog('edit'); }}>Edit</Button>}
          {a.includes('stage') && <Button variant="danger" onClick={() => setDialog('LOST')}>Mark lost</Button>}
          {a.includes('stage') && <Button icon={<Trophy size={18} />} onClick={() => setDialog('WON')}>Mark won</Button>}
          {a.includes('reopen') && <Button variant="secondary" onClick={() => setDialog('reopen')}>Reopen</Button>}
        </>} />
      {a.includes('stage') && (
        <nav aria-label="Stage" className="mb-6 flex flex-wrap gap-2">
          {OPEN_STAGES.map((s, i) => {
            const cur = OPEN_STAGES.indexOf(o.stage as never);
            return <button key={s} onClick={() => stageMove(s)} aria-current={s === o.stage ? 'step' : undefined}
              className={clsx('h-10 rounded-full px-4 text-[14px] font-medium transition', s === o.stage ? 'bg-primary text-white shadow-primary' : i < cur ? 'bg-primary-soft text-primary-hover' : 'bg-white text-ink-2 hover:bg-primary-tint')}>{i + 1}. {STAGE_LABEL[s]}</button>;
          })}
        </nav>
      )}
      <div className="grid gap-6 2xl:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Card title="Opportunity">
            <KeyValues items={[['Customer', o.partyName ? <Link className="text-primary" to={`/sales/dealers/${o.partyId}`}>{o.partyName}</Link> : <span>{o.company} <span className="text-warning-text">(not yet a registered dealer)</span></span>],
              ['Value', fmtINR(o.value)], ['Win probability', `${o.probability}%`], ['Weighted value', fmtINR(Number(o.value) * o.probability / 100)], ['Expected close', fmtDate(o.expectedClose)],
              ['Owner', o.owner], ['Territory', o.territory], ['Product', o.productInterest], ...(o.lossReason ? [['Loss reason', `${LOSS_LABEL[o.lossReason]}${o.lossNotes ? ` — ${o.lossNotes}` : ''}`] as [string, string]] : [])]} />
          </Card>
          <ActivityTimeline activities={o.activities} canLog={o.canLogActivity} onLog={() => setDialog('activity')} />
        </div>
        <Card title="Stage history">
          <ol className="space-y-4">{o.history.map((h, i) => (
            <li key={i}><p className="font-medium">{h.fromStage ? `${STAGE_LABEL[h.fromStage]} → ` : ''}{STAGE_LABEL[h.toStage]}</p>
              <p className="text-[13px] text-ink-2">{h.changedBy ?? 'system'} · {fmtDateTime(h.changedAt)} · {fmtINR(h.value)}</p>{h.note && <p className="text-[14px]">{h.note}</p>}</li>))}</ol>
        </Card>
      </div>
      <Modal open={dialog === 'edit'} onClose={() => setDialog(null)} title="Edit opportunity" width={600} footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
        <ErrorBanner error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Title" htmlFor="etitle" required><Input id="etitle" value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} /></Field></div>
          <Field label="Value (₹)" htmlFor="evalue" required><Input id="evalue" type="number" min={0} value={e.value} onChange={(x) => setE({ ...e, value: x.target.value })} /></Field>
          <Field label="Win %" htmlFor="eprob" required><Input id="eprob" type="number" min={0} max={100} value={e.probability} onChange={(x) => setE({ ...e, probability: x.target.value })} /></Field>
          <Field label="Expected close" htmlFor="eclose"><Input id="eclose" type="date" value={e.expectedClose} onChange={(x) => setE({ ...e, expectedClose: x.target.value })} /></Field>
          <Field label="Registered dealer" htmlFor="eparty" hint="Required before marking won"><Select id="eparty" value={e.partyId} onChange={(x) => setE({ ...e, partyId: x.target.value })}><option value="">Not linked</option>{dealers.data?.data.map((d) => <option key={d.id} value={d.id}>{d.code} — {d.legalName}</option>)}</Select></Field>
        </div>
      </Modal>
      {(dialog === 'WON' || dialog === 'LOST') && <CloseDialog opp={o} stage={dialog} onClose={() => setDialog(null)} />}
      {dialog === 'activity' && <LogActivityDialog subjectType="opportunity" subjectId={o.id} onClose={() => setDialog(null)} />}
      <ReasonDialog open={dialog === 'reopen'} title="Reopen opportunity" confirmLabel="Reopen" onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`/crm/opportunities/${id}/reopen`, { body: { reason } }); toast('success', 'Reopened.'); await qc.invalidateQueries(); }} />
    </>
  );
}
