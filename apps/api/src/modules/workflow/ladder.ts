/** D01 (approved 18 Nov 2026): hybrid routing over the nine-tier hierarchy. Pure function so it is unit-testable. */
export interface TierLimit { tier: string; maxDiscountPct: number | null; maxOrderValue: number | null; canApprove: boolean }
export interface ChainMember { employeeId: string; name: string; tier: string | null; userId: string | null; active: boolean }

export type LadderResult =
  | { ok: true; approver: ChainMember; skipped: ChainMember[]; vacant: ChainMember[] }
  | { ok: false; reason: 'NO_AUTHORITY'; skipped: ChainMember[]; vacant: ChainMember[] };

export function covers(limit: TierLimit, amount: number, discountPct: number): boolean {
  return limit.canApprove &&
    (limit.maxOrderValue === null || amount <= limit.maxOrderValue) &&
    (limit.maxDiscountPct === null || discountPct <= limit.maxDiscountPct);
}

/**
 * Walk the initiator's reporting chain upwards (starting with the direct manager — an initiator never approves their own order)
 * and stop at the first manager whose tier covers both the order value and the highest discount.
 * Managers passed over are returned as `skipped` (they receive a notify-only copy). Members without a system user or a sales tier
 * are `vacant` and passed over silently (vacant-tier rule, doc 07 §5.1).
 */
export function resolveLadder(chain: ChainMember[], limits: Map<string, TierLimit>, amount: number, discountPct: number): LadderResult {
  const skipped: ChainMember[] = [];
  const vacant: ChainMember[] = [];
  for (const m of chain) {
    const limit = m.tier ? limits.get(m.tier) : undefined;
    if (!m.active || !m.userId || !limit || !limit.canApprove) { vacant.push(m); continue; }
    if (covers(limit, amount, discountPct)) return { ok: true, approver: m, skipped, vacant };
    skipped.push(m);
  }
  return { ok: false, reason: 'NO_AUTHORITY', skipped, vacant };
}
