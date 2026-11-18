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
        const notes = e.aggregate_type === 'wf.approval' ? await approvalNotes(client, e) : [];
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
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { while ((await relayOutbox(db)) > 0); } catch (e) { onError(e); } finally { running = false; }
  }, intervalMs);
  return () => clearInterval(timer);
}
