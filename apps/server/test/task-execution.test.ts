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
  type CompleteResult,
  type FailResult,
  type ProgressResult,
  type TasksService,
  type TaskView,
} from '../src/modules/tasks.js';
import { createHandlerRegistry } from '../src/registry.js';
import { silentLogger } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';
const CLOCK = 1_700_000_000_000;

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  repos: Repositories;
  events: EventStore;
  tokens: TokenService;
  service: TasksService;
  clock: { now: number };
  call: (method: string, params?: unknown, ctx?: DispatchContext) => Promise<DispatchOutcome>;
  register: (
    name: string,
    role?: 'admin' | 'agent' | 'observer',
    skills?: string[],
  ) => Promise<{ agentId: string; token: string }>;
  publish: (token: string, params?: Record<string, unknown>) => Promise<DispatchOutcome>;
  bid: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  award: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  progress: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  complete: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
  fail: (token: string, params: Record<string, unknown>) => Promise<DispatchOutcome>;
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

  const service = registerTasksModule(registry, {
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
    resultOf<{ agentId: string; token: string }>(
      await call(METHODS.agent.register, { name, role, skills }, {}),
    );

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
  const bid: Harness['bid'] = (token, params) =>
    call(METHODS.task.bid, params, { token });
  const award: Harness['award'] = (token, params) =>
    call(METHODS.task.award, params, { token });
  const progress: Harness['progress'] = (token, params) =>
    call(METHODS.task.progress, params, { token });
  const complete: Harness['complete'] = (token, params) =>
    call(METHODS.task.complete, params, { token });
  const fail: Harness['fail'] = (token, params) =>
    call(METHODS.task.fail, params, { token });
  const taskVersion: Harness['taskVersion'] = async (taskId, token) =>
    resultOf<TaskView>(await call(METHODS.task.get, { taskId }, { token })).version;
  const taskLog: Harness['taskLog'] = (taskId) =>
    events.loadAggregate(`task:${taskId}`);

  return {
    db,
    repos,
    events,
    tokens,
    service,
    clock,
    call,
    register,
    publish,
    bid,
    award,
    progress,
    complete,
    fail,
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

interface AwardedTask {
  task: TaskView;
  worker: { agentId: string; token: string };
  admin: { agentId: string; token: string };
}

async function setupAwarded(
  h: Harness,
  options: { parentId?: string; workerName?: string } = {},
): Promise<AwardedTask> {
  const admin = await h.register('admin', 'admin');
  const worker = await h.register(options.workerName ?? 'worker', 'agent', ['typescript']);
  const task = resultOf<{ task: TaskView }>(
    await h.publish(
      admin.token,
      options.parentId === undefined ? {} : { parentId: options.parentId },
    ),
  ).task;
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

describe('task.progress', () => {
  it('starts the task on first progress and never bumps version afterwards', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    expect(task.status).toBe('awarded');

    const first = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 0 }),
    );
    expect(first.task.status).toBe('in_progress');
    expect(first.task.progress).toBe(0);
    expect(first.version).toBe(task.version + 1);

    for (let value = 10; value <= 100; value += 10) {
      const reported = resultOf<ProgressResult>(
        await h.progress(worker.token, { taskId: task.id, progress: value }),
      );
      expect(reported.version).toBe(first.version);
    }

    expect(h.repos.tasks.get(task.id)?.version).toBe(first.version);
    expect(h.repos.tasks.get(task.id)?.progress).toBe(100);
    expect(
      h.taskLog(task.id).filter((event) => event.type === 'task.progress.updated'),
    ).toHaveLength(11);
  });

  it('accepts concurrent progress reports and keeps the version stable', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 10 }),
    );

    const outcomes = await Promise.all([
      h.progress(worker.token, { taskId: task.id, progress: 30 }),
      h.progress(worker.token, { taskId: task.id, progress: 70 }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.response?.error).toBeUndefined();
    }
    const row = h.repos.tasks.get(task.id);
    expect(row?.version).toBe(started.version);
    expect([30, 70]).toContain(row?.progress);
  });

  it('validates progress and artifact inputs with -32602', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    await h.progress(worker.token, { taskId: task.id, progress: 10 });

    for (const params of [
      { taskId: task.id, progress: -1 },
      { taskId: task.id, progress: 101 },
      { taskId: task.id, progress: '50' },
      { taskId: task.id, progress: 50, artifacts: 'not-an-array' },
      { taskId: task.id, progress: 50, artifacts: [''] },
    ]) {
      const error = errorOf(await h.progress(worker.token, params));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    }
  });

  it('rejects progress outside awarded/in_progress', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    const bidding = errorOf(
      await h.progress(worker.token, { taskId: task.id, progress: 10 }),
    );
    // Nobody is assigned while bidding, so the assignee check fires first.
    expect(bidding.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(bidding.data).toMatchObject({ reason: 'not_assignee' });

    // Move through award + progress + complete, then progress is illegal.
    await h.bid(worker.token, { taskId: task.id, price: 100 });
    const version = await h.taskVersion(task.id, admin.token);
    resultOf<AwardResult>(
      await h.award(admin.token, {
        taskId: task.id,
        expectedVersion: version,
        awardeeId: worker.agentId,
      }),
    );
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 50 }),
    );
    resultOf<CompleteResult>(
      await h.complete(worker.token, {
        taskId: task.id,
        expectedVersion: started.version,
      }),
    );
    const review = errorOf(
      await h.progress(worker.token, { taskId: task.id, progress: 60 }),
    );
    expect(review.code).toBe(JsonRpcErrorCode.InvalidState);
  });

  it('rejects a non-assignee with -32002', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const outsider = await h.register('outsider', 'agent', ['typescript']);

    const denied = errorOf(
      await h.progress(outsider.token, { taskId: task.id, progress: 10 }),
    );
    expect(denied.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(denied.data).toMatchObject({ reason: 'not_assignee' });

    const adminFresh = await h.register('admin-2', 'admin');
    const adminDenied = errorOf(
      await h.progress(adminFresh.token, { taskId: task.id, progress: 10 }),
    );
    expect(adminDenied.code).toBe(JsonRpcErrorCode.Forbidden);

    void worker;
  });
});

describe('task.complete', () => {
  it('moves in_progress -> review and emits task.completed with artifacts', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 50 }),
    );

    const completed = resultOf<CompleteResult>(
      await h.complete(worker.token, {
        taskId: task.id,
        expectedVersion: started.version,
        artifacts: ['https://artifacts.example/tsk_1.zip'],
        note: 'ready for review',
      }),
    );

    expect(completed.task).toMatchObject({
      status: 'review',
      progress: 100,
      version: started.version + 1,
    });
    expect(h.taskLog(task.id).at(-1)?.payload).toMatchObject({
      taskId: task.id,
      artifacts: ['https://artifacts.example/tsk_1.zip'],
      note: 'ready for review',
    });
  });

  it('requires every subtask to be done', async () => {
    const h = makeHarness();
    const { task, worker, admin } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 50 }),
    );
    const child = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, { parentId: task.id, title: 'child' }),
    ).task;

    const blocked = errorOf(
      await h.complete(worker.token, {
        taskId: task.id,
        expectedVersion: started.version,
      }),
    );
    expect(blocked.code).toBe(JsonRpcErrorCode.InvalidState);
    expect(blocked.data).toMatchObject({
      reason: 'subtasks_incomplete',
      pendingSubtaskIds: [child.id],
    });

    h.repos.tasks.update(child.id, { status: 'done', progress: 100 });
    const completed = resultOf<CompleteResult>(
      await h.complete(worker.token, {
        taskId: task.id,
        expectedVersion: started.version,
      }),
    );
    expect(completed.task.status).toBe('review');
  });

  it('rejects a stale expectedVersion with -32007', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 50 }),
    );

    const stale = errorOf(
      await h.complete(worker.token, {
        taskId: task.id,
        expectedVersion: started.version - 1,
      }),
    );
    expect(stale.code).toBe(JsonRpcErrorCode.VersionConflict);
    expect(h.repos.tasks.get(task.id)?.status).toBe('in_progress');
  });

  it('rejects a non-assignee with -32002', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 50 }),
    );
    const outsider = await h.register('complete-outsider', 'agent', ['typescript']);

    const denied = errorOf(
      await h.complete(outsider.token, {
        taskId: task.id,
        expectedVersion: started.version,
      }),
    );
    expect(denied.code).toBe(JsonRpcErrorCode.Forbidden);
  });
});

describe('task.fail', () => {
  it('moves in_progress -> failed and emits task.failed', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 20 }),
    );

    const failed = resultOf<FailResult>(
      await h.fail(worker.token, {
        taskId: task.id,
        expectedVersion: started.version,
        reason: 'dependency unavailable',
      }),
    );
    expect(failed.task).toMatchObject({
      status: 'failed',
      version: started.version + 1,
    });
    expect(h.taskLog(task.id).at(-1)?.payload).toMatchObject({
      taskId: task.id,
      reason: 'dependency unavailable',
    });
  });

  it('blocks a live parent and emits task.dependency.failed', async () => {
    const h = makeHarness();
    const { task: parent, worker, admin } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: parent.id, progress: 40 }),
    );

    const childOwner = await h.register('child-owner', 'agent', ['typescript']);
    const child = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, {
        parentId: parent.id,
        title: 'child work',
      }),
    ).task;
    // Put the child in progress without exercising the full auction again.
    const childRow = h.repos.tasks.get(child.id);
    expect(childRow).toBeDefined();
    h.repos.tasks.updateWithVersion(child.id, childRow?.version ?? 0, {
      status: 'in_progress',
      assignee: childOwner.agentId,
      progress: 10,
    });
    const childVersion = h.repos.tasks.get(child.id)?.version ?? 0;

    resultOf<FailResult>(
      await h.fail(childOwner.token, {
        taskId: child.id,
        expectedVersion: childVersion,
        reason: 'compile error',
      }),
    );

    const parentRow = h.repos.tasks.get(parent.id);
    expect(parentRow?.status).toBe('in_progress');
    expect(parentRow?.blockedBy).toContain(child.id);
    expect(
      h.taskLog(parent.id).filter((event) => event.type === 'task.dependency.failed'),
    ).toHaveLength(1);
    expect(started.task.status).toBe('in_progress');
  });

  it('does not propagate to a terminal parent', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const childOwner = await h.register('child-owner', 'agent', ['typescript']);
    const parent = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, { title: 'parent' }),
    ).task;
    h.repos.tasks.update(parent.id, { status: 'done', progress: 100 });

    const child = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, { parentId: parent.id, title: 'child' }),
    ).task;
    const childRow = h.repos.tasks.get(child.id);
    expect(childRow).toBeDefined();
    h.repos.tasks.updateWithVersion(child.id, childRow?.version ?? 0, {
      status: 'in_progress',
      assignee: childOwner.agentId,
    });

    resultOf<FailResult>(
      await h.fail(childOwner.token, {
        taskId: child.id,
        expectedVersion: h.repos.tasks.get(child.id)?.version ?? 0,
      }),
    );

    expect(h.repos.tasks.get(parent.id)).toMatchObject({
      status: 'done',
      blockedBy: [],
    });
    expect(
      h.taskLog(parent.id).filter((event) => event.type === 'task.dependency.failed'),
    ).toHaveLength(0);
  });

  it('rejects a stale expectedVersion with -32007', async () => {
    const h = makeHarness();
    const { task, worker } = await setupAwarded(h);
    const started = resultOf<ProgressResult>(
      await h.progress(worker.token, { taskId: task.id, progress: 20 }),
    );

    const stale = errorOf(
      await h.fail(worker.token, {
        taskId: task.id,
        expectedVersion: started.version - 1,
      }),
    );
    expect(stale.code).toBe(JsonRpcErrorCode.VersionConflict);
  });
});

describe('DAG invariants', () => {
  it('rejects a parent chain cycle', () => {
    const h = makeHarness();
    h.repos.tasks.create({
      id: 'cyc_a',
      title: 'a',
      status: 'in_progress',
      parentId: 'cyc_b',
      version: 1,
      progress: 0,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
    h.repos.tasks.create({
      id: 'cyc_b',
      title: 'b',
      status: 'in_progress',
      parentId: 'cyc_a',
      version: 1,
      progress: 0,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });

    expect(() => h.service.assertParentChainAcyclic('cyc_a')).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.InvalidState }),
    );
  });

  it('rejects a self-parent cycle', () => {
    const h = makeHarness();
    h.repos.tasks.create({
      id: 'cyc_self',
      title: 'self',
      status: 'in_progress',
      parentId: 'cyc_self',
      version: 1,
      progress: 0,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
    expect(() => h.service.assertParentChainAcyclic('cyc_self')).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.InvalidState }),
    );
  });
});
