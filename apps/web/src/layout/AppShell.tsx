import { List, MagnifyingGlass, SignOut, SidebarSimple, X } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { initials } from '../lib/format';
import { NAV } from './nav';
import { NotificationBell } from './NotificationBell';
import { SearchOverlay } from './SearchOverlay';

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-3 px-2" aria-label="Dhruv Agro ERP home">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-primary shadow-primary">
        <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden><path d="M32 12c-9 7-16 15-16 24a16 16 0 0 0 32 0c0-9-7-17-16-24z" fill="none" stroke="#fff" strokeWidth="5" strokeLinejoin="round" /><path d="M32 30v20" stroke="#fff" strokeWidth="5" strokeLinecap="round" /></svg>
      </span>
      {!collapsed && <span className="leading-tight"><span className="block font-display text-[16px] font-extrabold">Dhruv Agro</span><span className="block text-[12px] text-ink-2">Enterprise ERP 2.0</span></span>}
    </Link>
  );
}

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { can } = useAuth();
  const pending = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ myPendingApprovals: number }>('/dashboard/overview'), refetchInterval: 60_000 });
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 overflow-y-auto px-4 py-7">
      <Logo collapsed={collapsed} />
      {NAV.map((g, gi) => {
        const items = g.items.filter((i) => !i.perm || can(i.perm));
        if (!items.length) return null;
        return (
          <div key={gi}>
            {g.label && !collapsed && <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-2">{g.label}</p>}
            <ul className="space-y-1">
              {items.map((i) => (
                <li key={i.to}>
                  <NavLink to={i.to} end={i.to === '/'} onClick={onNavigate} title={collapsed ? i.label : undefined}
                    className={({ isActive }) => clsx('group flex h-12 items-center gap-3.5 rounded-md px-3 text-[15px] font-medium transition duration-200 ease-erp hover:translate-x-0.5 hover:bg-primary-tint hover:text-primary-hover',
                      isActive ? 'font-semibold text-primary' : 'text-ink-2')}>
                    {({ isActive }) => (<>
                      <i.icon size={22} weight={isActive ? 'fill' : 'duotone'} className={clsx('shrink-0', isActive ? 'text-primary' : 'text-[#9A99AE] group-hover:text-primary')} aria-hidden />
                      {!collapsed && <span className="flex-1 truncate">{i.label}</span>}
                      {!collapsed && i.to === '/approvals' && !!pending.data?.myPendingApprovals && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-white num" aria-label={`${pending.data.myPendingApprovals} pending`}>{pending.data.myPendingApprovals}</span>)}
                    </>)}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const { me } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = async () => { await api('/auth/logout', { method: 'POST' }); location.assign('/login'); };

  return (
    <div className="min-h-screen bg-white">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2">Skip to content</a>
      <aside className={clsx('fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-white transition-[width] duration-300 ease-erp lg:block', collapsed ? 'w-[88px]' : 'w-[280px]')}>
        <Sidebar collapsed={collapsed} />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-[rgba(22,20,45,0.28)] backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] bg-white shadow-hover">
            <button aria-label="Close menu" onClick={() => setMobileOpen(false)} className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full hover:bg-primary-tint"><X size={18} /></button>
            <Sidebar collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className={clsx('min-h-screen bg-canvas transition-[padding] duration-300 ease-erp', collapsed ? 'lg:pl-[88px]' : 'lg:pl-[280px]')}>
        <header className="sticky top-0 z-20 flex h-[76px] items-center gap-3 bg-canvas/90 px-4 backdrop-blur md:px-10">
          <button aria-label="Open menu" onClick={() => setMobileOpen(true)} className="grid h-11 w-11 place-items-center rounded-full hover:bg-primary-tint lg:hidden"><List size={22} /></button>
          <button aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setCollapsed((c) => !c)} className="hidden h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-primary-tint hover:text-primary lg:grid"><SidebarSimple size={22} /></button>
          <button onClick={() => setSearchOpen(true)} className="flex h-11 flex-1 items-center gap-3 rounded-md px-3 text-left text-[15px] text-ink-2 hover:bg-white md:max-w-md">
            <MagnifyingGlass size={20} aria-hidden /> <span className="flex-1">Search</span>
            <kbd className="hidden rounded border border-line bg-white px-1.5 text-[11px] md:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <button onClick={() => nav('/profile')} className="flex h-11 items-center gap-2.5 rounded-full bg-white pl-1.5 pr-4 shadow-card hover:bg-primary-tint" aria-label="My profile">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-primary-soft text-[13px] font-bold text-primary-hover">{initials(me?.user.fullName)}</span>
              <span className="hidden max-w-[160px] truncate text-[14px] font-medium md:block">{me?.user.fullName}</span>
            </button>
            <button onClick={logout} aria-label="Sign out" title="Sign out" className="grid h-11 w-11 place-items-center rounded-full text-ink-2 hover:bg-primary-tint hover:text-primary"><SignOut size={20} /></button>
          </div>
        </header>
        <main id="main" key={loc.pathname} className="page-enter px-4 pb-12 pt-2 md:px-10">
          <Outlet />
        </main>
      </div>
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
