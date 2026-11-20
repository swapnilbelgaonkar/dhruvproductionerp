import type { Db, Tx } from '../../db/pool';

interface OutboxRow { id: string; aggregate_type: string; aggregate_id: string; event_type: string; payload: Record<string, unknown> }
type Note = { userId: string; kind: 'action' | 'info' | 'success' | 'warning'; title: string; body: string; link: string };

async function approvalNotes(tx: Tx, e: OutboxRow): Promise<Note[]> {
  const a = (await tx.query(`select id, doc_no, subject_label, status, initiated_by from wf.approval_requests where id = $1`, [e.aggregate_id])).rows[0];
  if (!a) return [];
  const link = `/approvals/${a.id}`;
  const users = (e.payload.userIds as string[] | undefined) ?? [];
  switch (e.event_type) {
    case 'approval.step_assigned':
      return users.map((u) => ({ userId: u, kind: 'action', title: `Approval needed — ${a.doc_no}`, body: a.subject_label, link }));
    case 'approval.notified':
      return users.map((u) => ({ userId: u, kind: 'info', title: `For your information — ${a.doc_no}`, body: `${a.subject_label} (you were passed over in the approval route)`, link }));
    case 'approval.approve':
      return a.status === 'Approved' ? [{ userId: a.initiated_by, kind: 'success', title: `Approved — ${a.doc_no}`, body: a.subject_label, link }] : [];
    case 'approval.reject':
      return [{ userId: a.initiated_by, kind: 'warning', title: `Rejected — ${a.doc_no}`, body: a.subject_label, link }];
    case 'approval.return':
      return [{ userId: a.initiated_by, kind: 'warning', title: `Returned for correction — ${a.doc_no}`, body: a.subject_label, link }];
    case 'approval.hold':
      return [{ userId: a.initiated_by, kind: 'info', title: `Put on hold — ${a.doc_no}`, body: a.subject_label, link }];
    default:
      return [];
  }
}

async function leadNotes(tx: Tx, e: OutboxRow): Promise<Note[]> {
  if (e.event_type !== 'crm.lead_assigned') return [];
  const l = (await tx.query(
    `select l.id, l.code, l.company, u.id as user_id from sales.leads l join iam.users u on u.employee_id = l.owner_id and u.status = 'Active' where l.id = $1`,
    [e.aggregate_id])).rows[0];
  return l ? [{ userId: l.user_id, kind: 'action', title: `New lead assigned — ${l.code}`, body: l.company, link: `/sales/leads/${l.id}` }] : [];
}

/**
 * Transactional-outbox relay (PLT-004): reads committed events and turns them into in-app notifications.
 * Safe to run on several instances (SKIP LOCKED) and to retry (unique dedupe key per user and event).
 */
export async function relayOutbox(db: Db, batch = 100): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const rows = (await client.query<OutboxRow>(
      `select id, aggregate_type, aggregate_id, event_type, payload from sys.outbox_events
        where published_at is null order by created_at limit $1 for update skip locked`, [batch])).rows;
    for (const e of rows) {
      try {
        await client.query('savepoint ev');
        const notes = e.aggregate_type === 'wf.approval' ? await approvalNotes(client, e) : e.aggregate_type === 'crm.lead' ? await leadNotes(client, e) : [];
        for (const n of notes) {
          await client.query(
            `insert into sys.notifications (user_id, kind, title, body, link, dedupe_key) values ($1,$2,$3,$4,$5,$6)
             on conflict (user_id, dedupe_key) do nothing`, [n.userId, n.kind, n.title, n.body, n.link, e.id]);
        }
        await client.query(`update sys.outbox_events set published_at = now(), attempts = attempts + 1 where id = $1`, [e.id]);
        await client.query('release savepoint ev');
      } catch (err) {
        await client.query('rollback to savepoint ev');
        await client.query(`update sys.outbox_events set attempts = attempts + 1, last_error = $2 where id = $1`, [e.id, (err as Error).message.slice(0, 500)]);
      }
    }
    await client.query('commit');
    return rows.length;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function startRelay(db: Db, intervalMs = 2000, onError: (e: unknown) => void = console.error) {
  let running = false;
  const scan = () => scanLicenceExpiry(db).catch(onError);
  const daily = setInterval(scan, 3_600_000); // hourly check; each alert is sent once
  void scan();
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { while ((await relayOutbox(db)) > 0); } catch (e) { onError(e); } finally { running = false; }
  }, intervalMs);
  return () => { clearInterval(timer); clearInterval(daily); };
}

/**
 * Licence expiry alerts (DLR-008, BRD p.8/p.19): notifies the dealer's sales owner and the document verifiers
 * when a licence reaches each configured threshold (default 60 and 30 days) and when it expires. Each alert is sent once.
 */
export async function scanLicenceExpiry(db: Db): Promise<number> {
  const thresholds = ((await db.query(`select value from sys.settings where key = 'licence.alertDays'`)).rows[0]?.value as number[] | undefined) ?? [60, 30];
  const rows = (await db.query(
    `select l.id, l.licence_type, l.number, l.valid_to, (l.valid_to - current_date) as days_left, p.id as party_id, p.code, p.legal_name, ou.id as owner_user
       from mdm.party_licences l join mdm.parties p on p.id = l.party_id join mdm.dealer_profiles dp on dp.party_id = p.id
       left join iam.users ou on ou.employee_id = dp.sales_owner_id and ou.status = 'Active'
      where l.status = 'Active' and dp.status in ('Active','Suspended','Submitted') and l.valid_to - current_date <= $1`, [Math.max(...thresholds)])).rows;
  if (!rows.length) return 0;
  const verifiers = (await db.query(
    `select distinct u.id from iam.user_roles ur join iam.roles r on r.id = ur.role_id join iam.users u on u.id = ur.user_id
      where r.code = 'DOC_VERIFIER' and ur.status = 'Active' and u.status = 'Active'`)).rows.map((x) => x.id as string);
  let n = 0;
  for (const l of rows) {
    const days = Number(l.days_left);
    const bucket = days < 0 ? 'expired' : String([...thresholds].sort((a, b) => a - b).find((t) => days <= t));
    const title = days < 0 ? `Licence expired — ${l.code}` : `Licence expires in ${days} days — ${l.code}`;
    const body = `${l.legal_name}: ${String(l.licence_type).toLowerCase()} licence ${l.number}${days < 0 ? ' — billing for these products is blocked' : ''}`;
    for (const userId of new Set([l.owner_user, ...verifiers].filter(Boolean) as string[])) {
      const ins = await db.query(
        `insert into sys.notifications (user_id, kind, title, body, link, dedupe_key) values ($1,'warning',$2,$3,$4,$5) on conflict (user_id, dedupe_key) do nothing`,
        [userId, title, body, `/sales/dealers/${l.party_id}`, `licence:${l.id}:${bucket}`]);
      n += ins.rowCount ?? 0;
    }
  }
  return n;
}
