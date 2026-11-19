import type { AgentMeshDatabase } from '../db.js';
import { fromSqliteBoolean, toSqliteBoolean } from '../json.js';
import { DEFAULT_WORKSPACE_ID, type SqlValue } from '../types.js';

/**
 * A bid placed by an agent on a task.
 *
 * ## OR-Set semantics (US-012)
 *
 * The bid set is an OR-Set: removing a bid writes `tombstone = 1` together
 * with `deletedAt` instead of deleting the row, so a concurrent add of the
 * same element can still be observed and merged correctly. Tombstones are
 * only compacted later, behind `stableFrontier` (the aggregate-level logical
 * cursor: how far the tombstones have been safely compressed).
 */
export interface TaskBid {
  id: string;
  taskId: string;
  agentId: string;
  price: number;
  eta: number | null;
  approach: string | null;
  confidence: number | null;
  /** OR-Set element-level deletion marker (never physically deleted in MVP). */
  tombstone: boolean;
  /** Logical deletion time in ms; `null` for live bids. */
  deletedAt: number | null;
  /** Aggregate-level compaction cursor (denormalised on each row). */
  stableFrontier: number | null;
  createdAt: number;
  workspaceId: string;
}

export interface CreateTaskBidInput {
  id: string;
  taskId: string;
  agentId: string;
  price: number;
  eta?: number | null;
  approach?: string | null;
  confidence?: number | null;
  tombstone?: boolean;
  deletedAt?: number | null;
  stableFrontier?: number | null;
  createdAt?: number;
  workspaceId?: string;
}

export type UpdateTaskBidPatch = Partial<
  Pick<TaskBid, 'price' | 'eta' | 'approach' | 'confidence' | 'stableFrontier'>
>;

export interface ListTaskBidsOptions {
  workspaceId?: string;
  /** Live bids only (default true) — tombstones are OR-Set metadata. */
  includeTombstones?: boolean;
  limit?: number;
}

interface TaskBidRow {
  id: string;
  task_id: string;
  agent_id: string;
  price: number;
  eta: number | null;
  approach: string | null;
  confidence: number | null;
  tombstone: number;
  deleted_at: number | null;
  stable_frontier: number | null;
  created_at: number;
  workspace_id: string;
}

function mapBid(row: TaskBidRow): TaskBid {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    price: row.price,
    eta: row.eta,
    approach: row.approach,
    confidence: row.confidence,
    tombstone: fromSqliteBoolean(row.tombstone),
    deletedAt: row.deleted_at,
    stableFrontier: row.stable_frontier,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
  };
}

/** Typed CRUD for the `task_bids` table (OR-Set delete + compaction cursor). */
export class TaskBidsDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: CreateTaskBidInput): TaskBid {
    const row: TaskBidRow = {
      id: input.id,
      task_id: input.taskId,
      agent_id: input.agentId,
      price: input.price,
      eta: input.eta ?? null,
      approach: input.approach ?? null,
      confidence: input.confidence ?? null,
      tombstone: toSqliteBoolean(input.tombstone ?? false),
      deleted_at: input.deletedAt ?? null,
      stable_frontier: input.stableFrontier ?? null,
      created_at: input.createdAt ?? Date.now(),
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT INTO task_bids (
           id, task_id, agent_id, price, eta, approach, confidence,
           tombstone, deleted_at, stable_frontier, created_at, workspace_id
         ) VALUES (
           @id, @task_id, @agent_id, @price, @eta, @approach, @confidence,
           @tombstone, @deleted_at, @stable_frontier, @created_at, @workspace_id
         )`,
      )
      .run(row);
    return mapBid(row);
  }

  /**
   * Insert-or-replace a live bid for one (task, agent) pair.
   *
   * US-009 requires "same agent bidding twice on the same task overwrites the
   * previous bid", so this reuses the existing row/id when a live bid exists.
   */
  upsertByAgent(input: CreateTaskBidInput): TaskBid {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = this.findLiveByTaskAndAgent(input.taskId, input.agentId, workspaceId);
    if (existing === undefined) {
      return this.create(input);
    }
    // Pass the workspace through to the UPDATE: without it the statement
    // matched 0 rows outside the default workspace and silently returned the
    // stale bid (the upsert looked successful while nothing changed).
    const updated = this.update(
      existing.id,
      {
        price: input.price,
        eta: input.eta ?? null,
        approach: input.approach ?? null,
        confidence: input.confidence ?? null,
      },
      workspaceId,
    );
    if (updated !== undefined) {
      return updated;
    }
    // Row vanished between the read and the update (e.g. compaction). Re-read
    // first, otherwise insert a fresh live row with the same id.
    return this.get(existing.id, workspaceId) ?? this.create({ ...input, id: existing.id, workspaceId });
  }

  get(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): TaskBid | undefined {
    const row = this.db
      .prepare('SELECT * FROM task_bids WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as TaskBidRow | undefined;
    return row ? mapBid(row) : undefined;
  }

  /** Most recent live bid by `agentId` on `taskId`, if any. */
  findLiveByTaskAndAgent(
    taskId: string,
    agentId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): TaskBid | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM task_bids
          WHERE task_id = ? AND agent_id = ? AND tombstone = 0 AND workspace_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(taskId, agentId, workspaceId) as TaskBidRow | undefined;
    return row ? mapBid(row) : undefined;
  }

  listByTask(taskId: string, options: ListTaskBidsOptions = {}): TaskBid[] {
    const where: string[] = ['task_id = ?', 'workspace_id = ?'];
    const params: SqlValue[] = [taskId, options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.includeTombstones !== true) {
      where.push('tombstone = 0');
    }
    let sql = `SELECT * FROM task_bids WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as TaskBidRow[];
    return rows.map(mapBid);
  }

  listByAgent(agentId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): TaskBid[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM task_bids
          WHERE agent_id = ? AND tombstone = 0 AND workspace_id = ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(agentId, workspaceId) as TaskBidRow[];
    return rows.map(mapBid);
  }

  update(
    id: string,
    patch: UpdateTaskBidPatch,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): TaskBid | undefined {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.price !== undefined) {
      sets.push('price = ?');
      params.push(patch.price);
    }
    if (patch.eta !== undefined) {
      sets.push('eta = ?');
      params.push(patch.eta);
    }
    if (patch.approach !== undefined) {
      sets.push('approach = ?');
      params.push(patch.approach);
    }
    if (patch.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(patch.confidence);
    }
    if (patch.stableFrontier !== undefined) {
      sets.push('stable_frontier = ?');
      params.push(patch.stableFrontier);
    }
    if (sets.length === 0) {
      return this.get(id, workspaceId);
    }
    params.push(id, workspaceId);
    const result = this.db
      .prepare(`UPDATE task_bids SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`)
      .run(...params);
    return result.changes > 0 ? this.get(id, workspaceId) : undefined;
  }

  /**
   * OR-Set element-level delete: flip the tombstone, never remove the row.
   * Idempotent — a second call keeps the first `deleted_at`.
   */
  markDeleted(
    id: string,
    deletedAt: number = Date.now(),
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE task_bids
            SET tombstone = 1, deleted_at = COALESCE(deleted_at, ?)
          WHERE id = ? AND workspace_id = ? AND tombstone = 0`,
      )
      .run(deletedAt, id, workspaceId);
    if (result.changes > 0) {
      return true;
    }
    // Already tombstoned still counts as "deleted" for callers.
    return this.get(id, workspaceId)?.tombstone === true;
  }

  /** Physical delete — reserved for the US-012 compaction job and tests. */
  delete(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    const result = this.db
      .prepare('DELETE FROM task_bids WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    return result.changes > 0;
  }

  /**
   * Current aggregate-level compaction cursor for a task's bid set
   * (`MAX(stable_frontier)`, 0 when never compacted).
   */
  getStableFrontier(taskId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(stable_frontier), 0) AS frontier
           FROM task_bids WHERE task_id = ? AND workspace_id = ?`,
      )
      .get(taskId, workspaceId) as { frontier: number };
    return row.frontier;
  }

  /**
   * Advance the aggregate-level cursor after compaction. Monotonic: it never
   * moves backwards, so a stale compactor cannot resurrect deleted ranges.
   */
  setStableFrontier(
    taskId: string,
    frontier: number,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): number {
    const result = this.db
      .prepare(
        `UPDATE task_bids
            SET stable_frontier = ?
          WHERE task_id = ? AND workspace_id = ?
            AND (stable_frontier IS NULL OR stable_frontier < ?)`,
      )
      .run(frontier, taskId, workspaceId, frontier);
    return result.changes;
  }

  count(
    taskId: string,
    options: { includeTombstones?: boolean; workspaceId?: string } = {},
  ): number {
    const sql =
      options.includeTombstones === true
        ? 'SELECT COUNT(*) AS count FROM task_bids WHERE task_id = ? AND workspace_id = ?'
        : 'SELECT COUNT(*) AS count FROM task_bids WHERE task_id = ? AND tombstone = 0 AND workspace_id = ?';
    const row = this.db
      .prepare(sql)
      .get(taskId, options.workspaceId ?? DEFAULT_WORKSPACE_ID) as { count: number };
    return row.count;
  }
}
