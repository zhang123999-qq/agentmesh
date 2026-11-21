import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventStore } from '@agentmesh/core';
import {
  AccountsService,
  createLogger,
  createTokenService,
  loadConfig,
  startServer,
} from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

import { run } from '../src/cli.js';
import { saveConfig } from '../src/config.js';

const JWT_SECRET = 'cli-test-secret-value-1234567890';

interface Harness {
  readonly url: string;
  readonly home: string;
  readonly adminId: string;
  readonly adminSecret: string;
  readonly close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
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
  const seeded = accounts.seedAdmin({ name: 'cli-admin' });
  if (seeded.secret === undefined) throw new Error('seedAdmin did not return a secret');

  const app = await startServer({
    config: loadConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: ':memory:',
      JWT_SECRET,
      LOG_LEVEL: 'silent',
    }),
    logger: createLogger({ level: 'silent' }),
    store: { db, repos },
  });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-cli-home-'));

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    home,
    adminId: seeded.agentId,
    adminSecret: seeded.secret,
    close: async () => {
      await app.close();
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

interface CliResult {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly text: string;
  readonly errText: string;
}

async function cli(harness: Harness, argv: readonly string[]): Promise<CliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    env: { AGENTMESH_URL: harness.url } as NodeJS.ProcessEnv,
    homeDir: harness.home,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out, err, text: out.join('\n'), errText: err.join('\n') };
}

async function loginAdmin(harness: Harness): Promise<void> {
  const result = await cli(harness, [
    'login',
    '--profile',
    'admin',
    '--agent-id',
    harness.adminId,
    '--secret',
    harness.adminSecret,
  ]);
  expect(result.code).toBe(0);
}

async function registerWorker(harness: Harness): Promise<string> {
  const result = await cli(harness, [
    'register',
    '--profile',
    'worker',
    '--name',
    'cli-worker',
    '--skills',
    'typescript,docs',
  ]);
  expect(result.code).toBe(0);
  const config = JSON.parse(
    readFileSync(join(harness.home, 'profiles', 'worker.json'), 'utf8'),
  ) as { agentId?: string; token?: string };
  expect(config.token).toBeDefined();
  if (config.agentId === undefined) throw new Error('worker config has no agentId');
  return config.agentId;
}

describe('agentmesh CLI against the real server', () => {
  it('logs in, persists only the token and reports whoami', async () => {
    const harness = await startHarness();
    try {
      await loginAdmin(harness);
      const configPath = join(harness.home, 'profiles', 'admin.json');
      const raw = readFileSync(configPath, 'utf8');
      expect(raw).toContain('token');
      expect(raw).not.toContain(harness.adminSecret);

      const who = await cli(harness, ['whoami', '--profile', 'admin']);
      expect(who.code).toBe(0);
      expect(who.text).toContain(harness.adminId);
      expect(who.text).toContain('role:      admin');

      const workerId = await registerWorker(harness);
      expect(workerId).toMatch(/^agt_/);
    } finally {
      await harness.close();
    }
  }, 20_000);

  it('creates a channel, sends messages and pages history with both cursors', async () => {
    const harness = await startHarness();
    try {
      await loginAdmin(harness);
      await registerWorker(harness);

      const created = await cli(harness, [
        'channel',
        'create',
        '--profile',
        'admin',
        '--name',
        'cli-general',
        '--json',
      ]);
      expect(created.code).toBe(0);
      const channel = JSON.parse(created.text) as {
        channel: { channelId: string };
      };
      const channelId = channel.channel.channelId;

      expect(
        (
          await cli(harness, [
            'channel',
            'join',
            '--profile',
            'worker',
            '--channel',
            channelId,
          ])
        ).code,
      ).toBe(0);

      for (const body of ['one', 'two', 'three']) {
        const sent = await cli(harness, [
          'message',
          'send',
          '--profile',
          'admin',
          '--channel',
          channelId,
          '--body',
          body,
          '--json',
        ]);
        expect(sent.code).toBe(0);
      }

      const latest = await cli(harness, [
        'message',
        'history',
        '--profile',
        'worker',
        '--channel',
        channelId,
        '--json',
      ]);
      expect(latest.code).toBe(0);
      const page = JSON.parse(latest.text) as {
        channelTotal: number;
        messages: Array<{ body: string; seq: number }>;
        hasMoreBefore: boolean;
      };
      expect(page.channelTotal).toBe(3);
      expect(page.messages.map((message) => message.body)).toEqual([
        'one',
        'two',
        'three',
      ]);

      const firstSeq = page.messages[0]?.seq;
      expect(firstSeq).toBeDefined();
      const after = await cli(harness, [
        'message',
        'history',
        '--profile',
        'worker',
        '--channel',
        channelId,
        '--after-seq',
        String(firstSeq),
        '--json',
      ]);
      const afterPage = JSON.parse(after.text) as { messages: Array<{ body: string }> };
      expect(afterPage.messages.map((message) => message.body)).toEqual(['two', 'three']);

      const lastSeq = page.messages[2]?.seq;
      const before = await cli(harness, [
        'message',
        'history',
        '--profile',
        'worker',
        '--channel',
        channelId,
        '--before-seq',
        String(lastSeq),
        '--json',
      ]);
      const beforePage = JSON.parse(before.text) as {
        messages: Array<{ body: string }>;
        hasMoreBefore: boolean;
      };
      expect(beforePage.messages.map((message) => message.body)).toEqual(['one', 'two']);
      expect(beforePage.hasMoreBefore).toBe(false);

      const human = await cli(harness, [
        'message',
        'history',
        '--profile',
        'worker',
        '--channel',
        channelId,
      ]);
      expect(human.text).toContain('3 message(s) total');
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('drives bidding → award → progress → complete → review and explains -32007', async () => {
    const harness = await startHarness();
    try {
      await loginAdmin(harness);
      const workerId = await registerWorker(harness);

      const published = await cli(harness, [
        'task',
        'publish',
        '--profile',
        'admin',
        '--title',
        'CLI task',
        '--description',
        'exercise the lifecycle',
        '--skills',
        'typescript',
        '--bidding-deadline',
        String(Date.now() + 60_000),
        '--json',
      ]);
      expect(published.code).toBe(0);
      const task = JSON.parse(published.text) as {
        task: { id: string; version: number; status: string };
      };
      expect(task.task.status).toBe('bidding');
      const taskId = task.task.id;

      expect(
        (
          await cli(harness, [
            'task',
            'bid',
            '--profile',
            'worker',
            '--task',
            taskId,
            '--price',
            '10',
            '--eta',
            '2',
            '--confidence',
            '0.8',
          ])
        ).code,
      ).toBe(0);

      const bids = await cli(harness, [
        'task',
        'bids',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--json',
      ]);
      const bidList = JSON.parse(bids.text) as {
        bids: Array<{ agentId: string }>;
      };
      expect(bidList.bids[0]?.agentId).toBe(workerId);

      const beforeAward = await cli(harness, [
        'task',
        'get',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--json',
      ]);
      const versionBeforeAward = (JSON.parse(beforeAward.text) as { version: number })
        .version;

      const award = await cli(harness, [
        'task',
        'award',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--expected-version',
        String(versionBeforeAward),
        '--awardee',
        workerId,
      ]);
      expect(award.code).toBe(0);
      expect(award.text).toContain(workerId);

      const stale = await cli(harness, [
        'task',
        'award',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--expected-version',
        String(versionBeforeAward),
        '--awardee',
        workerId,
      ]);
      expect(stale.code).toBe(1);
      expect(stale.errText).toContain('version conflict');
      expect(stale.errText).toContain('current:');
      expect(stale.errText).toContain('--expected-version');

      const progress = await cli(harness, [
        'task',
        'progress',
        '--profile',
        'worker',
        '--task',
        taskId,
        '--progress',
        '40',
      ]);
      expect(progress.code).toBe(0);
      expect(progress.text).toContain('40%');

      const afterProgress = await cli(harness, [
        'task',
        'get',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--json',
      ]);
      const versionForComplete = (JSON.parse(afterProgress.text) as { version: number })
        .version;

      const complete = await cli(harness, [
        'task',
        'complete',
        '--profile',
        'worker',
        '--task',
        taskId,
        '--expected-version',
        String(versionForComplete),
        '--note',
        'ready for review',
      ]);
      expect(complete.code).toBe(0);

      const inReview = await cli(harness, [
        'task',
        'get',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--json',
      ]);
      const reviewView = JSON.parse(inReview.text) as {
        status: string;
        version: number;
      };
      expect(reviewView.status).toBe('review');

      const review = await cli(harness, [
        'task',
        'review',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--expected-version',
        String(reviewView.version),
        '--decision',
        'approve',
      ]);
      expect(review.code).toBe(0);

      const done = await cli(harness, [
        'task',
        'get',
        '--profile',
        'admin',
        '--task',
        taskId,
        '--json',
      ]);
      const doneView = JSON.parse(done.text) as {
        status: string;
        completedAt: number | null;
      };
      expect(doneView.status).toBe('done');
      expect(doneView.completedAt).not.toBeNull();
    } finally {
      await harness.close();
    }
  }, 40_000);

  it('reports doctor failures for expired tokens and unknown resources', async () => {
    const harness = await startHarness();
    try {
      const payload = Buffer.from(
        JSON.stringify({ sub: 'agt_expired', exp: Math.floor(Date.now() / 1000) - 60 }),
      ).toString('base64url');
      const expiredToken = `header.${payload}.signature`;
      saveConfig(join(harness.home, 'profiles', 'expired.json'), {
        url: harness.url,
        agentId: 'agt_expired',
        token: expiredToken,
      });

      const expired = await cli(harness, ['doctor', '--profile', 'expired']);
      expect(expired.code).toBe(1);
      expect(expired.text).toContain('FAIL token');
      expect(expired.text).toContain('expired');

      await loginAdmin(harness);
      const missing = await cli(harness, [
        'task',
        'get',
        '--profile',
        'admin',
        '--task',
        'tsk_missing',
      ]);
      expect(missing.code).toBe(1);
      expect(missing.errText).toContain('not found');
      expect(missing.errText).toContain('tsk_missing');

      const ok = await cli(harness, ['doctor', '--profile', 'admin']);
      expect(ok.code).toBe(0);
      expect(ok.text).toContain('PASS connection');
      expect(ok.text).toContain('PASS read rpc');
    } finally {
      await harness.close();
    }
  }, 20_000);

  it('returns exit code 2 for usage errors and missing required CAS versions', async () => {
    const harness = await startHarness();
    try {
      const unknown = await cli(harness, ['frobnicate']);
      expect(unknown.code).toBe(2);
      expect(unknown.errText).toContain('unknown command: frobnicate');

      await loginAdmin(harness);
      const missingVersion = await cli(harness, [
        'task',
        'cancel',
        '--profile',
        'admin',
        '--task',
        'tsk_whatever',
      ]);
      expect(missingVersion.code).toBe(2);
      expect(missingVersion.errText).toContain('missing required flag --expected-version');
    } finally {
      await harness.close();
    }
  }, 20_000);
});
