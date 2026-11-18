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
  return (
    <AuthLayout title="Two-step verification" subtitle="Enter the 6-digit code from your authenticator app.">
      <TotpForm path="/auth/mfa/verify" label="Authentication code" onDone={refresh} />
    </AuthLayout>
  );
}

export function MfaEnrol() {
  const { refresh } = useAuth();
  const start = useMutation({ mutationFn: () => api<{ secret: string; qrDataUrl: string }>('/auth/mfa/enrol', { method: 'POST' }) });
  return (
    <AuthLayout title="Set up two-step verification" subtitle="Your role requires an authenticator app (Google Authenticator, Microsoft Authenticator or similar).">
      {!start.data ? (
        <><ErrorBanner error={start.error} /><Button className="w-full" loading={start.isPending} onClick={() => start.mutate()}>Start setup</Button></>
      ) : (
        <div className="space-y-6">
          <div className="card flex flex-col items-center p-6">
            <img src={start.data.qrDataUrl} alt="QR code to scan with your authenticator app" width={184} height={184} />
            <p className="mt-3 text-center text-[13px] text-ink-2">Can't scan? Enter this key manually:</p>
            <code className="mt-1 break-all rounded-sm bg-canvas px-3 py-1.5 text-[13px]">{start.data.secret}</code>
          </div>
          <TotpForm path="/auth/mfa/enrol/confirm" label="Code shown in the app" onDone={refresh} />
        </div>
      )}
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
