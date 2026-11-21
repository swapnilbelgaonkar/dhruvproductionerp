import { zodResolver } from '@hookform/resolvers/zod';
import { CONSTITUTIONS, DEALER_CATEGORIES, DEALER_LICENCE_TYPES, dealerSchema } from '@dhruv/contracts';
import { Plus, Warning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable } from '../../components/DataTable';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { AddressesCard, ApprovalHistoryCard, ChecklistCard, CONSTITUTION_LABEL, GstinRow, LicencesCard, LICENCE_LABEL, SignatoriesCard,
  type ApprovalRef, type PartyAddress, type PartyLicence, type PartySignatory, type Readiness } from '../../components/parties/PartyParts';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api, ApiError, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtINR } from '../../lib/format';


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
  addresses: PartyAddress[]; licences: PartyLicence[]; signatories: PartySignatory[]; approvals: ApprovalRef[]; readiness: Readiness | null;
  allowedActions: string[]; canEditDetails: boolean; canAddLicence: boolean; canVerify: boolean;
}

export function DealerDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['dealer', id], queryFn: () => api<Dealer>(`/dealers/${id}`) });
  const [dialog, setDialog] = useState<null | 'suspend' | 'reactivate'>(null);
  const submit = useMutation({ mutationFn: () => api<{ approvalDocNo: string }>(`/dealers/${id}/submit`, { method: 'POST' }),
    onSuccess: async (r) => { toast('success', `Submitted for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['dealer', id] }); void qc.invalidateQueries({ queryKey: ['documents', 'mdm.party', id] }); };

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
            <div className="mt-5">{d.gstRegistered ? <GstinRow partyId={d.id} gstin={d.gstin} canUpload={d.canAddLicence} /> : <p className="text-ink-2">Not registered under GST.</p>}</div>
          </Card>
          <Card title="Commercial terms">
            <KeyValues items={[['Territory', d.territory], ['Sales owner', d.salesOwner], ['Credit limit', fmtINR(d.creditLimit)], ['Credit days', `${d.creditDays} days`],
              ['Price group', d.priceGroup], ['Annual target', d.annualTarget ? `${fmtINR(d.annualTarget)}${d.targetFy ? ` (FY ${d.targetFy})` : ''}` : '—'],
              ['Buys', d.licenceTypes.map((t) => LICENCE_LABEL[t]).join(', ') || 'Products needing no licence']]} />
          </Card>

          <AddressesCard base={`/dealers/${id}`} addresses={d.addresses} canEdit={d.canEditDetails} onChanged={refresh}
            emptyText="No addresses yet. Registered, billing and at least one shipping address are needed." />
          <LicencesCard base={`/dealers/${id}`} partyId={d.id} licences={d.licences} types={d.licenceTypes} offered={DEALER_LICENCE_TYPES} status={d.status}
            canAdd={d.canAddLicence} canVerify={d.canVerify} onChanged={refresh} />
          <SignatoriesCard base={`/dealers/${id}`} partyId={d.id} signatories={d.signatories} canEdit={d.canEditDetails} onChanged={refresh} />

          <DocumentsPanel entityType="mdm.party" entityId={d.id} onChanged={() => qc.invalidateQueries({ queryKey: ['dealer', id] })} />
          {d.status === 'Active' && <DealerBusiness partyId={d.id} />}
        </div>

        <div className="space-y-6">
          {d.readiness && <ChecklistCard readiness={d.readiness} />}
          <ApprovalHistoryCard approvals={d.approvals} />
        </div>
      </div>

      <ReasonDialog open={dialog === 'suspend' || dialog === 'reactivate'} danger={dialog === 'suspend'} title={dialog === 'suspend' ? 'Suspend dealer' : 'Reactivate dealer'} confirmLabel={dialog === 'suspend' ? 'Suspend' : 'Reactivate'}
        description={dialog === 'suspend' ? 'No new quotations or orders can be raised while suspended.' : 'The dealer can trade again.'} onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`/dealers/${id}/${dialog}`, { body: { reason } }); toast('success', 'Done.'); await qc.invalidateQueries(); }} />
    </>
  );
}

type Doc = { id: string; docNo: string; revision?: number; status: string; grandTotal: string; quoteDate?: string; orderDate?: string };

/** Recent quotations and orders of an active dealer, with shortcuts to create new ones. */
function DealerBusiness({ partyId }: { partyId: string }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const seeQ = can('sales.quotation:view');
  const seeO = can('sales.order:view');
  const quotes = useQuery({ queryKey: ['quotations', 'dealer', partyId], enabled: seeQ, queryFn: () => api<Page<Doc>>(`/quotations?partyId=${partyId}&limit=5`) });
  const orders = useQuery({ queryKey: ['sales-orders', 'dealer', partyId], enabled: seeO, queryFn: () => api<Page<Doc>>(`/sales-orders?partyId=${partyId}&limit=5`) });
  if (!seeQ && !seeO) return null;
  const list = (rows: Doc[] | undefined, base: string, empty: string) => (!rows?.length ? <p className="text-ink-2">{empty}</p> : (
    <ul className="divide-y divide-line">{rows.map((x) => (
      <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[14px]">
        <Link className="font-semibold text-primary num" to={`${base}/${x.id}`}>{x.docNo}{x.revision ? ` R${x.revision}` : ''}</Link>
        <span className="text-ink-2 num">{fmtDate(x.orderDate ?? x.quoteDate)}</span><span className="num">{fmtINR(x.grandTotal)}</span><StatusBadge status={x.status} />
      </li>))}</ul>
  ));
  return (
    <Card title="Quotations and orders" actions={<div className="flex gap-2">
      {can('sales.quotation:create') && <Button size="sm" variant="secondary" onClick={() => nav(`/sales/quotations/new?partyId=${partyId}`)}>New quotation</Button>}
      {can('sales.order:create') && <Button size="sm" variant="secondary" onClick={() => nav(`/sales/orders/new?partyId=${partyId}`)}>New order</Button>}
    </div>}>
      <div className="grid gap-6 md:grid-cols-2">
        {seeQ && <div><h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-2">Recent quotations ({quotes.data?.total ?? 0})</h3>{list(quotes.data?.data, '/sales/quotations', 'No quotations yet.')}</div>}
        {seeO && <div><h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-2">Recent orders ({orders.data?.total ?? 0})</h3>{list(orders.data?.data, '/sales/orders', 'No orders yet.')}</div>}
      </div>
    </Card>
  );
}
