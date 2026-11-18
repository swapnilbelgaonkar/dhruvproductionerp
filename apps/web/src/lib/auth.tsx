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

const Ctx = createContext<{ me: Me | null; loading: boolean; can: (p: string) => boolean; refresh: () => Promise<void> }>({
  me: null, loading: true, can: () => false, refresh: async () => undefined,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try { return await api<Me>('/me'); } catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
    },
    staleTime: 60_000,
  });
  const me = q.data ?? null;
  const perms = new Set(me?.permissions ?? []);
  return (
    <Ctx.Provider value={{ me, loading: q.isLoading, can: (p) => perms.has(p), refresh: async () => { await qc.invalidateQueries(); } }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
