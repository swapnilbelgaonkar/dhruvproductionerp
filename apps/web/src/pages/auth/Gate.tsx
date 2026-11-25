import { zodResolver } from '@hookform/resolvers/zod';
import { changePasswordSchema, totpSchema } from '@dhruv/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { Button, ErrorBanner, Field, Input } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthLayout } from './Login';

function TotpForm({ path, onDone, label }: { path: string; onDone: () => void; label: string }) {
  const [error, setError] = useState<unknown>(null);
  const f = useForm<z.infer<typeof totpSchema>>({ resolver: zodResolver(totpSchema) });
  return (
    <form noValidate className="space-y-5" onSubmit={f.handleSubmit(async (v) => { setError(null); try { await api(path, { body: v }); onDone(); } catch (e) { setError(e); } })}>
      <ErrorBanner error={error} />
      <Field label={label} htmlFor="code" error={f.formState.errors.code?.message} required>
        <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus className="text-center text-[22px] tracking-[0.4em] num" {...f.register('code')} />
      </Field>
      <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>Continue</Button>
    </form>
  );
}

export function MfaVerify() {
  const { refresh } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthLayout title="Two-step verification" subtitle={recovery ? 'Enter one of the recovery codes you saved when you set up two-step verification. Each code works once.' : 'Enter the 6-digit code from your authenticator app.'}>
      {recovery ? (
        <form noValidate className="space-y-5" onSubmit={async (e) => { e.preventDefault(); setError(null); setBusy(true);
          try { await api('/auth/mfa/verify', { body: { recoveryCode: code } }); await refresh(); } catch (x) { setError(x); } finally { setBusy(false); } }}>
          <ErrorBanner error={error} />
          <Field label="Recovery code" htmlFor="rc" required><Input id="rc" autoComplete="off" autoFocus placeholder="ABCD-EFGH" className="text-center text-[18px] tracking-[0.2em] num" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button type="submit" className="w-full" loading={busy}>Continue</Button>
        </form>
      ) : <TotpForm path="/auth/mfa/verify" label="Authentication code" onDone={refresh} />}
      <button type="button" className="mt-4 w-full text-center text-[13px] text-primary underline" onClick={() => { setRecovery(!recovery); setError(null); }}>
        {recovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}</button>
    </AuthLayout>
  );
}

/** Shows the single-use recovery codes once, with copy and download. */
export function RecoveryCodes({ codes, onDone, doneLabel = 'I have saved them' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const text = `Dhruv Agro ERP — two-step verification recovery codes\nEach code works once. Keep them somewhere safe, away from your phone.\n\n${codes.join('\n')}\n`;
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4">
      <p className="text-[14px]">If you lose your phone, sign in with one of these codes. <b>They are shown only now.</b> Print them or keep them in a password manager.</p>
      <ol className="grid grid-cols-2 gap-2 rounded-md border border-line bg-canvas p-4 font-mono text-[15px] num" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy'}</Button>
        <a className="btn btn-secondary inline-flex items-center rounded-md border border-line px-4 py-2 text-[14px] font-semibold" download="dhruv-erp-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}>Download</a>
        <Button onClick={onDone}>{doneLabel}</Button>
      </div>
    </div>
  );
}

/** Authenticator set-up: QR, confirm with a code, then the recovery codes. Used at sign-in (role requires it) and from My profile. */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const start = useMutation({ mutationFn: () => api<{ secret: string; qrDataUrl: string }>('/auth/mfa/enrol', { method: 'POST' }) });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const f = useForm<z.infer<typeof totpSchema>>({ resolver: zodResolver(totpSchema) });
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  if (!start.data) return <><ErrorBanner error={start.error} /><Button className="w-full" loading={start.isPending} onClick={() => start.mutate()}>Start setup</Button></>;
  return (
    <div className="space-y-6">
      <div className="card flex flex-col items-center p-6">
        <img src={start.data.qrDataUrl} alt="QR code to scan with your authenticator app" width={184} height={184} />
        <p className="mt-3 text-center text-[13px] text-ink-2">Can't scan? Enter this key manually:</p>
        <code className="mt-1 break-all rounded-sm bg-canvas px-3 py-1.5 text-[13px]">{start.data.secret}</code>
      </div>
      <form noValidate className="space-y-5" onSubmit={f.handleSubmit(async (v) => { setError(null);
        try { const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/enrol/confirm', { body: v }); setCodes(r.recoveryCodes); } catch (e) { setError(e); } })}>
        <ErrorBanner error={error} />
        <Field label="Code shown in the app" htmlFor="enrol-code" error={f.formState.errors.code?.message} required>
          <Input id="enrol-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="text-center text-[22px] tracking-[0.4em] num" {...f.register('code')} />
        </Field>
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>Confirm</Button>
      </form>
    </div>
  );
}

export function MfaEnrol() {
  const { refresh } = useAuth();
  return (
    <AuthLayout title="Set up two-step verification" subtitle="Your role requires an authenticator app (Google Authenticator, Microsoft Authenticator or similar).">
      <MfaSetup onDone={refresh} />
    </AuthLayout>
  );
}

export function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const f = useForm<z.infer<typeof changePasswordSchema>>({ resolver: zodResolver(changePasswordSchema) });
  return (
    <form noValidate className="space-y-5" onSubmit={f.handleSubmit(async (v) => {
      setError(null);
      try { await api('/auth/password/change', { body: v }); f.reset(); onDone(); }
      catch (e) { if (e instanceof ApiError) Object.entries(e.fieldErrors).forEach(([k, m]) => f.setError(k as 'newPassword', { message: m })); setError(e); }
    })}>
      <ErrorBanner error={error} />
      <Field label="Current password" htmlFor="cur" error={f.formState.errors.currentPassword?.message} required>
        <Input id="cur" type="password" autoComplete="current-password" {...f.register('currentPassword')} />
      </Field>
      <Field label="New password" htmlFor="new" error={f.formState.errors.newPassword?.message} hint="At least 12 characters with letters and digits." required>
        <Input id="new" type="password" autoComplete="new-password" {...f.register('newPassword')} />
      </Field>
      <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>Change password</Button>
    </form>
  );
}

export function PasswordChangeGate() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  return (
    <AuthLayout title="Choose a new password" subtitle="Your password was set by an administrator. Choose your own before continuing.">
      <ChangePasswordForm onDone={async () => { await refresh(); await qc.invalidateQueries(); }} />
    </AuthLayout>
  );
}
