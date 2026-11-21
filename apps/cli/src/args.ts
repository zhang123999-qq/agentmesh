/**
 * Minimal argument parser for the `agentmesh` CLI.
 *
 * Supports `--flag value`, `--flag=value`, boolean flags, repeatable flags and
 * a few short aliases. Unknown flags are usage errors — a typo must never be
 * silently ignored (it would change which task/version a command acts on).
 */

export type FlagValue = string | boolean | string[];
export type Flags = Readonly<Record<string, FlagValue>>;

export interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: Flags;
}

/** Bad command line (exit code 2, never an RPC error). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const BOOLEAN_FLAGS = new Set([
  'json',
  'help',
  'version',
  'secret-stdin',
  'body-stdin',
]);

const REPEATABLE_FLAGS = new Set(['artifact']);

const SHORT_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  u: 'url',
  t: 'token',
  p: 'profile',
  h: 'help',
});

function setFlag(flags: Record<string, FlagValue>, name: string, value: string | boolean): void {
  const existing = flags[name];
  if (existing === undefined) {
    flags[name] = value;
    return;
  }
  if (REPEATABLE_FLAGS.has(name) && typeof value === 'string') {
    if (Array.isArray(existing)) {
      flags[name] = [...existing, value];
    } else if (typeof existing === 'string') {
      flags[name] = [existing, value];
    } else {
      flags[name] = [value];
    }
    return;
  }
  flags[name] = value;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      if (body.length === 0) throw new UsageError('empty flag name');
      const equals = body.indexOf('=');
      if (equals !== -1) {
        setFlag(flags, body.slice(0, equals), body.slice(equals + 1));
        index += 1;
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        setFlag(flags, body, true);
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError(`flag --${body} requires a value`);
      }
      setFlag(flags, body, next);
      index += 2;
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1);
      const name = SHORT_FLAGS[short];
      if (name === undefined) throw new UsageError(`unknown flag -${short}`);
      if (BOOLEAN_FLAGS.has(name)) {
        setFlag(flags, name, true);
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) {
        throw new UsageError(`flag -${short} requires a value`);
      }
      setFlag(flags, name, next);
      index += 2;
      continue;
    }

    positionals.push(token);
    index += 1;
  }

  return { positionals, flags };
}

/** Single string value of `--name`; arrays (repeated flags) are rejected. */
export function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError(`flag --${name} expects exactly one value`);
  }
  return value;
}

export function requireString(args: ParsedArgs, name: string): string {
  const value = optionalString(args, name);
  if (value === undefined || value.length === 0) {
    throw new UsageError(`missing required flag --${name}`);
  }
  return value;
}

export function booleanFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new UsageError(`flag --${name} is a boolean flag`);
  }
  return value;
}

export function optionalNumber(args: ParsedArgs, name: string): number | undefined {
  const raw = optionalString(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`flag --${name} must be a number (got ${raw})`);
  }
  return value;
}

export function requireNumber(args: ParsedArgs, name: string): number {
  const value = optionalNumber(args, name);
  if (value === undefined) throw new UsageError(`missing required flag --${name}`);
  return value;
}

export function optionalInt(args: ParsedArgs, name: string): number | undefined {
  const value = optionalNumber(args, name);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new UsageError(`flag --${name} must be an integer`);
  return value;
}

export function requireInt(args: ParsedArgs, name: string): number {
  const value = optionalInt(args, name);
  if (value === undefined) throw new UsageError(`missing required flag --${name}`);
  return value;
}

/** `--skills a,b, c` → `['a','b','c']`. */
export function optionalList(args: ParsedArgs, name: string): string[] | undefined {
  const raw = optionalString(args, name);
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length === 0 ? undefined : items;
}

/** Repeatable `--artifact <ref>` values. */
export function optionalRepeated(args: ParsedArgs, name: string): string[] | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : [value];
  const refs = items.filter((item): item is string => typeof item === 'string');
  return refs.length === 0 ? undefined : refs;
}

/**
 * Timestamps accept epoch milliseconds (`1750000000000`) or anything
 * `Date.parse` understands (`2026-11-21T10:00:00Z`).
 */
export function parseWhen(value: string, name: string): number {
  if (/^\d+$/.test(value)) {
    const epoch = Number(value);
    if (!Number.isSafeInteger(epoch)) {
      throw new UsageError(`flag --${name} is not a valid epoch timestamp`);
    }
    return epoch;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new UsageError(
      `flag --${name} must be epoch milliseconds or an ISO date (got ${value})`,
    );
  }
  return parsed;
}
