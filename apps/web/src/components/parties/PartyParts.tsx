import { zodResolver } from '@hookform/resolvers/zod';
import { addressSchema, ID_TYPES, INDIAN_STATES } from '@dhruv/contracts';
import { CheckCircle, Plus, SealCheck, UploadSimple, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { api, uploadFile } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { ReasonDialog } from '../ReasonDialog';
import { useToast } from '../toast';
import { Button, Card, ErrorBanner, Field, Input, Modal, Select, StatusBadge } from '../ui';

/** Sections shared by every party page (dealers, vendors): identity, addresses, licences, signatories, checklist, approvals. */
export const CONSTITUTION_LABEL: Record<string, string> = { PROPRIETORSHIP: 'Proprietorship', PARTNERSHIP: 'Partnership', LLP: 'LLP', PVT_LTD: 'Private Limited', PUBLIC_LTD: 'Public Limited', FPO: 'Farmer Producer Company (FPO)' };
export const LICENCE_LABEL: Record<string, string> = {
  FERTILIZER: 'Fertilizer (FCO 1985)', PESTICIDE: 'Pesticide (Insecticides Act 1968)', BIOSTIMULANT: 'Bio-stimulant (FCO Sch. VI)',
  CIB_REGISTRATION: 'CIB&RC registration', MANUFACTURING: 'Factory manufacturing licence',
};
export const LICENCE_DOC: Record<string, string> = {
  FERTILIZER: 'FERTILIZER_LICENCE', PESTICIDE: 'PESTICIDE_LICENCE', BIOSTIMULANT: 'BIOSTIMULANT_REGISTRATION', CIB_REGISTRATION: 'CIB_REGISTRATION', MANUFACTURING: 'FACTORY_LICENCE',
};
const today = () => new Date().toISOString().slice(0, 10);

export interface PartyAddress { id: string; kind: string; label: string | null; line1: string | null; line2: string | null; city: string | null; district: string | null; stateCode: string | null; pincode: string | null }
export interface PartyLicence { id: string; licenceType: string; number: string; issuer: string; validFrom: string; validTo: string; verification: string; remarks: string | null; verifiedBy: string | null; verifiedAt: string | null; documentId: string; status: string }
export interface PartySignatory { id: string; fullName: string; designation: string; idType: string; idLast4: string }
export interface Readiness { ready: boolean; policy: string; checks: { key: string; label: string; ok: boolean; detail?: string }[] }
export interface ApprovalRef { id: string; doc_no: string; status: string; submitted_at: string; initiator: string }

export function FilePick({ onFile, label = 'Choose file' }: { onFile: (f: File) => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return <>
    <Button type="button" size="sm" variant="secondary" icon={<UploadSimple size={16} />} onClick={() => ref.current?.click()}>{label}</Button>
    <input ref={ref} type="file" accept="application/pdf,image/png,image/jpeg" className="sr-only" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
  </>;
}

/** BRD p.7–8 "same-line" rule: the GST certificate upload sits on the same row as the GSTIN. */
export function GstinRow({ partyId, gstin, canUpload }: { partyId: string; gstin: string | null; canUpload: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const docs = useQuery({ queryKey: ['documents', 'mdm.party', partyId], queryFn: () => api<{ data: { documentType: string; status: string; title: string }[] }>(`/documents?entityType=mdm.party&entityId=${partyId}`) });
  const has = docs.data?.data.some((x) => x.documentType === 'GST_CERTIFICATE' && x.status === 'Active');
  const up = async (file: File) => {
    try { await uploadFile('/documents', file, { documentType: 'GST_CERTIFICATE', entityType: 'mdm.party', entityId: partyId, title: `GST certificate ${gstin}` }); toast('success', 'GST certificate uploaded.'); await qc.invalidateQueries(); }
    catch (e) { toast('error', (e as Error).message); }
  };
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-canvas px-4 py-3">
      <span className="text-[12px] font-medium uppercase tracking-wide text-ink-2">GSTIN</span>
      <span className="font-semibold num">{gstin}</span>
      <span className="flex-1" />
      {has ? <StatusBadge status="Active" label="Certificate uploaded" /> : <StatusBadge status="Pending" label="Certificate missing" />}
      {canUpload && !has && <FilePick onFile={up} label="Upload certificate" />}
    </div>
  );
}

function useRemove(onChanged: () => void) {
  const toast = useToast();
  return async (path: string) => { try { await api(path, { method: 'POST' }); onChanged(); } catch (e) { toast('error', (e as Error).message); } };
}

export function AddressesCard({ base, addresses, canEdit, onChanged, emptyText }: { base: string; addresses: PartyAddress[]; canEdit: boolean; onChanged: () => void; emptyText: string }) {
  const [open, setOpen] = useState(false);
  const remove = useRemove(onChanged);
  return (
    <Card title="Addresses" actions={canEdit && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add address</Button>}>
      {addresses.length === 0 ? <p className="text-ink-2">{emptyText}</p> : (
        <ul className="grid gap-3 md:grid-cols-2">{addresses.map((x) => (
          <li key={x.id} className="rounded-md border border-line p-4">
            <p className="flex items-center justify-between"><span className="text-[12px] font-semibold uppercase tracking-wide text-primary-hover">{x.kind}{x.label ? ` · ${x.label}` : ''}</span>
              {canEdit && <button className="text-[13px] font-semibold text-ink-2 hover:text-danger-text" onClick={() => remove(`${base}/addresses/${x.id}/remove`)}>Remove</button>}</p>
            <p className="mt-1">{[x.line1, x.line2].filter(Boolean).join(', ') || <span className="text-warning-text">Address line missing</span>}</p>
            <p className="text-ink-2">{[x.city, x.district, x.stateCode ? INDIAN_STATES[x.stateCode] : null].filter(Boolean).join(', ')} {x.pincode ?? ''}
              {(!x.line1 || !x.city || !x.district || !x.stateCode || !x.pincode) && <span className="ml-1 text-warning-text">(incomplete — add the full address and remove this one)</span>}</p>
          </li>))}</ul>
      )}
      {open && <AddressDialog base={base} onDone={() => { setOpen(false); onChanged(); }} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function AddressDialog({ base, onDone, onClose }: { base: string; onDone: () => void; onClose: () => void }) {
  const f = useForm<z.input<typeof addressSchema>>({ resolver: zodResolver(z.preprocess((o) => Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, v === '' ? null : v])), addressSchema)), defaultValues: { kind: 'REGISTERED', stateCode: '27' } });
  const m = useMutation({ mutationFn: (v: object) => api(`${base}/addresses`, { body: v }), onSuccess: onDone });
  const err = (k: string) => (f.formState.errors as Record<string, { message?: string }>)[k]?.message;
  return (
    <Modal open onClose={onClose} title="Add address" width={640} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} onClick={f.handleSubmit((v) => m.mutate(v))}>Add</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="akind" required><Select id="akind" {...f.register('kind')}><option value="REGISTERED">Registered (replaces current)</option><option value="BILLING">Billing (replaces current)</option><option value="SHIPPING">Shipping / dispatch (add another)</option></Select></Field>
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

export function LicencesCard({ base, partyId, licences, types, offered, status, canAdd, canVerify, onChanged }: {
  base: string; partyId: string; licences: PartyLicence[]; types: string[]; offered: readonly string[]; status: string; canAdd: boolean; canVerify: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [verify, setVerify] = useState<{ id: string; label: string; verification: 'Verified' | 'Rejected' } | null>(null);
  return (
    <Card title="Statutory licences" actions={canAdd && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>{status === 'Active' ? 'Renew / add licence' : 'Add licence'}</Button>}>
      {licences.length === 0 ? <p className="text-ink-2">{types.length ? `Needed: ${types.map((t) => LICENCE_LABEL[t]).join(', ')}.` : 'No licence needed.'}</p> : (
        <ul className="divide-y divide-line">{licences.map((l) => {
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
              {canVerify && l.status === 'Active' && l.verification === 'Pending' && <>
                <Button size="sm" icon={<SealCheck size={16} />} onClick={() => setVerify({ id: l.id, label: l.number, verification: 'Verified' })}>Verify</Button>
                <Button size="sm" variant="danger" onClick={() => setVerify({ id: l.id, label: l.number, verification: 'Rejected' })}>Reject</Button>
              </>}
            </li>
          );
        })}</ul>
      )}
      {open && <LicenceDialog base={base} partyId={partyId} offered={offered} initial={types[0] ?? offered[0]!} onDone={() => { setOpen(false); onChanged(); }} onClose={() => setOpen(false)} />}
      <ReasonDialog open={verify?.verification === 'Rejected'} danger title={`Reject licence ${verify?.label ?? ''}`} confirmLabel="Reject" onClose={() => setVerify(null)}
        description="Then return the application so it can be replaced."
        onConfirm={async (remarks) => { await api(`${base}/licences/${verify!.id}/verify`, { body: { verification: 'Rejected', remarks } }); toast('success', 'Licence rejected.'); onChanged(); }} />
      <Modal open={verify?.verification === 'Verified'} onClose={() => setVerify(null)} title={`Verify licence ${verify?.label ?? ''}`} width={460}
        description="Confirm you have checked the certificate against the number, issuer and validity dates."
        footer={<><Button variant="secondary" onClick={() => setVerify(null)}>Cancel</Button><Button onClick={async () => {
          try { await api(`${base}/licences/${verify!.id}/verify`, { body: { verification: 'Verified' } }); toast('success', 'Licence verified.'); setVerify(null); onChanged(); }
          catch (e) { toast('error', (e as Error).message); }
        }}>Verify</Button></>}><span /></Modal>
    </Card>
  );
}

function LicenceDialog({ base, partyId, offered, initial, onDone, onClose }: { base: string; partyId: string; offered: readonly string[]; initial: string; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState({ licenceType: initial, number: '', issuer: '', validFrom: '', validTo: '' });
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const doc = await uploadFile<{ id: string }>('/documents', file!, { documentType: LICENCE_DOC[v.licenceType], entityType: 'mdm.party', entityId: partyId, title: `${LICENCE_LABEL[v.licenceType]} ${v.number}`, validUntil: v.validTo });
      return api(`${base}/licences`, { body: { ...v, documentId: doc.id } });
    },
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose} title="Add licence" width={620} description="The certificate is stored in the document vault and checked by a document verifier."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={m.isPending} disabled={!file || !v.number || !v.issuer || !v.validFrom || !v.validTo} onClick={() => m.mutate()}>Add licence</Button></>}>
      <ErrorBanner error={m.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Licence type" htmlFor="ltype" required><Select id="ltype" value={v.licenceType} onChange={(e) => setV({ ...v, licenceType: e.target.value })}>{offered.map((t) => <option key={t} value={t}>{LICENCE_LABEL[t]}</option>)}</Select></Field>
        <Field label="Licence number" htmlFor="lnum" required hint="e.g. FL-MH-12345"><Input id="lnum" className="uppercase" value={v.number} onChange={(e) => setV({ ...v, number: e.target.value.toUpperCase() })} /></Field>
        <div className="sm:col-span-2"><Field label="Issuing authority" htmlFor="liss" required><Input id="liss" value={v.issuer} onChange={(e) => setV({ ...v, issuer: e.target.value })} /></Field></div>
        <Field label="Valid from" htmlFor="lfrom" required><Input id="lfrom" type="date" value={v.validFrom} onChange={(e) => setV({ ...v, validFrom: e.target.value })} /></Field>
        <Field label="Valid to" htmlFor="lto" required hint="Alerts at 60 and 30 days"><Input id="lto" type="date" value={v.validTo} onChange={(e) => setV({ ...v, validTo: e.target.value })} /></Field>
        <div className="flex items-center gap-3 sm:col-span-2"><FilePick onFile={setFile} label="Certificate (PDF/image)" />{file && <span className="text-[14px]">{file.name}</span>}</div>
      </div>
    </Modal>
  );
}

export function SignatoriesCard({ base, partyId, signatories, canEdit, onChanged }: { base: string; partyId: string; signatories: PartySignatory[]; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const remove = useRemove(onChanged);
  return (
    <Card title="Proprietor / partners / directors" actions={canEdit && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => setOpen(true)}>Add person</Button>}>
      {signatories.length === 0 ? <p className="text-ink-2">Add the authorised signatories with identity proof.</p> : (
        <ul className="divide-y divide-line">{signatories.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-3"><span className="flex-1"><span className="font-medium">{s.fullName}</span><span className="ml-2 text-ink-2">{s.designation} · {s.idType} ending {s.idLast4}</span></span>
            {canEdit && <button className="text-[13px] font-semibold text-ink-2 hover:text-danger-text" onClick={() => remove(`${base}/signatories/${s.id}/remove`)}>Remove</button>}</li>))}</ul>
      )}
      {open && <SignatoryDialog base={base} partyId={partyId} onDone={() => { setOpen(false); onChanged(); }} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function SignatoryDialog({ base, partyId, onDone, onClose }: { base: string; partyId: string; onDone: () => void; onClose: () => void }) {
  const [v, setV] = useState({ fullName: '', designation: 'Proprietor', idType: 'PAN', idLast4: '' });
  const [file, setFile] = useState<File | null>(null);
  const m = useMutation({
    mutationFn: async () => {
      const doc = await uploadFile<{ id: string }>('/documents', file!, { documentType: 'SIGNATORY_ID', entityType: 'mdm.party', entityId: partyId, title: `ID proof — ${v.fullName}` });
      return api(`${base}/signatories`, { body: { ...v, documentId: doc.id } });
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

export function ChecklistCard({ readiness }: { readiness: Readiness }) {
  return (
    <Card title="Onboarding checklist">
      <p className="mb-3 text-[13px] text-ink-2">KYC rules: {readiness.policy === 'BRD_STRICT' ? 'BRD strict (3 cheques, 5 directors for all)' : 'conditional (D07)'}.</p>
      <ul className="space-y-2.5">{readiness.checks.map((c) => (
        <li key={c.key} className="flex gap-2.5">
          {c.ok ? <CheckCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-success-text" aria-label="Done" /> : <XCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-danger-text" aria-label="Missing" />}
          <span><span className={clsx(c.ok ? 'text-ink' : 'font-medium')}>{c.label}</span>{c.detail && <span className="block text-[13px] text-ink-2">{c.detail}</span>}</span>
        </li>))}</ul>
      <p className={clsx('mt-4 rounded-md px-3 py-2 text-[14px] font-medium', readiness.ready ? 'bg-success-bg text-success-text' : 'bg-warning-bg text-warning-text')}>
        {readiness.ready ? 'Ready to submit.' : `${readiness.checks.filter((c) => !c.ok).length} item(s) to complete.`}</p>
    </Card>
  );
}

export function ApprovalHistoryCard({ approvals }: { approvals: ApprovalRef[] }) {
  return (
    <Card title="Approval history">
      {approvals.length === 0 ? <p className="text-ink-2">Not yet submitted.</p> : (
        <ul className="divide-y divide-line">{approvals.map((x) => (
          <li key={x.id} className="py-3"><Link to={`/approvals/${x.id}`} className="font-semibold text-primary">{x.doc_no}</Link>
            <span className="mt-1 flex items-center justify-between text-[13px] text-ink-2">{fmtDateTime(x.submitted_at)}<StatusBadge status={x.status} /></span></li>))}</ul>
      )}
    </Card>
  );
}
