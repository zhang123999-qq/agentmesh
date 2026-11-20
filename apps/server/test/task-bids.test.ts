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
  type BidListResult,
  type PlaceBidResult,
  type TasksService,
  type TaskView,
} from '../src/modules/tasks.js';
import {
  ProbabilisticExploration,
  type ExplorationPolicy,
  type ScoringWeights,
} from '../src/modules/task-scoring.js';
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
  taskVersion: (taskId: string, token: string) => Promise<number>;
  taskLog: (taskId: string) => ReturnType<EventStore['loadAggregate']>;
}

function makeHarness(options: {
  demoMode?: boolean;
  explorationPolicy?: ExplorationPolicy;
  bidRateLimit?: { ratePerSecond: number; burst: number };
  scoringWeights?: Partial<ScoringWeights>;
  historyConfidenceThreshold?: number;
} = {}): Harness {
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
    demoMode: options.demoMode ?? false,
    ...(options.explorationPolicy === undefined
      ? {}
      : { explorationPolicy: options.explorationPolicy }),
    ...(options.bidRateLimit === undefined
      ? {}
      : { bidRateLimit: options.bidRateLimit }),
    ...(options.scoringWeights === undefined
      ? {}
      : { scoringWeights: options.scoringWeights }),
    ...(options.historyConfidenceThreshold === undefined
      ? {}
      : { historyConfidenceThreshold: options.historyConfidenceThreshold }),
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

  const register: Harness['register'] = async (name, role = 'agent', skills = []) => {
    const outcome = await call(
      METHODS.agent.register,
      { name, role, skills },
      {},
    );
    const result = resultOf<{ agentId: string; token: string }>(outcome);
    return result;
  };

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
  const taskVersion: Harness['taskVersion'] = async (taskId, token) => {
    const view = resultOf<TaskView>(
      await call(METHODS.task.get, { taskId }, { token }),
    );
    return view.version;
  };
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

function seedFinishedTasks(
  h: Harness,
  agentId: string,
  completed: number,
  failed: number,
): void {
  let index = 0;
  for (let i = 0; i < completed; i += 1) {
    index += 1;
    h.repos.tasks.create({
      id: `hist_done_${index}`,
      title: 'history done',
      status: 'done',
      assignee: agentId,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
  }
  for (let i = 0; i < failed; i += 1) {
    index += 1;
    h.repos.tasks.create({
      id: `hist_failed_${index}`,
      title: 'history failed',
      status: 'failed',
      assignee: agentId,
      createdAt: CLOCK,
      updatedAt: CLOCK,
    });
  }
}

describe('task.bid', () => {
  it('publishes into bidding and appends audit + notification bid events without bumping version', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(
      await h.publish(admin.token),
    ).task;
    expect(task.status).toBe('bidding');
    expect(task.version).toBe(1);

    const placed = resultOf<PlaceBidResult>(
      await h.bid(worker.token, {
        taskId: task.id,
        price: 100,
        eta: 60,
        approach: 'plan',
        confidence: 0.8,
      }),
    );

    expect(placed).toMatchObject({
      status: 'bidding',
      version: 1,
      bid: { taskId: task.id, agentId: worker.agentId, price: 100, eta: 60 },
    });
    expect(h.repos.tasks.get(task.id)).toMatchObject({ status: 'bidding', version: 1 });

    const list = resultOf<BidListResult>(
      await h.call(METHODS.task.bids, { taskId: task.id }, { token: admin.token }),
    );
    expect(list.total).toBe(1);
    expect(list.bids[0]).toMatchObject({
      bidId: placed.bid.bidId,
      agentId: worker.agentId,
      price: 100,
      approach: 'plan',
      confidence: 0.8,
    });
    const log = h.taskLog(task.id);
    expect(log.map((event) => event.type)).toEqual([
      'task.published',
      'task.bid.placed',
      'task.bid.received',
    ]);
    expect(log.every((event) => event.version === 1)).toBe(true);
  });

  it('overwrites the same agent bid instead of creating a second live row', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    const first = resultOf<PlaceBidResult>(
      await h.bid(worker.token, { taskId: task.id, price: 100 }),
    );
    const second = resultOf<PlaceBidResult>(
      await h.bid(worker.token, { taskId: task.id, price: 80 }),
    );

    expect(second.bid.bidId).toBe(first.bid.bidId);
    expect(second.bid.price).toBe(80);
    expect(h.repos.taskBids.listByTask(task.id)).toHaveLength(1);
    expect(h.taskLog(task.id).filter((event) => event.type === 'task.bid.placed')).toHaveLength(2);
    // Bidding never mutates the task row version.
    expect(h.repos.tasks.get(task.id)?.version).toBe(1);
  });

  it('does not change tasks.version across ten bids', async () => {
    const h = makeHarness({ bidRateLimit: { ratePerSecond: 100, burst: 100 } });
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    for (let i = 0; i < 10; i += 1) {
      resultOf<PlaceBidResult>(
        await h.bid(worker.token, { taskId: task.id, price: 100 + i }),
      );
    }

    expect(h.repos.tasks.get(task.id)?.version).toBe(1);
    expect(h.repos.taskBids.listByTask(task.id)).toHaveLength(1);
    expect(await h.taskVersion(task.id, admin.token)).toBe(1);
  });

  it('rejects bids on an open task that has no bidding window', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const published = resultOf<{ task: TaskView }>(
      await h.call(
        METHODS.task.publish,
        { title: 'open draft' },
        { token: admin.token },
      ),
    ).task;
    expect(published.status).toBe('open');

    const error = errorOf(
      await h.bid(worker.token, { taskId: published.id, price: 100 }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InvalidState);
    expect(error.data).toMatchObject({ reason: 'bidding_closed' });
  });

  it('rejects bids after biddingDeadline has passed', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, { biddingDeadline: CLOCK + 1_000 }),
    ).task;

    h.clock.now = CLOCK + 2_000;
    const error = errorOf(await h.bid(worker.token, { taskId: task.id, price: 100 }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidState);
    expect(error.data).toMatchObject({ reason: 'bidding_closed' });
  });

  it('rejects bids after the window closes with -32003', async () => {
    const h = makeHarness({ explorationPolicy: new ProbabilisticExploration({ rate: 0 }) });
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    await h.bid(worker.token, { taskId: task.id, price: 100 });
    const version = await h.taskVersion(task.id, admin.token);
    resultOf<AwardResult>(
      await h.award(admin.token, {
        taskId: task.id,
        expectedVersion: version,
        awardeeId: worker.agentId,
      }),
    );

    const late = errorOf(await h.bid(worker.token, { taskId: task.id, price: 50 }));
    expect(late.code).toBe(JsonRpcErrorCode.InvalidState);
    expect(late.data).toMatchObject({ reason: 'bidding_closed' });
    // A late bid must never change ownership.
    expect(h.repos.tasks.get(task.id)?.assignee).toBe(worker.agentId);
  });

  it('enforces the default 5 bids/minute budget', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    for (let i = 0; i < 5; i += 1) {
      const placed = resultOf<PlaceBidResult>(
        await h.bid(worker.token, { taskId: task.id, price: 100 + i }),
      );
      expect(placed.bid.price).toBe(100 + i);
    }
    const limited = errorOf(await h.bid(worker.token, { taskId: task.id, price: 99 }));
    expect(limited.code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it('enforces the per-agent bid budget with -32005', async () => {
    const h = makeHarness({ bidRateLimit: { ratePerSecond: 0.001, burst: 2 } });
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    await h.bid(worker.token, { taskId: task.id, price: 100 });
    await h.bid(worker.token, { taskId: task.id, price: 90 });
    const limited = errorOf(await h.bid(worker.token, { taskId: task.id, price: 80 }));
    expect(limited.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(limited.data).toMatchObject({ reason: 'too_many_bids' });
  });

  it('lets only admins read the bid set', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(worker.token, { taskId: task.id, price: 100 });

    const forbidden = errorOf(
      await h.call(METHODS.task.bids, { taskId: task.id }, { token: worker.token }),
    );
    expect(forbidden.code).toBe(JsonRpcErrorCode.Forbidden);
  });
});

describe('bidding window close', () => {
  it('cancels a bidding task with no bids after biddingDeadline', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const task = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, { biddingDeadline: CLOCK + 1_000 }),
    ).task;

    h.clock.now = CLOCK + 2_000;
    const result = h.service.closeExpiredBidding();
    expect(result.count).toBe(1);
    expect(result.closed[0]).toMatchObject({ id: task.id, status: 'cancelled' });
    expect(h.repos.tasks.get(task.id)?.status).toBe('cancelled');
    expect(h.taskLog(task.id).at(-1)?.payload).toMatchObject({
      from: 'bidding',
      to: 'cancelled',
      reason: 'bidding_window_closed',
    });
  });

  it('keeps a bidding task open when it already has a live bid', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(
      await h.publish(admin.token, { biddingDeadline: CLOCK + 1_000 }),
    ).task;
    await h.bid(worker.token, { taskId: task.id, price: 100 });

    h.clock.now = CLOCK + 2_000;
    expect(h.service.closeExpiredBidding().count).toBe(0);
    expect(h.repos.tasks.get(task.id)?.status).toBe('bidding');
  });
});

describe('task.award', () => {
  it('auto-scores live bids and writes exactly one task.awarded', async () => {
    const h = makeHarness({ explorationPolicy: new ProbabilisticExploration({ rate: 0 }) });
    const admin = await h.register('admin', 'admin');
    const strong = await h.register('strong', 'agent', ['typescript']);
    const cheap = await h.register('cheap', 'agent', []);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;

    await h.bid(strong.token, { taskId: task.id, price: 100, eta: 60 });
    await h.bid(cheap.token, { taskId: task.id, price: 10, eta: 30 });
    const version = await h.taskVersion(task.id, admin.token);

    const awarded = resultOf<AwardResult>(
      await h.award(admin.token, { taskId: task.id, expectedVersion: version, strategy: 'auto' }),
    );
    expect(awarded.awardeeId).toBe(strong.agentId);
    expect(awarded.strategy).toBe('auto');
    expect(awarded.exploration).toBe(false);
    expect(h.repos.tasks.get(task.id)).toMatchObject({
      status: 'awarded',
      assignee: strong.agentId,
      version: version + 1,
    });
    expect(h.taskLog(task.id).filter((event) => event.type === 'task.awarded')).toHaveLength(1);
  });

  it('demo mode forces the cold-start exploration branch', async () => {
    const h = makeHarness({ demoMode: true });
    const admin = await h.register('admin', 'admin');
    const veteran = await h.register('veteran', 'agent', ['typescript']);
    const cold = await h.register('cold', 'agent', ['typescript']);
    seedFinishedTasks(h, veteran.agentId, 6, 0);

    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(veteran.token, { taskId: task.id, price: 50, eta: 30 });
    await h.bid(cold.token, { taskId: task.id, price: 60, eta: 40 });
    const version = await h.taskVersion(task.id, admin.token);

    const awarded = resultOf<AwardResult>(
      await h.award(admin.token, { taskId: task.id, expectedVersion: version, strategy: 'auto' }),
    );
    expect(awarded.awardeeId).toBe(cold.agentId);
    expect(awarded.exploration).toBe(true);
    const event = h.taskLog(task.id).find((entry) => entry.type === 'task.awarded');
    expect(event?.payload).toMatchObject({ exploration: true, strategy: 'auto' });
  });

  it('returns -32007 for a stale expectedVersion and writes no award event', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(worker.token, { taskId: task.id, price: 100 });
    const version = await h.taskVersion(task.id, admin.token);

    const stale = errorOf(
      await h.award(admin.token, {
        taskId: task.id,
        expectedVersion: version - 1,
        awardeeId: worker.agentId,
      }),
    );
    expect(stale.code).toBe(JsonRpcErrorCode.VersionConflict);
    expect(h.taskLog(task.id).filter((event) => event.type === 'task.awarded')).toHaveLength(0);
    expect(h.repos.tasks.get(task.id)?.status).toBe('bidding');
  });

  it('one of two concurrent awards wins; the other gets -32007; one event total', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const a = await h.register('agent-a', 'agent', ['typescript']);
    const b = await h.register('agent-b', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(a.token, { taskId: task.id, price: 100 });
    await h.bid(b.token, { taskId: task.id, price: 90 });
    const version = await h.taskVersion(task.id, admin.token);

    const outcomes = await Promise.all([
      h.award(admin.token, {
        taskId: task.id,
        expectedVersion: version,
        awardeeId: a.agentId,
      }),
      h.award(admin.token, {
        taskId: task.id,
        expectedVersion: version,
        awardeeId: b.agentId,
      }),
    ]);

    const successes = outcomes.filter((outcome) => outcome.response?.error === undefined);
    const conflicts = outcomes.filter(
      (outcome) => outcome.response?.error?.code === JsonRpcErrorCode.VersionConflict,
    );
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(h.taskLog(task.id).filter((event) => event.type === 'task.awarded')).toHaveLength(1);
  });

  it('rejects manual awards for agents without a live bid', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const bidder = await h.register('bidder', 'agent', ['typescript']);
    const outsider = await h.register('outsider', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(bidder.token, { taskId: task.id, price: 100 });
    const version = await h.taskVersion(task.id, admin.token);

    const error = errorOf(
      await h.award(admin.token, {
        taskId: task.id,
        expectedVersion: version,
        awardeeId: outsider.agentId,
      }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InvalidState);
    expect(error.data).toMatchObject({ reason: 'awardee_has_no_bid' });
  });

  it('lets only admins award', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(worker.token, { taskId: task.id, price: 100 });
    const version = await h.taskVersion(task.id, admin.token);

    const forbidden = errorOf(
      await h.award(worker.token, {
        taskId: task.id,
        expectedVersion: version,
        awardeeId: worker.agentId,
      }),
    );
    expect(forbidden.code).toBe(JsonRpcErrorCode.Forbidden);
  });

  it('rejects awarding a task that has not started bidding', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const task = resultOf<{ task: TaskView }>(
      await h.call(
        METHODS.task.publish,
        { title: 'draft without window' },
        { token: admin.token },
      ),
    ).task;

    const error = errorOf(
      await h.award(admin.token, {
        taskId: task.id,
        expectedVersion: task.version,
        strategy: 'auto',
      }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.InvalidState);
  });
});

describe('task status after bidding', () => {
  it('exposes bidding in task.list filter', async () => {
    const h = makeHarness();
    const admin = await h.register('admin', 'admin');
    const worker = await h.register('worker', 'agent', ['typescript']);
    const task = resultOf<{ task: TaskView }>(await h.publish(admin.token)).task;
    await h.bid(worker.token, { taskId: task.id, price: 100 });

    const list = resultOf<{ tasks: TaskView[] }>(
      await h.call(METHODS.task.list, { status: 'bidding' }, { token: admin.token }),
    );
    expect(list.tasks.map((entry) => entry.id)).toEqual([task.id]);
    expect(list.tasks[0]?.status).toBe('bidding');
  });
});
