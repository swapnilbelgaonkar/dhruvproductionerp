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
  // A grant restricts legal entities only when it lists at least one; territory-scoped sales grants list none.
  if (scopes.some((s) => 'all' in s || s.legalEntityIds.length === 0)) return null;
  return [...new Set(scopes.flatMap((s) => ('legalEntityIds' in s ? s.legalEntityIds : [])))];
}

export function inLegalEntityScope(req: Request, permission: string, legalEntityId: string | null): boolean {
  const scope = legalEntityScope(req, permission);
  return scope === null || (legalEntityId !== null && scope.includes(legalEntityId));
}

/**
 * Territories the user may see for a permission (MP §4.5 row-level scope). null = unrestricted.
 * Union of territoryIds in the user's scoped grants plus the territory of their own employee record;
 * callers match a record's territory against these as a subtree (ltree <@).
 */
export async function territoryScope(db: { query: (sql: string, args: unknown[]) => Promise<{ rows: { territory_id: string | null }[] }> }, req: Request, permission: string): Promise<string[] | null> {
  const scopes = req.auth?.grants.get(permission) ?? [];
  if (scopes.some((s) => 'all' in s)) return null;
  const ids = new Set(scopes.flatMap((s) => ('territoryIds' in s ? s.territoryIds : [])));
  if (req.auth?.user.employeeId) {
    const own = (await db.query(`select territory_id from org.employees where id = $1`, [req.auth.user.employeeId])).rows[0];
    if (own?.territory_id) ids.add(own.territory_id);
  }
  return [...ids];
}
