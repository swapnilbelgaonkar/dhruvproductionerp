import pg from 'pg';

// numeric -> string (never float) ; bigint count -> number
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

export interface Actor {
  userId: string | null;
  label: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

/** Run fn inside a transaction. All business commands go through this. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Allow status columns to change inside this transaction (see sys.guard_status_change). */
export async function allowTransition(tx: Tx): Promise<void> {
  await tx.query(`select set_config('app.transition', 'on', true)`);
}
