/**
 * Defensive readers for event payloads.
 *
 * `@agentmesh/protocol` types notification payloads with zod, but domain-only
 * events (e.g. `task.published`) only exist in the log, and historical rows may
 * pre-date a field. Reducers therefore read fields tolerantly instead of
 * trusting `any`: a missing/garbled field degrades to `undefined` and the
 * reducer keeps going, so replay never dies on old data.
 */

export type PayloadRecord = Record<string, unknown>;

export function asRecord(value: unknown): PayloadRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as PayloadRecord)
    : {};
}

export function readString(source: PayloadRecord, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNumber(source: PayloadRecord, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(source: PayloadRecord, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function readStringArray(source: PayloadRecord, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** Read one of a fixed set of literals (e.g. a status or role). */
export function readOneOf<T extends string>(
  source: PayloadRecord,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = source[key];
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
