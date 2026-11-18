import { useState, type ReactNode } from 'react';
import { ErrorBanner, Field, Button, Modal, Textarea } from './ui';

/** Every override/status change asks for a reason that goes into the audit trail. */
export function ReasonDialog({ open, title, description, confirmLabel, danger, onClose, onConfirm, children }: {
  open: boolean; title: string; description?: string; confirmLabel: string; danger?: boolean; children?: ReactNode;
  onClose: () => void; onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const close = () => { setReason(''); setError(null); onClose(); };
  return (
    <Modal open={open} onClose={close} title={title} description={description}
      footer={<>
        <Button variant="secondary" onClick={close}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={!reason.trim()} onClick={async () => {
          setBusy(true); setError(null);
          try { await onConfirm(reason.trim()); close(); } catch (e) { setError(e); } finally { setBusy(false); }
        }}>{confirmLabel}</Button>
      </>}>
      <ErrorBanner error={error} />
      {children && <div className="mb-4 space-y-4">{children}</div>}
      <Field label="Reason (recorded in the audit trail)" required htmlFor="reason">
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </Field>
    </Modal>
  );
}
