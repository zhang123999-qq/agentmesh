/**
 * Replay: rebuild aggregate state from the log, optionally starting from a
 * snapshot checkpoint.
 *
 * Guarantees exercised by the tests:
 *  - replaying the full history equals folding events live,
 *  - `snapshot + incremental events` equals a full replay.
 */

import type { CoreEvent } from './envelope.js';
import type { EventStore } from './event-store.js';
import { reduceEvents, type Reducer } from './reducer.js';
import type { Snapshot } from './snapshot.js';

export interface ReplayResult<S> {
  state: S;
  /** Aggregate version after the last applied event (snapshot version when none). */
  version: number;
  /** Global seq after the last applied event (snapshot seq when none). */
  lastSeq: number;
  /** Number of events folded by this call. */
  applied: number;
  /** True when a snapshot checkpoint seeded the replay. */
  fromSnapshot: boolean;
}

export interface ReplayOptions<S> {
  /** Start from this checkpoint instead of the beginning of the log. */
  snapshot?: Snapshot<S>;
  workspaceId?: string;
}

/**
 * Fold `events` on top of `snapshot.state`, ignoring any event already covered
 * by `snapshot.seq` (defensive: callers may hand over a wider window).
 */
export function replayFromSnapshot<S>(
  snapshot: Snapshot<S>,
  events: readonly CoreEvent[],
  reducer: Reducer<S>,
): ReplayResult<S> {
  const incremental = events.filter((event) => event.seq > snapshot.seq);
  const state = reduceEvents(incremental, reducer, snapshot.state);
  const last = incremental[incremental.length - 1];
  return {
    state,
    version: last?.version ?? snapshot.version,
    lastSeq: last?.seq ?? snapshot.seq,
    applied: incremental.length,
    fromSnapshot: true,
  };
}

/**
 * Rebuild one aggregate from its event history.
 *
 * With `options.snapshot` the prefix covered by the checkpoint is skipped;
 * without it the whole log (already filtered to the aggregate) is folded.
 */
export function replayAggregate<S>(
  store: EventStore,
  aggregateId: string,
  reducer: Reducer<S>,
  initialState: S,
  options: ReplayOptions<S> = {},
): ReplayResult<S> {
  const events = store.loadAggregate(aggregateId, { workspaceId: options.workspaceId });
  if (options.snapshot) {
    return replayFromSnapshot(options.snapshot, events, reducer);
  }
  const state = reduceEvents(events, reducer, initialState);
  const last = events[events.length - 1];
  return {
    state,
    version: last?.version ?? 0,
    lastSeq: last?.seq ?? 0,
    applied: events.length,
    fromSnapshot: false,
  };
}

/**
 * Rebuild an aggregate from the newest available snapshot, if any.
 * Convenience for services that always want the fastest path.
 */
export function replayAggregateWithLatestSnapshot<S>(
  store: EventStore,
  snapshots: { latest: <T = unknown>(aggregateId: string) => Snapshot<T> | undefined },
  aggregateId: string,
  reducer: Reducer<S>,
  initialState: S,
): ReplayResult<S> {
  const snapshot = snapshots.latest<S>(aggregateId);
  return replayAggregate(store, aggregateId, reducer, initialState, { snapshot });
}
