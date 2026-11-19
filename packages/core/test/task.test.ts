import type { EventType } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';

import { initialTaskState, reduceTask, taskReducer } from '../src/index.js';
import { makeEvent } from './helpers.js';

const AGG = 'task:tsk_1';

function lifecycle(steps: Array<{ type: EventType; payload: unknown }>) {
  return steps.map((step, index) =>
    makeEvent({
      seq: index + 1,
      version: index + 1,
      type: step.type,
      aggregateId: AGG,
      ts: 1000 + index,
      payload: step.payload,
    }),
  );
}

describe('taskReducer', () => {
  it('folds the full happy-path lifecycle', () => {
    const state = reduceTask(
      AGG,
      lifecycle([
        {
          type: 'task.published',
          payload: {
            taskId: 'tsk_1',
            title: 'build the thing',
            description: 'do it',
            requiredSkills: ['ts', 'sqlite'],
            budget: 100,
            parentId: 'task:tsk_0',
            deadline: 9999,
          },
        },
        {
          type: 'task.bid.placed',
          payload: { bidId: 'bid_1', agentId: 'agt_1', price: 50, eta: 30, confidence: 0.8 },
        },
        {
          type: 'task.bid.received',
          payload: { bidId: 'bid_2', agentId: 'agt_2', price: 60 },
        },
        {
          type: 'task.awarded',
          payload: {
            taskId: 'tsk_1',
            awardeeId: 'agt_1',
            awardedBy: 'agt_admin',
            exploration: true,
            strategy: 'auto',
          },
        },
        {
          type: 'task.progress.reported',
          payload: { taskId: 'tsk_1', agentId: 'agt_1', progress: 40 },
        },
        {
          type: 'task.review.decided',
          payload: {
            taskId: 'tsk_1',
            reviewerId: 'agt_admin',
            decision: 'request-revision',
            comment: 'fix tests',
          },
        },
        {
          type: 'task.completed',
          payload: { taskId: 'tsk_1' },
        },
      ]),
    );

    expect(state).toMatchObject({
      id: 'tsk_1',
      exists: true,
      title: 'build the thing',
      description: 'do it',
      requiredSkills: ['ts', 'sqlite'],
      budget: 100,
      parentId: 'task:tsk_0',
      deadline: 9999,
      status: 'done',
      assignee: 'agt_1',
      awardedBy: 'agt_admin',
      exploration: true,
      reviewDecision: 'request-revision',
      reviewComment: 'fix tests',
      progress: 100,
      version: 7,
      lastSeq: 7,
    });
    expect(Object.keys(state.bids).sort()).toEqual(['bid_1', 'bid_2']);
    expect(state.bids['bid_1']).toMatchObject({ agentId: 'agt_1', price: 50, eta: 30 });
    expect(state.bids['bid_2']).toMatchObject({ agentId: 'agt_2', price: 60, eta: null });
    expect(state.completedAt).toBe(1006);
    expect(state.createdAt).toBe(1000);
  });

  it('publishes as open by default and ignores invalid statuses', () => {
    const state = taskReducer(
      initialTaskState(AGG),
      makeEvent({
        seq: 1,
        version: 1,
        type: 'task.published',
        aggregateId: AGG,
        ts: 77,
        payload: { title: 'x', status: 'not-a-status' },
      }),
    );
    expect(state.status).toBe('open');
    expect(state.createdAt).toBe(77);
    expect(state.updatedAt).toBe(77);
    expect(state.budget).toBeNull();
  });

  it('award moves to awarded, progress starts in_progress, progress is clamped', () => {
    let state = initialTaskState(AGG);
    state = taskReducer(
      state,
      makeEvent({
        seq: 1,
        version: 1,
        type: 'task.published',
        aggregateId: AGG,
        payload: { title: 'x' },
      }),
    );
    state = taskReducer(
      state,
      makeEvent({
        seq: 2,
        version: 2,
        type: 'task.awarded',
        aggregateId: AGG,
        payload: { awardeeId: 'agt_1', awardedBy: 'admin' },
      }),
    );
    expect(state.status).toBe('awarded');
    expect(state.exploration).toBe(false);

    state = taskReducer(
      state,
      makeEvent({
        seq: 3,
        version: 3,
        type: 'task.progress.updated',
        aggregateId: AGG,
        payload: { progress: 250 },
      }),
    );
    expect(state.status).toBe('in_progress');
    expect(state.progress).toBe(100);
  });

  it('maps review decisions to terminal/intermediate statuses', () => {
    const review = (decision: string) => {
      let state = initialTaskState(AGG);
      state = taskReducer(
        state,
        makeEvent({
          seq: 1,
          version: 1,
          type: 'task.published',
          aggregateId: AGG,
          payload: { title: 'x' },
        }),
      );
      return taskReducer(
        state,
        makeEvent({
          seq: 2,
          version: 2,
          type: 'task.review.decided',
          aggregateId: AGG,
          payload: { reviewerId: 'admin', decision },
        }),
      );
    };
    expect(review('approve').status).toBe('done');
    expect(review('reject').status).toBe('in_progress');
    expect(review('reject').version).toBe(2);
    expect(review('request-revision').status).toBe('in_progress');
    expect(review('unheard-of').status).toBe('open');
  });

  it('opens bidding on the first bid and never reopens an awarded task', () => {
    let state = taskReducer(
      initialTaskState(AGG),
      makeEvent({
        seq: 1,
        version: 1,
        type: 'task.published',
        aggregateId: AGG,
        payload: { title: 'x' },
      }),
    );
    state = taskReducer(
      state,
      makeEvent({
        seq: 2,
        version: 2,
        type: 'task.bid.placed',
        aggregateId: AGG,
        payload: { bidId: 'bid_1', agentId: 'agt_1', price: 10 },
      }),
    );
    expect(state.status).toBe('bidding');

    state = taskReducer(
      state,
      makeEvent({
        seq: 3,
        version: 3,
        type: 'task.awarded',
        aggregateId: AGG,
        payload: { awardeeId: 'agt_1', awardedBy: 'admin' },
      }),
    );
    state = taskReducer(
      state,
      makeEvent({
        seq: 4,
        version: 4,
        type: 'task.bid.placed',
        aggregateId: AGG,
        payload: { bidId: 'bid_2', agentId: 'agt_2', price: 5 },
      }),
    );
    expect(state.status).toBe('awarded');
    expect(state.assignee).toBe('agt_1');
  });

  it('records failures, reassignments and blocked dependencies', () => {
    const events = lifecycle([
      { type: 'task.published', payload: { title: 'x' } },
      {
        type: 'task.dependency.failed',
        payload: { parentTaskId: 'tsk_1', subtaskId: 'tsk_2', blockedBy: ['tsk_3', 'tsk_4'] },
      },
      {
        type: 'task.dependency.failed',
        payload: { parentTaskId: 'tsk_1', subtaskId: 'tsk_5', blockedBy: ['tsk_4', 'tsk_6'] },
      },
      { type: 'task.reassigned', payload: { toAgentId: 'agt_9', reassignedBy: 'admin' } },
      { type: 'task.failed', payload: { taskId: 'tsk_1', reason: 'quota exceeded' } },
    ]);
    const state = reduceTask(AGG, events);

    expect(state.blockedBy).toEqual(['tsk_3', 'tsk_4', 'tsk_6']);
    expect(state.assignee).toBe('agt_9');
    expect(state.status).toBe('failed');
    expect(state.failureReason).toBe('quota exceeded');
  });

  it('ignores malformed bid / reassignment payloads without throwing', () => {
    let state = initialTaskState(AGG);
    for (const type of ['task.bid.placed', 'task.bid.received', 'task.reassigned'] as const) {
      state = taskReducer(
        state,
        makeEvent({ seq: 1, version: 1, type, aggregateId: AGG, payload: {} }),
      );
    }
    expect(state.bids).toEqual({});
    expect(state.assignee).toBeNull();
    expect(state.version).toBe(1);
  });
});
