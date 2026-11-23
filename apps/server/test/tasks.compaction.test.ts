import { EventStore } from '@agentmesh/core';
import { createLogger, TasksService } from '@agentmesh/server';
import { loadConfig, startServer } from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';

const JWT_SECRET = 'test-secret-value-1234567890';

/**
 * US-021B scheduled compaction.
 *
 * These tests assert the real behaviour end to end:
 *  - a tombstoned bid is physically reclaimed and the frontier advances,
 *  - live bids are never removed,
 *  - the operation is idempotent and a no-op with no bids,
 *  - `runCompaction` enumerates real task ids (the previous sentinel `''`
 *    matched nothing, so compaction silently did nothing),
 *  - the timer is only scheduled when the interval is > 0 (default closed),
 *  - a scheduled tick writes `task.compaction.completed` as a domain-only event.
 */

interface Harness {
  db: ReturnType<typeof openStore>['db'];
  repos: ReturnType<typeof openStore>['repos'];
  events: EventStore;
  service: TasksService;
  close: () => void;
}

function makeHarness(compactionIntervalMs = 0): Harness {
  const store = openStore(':memory:');
  const events = new EventStore(store.db, { workspaceId: 'default' }, store.repos.events);
  const service = new TasksService({
    db: store.db,
    tasks: store.repos.tasks,
    taskBids: store.repos.taskBids,
    accounts: store.repos.accounts,
    events,
    workspaceId: 'default',
    demoMode: false,
    openTtlSeconds: 0,
    compactionIntervalMs,
    clock: () => Date.now(),
    logger: createLogger({ level: 'silent' }),
  });
  return {
    db: store.db,
    repos: store.repos,
    events,
    service,
    close: () => {
      service.stopCompactionTimer();
      store.db.close();
    },
  };
}

async function seedBids(service: TasksService): Promise<{ taskId: string; bidIds: string[] }> {
  const published = await service.publish(
    {
      title: 'Compaction target',
      description: 'US-021B',
      requiredSkills: ['test'],
      budget: 100,
      biddingDeadline: Date.now() + 60_000,
    },
    { agentId: 'admin', role: 'admin' },
  );
  const taskId = published.task.id;

  await service.placeBid(
    { taskId, price: 100, eta: 10, approach: 'a1', confidence: 0.8 },
    { agentId: 'admin', role: 'admin' },
  );
  await service.placeBid(
    { taskId, price: 90, eta: 5, approach: 'a2', confidence: 0.9 },
    { agentId: 'agent2', role: 'agent' },
  );

  const bids = service.listBids(taskId, 'default').bids;
  return { taskId, bidIds: bids.map((bid) => bid.bidId) };
}

const closers: Harness[] = [];
afterEach(() => {
  while (closers.length > 0) {
    closers.pop()?.close();
  }
});

function harness(intervalMs = 0): Harness {
  const h = makeHarness(intervalMs);
  closers.push(h);
  return h;
}

describe('runCompaction (US-021B)', () => {
  it('physically reclaims a tombstone, advances the frontier, keeps live bids', async () => {
    const h = harness();
    const { taskId, bidIds } = await seedBids(h.service);
    expect(bidIds).toHaveLength(2);

    // Tombstone the first bid.
    h.repos.taskBids.markDeleted(bidIds[0]!, Date.now());
    expect(h.repos.taskBids.count(taskId, { includeTombstones: true })).toBe(2);
    expect(h.repos.taskBids.count(taskId)).toBe(1);
    expect(h.repos.taskBids.getStableFrontier(taskId)).toBe(0);

    const result = h.service.runCompaction();
    expect(result.errors).toEqual([]);
    expect(result.compactedTasks).toBe(1);
    expect(result.totalRemoved).toBe(1);

    // Tombstone physically gone, live bid preserved, frontier advanced.
    expect(h.repos.taskBids.count(taskId, { includeTombstones: true })).toBe(1);
    expect(h.repos.taskBids.count(taskId)).toBe(1);
    expect(h.repos.taskBids.getStableFrontier(taskId)).toBeGreaterThan(0);
    expect(h.repos.taskBids.get(bidIds[0]!)).toBeUndefined();
    expect(h.repos.taskBids.get(bidIds[1]!)).toBeDefined();
  });

  it('is idempotent — a second run removes nothing', async () => {
    const h = harness();
    const { taskId, bidIds } = await seedBids(h.service);
    h.repos.taskBids.markDeleted(bidIds[0]!, Date.now());

    expect(h.service.runCompaction().totalRemoved).toBe(1);
    const second = h.service.runCompaction();
    expect(second.compactedTasks).toBe(0);
    expect(second.totalRemoved).toBe(0);
    // Live bid still there.
    expect(h.repos.taskBids.count(taskId)).toBe(1);
  });

  it('is a no-op when there are no bids', async () => {
    const h = harness();
    const result = h.service.runCompaction();
    expect(result).toEqual({ compactedTasks: 0, totalRemoved: 0, errors: [] });
  });
});

describe('compaction timer lifecycle (US-021B)', () => {
  it('is not running until started, ignores interval <= 0, and stops on request', () => {
    const h = harness();
    expect(h.service.isCompactionTimerRunning()).toBe(false);

    h.service.startCompactionTimer(0);
    expect(h.service.isCompactionTimerRunning()).toBe(false);

    h.service.startCompactionTimer(-1);
    expect(h.service.isCompactionTimerRunning()).toBe(false);

    h.service.startCompactionTimer(50);
    expect(h.service.isCompactionTimerRunning()).toBe(true);

    h.service.stopCompactionTimer();
    expect(h.service.isCompactionTimerRunning()).toBe(false);
  });

  it('a scheduled tick writes task.compaction.completed as a domain-only event', async () => {
    const h = harness();
    const { bidIds } = await seedBids(h.service);
    h.repos.taskBids.markDeleted(bidIds[0]!, Date.now());

    h.service.startCompactionTimer(40);
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.service.stopCompactionTimer();

    const compactionEvents = h.events
      .readFrom(0)
      .filter((event) => event.type === 'task.compaction.completed');
    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0]?.payload).toMatchObject({ compactedTasks: 1, totalRemoved: 1 });
  });
});

describe('compaction timer wiring from config (US-021B)', () => {
  it('TASK_BID_COMPACTION_INTERVAL_SECONDS=0 does not start the timer (default closed)', async () => {
    const store = openStore(':memory:');
    const app = await startServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
        JWT_SECRET,
        LOG_LEVEL: 'silent',
        TASK_BID_COMPACTION_INTERVAL_SECONDS: '0',
        ALLOW_ADMIN_SELF_REGISTER: 'true',
      }),
      logger: createLogger({ level: 'silent' }),
      store: { db: store.db, repos: store.repos },
    });
    try {
      expect(app.tasks).toBeDefined();
      expect(app.tasks!.isCompactionTimerRunning()).toBe(false);
    } finally {
      await app.close();
      store.db.close();
    }
  });

  it('a positive interval starts the timer and shutdown clears it', async () => {
    const store = openStore(':memory:');
    const app = await startServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
        JWT_SECRET,
        LOG_LEVEL: 'silent',
        TASK_BID_COMPACTION_INTERVAL_SECONDS: '60',
        ALLOW_ADMIN_SELF_REGISTER: 'true',
      }),
      logger: createLogger({ level: 'silent' }),
      store: { db: store.db, repos: store.repos },
    });
    expect(app.tasks).toBeDefined();
    expect(app.tasks!.isCompactionTimerRunning()).toBe(true);
    await app.close();
    expect(app.tasks!.isCompactionTimerRunning()).toBe(false);
    store.db.close();
  });
});

describe('task.compaction.completed event classification', () => {
  it('is a domain-only event, never a push notification', async () => {
    const { isNotificationEventType, DOMAIN_ONLY_EVENT_TYPES } = await import('@agentmesh/protocol');
    expect(isNotificationEventType('task.compaction.completed')).toBe(false);
    expect(DOMAIN_ONLY_EVENT_TYPES).toContain('task.compaction.completed');
  });
});
