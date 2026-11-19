/**
 * Shared domain primitives for the persistence layer.
 *
 * These mirror `@agentmesh/protocol` where a wire-level counterpart exists
 * (event types, task lifecycle) so the server can move values between the
 * protocol and the database without translation tables.
 */

/**
 * Every business table carries a `workspace_id` column with this default.
 * The MVP runs a single workspace and never filters on it explicitly, but the
 * schema and indexes are already multi-tenant ready.
 */
export const DEFAULT_WORKSPACE_ID = 'default';

/**
 * Account roles (US-005 enforces the authorisation rules).
 *
 * Re-exported from `@agentmesh/protocol` so the wire contract and the DB
 * column cannot drift apart.
 */
export type { AccountRole } from '@agentmesh/protocol';

/** Task lifecycle states (US-008 owns the transition table). */
export const TASK_STATUSES = [
  'draft',
  'open',
  'bidding',
  'awarded',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Free-form JSON object stored in `meta`-style columns. */
export type JsonRecord = Record<string, unknown>;

/** Values accepted as SQL positional parameters. */
export type SqlValue = string | number | bigint | null | Uint8Array;
