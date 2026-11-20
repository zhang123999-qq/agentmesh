import type { AgentMeshDatabase } from '../db.js';
import { parseJsonArrayColumn, parseJsonColumn, toJsonColumn } from '../json.js';
import {
  DEFAULT_WORKSPACE_ID,
  type JsonRecord,
  type SqlValue,
  type TaskStatus,
} from '../types.js';

/** A persisted task (lifecycle owned by US-008, CAS ownership by US-009/013). */
export interface Task {
  id: string;
  title: string;
  description: string;
  requiredSkills: string[];
  budget: number;
  status: TaskStatus;
  assignee: string | null;
  /** Optimistic-concurrency counter; incremented by CAS updates only. */
  version: number;
  /** Completion percentage 0-100; updated in place without a version bump. */
  progress: number;
  parentId: string | null;
  deadline: number | null;
  meta: JsonRecord | null;
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
  workspaceId: string;
}

export interface CreateTaskInput {
  id: string;
  title: string;
  description?: string;
  requiredSkills?: readonly string[];
  budget?: number;
  status?: TaskStatus;
  assignee?: string | null;
  version?: number;
  progress?: number;
  parentId?: string | null;
  deadline?: number | null;
  meta?: JsonRecord | null;
  blockedBy?: readonly string[];
  createdAt?: number;
  updatedAt?: number;
  workspaceId?: string;
}

export type UpdateTaskPatch = Partial<
  Pick<
    Task,
    | 'title'
    | 'description'
    | 'requiredSkills'
    | 'budget'
    | 'status'
    | 'assignee'
    | 'progress'
    | 'parentId'
    | 'deadline'
    | 'meta'
    | 'blockedBy'
  >
>;

export interface ListTasksOptions {
  workspaceId?: string;
  status?: TaskStatus | readonly TaskStatus[];
  assignee?: string | null;
  parentId?: string;
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

interface TaskRow {
  id: string;
  title: string;
  description: string;
  required_skills: string;
  budget: number;
  status: string;
  assignee: string | null;
  version: number;
  progress: number;
  parent_id: string | null;
  deadline: number | null;
  meta: string | null;
  blocked_by: string;
  created_at: number;
  updated_at: number;
  workspace_id: string;
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    requiredSkills: parseJsonArrayColumn<string>(row.required_skills),
    budget: row.budget,
    status: row.status as TaskStatus,
    assignee: row.assignee,
    version: row.version,
    progress: row.progress,
    parentId: row.parent_id,
    deadline: row.deadline,
    meta: parseJsonColumn<JsonRecord | null>(row.meta, null),
    blockedBy: parseJsonArrayColumn<string>(row.blocked_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

/**
 * Build the `SET` clause for a partial task patch. Shared by the plain update
 * and the CAS update so both accept exactly the same patch shape.
 */
function buildTaskSet(
  patch: UpdateTaskPatch,
  updatedAt: number,
): { sets: string[]; params: SqlValue[] } {
  const sets: string[] = ['updated_at = ?'];
  const params: SqlValue[] = [updatedAt];

  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.requiredSkills !== undefined) {
    sets.push('required_skills = ?');
    params.push(toJsonColumn(patch.requiredSkills));
  }
  if (patch.budget !== undefined) {
    sets.push('budget = ?');
    params.push(patch.budget);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.assignee !== undefined) {
    sets.push('assignee = ?');
    params.push(patch.assignee);
  }
  if (patch.progress !== undefined) {
    sets.push('progress = ?');
    params.push(patch.progress);
  }
  if (patch.parentId !== undefined) {
    sets.push('parent_id = ?');
    params.push(patch.parentId);
  }
  if (patch.deadline !== undefined) {
    sets.push('deadline = ?');
    params.push(patch.deadline);
  }
  if (patch.meta !== undefined) {
    sets.push('meta = ?');
    params.push(patch.meta === null ? null : toJsonColumn(patch.meta, {}));
  }
  if (patch.blockedBy !== undefined) {
    sets.push('blocked_by = ?');
    params.push(toJsonColumn(patch.blockedBy));
  }

  return { sets, params };
}

/** Typed CRUD for the `tasks` table, including the CAS primitive. */
export class TasksDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: CreateTaskInput): Task {
    const now = Date.now();
    const row: TaskRow = {
      id: input.id,
      title: input.title,
      description: input.description ?? '',
      required_skills: toJsonColumn(input.requiredSkills ?? []),
      budget: input.budget ?? 0,
      status: input.status ?? 'draft',
      assignee: input.assignee ?? null,
      version: input.version ?? 0,
      progress: input.progress ?? 0,
      parent_id: input.parentId ?? null,
      deadline: input.deadline ?? null,
      meta: input.meta === undefined || input.meta === null ? null : toJsonColumn(input.meta, {}),
      blocked_by: toJsonColumn(input.blockedBy ?? []),
      created_at: input.createdAt ?? now,
      updated_at: input.updatedAt ?? input.createdAt ?? now,
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, title, description, required_skills, budget, status, assignee, version,
           progress, parent_id, deadline, meta, blocked_by, created_at, updated_at, workspace_id
         ) VALUES (
           @id, @title, @description, @required_skills, @budget, @status, @assignee, @version,
           @progress, @parent_id, @deadline, @meta, @blocked_by, @created_at, @updated_at, @workspace_id
         )`,
      )
      .run(row);
    return mapTask(row);
  }

  /** Full row including `version`, which callers echo back for CAS. */
  get(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Task | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as TaskRow | undefined;
    return row ? mapTask(row) : undefined;
  }

  list(options: ListTasksOptions = {}): Task[] {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];

    if (options.status !== undefined) {
      const statuses: readonly TaskStatus[] =
        typeof options.status === 'string' ? [options.status] : options.status;
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
    }
    if (options.assignee !== undefined) {
      if (options.assignee === null) {
        where.push('assignee IS NULL');
      } else {
        where.push('assignee = ?');
        params.push(options.assignee);
      }
    }
    if (options.parentId !== undefined) {
      where.push('parent_id = ?');
      params.push(options.parentId);
    }

    const direction = options.order === 'desc' ? 'DESC' : 'ASC';
    let sql = `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at ${direction}, id ${direction}`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }
    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(mapTask);
  }

  /**
   * Blind update: no version check and **no version bump** (use
   * `updateWithVersion` for any state transition that must be CAS-guarded).
   */
  update(
    id: string,
    patch: UpdateTaskPatch,
    options: { workspaceId?: string; updatedAt?: number } = {},
  ): Task | undefined {
    const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const { sets, params } = buildTaskSet(patch, options.updatedAt ?? Date.now());
    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`)
      .run(...params, id, workspaceId);
    return result.changes > 0 ? this.get(id, workspaceId) : undefined;
  }

  /**
   * Compare-and-swap update (US-009/013 ownership transitions).
   *
   * Runs `UPDATE ... WHERE id = ? AND version = ?`; on success `version` is
   * incremented atomically in the same statement so concurrent writers cannot
   * both win. Returns the number of affected rows — `0` means the caller's
   * `expectedVersion` was stale and the server must answer `-32007`.
   */
  updateWithVersion(
    id: string,
    expectedVersion: number,
    patch: UpdateTaskPatch,
    options: { workspaceId?: string; updatedAt?: number } = {},
  ): number {
    const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const { sets, params } = buildTaskSet(patch, options.updatedAt ?? Date.now());
    const result = this.db
      .prepare(
        `UPDATE tasks
            SET ${sets.join(', ')}, version = version + 1
          WHERE id = ? AND version = ? AND workspace_id = ?`,
      )
      .run(...params, id, expectedVersion, workspaceId);
    return result.changes;
  }

  delete(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    const result = this.db
      .prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    return result.changes > 0;
  }

  count(options: { workspaceId?: string; status?: TaskStatus | readonly TaskStatus[] } = {}): number {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.status !== undefined) {
      const statuses: readonly TaskStatus[] =
        typeof options.status === 'string' ? [options.status] : options.status;
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM tasks WHERE ${where.join(' AND ')}`)
      .get(...params) as { count: number };
    return row.count;
  }
}
