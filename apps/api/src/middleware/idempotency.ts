import type { NextFunction, Request, Response } from 'express';
import type { Db } from '../db/pool';
import { sha256 } from '../lib/crypto';
import { Errors } from '../lib/errors';

/**
 * Idempotency-Key support (PLT-004, doc 08 §1). When a client sends the header on a POST/PUT:
 *  - first request: processed normally, and the response stored;
 *  - replay with the same body: the stored response is returned, nothing runs twice;
 *  - same key with a different body, or while the first is still running: 409.
 */
export function idempotency(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get('idempotency-key');
    if (!key || !['POST', 'PUT'].includes(req.method) || !req.auth) return next();
    if (key.length > 100) return next(Errors.validation([{ field: 'Idempotency-Key', message: 'Too long' }]));
    try {
      const userId = req.auth.user.id;
      const path = req.originalUrl.split('?')[0]!;
      const hash = sha256(`${req.method} ${req.originalUrl} ${Buffer.isBuffer(req.body) ? sha256(req.body.toString('base64')) : JSON.stringify(req.body ?? {})}`);
      const ins = await db.query(
        `insert into sys.idempotency_keys (user_id, key, method, path, request_hash, status_code) values ($1,$2,$3,$4,$5,0)
         on conflict (user_id, key) do nothing returning key`, [userId, key, req.method, path, hash]);
      if (!ins.rowCount) {
        const prev = (await db.query(`select request_hash, status_code, response from sys.idempotency_keys where user_id = $1 and key = $2`, [userId, key])).rows[0];
        if (!prev || prev.request_hash !== hash) return next(Errors.conflict('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different request.'));
        if (prev.status_code === 0) return next(Errors.conflict('IDEMPOTENCY_IN_PROGRESS', 'The original request is still being processed.'));
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(prev.status_code).json(prev.response);
      }
      const json = res.json.bind(res);
      res.json = (body: unknown) => {
        const status = res.statusCode;
        // keep only definitive outcomes; server errors free the key so the client can retry
        const done = status < 500
          ? db.query(`update sys.idempotency_keys set status_code = $3, response = $4 where user_id = $1 and key = $2`, [userId, key, status, JSON.stringify(body ?? null)])
          : db.query(`delete from sys.idempotency_keys where user_id = $1 and key = $2`, [userId, key]);
        done.catch(() => undefined).finally(() => json(body));
        return res;
      };
      next();
    } catch (e) {
      next(e);
    }
  };
}
