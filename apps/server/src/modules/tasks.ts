/**
 * Task publishing + lifecycle state machine (US-008).
 *
 * Methods (see `METHODS.task` in `@agentmesh/protocol`):
 *
 * - `task.publish` — **admin only**: create a task in `open` and append
 *   `task.published`. The requested skills/budget/deadline travel with both
 *   the row and the event so replay rebuilds the same task.
 * - `task.list`    — `admin`/`agent`: the workspace's tasks, filterable by
 *   `status`, with `limit`/`offset` paging.
 * - `task.get`     — `admin`/`agent`: one task by id, **including `version`**
 *   (the optimistic-concurrency token US-009 echoes back on award/bid CAS).
 *
 * ## The state machine
 *
 * All legal moves live in {@link TASK_TRANSITIONS} — one table, used by both
 * the RPC layer and the sweeper. Everything else is rejected with `-32003`
 * (`data: {taskId, from, to, allowed}`), never silently coerced:
 *
 * ```
 * draft → open → bidding → awarded → in_progress → review → done
 *                  ↓         ↓          ↓            ↓
 *               failed    failed     failed       failed
 * open → cancelled        (MVP cancel branch, see below)
 * ```
 *
 * **Cancel policy (MVP, per US-008 notes).** Only `open` tasks may be
 * cancelled. `awarded`/`in_progress`/`review` tasks are "owned" by an agent
 * (and `bidding` is mid-auction), so they exit through `failed` or through the
 * US-013 reassign / human-takeover path — never through a plain `cancel`
 * (that extension is US-022+). The table therefore has exactly one
 * `→ cancelled` edge.
 *
 * ## CAS + event log
 *
 * Every transition is one transaction:
 *
 * 1. `TasksDao.updateWithVersion(id, expectedVersion, {status})` — SQL
 *    `UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?`.
 *    Zero affected rows means another writer won: `-32007` with
 *    `{taskId, expectedVersion, currentVersion}` (the same code US-009 uses).
 * 2. append `task.status.changed` with `{taskId, from, to, version, actorId?,
 *    reason?, at}` at the **same** version the row now holds, so the projection
 *    and the event log cannot drift.
 *
 * ## Reclaiming stale `open` tasks
 *
 * `reclaimExpired(now)` is a pure function of the injected clock: it cancels
 * `open` tasks whose `deadline` has passed, plus — when
 * `TASK_OPEN_TTL_SECONDS > 0` — `open` tasks older than the TTL that never had
 * a deadline. `app.ts` wires it to a `setInterval` (cleared on close), but
 * tests call it directly with an explicit `now`, so nothing depends on real
 * wall-clock time.
 */

import { randomUUID } from 'node:crypto';

import { aggregateIdOf } from '@agentmesh/core';
import type { EventStore } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS, ProtocolError } from '@agentmesh/protocol';
import {
  TASK_STATUSES,
  withTransaction,
  type AgentMeshDatabase,
  type Task,
  type TaskStatus,
  type TasksDao,
} from '@agentmesh/store';

import type { AuthContext } from '../auth/roles.js';
import { requireRole } from '../auth/roles.js';
import type { HandlerRegistry } from '../registry.js';

/** Longest accepted title. */
export const MAX_TASK_TITLE_LENGTH = 200;
/** Longest accepted description. */
export const MAX_TASK_DESCRIPTION_LENGTH = 4000;
/** Cap on `requiredSkills` entries (deduplicated). */
export const MAX_TASK_SKILLS = 32;
/** Longest single skill token. */
export const MAX_SKILL_LENGTH = 64;

/** Roles allowed to publish tasks (the operator role). */
export const TASK_PUBLISH_ROLES: readonly AuthContext['role'][] = ['admin'];
/** Roles allowed to read tasks (`observer` is not "agent+" and is excluded). */
export const TASK_READ_ROLES: readonly AuthContext['role'][] = ['admin', 'agent'];

/**
 * Legal lifecycle edges. The single source of truth for "what may follow
 * what"; `null` rows (terminal states) are represented by empty arrays.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  Object.freeze({
    draft: ['open'],
    open: ['bidding', 'cancelled'],
    bidding: ['awarded', 'failed'],
    awarded: ['in_progress', 'failed'],
    in_progress: ['review', 'failed'],
    review: ['done', 'failed', 'in_progress'],
    done: [],
    failed: [],
    cancelled: [],
  });

/** True when `from → to` is a legal lifecycle step. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

function invalidTransition(taskId: string, from: TaskStatus, to: TaskStatus): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidState,
    `Illegal task transition ${from} → ${to}`,
    { taskId, from, to, allowed: TASK_TRANSITIONS[from] },
  );
}

function versionConflict(
  taskId: string,
  expectedVersion: number,
  currentVersion: number | null,
  from: TaskStatus,
  to: TaskStatus,
): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.VersionConflict,
    `Task ${taskId} changed since version ${expectedVersion}`,
    { taskId, expectedVersion, currentVersion, from, to },
  );
}

function notFoundTask(taskId: string): ProtocolError {
  return new ProtocolError(JsonRpcErrorCode.NotFound, `Unknown task: ${taskId}`, { taskId });
}

// ---------------------------------------------------------------------------
// Param validation (structured `-32602` instead of leaking zod messages)
// ---------------------------------------------------------------------------

function invalidParams(message: string, field?: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidParams,
    `Invalid params: ${message}`,
    field === undefined ? undefined : { field },
  );
}

function asParamsObject(params: unknown, method: string): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw invalidParams(`${method} params must be an object`);
  }
  return params as Record<string, unknown>;
}

function readRequiredString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const raw = input[field];
  if (typeof raw !== 'string') {
    throw invalidParams(`${field} must be a string`, field);
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw invalidParams(`${field} must not be empty`, field);
  }
  if (value.length > maxLength) {
    throw invalidParams(`${field} must be at most ${maxLength} characters`, field);
  }
  return value;
}

function readOptionalString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw invalidParams(`${field} must be a string`, field);
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    throw invalidParams(`${field} must be at most ${maxLength} characters`, field);
  }
  return value;
}

function readOptionalSkills(input: Record<string, unknown>): string[] | undefined {
  const raw = input.requiredSkills;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw invalidParams('requiredSkills must be an array of strings', 'requiredSkills');
  }
  if (raw.length > MAX_TASK_SKILLS) {
    throw invalidParams(
      `requiredSkills must contain at most ${MAX_TASK_SKILLS} entries`,
      'requiredSkills',
    );
  }
  const skills: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      throw invalidParams('requiredSkills must contain only strings', 'requiredSkills');
    }
    const skill = entry.trim();
    if (skill.length === 0) {
      throw invalidParams('requiredSkills must not contain empty entries', 'requiredSkills');
    }
    if (skill.length > MAX_SKILL_LENGTH) {
      throw invalidParams(
        `each skill must be at most ${MAX_SKILL_LENGTH} characters`,
        'requiredSkills',
      );
    }
    if (!skills.includes(skill)) skills.push(skill);
  }
  return skills;
}

function readOptionalNonNegativeNumber(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw invalidParams(`${field} must be a non-negative number`, field);
  }
  return raw;
}

function readOptionalTimestamp(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw invalidParams(`${field} must be a non-negative integer (epoch ms)`, field);
  }
  return raw;
}

function readOptionalStatus(input: Record<string, unknown>): TaskStatus | undefined {
  const raw = input.status;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !(TASK_STATUSES as readonly string[]).includes(raw)) {
    throw invalidParams(`status must be one of ${TASK_STATUSES.join(', ')}`, 'status');
  }
  return raw as TaskStatus;
}

function readPagination(input: Record<string, unknown>): { limit?: number; offset: number } {
  const rawLimit = input.limit;
  const rawOffset = input.offset;
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
      throw invalidParams('limit must be a positive integer', 'limit');
    }
    limit = rawLimit;
  }
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      throw invalidParams('offset must be a non-negative integer', 'offset');
    }
    offset = rawOffset;
  }
  return limit === undefined ? { offset } : { limit, offset };
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** Wire shape of a task; `version` is echoed back by US-009 for CAS. */
export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly requiredSkills: string[];
  readonly budget: number;
  readonly status: TaskStatus;
  readonly assignee: string | null;
  readonly version: number;
  readonly parentId: string | null;
  readonly deadline: number | null;
  readonly blockedBy: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PublishTaskResult {
  readonly task: TaskView;
  /** `seq` of the `task.published` event. */
  readonly seq: number;
}

export interface TaskListResult {
  readonly tasks: TaskView[];
  readonly total: number;
  readonly limit: number | null;
  readonly offset: number;
}

/** Why a task left `open` without being awarded. */
export type ReclaimReason = 'deadline_expired' | 'open_ttl_expired';

export interface ReclaimResult {
  /** Tasks that were cancelled by this sweep (oldest first). */
  readonly reclaimed: TaskView[];
  readonly count: number;
}

export interface TransitionOptions {
  /**
   * Version the caller last saw. Required: every lifecycle step is a CAS, so a
   * caller cannot accidentally fall back to a read-then-write.
   */
  readonly expectedVersion: number;
  /** Agent that caused the transition (absent for system sweeps). */
  readonly actorId?: string;
  /** Free-form reason recorded in the event (e.g. `deadline_expired`). */
  readonly reason?: string;
  readonly workspaceId?: string;
}

export interface PublishTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly requiredSkills?: readonly string[];
  readonly budget?: number;
  readonly deadline?: number;
}

export interface ListTasksQuery {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface TasksModuleOptions {
  /** Connection used to wrap `CAS + event append` in one transaction. */
  readonly db: AgentMeshDatabase;
  readonly tasks: TasksDao;
  readonly events: EventStore;
  /** Tenant scope; defaults to the event store's workspace. */
  readonly workspaceId?: string;
  /** `0`/absent disables the TTL sweep (deadlines are always honoured). */
  readonly openTtlSeconds?: number;
  /** Id generator (tests inject a deterministic one). */
  readonly idFactory?: () => string;
  /** Injectable clock for deterministic timestamps. */
  readonly clock?: () => number;
}

function toView(task: Task): TaskView {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    requiredSkills: [...task.requiredSkills],
    budget: task.budget,
    status: task.status,
    assignee: task.assignee,
    version: task.version,
    parentId: task.parentId,
    deadline: task.deadline,
    blockedBy: [...task.blockedBy],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Domain service behind the three RPC handlers (unit-testable on its own). */
export class TasksService {
  readonly #db: AgentMeshDatabase;
  readonly #tasks: TasksDao;
  readonly #events: EventStore;
  readonly #workspaceId: string;
  readonly #openTtlSeconds: number;
  readonly #idFactory: () => string;
  readonly #clock: () => number;

  constructor(options: TasksModuleOptions) {
    this.#db = options.db;
    this.#tasks = options.tasks;
    this.#events = options.events;
    this.#workspaceId = options.workspaceId ?? 'default';
    this.#openTtlSeconds = options.openTtlSeconds ?? 0;
    this.#idFactory = options.idFactory ?? (() => `tsk_${randomUUID()}`);
    this.#clock = options.clock ?? (() => Date.now());
  }

  // ----------------------------------------------------------------- publish

  /**
   * Create a task in `open` and append `task.published`.
   *
   * The row is born at `version: 1`, the version of the `task.published`
   * event, so "row version == aggregate version" holds from the first write
   * and US-009's first CAS can safely send `expectedVersion: 1`.
   */
  publish(
    input: PublishTaskInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): PublishTaskResult {
    const title = input.title.trim();
    if (title.length === 0) {
      throw invalidParams('title must not be empty', 'title');
    }
    if (title.length > MAX_TASK_TITLE_LENGTH) {
      throw invalidParams(
        `title must be at most ${MAX_TASK_TITLE_LENGTH} characters`,
        'title',
      );
    }
    const description = input.description ?? '';
    if (description.length > MAX_TASK_DESCRIPTION_LENGTH) {
      throw invalidParams(
        `description must be at most ${MAX_TASK_DESCRIPTION_LENGTH} characters`,
        'description',
      );
    }
    if (input.budget !== undefined && input.budget < 0) {
      throw invalidParams('budget must be a non-negative number', 'budget');
    }
    if (input.deadline !== undefined && input.deadline < 0) {
      throw invalidParams('deadline must be a non-negative integer (epoch ms)', 'deadline');
    }

    const createdAt = this.#clock();
    const taskId = this.#requireUniqueId(workspaceId);
    const aggregateId = aggregateIdOf('task', taskId);
    const requiredSkills = [...(input.requiredSkills ?? [])];
    const budget = input.budget ?? 0;
    const deadline = input.deadline ?? null;
    if (deadline !== null && deadline <= createdAt) {
      // A task that is expired on arrival is immediately reclaimable but
      // still shows as `open` until a sweep; reject it at the source.
      throw invalidParams('deadline must be in the future', 'deadline');
    }

    const { row, event } = withTransaction(this.#db, () => {
      const created = this.#tasks.create({
        id: taskId,
        title,
        description,
        requiredSkills,
        budget,
        status: 'open',
        version: 1,
        deadline,
        createdAt,
        updatedAt: createdAt,
        workspaceId,
      });
      const published = this.#events.append({
        aggregateId,
        type: 'task.published',
        version: 1,
        payload: {
          taskId,
          title,
          description,
          requiredSkills,
          budget,
          status: 'open',
          publishedBy: actor.agentId,
          deadline,
          createdAt,
        },
        ts: createdAt,
        workspaceId,
      });
      return { row: created, event: published };
    });

    return { task: toView(row), seq: event.seq };
  }

  // -------------------------------------------------------------------- read

  /** Tasks of `workspaceId`, oldest first, optionally filtered by status. */
  list(
    query: ListTasksQuery,
    workspaceId: string = this.#workspaceId,
  ): TaskListResult {
    const tasks = this.#tasks.list({
      workspaceId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    return {
      tasks: tasks.map(toView),
      total: this.#tasks.count({
        workspaceId,
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
      limit: query.limit ?? null,
      offset: query.offset ?? 0,
    };
  }

  /** One task (including its CAS `version`); `-32004` when unknown. */
  get(taskId: string, workspaceId: string = this.#workspaceId): TaskView {
    const task = this.#tasks.get(taskId, workspaceId);
    if (task === undefined) throw notFoundTask(taskId);
    return toView(task);
  }

  // --------------------------------------------------------------- transition

  /**
   * Apply one lifecycle step.
   *
   * Order inside the transaction: CAS the row **first** (so a loser never
   * appends an event), then append `task.status.changed` at the new version.
   * Illegal edges are rejected before any write (`-32003`).
   */
  transition(
    taskId: string,
    to: TaskStatus,
    options: TransitionOptions,
  ): TaskView {
    const workspaceId = options.workspaceId ?? this.#workspaceId;
    const existing = this.#tasks.get(taskId, workspaceId);
    if (existing === undefined) throw notFoundTask(taskId);

    const from = existing.status;
    if (!canTransition(from, to)) {
      throw invalidTransition(taskId, from, to);
    }

    const expectedVersion = options.expectedVersion;
    const at = this.#clock();

    const updated = withTransaction(this.#db, () => {
      const changes = this.#tasks.updateWithVersion(
        taskId,
        expectedVersion,
        { status: to },
        { workspaceId, updatedAt: at },
      );
      if (changes === 0) {
        const current = this.#tasks.get(taskId, workspaceId);
        if (current === undefined) throw notFoundTask(taskId);
        throw versionConflict(taskId, expectedVersion, current.version, from, to);
      }

      const version = expectedVersion + 1;
      this.#events.append({
        aggregateId: aggregateIdOf('task', taskId),
        type: 'task.status.changed',
        version,
        payload: {
          taskId,
          from,
          to,
          version,
          at,
          ...(options.actorId === undefined ? {} : { actorId: options.actorId }),
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
        ts: at,
        workspaceId,
      });

      const row = this.#tasks.get(taskId, workspaceId);
      if (row === undefined) throw notFoundTask(taskId);
      return row;
    });

    return toView(updated);
  }

  // ----------------------------------------------------------------- reclaim

  /**
   * Cancel `open` tasks whose `deadline` (or, when configured, whose
   * `createdAt + TASK_OPEN_TTL_SECONDS`) is at or before `now`.
   *
   * Pure w.r.t. the injected clock: tests pass an explicit `now` instead of
   * sleeping. A task that another writer just moved out of `open` is skipped
   * (its CAS fails) rather than raising — the sweep is best-effort by design.
   */
  reclaimExpired(
    now: number = this.#clock(),
    workspaceId: string = this.#workspaceId,
  ): ReclaimResult {
    const ttlMs = this.#openTtlSeconds > 0 ? this.#openTtlSeconds * 1000 : undefined;
    const candidates = this.#tasks.list({ workspaceId, status: 'open' });
    const reclaimed: TaskView[] = [];

    for (const task of candidates) {
      const dueAt =
        task.deadline ?? (ttlMs === undefined ? null : task.createdAt + ttlMs);
      if (dueAt === null || dueAt > now) continue;
      const reason: ReclaimReason =
        task.deadline === null ? 'open_ttl_expired' : 'deadline_expired';
      try {
        reclaimed.push(
          this.transition(task.id, 'cancelled', {
            expectedVersion: task.version,
            reason,
            workspaceId,
          }),
        );
      } catch (err) {
        if (
          err instanceof ProtocolError &&
          (err.code === JsonRpcErrorCode.VersionConflict ||
            err.code === JsonRpcErrorCode.InvalidState)
        ) {
          // Lost the race to a publisher/agent; next sweep is a no-op.
          continue;
        }
        throw err;
      }
    }

    return { reclaimed, count: reclaimed.length };
  }

  // ---------------------------------------------------------------- internal

  #requireUniqueId(workspaceId: string = this.#workspaceId): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.#idFactory();
      if (this.#tasks.get(id, workspaceId) === undefined) return id;
    }
    throw new Error('could not allocate a unique task id');
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Wire `task.publish` / `task.list` / `task.get` into `registry`.
 * @returns the service instance (used by the sweeper in `app.ts`).
 */
export function registerTasksModule(
  registry: HandlerRegistry,
  options: TasksModuleOptions,
): TasksService {
  const service = new TasksService(options);

  registry.registerHandler(
    METHODS.task.publish,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_PUBLISH_ROLES);
      const input = asParamsObject(params, METHODS.task.publish);
      const title = readRequiredString(input, 'title', MAX_TASK_TITLE_LENGTH);
      const description = readOptionalString(
        input,
        'description',
        MAX_TASK_DESCRIPTION_LENGTH,
      );
      const requiredSkills = readOptionalSkills(input);
      const budget = readOptionalNonNegativeNumber(input, 'budget');
      const deadline = readOptionalTimestamp(input, 'deadline');
      const result = service.publish(
        {
          title,
          ...(description === undefined ? {} : { description }),
          ...(requiredSkills === undefined ? {} : { requiredSkills }),
          ...(budget === undefined ? {} : { budget }),
          ...(deadline === undefined ? {} : { deadline }),
        },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId: result.task.id,
        agentId: auth.agentId,
        seq: result.seq,
        msg: 'task.published',
      });
      return result;
    },
    { description: 'Publish a task (admin only); it starts in `open`' },
  );

  registry.registerHandler(
    METHODS.task.list,
    async (ctx, params) => {
      requireRole(ctx, TASK_READ_ROLES);
      const input = asParamsObject(params, METHODS.task.list);
      const status = readOptionalStatus(input);
      const { limit, offset } = readPagination(input);
      return service.list(
        {
          ...(status === undefined ? {} : { status }),
          ...(limit === undefined ? {} : { limit }),
          offset,
        },
        ctx.workspaceId,
      );
    },
    { description: 'List workspace tasks (optionally by status, with paging)' },
  );

  registry.registerHandler(
    METHODS.task.get,
    async (ctx, params) => {
      requireRole(ctx, TASK_READ_ROLES);
      const input = asParamsObject(params, METHODS.task.get);
      const taskId = readRequiredString(input, 'taskId', 128);
      return service.get(taskId, ctx.workspaceId);
    },
    { description: 'Fetch one task, including the CAS `version`' },
  );

  return service;
}
