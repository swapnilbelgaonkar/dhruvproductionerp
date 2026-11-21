import { CheckCircle, CircleDashed, Clock, Lock, PauseCircle, Spinner, Warning, XCircle, type Icon } from '@phosphor-icons/react';
import clsx from 'clsx';
import { forwardRef, useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

// ---------------------------------------------------------------- Button
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean; size?: 'md' | 'sm'; icon?: ReactNode }>(
  function Button({ variant = 'primary', loading, size = 'md', icon, className, children, disabled, ...rest }, ref) {
    return (
      <button ref={ref} disabled={disabled || loading} {...rest}
        className={clsx('inline-flex items-center justify-center gap-2 font-semibold transition duration-200 ease-erp active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60',
          size === 'md' ? 'h-12 rounded-md px-5 text-[14px]' : 'h-9 rounded-sm px-3.5 text-[13px]',
          variant === 'primary' && 'bg-primary text-white hover:-translate-y-px hover:bg-primary-hover hover:shadow-primary',
          variant === 'secondary' && 'border border-line-input bg-white text-ink hover:bg-primary-tint hover:text-primary-hover',
          variant === 'ghost' && 'text-ink-2 hover:bg-primary-tint hover:text-primary-hover',
          variant === 'danger' && 'border border-danger-bg bg-danger-bg text-danger-text hover:border-danger-text', className)}>
        {loading ? <Spinner className="animate-spin" size={16} aria-hidden /> : icon}
        {children}
      </button>
    );
  });

// ---------------------------------------------------------------- Form controls
export function Field({ label, error, hint, required, children, htmlFor }: { label: string; error?: string; hint?: string; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}{required && <span className="text-danger-text" aria-hidden> *</span>}</label>
      {children}
      {error ? <p role="alert" className="mt-1.5 flex items-center gap-1 text-[12px] text-danger-text"><Warning size={14} aria-hidden />{error}</p>
        : hint ? <p className="mt-1.5 text-[12px] text-ink-2">{hint}</p> : null}
    </div>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ invalid, className, ...p }, ref) {
  return <input ref={ref} aria-invalid={invalid || undefined} className={clsx('input', invalid && 'input-error', className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(function Select({ invalid, className, children, ...p }, ref) {
  return <select ref={ref} aria-invalid={invalid || undefined} className={clsx('input appearance-none bg-[length:16px] bg-[right_14px_center] bg-no-repeat pr-10', invalid && 'input-error', className)}
    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Cpath fill='%236B6B80' d='M213.66 101.66l-80 80a8 8 0 0 1-11.32 0l-80-80a8 8 0 0 1 11.32-11.32L128 164.69l74.34-74.35a8 8 0 0 1 11.32 11.32z'/%3E%3C/svg%3E\")" }} {...p}>{children}</select>;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ invalid, className, ...p }, ref) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={clsx('input h-auto min-h-[96px] py-3', invalid && 'input-error', className)} {...p} />;
});

// ---------------------------------------------------------------- Status badge (doc 10 §6: colour + icon + label)
const BADGE: Record<string, { cls: string; icon: Icon }> = {
  neutral: { cls: 'bg-neutral-bg text-neutral-text', icon: CircleDashed },
  pending: { cls: 'bg-warning-bg text-warning-text', icon: Clock },
  positive: { cls: 'bg-success-bg text-success-text', icon: CheckCircle },
  negative: { cls: 'bg-danger-bg text-danger-text', icon: XCircle },
  hold: { cls: 'bg-warning-bg text-warning-text ring-1 ring-inset ring-warning-text/30', icon: PauseCircle },
  locked: { cls: 'bg-neutral-bg text-neutral-text ring-1 ring-inset ring-neutral-text/30', icon: Lock },
  special: { cls: 'bg-primary-soft text-primary-hover', icon: CheckCircle },
};
const FAMILY: Record<string, keyof typeof BADGE> = {
  Draft: 'neutral', Inactive: 'neutral', Waiting: 'neutral', Cancelled: 'neutral', Revoked: 'neutral', Retired: 'neutral', Deactivated: 'locked',
  Submitted: 'pending', Pending: 'pending', PendingApproval: 'pending',
  Active: 'positive', Approved: 'positive', Published: 'positive', Accepted: 'positive', Notified: 'special', Sent: 'special', Converted: 'special',
  Rejected: 'negative', Returned: 'negative', Expired: 'negative', Superseded: 'locked', Closed: 'locked',
  Acknowledged: 'positive', Received: 'positive', PartiallyReceived: 'pending', Issued: 'special', Awarded: 'positive', Lapsed: 'negative',
  OnHold: 'hold', Suspended: 'hold',
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const b = BADGE[FAMILY[status] ?? 'neutral']!;
  const Ico = b.icon;
  return <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold', b.cls)}><Ico size={14} weight="bold" aria-hidden />{label ?? status.replace(/([a-z])([A-Z])/g, '$1 $2')}</span>;
}

// ---------------------------------------------------------------- Layout pieces
export function PageHeader({ title, subtitle, actions, crumbs }: { title: string; subtitle?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs && <div className="mb-2 text-[13px] text-ink-2">{crumbs}</div>}
        <h1 className="font-display text-[28px] font-extrabold leading-tight tracking-[-0.5px] text-ink">{title}</h1>
        {subtitle && <div className="mt-1 text-[14px] text-ink-2">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, padded = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={clsx('card', padded && 'p-6 md:p-7', className)}>
      {(title || actions) && <div className={clsx('mb-4 flex items-center justify-between gap-3', !padded && 'px-6 pt-5 md:px-7 md:pt-6')}><h2 className="text-[17px] font-semibold text-ink">{title}</h2>{actions}</div>}
      {children}
    </section>
  );
}

/** `columns="narrow"` for side panels: one column, two on mid-size screens where the panel is full width. */
export function KeyValues({ items, columns = 'wide' }: { items: [string, ReactNode][]; columns?: 'wide' | 'narrow' }) {
  return (
    <dl className={clsx('grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2', columns === 'wide' ? 'lg:grid-cols-3' : 'xl:grid-cols-1')}>
      {items.map(([k, v]) => <div key={k}><dt className="text-[12px] font-medium uppercase tracking-wide text-ink-2">{k}</dt><dd className="mt-1 break-words text-[14px] text-ink">{v ?? '—'}</dd></div>)}
    </dl>
  );
}

export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <svg width="120" height="88" viewBox="0 0 120 88" aria-hidden><rect x="18" y="14" width="84" height="60" rx="14" fill="#EEEAFE" /><rect x="30" y="28" width="44" height="8" rx="4" fill="#C9BFFB" /><rect x="30" y="44" width="60" height="8" rx="4" fill="#DDD6FD" /><circle cx="96" cy="66" r="14" fill="#5B38F5" /><path d="M90 66h12M96 60v12" stroke="#fff" strokeWidth="3" strokeLinecap="round" /></svg>
      <h3 className="mt-4 text-[17px] font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-ink-2">{text}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) { return <div className={clsx('skeleton', className)} />; }

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as { message?: string; body?: { traceId?: string } };
  return <div role="alert" className="mb-4 flex items-start gap-2 rounded-md bg-danger-bg px-4 py-3 text-[14px] text-danger-text"><Warning size={18} className="mt-0.5 shrink-0" aria-hidden /><span>{e.message ?? 'Something went wrong.'}{e.body?.traceId && <span className="ml-1 text-[12px] opacity-80">(trace {e.body.traceId.slice(0, 8)})</span>}</span></div>;
}

// ---------------------------------------------------------------- Modal (native <dialog>: focus trap + Esc for free)
export function Modal({ open, onClose, title, description, children, footer, width = 560 }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={onClose} aria-labelledby="dlg-title" className="w-[calc(100%-32px)] rounded-2xl p-0 shadow-hover" style={{ maxWidth: width }}>
      {open && <div className="p-7">
        <h2 id="dlg-title" className="text-[22px] font-bold">{title}</h2>
        {description && <p className="mt-1 text-ink-2">{description}</p>}
        <div className="mt-5">{children}</div>
        {footer && <div className="mt-7 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>}
    </dialog>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto rounded-md bg-white p-1 shadow-card">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={clsx('h-10 whitespace-nowrap rounded-sm px-4 text-[14px] font-medium transition', value === t.value ? 'bg-primary-soft text-primary-hover' : 'text-ink-2 hover:bg-primary-tint')}>
          {t.label}{t.count !== undefined && <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-[12px] num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
