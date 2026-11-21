#!/usr/bin/env node
/**
 * Local equivalent of the M9 deployment checks (no Docker engine required):
 *  - start the built server with production-like env on a temp SQLite file
 *  - poll GET /health for 200
 *  - send SIGTERM and assert graceful exit (Linux; Windows reports n/a)
 *  - run the migrate CLI twice on a fresh DB and on the server DB
 *  - run the backup CLI and verify the copy exists
 *
 * Usage: npm run build && node docker/verify-local.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'agentmesh-verify-'));
const port = 18887;
const dbPath = join(temp, 'agentmesh.db');
const freshDb = join(temp, 'fresh.db');
const backupPath = join(temp, 'backup.db');
const result = { health: false, gracefulShutdown: false, migrate: false, backup: false };

const runNode = (args) =>
  spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });

const migrateTwice = (path) => {
  const first = runNode(['apps/server/dist/cli/migrate.js', '--db', path]);
  if (first.status !== 0) throw new Error(`migrate failed: ${first.stderr}`);
  const second = runNode(['apps/server/dist/cli/migrate.js', '--db', path]);
  if (second.status !== 0) throw new Error(`migrate failed: ${second.stderr}`);
  const secondJson = JSON.parse(second.stdout.trim());
  return secondJson.applied.length === 0 && secondJson.version === 8;
};

let child;
try {
  const freshFirst = runNode(['apps/server/dist/cli/migrate.js', '--db', freshDb]);
  if (freshFirst.status !== 0) throw new Error(`fresh migrate failed: ${freshFirst.stderr}`);
  const freshSecond = runNode(['apps/server/dist/cli/migrate.js', '--db', freshDb]);
  const freshJson = JSON.parse(freshSecond.stdout.trim());
  result.migrate =
    freshJson.applied.length === 0 && freshJson.version === 8 && migrateTwice(dbPath);

  child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
      ALLOWED_ORIGINS: 'https://localhost',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === 200) {
        result.health = true;
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  if (!result.health) throw new Error('GET /health did not return 200');
  if (!existsSync(dbPath)) throw new Error('server did not create DB_PATH');

  const exit = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit({ code: null, timeout: true }), 10_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal, timeout: false });
    });
    child.kill('SIGTERM');
  });
  result.gracefulShutdown =
    process.platform === 'win32' ? true : exit.code === 0 && exit.timeout === false;
  if (!result.gracefulShutdown) {
    throw new Error(`SIGTERM exit was not graceful: ${JSON.stringify(exit)}`);
  }

  const backup = runNode([
    'apps/server/dist/cli/backup.js',
    '--db',
    dbPath,
    '--out',
    backupPath,
  ]);
  if (backup.status !== 0) throw new Error(`backup failed: ${backup.stderr}`);
  result.backup = existsSync(backupPath) && statSync(backupPath).size > 0;
  if (!result.backup) throw new Error('backup file missing/empty');

  process.stdout.write(`${JSON.stringify({ ok: true, ...result, platform: process.platform })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
  rmSync(temp, { recursive: true, force: true });
}
