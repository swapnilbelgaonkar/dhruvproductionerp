import type { Request } from 'express';
import type { Actor } from '../db/pool';
import type { Scope } from '@dhruv/contracts';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  user: { id: string; email: string; fullName: string; status: string; mustChangePassword: boolean; mfaEnabled: boolean; employeeId: string | null };
  mfaSatisfied: boolean;
  mfaRequiredByRole: boolean;
  roles: { code: string; name: string }[];
  /** permission code -> scopes granted through every role that carries it */
  grants: Map<string, Scope[]>;
}


export function actorOf(req: Request): Actor {
  return {
    userId: req.auth?.user.id ?? null,
    label: req.auth ? req.auth.user.email : 'anonymous',
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
    requestId: req.requestId,
  };
}

export function can(req: Request, permission: string): boolean {
  return !!req.auth?.grants.has(permission);
}

/** Legal entities the user may see for a permission. null = unrestricted. */
export function legalEntityScope(req: Request, permission: string): string[] | null {
  const scopes = req.auth?.grants.get(permission) ?? [];
  if (scopes.some((s) => 'all' in s)) return null;
  return [...new Set(scopes.flatMap((s) => ('legalEntityIds' in s ? s.legalEntityIds : [])))];
}

export function inLegalEntityScope(req: Request, permission: string, legalEntityId: string | null): boolean {
  const scope = legalEntityScope(req, permission);
  return scope === null || (legalEntityId !== null && scope.includes(legalEntityId));
}
