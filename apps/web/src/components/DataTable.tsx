import { CaretLeft, CaretRight, MagnifyingGlass } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs, type Page } from '../lib/api';
import { EmptyState, ErrorBanner, Select, Skeleton } from './ui';

export interface Column<T> { key: string; header: string; render: (row: T) => ReactNode; className?: string }

/** Server-paginated, searchable register (doc 06 §3, UI-002). */
export function DataTable<T extends { id?: string }>({ queryKey, path, columns, rowHref, filters, statusOptions, defaultStatus = '', empty, searchPlaceholder = 'Search code or name', searchable = true }: {
  queryKey: string; path: string; columns: Column<T>[]; rowHref?: (row: T) => string; filters?: Record<string, unknown>;
  statusOptions?: string[]; /** status filter selected when the list opens */ defaultStatus?: string; empty: { title: string; text: string; action?: ReactNode }; searchPlaceholder?: string; searchable?: boolean;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(defaultStatus);
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const nav = useNavigate();
  const query = useQuery({
    queryKey: [queryKey, q, status, offset, filters],
    queryFn: () => api<Page<T>>(path + qs({ q, status, limit, offset, ...filters })),
    placeholderData: (prev) => prev,
  });
  const total = Number(query.data?.total ?? 0);
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        {searchable ? <div className="relative min-w-[220px] flex-1">
          <MagnifyingGlass size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-2" aria-hidden />
          <input aria-label="Search" className="input h-11 pl-11" placeholder={searchPlaceholder} value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        </div> : <div className="flex-1" />}
        {statusOptions && (
          <Select aria-label="Filter by status" className="h-11 w-48" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}>
            <option value="">All statuses</option>
            {statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        )}
      </div>
      <ErrorBanner error={query.error} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left">
          <thead><tr className="bg-[#F7F6FC] text-[13px] text-ink-2">{columns.map((c) => <th key={c.key} scope="col" className={clsx('px-5 py-3 font-medium', c.className)}>{c.header}</th>)}</tr></thead>
          <tbody>
            {query.isLoading && Array.from({ length: 5 }).map((_, i) => (
              <tr key={i} className="border-t border-line">{columns.map((c) => <td key={c.key} className="px-5 py-4"><Skeleton className="h-4 w-3/4" /></td>)}</tr>
            ))}
            {query.data?.data.map((row, i) => (
              <tr key={row.id ?? i} tabIndex={rowHref ? 0 : undefined}
                onClick={rowHref ? () => nav(rowHref(row)) : undefined}
                onKeyDown={rowHref ? (e) => { if (e.key === 'Enter') nav(rowHref(row)); } : undefined}
                className={clsx('h-14 border-t border-line transition-colors', rowHref && 'cursor-pointer hover:bg-[#FAF9FF]')}>
                {columns.map((c) => <td key={c.key} className={clsx('px-5 py-3 align-middle', c.className)}>{c.render(row)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.data && query.data.data.length === 0 && <EmptyState {...empty} />}
      {total > limit && (
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[13px] text-ink-2">
          <span className="num">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
          <div className="flex gap-1">
            <button aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} className="grid h-9 w-9 place-items-center rounded-sm hover:bg-primary-tint disabled:opacity-40"><CaretLeft /></button>
            <button aria-label="Next page" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} className="grid h-9 w-9 place-items-center rounded-sm hover:bg-primary-tint disabled:opacity-40"><CaretRight /></button>
          </div>
        </div>
      )}
    </div>
  );
}
