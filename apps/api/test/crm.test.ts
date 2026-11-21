import { describe, expect, it } from 'vitest';
import { bantScore } from '../src/modules/crm/routes';
import { relayOutbox } from '../src/modules/notifications/relay';
import { db, uniq, userAgent } from './helpers';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const mobile = () => `9${String(Math.floor(100000000 + Math.random() * 899999999))}`;

async function setup() {
  const mdo = await userAgent([{ code: 'MASTER_DATA_OWNER' }]);
  const terr = async (parentId: string | null, level: number) =>
    (await mdo.post('/api/v1/territories', { parentId, code: uniq('T'), name: `[TEST] T${level}`, level }).expect(201)).body.id as string;
  const state = await terr(null, 4);
  const taluka = await terr(state, 7);
  const taluka2 = await terr(state, 7);
  const emp = async (tier: string, managerId: string | null, territoryId: string) =>
    (await mdo.post('/api/v1/employees', { empCode: uniq('E'), fullName: `[TEST] ${tier}`, salesTier: tier, managerId, territoryId }).expect(201)).body.id as string;
  const rsmE = await emp('RSM', null, state);
  const seE = await emp('SE', rsmE, taluka);
  const se2E = await emp('SE', rsmE, taluka2);
  const scope = { legalEntityIds: [], plantIds: [], warehouseIds: [], territoryIds: [] };
  return {
    taluka, taluka2, seE, se2E,
    rsm: await userAgent([{ code: 'SALES_RSM', scope }], { employeeId: rsmE }),
    se: await userAgent([{ code: 'SALES_SE', scope }], { employeeId: seE }),
    se2: await userAgent([{ code: 'SALES_SE', scope }], { employeeId: se2E }),
  };
}

async function activeDealer(territoryId: string, ownerId: string) {
  const p = (await db.query(
    `insert into mdm.parties (code, legal_name, constitution, pan, gst_registered, contact_person, mobile) values ($1,$2,'PROPRIETORSHIP','AAAAA0000A',false,'x',$3) returning id`,
    [uniq('DLR-T-'), '[TEST] Active dealer', mobile()])).rows[0].id;
  await db.query(`insert into mdm.dealer_profiles (party_id, dealer_category, territory_id, sales_owner_id, status) values ($1,'DEALER',$2,$3,'Active')`, [p, territoryId, ownerId]);
  return p as string;
}

describe('BANT scoring (CRM-006)', () => {
  it('weights budget, authority, need and timeline', () => {
    const t = new Date('2026-11-20');
    expect(bantScore({ budget: true, authority: true, needScore: 5, timeline: '2027-01-15' }, t)).toBe(100);
    expect(bantScore({ budget: false, authority: true, needScore: 3, timeline: '2027-04-30' }, t)).toBe(55);
    expect(bantScore({ budget: false, authority: false, needScore: 1, timeline: '2028-06-01' }, t)).toBe(5);
  });
});

describe('Lead → opportunity → won/lost (CRM-003…008)', () => {
  it('runs the lifecycle with its controls', async () => {
    const f = await setup();
    const m = mobile();
    const lead = await f.se.post('/api/v1/crm/leads', { company: '[TEST] Sahyadri FPO', contactPerson: 'Chairman', mobile: m, source: 'EXHIBITION',
      sourceDetail: 'Kisan Expo 2026', territoryId: f.taluka, ownerId: f.seE, productInterest: 'Chelated zinc, 2 MT', expectedQty: 2, expectedUom: 'MT' }).expect(201);
    expect(lead.body.code).toMatch(/^LEAD-\d{4}-\d{5}$/);
    const dup = await f.se.post('/api/v1/crm/leads', { company: 'Other', contactPerson: 'x', mobile: m, source: 'OTHER', territoryId: f.taluka, ownerId: f.seE, productInterest: 'x' }).expect(409);
    expect(dup.body.error.code).toBe('DUPLICATE_LEAD');

    // a completed call moves New → Contacted
    await f.se.post('/api/v1/crm/activities', { subjectType: 'lead', subjectId: lead.body.id, kind: 'CALL', title: 'Intro call', plannedAt: inDays(0), done: true, outcome: 'Interested, wants a trial' }).expect(201);
    let l = await f.se.get(`/api/v1/crm/leads/${lead.body.id}`).expect(200);
    expect(l.body.status).toBe('Contacted');
    expect(l.body.activities).toHaveLength(1);

    await f.se.post(`/api/v1/crm/leads/${lead.body.id}/bant`, { budget: false, authority: false, needScore: 2, timeline: inDays(300).slice(0, 10) }).expect(200);
    const low = await f.se.post(`/api/v1/crm/leads/${lead.body.id}/qualify`).expect(422);
    expect(low.body.error.code).toBe('BANT_TOO_LOW');
    const s = await f.se.post(`/api/v1/crm/leads/${lead.body.id}/bant`, { budget: true, authority: true, decisionMaker: 'Chairman', needScore: 4, timeline: inDays(45).slice(0, 10) }).expect(200);
    expect(s.body.score).toBe(95);
    await f.se.post(`/api/v1/crm/leads/${lead.body.id}/qualify`).expect(200);
    const opp = await f.se.post(`/api/v1/crm/leads/${lead.body.id}/convert`, { title: 'Zinc for kharif 2027', value: 480000, expectedClose: inDays(40).slice(0, 10) }).expect(201);
    l = await f.se.get(`/api/v1/crm/leads/${lead.body.id}`).expect(200);
    expect(l.body.status).toBe('Converted');
    expect(l.body.opportunityId).toBe(opp.body.id);

    await f.se.post(`/api/v1/crm/opportunities/${opp.body.id}/stage`, { stage: 'SAMPLE_TRIAL', note: 'Trial on 2 acres' }).expect(200);
    await f.se.post(`/api/v1/crm/opportunities/${opp.body.id}/stage`, { stage: 'LOST' }).expect(400);
    const won = await f.se.post(`/api/v1/crm/opportunities/${opp.body.id}/stage`, { stage: 'WON' }).expect(422);
    expect(won.body.error.code).toBe('DEALER_REQUIRED');
    const dealer = await activeDealer(f.taluka, f.seE);
    const o = await f.se.get(`/api/v1/crm/opportunities/${opp.body.id}`).expect(200);
    expect(o.body.probability).toBe(25);
    await f.se.put(`/api/v1/crm/opportunities/${opp.body.id}`, { title: o.body.title, value: 500000, probability: 60, partyId: dealer, version: o.body.version }).expect(200);
    await f.se.post(`/api/v1/crm/opportunities/${opp.body.id}/stage`, { stage: 'WON', note: 'PO received' }).expect(200);
    const closed = await f.se.get(`/api/v1/crm/opportunities/${opp.body.id}`).expect(200);
    expect(closed.body.stage).toBe('WON');
    expect(closed.body.history.map((h: { toStage: string }) => h.toStage)).toEqual(['WON', 'SAMPLE_TRIAL', 'REQUIREMENT']);
    await f.se.put(`/api/v1/crm/opportunities/${opp.body.id}`, { title: 'x', value: 1, probability: 1, version: closed.body.version }).expect(422);

    await f.se.post(`/api/v1/crm/opportunities/${opp.body.id}/reopen`, { reason: 'x' }).expect(403);
    await f.rsm.post(`/api/v1/crm/opportunities/${opp.body.id}/reopen`, { reason: 'PO cancelled by dealer' }).expect(200);
    await f.rsm.post(`/api/v1/crm/opportunities/${opp.body.id}/stage`, { stage: 'LOST', lossReason: 'COMPETITOR', note: 'Lower price from competitor' }).expect(200);

    const sum = await f.rsm.get('/api/v1/crm/summary').expect(200);
    expect(sum.body.thisMonth.lostCount).toBeGreaterThanOrEqual(1);
  });

  it('restricts leads to territory and lets managers reassign them with a notification', async () => {
    const f = await setup();
    const lead = await f.se.post('/api/v1/crm/leads', { company: '[TEST] Agro Kendra', contactPerson: 'Owner', mobile: mobile(), source: 'FIELD_VISIT',
      territoryId: f.taluka, ownerId: f.seE, productInterest: 'Humate' }).expect(201);
    await f.se2.get(`/api/v1/crm/leads/${lead.body.id}`).expect(404);
    await f.se.post(`/api/v1/crm/leads/${lead.body.id}/transfer`, { ownerId: f.se2E, territoryId: f.taluka2, reason: 'x' }).expect(403);
    await f.rsm.post(`/api/v1/crm/leads/${lead.body.id}/transfer`, { ownerId: f.se2E, territoryId: f.taluka2, reason: 'Belongs to Niphad beat' }).expect(200);
    await f.se2.get(`/api/v1/crm/leads/${lead.body.id}`).expect(200);
    await f.se.get(`/api/v1/crm/leads/${lead.body.id}`).expect(404);
    while ((await relayOutbox(db)) > 0);
    const notes = await f.se2.get('/api/v1/notifications').expect(200);
    expect(notes.body.data.some((n: { title: string }) => n.title.startsWith('New lead assigned'))).toBe(true);
    await f.se2.post(`/api/v1/crm/leads/${lead.body.id}/disqualify`, { reason: 'No requirement this season' }).expect(200);
    await f.se2.post(`/api/v1/crm/activities`, { subjectType: 'lead', subjectId: lead.body.id, kind: 'CALL', title: 'x', plannedAt: inDays(1) }).expect(422);
  });

  it('plans and completes activities with a follow-up; only the owner can complete', async () => {
    const f = await setup();
    const lead = await f.se.post('/api/v1/crm/leads', { company: '[TEST] Follow-up Traders', contactPerson: 'x', mobile: mobile(), source: 'REFERRAL',
      territoryId: f.taluka, ownerId: f.seE, productInterest: 'Micronutrient mix' }).expect(201);
    const act = await f.se.post('/api/v1/crm/activities', { subjectType: 'lead', subjectId: lead.body.id, kind: 'DEALER_VISIT', title: 'Visit shop', plannedAt: inDays(-1) }).expect(201);
    const mine = await f.se.get('/api/v1/crm/activities?view=mine').expect(200);
    expect(mine.body.data.some((a: { id: string }) => a.id === act.body.id)).toBe(true);
    expect((await f.se.get('/api/v1/crm/summary').expect(200)).body.myActivities.overdue).toBeGreaterThanOrEqual(1);
    await f.rsm.post(`/api/v1/crm/activities/${act.body.id}/complete`, { outcome: 'x' }).expect(403);
    await f.se.post(`/api/v1/crm/activities/${act.body.id}/complete`, { outcome: 'Met owner, sample requested',
      nextAction: { kind: 'FOLLOW_UP', title: 'Deliver sample', plannedAt: inDays(3) } }).expect(200);
    const l = await f.se.get(`/api/v1/crm/leads/${lead.body.id}`).expect(200);
    expect(l.body.status).toBe('Contacted');
    expect(l.body.activities.map((a: { status: string }) => a.status).sort()).toEqual(['Done', 'Planned']);
    expect(l.body.followUpAt).toBeTruthy();
  });
});
