import { describe, expect, it } from 'vitest';
import { resolveLadder, type ChainMember, type TierLimit } from '../src/modules/workflow/ladder';
import { db, makeUser, uniq, userAgent } from './helpers';

// BRD p.3–4 limits
const L: [string, number | null, number | null][] = [['BH', null, null], ['NSM', 25, 1_000_000], ['DSM', 20, 750_000], ['ZSM', 15, 500_000],
  ['RSM', 12, 350_000], ['SASM', 10, 250_000], ['ASM', 7, 150_000], ['TSM', 5, 75_000]];
const limits = new Map<string, TierLimit>(L.map(([tier, d, v]) => [tier, { tier, maxDiscountPct: d, maxOrderValue: v, canApprove: true }]));
const m = (tier: string, active = true): ChainMember => ({ employeeId: tier, name: tier, tier, userId: `u-${tier}`, active });
// chain above an SE
const chain = ['TSM', 'ASM', 'SASM', 'RSM', 'ZSM', 'DSM', 'NSM', 'BH'].map((t) => m(t));

describe('D01 hybrid routing — authority ladder (doc 07 §5.1 examples)', () => {
  const route = (amount: number, disc: number, c = chain) => {
    const r = resolveLadder(c, limits, amount, disc);
    return r.ok ? { approver: r.approver.tier, skipped: r.skipped.map((s) => s.tier) } : { approver: null, skipped: r.skipped.map((s) => s.tier) };
  };
  it('₹1,20,000 at 6% → ASM; TSM notified', () => expect(route(120_000, 6)).toEqual({ approver: 'ASM', skipped: ['TSM'] }));
  it('₹4,00,000 at 4% → ZSM (value above RSM)', () => expect(route(400_000, 4).approver).toBe('ZSM'));
  it('₹90,000 at 13% → ZSM (discount above RSM 12%)', () => expect(route(90_000, 13).approver).toBe('ZSM'));
  it('₹12,00,000 → BH (above NSM) — the route the BRD chain lacked (X23)', () => expect(route(1_200_000, 2).approver).toBe('BH'));
  it('₹50,000 at 3% → TSM, nobody skipped', () => expect(route(50_000, 3)).toEqual({ approver: 'TSM', skipped: [] }));
  it('vacant tier is passed over to the next manager', () => {
    const withVacancy = chain.map((x) => (x.tier === 'ASM' ? { ...x, userId: null } : x));
    expect(route(120_000, 6, withVacancy).approver).toBe('SASM');
  });
  it('no authority when the chain has no BH', () => expect(route(5_000_000, 1, chain.slice(0, 7)).approver).toBeNull());
});

describe('Policy simulator over the real hierarchy', () => {
  it('routes a sales order per D01 and warns while limits are inactive (D15)', async () => {
    const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
    const mk = async (tier: string, managerId?: string) => {
      const e = await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: `[TEST] ${tier}`, salesTier: tier, managerId: managerId ?? null }).expect(201);
      const u = await makeUser({ employeeId: e.body.id, name: `[TEST] ${tier} user`, roles: [{ code: `SALES_${tier}` }] });
      return { employeeId: e.body.id as string, userId: u.userId };
    };
    const bh = await mk('BH');
    const nsm = await mk('NSM', bh.employeeId);
    const zsm = await mk('ZSM', nsm.employeeId);
    const rsm = await mk('RSM', zsm.employeeId);
    const asm = await mk('ASM', rsm.employeeId);
    const tsm = await mk('TSM', asm.employeeId);
    const se = await mk('SE', tsm.employeeId);
    await makeUser({ roles: [{ code: 'ACCOUNTS_EXEC' }], name: '[TEST] Accounts' });

    const exec = await userAgent([{ code: 'EXEC_ADMIN' }]);
    const sim = await exec.post('/api/v1/approval-policies/simulate', { docType: 'sales.order', initiatorUserId: se.userId, facts: { amount: 400000, maxDiscountPct: 4 } }).expect(200);
    const approve = sim.body.steps.filter((s: { kind: string }) => s.kind === 'approve');
    expect(approve[0].label).toContain('(ZSM)');
    expect(approve[0].approvers[0].userId).toBe(zsm.userId);
    const notify = sim.body.steps.find((s: { kind: string }) => s.kind === 'notify');
    expect(notify.approvers.map((a: { userId: string }) => a.userId)).toEqual([tsm.userId, asm.userId, rsm.userId]);
    expect(approve[1].label).toContain('Accounts');
    expect(sim.body.warnings.join(' ')).toContain('D15');
    const limitsActive = (await db.query(`select bool_and(active) as a from iam.authority_limits`)).rows[0].a;
    expect(limitsActive).toBe(false);
  });
});
