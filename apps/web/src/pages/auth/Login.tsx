import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema } from '@dhruv/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import { Button, ErrorBanner, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen bg-canvas lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-gradient-to-br from-[#6843FF] to-[#4931D4] p-14 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-white/15"><svg width="26" height="26" viewBox="0 0 64 64" aria-hidden><path d="M32 12c-9 7-16 15-16 24a16 16 0 0 0 32 0c0-9-7-17-16-24z" fill="none" stroke="#fff" strokeWidth="5" strokeLinejoin="round" /><path d="M32 30v20" stroke="#fff" strokeWidth="5" strokeLinecap="round" /></svg></span>
          <span className="font-display text-[18px] font-extrabold">Dhruv Agro Technologies</span>
        </div>
        <div>
          <p className="font-display text-[44px] font-extrabold leading-[1.05] tracking-[-1.5px]">One enterprise.<br />One connected ERP.</p>
          <p className="mt-4 max-w-md text-[16px] text-white/80">Controlled processes, traceable transactions and reliable information — from dealer order to batch release.</p>
        </div>
        <p className="text-[13px] text-white/60">Authorised users only. Activity is recorded in the audit log.</p>
        <div aria-hidden className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10" />
        <div aria-hidden className="absolute -bottom-32 right-24 h-72 w-72 rounded-full bg-white/5" />
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-[420px]">
          <h1 className="font-display text-[34px] font-extrabold tracking-[-1px]">{title}</h1>
          <p className="mb-8 mt-2 text-ink-2">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const f = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  const submit = f.handleSubmit(async (v) => {
    setError(null);
    try {
      await api('/auth/login', { body: v });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(params.get('next') ?? '/', { replace: true });
    } catch (e) { setError(e); }
  });
  return (
    <AuthLayout title="Sign in" subtitle="Use your company email and password.">
      <ErrorBanner error={error} />
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field label="Email" htmlFor="email" error={f.formState.errors.email?.message} required>
          <Input id="email" type="email" autoComplete="username" autoFocus invalid={!!f.formState.errors.email} {...f.register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={f.formState.errors.password?.message} required>
          <Input id="password" type="password" autoComplete="current-password" invalid={!!f.formState.errors.password} {...f.register('password')} />
        </Field>
        <Button type="submit" className="w-full" loading={f.formState.isSubmitting}>Sign in</Button>
      </form>
      <p className="mt-6 text-[13px] text-ink-2">Forgot your password or locked out? Ask your Security Administrator to unlock or reset your account.</p>
    </AuthLayout>
  );
}
