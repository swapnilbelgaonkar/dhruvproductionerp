import type { Db, Tx } from '../db/pool';

export async function getSetting<T>(db: Db | Tx, key: string, fallback: T): Promise<T> {
  const r = await db.query<{ value: T }>(`select value from sys.settings where key = $1`, [key]);
  return r.rows[0] ? r.rows[0].value : fallback;
}
