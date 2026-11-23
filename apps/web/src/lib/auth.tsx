import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface Me {
  user: { id: string; email: string; fullName: string; mustChangePassword: boolean; mfaEnabled: boolean; employeeId: string | null };
  roles: { code: string; name: string }[];
  permissions: string[];
  gate: null | 'MFA_VERIFY' | 'MFA_ENROL' | 'PASSWORD_CHANGE';
  mfaRequiredByRole: boolean;
}

const Ctx = createContext<{ me: Me | null; loading: boolean; offline: boolean; can: (p: string) => boolean; refresh: () => Promise<void> }>({
  me: null, loading: true, offline: false, can: () => false, refresh: async () => undefined,
});
const ME_KEY = 'dhruv.me';
const cachedMe = (): Me | null => { try { return JSON.parse(localStorage.getItem(ME_KEY) ?? 'null') as Me | null; } catch { return null; } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<Me & { offline?: boolean } | null> => {
      try {
        const me = await api<Me>('/me');
        try { localStorage.setItem(ME_KEY, JSON.stringify(me)); } catch { /* storage unavailable */ }
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { try { localStorage.removeItem(ME_KEY); } catch { /* ignore */ } return null; }
        // no network: the scanner keeps working on the last known sign-in; the server still checks every request when it syncs
        if (!(e instanceof ApiError)) { const c = cachedMe(); if (c) return { ...c, offline: true }; }
        throw e;
      }
    },
    staleTime: 60_000,
  });
  const me = q.data ?? null;
  const perms = new Set(me?.permissions ?? []);
  return (
    <Ctx.Provider value={{ me, loading: q.isLoading, offline: !!(q.data as { offline?: boolean } | null)?.offline, can: (p) => perms.has(p), refresh: async () => { await qc.invalidateQueries(); } }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
