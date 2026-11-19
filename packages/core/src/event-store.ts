/**
 * `EventStore` — the write/read facade over the append-only `events` table.
 *
 * Responsibility split:
 *  - `@agentmesh/store` owns the table, the global `seq` (SQLite
 *    AUTOINCREMENT) and the typed `EventsDao`;
 *  - this class adds event-sourcing semantics: automatic per-aggregate
 *    `version`, optional `prevHash` hash-chain links, ordered batch appends
 *    and envelope-shaped reads.
 *
 * `seq` is assigned by the database, so it is global, strictly increasing and
 * never reused across aggregates — the same space clients use for resume and
 * dedupe. It is never accepted from callers.
 */

import type { EventType } from '@agentmesh/protocol';
import {
  EventsDao,
  withTransaction,
  type AgentMeshDatabase,
  type StoredEvent,
  DEFAULT_WORKSPACE_ID,
} from '@agentmesh/store';

import {
  type AppendEventRequest,
  type CoreEvent,
  hashEvent,
  toCoreEvent,
} from './envelope.js';

export interface EventStoreOptions {
  /** Workspace used when a request does not name one (default `default`). */
  workspaceId?: string;
  /** Injectable clock, so tests can produce deterministic timestamps. */
  clock?: () => number;
  /**
   * Write `prevHash` links (default true). Disable for fixtures that must look
   * like legacy rows; verification is never automatic either way.
   */
  hashChain?: boolean;
}

export interface LoadAggregateOptions {
  workspaceId?: string;
  /** Only events whose aggregate version is >= this value. */
  fromVersion?: number;
  limit?: number;
}

export interface ReadEventsOptions {
  workspaceId?: string;
  /** Inclusive upper bound on the global seq. */
  toSeq?: number;
  aggregateId?: string;
  limit?: number;
}

export class EventStore {
  private readonly events: EventsDao;
  private readonly workspaceId: string;
  private readonly clock: () => number;
  private readonly hashChain: boolean;

  constructor(
    private readonly db: AgentMeshDatabase,
    options: EventStoreOptions = {},
    events?: EventsDao,
  ) {
    this.events = events ?? new EventsDao(db);
    this.workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.clock = options.clock ?? (() => Date.now());
    this.hashChain = options.hashChain ?? true;
  }

  // ------------------------------------------------------------------ writes

  /**
   * Append one event. `version` defaults to the aggregate's latest version + 1
   * (starting at 1), and `prevHash` defaults to the hash of the current log
   * head, forming a hash chain across the whole workspace.
   *
   * The read of the current head and the insert happen in one `IMMEDIATE`
   * transaction. Callers that already opened a transaction keep it (the read
   * is then protected by their write lock); standalone callers get one here so
   * two writers cannot compute the same version/`prevHash` concurrently.
   */
  append<T = unknown>(request: AppendEventRequest<T>): CoreEvent<T> {
    if (this.db.inTransaction) {
      return this.#appendLocked(request);
    }
    return withTransaction(this.db, () => this.#appendLocked(request));
  }

  #appendLocked<T = unknown>(request: AppendEventRequest<T>): CoreEvent<T> {
    const workspaceId = request.workspaceId ?? this.workspaceId;
    const version = request.version ?? this.nextVersion(request.aggregateId, workspaceId);
    const prevHash =
      request.prevHash !== undefined
        ? (request.prevHash ?? undefined)
        : this.hashChain
          ? this.headHash(workspaceId)
          : undefined;

    const stored = this.events.append({
      aggregateId: request.aggregateId,
      type: request.type,
      version,
      payload: request.payload,
      ts: request.ts ?? this.clock(),
      prevHash: prevHash ?? null,
      workspaceId,
    });
    return toCoreEvent(stored);
  }

  /** Append several events atomically (one seq each, all or nothing). */
  appendMany<T = unknown>(requests: ReadonlyArray<AppendEventRequest<T>>): Array<CoreEvent<T>> {
    return withTransaction(this.db, () =>
      requests.map((request) => this.#appendLocked(request)),
    );
  }

  // ------------------------------------------------------------------- reads

  /** Full ordered history of one aggregate, oldest first. */
  loadAggregate(aggregateId: string, options: LoadAggregateOptions = {}): CoreEvent[] {
    return this.events
      .listByAggregate(aggregateId, {
        workspaceId: options.workspaceId ?? this.workspaceId,
        fromVersion: options.fromVersion,
        limit: options.limit,
      })
      .map((stored) => toCoreEvent(stored));
  }

  /** Aggregate version after its newest event (0 when it has no events). */
  aggregateVersion(aggregateId: string, workspaceId: string = this.workspaceId): number {
    return this.events.latestForAggregate(aggregateId, workspaceId)?.version ?? 0;
  }

  hasAggregate(aggregateId: string, workspaceId: string = this.workspaceId): boolean {
    return this.events.latestForAggregate(aggregateId, workspaceId) !== undefined;
  }

  /** Events with `seq >= fromSeq` (inclusive), oldest first. */
  readFrom(fromSeq: number, options: ReadEventsOptions = {}): CoreEvent[] {
    return this.events
      .list({
        workspaceId: options.workspaceId ?? this.workspaceId,
        fromSeq,
        toSeq: options.toSeq,
        aggregateId: options.aggregateId,
        limit: options.limit,
      })
      .map((stored) => toCoreEvent(stored));
  }

  /** Events with `seq > afterSeq` — the resume/gap-fill primitive. */
  readAfter(afterSeq: number, limit?: number, workspaceId: string = this.workspaceId): CoreEvent[] {
    return this.events
      .listSince(afterSeq, limit, workspaceId)
      .map((stored) => toCoreEvent(stored));
  }

  /** Current high-water mark of the global seq space (0 when empty). */
  head(workspaceId: string = this.workspaceId): number {
    return this.events.head(workspaceId);
  }

  /** Newest event in the log, if any. */
  latest(workspaceId: string = this.workspaceId): CoreEvent | undefined {
    const head = this.events.head(workspaceId);
    if (head === 0) {
      return undefined;
    }
    const stored = this.events.get(head, workspaceId);
    return stored ? toCoreEvent(stored) : undefined;
  }

  count(workspaceId: string = this.workspaceId): number {
    return this.events.count({ workspaceId });
  }

  /** Escape hatch for callers that need the raw DAO (e.g. projections). */
  get dao(): EventsDao {
    return this.events;
  }

  // ---------------------------------------------------------------- internal

  private nextVersion(aggregateId: string, workspaceId: string): number {
    const latest: StoredEvent | undefined = this.events.latestForAggregate(
      aggregateId,
      workspaceId,
    );
    return (latest?.version ?? 0) + 1;
  }

  /** Hash of the current tail of the workspace log (hash-chain link). */
  private headHash(workspaceId: string): string | undefined {
    const head = this.events.head(workspaceId);
    if (head === 0) {
      return undefined;
    }
    const previous: StoredEvent | undefined = this.events.get(head, workspaceId);
    return previous ? hashEvent(previous) : undefined;
  }
}

/** Convenience: build an {@link EventStore} with its own `EventsDao`. */
export function createEventStore(
  db: AgentMeshDatabase,
  options: EventStoreOptions = {},
): EventStore {
  return new EventStore(db, options);
}

/** Type guard used by projections/consumers that switch on event type. */
export function isEventOfType<T extends EventType>(
  event: CoreEvent,
  type: T,
): event is CoreEvent & { type: T } {
  return event.type === type;
}
