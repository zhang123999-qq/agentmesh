import type { EventType, Seq } from '@agentmesh/protocol';

import { afterCommit, withTransaction, type AgentMeshDatabase } from '../db.js';
import { toJsonColumn } from '../json.js';
import { DEFAULT_WORKSPACE_ID, type SqlValue } from '../types.js';

/**
 * One row of the append-only event log.
 *
 * `seq` is the global, monotonically increasing, globally unique cursor shared
 * by every aggregate (see `@agentmesh/protocol`): it is the only resume/dedupe
 * position used by clients.
 */
export interface StoredEvent<T = unknown> {
  /** `events.seq` — global AUTOINCREMENT, never reused. */
  seq: Seq;
  aggregateId: string;
  type: EventType;
  /** Aggregate version after this event (CAS / replay). */
  version: number;
  payload: T;
  /** Milliseconds since epoch. */
  ts: number;
  /** Optional hash-chain link (schema reserved, not verified in MVP). */
  prevHash: string | null;
  workspaceId: string;
}

export interface AppendEventInput<T = unknown> {
  aggregateId: string;
  type: EventType;
  version: number;
  payload: T;
  ts?: number;
  prevHash?: string | null;
  workspaceId?: string;
}

/**
 * Called once per **committed** append, in `seq` order, with the persisted row.
 *
 * This is the hook a transport (the US-006 WS gateway) uses to turn "a new
 * event exists" into a live push. Listeners must be fast and must not throw:
 * the DAO isolates them so a broken subscriber can never fail a write.
 */
export type EventAppendListener = (event: StoredEvent) => void;

export interface ListEventsOptions {
  workspaceId?: string;
  aggregateId?: string;
  type?: EventType;
  /** Inclusive lower bound on the global seq. */
  fromSeq?: number;
  /** Inclusive upper bound on the global seq. */
  toSeq?: number;
  limit?: number;
}

interface EventRow {
  seq: number;
  aggregate_id: string;
  type: string;
  version: number;
  payload: string;
  ts: number;
  prev_hash: string | null;
  workspace_id: string;
}

function mapEvent(row: EventRow): StoredEvent {
  return {
    seq: row.seq,
    aggregateId: row.aggregate_id,
    type: row.type as EventType,
    version: row.version,
    payload: JSON.parse(row.payload) as unknown,
    ts: row.ts,
    prevHash: row.prev_hash,
    workspaceId: row.workspace_id,
  };
}

/**
 * Append-only event log DAO.
 *
 * There is intentionally no `update`/`delete`: the log is immutable, and any
 * "change" is a new event. `seq` is assigned by SQLite (`AUTOINCREMENT`) so the
 * global sequence survives deletes and is never handed out twice.
 */
export class EventsDao {
  /** Append subscribers (live-push wiring). Order of registration is kept. */
  readonly #appendListeners = new Set<EventAppendListener>();

  constructor(private readonly db: AgentMeshDatabase) {}

  /**
   * Observe committed appends (the live-push feed).
   *
   * Every subscriber is called with the row that was really persisted, so the
   * `seq` it broadcasts is the same globally unique cursor a later `resume`
   * would replay. Idempotent per listener; returns an unsubscribe function.
   */
  onAppend(listener: EventAppendListener): () => void {
    this.#appendListeners.add(listener);
    return () => {
      this.#appendListeners.delete(listener);
    };
  }

  /** Deliver one committed event to every subscriber, isolating failures. */
  #emit(event: StoredEvent): void {
    for (const listener of this.#appendListeners) {
      try {
        listener(event);
      } catch {
        // A subscriber bug must never break the append itself.
      }
    }
  }

  append<T = unknown>(input: AppendEventInput<T>): StoredEvent<T> {
    const stored = this.#insert(input);
    // Never announce a row before its enclosing transaction commits. Outside
    // a transaction `afterCommit` invokes the listener synchronously.
    afterCommit(this.db, () => {
      this.#emit(stored);
    });
    return stored;
  }

  /**
   * Append several events atomically, in order (one seq each).
   *
   * Subscribers fire only **after** the transaction commits, so a rollback
   * never announces events that do not exist.
   */
  appendMany<T = unknown>(inputs: ReadonlyArray<AppendEventInput<T>>): Array<StoredEvent<T>> {
    const stored = withTransaction(this.db, () => inputs.map((input) => this.#insert(input)));
    for (const event of stored) {
      // Emits now for a top-level call, or joins the caller's frame when
      // appendMany itself runs inside a larger transaction.
      afterCommit(this.db, () => {
        this.#emit(event);
      });
    }
    return stored;
  }

  /** Persist one row and read it back (no subscriber notification). */
  #insert<T = unknown>(input: AppendEventInput<T>): StoredEvent<T> {
    const params = {
      aggregate_id: input.aggregateId,
      type: input.type,
      version: input.version,
      payload: toJsonColumn(input.payload, {}),
      ts: input.ts ?? Date.now(),
      prev_hash: input.prevHash ?? null,
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    const result = this.db
      .prepare(
        `INSERT INTO events (aggregate_id, type, version, payload, ts, prev_hash, workspace_id)
         VALUES (@aggregate_id, @type, @version, @payload, @ts, @prev_hash, @workspace_id)`,
      )
      .run(params);

    // Read the row back so callers observe exactly what was persisted: the
    // payload column is the `toJsonColumn` normalisation (`undefined` → `{}`,
    // `toJSON` applied), not the caller's raw object. Guarantees
    // `append().payload === get(seq).payload`.
    const seq = Number(result.lastInsertRowid);
    const stored = this.get(seq, params.workspace_id);
    if (stored !== undefined) {
      return stored as StoredEvent<T>;
    }
    // Unreachable in practice (no deletes between insert and read); keep a
    // shape-identical fallback rather than returning undefined.
    return {
      seq,
      aggregateId: params.aggregate_id,
      type: params.type,
      version: params.version,
      payload: JSON.parse(params.payload) as T,
      ts: params.ts,
      prevHash: params.prev_hash,
      workspaceId: params.workspace_id,
    };
  }

  get(seq: number, workspaceId: string = DEFAULT_WORKSPACE_ID): StoredEvent | undefined {
    const row = this.db
      .prepare('SELECT * FROM events WHERE seq = ? AND workspace_id = ?')
      .get(seq, workspaceId) as EventRow | undefined;
    return row ? this.applyPayloadGuard(row) : undefined;
  }

  /** Newest event of an aggregate (used to read the current version). */
  latestForAggregate(
    aggregateId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): StoredEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
          WHERE aggregate_id = ? AND workspace_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(aggregateId, workspaceId) as EventRow | undefined;
    return row ? this.applyPayloadGuard(row) : undefined;
  }

  /** Replay a single aggregate in seq order (optionally from a version). */
  listByAggregate(
    aggregateId: string,
    options: { workspaceId?: string; fromVersion?: number; limit?: number } = {},
  ): StoredEvent[] {
    const where: string[] = ['aggregate_id = ?', 'workspace_id = ?'];
    const params: SqlValue[] = [aggregateId, options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.fromVersion !== undefined) {
      where.push('version >= ?');
      params.push(options.fromVersion);
    }
    let sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map((row) => this.applyPayloadGuard(row));
  }

  /** Window scan used by resume / gap-fill and admin audit (US-006/013). */
  list(options: ListEventsOptions = {}): StoredEvent[] {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.aggregateId !== undefined) {
      where.push('aggregate_id = ?');
      params.push(options.aggregateId);
    }
    if (options.type !== undefined) {
      where.push('type = ?');
      params.push(options.type);
    }
    if (options.fromSeq !== undefined) {
      where.push('seq >= ?');
      params.push(options.fromSeq);
    }
    if (options.toSeq !== undefined) {
      where.push('seq <= ?');
      params.push(options.toSeq);
    }
    let sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as EventRow[];
    return rows.map((row) => this.applyPayloadGuard(row));
  }

  /** Every event with `seq > afterSeq`, oldest first — the resume primitive. */
  listSince(afterSeq: number, limit?: number, workspaceId: string = DEFAULT_WORKSPACE_ID): StoredEvent[] {
    return this.list({ workspaceId, fromSeq: afterSeq + 1, limit });
  }

  /** Current high-water mark of the global seq space (0 when empty). */
  head(workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE workspace_id = ?')
      .get(workspaceId) as { seq: number };
    return row.seq;
  }

  count(options: { workspaceId?: string; aggregateId?: string } = {}): number {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.aggregateId !== undefined) {
      where.push('aggregate_id = ?');
      params.push(options.aggregateId);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events WHERE ${where.join(' AND ')}`)
      .get(...params) as { count: number };
    return row.count;
  }

  /**
   * A single corrupt JSON payload must not take down replay; surface the raw
   * text instead so diagnostics can see exactly what was stored.
   */
  private applyPayloadGuard(row: EventRow): StoredEvent {
    try {
      return mapEvent(row);
    } catch {
      return {
        seq: row.seq,
        aggregateId: row.aggregate_id,
        type: row.type as EventType,
        version: row.version,
        payload: row.payload,
        ts: row.ts,
        prevHash: row.prev_hash,
        workspaceId: row.workspace_id,
      };
    }
  }
}
