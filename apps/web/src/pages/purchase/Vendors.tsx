import { zodResolver } from '@hookform/resolvers/zod';
import { CONSTITUTIONS, VENDOR_CATEGORIES, VENDOR_LICENCE_TYPES, vendorSchema } from '@dhruv/contracts';
import { Bank, Plus, SealCheck, Trash, Warning } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { DataTable } from '../../components/DataTable';
import { DocumentsPanel } from '../../components/DocumentsPanel';
import { AddressesCard, ApprovalHistoryCard, ChecklistCard, CONSTITUTION_LABEL, FilePick, GstinRow, LicencesCard, LICENCE_LABEL, SignatoriesCard,
  type ApprovalRef, type PartyAddress, type PartyLicence, type PartySignatory, type Readiness } from '../../components/parties/PartyParts';
import { ReasonDialog } from '../../components/ReasonDialog';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, Input, KeyValues, Modal, PageHeader, Select, Skeleton, StatusBadge } from '../../components/ui';
import { api, ApiError, uploadFile, type Page } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtNum } from '../../lib/format';

export const CATEGORY_LABEL: Record<string, string> = { RAW_MATERIAL: 'Raw material', PACKAGING: 'Packaging', LAB_CONSUMABLE: 'Lab consumables', SERVICES: 'Services', CAPITAL: 'Capital goods', OTHER: 'Other' };

interface VendorRow { id: string; code: string; legalName: string; gstin: string | null; vendorCategory: string; status: string; paymentTermsDays: number; msmeRegistered: boolean; itemCount: number; bankVerification: string | null; nextLicenceExpiry: string | null }

export function VendorsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const create = can('mdm.vendor:create') ? <Button icon={<Plus size={18} weight="bold" />} onClick={() => nav('/purchase/vendors/new')}>Register vendor</Button> : undefined;
  return (
    <>
      <PageHeader title="Vendors" subtitle="Suppliers of raw materials, packaging and services — active only after document, purchase-head and finance (bank) approval (BRD §3.2)." actions={create} />
      <DataTable<VendorRow> queryKey="vendors" path="/vendors" rowHref={(r) => `/purchase/vendors/${r.id}`} searchPlaceholder="Search code, name, GSTIN or mobile"
        statusOptions={['Draft', 'Submitted', 'Active', 'Rejected', 'Suspended']}
        empty={{ title: 'No vendors yet', text: 'Register a vendor, complete the checklist (KYC, bank account, items supplied) and submit it for approval.', action: create }}
        columns={[
          { key: 'code', header: 'Code', render: (r) => <span className="font-semibold num">{r.code}</span> },
          { key: 'name', header: 'Vendor', render: (r) => <span><span className="block font-medium">{r.legalName}</span><span className="text-[13px] text-ink-2">{r.gstin ?? 'Not GST registered'}{r.msmeRegistered ? ' · MSME' : ''}</span></span> },
          { key: 'cat', header: 'Category', render: (r) => CATEGORY_LABEL[r.vendorCategory] },
          { key: 'items', header: 'Items', render: (r) => <span className="num">{r.itemCount}</span> },
          { key: 'terms', header: 'Payment terms', render: (r) => `${r.paymentTermsDays} days` },
          { key: 'bank', header: 'Bank', render: (r) => (r.bankVerification ? <StatusBadge status={r.bankVerification === 'Verified' ? 'Active' : r.bankVerification === 'Rejected' ? 'Rejected' : 'Pending'} label={r.bankVerification} /> : '—') },
          { key: 'lic', header: 'Licence expiry', render: (r) => {
            if (!r.nextLicenceExpiry) return '—';
            const days = Math.ceil((new Date(r.nextLicenceExpiry).getTime() - Date.now()) / 86_400_000);
            return <span className={clsx(days < 0 ? 'font-semibold text-danger-text' : days <= 60 && 'font-semibold text-warning-text')}>{fmtDate(r.nextLicenceExpiry)}</span>;
          } },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />
    </>
  );
}

// ---------------------------------------------------------------- registration / edit form
type VendorForm = z.input<typeof vendorSchema>;

export function VendorFormPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({ queryKey: ['vendor', id], queryFn: () => api<VendorForm & { version: number }>(`/vendors/${id}`), enabled: !!id });
  const [error, setError] = useState<unknown>(null);
  const [dupWarn, setDupWarn] = useState<string | null>(null);
  const f = useForm<VendorForm>({
    resolver: zodResolver(z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? null : v])), vendorSchema)),
    defaultValues: { gstRegistered: true, licenceTypes: [], msmeRegistered: false, paymentTermsDays: 30, vendorCategory: 'RAW_MATERIAL', constitution: 'PROPRIETORSHIP' },
    values: existing.data ? { ...existing.data, gstin: existing.data.gstin ?? '', email: existing.data.email ?? '', tradeName: existing.data.tradeName ?? '', udyamNumber: existing.data.udyamNumber ?? '',
      constitution: existing.data.constitution ?? '', pan: existing.data.pan ?? '', contactPerson: existing.data.contactPerson ?? '', mobile: existing.data.mobile ?? '', phoneNumbers: existing.data.phoneNumbers ?? '' } as VendorForm : undefined,
  });
  if (id && existing.isLoading) return <Skeleton className="h-96" />;
  const gstRegistered = f.watch('gstRegistered');
  const msme = f.watch('msmeRegistered');
  const err = (k: string) => (f.formState.errors as Record<string, { message?: string }>)[k]?.message;
  const checkDup = async () => {
    const v = f.getValues();
    if (!v.pan && !v.gstin && !v.mobile) return;
    const r = await api<{ data: { code: string; legalName: string; matches: string[]; role: string }[] }>(`/vendors/duplicates?gstin=${v.gstin ?? ''}&pan=${v.pan ?? ''}&mobile=${v.mobile ?? ''}${id ? `&excludeId=${id}` : ''}`).catch(() => null);
    setDupWarn(r?.data.length ? r.data.map((d) => `${d.code} ${d.legalName} (${d.role}, same ${d.matches.join(', ')})`).join('; ') : null);
  };
  const save = f.handleSubmit(async (v) => {
    setError(null);
    try {
      if (id) { await api(`/vendors/${id}`, { method: 'PUT', body: { ...v, version: existing.data!.version } }); await qc.invalidateQueries(); toast('success', 'Saved.'); nav(`/purchase/vendors/${id}`); }
      else { const r = await api<{ id: string; code: string }>('/vendors', { body: v }); toast('success', `Vendor ${r.code} saved as Draft. Complete the checklist next.`); nav(`/purchase/vendors/${r.id}`); }
    } catch (e) { if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k as 'pan', { message: m })); setError(e); }
  });
  return (
    <>
      <PageHeader title={id ? 'Edit vendor' : 'Register vendor'} crumbs={<Link to="/purchase/vendors" className="hover:text-primary">Vendors</Link>}
        subtitle="Step 1 of 2 — business and tax details. Address, bank account, licences, items supplied and documents come next on the vendor page." />
      <form noValidate onSubmit={save} className="max-w-5xl space-y-6">
        <ErrorBanner error={error} />
        {dupWarn && <div role="alert" className="flex items-start gap-2 rounded-md bg-warning-bg px-4 py-3 text-warning-text"><Warning size={20} className="shrink-0" />Possible duplicate: {dupWarn}</div>}
        <Card title="1. Business profile">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Legal business name" htmlFor="legalName" required error={err('legalName')} hint="As per GST and PAN"><Input id="legalName" {...f.register('legalName')} /></Field>
            <Field label="Trade name" htmlFor="tradeName" error={err('tradeName')}><Input id="tradeName" {...f.register('tradeName')} /></Field>
            <Field label="Constitution" htmlFor="constitution" hint="Needed before submission"><Select id="constitution" {...f.register('constitution')}><option value="">Not yet known</option>{CONSTITUTIONS.map((c) => <option key={c} value={c}>{CONSTITUTION_LABEL[c]}</option>)}</Select></Field>
            <Field label="Vendor category" htmlFor="vendorCategory" required><Select id="vendorCategory" {...f.register('vendorCategory')}>{VENDOR_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</Select></Field>
            <Field label="Contact person" htmlFor="contactPerson" error={err('contactPerson')} hint="Needed before submission"><Input id="contactPerson" {...f.register('contactPerson')} /></Field>
            <Field label="Mobile" htmlFor="mobile" error={err('mobile')} hint="Needed before submission"><Input id="mobile" inputMode="numeric" maxLength={10} {...f.register('mobile', { onBlur: checkDup })} /></Field>
            <Field label="Other phone numbers" htmlFor="phoneNumbers" error={err('phoneNumbers')} hint="Landlines or more mobiles, as written"><Input id="phoneNumbers" {...f.register('phoneNumbers')} /></Field>
            <Field label="Email" htmlFor="email" error={err('email')} hint="Purchase orders are sent here"><Input id="email" type="email" {...f.register('email')} /></Field>
          </div>
        </Card>
        <Card title="2. Tax identity">
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="PAN" htmlFor="pan" error={err('pan')} hint="Needed before submission"><Input id="pan" className="uppercase num" maxLength={10} {...f.register('pan', { setValueAs: (v: string) => v?.toUpperCase(), onBlur: checkDup })} /></Field>
            <label className="flex items-center gap-3 self-end py-3"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" {...f.register('gstRegistered')} />Registered under GST</label>
            {gstRegistered && <Field label="GSTIN" htmlFor="gstin" required error={err('gstin')} hint="Characters 3–12 must equal the PAN. Upload the certificate on the same line on the next step."><Input id="gstin" className="uppercase num" maxLength={15} {...f.register('gstin', { setValueAs: (v: string) => v?.toUpperCase(), onBlur: checkDup })} /></Field>}
            <label className="flex items-center gap-3 self-end py-3"><input type="checkbox" className="h-5 w-5 accent-[#5B38F5]" {...f.register('msmeRegistered')} />MSME (Udyam registered) — payment within 45 days by law</label>
            {msme && <Field label="Udyam registration number" htmlFor="udyamNumber" required error={err('udyamNumber')}><Input id="udyamNumber" className="uppercase num" placeholder="UDYAM-MH-00-0000000" {...f.register('udyamNumber', { setValueAs: (v: string) => v?.toUpperCase() })} /></Field>}
          </div>
        </Card>
        <Card title="3. Licences and terms">
          <div className="grid gap-5 md:grid-cols-2">
            <fieldset className="md:col-span-2"><legend className="label">Licences this vendor must hold (BRD p.8: CIB&RC registration for technicals, factory manufacturing licence)</legend>
              <div className="flex flex-wrap gap-4">{VENDOR_LICENCE_TYPES.map((t) => <label key={t} className="flex items-center gap-2"><input type="checkbox" value={t} className="h-5 w-5 accent-[#5B38F5]" {...f.register('licenceTypes')} />{LICENCE_LABEL[t]}</label>)}</div>
            </fieldset>
            <Field label="Payment terms (days)" htmlFor="paymentTermsDays" required error={err('paymentTermsDays')} hint={msme ? 'MSME: 45 days at most (MSMED Act)' : undefined}>
              <Input id="paymentTermsDays" type="number" min={0} max={180} {...f.register('paymentTermsDays', { setValueAs: (v: string) => (v === '' ? null : Number(v)) })} /></Field>
          </div>
        </Card>
        <div className="flex gap-2"><Button type="submit" loading={f.formState.isSubmitting}>{id ? 'Save' : 'Save & continue'}</Button><Button type="button" variant="secondary" onClick={() => nav(-1)}>Cancel</Button></div>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- detail
interface Bank { id: string; accountHolder: string; bankName: string; branch: string | null; ifsc: string; accountLast4: string; accountNumber: string | null; verification: string; remarks: string | null; verifiedAt: string | null; verifiedBy: string | null }
interface VendorItem { id: string; itemId: string; itemCode: string; itemName: string; itemType: string; uom: string; vendorItemCode: string | null; leadTimeDays: number; minOrderQty: string | null }
interface Vendor {
  id: string; code: string; legalName: string; tradeName: string | null; constitution: string | null; pan: string | null; gstRegistered: boolean; gstin: string | null;
  contactPerson: string | null; mobile: string | null; phoneNumbers: string | null; email: string | null; vendorCategory: string; licenceTypes: string[]; msmeRegistered: boolean; udyamNumber: string | null;
  paymentTermsDays: number; rating: string | null; status: string; statusReason: string | null; activatedAt: string | null; version: number;
  addresses: PartyAddress[]; licences: PartyLicence[]; signatories: PartySignatory[]; approvals: ApprovalRef[]; readiness: Readiness | null;
  bank: Bank | null; items: VendorItem[];
  allowedActions: string[]; canEditDetails: boolean; canAddLicence: boolean; canVerify: boolean; canVerifyBank: boolean;
}

export function VendorDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['vendor', id], queryFn: () => api<Vendor>(`/vendors/${id}`) });
  const [dialog, setDialog] = useState<null | 'suspend' | 'reactivate'>(null);
  const submit = useMutation({ mutationFn: () => api<{ approvalDocNo: string }>(`/vendors/${id}/submit`, { method: 'POST' }),
    onSuccess: async (r) => { toast('success', `Submitted for approval as ${r.approvalDocNo}.`); await qc.invalidateQueries(); } });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const a = d.allowedActions;
  const base = `/vendors/${id}`;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['vendor', id] }); void qc.invalidateQueries({ queryKey: ['documents', 'mdm.party', id] }); };
  return (
    <>
      <PageHeader title={d.legalName} crumbs={<Link to="/purchase/vendors" className="hover:text-primary">Vendors</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><span className="font-semibold num">{d.code}</span><StatusBadge status={d.status} />{d.statusReason && <span className="text-ink-2">— {d.statusReason}</span>}</span>}
        actions={<>
          {a.includes('edit') && <Button variant="secondary" onClick={() => nav(`/purchase/vendors/${id}/edit`)}>Edit details</Button>}
          {a.includes('submit') && <Button loading={submit.isPending} disabled={!d.readiness?.ready} onClick={() => submit.mutate()}>Submit for approval</Button>}
          {a.includes('suspend') && <Button variant="danger" onClick={() => setDialog('suspend')}>Suspend</Button>}
          {a.includes('reactivate') && <Button onClick={() => setDialog('reactivate')}>Reactivate</Button>}
        </>} />
      <ErrorBanner error={submit.error} />
      {d.status === 'Submitted' && <div className="mb-6 rounded-md bg-warning-bg px-4 py-3 text-warning-text">In approval. Document verifiers verify each licence, the purchase head approves, then finance verifies the bank account.</div>}
      <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <Card title="Business & tax identity">
            <KeyValues items={[['Legal name', d.legalName], ['Trade name', d.tradeName], ['Constitution', d.constitution ? CONSTITUTION_LABEL[d.constitution] : null], ['Contact person', d.contactPerson],
              ['Mobile', d.mobile], ['Other phone numbers', d.phoneNumbers], ['Email', d.email], ['PAN', d.pan], ['Category', CATEGORY_LABEL[d.vendorCategory]], ['MSME', d.msmeRegistered ? d.udyamNumber : 'No'],
              ['Payment terms', `${d.paymentTermsDays} days`], ['Licences required', d.licenceTypes.map((t) => LICENCE_LABEL[t]).join(', ') || 'None'],
              ['Rating', d.rating ? `${d.rating} / 5` : 'Rated from receipts and QC once purchasing starts'], ['Activated', fmtDateTime(d.activatedAt)]]} />
            <div className="mt-5">{d.gstRegistered ? <GstinRow partyId={d.id} gstin={d.gstin} canUpload={d.canAddLicence} /> : <p className="text-ink-2">Not registered under GST.</p>}</div>
          </Card>
          <BankCard vendor={d} onChanged={refresh} />
          <ItemsCard vendor={d} onChanged={refresh} />
          <AddressesCard base={base} addresses={d.addresses} canEdit={d.canEditDetails} onChanged={refresh} emptyText="Add the registered address (it must match the GSTIN state)." />
          <LicencesCard base={base} partyId={d.id} licences={d.licences} types={d.licenceTypes} offered={VENDOR_LICENCE_TYPES} status={d.status} canAdd={d.canAddLicence} canVerify={d.canVerify} onChanged={refresh} />
          <SignatoriesCard base={base} partyId={d.id} signatories={d.signatories} canEdit={d.canEditDetails} onChanged={refresh} />
          <DocumentsPanel entityType="mdm.party" entityId={d.id} onChanged={refresh} />
        </div>
        <div className="space-y-6">
          {d.readiness && <ChecklistCard readiness={d.readiness} />}
          <ApprovalHistoryCard approvals={d.approvals} />
        </div>
      </div>
      <ReasonDialog open={!!dialog} danger={dialog === 'suspend'} title={dialog === 'suspend' ? 'Suspend vendor' : 'Reactivate vendor'} confirmLabel={dialog === 'suspend' ? 'Suspend' : 'Reactivate'}
        description={dialog === 'suspend' ? 'No new purchase orders can be raised while suspended.' : 'The vendor can be ordered from again.'} onClose={() => setDialog(null)}
        onConfirm={async (reason) => { await api(`${base}/${dialog}`, { body: { reason } }); toast('success', 'Done.'); await qc.invalidateQueries(); }} />
    </>
  );
}

/** MDM-011: bank account with cancelled cheque; finance verifies it (not the person who entered it). */
function BankCard({ vendor, onChanged }: { vendor: Vendor; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reject, setReject] = useState(false);
  const b = vendor.bank;
  const canSet = vendor.canAddLicence;
  const verify = async () => { try { await api(`/vendors/${vendor.id}/bank-account/verify`, { body: { verification: 'Verified' } }); toast('success', 'Bank account verified.'); onChanged(); } catch (e) { toast('error', (e as Error).message); } };
  return (
    <Card title="Bank account" actions={canSet && <Button size="sm" variant="secondary" icon={<Bank size={16} />} onClick={() => setOpen(true)}>{b ? 'Replace' : 'Add bank account'}</Button>}>
      {!b ? <p className="text-ink-2">Add the account payments go to, with a cancelled cheque or bank letter.</p> : (
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <KeyValues items={[['Account holder', b.accountHolder], ['Bank', `${b.bankName}${b.branch ? `, ${b.branch}` : ''}`], ['IFSC', b.ifsc],
              ['Account number', b.accountNumber ?? `•••• ${b.accountLast4}`], ['Verification', b.verifiedBy ? `${b.verification} by ${b.verifiedBy}, ${fmtDateTime(b.verifiedAt)}${b.remarks ? ` — ${b.remarks}` : ''}` : b.verification]]} />
          </div>
          <StatusBadge status={b.verification === 'Verified' ? 'Active' : b.verification === 'Rejected' ? 'Rejected' : 'Pending'} label={b.verification} />
          {vendor.canVerifyBank && b.verification === 'Pending' && <div className="flex gap-2">
            <Button size="sm" icon={<SealCheck size={16} />} onClick={verify}>Verify</Button>
            <Button size="sm" variant="danger" onClick={() => setReject(true)}>Reject</Button>
          </div>}
        </div>
      )}
      {open && <BankDialog vendorId={vendor.id} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onChanged(); }} />}
      <ReasonDialog open={reject} danger title="Reject bank account" confirmLabel="Reject" onClose={() => setReject(false)} description="Purchase must enter a corrected account."
        onConfirm={async (remarks) => { await api(`/vendors/${vendor.id}/bank-account/verify`, { body: { verification: 'Rejected', remarks } }); toast('success', 'Bank account rejected.'); onChanged(); }} />
    </Card>
  );
}

function BankDialog({ vendorId, onDone, onClose }: { vendorId: string; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState({ accountHolder: '', bankName: '', branch: '', ifsc: '', accountNumber: '' });
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const doc = await uploadFile<{ id: string }>('/documents', file!, { documentType: 'CANCELLED_CHEQUE', entityType: 'mdm.party', entityId: vendorId, title: `Cancelled cheque ${v.bankName} ••${v.accountNumber.slice(-4)}` });
      return api(`/vendors/${vendorId}/bank-account`, { body: { ...v, branch: v.branch || null, documentId: doc.id } });
    },
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose} title="Bank account" width={620} description="Stored encrypted; only finance and verifiers see the full number. A new account must be verified again."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!file || !v.accountHolder || !v.bankName || !v.ifsc || !v.accountNumber} onClick={() => m.mutate()}>Save</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><Field label="Account holder name" htmlFor="b-holder" required hint="Must match the vendor's legal name"><Input id="b-holder" value={v.accountHolder} onChange={(e) => setV({ ...v, accountHolder: e.target.value })} /></Field></div>
        <Field label="Bank" htmlFor="b-bank" required><Input id="b-bank" value={v.bankName} onChange={(e) => setV({ ...v, bankName: e.target.value })} /></Field>
        <Field label="Branch" htmlFor="b-branch"><Input id="b-branch" value={v.branch} onChange={(e) => setV({ ...v, branch: e.target.value })} /></Field>
        <Field label="IFSC" htmlFor="b-ifsc" required><Input id="b-ifsc" className="uppercase num" maxLength={11} value={v.ifsc} onChange={(e) => setV({ ...v, ifsc: e.target.value.toUpperCase() })} /></Field>
        <Field label="Account number" htmlFor="b-no" required><Input id="b-no" inputMode="numeric" className="num" maxLength={18} value={v.accountNumber} onChange={(e) => setV({ ...v, accountNumber: e.target.value.replace(/\D/g, '') })} /></Field>
        <div className="flex items-center gap-3 sm:col-span-2"><FilePick onFile={setFile} label="Cancelled cheque (PDF/image)" />{file && <span className="text-[14px]">{file.name}</span>}</div>
      </div>
    </Modal>
  );
}

function ItemsCard({ vendor, onChanged }: { vendor: Vendor; onChanged: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ itemId: '', vendorItemCode: '', leadTimeDays: '7', minOrderQty: '' });
  const items = useQuery({ queryKey: ['items-active'], enabled: open, queryFn: () => api<Page<{ id: string; code: string; name: string; itemType: string; status: string }>>('/items?status=Active&limit=100') });
  const add = useMutation({
    mutationFn: () => api(`/vendors/${vendor.id}/items`, { body: { itemId: v.itemId, vendorItemCode: v.vendorItemCode || null, leadTimeDays: Number(v.leadTimeDays), minOrderQty: v.minOrderQty ? Number(v.minOrderQty) : null } }),
    onSuccess: () => { toast('success', 'Item added.'); setOpen(false); setV({ itemId: '', vendorItemCode: '', leadTimeDays: '7', minOrderQty: '' }); onChanged(); },
  });
  const remove = async (vid: string) => { try { await api(`/vendors/${vendor.id}/items/${vid}/remove`, { method: 'POST' }); onChanged(); } catch (e) { toast('error', (e as Error).message); } };
  return (
    <Card title="Items supplied" padded={false} actions={vendor.canEditDetails && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => { add.reset(); setOpen(true); }}>Add item</Button>}>
      {vendor.items.length === 0 ? <p className="px-6 pb-6 text-ink-2">Add the items this vendor is approved to supply. Purchase orders can only be placed for these.</p> : (
        <div className="overflow-x-auto"><table className="w-full text-[14px]">
          <thead><tr className="border-b border-line text-left text-[12px] uppercase tracking-wide text-ink-2"><th className="px-6 py-3">Item</th><th className="px-3 py-3">Vendor's code</th><th className="px-3 py-3 text-right">Lead time</th><th className="px-3 py-3 text-right">Minimum order</th>{vendor.canEditDetails && <th className="px-6 py-3" />}</tr></thead>
          <tbody>{vendor.items.map((x) => (
            <tr key={x.id} className="border-b border-line last:border-0">
              <td className="px-6 py-3"><span className="font-semibold">{x.itemCode}</span> <span className="text-ink-2">{x.itemName} · {x.itemType}</span></td>
              <td className="px-3 py-3">{x.vendorItemCode ?? '—'}</td><td className="px-3 py-3 text-right num">{x.leadTimeDays} days</td>
              <td className="px-3 py-3 text-right num">{x.minOrderQty ? `${fmtNum(Number(x.minOrderQty))} ${x.uom}` : '—'}</td>
              {vendor.canEditDetails && <td className="px-6 py-3 text-right"><Button size="sm" variant="ghost" aria-label={`Remove ${x.itemCode}`} onClick={() => remove(x.id)}><Trash size={16} /></Button></td>}
            </tr>))}</tbody>
        </table></div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Add item supplied" width={560}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={add.isPending} disabled={!v.itemId || v.leadTimeDays === ''} onClick={() => add.mutate()}>Add</Button></>}>
        <ErrorBanner error={add.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Item" htmlFor="vi-item" required hint="Approved items only">
            <Select id="vi-item" value={v.itemId} onChange={(e) => setV({ ...v, itemId: e.target.value })}><option value="">Select…</option>
              {(items.data?.data ?? []).filter((i) => i.itemType !== 'FG').map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name} ({i.itemType})</option>)}</Select></Field></div>
          <Field label="Vendor's item code" htmlFor="vi-code"><Input id="vi-code" value={v.vendorItemCode} onChange={(e) => setV({ ...v, vendorItemCode: e.target.value })} /></Field>
          <Field label="Lead time (days)" htmlFor="vi-lead" required><Input id="vi-lead" type="number" min={0} max={365} value={v.leadTimeDays} onChange={(e) => setV({ ...v, leadTimeDays: e.target.value })} /></Field>
          <Field label="Minimum order quantity" htmlFor="vi-moq" hint="In the item's base unit"><Input id="vi-moq" type="number" min={0} step="any" value={v.minOrderQty} onChange={(e) => setV({ ...v, minOrderQty: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}
