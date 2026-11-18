import { Router } from 'express';
import type { Db } from '../../db/pool';
import { asyncHandler } from '../../lib/http';

export function notificationRoutes(db: Db) {
  const r = Router();
  r.get('/', asyncHandler(async (req, res) => {
    const me = req.auth!.user.id;
    const rows = await db.query(
      `select id, kind, title, body, link, read_at as "readAt", created_at as "createdAt" from sys.notifications
        where user_id = $1 order by created_at desc limit 30`, [me]);
    const unread = await db.query(`select count(*) as n from sys.notifications where user_id = $1 and read_at is null`, [me]);
    res.json({ data: rows.rows, unread: Number(unread.rows[0].n) });
  }));
  r.post('/:id/read', asyncHandler(async (req, res) => {
    await db.query(`update sys.notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2`, [req.params.id, req.auth!.user.id]);
    res.json({ ok: true });
  }));
  r.post('/read-all', asyncHandler(async (req, res) => {
    await db.query(`update sys.notifications set read_at = now() where user_id = $1 and read_at is null`, [req.auth!.user.id]);
    res.json({ ok: true });
  }));
  return r;
}
