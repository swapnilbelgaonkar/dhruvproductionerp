import { DownloadSimple, FilePdf, FileImage, Plus, UploadSimple } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { api, uploadFile } from '../lib/api';
import { fmtDate, fmtDateTime, fmtSize } from '../lib/format';
import { ReasonDialog } from './ReasonDialog';
import { useToast } from './toast';
import { Button, Card, ErrorBanner, Field, Input, Modal, Select, StatusBadge } from './ui';

interface Version { id: string; version: number; note: string; createdAt: string; createdBy: string; fileName: string; mime: string; sizeBytes: number; avStatus: string; validUntil: string | null }
interface Doc { id: string; documentType: string; typeName: string; sensitive: boolean; title: string; currentVersion: number; validUntil: string | null; status: string; versions: Version[] }

function expiryBadge(d: string | null) {
  if (!d) return null;
  const days = Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return <StatusBadge status="Rejected" label="Expired" />;
  if (days <= 30) return <StatusBadge status="OnHold" label={`Expires in ${days} d`} />;
  if (days <= 60) return <StatusBadge status="Pending" label={`Expires in ${days} d`} />;
  return null;
}

function UploadZone({ file, setFile }: { file: File | null; setFile: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); setFile(e.dataTransfer.files[0] ?? null); }}
      className={clsx('flex flex-col items-center rounded-lg border-2 border-dashed p-6 text-center transition', over ? 'scale-[1.01] border-primary bg-primary-tint' : 'border-[#D6CEFB] bg-[#FAF9FF]')}>
      <UploadSimple size={28} className="text-primary" aria-hidden />
      {file ? <p className="mt-2 font-medium">{file.name} <span className="text-ink-2">({(file.size / 1024).toFixed(0)} KB)</span></p> : <p className="mt-2">Drag &amp; drop a PDF or image here</p>}
      <button type="button" onClick={() => input.current?.click()} className="mt-1 text-[14px] font-semibold text-primary hover:text-primary-hover">or browse files</button>
      <input ref={input} type="file" accept="application/pdf,image/png,image/jpeg" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <p className="mt-2 text-[12px] text-ink-2">PDF, PNG or JPEG · up to 10 MB</p>
    </div>
  );
}

export function DocumentsPanel({ entityType, entityId, onChanged }: { entityType: string; entityId: string; onChanged?: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['documents', entityType, entityId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ data: Doc[]; canUpload: boolean }>(`/documents?entityType=${entityType}&entityId=${entityId}`) });
  const types = useQuery({ queryKey: ['doc-types', entityType], queryFn: () => api<{ data: { code: string; name: string; requiresExpiry: boolean }[] }>(`/documents/types?entityType=${entityType}`), enabled: !!q.data?.canUpload });
  const [open, setOpen] = useState<null | 'new' | Doc>(null);
  const [archive, setArchive] = useState<Doc | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState({ documentType: '', title: '', validUntil: '', note: '' });
  const needsExpiry = open === 'new' ? types.data?.data.find((t) => t.code === meta.documentType)?.requiresExpiry : open && typeof open === 'object' && !!open.validUntil;
  const upload = useMutation({
    mutationFn: () => open === 'new'
      ? uploadFile('/documents', file!, { ...meta, entityType, entityId, validUntil: meta.validUntil || undefined })
      : uploadFile(`/documents/${(open as Doc).id}/versions`, file!, { validUntil: meta.validUntil || undefined, note: meta.note }),
    onSuccess: async () => { toast('success', 'Document uploaded.'); setOpen(null); setFile(null); setMeta({ documentType: '', title: '', validUntil: '', note: '' }); await qc.invalidateQueries({ queryKey: key }); onChanged?.(); },
  });
  const download = async (v: Version) => {
    try { const { url } = await api<{ url: string }>(`/documents/versions/${v.id}/link`, { method: 'POST' }); window.open(url + '&inline=1', '_blank', 'noopener'); }
    catch (e) { toast('error', (e as Error).message); }
  };
  const docs = q.data?.data ?? [];
  return (
    <Card title="Documents" actions={q.data?.canUpload && <Button size="sm" variant="secondary" icon={<Plus size={16} />} onClick={() => { upload.reset(); setOpen('new'); }}>Upload</Button>}>
      <ErrorBanner error={q.error} />
      {docs.length === 0 ? <p className="text-ink-2">No documents attached.</p> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {docs.filter((d) => d.versions.length > 0).map((d) => {
            const cur = d.versions[0]!;
            const Icon = cur.mime === 'application/pdf' ? FilePdf : FileImage;
            return (
              <li key={d.id} className={clsx('group rounded-lg border border-line p-4 transition hover:-translate-y-0.5 hover:shadow-hover', d.status === 'Archived' && 'opacity-60')}>
                <div className="flex gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-primary-soft text-primary"><Icon size={24} weight="duotone" aria-hidden /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{d.title}</p>
                    <p className="truncate text-[13px] text-ink-2">{d.typeName} · v{d.currentVersion} · {fmtSize(cur.sizeBytes)}</p>
                    <p className="text-[12px] text-ink-2">{cur.createdBy}, {fmtDateTime(cur.createdAt)}{d.validUntil ? ` · valid until ${fmtDate(d.validUntil)}` : ''}</p>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {d.status === 'Archived' ? <StatusBadge status="Inactive" label="Archived" /> : expiryBadge(d.validUntil)}
                  {d.sensitive && <StatusBadge status="OnHold" label="Sensitive" />}
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" icon={<DownloadSimple size={16} />} onClick={() => download(cur)}>Open</Button>
                  {q.data?.canUpload && d.status === 'Active' && <>
                    <Button size="sm" variant="ghost" onClick={() => { upload.reset(); setOpen(d); }}>New version</Button>
                    <Button size="sm" variant="ghost" onClick={() => setArchive(d)}>Archive</Button>
                  </>}
                </div>
                {d.versions.length > 1 && (
                  <details className="mt-2 text-[13px]"><summary className="cursor-pointer text-ink-2">Earlier versions ({d.versions.length - 1})</summary>
                    <ul className="mt-2 space-y-1">{d.versions.slice(1).map((v) => (
                      <li key={v.id} className="flex items-center justify-between"><span>v{v.version} · {fmtDateTime(v.createdAt)}{v.note ? ` · ${v.note}` : ''}</span>
                        <button className="font-semibold text-primary" onClick={() => download(v)}>Open</button></li>))}</ul></details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!open} onClose={() => setOpen(null)} title={open === 'new' ? 'Upload document' : `New version of ${(open as Doc | null)?.title ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setOpen(null)}>Cancel</Button>
          <Button loading={upload.isPending} disabled={!file || (open === 'new' && (!meta.documentType || !meta.title.trim())) || (!!needsExpiry && !meta.validUntil)} onClick={() => upload.mutate()}>Upload</Button></>}>
        <ErrorBanner error={upload.error} />
        <div className="space-y-4">
          {open === 'new' && <>
            <Field label="Document type" htmlFor="dtype" required><Select id="dtype" value={meta.documentType} onChange={(e) => setMeta({ ...meta, documentType: e.target.value })}><option value="">Select…</option>{types.data?.data.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</Select></Field>
            <Field label="Title" htmlFor="dtitle" required><Input id="dtitle" value={meta.title} onChange={(e) => setMeta({ ...meta, title: e.target.value })} /></Field>
          </>}
          {open !== 'new' && <Field label="What changed (optional)" htmlFor="dnote"><Input id="dnote" value={meta.note} onChange={(e) => setMeta({ ...meta, note: e.target.value })} /></Field>}
          <Field label={needsExpiry ? 'Valid until' : 'Valid until (optional)'} htmlFor="dexp" required={!!needsExpiry} hint="Expiry alerts at 60 and 30 days (BRD p.19)"><Input id="dexp" type="date" value={meta.validUntil} onChange={(e) => setMeta({ ...meta, validUntil: e.target.value })} /></Field>
          <UploadZone file={file} setFile={setFile} />
        </div>
      </Modal>
      <ReasonDialog open={!!archive} title={`Archive ${archive?.title ?? ''}`} confirmLabel="Archive" danger onClose={() => setArchive(null)} description="Archived documents stay in history but are no longer current."
        onConfirm={async (reason) => { await api(`/documents/${archive!.id}/archive`, { body: { reason } }); toast('success', 'Archived.'); await qc.invalidateQueries({ queryKey: key }); onChanged?.(); }} />
    </Card>
  );
}
