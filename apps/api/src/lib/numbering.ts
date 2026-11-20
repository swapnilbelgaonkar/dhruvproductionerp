import type { Tx } from '../db/pool';
import { AppError } from './errors';

/** Indian financial year label for a date, e.g. 2026-11-18 -> "2026-27". */
export function financialYear(d: Date): string {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Allocates the next document number under a row lock. Format: PREFIX/FY/000001 (or PREFIX/SCOPE/FY/…). */
export async function nextDocNo(tx: Tx, docType: string, opts: { scopeKey?: string; date?: Date } = {}): Promise<string> {
  const scopeKey = opts.scopeKey ?? 'GLOBAL';
  const fy = financialYear(opts.date ?? new Date());
  const fmt = await tx.query<{ prefix: string; padding: number }>(
    `select prefix, padding from sys.number_series_formats where doc_type = $1`, [docType]);
  const f = fmt.rows[0];
  if (!f) throw new AppError(500, 'NUMBER_SERIES_MISSING', `No number series format for ${docType}`);
  const r = await tx.query<{ value: number }>(
    `insert into sys.number_series (doc_type, scope_key, fy, next_value) values ($1,$2,$3,2)
     on conflict (doc_type, scope_key, fy) do update set next_value = sys.number_series.next_value + 1
     returning next_value - 1 as value`,
    [docType, scopeKey, fy],
  );
  const n = String(r.rows[0]!.value).padStart(f.padding, '0');
  return scopeKey === 'GLOBAL' ? `${f.prefix}/${fy}/${n}` : `${f.prefix}/${scopeKey}/${fy}/${n}`;
}

/** Master codes in the BRD style PREFIX-YYYY-0001 (YYYY = financial-year start), e.g. DLR-2026-0001 (BRD p.8). */
export async function nextMasterCode(tx: Tx, docType: string, date = new Date()): Promise<string> {
  const fmt = (await tx.query<{ prefix: string; padding: number }>(`select prefix, padding from sys.number_series_formats where doc_type = $1`, [docType])).rows[0];
  if (!fmt) throw new AppError(500, 'NUMBER_SERIES_MISSING', `No number series format for ${docType}`);
  const fy = financialYear(date);
  const r = await tx.query<{ value: number }>(
    `insert into sys.number_series (doc_type, scope_key, fy, next_value) values ($1,'CODE',$2,2)
     on conflict (doc_type, scope_key, fy) do update set next_value = sys.number_series.next_value + 1 returning next_value - 1 as value`,
    [docType, fy]);
  return `${fmt.prefix}-${fy.slice(0, 4)}-${String(r.rows[0]!.value).padStart(fmt.padding, '0')}`;
}
