import { EventStore } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS } from '@agentmesh/protocol';
import { openStore, type Repositories } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

import { createTokenService, type TokenService } from '../src/auth/token.js';
import type { DispatchContext, DispatchOutcome } from '../src/dispatcher.js';
import { RpcDispatcher } from '../src/dispatcher.js';
import { registerAccountsModule } from '../src/modules/accounts.js';
import {
  registerTasksModule,
  type AwardResult,
  type CancelResult,
  type CompleteResult,
  type ProgressResult,
  type ReassignResult,
  type ReviewResult,
  type TaskView,
} from '../src/modules/tasks.js';
import { createHandlerRegistry } from '../src/registry.js';
import { silentLogger } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';
const CLOCK = 1_700_000_000_000;

interface Actor {
  agentId: string;
  token: string;
}

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  repos: Repositories;
  events: EventStore;
  tokens: TokenService;
  clock: { now: number };
  call: (method: string, params?: unknown, ctx?: DispatchContext) => Promise<DispatchOutcome>;
  register: (
    name: string,
    role?: 'admin' | 'agent' | 'observer',
    skills?: string[],
  ) => Promise<Actor>;
  publish: (token: string, params?: Record<string, unknown>) => Promise<DispatchOutcome>;
  bid: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  award: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  progress: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  complete: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  fail: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  review: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  reassign: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  cancel: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  taskVersion: (taskId: string, token: string) => Promise<number>;
  taskLog: (taskId: string) => ReturnType<EventStore['loadAggregate']>;
}

function makeHarness(): Harness {
  const { db, repos } = openStore(':memory:');
  const clock = { now: CLOCK };
  const events = new EventStore(db, { clock: () => clock.now });
  const tokens = createTokenService({ secret: SECRET, clock: () => clock.now });
  const registry = createHandlerRegistry();
  let agentCounter = 0;
  let taskCounter = 0;

  registerAccountsModule(registry, {
    db,
    accounts: repos.accounts,
    events,
    tokens,
    allowAdminSelfRegister: true,
    idFactory: () => {
      agentCounter += 1;
      return `agt_${agentCounter}`;
    },
    clock: () => clock.now,
  });

  registerTasksModule(registry, {
    db,
    tasks: repos.tasks,
    taskBids: repos.taskBids,
    accounts: repos.accounts,
    events,
    idFactory: () => {
      taskCounter += 1;
      return `tsk_${taskCounter}`;
    },
    clock: () => clock.now,
  });

  const dispatcher = new RpcDispatcher({
    registry,
    logger: silentLogger(),
    tokenVerifier: (token) => tokens.verify(token),
  });
  const call: Harness['call'] = (method, params = {}, ctx = {}) =>
    dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method, params }, ctx);

  const register: Harness['register'] = async (name, role = 'agent', skills = []) =>
    resultOf<Actor>(await call(METHODS.agent.register, { name, role, skills }, {}));

  const publish: Harness['publish'] = (token, params = {}) =>
    call(
      METHODS.task.publish,
      {
        title: 'task',
        requiredSkills: ['typescript'],
        biddingDeadline: CLOCK + 1_000_000,
        ...params,
      },
      { token },
    );
  const bid: Harness['bid'] = (token, params) => call(METHODS.task.bid, params, { token });
  const award: Harness['award'] = (token, params) =>
    call(METHODS.task.award, params, { token });
  const progress: Harness['progress'] = (token, params) =>
    call(METHODS.task.progress, params, { token });
  const complete: Harness['complete'] = (token, params) =>
    call(METHODS.task.complete, params, { token });
  const fail: Harness['fail'] = (token, params) =>
    call(METHODS.task.fail, params, { token });
  const review: Harness['review'] = (token, params) =>
    call(METHODS.task.review, params, { token });
  const reassign: Harness['reassign'] = (token, params) =>
    call(METHODS.task.reassign, params, { token });
  const cancel: Harness['cancel'] = (token, params) =>
    call(METHODS.task.cancel, params, { token });
  const taskVersion: Harness['taskVersion'] = async (taskId, token) =>
    resultOf<TaskView>(await call(METHODS.task.get, { taskId }, { token })).version;
  const taskLog: Harness['taskLog'] = (taskId) => events.loadAggregate(`task:${taskId}`);

  return {
    db,
    repos,
    events,
    tokens,
    clock,
    call,
    register,
    publish,
    bid,
    award,
    progress,
    complete,
    fail,
    review,
    reassign,
    cancel,
    taskVersion,
    taskLog,
  };
}

function resultOf<T>(outcome: DispatchOutcome): T {
  expect(outcome.response?.error).toBeUndefined();
  return outcome.response?.result as T;
}

function errorOf(outcome: DispatchOutcome): { code: number; message: string; data?: unknown } {
  const error = outcome.response?.error;
  expect(error).toBeDefined();
  return error as { code: number; message: string; data?: unknown };
}

async function setupAwarded(h: Harness): Promise<{
  task: TaskView;
  worker: Actor;
  admin: Actor;
}> {
  const admin = await h.register('admin', 'admin');
  const worker = await h.register('worker', 'agent', ['typescript']);
  const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
  await h.bid(worker.token, { taskId: task.id, price: 100 });
  const version = await h.taskVersion(task.id, admin.token);
  const awarded = resultOf<AwardResult>(
    await h.award(admin.token, {
      taskId: task.id,
      expectedVersion: version,
      awardeeId: worker.agentId,
    }),
  );
  return { task: awarded.task, worker, admin };
}

async function setupReview(h: Harness): Promise<{
  task: TaskView;
  worker: Actor;
  admin: Actor;
}> {
  const { task, worker, admin } = await setupAwarded(h);
  const started = resultOf<ProgressResult>(
    await h.progress(worker.token, { taskId: task.id, progress: 50 }),
  );
  const completed = resultOf<CompleteResult>(
    await h.complete(worker.token, {
      taskId: task.id,
      expectedVersion: started.version,
      note: 'ready',
    }),
  );
  return { task: completed.task, worker, admin };
}

describe('task.review', () => {
  it('approve -> done with completedAt and a task.review.decided event', async () => {
    const h = makeHarness();
    const { task, admin } = await setupReview(h);

    const reviewed = resultOf<ReviewResult>(
      await h.review(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        decision: 'approve',
        comment: 'looks good',
      }),
    );

    expect(reviewed.task).toMatchObject({
      status: 'done',
      progress: 100,
      completedAt: CLOCK,
      version: task.version + 1,
    });
    expect(h.repos.tasks.get(task.id)).toMatchObject({
      status: 'done',
      completedAt: CLOCK,
    });
    const event = h.taskLog(task.id).at(-1);
    expect(event?.type).toBe('task.review.decided');
    expect(event?.payload).toMatchObject({
      taskId: task.id,
      reviewerId: admin.agentId,
      decision: 'approve',
      comment: 'looks good',
    });
  });

  it.each(['reject', 'request-revision'] as const)(
    '%s -> in_progress and preserves progress',
    async (decision) => {
      const h = makeHarness();
      const { task, admin } = await setupReview(h);

      const reviewed = resultOf<ReviewResult>(
        await h.review(admin.token, {
          taskId: task.id,
          expectedVersion: task.version,
          decision,
        }),
      );
      expect(reviewed.task).toMatchObject({
        status: 'in_progress',
        progress: 100,
        version: task.version + 1,
      });
      expect(reviewed.task.completedAt).toBeNull();
      expect(h.repos.tasks.get(task.id)?.status).toBe('in_progress');
    },
  );

  it('allows an admin to fail a review task explicitly', async () => {
    const h = makeHarness();
    const { task, admin } = await setupReview(h);

    const failed = resultOf<{ task: TaskView }>(
      await h.fail(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        reason: 'requirements withdrawn',
      }),
    );
    expect(failed.task.status).toBe('failed');
    expect(h.taskLog(task.id).at(-1)?.type).toBe('task.failed');
  });

  it('rejects non-admin callers, non-review states and stale versions', async () => {
    const h = makeHarness();
    const { task, worker, admin } = await setupReview(h);

    const forbidden = errorOf(
      await h.review(worker.token, {
        taskId: task.id,
        expectedVersion: task.version,
        decision: 'approve',
      }),
    );
    expect(forbidden.code).toBe(JsonRpcErrorCode.Forbidden);

    const stale = errorOf(
      await h.review(admin.token, {
        taskId: task.id,
        expectedVersion: task.version - 1,
        decision: 'approve',
      }),
    );
    expect(stale.code).toBe(JsonRpcErrorCode.VersionConflict);

    const missing = errorOf(
      await h.review(admin.token, {
        taskId: 'tsk_missing',
        expectedVersion: 1,
        decision: 'approve',
      }),
    );
    expect(missing.code).toBe(JsonRpcErrorCode.NotFound);

    // A second review on a now-done task is an invalid state.
    resultOf<ReviewResult>(
      await h.review(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        decision: 'approve',
      }),
    );
    const invalid = errorOf(
      await h.review(admin.token, {
        taskId: task.id,
        expectedVersion: task.version + 1,
        decision: 'reject',
      }),
    );
    expect(invalid.code).toBe(JsonRpcErrorCode.InvalidState);
  });
});

describe('task.reassign', () => {
  it('moves an awarded task to in_progress under a registered agent', async () => {
    const h = makeHarness();
    const { task, admin, worker } = await setupAwarded(h);
    const next = await h.register('next-owner', 'agent', ['typescript']);

    const reassigned = resultOf<ReassignResult>(
      await h.reassign(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        toAgentId: next.agentId,
        reason: 'handoff',
      }),
    );

    expect(reassigned.task).toMatchObject({
      status: 'in_progress',
      assignee: next.agentId,
      version: task.version + 1,
    });
    const event = h.taskLog(task.id).at(-1);
    expect(event?.type).toBe('task.reassigned');
    expect(event?.payload).toMatchObject({
      taskId: task.id,
      toAgentId: next.agentId,
      reassignedBy: admin.agentId,
      humanTakeover: false,
    });

    const oldOwner = errorOf(
      await h.progress(worker.token, { taskId: task.id, progress: 10 }),
    );
    expect(oldOwner.code).toBe(JsonRpcErrorCode.Forbidden);
    const newOwnerProgress = resultOf<ProgressResult>(
      await h.progress(next.token, { taskId: task.id, progress: 10 }),
    );
    expect(newOwnerProgress.task.assignee).toBe(next.agentId);
  });

  it('rejects unknown target agents with -32004 and stale versions with -32007', async () => {
    const h = makeHarness();
    const { task, admin } = await setupAwarded(h);

    const missing = errorOf(
      await h.reassign(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        toAgentId: 'agt_missing',
      }),
    );
    expect(missing.code).toBe(JsonRpcErrorCode.NotFound);
    expect(missing.data).toMatchObject({ reason: 'target_not_found' });

    const next = await h.register('next-owner-2', 'agent', ['typescript']);
    const stale = errorOf(
      await h.reassign(admin.token, {
        taskId: task.id,
        expectedVersion: task.version - 1,
        toAgentId: next.agentId,
      }),
    );
    expect(stale.code).toBe(JsonRpcErrorCode.VersionConflict);
  });

  it('marks an admin self-takeover as humanTakeover', async () => {
    const h = makeHarness();
    const { task, admin } = await setupAwarded(h);

    const reassigned = resultOf<ReassignResult>(
      await h.reassign(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        toAgentId: admin.agentId,
      }),
    );
    expect(reassigned.task.assignee).toBe(admin.agentId);
    expect(h.taskLog(task.id).at(-1)?.payload).toMatchObject({
      humanTakeover: true,
    });
  });

  it('rejects non-admin callers with -32002', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const denied = errorOf(
      await h.reassign(worker.token, {
        taskId: task.id,
        expectedVersion: task.version,
        toAgentId: worker.agentId,
      }),
    );
    expect(denied.code).toBe(JsonRpcErrorCode.Forbidden);
  });
});

describe('task.cancel', () => {
  it.each([
    ['open', false],
    ['bidding', true],
  ] as const)('cancels a %s task', async (state, withWindow) => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const task = resultOf<{ task: TaskView }>(
      await h.publish(
        admin.token,
        withWindow ? {} : { biddingDeadline: undefined },
      ),
    ).task;
    expect(task.status).toBe(state);

    const cancelled = resultOf<CancelResult>(
      await h.cancel(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        reason: 'no longer needed',
      }),
    );
    expect(cancelled.task).toMatchObject({
      status: 'cancelled',
      version: task.version + 1,
    });
    const event = h.taskLog(task.id).at(-1);
    expect(event?.type).toBe('task.cancelled');
    expect(event?.payload).toMatchObject({
      taskId: task.id,
      cancelledBy: admin.agentId,
      reason: 'no longer needed',
    });
  });

  it('cancels in_progress and review tasks but not terminal tasks', async () => {
    const h = makeHarness();
    const { task, worker, admin } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 30 }),
    );
    const cancelled = resultOf<CancelResult>(
      await h.cancel(admin.token, {
        taskId: task.id,
        expectedVersion: started.version,
      }),
    );
    expect(cancelled.task.status).toBe('cancelled');

    const secondHarness = makeHarness();
    const second = await setupReview(secondHarness);
    const cancelledReview = resultOf<CancelResult>(
      await secondHarness.cancel(second.admin.token, {
        taskId: second.task.id,
        expectedVersion: second.task.version,
      }),
    );
    expect(cancelledReview.task.status).toBe('cancelled');

    const thirdHarness = makeHarness();
    const third = await setupReview(thirdHarness);
    resultOf<ReviewResult>(
      await thirdHarness.review(third.admin.token, {
        taskId: third.task.id,
        expectedVersion: third.task.version,
        decision: 'approve',
      }),
    );
    const terminal = errorOf(
      await thirdHarness.cancel(third.admin.token, {
        taskId: third.task.id,
        expectedVersion: third.task.version + 1,
      }),
    );
    expect(terminal.code).toBe(JsonRpcErrorCode.InvalidState);
  });

  it('rejects non-admin callers with -32002', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent');
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    const denied = errorOf(
      await h.cancel(worker.token, {
        taskId: task.id,
        expectedVersion: task.version,
      }),
    );
    expect(denied.code).toBe(JsonRpcErrorCode.Forbidden);
  });
});
