import type { AgentMeshDatabase } from '../db.js';
import { toJsonColumn } from '../json.js';
import { DEFAULT_WORKSPACE_ID, type SqlValue } from '../types.js';

/**
 * One aggregate checkpoint: the reduced state as of global `seq` / aggregate
 * `version`. The event log stays the source of truth — a snapshot is only a
 * materialised shortcut that lets replay skip the prefix of the log.
 */
export interface SnapshotRecord<T = unknown> {
  aggregateId: string;
  /** Aggregate version covered by this snapshot (`state.version`). */
  version: number;
  /** Global `events.seq` of the last event folded into `state`. */
  seq: number;
  state: T;
  /** Milliseconds since epoch. */
  ts: number;
  workspaceId: string;
}

export interface SaveSnapshotInput<T = unknown> {
  aggregateId: string;
  version: number;
  seq: number;
  state: T;
  ts?: number;
  workspaceId?: string;
}

export interface ListSnapshotsOptions {
  workspaceId?: string;
  /** Max rows, newest version first. */
  limit?: number;
}

interface SnapshotRow {
  aggregate_id: string;
  version: number;
  seq: number;
  state: string;
  ts: number;
  workspace_id: string;
}

function mapSnapshot<T>(row: SnapshotRow): SnapshotRecord<T> {
  return {
    aggregateId: row.aggregate_id,
    version: row.version,
    seq: row.seq,
    state: JSON.parse(row.state) as T,
    ts: row.ts,
    workspaceId: row.workspace_id,
  };
}

/**
 * Typed DAO for the `snapshots` table (migration v2).
 *
 * Snapshots are derived data: they can be dropped and rebuilt from the event
 * log at any time, so `save` behaves as an upsert keyed by
 * `(aggregate_id, version)`.
 */
export class SnapshotsDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  save<T = unknown>(input: SaveSnapshotInput<T>): SnapshotRecord<T> {
    const row: SnapshotRow = {
      aggregate_id: input.aggregateId,
      version: input.version,
      seq: input.seq,
      state: toJsonColumn(input.state, {}),
      ts: input.ts ?? Date.now(),
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT INTO snapshots (aggregate_id, version, seq, state, ts, workspace_id)
         VALUES (@aggregate_id, @version, @seq, @state, @ts, @workspace_id)
         ON CONFLICT(aggregate_id, version) DO UPDATE SET
           seq = excluded.seq,
           state = excluded.state,
           ts = excluded.ts,
           workspace_id = excluded.workspace_id`,
      )
      .run(row);
    return mapSnapshot<T>(row);
  }

  get<T = unknown>(
    aggregateId: string,
    version: number,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): SnapshotRecord<T> | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM snapshots
          WHERE aggregate_id = ? AND version = ? AND workspace_id = ?`,
      )
      .get(aggregateId, version, workspaceId) as SnapshotRow | undefined;
    return row ? mapSnapshot<T>(row) : undefined;
  }

  /** Highest-version snapshot for an aggregate (the replay entry point). */
  latest<T = unknown>(
    aggregateId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): SnapshotRecord<T> | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM snapshots
          WHERE aggregate_id = ? AND workspace_id = ?
          ORDER BY version DESC LIMIT 1`,
      )
      .get(aggregateId, workspaceId) as SnapshotRow | undefined;
    return row ? mapSnapshot<T>(row) : undefined;
  }

  /** Newest first — diagnostics / admin history. */
  list<T = unknown>(
    aggregateId: string,
    options: ListSnapshotsOptions = {},
  ): Array<SnapshotRecord<T>> {
    const params: SqlValue[] = [aggregateId, options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    let sql = `SELECT * FROM snapshots
                WHERE aggregate_id = ? AND workspace_id = ?
                ORDER BY version DESC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as SnapshotRow[];
    return rows.map((row) => mapSnapshot<T>(row));
  }

  /** Keep only the newest `keep` snapshots of an aggregate; returns rows deleted. */
  prune(
    aggregateId: string,
    keep = 1,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): number {
    const survivors = this.db
      .prepare(
        `SELECT version FROM snapshots
          WHERE aggregate_id = ? AND workspace_id = ?
          ORDER BY version DESC LIMIT ?`,
      )
      .all(aggregateId, workspaceId, Math.max(keep, 0)) as Array<{ version: number }>;
    const keepVersions = survivors.map((row) => row.version);
    if (keepVersions.length === 0) {
      const result = this.db
        .prepare('DELETE FROM snapshots WHERE aggregate_id = ? AND workspace_id = ?')
        .run(aggregateId, workspaceId);
      return result.changes;
    }
    const placeholders = keepVersions.map(() => '?').join(', ');
    const result = this.db
      .prepare(
        `DELETE FROM snapshots
          WHERE aggregate_id = ? AND workspace_id = ? AND version NOT IN (${placeholders})`,
      )
      .run(aggregateId, workspaceId, ...keepVersions);
    return result.changes;
  }

  count(aggregateId?: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [workspaceId];
    if (aggregateId !== undefined) {
      where.push('aggregate_id = ?');
      params.push(aggregateId);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM snapshots WHERE ${where.join(' AND ')}`)
      .get(...params) as { count: number };
    return row.count;
  }
}
