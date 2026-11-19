/**
 * Small helpers for the SQLite storage contract.
 *
 * SQLite has no native JSON/boolean/array types, so the DAOs store JSON text
 * in `TEXT` columns and 0/1 in `INTEGER` columns. These helpers keep the
 * (de)serialisation rules in one place so every DAO is consistent.
 */

/** Parse a `TEXT` column that holds JSON; fall back when the value is empty/broken. */
export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Parse a JSON array column, tolerating legacy rows that stored a scalar. */
export function parseJsonArrayColumn<T = string>(raw: string | null | undefined): T[] {
  const parsed = parseJsonColumn<unknown>(raw, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

/** Serialise a value for a `TEXT` JSON column (`null`/`undefined` become `[]`). */
export function toJsonColumn(value: unknown, fallback: unknown = []): string {
  return JSON.stringify(value === undefined || value === null ? fallback : value);
}

/** SQLite stores booleans as 0/1. */
export function toSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

/** Read a 0/1 column as a boolean. */
export function fromSqliteBoolean(value: number | null | undefined): boolean {
  return value === 1;
}
