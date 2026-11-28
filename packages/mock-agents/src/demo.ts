import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventStore } from '@agentmesh/core';
import type { DomainEventNotification, EventNotification } from '@agentmesh/protocol';
import {
  AgentMeshClient,
  VersionConflictError,
  type TaskView,
  type TransportFactory,
} from '@agentmesh/sdk';
import {
  AccountsService,
  createLogger,
  createTokenService,
  loadConfig,
  startServer,
} from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { WebSocket } from 'ws';

import { CoderAgent, PlannerAgent, ReviewerAgent } from './agents.js';

const JWT_SECRET = 'demo-secret-value-1234567890';

const nodeTransport: TransportFactory = (url, _options, handlers) => {
  const socket = new WebSocket(url);
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data) => handlers.onMessage(String(data)));
  socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));
  socket.on('error', (error) => handlers.onError(error));
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });

interface CollectedEvent {
  readonly type: string;
  readonly seq: number;
  readonly payload: unknown;
}

export interface DemoTasks {
  readonly code: TaskView;
  readonly rework: TaskView;
  readonly cancelled: TaskView;
}

export interface DemoAward {
  readonly taskId: string;
  readonly awardeeId: string;
  readonly exploration: boolean;
  readonly strategy?: string;
}

export interface DemoVersionConflict {
  readonly taskId?: string;
  readonly expectedVersion?: number;
  readonly currentVersion?: number;
}

export interface DemoResult {
  readonly demoMode: true;
  readonly channelId: string;
  readonly tasks: DemoTasks;
  readonly awards: DemoAward[];
  readonly eventTypes: string[];
  readonly eventSeqs: number[];
  readonly versionConflict: DemoVersionConflict;
  readonly cleanExit: boolean;
}

function summarize(task: TaskView): TaskView {
  return task;
}

/**
 * End-to-end demo: real server + seed admin + three mock agents.
 *
 * Paths:
 *  a) publish → bid → award → progress → complete → review approve → done
 *  b) publish → bid → award → progress → complete → reject → rework → approve → done
 *  c) publish (open) → cancel
 *
 * `DEMO_MODE=true` makes the cold-start exploration branch deterministic. A
 * stale award is attempted on purpose to assert `-32007` context.
 */
export async function runDemo(): Promise<DemoResult> {
  const { db, repos } = openStore(':memory:');
  const events = new EventStore(db, { workspaceId: 'default' }, repos.events);
  const tokens = createTokenService({ secret: JWT_SECRET });
  const accounts = new AccountsService({
    db,
    accounts: repos.accounts,
    events,
    tokens,
    workspaceId: 'default',
  });
  const seeded = accounts.seedAdmin({ name: 'demo-admin' });
  if (seeded.secret === undefined) throw new Error('seedAdmin did not return a secret');

  const app = await startServer({
    config: loadConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: ':memory:',
      JWT_SECRET,
      LOG_LEVEL: 'silent',
      DEMO_MODE: 'true',
    }),
    logger: createLogger({ level: 'silent' }),
    store: { db, repos },
  });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `ws://127.0.0.1:${port}/ws`;
  const makeClient = (): AgentMeshClient =>
    new AgentMeshClient({
      url,
      transportFactory: nodeTransport,
      autoReconnect: false,
      gapPolicy: 'strict',
    });

  const plannerClient = makeClient();
  const coderClient = makeClient();
  const reviewerClient = makeClient();
  const planner = new PlannerAgent(plannerClient, { name: 'demo-admin' });
  const coder = new CoderAgent(coderClient, { name: 'demo-coder', availability: 0.9 });
  const reviewer = new ReviewerAgent(reviewerClient, { name: 'demo-reviewer' });

  try {
    await Promise.all([
      plannerClient.connect(),
      coderClient.connect(),
      reviewerClient.connect(),
    ]);
    await planner.authenticate({ name: 'demo-admin', secret: seeded.secret });
    await coder.register();
    await reviewer.register();

    const channel = await plannerClient.createChannel({ name: 'demo' });
    const channelId = channel.channel.channelId;
    await coder.join(channelId);
    await reviewer.join(channelId);

    const collected: CollectedEvent[] = [];
    const record = (type: string) =>
      (
        payload: unknown,
        envelope?: EventNotification | DomainEventNotification,
      ): void => {
        if (envelope !== undefined) {
          collected.push({ type, seq: envelope.seq, payload });
        }
      };
    plannerClient.on('task.bid.received', record('task.bid.received'));
    plannerClient.on('task.awarded', record('task.awarded'));
    plannerClient.on('task.progress.updated', record('task.progress.updated'));
    plannerClient.on('task.completed', record('task.completed'));
    plannerClient.on('task.review.decided', record('task.review.decided'));
    plannerClient.on('task.cancelled', record('task.cancelled'));

    // (a) approve path
    const codeTask = await plannerClient.publishTask({
      title: 'implement feature',
      requiredSkills: ['typescript'],
      biddingDeadline: Date.now() + 60_000,
    });
    await coder.bid(codeTask.task.id, { price: 100, eta: 30 });
    await reviewer.bid(codeTask.task.id, { price: 120, eta: 45 });
    const awarded = await plannerClient.award({
      taskId: codeTask.task.id,
      expectedVersion: 1,
      strategy: 'auto',
    });

    // Failure injection: a stale award must surface -32007.
    let versionConflict: DemoVersionConflict = {};
    try {
      await plannerClient.award({
        taskId: codeTask.task.id,
        expectedVersion: 1,
        strategy: 'auto',
      });
      throw new Error('expected a VersionConflictError from the stale award');
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      versionConflict = {
        ...(error.taskId === undefined ? {} : { taskId: error.taskId }),
        ...(error.expectedVersion === undefined
          ? {}
          : { expectedVersion: error.expectedVersion }),
        ...(error.currentVersion === undefined
          ? {}
          : { currentVersion: error.currentVersion }),
      };
    }

    await coder.executeTask(codeTask.task.id, 50, {
      note: 'first implementation',
      artifacts: ['artifact://code/v1'],
    });
    const codeReview = await plannerClient.getTask({ taskId: codeTask.task.id });
    await planner.review(codeTask.task.id, codeReview.version, 'approve', 'looks good');

    // (b) reject → rework → approve path
    const reworkTask = await plannerClient.publishTask({
      title: 'review design',
      requiredSkills: ['review'],
      biddingDeadline: Date.now() + 60_000,
    });
    await coder.bid(reworkTask.task.id, { price: 120, eta: 45 });
    await reviewer.bid(reworkTask.task.id, { price: 80, eta: 20 });
    await plannerClient.award({
      taskId: reworkTask.task.id,
      expectedVersion: 1,
      strategy: 'auto',
    });
    await reviewer.executeTask(reworkTask.task.id, 40, {
      note: 'first draft',
      artifacts: ['artifact://review/v1'],
    });
    const firstReview = await plannerClient.getTask({ taskId: reworkTask.task.id });
    await planner.review(
      reworkTask.task.id,
      firstReview.version,
      'request-revision',
      'needs another pass',
    );
    await reviewer.executeTask(reworkTask.task.id, 60, {
      note: 'second draft',
      artifacts: ['artifact://review/v2'],
    });
    const secondReview = await plannerClient.getTask({ taskId: reworkTask.task.id });
    await planner.review(reworkTask.task.id, secondReview.version, 'approve', 'accepted');

    // (c) cancel path
    const cancelledTask = await plannerClient.publishTask({ title: 'obsolete draft' });
    await plannerClient.cancel({
      taskId: cancelledTask.task.id,
      expectedVersion: 1,
      reason: 'no longer needed',
    });

    await delay(100);

    const finalCode = await plannerClient.getTask({ taskId: codeTask.task.id });
    const finalRework = await plannerClient.getTask({ taskId: reworkTask.task.id });
    const finalCancelled = await plannerClient.getTask({ taskId: cancelledTask.task.id });

    const awards: DemoAward[] = collected
      .filter((event) => event.type === 'task.awarded')
      .map((event) => {
        const payload = event.payload as {
          taskId: string;
          awardeeId: string;
          exploration: boolean;
          strategy?: string;
        };
        return {
          taskId: payload.taskId,
          awardeeId: payload.awardeeId,
          exploration: payload.exploration,
          ...(payload.strategy === undefined ? {} : { strategy: payload.strategy }),
        };
      });

    void awarded;

    const result: Omit<DemoResult, 'cleanExit'> = {
      demoMode: true,
      channelId,
      tasks: {
        code: summarize(finalCode),
        rework: summarize(finalRework),
        cancelled: summarize(finalCancelled),
      },
      awards,
      eventTypes: collected.map((event) => event.type),
      eventSeqs: collected.map((event) => event.seq),
      versionConflict,
    };

    planner.close();
    coder.close();
    reviewer.close();
    plannerClient.close();
    coderClient.close();
    reviewerClient.close();
    await app.close();
    db.close();

    return {
      ...result,
      cleanExit:
        plannerClient.state === 'closed' &&
        coderClient.state === 'closed' &&
        reviewerClient.state === 'closed',
    };
  } catch (error) {
    planner.close();
    coder.close();
    reviewer.close();
    plannerClient.close();
    coderClient.close();
    reviewerClient.close();
    await app.close();
    db.close();
    throw error;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  runDemo()
    .then((result) => {
      const json = JSON.stringify(result, null, 2);
      writeFileSync('demo-output.json', `${json}\n`, 'utf8');
      process.stdout.write(`${json}\n`);
      if (result.tasks.code.status !== 'done') process.exitCode = 1;
      if (result.tasks.rework.status !== 'done') process.exitCode = 1;
      if (result.tasks.cancelled.status !== 'cancelled') process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
