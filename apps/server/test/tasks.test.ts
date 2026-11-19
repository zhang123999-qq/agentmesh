/**
 * Integration tests for the US-008 task publish + lifecycle state machine.
 *
 * Everything runs through the real dispatcher and real SQLite (`:memory:`):
 * the RPC surface (`task.publish` / `task.list` / `task.get`), the transition
 * table (legal chains, illegal edges, the MVP cancel policy), CAS conflicts
 * (`-32007`) and the deadline/TTL reclaim sweep driven by an injected clock.
 */

import { EventStore, initialTaskState, taskReducer } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS, ProtocolError } from '@agentmesh/protocol';
import { openStore, type Repositories, type TaskStatus } from '@agentmesh/store';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canTransition,
  MAX_TASK_SKILLS,
  TASK_TRANSITIONS,
  TasksService,
  registerTasksModule,
} from '../src/modules/tasks.js';
import { buildServer, type ServerStore } from '../src/app.js';
import { startServer } from '../src/index.js';
import { createTokenService, type TokenService } from '../src/auth/token.js';
import type { DispatchContext, DispatchOutcome } from '../src/dispatcher.js';
import { RpcDispatcher } from '../src/dispatcher.js';
import { registerAccountsModule } from '../src/modules/accounts.js';
import { createHandlerRegistry } from '../src/registry.js';
import { silentLogger, testConfig } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';
const CLOCK = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: ServerStore['db'];
  repos: Repositories;
  events: EventStore;
  tokens: TokenService;
  service: TasksService;
  /** Mutable injected clock: bump it to simulate time passing. */
  clock: { now: number };
  call: (method: string, params?: unknown, ctx?: DispatchContext) => Promise<DispatchOutcome>;
  register: (name: string, role?: 'admin' | 'agent' | 'observer') => Promise<{
    agentId: string;
    token: string;
    role: string;
  }>;
}

function makeHarness(options: { openTtlSeconds?: number } = {}): Harness {
  const { db, repos } = openStore(':memory:');
  const clock = { now: CLOCK };
  const events = new EventStore(db, { clock: () => clock.now });
  const tokens = createTokenService({ secret: SECRET, clock: () => clock.now });
  const registry = createHandlerRegistry();
  let counter = 0;

  registerAccountsModule(registry, {
    db,
    accounts: repos.accounts,
    events,
    tokens,
    allowAdminSelfRegister: true,
    idFactory: () => {
      counter += 1;
      return `agt_${counter}`;
    },
    clock: () => clock.now,
  });

  const service = registerTasksModule(registry, {
    db,
    tasks: repos.tasks,
    events,
    openTtlSeconds: options.openTtlSeconds ?? 0,
    idFactory: () => {
      counter += 1;
      return `tsk_${counter}`;
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

  return {
    db,
    repos,
    events,
    tokens,
    service,
    clock,
    call,
    register: async (name, role = 'agent') => {
      const outcome = await call(METHODS.agent.register, {
        name,
        ...(role === 'agent' ? {} : { role }),
      });
      return resultOf<{ agentId: string; token: string; role: string }>(outcome);
    },
  };
}

function resultOf<T>(outcome: DispatchOutcome): T {
  expect(outcome.response?.error).toBeUndefined();
  return outcome.response?.result as T;
}

function errorOf(outcome: DispatchOutcome): {
  code: number;
  message: string;
  data?: Record<string, unknown>;
} {
  const error = outcome.response?.error;
  expect(error).toBeDefined();
  return error as { code: number; message: string; data?: Record<string, unknown> };
}

/** Capture a synchronous `ProtocolError` thrown by the service layer. */
function protocolErrorOf(fn: () => unknown): ProtocolError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProtocolError);
    return err as ProtocolError;
  }
  throw new Error('expected a ProtocolError, but the call succeeded');
}

interface TaskResult {
  id: string;
  title: string;
  description: string;
  requiredSkills: string[];
  budget: number;
  status: TaskStatus;
  assignee: string | null;
  version: number;
  deadline: number | null;
  createdAt: number;
  updatedAt: number;
}

interface PublishResult {
  task: TaskResult;
  seq: number;
}

interface ListResult {
  tasks: TaskResult[];
  total: number;
  limit: number | null;
  offset: number;
}

function publish(
  h: Harness,
  token: string,
  params: Record<string, unknown> = { title: 'ship it' },
): Promise<DispatchOutcome> {
  return h.call(METHODS.task.publish, params, { token });
}

function replayTask(h: Harness, taskId: string) {
  const aggregateId = `task:${taskId}`;
  return h.events.loadAggregate(aggregateId).reduce(taskReducer, initialTaskState(aggregateId));
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// ---------------------------------------------------------------------------
// task.publish
// ---------------------------------------------------------------------------

describe('task.publish', () => {
  it('creates an open task and appends task.published (admin only)', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');

    const result = resultOf<PublishResult>(
      await publish(h, root.token, {
        title: '  build the mesh  ',
        description: 'wire agents together',
        requiredSkills: ['typescript', 'sqlite', 'typescript'],
        budget: 120,
        deadline: CLOCK + 60_000,
      }),
    );

    expect(result.task).toMatchObject({
      title: 'build the mesh',
      description: 'wire agents together',
      requiredSkills: ['typescript', 'sqlite'],
      budget: 120,
      status: 'open',
      version: 1,
      deadline: CLOCK + 60_000,
      createdAt: CLOCK,
    });

    // Projection row agrees with the response (same version → CAS token).
    const stored = h.repos.tasks.get(result.task.id, 'default');
    expect(stored).toMatchObject({ status: 'open', version: 1, budget: 120 });

    // Event log: one `task.published` at version 1, seq echoed in the result.
    const log = h.events.loadAggregate(`task:${result.task.id}`);
    expect(log.map((event) => event.type)).toEqual(['task.published']);
    expect(log[0]?.seq).toBe(result.seq);
    expect(log[0]?.version).toBe(1);
    expect(log[0]?.payload).toMatchObject({
      taskId: result.task.id,
      title: 'build the mesh',
      requiredSkills: ['typescript', 'sqlite'],
      budget: 120,
      status: 'open',
      publishedBy: root.agentId,
      deadline: CLOCK + 60_000,
    });

    // Replaying the aggregate rebuilds the same projection.
    expect(replayTask(h, result.task.id)).toMatchObject({
      exists: true,
      title: 'build the mesh',
      status: 'open',
      version: 1,
      budget: 120,
      requiredSkills: ['typescript', 'sqlite'],
    });
  });

  it('rejects non-admin callers with -32002 and anonymous callers with -32001', async () => {
    const h = makeHarness();
    const worker = await h.register('worker');
    const watcher = await h.register('watcher', 'observer');

    const workerError = errorOf(await publish(h, worker.token));
    expect(workerError.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(workerError.data).toMatchObject({ role: 'agent', required: ['admin'] });

    const observerError = errorOf(await publish(h, watcher.token));
    expect(observerError.code).toBe(JsonRpcErrorCode.Forbidden);

    const anonymous = errorOf(
      await h.call(METHODS.task.publish, { title: 'nope' }),
    );
    expect(anonymous.code).toBe(JsonRpcErrorCode.Unauthorized);

    expect(h.repos.tasks.count()).toBe(0);
    expect(h.events.count()).toBe(2); // the two agent.registered events only
  });

  it('validates params with -32602 and writes nothing', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');

    const cases: Array<{ params: Record<string, unknown>; field: string }> = [
      { params: {}, field: 'title' },
      { params: { title: '   ' }, field: 'title' },
      { params: { title: 'x', budget: -1 }, field: 'budget' },
      { params: { title: 'x', budget: 'cheap' }, field: 'budget' },
      { params: { title: 'x', deadline: 1.5 }, field: 'deadline' },
      { params: { title: 'x', requiredSkills: 'ts' }, field: 'requiredSkills' },
      { params: { title: 'x', requiredSkills: [''] }, field: 'requiredSkills' },
      {
        params: { title: 'x', requiredSkills: Array.from({ length: MAX_TASK_SKILLS + 1 }, (_, i) => `s${i}`) },
        field: 'requiredSkills',
      },
    ];

    for (const { params, field } of cases) {
      const error = errorOf(await publish(h, root.token, params));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.data).toMatchObject({ field });
    }

    expect(h.repos.tasks.count()).toBe(0);
    expect(h.events.count('default')).toBe(1);
  });

  it('rejects a deadline that is not strictly in the future', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');

    const atCreation = errorOf(
      await publish(h, root.token, { title: 'same instant', deadline: CLOCK }),
    );
    expect(atCreation.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(atCreation.data).toMatchObject({ field: 'deadline' });

    const alreadyPast = errorOf(
      await publish(h, root.token, { title: 'past', deadline: CLOCK - 1_000 }),
    );
    expect(alreadyPast.code).toBe(JsonRpcErrorCode.InvalidParams);

    expect(h.repos.tasks.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// task.list / task.get
// ---------------------------------------------------------------------------

describe('task.list and task.get', () => {
  it('lists tasks with status filtering and paging', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');
    const worker = await h.register('worker');

    const ids: string[] = [];
    for (const title of ['alpha', 'beta', 'gamma']) {
      h.clock.now += 10;
      const published = resultOf<PublishResult>(await publish(h, root.token, { title }));
      ids.push(published.task.id);
    }
    // Move the last one out of `open` to exercise the status filter.
    h.service.transition(ids[2] as string, 'bidding', {
      expectedVersion: h.service.get(ids[2] as string).version,
      actorId: root.agentId,
    });

    const all = resultOf<ListResult>(await h.call(METHODS.task.list, {}, { token: worker.token }));
    expect(all.total).toBe(3);
    expect(all.tasks.map((task) => task.title)).toEqual(['alpha', 'beta', 'gamma']);
    expect(all.limit).toBeNull();
    expect(all.offset).toBe(0);

    const open = resultOf<ListResult>(
      await h.call(METHODS.task.list, { status: 'open' }, { token: worker.token }),
    );
    expect(open.total).toBe(2);
    expect(open.tasks.map((task) => task.title)).toEqual(['alpha', 'beta']);

    const bidding = resultOf<ListResult>(
      await h.call(METHODS.task.list, { status: 'bidding' }, { token: worker.token }),
    );
    expect(bidding.tasks.map((task) => task.id)).toEqual([ids[2]]);

    const page = resultOf<ListResult>(
      await h.call(METHODS.task.list, { limit: 1, offset: 1 }, { token: worker.token }),
    );
    expect(page.tasks.map((task) => task.title)).toEqual(['beta']);
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });

    // Read access rules: observers are not "agent+"; anonymous has no identity.
    const watcher = await h.register('watcher', 'observer');
    expect(errorOf(await h.call(METHODS.task.list, {}, { token: watcher.token })).code).toBe(
      JsonRpcErrorCode.Forbidden,
    );
    expect(errorOf(await h.call(METHODS.task.list, {})).code).toBe(
      JsonRpcErrorCode.Unauthorized,
    );
    expect(
      errorOf(await h.call(METHODS.task.list, { status: 'nope' }, { token: worker.token })).data,
    ).toMatchObject({ field: 'status' });
  });

  it('returns one task with its version and -32004 for unknown ids', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');
    const worker = await h.register('worker');
    const published = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'inspect me', budget: 7 }),
    );

    const fetched = resultOf<TaskResult>(
      await h.call(METHODS.task.get, { taskId: published.task.id }, { token: worker.token }),
    );
    expect(fetched).toEqual(published.task);
    expect(fetched.version).toBe(1);

    const missing = errorOf(
      await h.call(METHODS.task.get, { taskId: 'tsk_missing' }, { token: worker.token }),
    );
    expect(missing.code).toBe(JsonRpcErrorCode.NotFound);
    expect(missing.data).toMatchObject({ taskId: 'tsk_missing' });

    expect(errorOf(await h.call(METHODS.task.get, { taskId: '' }, { token: worker.token })).data)
      .toMatchObject({ field: 'taskId' });
    expect(errorOf(await h.call(METHODS.task.get, { taskId: published.task.id })).code).toBe(
      JsonRpcErrorCode.Unauthorized,
    );
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('task lifecycle state machine', () => {
  async function publishAsRoot(h: Harness): Promise<{ root: { agentId: string; token: string }; task: TaskResult }> {
    const root = await h.register('root', 'admin');
    const published = resultOf<PublishResult>(await publish(h, root.token, { title: 'lifecycle' }));
    return { root, task: published.task };
  }

  it('accepts the full open → bidding → awarded → in_progress → review → done chain', async () => {
    const h = makeHarness();
    const { root, task } = await publishAsRoot(h);

    const chain: TaskStatus[] = ['bidding', 'awarded', 'in_progress', 'review', 'done'];
    let version = task.version;
    for (const next of chain) {
      const updated = h.service.transition(task.id, next, {
        expectedVersion: version,
        actorId: root.agentId,
      });
      version += 1;
      expect(updated.status).toBe(next);
      expect(updated.version).toBe(version);
    }

    expect(h.service.get(task.id).status).toBe('done');
    expect(h.repos.tasks.get(task.id)?.status).toBe('done');

    // Every step is on the log at the matching version, in order.
    const log = h.events.loadAggregate(`task:${task.id}`);
    expect(log.map((event) => event.type)).toEqual([
      'task.published',
      'task.status.changed',
      'task.status.changed',
      'task.status.changed',
      'task.status.changed',
      'task.status.changed',
    ]);
    expect(log.slice(1).map((event) => event.payload as Record<string, unknown>)).toMatchObject([
      { from: 'open', to: 'bidding', version: 2, actorId: root.agentId },
      { from: 'bidding', to: 'awarded', version: 3, actorId: root.agentId },
      { from: 'awarded', to: 'in_progress', version: 4, actorId: root.agentId },
      { from: 'in_progress', to: 'review', version: 5, actorId: root.agentId },
      { from: 'review', to: 'done', version: 6, actorId: root.agentId },
    ]);
    expect(log.map((event) => event.version)).toEqual([1, 2, 3, 4, 5, 6]);

    expect(replayTask(h, task.id)).toMatchObject({ status: 'done', version: 6 });
  });

  it('returns review → in_progress for a request-revision decision', async () => {
    const h = makeHarness();
    const { task } = await publishAsRoot(h);

    for (const next of ['bidding', 'awarded', 'in_progress', 'review'] as TaskStatus[]) {
      h.service.transition(task.id, next, {
        expectedVersion: h.service.get(task.id).version,
      });
    }
    expect(h.service.get(task.id).status).toBe('review');

    const revised = h.service.transition(task.id, 'in_progress', {
      expectedVersion: h.service.get(task.id).version,
      reason: 'request-revision',
    });
    expect(revised.status).toBe('in_progress');
    expect(revised.version).toBe(6);
    expect(h.events.loadAggregate(`task:${task.id}`).at(-1)?.payload).toMatchObject({
      from: 'review',
      to: 'in_progress',
      reason: 'request-revision',
    });
  });

  it('rejects illegal transitions with -32003 and leaves the row untouched', async () => {
    const h = makeHarness();
    const { task } = await publishAsRoot(h);

    const illegal: Array<[TaskStatus, TaskStatus]> = [
      ['open', 'done'],
      ['open', 'in_progress'],
      ['open', 'awarded'],
    ];
    for (const [from, to] of illegal) {
      expect(h.service.get(task.id).status).toBe(from);
      const err = protocolErrorOf(() =>
        h.service.transition(task.id, to, {
          expectedVersion: h.service.get(task.id).version,
        }),
      );
      expect(err.code).toBe(JsonRpcErrorCode.InvalidState);
      expect(err.data).toMatchObject({
        taskId: task.id,
        from,
        to,
        allowed: TASK_TRANSITIONS[from],
      });
    }

    // Terminal states never move again.
    for (const next of ['bidding', 'awarded', 'in_progress', 'review', 'done'] as TaskStatus[]) {
      h.service.transition(task.id, next, {
        expectedVersion: h.service.get(task.id).version,
      });
    }
    const doneVersion = h.service.get(task.id).version;

    const backwards = protocolErrorOf(() =>
      h.service.transition(task.id, 'open', { expectedVersion: doneVersion }),
    );
    expect(backwards.code).toBe(JsonRpcErrorCode.InvalidState);
    expect(backwards.data).toMatchObject({ from: 'done', to: 'open', allowed: [] });
    expect(h.service.get(task.id)).toMatchObject({ status: 'done', version: doneVersion });

    // Only the legitimate chain landed on the log (no event for a rejection).
    expect(h.events.loadAggregate(`task:${task.id}`)).toHaveLength(6);
  });

  it('cancels only open tasks (MVP cancel policy)', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');
    const published = resultOf<PublishResult>(await publish(h, root.token, { title: 'cancel me' }));
    const taskId = published.task.id;

    // open → cancelled is the single legal cancel edge, and it is logged.
    const cancelled = h.service.transition(taskId, 'cancelled', {
      expectedVersion: published.task.version,
      actorId: root.agentId,
      reason: 'no longer needed',
    });
    expect(cancelled).toMatchObject({ status: 'cancelled', version: 2 });
    const log = h.events.loadAggregate(`task:${taskId}`);
    expect(log.at(-1)?.type).toBe('task.status.changed');
    expect(log.at(-1)?.payload as Record<string, unknown>).toMatchObject({
      from: 'open',
      to: 'cancelled',
      reason: 'no longer needed',
    });

    // awarded / in_progress / review / bidding may not be cancelled directly.
    for (const blockedFrom of ['bidding', 'awarded', 'in_progress', 'review'] as TaskStatus[]) {
      const other = resultOf<PublishResult>(
        await publish(h, root.token, { title: `stuck in ${blockedFrom}` }),
      );
      const path: TaskStatus[] = ['bidding', 'awarded', 'in_progress', 'review'];
      const stopAt = path.indexOf(blockedFrom);
      for (let i = 0; i <= stopAt; i += 1) {
        h.service.transition(other.task.id, path[i] as TaskStatus, {
          expectedVersion: h.service.get(other.task.id).version,
        });
      }
      const err = protocolErrorOf(() =>
        h.service.transition(other.task.id, 'cancelled', {
          expectedVersion: h.service.get(other.task.id).version,
        }),
      );
      expect(err.code).toBe(JsonRpcErrorCode.InvalidState);
      expect(err.data).toMatchObject({ from: blockedFrom, to: 'cancelled' });
      expect(h.service.get(other.task.id).status).toBe(blockedFrom);
    }
  });

  it('allows failed from any active state but not from a terminal one', () => {
    expect(canTransition('open', 'failed')).toBe(false);
    expect(canTransition('bidding', 'failed')).toBe(true);
    expect(canTransition('awarded', 'failed')).toBe(true);
    expect(canTransition('in_progress', 'failed')).toBe(true);
    expect(canTransition('review', 'failed')).toBe(true);
    expect(canTransition('done', 'failed')).toBe(false);
    expect(canTransition('cancelled', 'failed')).toBe(false);
    expect(canTransition('failed', 'open')).toBe(false);
    expect(canTransition('draft', 'open')).toBe(true);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });

  it('rejects a stale expectedVersion with -32007 and accepts a fresh retry', async () => {
    const h = makeHarness();
    const { task } = await publishAsRoot(h);

    // A concurrent writer moved the task to version 2 (`open → bidding`).
    const moved = h.service.transition(task.id, 'bidding', { expectedVersion: 1 });
    expect(moved.version).toBe(2);

    // A stale writer still holding version 1 asks for `bidding → awarded`:
    // the edge is legal for the *current* status, so the CAS is what rejects it.
    const err = protocolErrorOf(() =>
      h.service.transition(task.id, 'awarded', { expectedVersion: 1 }),
    );
    expect(err.code).toBe(JsonRpcErrorCode.VersionConflict);
    expect(err.data).toMatchObject({
      taskId: task.id,
      expectedVersion: 1,
      currentVersion: 2,
      from: 'bidding',
      to: 'awarded',
    });
    expect(h.service.get(task.id).version).toBe(2);
    expect(h.events.loadAggregate(`task:${task.id}`)).toHaveLength(2);

    // Retrying with the fresh version succeeds exactly once.
    const retried = h.service.transition(task.id, 'awarded', { expectedVersion: 2 });
    expect(retried).toMatchObject({ status: 'awarded', version: 3 });
  });

  it('rejects transitions on unknown tasks with -32004', async () => {
    const h = makeHarness();
    const err = protocolErrorOf(() =>
      h.service.transition('tsk_nope', 'bidding', { expectedVersion: 1 }),
    );
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data).toMatchObject({ taskId: 'tsk_nope' });
  });
});

// ---------------------------------------------------------------------------
// Timeout reclaim
// ---------------------------------------------------------------------------

describe('open-task timeout reclaim', () => {
  it('cancels open tasks whose deadline has passed and logs the reason', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');

    const overdue = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'overdue', deadline: CLOCK + 1_000 }),
    );
    const future = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'future', deadline: CLOCK + 1_000_000 }),
    );
    const noDeadline = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'no deadline' }),
    );

    // Not yet due: nothing reclaimed.
    expect(h.service.reclaimExpired(CLOCK + 999).count).toBe(0);

    h.clock.now = CLOCK + 2_000;
    const sweep = h.service.reclaimExpired();
    expect(sweep.count).toBe(1);
    expect(sweep.reclaimed[0]).toMatchObject({
      id: overdue.task.id,
      status: 'cancelled',
      version: 2,
    });

    expect(h.service.get(overdue.task.id).status).toBe('cancelled');
    expect(h.service.get(future.task.id).status).toBe('open');
    // Without a TTL, a deadline-less task is never reclaimed.
    expect(h.service.get(noDeadline.task.id).status).toBe('open');

    const log = h.events.loadAggregate(`task:${overdue.task.id}`);
    expect(log.map((event) => event.type)).toEqual([
      'task.published',
      'task.status.changed',
    ]);
    expect(log.at(-1)?.payload as Record<string, unknown>).toMatchObject({
      from: 'open',
      to: 'cancelled',
      reason: 'deadline_expired',
      version: 2,
    });

    // Idempotent: the second sweep has nothing to do.
    expect(h.service.reclaimExpired().count).toBe(0);
    expect(h.events.loadAggregate(`task:${overdue.task.id}`)).toHaveLength(2);
  });

  it('honours TASK_OPEN_TTL_SECONDS for open tasks without a deadline', async () => {
    const h = makeHarness({ openTtlSeconds: 100 });

    const root = await h.register('root', 'admin');
    const withDeadline = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'explicit', deadline: CLOCK + 1_000_000 }),
    );
    const ttlOnly = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'ttl only' }),
    );

    // 99.999s after creation: the TTL has not elapsed yet.
    expect(h.service.reclaimExpired(CLOCK + 99_999).count).toBe(0);
    // At exactly TTL: reclaimed (the TTL is an upper bound, not a grace period).
    const sweep = h.service.reclaimExpired(CLOCK + 100_000);
    expect(sweep.count).toBe(1);
    expect(sweep.reclaimed.map((task) => task.id)).toEqual([ttlOnly.task.id]);
    expect(
      h.events.loadAggregate(`task:${ttlOnly.task.id}`).at(-1)?.payload as Record<string, unknown>,
    ).toMatchObject({ reason: 'open_ttl_expired' });

    // The explicit deadline still governs the other task.
    expect(h.service.get(withDeadline.task.id).status).toBe('open');
    expect(h.service.reclaimExpired(CLOCK + 1_000_000).count).toBe(1);
    expect(h.service.get(withDeadline.task.id).status).toBe('cancelled');
  });

  it('sweeps overdue tasks before listening, so a restart cannot serve them as open', async () => {
    const { db, repos } = openStore(':memory:');
    const events = new EventStore(db, { clock: () => CLOCK });
    // Publish relative to a clock 60s in the past, so the deadline is already
    // overdue by the time startServer performs its startup sweep.
    const publisher = new TasksService({
      db,
      tasks: repos.tasks,
      events,
      workspaceId: 'default',
      clock: () => Date.now() - 60_000,
    });
    const published = publisher.publish(
      { title: 'overdue at boot', deadline: Date.now() - 30_000 },
      { agentId: 'agt_admin', role: 'admin' },
      'default',
    );

    const app = await startServer({
      config: testConfig({ port: 0, dbPath: ':memory:' }),
      logger: silentLogger(),
      store: { db, repos },
      taskReclaimIntervalMs: 60_000,
    });
    apps.push(app);

    expect(repos.tasks.get(published.task.id)?.status).toBe('cancelled');
    expect(
      events
        .loadAggregate(`task:${published.task.id}`)
        .at(-1)?.payload as Record<string, unknown>,
    ).toMatchObject({ from: 'open', to: 'cancelled', reason: 'deadline_expired' });
  });

  it('never touches tasks that already left open', async () => {
    const h = makeHarness();
    const root = await h.register('root', 'admin');
    const awarded = resultOf<PublishResult>(
      await publish(h, root.token, { title: 'awarded', deadline: CLOCK + 500 }),
    );
    h.service.transition(awarded.task.id, 'bidding', {
      expectedVersion: h.service.get(awarded.task.id).version,
    });
    h.service.transition(awarded.task.id, 'awarded', {
      expectedVersion: h.service.get(awarded.task.id).version,
    });
    const versionBefore = h.service.get(awarded.task.id).version;

    const sweep = h.service.reclaimExpired(CLOCK + 1_000_000);
    expect(sweep.count).toBe(0);
    expect(h.service.get(awarded.task.id)).toMatchObject({
      status: 'awarded',
      version: versionBefore,
    });
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('module wiring', () => {
  it('decorates app.tasks and registers the three methods when a store is wired', async () => {
    const { db, repos } = openStore(':memory:');
    const app = buildServer({
      config: testConfig(),
      logger: silentLogger(),
      store: { db, repos },
      taskReclaimIntervalMs: 10,
    });
    apps.push(app);

    expect(app.tasks).toBeInstanceOf(TasksService);
    expect(app.registry.listMethods()).toEqual(
      expect.arrayContaining([
        METHODS.task.publish,
        METHODS.task.list,
        METHODS.task.get,
      ]),
    );

    // The reclaim timer must not keep the process alive or survive close.
    await app.close();
    expect(app.tasks).toBeInstanceOf(TasksService);
  });
});
