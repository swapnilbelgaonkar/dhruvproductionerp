import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { AppError } from '../lib/errors';

const PG_MAP: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'DUPLICATE', message: 'A record with the same unique value already exists.' },
  '23503': { status: 422, code: 'REFERENCE_INVALID', message: 'A referenced record does not exist or is still in use.' },
  '23514': { status: 400, code: 'VALIDATION_FAILED', message: 'A value failed a database check.' },
};

export function errorHandler(log: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const traceId = req.requestId;
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, traceId } });
    }
    const pgErr = err as { code?: string; message?: string; constraint?: string; detail?: string };
    if (pgErr.code && PG_MAP[pgErr.code]) {
      const m = PG_MAP[pgErr.code]!;
      return res.status(m.status).json({ error: { code: m.code, message: m.message, details: { constraint: pgErr.constraint }, traceId } });
    }
    if (pgErr.code === 'P0001' && pgErr.message?.startsWith('STATUS_CHANGE_FORBIDDEN')) {
      return res.status(422).json({ error: { code: 'INVALID_STATE_TRANSITION', message: 'Status can only change through the workflow.', traceId } });
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body.', traceId } });
    }
    log.error({ err, traceId }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error. Quote the trace ID to support.', traceId } });
  };
}
