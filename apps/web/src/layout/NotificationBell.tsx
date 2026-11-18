import { Bell, CheckCircle, Info, Warning, WarningCircle } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

interface Note { id: string; kind: 'action' | 'info' | 'success' | 'warning'; title: string; body: string; link: string | null; readAt: string | null; createdAt: string }
const ICON = { action: { I: WarningCircle, c: 'bg-primary-soft text-primary' }, info: { I: Info, c: 'bg-info-bg text-info-text' }, success: { I: CheckCircle, c: 'bg-success-bg text-success-text' }, warning: { I: Warning, c: 'bg-warning-bg text-warning-text' } };

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ data: Note[]; unread: number }>('/notifications'), refetchInterval: 30_000 });
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, []);
  const unread = q.data?.unread ?? 0;
  const openNote = async (n: Note) => {
    setOpen(false);
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['notifications'] });
    if (n.link) nav(n.link);
  };
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open}
        className="relative grid h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-[#F1EEFF] hover:text-primary">
        <Bell size={22} weight={open ? 'fill' : 'regular'} />
        {unread > 0 && <span className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-canvas" aria-hidden />}
      </button>
      {open && (
        <div className="absolute right-0 top-14 z-30 w-[min(400px,calc(100vw-32px))] rounded-lg bg-white p-2 shadow-hover">
          <div className="flex items-center justify-between px-3 py-2">
            <p className="font-semibold">Notifications</p>
            {unread > 0 && <button className="text-[13px] font-semibold text-primary" onClick={async () => { await api('/notifications/read-all', { method: 'POST' }); await qc.invalidateQueries({ queryKey: ['notifications'] }); }}>Mark all read</button>}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {q.data?.data.length === 0 && <li className="px-3 py-8 text-center text-ink-2">You're all caught up.</li>}
            {q.data?.data.map((n) => {
              const { I, c } = ICON[n.kind];
              return (
                <li key={n.id}>
                  <button onClick={() => openNote(n)} className={clsx('flex w-full gap-3 rounded-md px-3 py-3 text-left hover:bg-[#FAF9FF]', !n.readAt && 'bg-[#F7F5FF]')}>
                    <span className={clsx('grid h-10 w-10 shrink-0 place-items-center rounded-lg', c)}><I size={20} weight="duotone" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2"><span className="truncate font-medium">{n.title}</span>{!n.readAt && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />}</span>
                      <span className="block truncate text-[13px] text-ink-2">{n.body}</span>
                      <span className="block text-[12px] text-ink-2">{fmtDateTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
