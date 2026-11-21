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
  type AccountsDao,
  type AgentMeshDatabase,
  type Task,
  type TaskBid,
  type TaskBidsDao,
  type TaskStatus,
  type TasksDao,
} from '@agentmesh/store';

import type { AuthContext } from '../auth/roles.js';
import { requireRole } from '../auth/roles.js';
import type { HandlerRegistry } from '../registry.js';
import { TokenBucketRegistry } from '../ws/session.js';
import {
  AlwaysExploreForDemo,
  assertValidScoringWeights,
  DEFAULT_HISTORY_CONFIDENCE_THRESHOLD,
  DEFAULT_SCORING_WEIGHTS,
  pickExplorationCandidate,
  ProbabilisticExploration,
  scoreBids,
  type AgentScoringStats,
  type ExplorationPolicy,
  type ScoringWeights,
} from './task-scoring.js';

/** Longest accepted title. */
export const MAX_TASK_TITLE_LENGTH = 200;
/** Longest accepted description. */
export const MAX_TASK_DESCRIPTION_LENGTH = 4000;
/** Cap on `requiredSkills` entries (deduplicated). */
export const MAX_TASK_SKILLS = 32;
/** Longest single skill token. */
export const MAX_SKILL_LENGTH = 64;
/** Longest accepted bid approach text. */
export const MAX_BID_APPROACH_LENGTH = 2000;

/** Roles allowed to publish tasks (the operator role). */
export const TASK_PUBLISH_ROLES: readonly AuthContext['role'][] = ['admin'];
/** Roles allowed to read tasks (`observer` is not "agent+" and is excluded). */
export const TASK_READ_ROLES: readonly AuthContext['role'][] = ['admin', 'agent'];
/** Roles allowed to place a bid. */
export const TASK_BID_ROLES: readonly AuthContext['role'][] = ['admin', 'agent'];
/** Roles allowed to inspect the bid set / award a task. */
export const TASK_AWARD_ROLES: readonly AuthContext['role'][] = ['admin'];
/** Roles that may report progress / complete / fail (subject to assignee check). */
export const TASK_EXECUTION_ROLES: readonly AuthContext['role'][] = ['admin', 'agent'];
/** Limits for progress notes / artifacts (references only, not content). */
export const MAX_PROGRESS_NOTE_LENGTH = 2000;
export const MAX_FAIL_REASON_LENGTH = 2000;
export const MAX_ARTIFACTS = 32;
export const MAX_ARTIFACT_REF_LENGTH = 2048;
/** Default bid budget: 5 bids per minute per agent. */
export const DEFAULT_BID_RATE_PER_SECOND = 5 / 60;
export const DEFAULT_BID_BURST = 5;

/**
 * Legal lifecycle edges. The single source of truth for "what may follow
 * what"; `null` rows (terminal states) are represented by empty arrays.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  Object.freeze({
    draft: ['open'],
    open: ['bidding', 'cancelled'],
    bidding: ['awarded', 'failed', 'cancelled'],
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

function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

function isReassignableStatus(status: TaskStatus): boolean {
  return status === 'awarded' || status === 'in_progress' || status === 'review';
}

function isCancellableStatus(status: TaskStatus): boolean {
  return (
    status === 'open' ||
    status === 'bidding' ||
    status === 'in_progress' ||
    status === 'review'
  );
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

function biddingClosed(taskId: string, status: TaskStatus): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidState,
    `Task ${taskId} is not accepting bids (status ${status})`,
    { taskId, status, reason: 'bidding_closed' },
  );
}

function noBids(taskId: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidState,
    `Task ${taskId} has no live bids`,
    { taskId, reason: 'no_bids' },
  );
}

function awardeeHasNoBid(taskId: string, agentId: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidState,
    `Agent ${agentId} has no live bid on task ${taskId}`,
    { taskId, agentId, reason: 'awardee_has_no_bid' },
  );
}

function tooManyBids(retryAfterMs: number): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.RateLimited,
    'Too many bids',
    { reason: 'too_many_bids', retryAfterMs },
  );
}

function notAssignee(taskId: string, assignee: string | null): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.Forbidden,
    'Only the assigned agent may report progress or finish this task',
    { taskId, assignee, reason: 'not_assignee' },
  );
}

function subtasksIncomplete(taskId: string, pending: readonly string[]): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidState,
    `Task ${taskId} still has ${pending.length} incomplete subtask(s)`,
    { taskId, pendingSubtaskIds: [...pending], reason: 'subtasks_incomplete' },
  );
}

function parentTaskNotFound(taskId: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidParams,
    `Parent task ${taskId} does not exist`,
    { parentId: taskId, field: 'parentId' },
  );
}

function parentCycle(taskId: string, chain: readonly string[]): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidState,
    `Task parent chain contains a cycle at ${taskId}`,
    { taskId, chain: [...chain], reason: 'dependency_cycle' },
  );
}

function targetAgentNotFound(agentId: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.NotFound,
    `Unknown target agent: ${agentId}`,
    { toAgentId: agentId, reason: 'target_not_found' },
  );
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

function readRequiredNonNegativeNumber(
  input: Record<string, unknown>,
  field: string,
): number {
  const value = readOptionalNonNegativeNumber(input, field);
  if (value === undefined) throw invalidParams(`${field} is required`, field);
  return value;
}

function readRequiredNonNegativeInteger(
  input: Record<string, unknown>,
  field: string,
): number {
  const raw = input[field];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw invalidParams(`${field} must be a non-negative integer`, field);
  }
  return raw;
}

function readOptionalConfidence(
  input: Record<string, unknown>,
): number | undefined {
  const raw = input.confidence;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw invalidParams('confidence must be a number between 0 and 1', 'confidence');
  }
  return raw;
}

function readOptionalStrategy(
  input: Record<string, unknown>,
): 'manual' | 'auto' | undefined {
  const raw = input.strategy;
  if (raw === undefined || raw === null) return undefined;
  if (raw !== 'manual' && raw !== 'auto') {
    throw invalidParams("strategy must be 'manual' or 'auto'", 'strategy');
  }
  return raw;
}

function readReviewDecision(
  input: Record<string, unknown>,
): 'approve' | 'reject' | 'request-revision' {
  const raw = input.decision;
  if (raw !== 'approve' && raw !== 'reject' && raw !== 'request-revision') {
    throw invalidParams(
      "decision must be 'approve', 'reject' or 'request-revision'",
      'decision',
    );
  }
  return raw;
}

function readProgressValue(input: Record<string, unknown>): number {
  const raw = input.progress;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    throw invalidParams('progress must be a number between 0 and 100', 'progress');
  }
  return raw;
}

function readOptionalArtifacts(
  input: Record<string, unknown>,
  field = 'artifacts',
): string[] | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw invalidParams(`${field} must be an array of strings`, field);
  }
  if (raw.length > MAX_ARTIFACTS) {
    throw invalidParams(`${field} must contain at most ${MAX_ARTIFACTS} entries`, field);
  }
  const artifacts: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw invalidParams(`${field} must contain only strings`, field);
    }
    const value = item.trim();
    if (value.length === 0 || value.length > MAX_ARTIFACT_REF_LENGTH) {
      throw invalidParams(
        `each ${field} entry must be 1-${MAX_ARTIFACT_REF_LENGTH} characters`,
        field,
      );
    }
    artifacts.push(value);
  }
  return artifacts;
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
  /** Completion percentage 0-100 (updated in place without a version bump). */
  readonly progress: number;
  /** Epoch ms set when review approval moves the task to `done`. */
  readonly completedAt: number | null;
  /** Window close time; non-null means bidding is opened at publish. */
  readonly biddingDeadline: number | null;
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

export interface CloseBiddingResult {
  /** Tasks cancelled because their bidding window closed with no bids. */
  readonly closed: TaskView[];
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
  /** When present, the task is created directly in `bidding`. */
  readonly biddingDeadline?: number;
  /** Optional parent for a subtask DAG (MVP: single-parent DAG). */
  readonly parentId?: string;
}

export interface ListTasksQuery {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BidView {
  readonly bidId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly price: number;
  readonly eta: number | null;
  readonly approach: string | null;
  readonly confidence: number | null;
  readonly createdAt: number;
}

export interface PlaceBidInput {
  readonly taskId: string;
  readonly price: number;
  readonly eta?: number;
  readonly approach?: string;
  readonly confidence?: number;
}

export interface PlaceBidResult {
  readonly bid: BidView;
  readonly status: TaskStatus;
  readonly version: number;
  /** `seq` of the appended `task.bid.placed` event. */
  readonly seq: number;
}

export interface BidListResult {
  readonly taskId: string;
  readonly bids: BidView[];
  readonly total: number;
}

export interface AwardInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly awardeeId?: string;
  readonly strategy?: 'manual' | 'auto';
}

export interface AwardResult {
  readonly task: TaskView;
  readonly awardeeId: string;
  readonly strategy: 'manual' | 'auto';
  readonly exploration: boolean;
  readonly version: number;
  /** `seq` of the appended `task.awarded` event. */
  readonly seq: number;
}

export interface ProgressInput {
  readonly taskId: string;
  readonly progress: number;
  readonly note?: string;
  /** Artifact references (URLs/IDs); large content goes through HTTP upload. */
  readonly artifacts?: readonly string[];
}

export interface ProgressResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface CompleteInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly note?: string;
  readonly artifacts?: readonly string[];
}

export interface CompleteResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface FailInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface FailResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface ReviewInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly decision: 'approve' | 'reject' | 'request-revision';
  readonly comment?: string;
}

export interface ReviewResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface ReassignInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly toAgentId: string;
  readonly reason?: string;
}

export interface ReassignResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface CancelInput {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly reason?: string;
}

export interface CancelResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface TasksModuleOptions {
  /** Connection used to wrap `CAS + event append` in one transaction. */
  readonly db: AgentMeshDatabase;
  readonly tasks: TasksDao;
  /** Bid table (OR-Set) used by `task.bid` / `task.bids` / `task.award`. */
  readonly taskBids: TaskBidsDao;
  /** Accounts provide skills for the scoring function. */
  readonly accounts: AccountsDao;
  readonly events: EventStore;
  /** Tenant scope; defaults to the event store's workspace. */
  readonly workspaceId?: string;
  /** `0`/absent disables the TTL sweep (deadlines are always honoured). */
  readonly openTtlSeconds?: number;
  /** Force the deterministic exploration branch (DEMO_MODE). */
  readonly demoMode?: boolean;
  /** Override the five scoring weights (must sum to 1). */
  readonly scoringWeights?: Partial<ScoringWeights>;
  /** Sample count below which history is shrunk toward 0.5. Default 5. */
  readonly historyConfidenceThreshold?: number;
  /** Exploration policy override (tests / embedding). */
  readonly explorationPolicy?: ExplorationPolicy;
  /** Bid bucket budget (default 5/minute, burst 5). */
  readonly bidRateLimit?: { readonly ratePerSecond: number; readonly burst: number };
  /** Injectable bid bucket registry (tests). */
  readonly bidBucketRegistry?: TokenBucketRegistry;
  /** Id generator (tests inject a deterministic one). */
  readonly idFactory?: () => string;
  /** Injectable clock for deterministic timestamps. */
  readonly clock?: () => number;
}

function readBiddingDeadline(meta: Task['meta']): number | null {
  const raw = meta?.['biddingDeadline'];
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
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
    progress: task.progress,
    completedAt: task.completedAt,
    biddingDeadline: readBiddingDeadline(task.meta),
    blockedBy: [...task.blockedBy],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function toBidView(bid: TaskBid): BidView {
  return {
    bidId: bid.id,
    taskId: bid.taskId,
    agentId: bid.agentId,
    price: bid.price,
    eta: bid.eta,
    approach: bid.approach,
    confidence: bid.confidence,
    createdAt: bid.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Domain service behind the three RPC handlers (unit-testable on its own). */
export class TasksService {
  readonly #db: AgentMeshDatabase;
  readonly #tasks: TasksDao;
  readonly #taskBids: TaskBidsDao;
  readonly #accounts: AccountsDao;
  readonly #events: EventStore;
  readonly #workspaceId: string;
  readonly #openTtlSeconds: number;
  readonly #idFactory: () => string;
  readonly #clock: () => number;
  readonly #scoringWeights: ScoringWeights;
  readonly #historyThreshold: number;
  readonly #explorationPolicy: ExplorationPolicy;
  readonly #bidBuckets: TokenBucketRegistry;

  constructor(options: TasksModuleOptions) {
    this.#db = options.db;
    this.#tasks = options.tasks;
    this.#taskBids = options.taskBids;
    this.#accounts = options.accounts;
    this.#events = options.events;
    this.#workspaceId = options.workspaceId ?? 'default';
    this.#openTtlSeconds = options.openTtlSeconds ?? 0;
    this.#idFactory = options.idFactory ?? (() => `tsk_${randomUUID()}`);
    this.#clock = options.clock ?? (() => Date.now());

    this.#scoringWeights = { ...DEFAULT_SCORING_WEIGHTS, ...options.scoringWeights };
    assertValidScoringWeights(this.#scoringWeights);
    this.#historyThreshold =
      options.historyConfidenceThreshold ?? DEFAULT_HISTORY_CONFIDENCE_THRESHOLD;
    if (!Number.isSafeInteger(this.#historyThreshold) || this.#historyThreshold <= 0) {
      throw new TypeError('historyConfidenceThreshold must be a positive integer');
    }
    this.#explorationPolicy =
      options.explorationPolicy ??
      (options.demoMode === true
        ? new AlwaysExploreForDemo()
        : new ProbabilisticExploration());
    this.#bidBuckets =
      options.bidBucketRegistry ??
      new TokenBucketRegistry({
        ratePerSecond:
          options.bidRateLimit?.ratePerSecond ?? DEFAULT_BID_RATE_PER_SECOND,
        burst: options.bidRateLimit?.burst ?? DEFAULT_BID_BURST,
        clock: this.#clock,
      });
  }

  // ----------------------------------------------------------------- publish

  /**
   * Create a task. A `biddingDeadline` opens the bidding window immediately
   * (`status: bidding`); without one the task stays `open` as a draft that a
   * window/operator can still act on.
   *
   * The row is born at `version: 1`, the version of the `task.published`
   * event. Bids do **not** change this version, so `expectedVersion` for
   * `task.award` remains stable for the whole bidding window.
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
    if (input.biddingDeadline !== undefined && input.biddingDeadline < 0) {
      throw invalidParams(
        'biddingDeadline must be a non-negative integer (epoch ms)',
        'biddingDeadline',
      );
    }

    const createdAt = this.#clock();
    const taskId = this.#requireUniqueId(workspaceId);
    const aggregateId = aggregateIdOf('task', taskId);
    const requiredSkills = [...(input.requiredSkills ?? [])];
    const budget = input.budget ?? 0;
    const deadline = input.deadline ?? null;
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      if (parentId === taskId) throw parentCycle(taskId, [taskId]);
      if (this.#tasks.get(parentId, workspaceId) === undefined) {
        throw parentTaskNotFound(parentId);
      }
      this.assertParentChainAcyclic(parentId, workspaceId);
    }
    const biddingDeadline = input.biddingDeadline ?? null;
    if (deadline !== null && deadline <= createdAt) {
      // A task that is expired on arrival is immediately reclaimable but
      // still shows as `open` until a sweep; reject it at the source.
      throw invalidParams('deadline must be in the future', 'deadline');
    }
    if (biddingDeadline !== null && biddingDeadline <= createdAt) {
      throw invalidParams('biddingDeadline must be in the future', 'biddingDeadline');
    }
    const status: TaskStatus = biddingDeadline === null ? 'open' : 'bidding';
    const meta = biddingDeadline === null ? null : { biddingDeadline };

    const { row, event } = withTransaction(this.#db, () => {
      const created = this.#tasks.create({
        id: taskId,
        title,
        description,
        requiredSkills,
        budget,
        status,
        version: 1,
        progress: 0,
        deadline,
        parentId,
        meta,
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
          status,
          publishedBy: actor.agentId,
          deadline,
          ...(biddingDeadline === null ? {} : { biddingDeadline }),
          ...(parentId === null ? {} : { parentId }),
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

  // --------------------------------------------------------------- bidding

  /**
   * Place (or overwrite) this agent's live bid for a task.
   *
   * Bidding must already be open: `task.publish` creates the task in `bidding`
   * when a `biddingDeadline` is supplied, and `open` (no window) is not
   * bid-able. Bids deliberately **do not touch `tasks.version`**; they append
   * `task.bid.placed` (audit) and `task.bid.received` (live notification) at
   * the current version. v6's partial unique index allows several bid events
   * per version while keeping status events unique.
   */
  placeBid(
    input: PlaceBidInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): PlaceBidResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    this.#assertBiddingOpen(task, this.#clock());

    const decision = this.#bidBuckets.get(actor.agentId).tryConsume();
    if (!decision.allowed) throw tooManyBids(decision.retryAfterMs);

    const at = this.#clock();
    const proposedBidId = `bid_${randomUUID()}`;

    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      this.#assertBiddingOpen(current, at);

      const bid = this.#taskBids.upsertByAgent({
        id: proposedBidId,
        taskId: current.id,
        agentId: actor.agentId,
        price: input.price,
        eta: input.eta ?? null,
        approach: input.approach ?? null,
        confidence: input.confidence ?? null,
        createdAt: at,
        workspaceId,
      });
      const payload = {
        taskId: current.id,
        bidId: bid.id,
        agentId: bid.agentId,
        price: bid.price,
        eta: bid.eta,
        approach: bid.approach,
        confidence: bid.confidence,
        createdAt: bid.createdAt,
      };
      const aggregateId = aggregateIdOf('task', current.id);
      // Audit event (domain-only) and notification twin (live push) share the
      // task's current version; neither changes `tasks.version`.
      const placed = this.#events.append({
        aggregateId,
        type: 'task.bid.placed',
        version: current.version,
        payload,
        ts: at,
        workspaceId,
      });
      this.#events.append({
        aggregateId,
        type: 'task.bid.received',
        version: current.version,
        payload,
        ts: at,
        workspaceId,
      });

      return {
        bid,
        event: placed,
        status: current.status,
        version: current.version,
      };
    });

    return {
      bid: toBidView(persisted.bid),
      status: persisted.status,
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  /**
   * Bidding is closed when the status is no longer `bidding` or the published
   * `biddingDeadline` has passed. The row is never mutated by a bid, so this
   * guard only reads.
   */
  #assertBiddingOpen(task: Task, now: number): void {
    if (task.status !== 'bidding') throw biddingClosed(task.id, task.status);
    const deadline = readBiddingDeadline(task.meta);
    if (deadline !== null && now >= deadline) {
      throw biddingClosed(task.id, task.status);
    }
  }

  /** Live bid set for one task (admin-facing). */
  listBids(
    taskId: string,
    workspaceId: string = this.#workspaceId,
  ): BidListResult {
    const task = this.#tasks.get(taskId, workspaceId);
    if (task === undefined) throw notFoundTask(taskId);
    const bids = this.#taskBids.listByTask(taskId, { workspaceId });
    return { taskId, bids: bids.map(toBidView), total: bids.length };
  }

  /**
   * Award a `bidding` task.
   *
   * `expectedVersion` is mandatory and used for the CAS, so two concurrent
   * awards with the same observed version produce one winner and one `-32007`.
   * The single `task.awarded` event is appended **inside** the transaction;
   * the `withTransaction` frame stack emits it only after commit.
   *
   * Manual (`awardeeId` present): the agent must have a live bid.
   * Auto (`strategy:'auto'`, no awardeeId): score all live bids; explore a
   * cold-start candidate when the injected policy says so.
   */
  award(
    input: AwardInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): AwardResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    this.#assertAwardable(task, input.expectedVersion);

    const at = this.#clock();

    const outcome = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      this.#assertAwardable(current, input.expectedVersion);

      const bids = this.#taskBids.listByTask(current.id, { workspaceId });
      if (bids.length === 0) throw noBids(current.id);

      let chosen: TaskBid;
      let strategy: 'manual' | 'auto';
      let exploration = false;

      if (input.awardeeId !== undefined) {
        const match = bids.find((bid) => bid.agentId === input.awardeeId);
        if (match === undefined) throw awardeeHasNoBid(current.id, input.awardeeId);
        chosen = match;
        strategy = 'manual';
      } else {
        const stats = this.#statsForAgents(
          bids.map((bid) => bid.agentId),
          workspaceId,
        );
        const scored = scoreBids(
          bids.map((bid) => ({
            bidId: bid.id,
            agentId: bid.agentId,
            price: bid.price,
            eta: bid.eta,
          })),
          {
            requiredSkills: current.requiredSkills,
            stats,
            weights: this.#scoringWeights,
            historyConfidenceThreshold: this.#historyThreshold,
          },
        );
        const coldStart = pickExplorationCandidate(scored, this.#historyThreshold);
        const useExploration =
          coldStart !== undefined && this.#explorationPolicy.shouldExplore();
        const selected = useExploration ? coldStart : scored[0];
        if (selected === undefined) throw noBids(current.id);
        const selectedBid = bids.find((bid) => bid.id === selected.bidId);
        if (selectedBid === undefined) throw noBids(current.id);
        chosen = selectedBid;
        strategy = 'auto';
        exploration = useExploration;
      }

      const changes = this.#tasks.updateWithVersion(
        current.id,
        input.expectedVersion,
        { status: 'awarded', assignee: chosen.agentId },
        { workspaceId, updatedAt: at },
      );
      if (changes === 0) {
        const now = this.#tasks.get(current.id, workspaceId);
        throw versionConflict(
          current.id,
          input.expectedVersion,
          now?.version ?? null,
          current.status,
          'awarded',
        );
      }

      const version = input.expectedVersion + 1;
      const event = this.#events.append({
        aggregateId: aggregateIdOf('task', current.id),
        type: 'task.awarded',
        version,
        payload: {
          taskId: current.id,
          awardeeId: chosen.agentId,
          awardedBy: actor.agentId,
          exploration,
          strategy,
          version,
        },
        ts: at,
        workspaceId,
      });

      const row = this.#tasks.get(current.id, workspaceId);
      if (row === undefined) throw notFoundTask(current.id);
      return { row, chosen, event, strategy, exploration, version };
    });

    return {
      task: toView(outcome.row),
      awardeeId: outcome.chosen.agentId,
      strategy: outcome.strategy,
      exploration: outcome.exploration,
      version: outcome.version,
      seq: outcome.event.seq,
    };
  }

  // -------------------------------------------------------------- execution

  /**
   * Report progress. The first report on an `awarded` task is the
   * `awarded → in_progress` status transition (CAS, version +1); subsequent
   * reports update `tasks.progress` in place **without** touching the version.
   */
  reportProgress(
    input: ProgressInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): ProgressResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    this.#assertAssignee(task, actor);
    if (task.status !== 'awarded' && task.status !== 'in_progress') {
      throw invalidTransition(task.id, task.status, 'in_progress');
    }

    const at = this.#clock();
    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      this.#assertAssignee(current, actor);
      if (current.status !== 'awarded' && current.status !== 'in_progress') {
        throw invalidTransition(current.id, current.status, 'in_progress');
      }

      let version: number;
      if (current.status === 'awarded') {
        const changes = this.#tasks.updateWithVersion(
          current.id,
          current.version,
          { status: 'in_progress', progress: input.progress },
          { workspaceId, updatedAt: at },
        );
        if (changes === 0) {
          const now = this.#tasks.get(current.id, workspaceId);
          throw versionConflict(
            current.id,
            current.version,
            now?.version ?? null,
            current.status,
            'in_progress',
          );
        }
        version = current.version + 1;
      } else {
        const updated = this.#tasks.update(
          current.id,
          { progress: input.progress },
          { workspaceId, updatedAt: at },
        );
        if (updated === undefined) throw notFoundTask(current.id);
        version = current.version;
      }

      const event = this.#events.append({
        aggregateId: aggregateIdOf('task', current.id),
        type: 'task.progress.updated',
        version,
        payload: {
          taskId: current.id,
          agentId: actor.agentId,
          progress: input.progress,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.artifacts === undefined ? {} : { artifacts: [...input.artifacts] }),
          at,
        },
        ts: at,
        workspaceId,
      });

      const row = this.#tasks.get(current.id, workspaceId);
      if (row === undefined) throw notFoundTask(current.id);
      return { row, event, version };
    });

    return {
      task: toView(persisted.row),
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  /**
   * Submit the deliverable for review (`in_progress → review`). The assigned
   * agent must have finished every subtask (`parentId` children are `done`).
   */
  complete(
    input: CompleteInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): CompleteResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    this.#assertAssignee(task, actor);
    if (task.status !== 'in_progress') {
      throw invalidTransition(task.id, task.status, 'review');
    }
    this.#assertSubtasksDone(task.id, workspaceId);

    const at = this.#clock();
    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      this.#assertAssignee(current, actor);
      if (current.status !== 'in_progress') {
        throw invalidTransition(current.id, current.status, 'review');
      }
      this.#assertSubtasksDone(current.id, workspaceId);

      const changes = this.#tasks.updateWithVersion(
        current.id,
        input.expectedVersion,
        { status: 'review', progress: 100 },
        { workspaceId, updatedAt: at },
      );
      if (changes === 0) {
        const now = this.#tasks.get(current.id, workspaceId);
        throw versionConflict(
          current.id,
          input.expectedVersion,
          now?.version ?? null,
          current.status,
          'review',
        );
      }

      const version = input.expectedVersion + 1;
      const event = this.#events.append({
        aggregateId: aggregateIdOf('task', current.id),
        type: 'task.completed',
        version,
        payload: {
          taskId: current.id,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.artifacts === undefined ? {} : { artifacts: [...input.artifacts] }),
          at,
        },
        ts: at,
        workspaceId,
      });

      const row = this.#tasks.get(current.id, workspaceId);
      if (row === undefined) throw notFoundTask(current.id);
      return { row, event, version };
    });

    return {
      task: toView(persisted.row),
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  /** Mark the task failed; propagates a block to a non-terminal parent. */
  fail(
    input: FailInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): FailResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    this.#assertCanFail(task, actor);

    const at = this.#clock();
    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      this.#assertCanFail(current, actor);

      const changes = this.#tasks.updateWithVersion(
        current.id,
        input.expectedVersion,
        { status: 'failed' },
        { workspaceId, updatedAt: at },
      );
      if (changes === 0) {
        const now = this.#tasks.get(current.id, workspaceId);
        throw versionConflict(
          current.id,
          input.expectedVersion,
          now?.version ?? null,
          current.status,
          'failed',
        );
      }

      const version = input.expectedVersion + 1;
      const event = this.#events.append({
        aggregateId: aggregateIdOf('task', current.id),
        type: 'task.failed',
        version,
        payload: {
          taskId: current.id,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          at,
        },
        ts: at,
        workspaceId,
      });

      if (current.parentId !== null) {
        const parent = this.#tasks.get(current.parentId, workspaceId);
        if (parent !== undefined && !isTerminalStatus(parent.status)) {
          const blockedBy = [...new Set([...parent.blockedBy, current.id])];
          // Metadata only: no version bump, so complete/fail CAS is unaffected.
          this.#tasks.update(
            parent.id,
            { blockedBy },
            { workspaceId, updatedAt: at },
          );
          this.#events.append({
            aggregateId: aggregateIdOf('task', parent.id),
            type: 'task.dependency.failed',
            version: parent.version,
            payload: {
              parentTaskId: parent.id,
              subtaskId: current.id,
              blockedBy: [current.id],
              ...(input.reason === undefined ? {} : { reason: input.reason }),
            },
            ts: at,
            workspaceId,
          });
        }
      }

      const row = this.#tasks.get(current.id, workspaceId);
      if (row === undefined) throw notFoundTask(current.id);
      return { row, event, version };
    });

    return {
      task: toView(persisted.row),
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  /**
   * Admin review of a `review` task.
   *
   * approve → done (completedAt = now); reject / request-revision → in_progress.
   * Progress is preserved on rejection so the next progress report continues
   * from the agent's last state. `review → failed` is the admin's explicit
   * `task.fail` path, not a review decision.
   */
  review(
    input: ReviewInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): ReviewResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    const target = input.decision === 'approve' ? 'done' : 'in_progress';
    if (task.status !== 'review') {
      throw invalidTransition(task.id, task.status, target);
    }

    const at = this.#clock();
    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      if (current.status !== 'review') {
        throw invalidTransition(current.id, current.status, target);
      }

      const changes = this.#tasks.updateWithVersion(
        current.id,
        input.expectedVersion,
        target === 'done'
          ? { status: 'done', progress: 100, completedAt: at }
          : { status: 'in_progress' },
        { workspaceId, updatedAt: at },
      );
      if (changes === 0) {
        const now = this.#tasks.get(current.id, workspaceId);
        throw versionConflict(
          current.id,
          input.expectedVersion,
          now?.version ?? null,
          current.status,
          target,
        );
      }

      const version = input.expectedVersion + 1;
      const event = this.#events.append({
        aggregateId: aggregateIdOf('task', current.id),
        type: 'task.review.decided',
        version,
        payload: {
          taskId: current.id,
          reviewerId: actor.agentId,
          decision: input.decision,
          ...(input.comment === undefined ? {} : { comment: input.comment }),
          version,
        },
        ts: at,
        workspaceId,
      });

      const row = this.#tasks.get(current.id, workspaceId);
      if (row === undefined) throw notFoundTask(current.id);
      return { row, event, version };
    });

    return {
      task: toView(persisted.row),
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  /**
   * Reassign an active task to another registered agent. The task returns to
   * `in_progress`; progress and live bids are preserved (audit/history).
   */
  reassign(
    input: ReassignInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): ReassignResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    if (!isReassignableStatus(task.status)) {
      throw invalidTransition(task.id, task.status, 'in_progress');
    }
    if (this.#accounts.get(input.toAgentId, workspaceId) === undefined) {
      throw targetAgentNotFound(input.toAgentId);
    }

    const at = this.#clock();
    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      if (!isReassignableStatus(current.status)) {
        throw invalidTransition(current.id, current.status, 'in_progress');
      }
      if (this.#accounts.get(input.toAgentId, workspaceId) === undefined) {
        throw targetAgentNotFound(input.toAgentId);
      }

      const changes = this.#tasks.updateWithVersion(
        current.id,
        input.expectedVersion,
        { status: 'in_progress', assignee: input.toAgentId },
        { workspaceId, updatedAt: at },
      );
      if (changes === 0) {
        const now = this.#tasks.get(current.id, workspaceId);
        throw versionConflict(
          current.id,
          input.expectedVersion,
          now?.version ?? null,
          current.status,
          'in_progress',
        );
      }

      const version = input.expectedVersion + 1;
      const event = this.#events.append({
        aggregateId: aggregateIdOf('task', current.id),
        type: 'task.reassigned',
        version,
        payload: {
          taskId: current.id,
          fromAgentId: current.assignee ?? undefined,
          toAgentId: input.toAgentId,
          reassignedBy: actor.agentId,
          humanTakeover: actor.agentId === input.toAgentId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          version,
        },
        ts: at,
        workspaceId,
      });

      const row = this.#tasks.get(current.id, workspaceId);
      if (row === undefined) throw notFoundTask(current.id);
      return { row, event, version };
    });

    return {
      task: toView(persisted.row),
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  /** Admin cancellation for open/bidding/in_progress/review tasks. */
  cancel(
    input: CancelInput,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): CancelResult {
    const task = this.#tasks.get(input.taskId, workspaceId);
    if (task === undefined) throw notFoundTask(input.taskId);
    if (!isCancellableStatus(task.status)) {
      throw invalidTransition(task.id, task.status, 'cancelled');
    }

    const at = this.#clock();
    const persisted = withTransaction(this.#db, () => {
      const current = this.#tasks.get(input.taskId, workspaceId);
      if (current === undefined) throw notFoundTask(input.taskId);
      if (!isCancellableStatus(current.status)) {
        throw invalidTransition(current.id, current.status, 'cancelled');
      }
      return this.#cancelWithCas(
        current,
        input.expectedVersion,
        actor.agentId,
        input.reason,
        at,
        workspaceId,
      );
    });

    return {
      task: toView(persisted.row),
      version: persisted.version,
      seq: persisted.event.seq,
    };
  }

  #cancelWithCas(
    task: Task,
    expectedVersion: number,
    cancelledBy: string | undefined,
    reason: string | undefined,
    at: number,
    workspaceId: string,
  ): { row: Task; event: ReturnType<EventStore['append']>; version: number } {
    const changes = this.#tasks.updateWithVersion(
      task.id,
      expectedVersion,
      { status: 'cancelled' },
      { workspaceId, updatedAt: at },
    );
    if (changes === 0) {
      const now = this.#tasks.get(task.id, workspaceId);
      throw versionConflict(
        task.id,
        expectedVersion,
        now?.version ?? null,
        task.status,
        'cancelled',
      );
    }

    const version = expectedVersion + 1;
    const event = this.#events.append({
      aggregateId: aggregateIdOf('task', task.id),
      type: 'task.cancelled',
      version,
      payload: {
        taskId: task.id,
        ...(cancelledBy === undefined ? {} : { cancelledBy }),
        ...(reason === undefined ? {} : { reason }),
        at,
      },
      ts: at,
      workspaceId,
    });

    const row = this.#tasks.get(task.id, workspaceId);
    if (row === undefined) throw notFoundTask(task.id);
    return { row, event, version };
  }

  /** Defensive DAG invariant: walk parent links and reject a cycle. */
  assertParentChainAcyclic(
    taskId: string,
    workspaceId: string = this.#workspaceId,
  ): void {
    const seen = new Set<string>();
    let current: string | null = taskId;
    while (current !== null) {
      if (seen.has(current)) {
        throw parentCycle(current, [...seen, current]);
      }
      seen.add(current);
      const task = this.#tasks.get(current, workspaceId);
      if (task === undefined || task.parentId === null) return;
      current = task.parentId;
    }
  }

  #assertAssignee(task: Task, actor: AuthContext): void {
    if (task.assignee === null || task.assignee !== actor.agentId) {
      throw notAssignee(task.id, task.assignee);
    }
  }

  /**
   * `task.fail` is callable by the assigned agent (awarded/in_progress) and by
   * an admin (awarded/in_progress/review), which is the review → failed escape.
   */
  #assertCanFail(task: Task, actor: AuthContext): void {
    if (actor.role === 'admin') {
      if (!isReassignableStatus(task.status)) {
        throw invalidTransition(task.id, task.status, 'failed');
      }
      return;
    }
    this.#assertAssignee(task, actor);
    if (task.status !== 'awarded' && task.status !== 'in_progress') {
      throw invalidTransition(task.id, task.status, 'failed');
    }
  }

  #assertSubtasksDone(taskId: string, workspaceId: string): void {
    const pending = this.#tasks
      .list({ workspaceId, parentId: taskId })
      .filter((child) => child.status !== 'done')
      .map((child) => child.id);
    if (pending.length > 0) throw subtasksIncomplete(taskId, pending);
  }

  /**
   * Award preconditions with CAS precedence: if the caller's version is stale,
   * the answer is `-32007` even when a concurrent winner already moved the
   * task out of `bidding`. Otherwise a non-bidding task is `-32003`.
   */
  #assertAwardable(task: Task, expectedVersion: number): void {
    if (task.status === 'bidding') return;
    if (task.version > expectedVersion) {
      throw versionConflict(
        task.id,
        expectedVersion,
        task.version,
        'bidding',
        'awarded',
      );
    }
    throw invalidTransition(task.id, task.status, 'awarded');
  }

  /** Skills + finished/active counts for every bidder, used by auto-award. */
  #statsForAgents(
    agentIds: readonly string[],
    workspaceId: string,
  ): Map<string, AgentScoringStats> {
    const stats = new Map<string, AgentScoringStats>();
    for (const agentId of new Set(agentIds)) {
      const account = this.#accounts.get(agentId, workspaceId);
      const finished = this.#tasks.list({
        workspaceId,
        assignee: agentId,
        status: ['done', 'failed'],
      });
      const active = this.#tasks.list({
        workspaceId,
        assignee: agentId,
        status: ['awarded', 'in_progress'],
      });
      stats.set(agentId, {
        skills: account?.skills ?? [],
        completed: finished.filter((task) => task.status === 'done').length,
        failed: finished.filter((task) => task.status === 'failed').length,
        activeTasks: active.length,
      });
    }
    return stats;
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
   * Close expired bidding windows: a `bidding` task whose `biddingDeadline`
   * has passed and that has **no live bids** is cancelled. Tasks with bids stay
   * in `bidding` for an explicit `task.award` (the window only stops new bids).
   *
   * Pure w.r.t. the injected clock, best-effort like `reclaimExpired`.
   */
  closeExpiredBidding(
    now: number = this.#clock(),
    workspaceId: string = this.#workspaceId,
  ): CloseBiddingResult {
    const candidates = this.#tasks.list({ workspaceId, status: 'bidding' });
    const closed: TaskView[] = [];

    for (const task of candidates) {
      const deadline = readBiddingDeadline(task.meta);
      if (deadline === null || deadline > now) continue;
      if (this.#taskBids.count(task.id, { workspaceId }) > 0) continue;
      try {
        const cancelled = withTransaction(this.#db, () =>
          this.#cancelWithCas(
            task,
            task.version,
            undefined,
            'bidding_window_closed',
            now,
            workspaceId,
          ),
        );
        closed.push(toView(cancelled.row));
      } catch (err) {
        if (
          err instanceof ProtocolError &&
          (err.code === JsonRpcErrorCode.VersionConflict ||
            err.code === JsonRpcErrorCode.InvalidState)
        ) {
          continue;
        }
        throw err;
      }
    }

    return { closed, count: closed.length };
  }

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
      const biddingDeadline = readOptionalTimestamp(input, 'biddingDeadline');
      const parentId = readOptionalString(input, 'parentId', 128);
      const result = service.publish(
        {
          title,
          ...(description === undefined ? {} : { description }),
          ...(requiredSkills === undefined ? {} : { requiredSkills }),
          ...(budget === undefined ? {} : { budget }),
          ...(deadline === undefined ? {} : { deadline }),
          ...(biddingDeadline === undefined ? {} : { biddingDeadline }),
          ...(parentId === undefined ? {} : { parentId }),
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

  registry.registerHandler(
    METHODS.task.bid,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_BID_ROLES);
      const input = asParamsObject(params, METHODS.task.bid);
      const taskId = readRequiredString(input, 'taskId', 128);
      const price = readRequiredNonNegativeNumber(input, 'price');
      const eta = readOptionalNonNegativeNumber(input, 'eta');
      const approach = readOptionalString(input, 'approach', MAX_BID_APPROACH_LENGTH);
      const confidence = readOptionalConfidence(input);
      const result = service.placeBid(
        {
          taskId,
          price,
          ...(eta === undefined ? {} : { eta }),
          ...(approach === undefined ? {} : { approach }),
          ...(confidence === undefined ? {} : { confidence }),
        },
        auth,
        ctx.workspaceId,
      );
      // Deliberately no `approach` text in logs (may contain free-form plans).
      ctx.logger.info({
        taskId,
        bidId: result.bid.bidId,
        agentId: auth.agentId,
        price: result.bid.price,
        eta: result.bid.eta,
        msg: 'task.bid.placed',
      });
      return result;
    },
    { description: 'Place or overwrite a bid on an open/bidding task' },
  );

  registry.registerHandler(
    METHODS.task.bids,
    async (ctx, params) => {
      requireRole(ctx, TASK_AWARD_ROLES);
      const input = asParamsObject(params, METHODS.task.bids);
      const taskId = readRequiredString(input, 'taskId', 128);
      return service.listBids(taskId, ctx.workspaceId);
    },
    { description: 'List live bids for a task (admin only)' },
  );

  registry.registerHandler(
    METHODS.task.award,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_AWARD_ROLES);
      const input = asParamsObject(params, METHODS.task.award);
      const taskId = readRequiredString(input, 'taskId', 128);
      const expectedVersion = readRequiredNonNegativeInteger(input, 'expectedVersion');
      const awardeeId = readOptionalString(input, 'awardeeId', 128);
      const strategy = readOptionalStrategy(input);
      if (strategy === 'auto' && awardeeId !== undefined) {
        throw invalidParams(
          "awardeeId must be omitted when strategy is 'auto'",
          'awardeeId',
        );
      }
      if (strategy === 'manual' && awardeeId === undefined) {
        throw invalidParams(
          "awardeeId is required when strategy is 'manual'",
          'awardeeId',
        );
      }
      const result = service.award(
        {
          taskId,
          expectedVersion,
          ...(awardeeId === undefined ? {} : { awardeeId }),
          ...(strategy === undefined ? {} : { strategy }),
        },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        awardeeId: result.awardeeId,
        strategy: result.strategy,
        exploration: result.exploration,
        version: result.version,
        msg: 'task.awarded',
      });
      return result;
    },
    { description: 'Award a bidding task with expectedVersion CAS (admin only)' },
  );

  registry.registerHandler(
    METHODS.task.progress,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_EXECUTION_ROLES);
      const input = asParamsObject(params, METHODS.task.progress);
      const taskId = readRequiredString(input, 'taskId', 128);
      const progress = readProgressValue(input);
      const note = readOptionalString(input, 'note', MAX_PROGRESS_NOTE_LENGTH);
      const artifacts = readOptionalArtifacts(input);
      const result = service.reportProgress(
        {
          taskId,
          progress,
          ...(note === undefined ? {} : { note }),
          ...(artifacts === undefined ? {} : { artifacts }),
        },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        agentId: auth.agentId,
        progress: result.task.progress,
        status: result.task.status,
        version: result.version,
        msg: 'task.progress.updated',
      });
      return result;
    },
    { description: 'Report progress (assigned agent; first report starts the task)' },
  );

  registry.registerHandler(
    METHODS.task.complete,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_EXECUTION_ROLES);
      const input = asParamsObject(params, METHODS.task.complete);
      const taskId = readRequiredString(input, 'taskId', 128);
      const expectedVersion = readRequiredNonNegativeInteger(input, 'expectedVersion');
      const note = readOptionalString(input, 'note', MAX_PROGRESS_NOTE_LENGTH);
      const artifacts = readOptionalArtifacts(input);
      const result = service.complete(
        {
          taskId,
          expectedVersion,
          ...(note === undefined ? {} : { note }),
          ...(artifacts === undefined ? {} : { artifacts }),
        },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        agentId: auth.agentId,
        status: result.task.status,
        version: result.version,
        msg: 'task.completed',
      });
      return result;
    },
    { description: 'Submit for review (assigned agent; all subtasks must be done)' },
  );

  registry.registerHandler(
    METHODS.task.fail,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_EXECUTION_ROLES);
      const input = asParamsObject(params, METHODS.task.fail);
      const taskId = readRequiredString(input, 'taskId', 128);
      const expectedVersion = readRequiredNonNegativeInteger(input, 'expectedVersion');
      const reason = readOptionalString(input, 'reason', MAX_FAIL_REASON_LENGTH);
      const result = service.fail(
        { taskId, expectedVersion, ...(reason === undefined ? {} : { reason }) },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        agentId: auth.agentId,
        status: result.task.status,
        version: result.version,
        msg: 'task.failed',
      });
      return result;
    },
    { description: 'Mark the task failed (assigned agent); blocks a live parent' },
  );

  registry.registerHandler(
    METHODS.task.review,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_AWARD_ROLES);
      const input = asParamsObject(params, METHODS.task.review);
      const taskId = readRequiredString(input, 'taskId', 128);
      const expectedVersion = readRequiredNonNegativeInteger(input, 'expectedVersion');
      const decision = readReviewDecision(input);
      const comment = readOptionalString(input, 'comment', MAX_PROGRESS_NOTE_LENGTH);
      const result = service.review(
        {
          taskId,
          expectedVersion,
          decision,
          ...(comment === undefined ? {} : { comment }),
        },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        agentId: auth.agentId,
        status: result.task.status,
        version: result.version,
        msg: 'task.review.decided',
      });
      return result;
    },
    { description: 'Admin review: approve → done, reject/revision → in_progress' },
  );

  registry.registerHandler(
    METHODS.task.reassign,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_AWARD_ROLES);
      const input = asParamsObject(params, METHODS.task.reassign);
      const taskId = readRequiredString(input, 'taskId', 128);
      const expectedVersion = readRequiredNonNegativeInteger(input, 'expectedVersion');
      const toAgentId = readRequiredString(input, 'toAgentId', 128);
      const reason = readOptionalString(input, 'reason', MAX_FAIL_REASON_LENGTH);
      const result = service.reassign(
        {
          taskId,
          expectedVersion,
          toAgentId,
          ...(reason === undefined ? {} : { reason }),
        },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        agentId: auth.agentId,
        assignee: result.task.assignee,
        version: result.version,
        msg: 'task.reassigned',
      });
      return result;
    },
    { description: 'Admin reassign to another registered agent (returns to in_progress)' },
  );

  registry.registerHandler(
    METHODS.task.cancel,
    async (ctx, params) => {
      const auth = requireRole(ctx, TASK_AWARD_ROLES);
      const input = asParamsObject(params, METHODS.task.cancel);
      const taskId = readRequiredString(input, 'taskId', 128);
      const expectedVersion = readRequiredNonNegativeInteger(input, 'expectedVersion');
      const reason = readOptionalString(input, 'reason', MAX_FAIL_REASON_LENGTH);
      const result = service.cancel(
        { taskId, expectedVersion, ...(reason === undefined ? {} : { reason }) },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        taskId,
        agentId: auth.agentId,
        status: result.task.status,
        version: result.version,
        msg: 'task.cancelled',
      });
      return result;
    },
    { description: 'Admin cancel an open/bidding/in_progress/review task' },
  );

  return service;
}
