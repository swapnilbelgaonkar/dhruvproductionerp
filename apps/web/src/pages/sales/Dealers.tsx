import { zodResolver } from '@hookform/resolvers/zod';
import { addressSchema, CONSTITUTIONS, DEALER_CATEGORIES, DEALER_LICENCE_TYPES, dealerSchema, ID_TYPES, INDIAN_STATES } from '@dhruv/contracts';
import { CheckCircle, Plus, SealCheck, UploadSimple, Warning, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable } from '../../components/DataTable';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api, ApiError, uploadFile, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR } from '../../lib/format';

const CONSTITUTION_LABEL: Record<string, string> = { PROPRIETORSHIP: 'Proprietorship', PARTNERSHIP: 'Partnership', LLP: 'LLP', PVT_LTD: 'Private Limited', PUBLIC_LTD: 'Public Limited', FPO: 'Farmer Producer Company (FPO)' };
const LICENCE_LABEL: Record<string, string> = { FERTILIZER: 'Fertilizer (FCO 1985)', PESTICIDE: 'Pesticide (Insecticides Act 1968)', BIOSTIMULANT: 'Bio-stimulant (FCO Sch. VI)' };
const LICENCE_DOC: Record<string, string> = { FERTILIZER: 'FERTILIZER_LICENCE', PESTICIDE: 'PESTICIDE_LICENCE', BIOSTIMULANT: 'BIOSTIMULANT_REGISTRATION' };
const today = () => new Date().toISOString().slice(0, 10);

interface DealerRow { id: string; code: string; legalName: string; tradeName: string | null; constitution: string; gstin: string | null; territory: string; salesOwner: string; status: string; creditLimit: string; licenceTypes: string[]; nextLicenceExpiry: string | null }

export function DealersPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('mdm.dealer:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/sales/dealers/new')}>Register dealer</Button> : undefined;
  return (
    <>
      <PageHeader title="Dealers & Distributors" subtitle="Registration, KYC, licences and credit — active only after document, commercial, finance and final approval (BRD §3.1)." actions={create} />
      <DataTable<DealerRow> queryKey="dealers" path="/dealers" rowHref={(r) => `/sales/dealers/${r.id}`} searchPlaceholder="Search code, name, GSTIN or mobile"
        statusOptions={['Draft', 'Submitted', 'Active', 'Rejected', 'Suspended']}
        empty={{ title: 'No dealers yet', text: 'Register a dealer, complete the KYC checklist and submit it for approval.', action: create }}
        columns={[
          { key: 'code', header: 'Code', render: (r) => <span className="font-semibold num">{r.code}</span> },
          { key: 'name', header: 'Dealer', render: (r) => <span><span className="block font-medium">{r.legalName}</span><span className="text-[13px] text-ink-2">{r.gstin ?? 'Not GST registered'}</span></span> },
          { key: 'terr', header: 'Territory / owner', render: (r) => <span><span className="block">{r.territory}</span><span className="text-[13px] text-ink-2">{r.salesOwner}</span></span> },
          { key: 'credit', header: 'Credit limit', render: (r) => <span className="num">{fmtINR(r.creditLimit)}</span> },
          { key: 'lic', header: 'Licence expiry', render: (r) => {
            if (!r.nextLicenceExpiry) return r.licenceTypes.length ? <span className="text-warning-text">Missing</span> : '—';
            const days = Math.ceil((new Date(r.nextLicenceExpiry).getTime() - Date.now()) / 86_400_000);
            return <span className={clsx(days < 0 ? 'font-semibold text-danger-text' : days <= 60 && 'font-semibold text-warning-text')}>{fmtDate(r.nextLicenceExpiry)}</span>;
          } },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------- registration / edit form
type DealerForm = z.input<typeof dealerSchema>;

export function DealerFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['dealer', id], queryFn: () => api<DealerForm & { version: number }>(`/dealers/${id}`), enabled: !!id });
  const terrs = useQuery({ queryKey: ['territories'], queryFn: () => api<{ data: { id: string; name: string; level: number; levelName: string; status: string }[] }>('/territories') });
  const owners = useQuery({ queryKey: ['sales-employees'], queryFn: () => api<Page<{ id: string; fullName: string; empCode: string; salesTier: string | null; status: string }>>('/employees?limit=100&status=Active') });
  const [error, setError] = useState<unknown>(null);
  const [dupWarn, setDupWarn] = useState<string | null>(null);
  const f = useForm<DealerForm>({
    resolver: zodResolver(z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? null : v])), dealerSchema)),
    defaultValues: { gstRegistered: true, licenceTypes: [], creditDays: 0, creditLimit: 0, dealerCategory: 'DEALER', constitution: 'PROPRIETORSHIP', priceGroup: 'STANDARD' },
    values: existing.data ? { ...existing.data, gstin: existing.data.gstin ?? '', email: existing.data.email ?? '', tradeName: existing.data.tradeName ?? '', creditLimit: Number(existing.data.creditLimit), annualTarget: existing.data.annualTarget === null || existing.data.annualTarget === undefined ? null : Number(existing.data.annualTarget) } as DealerForm : undefined,
  });
  if (id && existing.isLoading) return <Skeleton className="h-96" />;
  const gstRegistered = f.watch('gstRegistered');
  const err = (k: string) => (f.formState.errors as Record<string, { message?: string }>)[k]?.message;
  const num = { setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)) };

  const checkDup = async () => {
    const v = f.getValues();
    if (!v.pan && !v.gstin && !v.mobile) return;
    const r = await api<{ data: { code: string; legalName: string; matches: string[] }[] }>(`/dealers/duplicates?gstin=${v.gstin ?? ''}&pan=${v.pan ?? ''}&mobile=${v.mobile ?? ''}${id ? `&excludeId=${id}` : ''}`).catch(() => null);
    setDupWarn(r?.data.length ? r.data.map((d) => `${d.code} ${d.legalName} (same ${d.matches.join(', ')})`).join('; ') : null);
  };

  const save = f.handleSubmit(async (v) => {
    setError(null);
    try {
      if (id) { await api(`/dealers/${id}`, { method: 'PUT', body: { ...v, version: existing.data!.version } }); await qc.invalidateQueries(); toast('success', 'Saved.'); nav(`/sales/dealers/${id}`); }
      else { const r = await api<{ id: string; code: string }>('/dealers', { body: v }); toast('success', `Dealer ${r.code} saved as Draft. Complete the checklist next.`); nav(`/sales/dealers/${r.id}`); }
    } catch (e) { if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k as 'pan', { message: m })); setError(e); }
  });

  return (
    <>
      <PageHeader title={id ? 'Edit dealer' : 'Register dealer'} crumbs={<Link to="/sales/dealers" className="hover:text-primary">Dealers</Link>}
        subtitle="Step 1 of 2 — business and commercial details. Addresses, licences, signatories and documents come next on the dealer page." />
      <form noValidate onSubmit={save} className="max-w-5xl space-y-6">
        <ErrorBanner error={error} />
        {dupWarn && <div role="alert" className="flex items-start gap-2 rounded-md bg-warning-bg px-4 py-3 text-warning-text"><Warning size={20} className="shrink-0" />Possible duplicate: {dupWarn}</div>}
        <Card title="1. Business profile">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Legal business name" htmlFor="legalName" required error={err('legalName')} hint="As per GST and PAN"><Input id="legalName" {...f.register('legalName')} /></Field>
            <Field label="Trade name" htmlFor="tradeName" error={err('tradeName')}><Input id="tradeName" {...f.register('tradeName')} /></Field>
            <Field label="Constitution" htmlFor="constitution" required error={err('constitution')}><Select id="constitution" {...f.register('constitution')}>{CONSTITUTIONS.map((c) => <option key={c} value={c}>{CONSTITUTION_LABEL[c]}</option>)}</Select></Field>
            <Field label="Dealer category" htmlFor="dealerCategory" required><Select id="dealerCategory" {...f.register('dealerCategory')}>{DEALER_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
            <Field label="Proprietor / director (contact person)" htmlFor="contactPerson" required error={err('contactPerson')} hint="Full legal name as per PAN"><Input id="contactPerson" {...f.register('contactPerson')} /></Field>
            <Field label="Mobile" htmlFor="mobile" required error={err('mobile')} hint="Used for WhatsApp dispatch alerts"><Input id="mobile" inputMode="numeric" maxLength={10} {...f.register('mobile', { onBlur: checkDup })} /></Field>
            <Field label="Email" htmlFor="email" error={err('email')}><Input id="email" type="email" {...f.register('email')} /></Field>
          </div>
        </Card>
        <Card title="2. Tax identity">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="PAN" htmlFor="pan" required error={err('pan')}><Input id="pan" className="uppercase num" maxLength={10} {...f.register('pan', { setValueAs: (v: string) => v?.toUpperCase(), onBlur: checkDup })} /></Field>
            <label className="flex items-center gap-3 self-end py-3"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" {...f.register('gstRegistered')} />Registered under GST</label>
            {gstRegistered && <Field label="GSTIN" htmlFor="gstin" required error={err('gstin')} hint="15 characters; characters 3–12 must equal the PAN. Upload the certificate on the next step, on the same line."><Input id="gstin" className="uppercase num" maxLength={15} {...f.register('gstin', { setValueAs: (v: string) => v?.toUpperCase(), onBlur: checkDup })} /></Field>}
          </div>
        </Card>
        <Card title="3. Territory & licences">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Territory" htmlFor="territoryId" required error={err('territoryId')}><Select id="territoryId" {...f.register('territoryId')}><option value="">Select…</option>{terrs.data?.data.filter((t) => t.status === 'Active').map((t) => <option key={t.id} value={t.id}>{'· '.repeat(t.level - 1)}{t.name} ({t.levelName})</option>)}</Select></Field>
            <Field label="Sales owner" htmlFor="salesOwnerId" required error={err('salesOwnerId')}><Select id="salesOwnerId" {...f.register('salesOwnerId')}><option value="">Select…</option>{owners.data?.data.filter((e) => e.salesTier).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.salesTier})</option>)}</Select></Field>
            <fieldset className="md:col-span-2"><legend className="label">Products the dealer will buy — each needs the matching licence</legend>
              <div className="flex flex-wrap gap-4">{DEALER_LICENCE_TYPES.map((t) => <label key={t} className="flex items-center gap-2"><input type="checkbox" value={t} className="h-5 w-5 accent-[#5B38F5]" {...f.register('licenceTypes')} />{LICENCE_LABEL[t]}</label>)}</div>
            </fieldset>
          </div>
        </Card>
        <Card title="4. Commercial terms">
          <div className="grid gap-5 md:grid-cols-3">
            <Field label="Credit limit (₹)" htmlFor="creditLimit" required error={err('creditLimit')} hint="0 for advance-payment dealers"><Input id="creditLimit" type="number" min={0} {...f.register('creditLimit', num)} /></Field>
            <Field label="Credit days" htmlFor="creditDays" required error={err('creditDays')} hint="Invoices older than this freeze ordering (BRD p.7)"><Input id="creditDays" type="number" min={0} max={365} {...f.register('creditDays', num)} /></Field>
            <Field label="Price group" htmlFor="priceGroup" required error={err('priceGroup')}><Input id="priceGroup" className="uppercase" {...f.register('priceGroup', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>
            <Field label="Annual business target (₹)" htmlFor="annualTarget" error={err('annualTarget')}><Input id="annualTarget" type="number" min={0} {...f.register('annualTarget', num)} /></Field>
            <Field label="Target financial year" htmlFor="targetFy" error={err('targetFy')} hint="e.g. 2026-27"><Input id="targetFy" {...f.register('targetFy')} /></Field>
          </div>
        </Card>
        <div className="flex gap-2"><Button type="submit" loading={f.formState.isSubmitting}>{id ? 'Save' : 'Save & continue'}</Button><Button type="button" variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- detail
interface Dealer {
  id: string; code: string; legalName: string; tradeName: string | null; constitution: string; pan: string; gstRegistered: boolean; gstin: string | null;
  contactPerson: string; mobile: string; email: string | null; dealerCategory: string; territory: string; salesOwner: string; licenceTypes: string[];
  priceGroup: string; creditDays: number; creditLimit: string; annualTarget: string | null; targetFy: string | null; status: string; statusReason: string | null;
  activatedAt: string | null; version: number;
  addresses: { id: string; kind: string; label: string | null; line1: string; line2: string | null; city: string; district: string; stateCode: string; pincode: string }[];
  licences: { id: string; licenceType: string; number: string; issuer: string; validFrom: string; validTo: string; verification: string; remarks: string | null; verifiedBy: string | null; verifiedAt: string | null; documentId: string; status: string }[];
  signatories: { id: string; fullName: string; designation: string; idType: string; idLast4: string }[];
  approvals: { id: string; doc_no: string; status: string; submitted_at: string; initiator: string }[];
  readiness: { ready: boolean; policy: string; checks: { key: string; label: string; ok: boolean; detail?: string }[] } | null;
  allowedActions: string[]; canEditDetails: boolean; canAddLicence: boolean; canVerify: boolean;
}

function FilePick({ onFile, label = 'Choose file' }: { onFile: (f: File) => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" size="sm" variant="secondary" icon={<UploadSimple size={16} />} onClick={() => ref.current?.click()}>{label}</Button>
    <input ref={ref} type="file" accept="application/pdf,image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
  </>;
}

/** BRD p.7 "same-line" rule: the GST certificate upload sits on the same row as the GSTIN. */
function GstinRow({ d, canUpload }: { d: Dealer; canUpload: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const docs = useQuery({ queryKey: ['documents', 'mdm.party', d.id], queryFn: () => api<{ data: { documentType: string; status: string; title: string }[] }>(`/documents?entityType=mdm.party&entityId=${d.id}`) });
  const has = docs.data?.data.some((x) => x.documentType === 'GST_CERTIFICATE' && x.status === 'Active');
  const up = async (file: File) => {
    try { await uploadFile('/documents', file, { documentType: 'GST_CERTIFICATE', entityType: 'mdm.party', entityId: d.id, title: `GST certificate ${d.gstin}` }); toast('success', 'GST certificate uploaded.'); await qc.invalidateQueries(); }
    catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-canvas px-4 py-3">
      <span className="text-[12px] font-medium uppercase tracking-wide text-ink-2">GSTIN</span>
      <span className="font-semibold num">{d.gstin}</span>
      <span className="flex-1" />
      {has ? <StatusBadge status="Active" label="Certificate uploaded" /> : <StatusBadge status="Pending" label="Certificate missing" />}
      {canUpload && !has && <FilePick onFile={up} label="Upload certificate" />}
    </div>
  );
}

export function DealerDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['dealer', id], queryFn: () => api<Dealer>(`/dealers/${id}`) });
  const [dialog, setDialog] = useState<null | 'address' | 'licence' | 'signatory' | 'suspend' | 'reactivate'>(null);
  const [verify, setVerify] = useState<{ id: string; label: string; verification: 'Verified' | 'Rejected' } | null>(null);
  const submit = useMutation({ mutationFn: () => api<{ approvalDocNo: string }>(`/dealers/${id}/submit`, { method: 'POST' }),
    onSuccess: async (r) => { toast('success', `Submitted for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } });
  const remove = async (path: string) => { try { await api(path, { method: 'POST' }); await qc.invalidateQueries({ queryKey: ['dealer', id] }); } catch (e) { toast('error', (e as Error).message); } };
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const close = async () => { setDialog(null); await qc.invalidateQueries({ queryKey: ['dealer', id] }); await qc.invalidateQueries({ queryKey: ['documents', 'mdm.party', id] }); };

  return (
    <>
      <PageHeader title={d.legalName} crumbs={<Link to="/sales/dealers" className="hover:text-primary">Dealers</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><span className="font-semibold num">{d.code}</span><StatusBadge status={d.status} />{d.statusReason && <span className="text-ink-2">— {d.statusReason}</span>}</span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/sales/dealers/${id}/edit`)}>Edit details</Button>}
          {a.includes('submit') && <Button loading={submit.isPending} disabled={!d.readiness?.ready} onClick={() => submit.mutate()}>Submit for approval</Button>}
          {a.includes('suspend') && <Button variant="danger" onClick={() => setDialog('suspend')}>Suspend</Button>}
          {a.includes('reactivate') && <Button onClick={() => setDialog('reactivate')}>Reactivate</Button>}
        </>} />
      <ErrorBanner error={submit.error} />
      {d.status === 'Submitted' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">In approval. Document verifiers verify each licence; then commercial, finance and final approval follow.</div>}

      <div className="grid gap-6 2xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card title="Business & tax identity">
            <KeyValues items={[['Legal name', d.legalName], ['Trade name', d.tradeName], ['Constitution', CONSTITUTION_LABEL[d.constitution]], ['Contact person', d.contactPerson],
              ['Mobile', d.mobile], ['Email', d.email], ['PAN', d.pan], ['Dealer category', d.dealerCategory], ['Activated', fmtDateTime(d.activatedAt)]]} />
            <div className="mt-5">{d.gstRegistered ? <GstinRow d={d} canUpload={d.canAddLicence} /> : <p className="text-ink-2">Not registered under GST.</p>}</div>
          </Card>
          <Card title="Commercial terms">
            <KeyValues items={[['Territory', d.territory], ['Sales owner', d.salesOwner], ['Credit limit', fmtINR(d.creditLimit)], ['Credit days', `${d.creditDays} days`],
              ['Price group', d.priceGroup], ['Annual target', d.annualTarget ? `${fmtINR(d.annualTarget)}${d.targetFy ? ` (FY ${d.targetFy})` : ''}` : '—'],
              ['Buys', d.licenceTypes.map((t) => LICENCE_LABEL[t]).join(', ') || 'Products needing no licence']]} />
          </Card>

          <Card title="Addresses" actions={d.canEditDetails && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setDialog('address')}>Add address</Button>}>
            {d.addresses.length === 0 ? <p className="text-ink-2">No addresses yet. Registered, billing and at least one shipping address are needed.</p> : (
              <ul className="grid gap-3 md:grid-cols-2">{d.addresses.map((x) => (
                <li key={x.id} className="rounded-md border border-line p-4">
                  <p className="flex items-center justify-between"><span className="text-[12px] font-semibold uppercase tracking-wide text-primary-hover">{x.kind}{x.label ? ` · ${x.label}` : ''}</span>
                    {d.canEditDetails && <button className="text-[13px] font-semibold text-ink-2 hover:text-danger-text" onClick={() => remove(`/dealers/${id}/addresses/${x.id}/remove`)}>Remove</button>}</p>
                  <p className="mt-1">{x.line1}{x.line2 ? `, ${x.line2}` : ''}</p>
                  <p className="text-ink-2">{x.city}, {x.district}, {INDIAN_STATES[x.stateCode]} {x.pincode}</p>
                </li>))}</ul>
            )}
          </Card>

          <Card title="Statutory licences" actions={d.canAddLicence && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setDialog('licence')}>{d.status === 'Active' ? 'Renew / add licence' : 'Add licence'}</Button>}>
            {d.licences.length === 0 ? <p className="text-ink-2">{d.licenceTypes.length ? 'Add the licences listed under "Buys" with their certificates.' : 'No licence needed for the products selected.'}</p> : (
              <ul className="divide-y divide-line">{d.licences.map((l) => {
                const expired = l.validTo.slice(0, 10) < today();
                return (
                  <li key={l.id} className={clsx('flex flex-wrap items-center gap-3 py-3', l.status === 'Superseded' && 'opacity-55')}>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{LICENCE_LABEL[l.licenceType]} — <span className="num">{l.number}</span></span>
                      <span className="block text-[13px] text-ink-2">{l.issuer} · {fmtDate(l.validFrom)} to <span className={clsx(expired && 'font-semibold text-danger-text')}>{fmtDate(l.validTo)}</span>
                        {l.verifiedBy ? ` · ${l.verification} by ${l.verifiedBy}` : ''}{l.remarks ? ` · ${l.remarks}` : ''}</span>
                    </span>
                    {l.status === 'Superseded' ? <StatusBadge status="Inactive" label="Superseded" /> : expired ? <StatusBadge status="Rejected" label="Expired" />
                      : <StatusBadge status={l.verification === 'Verified' ? 'Active' : l.verification === 'Rejected' ? 'Rejected' : 'Pending'} label={l.verification} />}
                    {d.canVerify && l.status === 'Active' && l.verification === 'Pending' && <>
                      <Button size="sm" icon={<SealCheck size={16} />} onClick={() => setVerify({ id: l.id, label: l.number, verification: 'Verified' })}>Verify</Button>
                      <Button size="sm" variant="danger" onClick={() => setVerify({ id: l.id, label: l.number, verification: 'Rejected' })}>Reject</Button>
                    </>}
                  </li>
                );
              })}</ul>
            )}
          </Card>

          <Card title="Proprietor / partners / directors" actions={d.canEditDetails && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setDialog('signatory')}>Add person</Button>}>
            {d.signatories.length === 0 ? <p className="text-ink-2">Add the authorised signatories with identity proof.</p> : (
              <ul className="divide-y divide-line">{d.signatories.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-3"><span className="flex-1"><span className="font-medium">{s.fullName}</span><span className="ml-2 text-ink-2">{s.designation} · {s.idType} ending {s.idLast4}</span></span>
                  {d.canEditDetails && <button className="text-[13px] font-semibold text-ink-2 hover:text-danger-text" onClick={() => remove(`/dealers/${id}/signatories/${s.id}/remove`)}>Remove</button>}</li>))}</ul>
            )}
          </Card>

          <DocumentsPanel entityType="mdm.party" entityId={d.id} onChanged={() => qc.invalidateQueries({ queryKey: ['dealer', id] })} />
        </div>

        <div className="space-y-6">
          {d.readiness && (
            <Card title="Onboarding checklist">
              <p className="mb-3 text-[13px] text-ink-2">KYC rules: {d.readiness.policy === 'BRD_STRICT' ? 'BRD strict (3 cheques, 5 directors for all)' : 'conditional (D07)'}.</p>
              <ul className="space-y-2.5">{d.readiness.checks.map((c) => (
                <li key={c.key} className="flex gap-2.5">
                  {c.ok ? <CheckCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-success-text" aria-label="Done" /> : <XCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-danger-text" aria-label="Missing" />}
                  <span><span className={clsx(c.ok ? 'text-ink' : 'font-medium')}>{c.label}</span>{c.detail && <span className="block text-[13px] text-ink-2">{c.detail}</span>}</span>
                </li>))}</ul>
              <p className={clsx('mt-4 rounded-md px-3 py-2 text-[14px] font-medium', d.readiness.ready ? 'bg-success-bg text-success-text' : 'bg-warning-bg text-warning-text')}>
                {d.readiness.ready ? 'Ready to submit.' : `${d.readiness.checks.filter((c) => !c.ok).length} item(s) to complete.`}</p>
            </Card>
          )}
          <Card title="Approval history">
            {d.approvals.length === 0 ? <p className="text-ink-2">Not yet submitted.</p> : (
              <ul className="divide-y divide-line">{d.approvals.map((x) => (
                <li key={x.id} className="py-3"><Link to={`/approvals/${x.id}`} className="font-semibold text-primary">{x.doc_no}</Link>
                  <span className="mt-1 flex items-center justify-between text-[13px] text-ink-2">{fmtDateTime(x.submitted_at)}<StatusBadge status={x.status} /></span></li>))}</ul>
            )}
          </Card>
        </div>
      </div>

      {dialog === 'address' && <AddressDialog dealerId={d.id} onDone={close} onClose={() => setDialog(null)} />}
      {dialog === 'licence' && <LicenceDialog dealer={d} onDone={close} onClose={() => setDialog(null)} />}
      {dialog === 'signatory' && <SignatoryDialog dealerId={d.id} onDone={close} onClose={() => setDialog(null)} />}
      <ReasonDialog open={dialog === 'suspend' || dialog === 'reactivate'} danger={dialog === 'suspend'} title={dialog === 'suspend' ? 'Suspend dealer' : 'Reactivate dealer'} confirmLabel={dialog === 'suspend' ? 'Suspend' : 'Reactivate'}
        description={dialog === 'suspend' ? 'No new quotations or orders can be raised while suspended.' : 'The dealer can trade again.'} onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`/dealers/${id}/${dialog}`, { body: { reason } }); toast('success', 'Done.'); await qc.invalidateQueries(); }} />
      <ReasonDialog open={verify?.verification === 'Rejected'} danger title={`Reject licence ${verify?.label ?? ''}`} confirmLabel="Reject" onClose={() => setVerify(null)}
        description="Then return the application so the sales team can replace it."
        onConfirm={async (remarks) => { await api(`/dealers/${id}/licences/${verify!.id}/verify`, { body: { verification: 'Rejected', remarks } }); toast('success', 'Licence rejected.'); await qc.invalidateQueries(); }} />
      <Modal open={verify?.verification === 'Verified'} onClose={() => setVerify(null)} title={`Verify licence ${verify?.label ?? ''}`} width={460}
        description="Confirm you have checked the certificate against the number, issuer and validity dates."
        footer={<><Button variant="secondary" onClick={() => setVerify(null)}>Cancel</Button><Button onClick={async () => {
          try { await api(`/dealers/${id}/licences/${verify!.id}/verify`, { body: { verification: 'Verified' } }); toast('success', 'Licence verified.'); setVerify(null); await qc.invalidateQueries(); }
          catch (e) { toast('error', (e as Error).message); }
        }}>Verify</Button></>}><span /></Modal>
    </>
  );
}

function AddressDialog({ dealerId, onDone, onClose }: { dealerId: string; onDone: () => void; onClose: () => void }) {
  const f = useForm<z.input<typeof addressSchema>>({ resolver: zodResolver(z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? null : v])), addressSchema)), defaultValues: { kind: 'REGISTERED', stateCode: '27' } });
  const m = useMutation({ mutationFn: (v: object) => api(`/dealers/${dealerId}/addresses`, { body: v }), onSuccess: onDone });
  const err = (k: string) => (f.formState.errors as Record<string, { message?: string }>)[k]?.message;
  return (
    <Modal open onClose={onClose} title="Add address" width={640} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={f.handleSubmit((v) => m.mutate(v))}>Add</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="akind" required><Select id="akind" {...f.register('kind')}><option value="REGISTERED">Registered (replaces current)</option><option value="BILLING">Billing (replaces current)</option><option value="SHIPPING">Shipping (add another)</option></Select></Field>
        <Field label="Label (optional)" htmlFor="alabel" hint="e.g. Main godown"><Input id="alabel" {...f.register('label')} /></Field>
        <div className="sm:col-span-2"><Field label="Address line 1" htmlFor="al1" required error={err('line1')}><Input id="al1" {...f.register('line1')} /></Field></div>
        <div className="sm:col-span-2"><Field label="Address line 2" htmlFor="al2"><Input id="al2" {...f.register('line2')} /></Field></div>
        <Field label="City / village" htmlFor="acity" required error={err('city')}><Input id="acity" {...f.register('city')} /></Field>
        <Field label="District" htmlFor="adist" required error={err('district')}><Input id="adist" {...f.register('district')} /></Field>
        <Field label="State" htmlFor="astate" required><Select id="astate" {...f.register('stateCode')}>{Object.entries(INDIAN_STATES).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</Select></Field>
        <Field label="PIN code" htmlFor="apin" required error={err('pincode')}><Input id="apin" inputMode="numeric" maxLength={6} {...f.register('pincode')} /></Field>
      </div>
    </Modal>
  );
}

function LicenceDialog({ dealer, onDone, onClose }: { dealer: Dealer; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState({ licenceType: dealer.licenceTypes[0] ?? 'FERTILIZER', number: '', issuer: '', validFrom: '', validTo: '' });
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const doc = await uploadFile<{ id: string }>('/documents', file!, { documentType: LICENCE_DOC[v.licenceType], entityType: 'mdm.party', entityId: dealer.id, title: `${v.licenceType.toLowerCase()} licence ${v.number}`, validUntil: v.validTo });
      return api(`/dealers/${dealer.id}/licences`, { body: { ...v, documentId: doc.id } });
    },
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose} title="Add licence" width={620} description="The certificate is stored in the document vault and checked by a document verifier."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!file || !v.number || !v.issuer || !v.validFrom || !v.validTo} onClick={() => m.mutate()}>Add licence</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Licence type" htmlFor="ltype" required><Select id="ltype" value={v.licenceType} onChange={(e) => setV({ ...v, licenceType: e.target.value })}>{DEALER_LICENCE_TYPES.map((t) => <option key={t} value={t}>{LICENCE_LABEL[t]}</option>)}</Select></Field>
        <Field label="Licence number" htmlFor="lnum" required hint="e.g. FL-MH-12345"><Input id="lnum" className="uppercase" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value.toUpperCase() })} /></Field>
        <div className="sm:col-span-2"><Field label="Issuing authority" htmlFor="liss" required><Input id="liss" value={v.issuer} onChange={(e) => setV({ ...v, issuer: e.target.value })} /></Field></div>
        <Field label="Valid from" htmlFor="lfrom" required><Input id="lfrom" type="date" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} /></Field>
        <Field label="Valid to" htmlFor="lto" required hint="Alerts at 60 and 30 days"><Input id="lto" type="date" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} /></Field>
        <div className="flex items-center gap-3 sm:col-span-2"><FilePick onFile={setFile} label="Certificate (PDF/image)" />{file && <span className="text-[14px]">{file.name}</span>}</div>
      </div>
    </Modal>
  );
}

function SignatoryDialog({ dealerId, onDone, onClose }: { dealerId: string; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState({ fullName: '', designation: 'Proprietor', idType: 'PAN', idLast4: '' });
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const doc = await uploadFile<{ id: string }>('/documents', file!, { documentType: 'SIGNATORY_ID', entityType: 'mdm.party', entityId: dealerId, title: `ID proof — ${v.fullName}` });
      return api(`/dealers/${dealerId}/signatories`, { body: { ...v, documentId: doc.id } });
    },
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose} title="Add proprietor / partner / director" width={600}
      description="Only the last 4 characters of the ID number are stored; the full proof is kept as a restricted document."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!file || !v.fullName || v.idLast4.length !== 4} onClick={() => m.mutate()}>Add</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full legal name" htmlFor="sname" required><Input id="sname" value={v.fullName} onChange={(e) => setV({ ...v, fullName: e.target.value })} /></Field>
        <Field label="Designation" htmlFor="sdes" required><Input id="sdes" value={v.designation} onChange={(e) => setV({ ...v, designation: e.target.value })} /></Field>
        <Field label="ID type" htmlFor="sidt" required><Select id="sidt" value={v.idType} onChange={(e) => setV({ ...v, idType: e.target.value })}>{ID_TYPES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Last 4 characters of the ID" htmlFor="sid4" required hint="Never the full Aadhaar number"><Input id="sid4" maxLength={4} className="uppercase" value={v.idLast4} onChange={(e) => setV({ ...v, idLast4: e.target.value.toUpperCase() })} /></Field>
        <div className="flex items-center gap-3 sm:col-span-2"><FilePick onFile={setFile} label="ID proof (PDF/image)" />{file && <span className="text-[14px]">{file.name}</span>}</div>
      </div>
    </Modal>
  );
}
