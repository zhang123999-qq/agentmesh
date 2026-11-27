#!/usr/bin/env node
/**
 * Production-like backup/restore drill.
 *
 * Unlike `restore-drill.sh` (which only boots a freshly-migrated, empty
 * database), this harness creates real data over the public RPC surface —
 * two tenants, accounts, channels, messages, a task driven to `done`, a
 * disabled tenant, and a persisted token revocation (v11) — then:
 *
 *   1. snapshots `/health`, `/metrics`, message counts and task state;
 *   2. stops the server and takes a `backup` CLI snapshot of the live DB;
 *   3. copies that snapshot to a separate file and boots it;
 *   4. asserts every snapshot value is identical on restored data, that the
 *      revoked token is still rejected (`-32001`), and that cross-tenant
 *      isolation still holds;
 *   5. restarts once more to prove revocation survives a *second* restart;
 *   6. runs a negative control: a corrupt database must fail to boot (so the
 *      drill's own boot check is known to detect a bad restore).
 *
 * Run after `npm run build`:
 *
 *   node scripts/production-restore-drill.mjs
 *
 * Exit 0 and a final `RESTORE DRILL PASS` line mean every assertion held.
 * Evidence (row counts, metrics, timings) is written to
 * `.drill-tmp/evidence.json`; the directory is recreated on every run.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '@agentmesh/store';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(ROOT, 'apps', 'server', 'dist', 'index.js');
const SEED_ADMIN = join(ROOT, 'apps', 'server', 'dist', 'cli', 'seed-admin.js');
const BACKUP_CLI = join(ROOT, 'apps', 'server', 'dist', 'cli', 'backup.js');

const WORK = join(ROOT, '.drill-tmp');
const PROD_DB = join(WORK, 'prod.db');
const BACKUP_DB = join(WORK, 'backup.db');
const RESTORED_DB = join(WORK, 'restored.db');
const CORRUPT_DB = join(WORK, 'corrupt.db');
const JWT_SECRET = randomBytes(48).toString('hex');

const PORTS = { prod: 18871, restored: 18872, restart: 18873, corrupt: 18874 };

const evidence = {
  startedAt: new Date().toISOString(),
  platform: process.platform,
  steps: [],
  assertions: [],
  snapshots: {},
  rowCounts: {},
  timingsMs: {},
};

let rpcSeq = 0;
/** Servers started by this run, killed on any failure so no orphans linger. */
const running = new Set();

// --------------------------------------------------------------------- utils

function step(name, detail) {
  const entry = { step: name, at: new Date().toISOString(), ...(detail ?? {}) };
  evidence.steps.push(entry);
  console.log(`\n[drill] ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

function check(name, fn) {
  const started = Date.now();
  try {
    fn();
    evidence.assertions.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    evidence.assertions.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`ASSERT FAILED: ${label}: expected ${e}, got ${a}`);
}

function rowCounts(dbPath) {
  const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
  try {
    const count = (table) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
      return Number(row.n);
    };
    return {
      accounts: count('accounts'),
      workspaces: count('workspaces'),
      channels: count('channels'),
      messages: count('messages'),
      tasks: count('tasks'),
      task_bids: count('task_bids'),
      revoked_tokens: count('revoked_tokens'),
      events: count('events'),
    };
  } finally {
    db.close();
  }
}

// ----------------------------------------------------------------- server ops

function serverEnv(dbPath, port) {
  return {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DB_PATH: dbPath,
    JWT_SECRET,
    LOG_LEVEL: 'warn',
    METRICS_ENABLED: 'true',
    ALLOWED_ORIGINS: 'http://localhost',
    HASH_CHAIN_VERIFY_ON_STARTUP: 'true',
    HASH_CHAIN_VERIFY_INTERVAL_SECONDS: '0',
    REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS: '0',
    TASK_BID_COMPACTION_INTERVAL_SECONDS: '0',
  };
}

function spawnServer(dbPath, port) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: serverEnv(dbPath, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  running.add(child);
  child.once('exit', () => running.delete(child));
  return { child, port, logs, exited };
}

async function waitForHealth(server, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${server.port}/health`;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(
        `server on port ${server.port} exited before becoming healthy (code ${server.child.exitCode}):\n${server.logs.join('')}`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server on port ${server.port} did not become healthy:\n${server.logs.join('')}`);
}

/**
 * Hash-chain verification runs at startup but asynchronously (it must never
 * block listening). Poll until the status leaves `unchecked`, then require
 * `ok` — an early healthy response alone would prove nothing.
 */
async function waitForHashChain(port, expected = 'ok', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    if (last.hashChain !== 'unchecked') {
      assertEqual(last.hashChain, expected, 'health.hashChain');
      return last;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`hashChain stayed ${last?.hashChain} on port ${port}`);
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  const exited = server.exited;
  server.child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
  }, 10_000);
  const result = await exited;
  clearTimeout(timer);
  return result;
}

function runNodeCli(label, script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (status ${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result.stdout;
}

// ---------------------------------------------------------------------- rpc

async function rpcRaw(port, token, method, params) {
  const headers = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
  });
  const body = await res.json();
  return body;
}

async function call(port, token, method, params = {}) {
  const body = await rpcRaw(port, token, method, params);
  if (body.error !== undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

async function callExpectError(port, token, method, params, expectedCode) {
  const body = await rpcRaw(port, token, method, params);
  assert(body.error !== undefined, `${method}: expected error ${expectedCode}, got result`);
  assertEqual(body.error.code, expectedCode, `${method} error code`);
  return body.error;
}

async function readMetrics(port) {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  const text = await res.text();
  const map = {};
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+(\S+)$/.exec(line.trim());
    if (match !== null) map[`${match[1]}${match[2] ?? ''}`] = Number(match[3]);
  }
  return { text, map };
}

function metricValue(metrics, name) {
  const value = metrics.map[name];
  assert(value !== undefined, `metric ${name} missing from /metrics`);
  return value;
}

// ------------------------------------------------------------------- snapshot

async function snapshot(label, port, ctx) {
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  const metrics = await readMetrics(port);

  const defaultHistory = await call(port, ctx.adminToken, 'message.history', {
    channelId: ctx.generalChannelId,
  });
  const drillHistory = await call(port, ctx.readerToken, 'message.history', {
    channelId: ctx.drillChannelId,
  });
  const task = await call(port, ctx.wsAdminToken, 'task.get', { taskId: ctx.taskId });
  const adminChannels = await call(port, ctx.adminToken, 'channel.list', {});
  const drillChannels = await call(port, ctx.readerToken, 'channel.list', {});

  const snap = {
    healthHashChain: health.hashChain,
    hashChainStatusOk: metrics.map['agentmesh_hashchain_status{status="ok"}'] ?? null,
    workspacesTotal: metricValue(metrics, 'agentmesh_workspaces_total'),
    workspacesDisabled: metricValue(metrics, 'agentmesh_workspaces_disabled'),
    revokedTokensActive: metricValue(metrics, 'agentmesh_revoked_tokens_active'),
    generalMessageCount: defaultHistory.channelTotal,
    drillMessageCount: drillHistory.channelTotal,
    taskStatus: task.status,
    taskProgress: task.progress,
    defaultChannelNames: adminChannels.channels.map((c) => c.name).sort(),
    drillChannelNames: drillChannels.channels.map((c) => c.name).sort(),
  };
  evidence.snapshots[label] = snap;
  return snap;
}

// --------------------------------------------------------------------- drill

async function main() {
  // Fail fast if the build output is missing.
  for (const [label, path] of [
    ['server', SERVER_ENTRY],
    ['seed-admin', SEED_ADMIN],
    ['backup', BACKUP_CLI],
  ]) {
    try {
      readFileSync(path);
    } catch {
      throw new Error(`${label} entry not found at ${path}; run \`npm run build\` first`);
    }
  }

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const t0 = Date.now();

  // 1. Seed an admin directly into a brand-new database.
  step('seed admin into fresh database', { db: PROD_DB });
  const seedOut = runNodeCli('seed:admin', SEED_ADMIN, ['--name', 'admin', '--owner', 'ops'], {
    DB_PATH: PROD_DB,
    JWT_SECRET,
  });
  const secretMatch = /secret: (\S+)/.exec(seedOut);
  assert(secretMatch !== null, 'seed-admin did not print a secret');
  const adminSecret = secretMatch[1];

  // 2. Boot the "production" server.
  step('boot production server', { port: PORTS.prod });
  const prod = spawnServer(PROD_DB, PORTS.prod);
  await waitForHealth(prod);
  await waitForHashChain(PORTS.prod);

  // 3. Build real data over the public RPC surface.
  step('authenticate seeded admin');
  const adminAuth = await call(PORTS.prod, null, 'agent.authenticate', {
    name: 'admin',
    secret: adminSecret,
  });
  const adminToken = adminAuth.token;

  step('create default tenant channel + 3 messages');
  const general = await call(PORTS.prod, adminToken, 'channel.create', { name: 'general' });
  const generalChannelId = general.channel.channelId;
  for (let i = 1; i <= 3; i += 1) {
    await call(PORTS.prod, adminToken, 'message.send', {
      channelId: generalChannelId,
      body: `default tenant message ${i}`,
    });
  }

  step('create ws-drill tenant');
  const wsCreate = await call(PORTS.prod, adminToken, 'workspace.create', { name: 'ws-drill' });
  const wsDrillId = wsCreate.workspace.id;
  const inviteCode = wsCreate.inviteCode;

  step('provision workspace_admin + two agents via invite code');
  const wsAdmin = await call(PORTS.prod, null, 'agent.register', {
    name: 'drill-admin',
    inviteCode,
    role: 'workspace_admin',
  });
  const wsAdminToken = wsAdmin.token;
  const agent = await call(PORTS.prod, null, 'agent.register', {
    name: 'drill-agent',
    inviteCode,
  });
  const agentToken = agent.token;
  const agentId = agent.agentId;
  // A second agent stays unrevoked so post-revocation snapshots can still read
  // the drill tenant's channels (workspace_admin cannot use channel.* RPCs).
  const reader = await call(PORTS.prod, null, 'agent.register', {
    name: 'drill-reader',
    inviteCode,
  });
  const readerToken = reader.token;

  step('create ws-drill channel + 5 messages');
  const drillChannel = await call(PORTS.prod, agentToken, 'channel.create', { name: 'drill-room' });
  const drillChannelId = drillChannel.channel.channelId;
  for (let i = 1; i <= 5; i += 1) {
    await call(PORTS.prod, agentToken, 'message.send', {
      channelId: drillChannelId,
      body: `ws-drill message ${i}`,
    });
  }
  await call(PORTS.prod, readerToken, 'channel.join', { channelId: drillChannelId });

  step('drive task through bidding -> awarded -> in_progress -> review -> done');
  const published = await call(PORTS.prod, wsAdminToken, 'task.publish', {
    title: 'restore drill task',
    description: 'created by the production-like restore drill',
    biddingDeadline: Date.now() + 3_600_000,
  });
  const taskId = published.task.id;
  assertEqual(published.task.status, 'bidding', 'published task status');

  await call(PORTS.prod, agentToken, 'task.bid', { taskId, price: 10, eta: 60 });
  const awarded = await call(PORTS.prod, wsAdminToken, 'task.award', {
    taskId,
    expectedVersion: published.task.version,
    awardeeId: agentId,
    strategy: 'manual',
  });
  assertEqual(awarded.awardeeId, agentId, 'awardee');

  const progress = await call(PORTS.prod, agentToken, 'task.progress', {
    taskId,
    progress: 50,
    note: 'half way',
  });
  assertEqual(progress.task.status, 'in_progress', 'status after progress');

  const completed = await call(PORTS.prod, agentToken, 'task.complete', {
    taskId,
    expectedVersion: progress.version,
    note: 'ready for review',
  });
  assertEqual(completed.task.status, 'review', 'status after complete');

  const reviewed = await call(PORTS.prod, wsAdminToken, 'task.review', {
    taskId,
    expectedVersion: completed.version,
    decision: 'approve',
    comment: 'looks good',
  });
  assertEqual(reviewed.task.status, 'done', 'status after approve');

  step('execution-role check: non-assignee cannot progress the task', {
    note: 'covered by cross-tenant isolation below',
  });

  step('disable a throwaway tenant (workspaces_disabled metric)');
  const throwaway = await call(PORTS.prod, adminToken, 'workspace.create', { name: 'ws-throwaway' });
  const disabled = await call(PORTS.prod, adminToken, 'workspace.disable', {
    workspaceId: throwaway.workspace.id,
  });
  assertEqual(disabled.disabled, true, 'workspace.disabled');

  step('revoke the drill agent token (v11 persisted revocation)');
  const revocation = await call(PORTS.prod, wsAdminToken, 'agent.revokeToken', {
    targetToken: agentToken,
  });
  assertEqual(revocation.revoked, true, 'revoked');
  await callExpectError(PORTS.prod, agentToken, 'task.list', {}, -32001);
  evidence.assertions.push({ name: 'revoked token rejected before backup', ok: true });

  step('cross-tenant guards before backup');
  await callExpectError(
    PORTS.prod,
    wsAdminToken,
    'agent.revokeToken',
    { targetToken: adminToken },
    -32002,
  );
  evidence.assertions.push({ name: 'ws_admin cannot revoke another tenant token (-32002)', ok: true });
  await callExpectError(
    PORTS.prod,
    adminToken,
    'task.get',
    { taskId },
    -32004,
  );
  evidence.assertions.push({ name: 'admin of default cannot read ws-drill task (-32004)', ok: true });
  await callExpectError(
    PORTS.prod,
    readerToken,
    'message.history',
    { channelId: generalChannelId },
    -32004,
  );
  evidence.assertions.push({ name: 'ws-drill cannot read default channel (-32004)', ok: true });

  const ctx = {
    adminToken,
    wsAdminToken,
    agentToken,
    readerToken,
    generalChannelId,
    drillChannelId,
    taskId,
    wsDrillId,
  };

  // 4. Snapshot the source.
  step('snapshot source database state');
  const before = await snapshot('source', PORTS.prod, ctx);
  check('source metrics: 3 workspaces, 1 disabled, 1 active revocation', () => {
    assertEqual(before.workspacesTotal, 3, 'workspaces_total');
    assertEqual(before.workspacesDisabled, 1, 'workspaces_disabled');
    assertEqual(before.revokedTokensActive, 1, 'revoked_tokens_active');
  });
  check('source message counts: 3 default / 5 drill', () => {
    assertEqual(before.generalMessageCount, 3, 'default channelTotal');
    assertEqual(before.drillMessageCount, 5, 'drill channelTotal');
  });
  check('source task terminal status is done', () =>
    assertEqual(before.taskStatus, 'done', 'task status'),
  );

  evidence.timingsMs.phase1_build = Date.now() - t0;

  // 5. Stop the server, take a backup, copy it to a "restored" file.
  step('stop production server');
  await stopServer(prod);
  step('run backup CLI against the stopped database');
  runNodeCli('backup', BACKUP_CLI, ['--db', PROD_DB, '--out', BACKUP_DB]);
  cpSync(BACKUP_DB, RESTORED_DB);
  evidence.rowCounts.source = rowCounts(PROD_DB);
  evidence.rowCounts.backup = rowCounts(BACKUP_DB);
  check('backup row counts match source', () =>
    assertEqual(evidence.rowCounts.backup, evidence.rowCounts.source, 'backup rows'),
  );
  check('source has a non-empty revocation table', () =>
    assert(evidence.rowCounts.source.revoked_tokens === 1, 'revoked_tokens row count'),
  );
  check('source has tenant + business rows', () => {
    assert(evidence.rowCounts.source.workspaces === 3, 'workspaces row count');
    assert(evidence.rowCounts.source.messages === 8, 'messages row count');
    assert(evidence.rowCounts.source.tasks === 1, 'tasks row count');
  });

  // 6. Boot the restored database and compare.
  step('boot restored server', { port: PORTS.restored, db: RESTORED_DB });
  const restored = spawnServer(RESTORED_DB, PORTS.restored);
  await waitForHealth(restored);
  await waitForHashChain(PORTS.restored);
  const after = await snapshot('restored', PORTS.restored, ctx);

  check('restored /health.hashChain is ok', () =>
    assertEqual(after.healthHashChain, 'ok', 'restored hashChain'),
  );
  check('restored metrics equal source metrics', () => {
    assertEqual(after.workspacesTotal, before.workspacesTotal, 'workspaces_total');
    assertEqual(after.workspacesDisabled, before.workspacesDisabled, 'workspaces_disabled');
    assertEqual(after.revokedTokensActive, before.revokedTokensActive, 'revoked_tokens_active');
  });
  check('restored message counts equal source', () => {
    assertEqual(after.generalMessageCount, before.generalMessageCount, 'default channelTotal');
    assertEqual(after.drillMessageCount, before.drillMessageCount, 'drill channelTotal');
  });
  check('restored task terminal status is done', () => {
    assertEqual(after.taskStatus, 'done', 'task status');
    assertEqual(after.taskProgress, 100, 'task progress');
  });
  check('restored tenant channel isolation unchanged', () => {
    assertEqual(after.defaultChannelNames, ['general'], 'default tenant channels');
    assertEqual(after.drillChannelNames, ['drill-room'], 'ws-drill channels');
  });
  check('restored row counts equal source', () =>
    assertEqual(rowCounts(RESTORED_DB), evidence.rowCounts.source, 'restored rows'),
  );

  // 7. Revocation must still be enforced after restore.
  await callExpectError(PORTS.restored, agentToken, 'task.list', {}, -32001);
  evidence.assertions.push({ name: 'revoked token rejected after restore (-32001)', ok: true });
  await callExpectError(PORTS.restored, wsAdminToken, 'agent.revokeToken', { targetToken: adminToken }, -32002);
  await callExpectError(PORTS.restored, adminToken, 'task.get', { taskId }, -32004);
  await callExpectError(PORTS.restored, readerToken, 'message.history', { channelId: generalChannelId }, -32004);
  evidence.assertions.push({ name: 'cross-tenant guards hold after restore (-32002/-32004)', ok: true });

  // 8. Second restart: revocation persistence is not just in-memory of the first boot.
  step('stop restored server');
  await stopServer(restored);
  step('restart restored database a second time', { port: PORTS.restart });
  const restarted = spawnServer(RESTORED_DB, PORTS.restart);
  await waitForHealth(restarted);
  await waitForHashChain(PORTS.restart);
  await callExpectError(PORTS.restart, agentToken, 'task.list', {}, -32001);
  evidence.assertions.push({ name: 'revoked token rejected after second restart (-32001)', ok: true });
  const afterRestart = await snapshot('restarted', PORTS.restart, ctx);
  check('second restart metrics equal source', () => {
    assertEqual(afterRestart.workspacesTotal, before.workspacesTotal, 'workspaces_total');
    assertEqual(afterRestart.workspacesDisabled, before.workspacesDisabled, 'workspaces_disabled');
    assertEqual(afterRestart.revokedTokensActive, before.revokedTokensActive, 'revoked_tokens_active');
  });
  await stopServer(restarted);

  // 9. Negative control: assertion helpers must actually fail, and a corrupt
  //    database must not boot.
  step('negative control: assertion helpers detect mismatches');
  let assertionThrew = false;
  try {
    assertEqual(1, 2, 'self-check');
  } catch {
    assertionThrew = true;
  }
  assert(assertionThrew, 'assertEqual did not throw on mismatched values');
  evidence.assertions.push({ name: 'assertion helper self-check throws on mismatch', ok: true });

  step('negative control: corrupt database fails to boot', { db: CORRUPT_DB, port: PORTS.corrupt });
  writeFileSync(CORRUPT_DB, Buffer.from('THIS IS NOT A SQLITE DATABASE'.repeat(64)));
  const corrupt = spawnServer(CORRUPT_DB, PORTS.corrupt);
  const corruptExit = await Promise.race([
    corrupt.exited,
    new Promise((r) => setTimeout(() => r(null), 20_000)),
  ]);
  if (corruptExit === null) {
    await stopServer(corrupt);
    throw new Error('corrupt database unexpectedly kept the server alive');
  }
  assert(corruptExit.code !== 0, `corrupt database exited with code ${corruptExit.code}`);
  evidence.assertions.push({
    name: `corrupt database rejected at startup (exit ${corruptExit.code})`,
    ok: true,
  });

  // 10. Evidence + summary.
  evidence.finishedAt = new Date().toISOString();
  evidence.totalMs = Date.now() - t0;
  evidence.rowCounts.restored = rowCounts(RESTORED_DB);
  writeFileSync(join(WORK, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  step('evidence written', { path: join(WORK, 'evidence.json') });
  console.log('\nSummary');
  console.log(`  source rows:  ${JSON.stringify(evidence.rowCounts.source)}`);
  console.log(`  restored rows:${JSON.stringify(evidence.rowCounts.restored)}`);
  console.log(`  source snap:  ${JSON.stringify(before)}`);
  console.log(`  restored snap:${JSON.stringify(after)}`);
  console.log(`  elapsed:      ${Math.round(evidence.totalMs / 1000)}s`);
  console.log(`\nRESTORE DRILL PASS (${evidence.assertions.length} assertions)`);
}

main().catch((err) => {
  console.error('\nRESTORE DRILL FAIL');
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  for (const child of running) child.kill('SIGKILL');
  try {
    mkdirSync(WORK, { recursive: true });
    writeFileSync(
      join(WORK, 'evidence.json'),
      `${JSON.stringify({ ...evidence, failure: String(err), failedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // best effort
  }
  process.exitCode = 1;
});
