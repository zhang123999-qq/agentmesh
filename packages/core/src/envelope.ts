/**
 * Event envelope primitives for `@agentmesh/core`.
 *
 * The wire envelope is owned by `@agentmesh/protocol`
 * (`{ seq, aggregateId, type, version, payload, ts, prevHash? }`) and the
 * storage shape by `@agentmesh/store` (`StoredEvent`). This module only adds:
 *
 *  - {@link CoreEvent}: the protocol envelope type used across core,
 *  - {@link AppendEventRequest}: what callers hand to the store (seq/prevHash
 *    are assigned by the store, version defaults to latest + 1),
 *  - aggregate-id helpers (`task:tsk_1` etc.),
 *  - a canonical-JSON SHA-256 hash of an event, used to fill `prevHash`.
 *
 * ## `prevHash` (future hash-chain audit)
 *
 * `prevHash` is written on every append by default: it is the hash of the
 * *previous event in the global log* (i.e. `seq - 1` in the same workspace).
 * Nothing verifies it automatically in the MVP — {@link verifyEventChain} is
 * available for audits and tests, and older rows without a hash stay valid.
 */

import { createHash } from 'node:crypto';

import type { EventEnvelope, EventType } from '@agentmesh/protocol';
import type { StoredEvent } from '@agentmesh/store';

/** The protocol event envelope, re-exported under a core-friendly name. */
export type CoreEvent<T = unknown> = EventEnvelope<T>;

/** Input accepted by {@link EventStore.append}. */
export interface AppendEventRequest<T = unknown> {
  /** Aggregate the event belongs to, e.g. `task:tsk_1`. */
  aggregateId: string;
  type: EventType;
  payload: T;
  /** Aggregate version after this event; defaults to `latestVersion + 1`. */
  version?: number;
  /** Milliseconds since epoch; defaults to the store clock (`Date.now()`). */
  ts?: number;
  /**
   * Explicit hash-chain link. When omitted the store hashes the current head
   * of the log (or leaves it empty when `hashChain: false`).
   */
  prevHash?: string | null;
  workspaceId?: string;
}

// ---------------------------------------------------------------------------
// Aggregate ids
// ---------------------------------------------------------------------------

export const AGGREGATE_KINDS = ['account', 'channel', 'message', 'task'] as const;
export type AggregateKind = (typeof AGGREGATE_KINDS)[number];

export interface ParsedAggregateId {
  kind: AggregateKind;
  id: string;
}

/** `aggregateIdOf('task', 'tsk_1') === 'task:tsk_1'`. */
export function aggregateIdOf(kind: AggregateKind, id: string): string {
  if (id.length === 0) {
    throw new Error(`aggregate id must not be empty (kind=${kind})`);
  }
  return `${kind}:${id}`;
}

export function isAggregateKind(value: string): value is AggregateKind {
  return (AGGREGATE_KINDS as readonly string[]).includes(value);
}

/** Parse `kind:id`; throws when the prefix is unknown or the id is empty. */
export function parseAggregateId(aggregateId: string): ParsedAggregateId {
  const parsed = tryParseAggregateId(aggregateId);
  if (!parsed) {
    throw new Error(
      `invalid aggregateId "${aggregateId}" (expected one of ${AGGREGATE_KINDS.join('|')}:<id>)`,
    );
  }
  return parsed;
}

export function tryParseAggregateId(aggregateId: string): ParsedAggregateId | undefined {
  const index = aggregateId.indexOf(':');
  if (index <= 0) {
    return undefined;
  }
  const kind = aggregateId.slice(0, index);
  const id = aggregateId.slice(index + 1);
  if (id.length === 0 || !isAggregateKind(kind)) {
    return undefined;
  }
  return { kind, id };
}

// ---------------------------------------------------------------------------
// Canonical JSON + hashing
// ---------------------------------------------------------------------------

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted recursively. `JSON.stringify` alone is
 * insertion-order dependent, which would make hashes unstable across writers.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

interface HashableEvent {
  seq: number;
  aggregateId: string;
  type: string;
  version: number;
  ts: number;
  payload: unknown;
  prevHash?: string | null;
}

/**
 * SHA-256 over the canonical form of an event envelope. `prevHash` is
 * normalised to `null` so "absent" and "null" hash identically.
 */
export function hashEvent(event: HashableEvent): string {
  const canonical = canonicalJson({
    seq: event.seq,
    aggregateId: event.aggregateId,
    type: event.type,
    version: event.version,
    ts: event.ts,
    payload: event.payload,
    prevHash: event.prevHash ?? null,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export interface ChainVerification {
  valid: boolean;
  /** Index (0-based) of the first event whose link does not match. */
  brokenAt?: number;
}

/**
 * Verify a log slice forms an unbroken hash chain.
 *
 * Links are only checkable between **globally consecutive** events
 * (`current.seq === previous.seq + 1`), because `prevHash` points at the
 * previous event in the workspace-wide log. Feed it a contiguous window such
 * as `EventStore.readFrom(1)`; an aggregate-scoped slice (`loadAggregate`)
 * legitimately has gaps and its links are simply unverifiable, not broken.
 *
 * Legacy rows without `prevHash` are treated as unverifiable anchors too — the
 * MVP writes but does not enforce the chain.
 */
export function verifyEventChain(events: readonly HashableEvent[]): ChainVerification {
  for (let i = 1; i < events.length; i += 1) {
    const current = events[i];
    const previous = events[i - 1];
    if (!current || !previous) {
      continue;
    }
    if (current.seq !== previous.seq + 1) {
      continue;
    }
    if (current.prevHash === undefined || current.prevHash === null) {
      continue;
    }
    if (current.prevHash !== hashEvent(previous)) {
      return { valid: false, brokenAt: i };
    }
  }
  return { valid: true };
}

/** Details of the first broken link in a hash chain (US-021C). */
export interface ChainMismatch {
  /** seq of the first event whose `prevHash` does not match its predecessor. */
  seq: number;
  aggregateId: string;
  expectedPrevHash: string;
  actualPrevHash: string | null;
}

export interface ChainVerificationDetailed {
  valid: boolean;
  /** Number of events examined. */
  checked: number;
  mismatch?: ChainMismatch;
}

/**
 * Batched hash-chain verification (US-021C) — never holds the whole log in
 * memory. `loadBatch(afterSeq, limit)` must return the next events with
 * `seq > afterSeq` in ascending seq order (e.g. `EventStore.readAfter`).
 *
 * The returned `mismatch` identifies the first broken link by `seq` and
 * `aggregateId` (not just an array index), so an operator can locate and repair
 * the offending row. Links are only checked between globally consecutive events
 * and where `prevHash` is present, mirroring {@link verifyEventChain}.
 */
export function verifyEventChainBatched(
  loadBatch: (afterSeq: number, limit: number) => readonly HashableEvent[],
  options: { batchSize?: number } = {},
): ChainVerificationDetailed {
  const batchSize = Math.max(1, options.batchSize ?? 1000);
  let previous: HashableEvent | undefined;
  let afterSeq = 0;
  let checked = 0;

  for (;;) {
    const batch = loadBatch(afterSeq, batchSize);
    if (batch.length === 0) break;

    for (const current of batch) {
      checked += 1;
      if (
        previous !== undefined &&
        current.seq === previous.seq + 1 &&
        current.prevHash !== undefined &&
        current.prevHash !== null
      ) {
        const expectedPrevHash = hashEvent(previous);
        if (current.prevHash !== expectedPrevHash) {
          return {
            valid: false,
            checked,
            mismatch: {
              seq: current.seq,
              aggregateId: current.aggregateId,
              expectedPrevHash,
              actualPrevHash: current.prevHash,
            },
          };
        }
      }
      previous = current;
    }

    const last = batch[batch.length - 1];
    if (last === undefined) break;
    afterSeq = last.seq;
    if (batch.length < batchSize) break;
  }

  return { valid: true, checked };
}

// ---------------------------------------------------------------------------
// Mapping from the persistence row to the envelope
// ---------------------------------------------------------------------------

/** Drop storage-only columns (`workspaceId`) and normalise `null` prevHash. */
export function toCoreEvent<T>(stored: StoredEvent<T>): CoreEvent<T> {
  const event: CoreEvent<T> = {
    seq: stored.seq,
    aggregateId: stored.aggregateId,
    type: stored.type,
    version: stored.version,
    payload: stored.payload,
    ts: stored.ts,
  };
  if (stored.prevHash !== null) {
    event.prevHash = stored.prevHash;
  }
  return event;
}
