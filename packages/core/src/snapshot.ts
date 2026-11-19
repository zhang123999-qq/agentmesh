/**
 * Aggregate snapshots — periodic checkpoints of a reducer's state.
 *
 * A snapshot is *derived* data: it stores `{aggregateId, version, seq, state}`
 * and lets replay start from the checkpoint and apply only the events with
 * `seq > snapshot.seq`. Snapshots can always be dropped and rebuilt from the
 * event log, which is why the DAO upserts on `(aggregate_id, version)`.
 */

import {
  DEFAULT_WORKSPACE_ID,
  SnapshotsDao,
  type AgentMeshDatabase,
  type SnapshotRecord,
} from '@agentmesh/store';

/** In-memory shape handed to/from the store (no workspace column). */
export interface Snapshot<S = unknown> {
  aggregateId: string;
  /** Aggregate version covered by `state`. */
  version: number;
  /** Global seq of the last event folded into `state`. */
  seq: number;
  state: S;
  /** Milliseconds since epoch. */
  ts: number;
}

export function toSnapshot<S>(record: SnapshotRecord<S>): Snapshot<S> {
  return {
    aggregateId: record.aggregateId,
    version: record.version,
    seq: record.seq,
    state: record.state,
    ts: record.ts,
  };
}

export interface SnapshotStoreOptions {
  workspaceId?: string;
}

/** Typed facade over the `snapshots` table (migration v2). */
export class SnapshotStore {
  private readonly dao: SnapshotsDao;
  private readonly workspaceId: string;

  constructor(db: AgentMeshDatabase, options: SnapshotStoreOptions = {}, dao?: SnapshotsDao) {
    this.dao = dao ?? new SnapshotsDao(db);
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  }

  /** Persist a checkpoint (upsert on aggregate + version). */
  save<S>(snapshot: Snapshot<S>): Snapshot<S> {
    return toSnapshot(
      this.dao.save({
        aggregateId: snapshot.aggregateId,
        version: snapshot.version,
        seq: snapshot.seq,
        state: snapshot.state,
        ts: snapshot.ts,
        workspaceId: this.workspaceId,
      }),
    );
  }

  /** Highest-version checkpoint for an aggregate. */
  latest<S = unknown>(aggregateId: string): Snapshot<S> | undefined {
    const record = this.dao.latest<S>(aggregateId, this.workspaceId);
    return record ? toSnapshot(record) : undefined;
  }

  get<S = unknown>(aggregateId: string, version: number): Snapshot<S> | undefined {
    const record = this.dao.get<S>(aggregateId, version, this.workspaceId);
    return record ? toSnapshot(record) : undefined;
  }

  /** Newest first. */
  list<S = unknown>(aggregateId: string, options: { limit?: number } = {}): Array<Snapshot<S>> {
    return this.dao
      .list<S>(aggregateId, { limit: options.limit, workspaceId: this.workspaceId })
      .map((record) => toSnapshot(record));
  }

  /** Keep only the newest `keep` checkpoints; returns rows deleted. */
  prune(aggregateId: string, keep = 1): number {
    return this.dao.prune(aggregateId, keep, this.workspaceId);
  }

  count(aggregateId?: string): number {
    return this.dao.count(aggregateId, this.workspaceId);
  }
}

export interface SnapshotterOptions {
  /**
   * Take a checkpoint every N applied aggregate versions. Default 50; tests use
   * small values to exercise the cadence deterministically.
   */
  everyNEvents?: number;
  clock?: () => number;
}

export interface TakeSnapshotInput<S> {
  aggregateId: string;
  state: S;
  /** Version covered by `state` (normally the last applied event's version). */
  version: number;
  /** Global seq covered by `state`. */
  seq: number;
}

/**
 * Periodic snapshot policy. `maybeTake` is the hot path called after applying
 * events: it is a no-op until `everyNEvents` new versions have accumulated
 * since the newest checkpoint, so the caller can invoke it unconditionally.
 */
export class Snapshotter {
  private readonly everyNEvents: number;
  private readonly clock: () => number;

  constructor(
    private readonly snapshots: SnapshotStore,
    options: SnapshotterOptions = {},
  ) {
    this.everyNEvents = Math.max(1, options.everyNEvents ?? 50);
    this.clock = options.clock ?? (() => Date.now());
  }

  /** Always persist a checkpoint at the given state/version/seq. */
  take<S>(input: TakeSnapshotInput<S>): Snapshot<S> {
    return this.snapshots.save({
      aggregateId: input.aggregateId,
      version: input.version,
      seq: input.seq,
      state: input.state,
      ts: this.clock(),
    });
  }

  /**
   * Persist a checkpoint only when due (>= `everyNEvents` versions since the
   * newest snapshot). Returns `null` when skipped.
   */
  maybeTake<S>(input: TakeSnapshotInput<S>): Snapshot<S> | null {
    if (input.version <= 0) {
      return null;
    }
    const latest = this.snapshots.latest<S>(input.aggregateId);
    const baseVersion = latest?.version ?? 0;
    if (input.version <= baseVersion) {
      return null;
    }
    if (input.version - baseVersion < this.everyNEvents) {
      return null;
    }
    return this.take(input);
  }

  /** Force a checkpoint if the aggregate advanced past its newest snapshot. */
  maybeTakeNow<S>(input: TakeSnapshotInput<S>): Snapshot<S> | null {
    const latest = this.snapshots.latest<S>(input.aggregateId);
    if (input.version <= (latest?.version ?? 0)) {
      return null;
    }
    return this.take(input);
  }
}
