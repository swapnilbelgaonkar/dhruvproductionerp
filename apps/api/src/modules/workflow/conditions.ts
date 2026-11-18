import type { PolicyCondition, PolicyDefinition } from '@dhruv/contracts';

export function evaluate(c: PolicyCondition | undefined, facts: Record<string, unknown>): boolean {
  if (!c) return true;
  if (c.all) return c.all.every((x) => evaluate(x, facts));
  if (c.any) return c.any.some((x) => evaluate(x, facts));
  if (!c.fact || !c.op) return true;
  const v = facts[c.fact];
  const n = (x: unknown) => Number(x);
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'gt': return n(v) > n(c.value);
    case 'gte': return n(v) >= n(c.value);
    case 'lt': return n(v) < n(c.value);
    case 'lte': return n(v) <= n(c.value);
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
  }
}

/** First matching rule wins. */
export function selectRule(def: PolicyDefinition, facts: Record<string, unknown>) {
  return def.rules.find((r) => evaluate(r.when, facts)) ?? null;
}
