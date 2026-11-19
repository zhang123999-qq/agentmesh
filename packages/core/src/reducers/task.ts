/**
 * Task aggregate reducer — the richest projection in the MVP.
 *
 * It folds the task lifecycle (`published → bidding → awarded → in_progress →
 * review → done|failed`), the bid set (OR-Set semantics; tombstones are a
 * storage concern, replay only ever records placements here) and progress
 * reports into one plain-object state.
 *
 * Review decisions map to statuses as follows (MVP policy):
 *   - `approve`          → `done`
 *   - `reject`           → `failed`
 *   - `request-revision` → `in_progress`
 * A later `task.completed` / `task.failed` event always wins because it is a
 * later event in the log.
 */

import { TASK_STATUSES, type TaskStatus } from '@agentmesh/store';

import type { CoreEvent } from '../envelope.js';
import {
  asRecord,
  readBoolean,
  readNumber,
  readOneOf,
  readString,
  readStringArray,
} from '../payload.js';
import type { Reducer } from '../reducer.js';

export interface TaskBidState {
  bidId: string;
  agentId: string;
  price: number;
  /** Estimated duration in minutes. */
  eta: number | null;
  approach: string | null;
  confidence: number | null;
  createdAt: number | null;
}

export interface TaskState {
  aggregateId: string;
  id: string;
  exists: boolean;
  title: string | null;
  description: string | null;
  requiredSkills: string[];
  budget: number | null;
  status: TaskStatus | null;
  assignee: string | null;
  parentId: string | null;
  deadline: number | null;
  blockedBy: string[];
  bids: Record<string, TaskBidState>;
  /** 0-100, `null` until the first progress report. */
  progress: number | null;
  awardedBy: string | null;
  /** True when the award came from the cold-start exploration branch. */
  exploration: boolean;
  reviewDecision: string | null;
  reviewComment: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  failureReason: string | null;
  version: number;
  lastSeq: number;
}

export function initialTaskState(aggregateId: string): TaskState {
  return {
    aggregateId,
    id: aggregateId.slice(aggregateId.indexOf(':') + 1),
    exists: false,
    title: null,
    description: null,
    requiredSkills: [],
    budget: null,
    status: null,
    assignee: null,
    parentId: null,
    deadline: null,
    blockedBy: [],
    bids: {},
    progress: null,
    awardedBy: null,
    exploration: false,
    reviewDecision: null,
    reviewComment: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    failureReason: null,
    version: 0,
    lastSeq: 0,
  };
}

const REVIEW_STATUS: Record<string, TaskStatus> = {
  approve: 'done',
  // `reject` means "not acceptable as-is": the task goes back for rework or
  // reassignment. A terminal failure is an explicit admin choice (`failed`),
  // not the default reject outcome (US-013).
  reject: 'in_progress',
  'request-revision': 'in_progress',
};

function clampProgress(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return Math.min(100, Math.max(0, value));
}

export const taskReducer: Reducer<TaskState> = (state, event: CoreEvent) => {
  const payload = asRecord(event.payload);
  const next: TaskState = { ...state, version: event.version, lastSeq: event.seq };

  switch (event.type) {
    case 'task.published': {
      const createdAt = readNumber(payload, 'createdAt') ?? event.ts;
      return {
        ...next,
        exists: true,
        title: readString(payload, 'title') ?? next.title,
        description: readString(payload, 'description') ?? next.description,
        requiredSkills: readStringArray(payload, 'requiredSkills') ?? next.requiredSkills,
        budget: readNumber(payload, 'budget') ?? next.budget,
        status: readOneOf(payload, 'status', TASK_STATUSES) ?? 'open',
        parentId: readString(payload, 'parentId') ?? next.parentId,
        deadline: readNumber(payload, 'deadline') ?? next.deadline,
        createdAt,
        updatedAt: createdAt,
      };
    }

    /**
     * Generic lifecycle step written by the US-008 transition table. The
     * milestone events below (`task.awarded`, `task.completed`, …) still carry
     * their own richer payloads; this case keeps replayed state in sync when a
     * transition has no dedicated event (e.g. `open → bidding`, `cancelled`).
     */
    case 'task.status.changed': {
      const status = readOneOf(payload, 'to', TASK_STATUSES);
      if (status === undefined) {
        return next;
      }
      return {
        ...next,
        status,
        updatedAt: readNumber(payload, 'at') ?? event.ts,
      };
    }

    case 'task.bid.placed':
    case 'task.bid.received': {
      const bidId = readString(payload, 'bidId');
      const agentId = readString(payload, 'agentId');
      if (!bidId || !agentId) {
        return next;
      }
      return {
        ...next,
        bids: {
          ...next.bids,
          [bidId]: {
            bidId,
            agentId,
            price: readNumber(payload, 'price') ?? 0,
            eta: readNumber(payload, 'eta') ?? null,
            approach: readString(payload, 'approach') ?? null,
            confidence: readNumber(payload, 'confidence') ?? null,
            createdAt: readNumber(payload, 'createdAt') ?? event.ts,
          },
        },
        updatedAt: event.ts,
      };
    }

    case 'task.awarded': {
      return {
        ...next,
        status: 'awarded',
        assignee: readString(payload, 'awardeeId') ?? next.assignee,
        awardedBy: readString(payload, 'awardedBy') ?? next.awardedBy,
        exploration: readBoolean(payload, 'exploration') ?? next.exploration,
        updatedAt: event.ts,
      };
    }

    case 'task.progress.reported':
    case 'task.progress.updated': {
      const progress = clampProgress(readNumber(payload, 'progress'));
      const started =
        next.status === 'awarded' || next.status === 'open' || next.status === 'bidding';
      return {
        ...next,
        progress: progress ?? next.progress,
        status: started ? 'in_progress' : next.status,
        updatedAt: event.ts,
      };
    }

    case 'task.review.decided': {
      const decision = readString(payload, 'decision') ?? null;
      const mappedStatus = decision !== null ? REVIEW_STATUS[decision] : undefined;
      return {
        ...next,
        reviewDecision: decision,
        reviewComment: readString(payload, 'comment') ?? next.reviewComment,
        status: mappedStatus ?? next.status,
        updatedAt: event.ts,
      };
    }

    case 'task.completed': {
      return {
        ...next,
        status: 'done',
        progress: 100,
        completedAt: event.ts,
        updatedAt: event.ts,
      };
    }

    case 'task.failed': {
      return {
        ...next,
        status: 'failed',
        failureReason: readString(payload, 'reason') ?? readString(payload, 'error') ?? null,
        updatedAt: event.ts,
      };
    }

    case 'task.reassigned': {
      const toAgentId = readString(payload, 'toAgentId');
      if (!toAgentId) {
        return next;
      }
      const needsAward =
        next.status === null ||
        next.status === 'draft' ||
        next.status === 'open' ||
        next.status === 'bidding';
      return {
        ...next,
        assignee: toAgentId,
        status: needsAward ? 'awarded' : next.status,
        updatedAt: event.ts,
      };
    }

    case 'task.dependency.failed': {
      const blockedBy = readStringArray(payload, 'blockedBy');
      if (!blockedBy) {
        return next;
      }
      const merged = [...next.blockedBy];
      for (const id of blockedBy) {
        if (!merged.includes(id)) {
          merged.push(id);
        }
      }
      return { ...next, blockedBy: merged, updatedAt: event.ts };
    }

    default:
      return next;
  }
};

export function reduceTask(aggregateId: string, events: readonly CoreEvent[]): TaskState {
  return events.reduce<TaskState>(taskReducer, initialTaskState(aggregateId));
}
