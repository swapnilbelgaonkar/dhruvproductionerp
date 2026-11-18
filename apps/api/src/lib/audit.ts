import type { Actor, Tx } from '../db/pool';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Only the changed keys are stored, to keep the log readable. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return { before, after };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (['updated_at', 'version', 'updated_by'].includes(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

const SENSITIVE = new Set(['password_hash', 'mfa_secret_enc', 'csrf_token']);
function redact(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v ?? null;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SENSITIVE.has(k) ? '[redacted]' : x]));
}

export async function audit(tx: Tx, actor: Actor, e: AuditInput): Promise<void> {
  await tx.query(
    `insert into sys.audit_events (actor_id, actor_label, action, entity_type, entity_id, before, after, reason, ip, user_agent, request_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      actor.userId, actor.label, e.action, e.entityType, e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(redact(e.before)),
      e.after === undefined ? null : JSON.stringify(redact(e.after)),
      e.reason ?? null, actor.ip ?? null, actor.userAgent ?? null, actor.requestId ?? null,
    ],
  );
}

export async function emit(tx: Tx, aggregateType: string, aggregateId: string, eventType: string, payload: unknown = {}) {
  await tx.query(
    `insert into sys.outbox_events (aggregate_type, aggregate_id, event_type, payload) values ($1,$2,$3,$4)`,
    [aggregateType, aggregateId, eventType, JSON.stringify(payload)],
  );
}
