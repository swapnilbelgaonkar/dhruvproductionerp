import { MagnifyingGlass } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

interface Hit { type: string; id: string; title: string; subtitle: string; href: string }

function highlight(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return text;
  return <>{text.slice(0, i)}<mark className="rounded bg-primary-soft px-0.5 text-primary-hover">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const nav = useNavigate();
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 200); return () => clearTimeout(t); }, [q]);
  useEffect(() => { const d = ref.current; if (open && d && !d.open) { d.showModal(); setQ(''); } if (!open && d?.open) d.close(); }, [open]);
  const res = useQuery({ queryKey: ['search', debounced], queryFn: () => api<{ data: Hit[] }>(`/search?q=${encodeURIComponent(debounced)}`), enabled: debounced.length >= 2 });
  const hits = res.data?.data ?? [];
  const go = (h: Hit) => { onClose(); nav(h.href); };
  return (
    <dialog ref={ref} onClose={onClose} aria-label="Search" className="mt-[10vh] w-[calc(100%-32px)] max-w-[640px] rounded-xl p-0 shadow-hover">
      <div className="flex items-center gap-3 border-b border-line px-5">
        <MagnifyingGlass size={20} className="text-ink-2" aria-hidden />
        <input autoFocus aria-label="Search records" className="h-16 flex-1 bg-transparent text-[16px] outline-none" placeholder="Search masters, users, approvals…" value={q}
          onChange={(e) => { setQ(e.target.value); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            if (e.key === 'Enter' && hits[active]) go(hits[active]!);
          }} />
        <kbd className="rounded border border-line px-1.5 text-[11px] text-ink-2">Esc</kbd>
      </div>
      <ul role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
        {debounced.length < 2 && <li className="px-4 py-6 text-center text-ink-2">Type at least two characters.</li>}
        {debounced.length >= 2 && !res.isLoading && hits.length === 0 && <li className="px-4 py-6 text-center text-ink-2">No results you have access to.</li>}
        {hits.map((h, i) => (
          <li key={h.type + h.id} role="option" aria-selected={i === active}>
            <button onMouseEnter={() => setActive(i)} onClick={() => go(h)} className={`flex w-full items-center gap-3 rounded-md px-4 py-3 text-left ${i === active ? 'bg-primary-tint' : ''}`}>
              <span className="w-24 shrink-0 text-[12px] font-semibold uppercase text-ink-2">{h.type}</span>
              <span className="min-w-0"><span className="block truncate font-medium">{highlight(h.title, debounced)}</span><span className="block truncate text-[13px] text-ink-2">{highlight(h.subtitle ?? '', debounced)}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
