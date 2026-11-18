const dt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const d = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('en-IN');

export const fmtDateTime = (v?: string | null) => (v ? dt.format(new Date(v)) : '—');
export const fmtDate = (v?: string | null) => (v ? d.format(new Date(v)) : '—');
export const fmtINR = (v?: string | number | null) => (v === null || v === undefined ? '—' : inr.format(Number(v)));
export const fmtNum = (v?: string | number | null) => (v === null || v === undefined ? '—' : num.format(Number(v)));
export const humanize = (s: string) => s.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
/** Two-letter initials, ignoring tags such as "[SAMPLE]". */
export const initials = (name?: string) =>
  (name ?? '').replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';
