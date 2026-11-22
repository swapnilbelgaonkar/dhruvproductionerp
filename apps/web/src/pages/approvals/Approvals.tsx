import { Bell, CheckCircle, Circle, Clock, PauseCircle, XCircle } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { DataTable } from '../../components/DataTable';
import { useToast } from '../../components/toast';
import { Button, Card, ErrorBanner, Field, KeyValues, Modal, PageHeader, Skeleton, StatusBadge, Tabs, Textarea } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime, humanize } from '../../lib/format';

interface Row { id: string; doc_no: string; subject_type: string; subject_label: string; status: string; submitted_at: string; initiator: string; current_step: string | null; due_at: string | null }

export function ApprovalsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') ?? 'inbox') as 'inbox' | 'initiated' | 'notified' | 'all';
  const tabs = [
    { value: 'inbox' as const, label: 'Awaiting me' }, { value: 'initiated' as const, label: 'Submitted by me' }, { value: 'notified' as const, label: 'For my information' },
    ...(can('wf.approval:view_all') ? [{ value: 'all' as const, label: 'All requests' }] : []),
  ];
  return (
    <>
      <PageHeader title="Approvals" subtitle="One inbox for every decision across the ERP (BRD §7.3)." />
      <Tabs value={view} onChange={(v) => setParams({ view: v })} tabs={tabs} />
      <DataTable<Row> key={view} queryKey={`approvals-${view}`} path="/approvals" filters={{ view }} searchable={false}
        statusOptions={['Pending', 'OnHold', 'Approved', 'Rejected', 'Returned', 'Cancelled']}
        rowHref={(r) => `/approvals/${r.id}`}
        empty={{ title: view === 'inbox' ? 'Nothing waiting for you' : 'No requests', text: view === 'inbox' ? 'When someone submits a document you approve, it appears here.' : 'Requests will appear here once submitted.' }}
        columns={[
          { key: 'doc', header: 'Request', render: (r) => <span className="font-semibold">{r.doc_no}</span> },
          { key: 'subject', header: 'Subject', render: (r) => <span><span className="block font-medium">{r.subject_label}</span><span className="text-[13px] text-ink-2">{humanize(r.subject_type)}</span></span> },
          { key: 'initiator', header: 'Initiator', render: (r) => r.initiator },
          { key: 'step', header: 'Current step', render: (r) => r.current_step ?? '—' },
          { key: 'submitted', header: 'Submitted', render: (r) => fmtDateTime(r.submitted_at) },
          { key: 'due', header: 'Due', render: (r) => r.due_at ? <span className={clsx(new Date(r.due_at) < new Date() && 'font-semibold text-danger-text')}>{fmtDateTime(r.due_at)}</span> : '—' },
          { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
        ]} />
    </>
  );
}

interface Step { id: string; seq: number; label: string; step_kind: 'approve' | 'notify'; status: string; approvers: { id: string; name: string }[] | null; decided_by_name: string | null; decided_at: string | null; due_at: string | null }
interface Detail {
  id: string; doc_no: string; subject_type: string; subject_id: string; subject_label: string; status: string; initiator: string; submitted_at: string; completed_at: string | null;
  rule_name: string; policy_version: number; facts: Record<string, unknown>; steps: Step[]; decisions: { decision: string; remarks: string; created_at: string; actor: string }[];
  allowedDecisions: string[];
}

const SUBJECT_LINK: Record<string, (id: string) => string> = {
  'org.legal_entity': (id) => `/masters/legal-entities/${id}`, 'org.plant': (id) => `/masters/plants/${id}`, 'org.warehouse': (id) => `/masters/warehouses/${id}`,
  'mdm.item': (id) => `/products/items/${id}`, 'mdm.dealer': (id) => `/sales/dealers/${id}`,
  'sales.price_list': (id) => `/sales/price-lists/${id}`, 'sales.quotation': (id) => `/sales/quotations/${id}`, 'sales.order': (id) => `/sales/orders/${id}`, 'mdm.vendor': (id) => `/purchase/vendors/${id}`, 'purchase.requisition': (id) => `/purchase/requisitions/${id}`, 'purchase.order': (id) => `/purchase/orders/${id}`, 'purchase.supplier_invoice': (id) => `/purchase/invoices/${id}`, 'mfg.bom_version': (id) => `/production/formulation-versions/${id}`, 'mfg.production_order': (id) => `/production/orders/${id}`, 'mfg.quarantine_override': (id) => `/production/overrides/${id}`, 'mfg.dosing_deviation': (id) => `/qa/deviations/${id}`, 'qc.spec_version': () => '/qc/master', 'qa.change_request': (id) => `/qa/changes/${id}`, 'qa.document_version': () => '/qa/documents', 'sales.credit_note': (id) => `/finance/credit-notes/${id}`,
};
const DECISION_LABEL: Record<string, string> = { Approve: 'Approve', Reject: 'Reject', Return: 'Return for correction', Hold: 'Put on hold', Resume: 'Resume', Cancel: 'Withdraw request' };

function StepIcon({ s }: { s: Step }) {
  if (s.step_kind === 'notify') return <Bell size={20} weight="duotone" className="text-primary" aria-hidden />;
  if (s.status === 'Approved') return <CheckCircle size={20} weight="fill" className="text-success-text" aria-hidden />;
  if (['Rejected', 'Returned'].includes(s.status)) return <XCircle size={20} weight="fill" className="text-danger-text" aria-hidden />;
  if (s.status === 'OnHold') return <PauseCircle size={20} weight="fill" className="text-warning-text" aria-hidden />;
  if (s.status === 'Pending') return <Clock size={20} weight="duotone" className="text-warning-text" aria-hidden />;
  return <Circle size={20} className="text-ink-muted" aria-hidden />;
}

export function ApprovalDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['approval', id], queryFn: () => api<Detail>(`/approvals/${id}`) });
  const [decision, setDecision] = useState<string | null>(null);
  const [remarks, setRemarks] = useState('');
  const m = useMutation({
    mutationFn: () => api(`/approvals/${id}/decisions`, { body: { decision, remarks } }),
    onSuccess: async () => { toast('success', `${DECISION_LABEL[decision!]} recorded.`); setDecision(null); setRemarks(''); await qc.invalidateQueries(); },
  });
  const d = q.data;
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (!d) return <ErrorBanner error={q.error} />;
  const needsRemarks = decision && ['Reject', 'Return', 'Hold'].includes(decision);
  const link = SUBJECT_LINK[d.subject_type]?.(d.subject_id);
  return (
    <>
      <PageHeader title={d.doc_no} crumbs={<Link to="/approvals" className="hover:text-primary">Approvals</Link>}
        subtitle={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge status={d.status} /> {d.subject_label}</span>}
        actions={d.allowedDecisions.map((x) => (
          <Button key={x} variant={x === 'Approve' || x === 'Resume' ? 'primary' : x === 'Reject' ? 'danger' : 'secondary'} onClick={() => { m.reset(); setDecision(x); }}>{DECISION_LABEL[x]}</Button>
        ))} />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card title="Request">
            <KeyValues items={[
              ['Subject', link ? <Link to={link} className="font-medium text-primary hover:text-primary-hover">{d.subject_label}</Link> : d.subject_label],
              ['Document type', humanize(d.subject_type)], ['Initiated by', d.initiator], ['Submitted', fmtDateTime(d.submitted_at)],
              ['Completed', fmtDateTime(d.completed_at)], ['Policy rule', `${d.rule_name} (v${d.policy_version})`],
            ]} />
          </Card>
          <Card title="Decision history">
            {d.decisions.length === 0 ? <p className="text-ink-2">No decisions yet.</p> : (
              <ul className="divide-y divide-line">{d.decisions.map((x, i) => (
                <li key={i} className="py-3"><p><span className="font-semibold">{x.actor}</span> — {DECISION_LABEL[x.decision] ?? x.decision}</p>
                  {x.remarks && <p className="mt-1 rounded-sm bg-canvas px-3 py-2 text-[14px]">{x.remarks}</p>}
                  <p className="mt-1 text-[12px] text-ink-2">{fmtDateTime(x.created_at)}</p></li>))}</ul>
            )}
          </Card>
        </div>
        <Card title="Route">
          <ol className="space-y-5">
            {d.steps.map((s) => (
              <li key={s.id} className="flex gap-3">
                <span className="mt-0.5"><StepIcon s={s} /></span>
                <div className="min-w-0">
                  <p className="font-medium">{s.label}</p>
                  <p className="text-[13px] text-ink-2">{s.step_kind === 'notify' ? 'Notified: ' : 'Approvers: '}{s.approvers?.map((a) => a.name).join(', ') || 'none'}</p>
                  <p className="mt-1 text-[12px] text-ink-2">
                    {s.decided_by_name ? `${s.status} by ${s.decided_by_name}, ${fmtDateTime(s.decided_at)}` : s.status === 'Pending' && s.due_at ? `Due ${fmtDateTime(s.due_at)}` : s.status.replace(/([a-z])([A-Z])/g, '$1 $2')}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
      <Modal open={!!decision} onClose={() => setDecision(null)} title={DECISION_LABEL[decision ?? ''] ?? ''} description={d.subject_label}
        footer={<><Button variant="secondary" onClick={() => setDecision(null)}>Cancel</Button>
          <Button variant={decision === 'Reject' ? 'danger' : 'primary'} loading={m.isPending} disabled={!!needsRemarks && !remarks.trim()} onClick={() => m.mutate()}>Confirm</Button></>}>
        <ErrorBanner error={m.error} />
        <Field label={needsRemarks ? 'Remarks (required)' : 'Remarks (optional)'} htmlFor="remarks" required={!!needsRemarks}>
          <Textarea id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={1000} />
        </Field>
      </Modal>
    </>
  );
}
