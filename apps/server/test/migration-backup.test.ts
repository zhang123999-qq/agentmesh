import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CURRENT_SCHEMA_VERSION, openDatabase, openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareMigrationBackup } from '../src/cli/migration-backup.js';
import { runMigrate } from '../src/cli/migrate.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'am-mig-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort on Windows file locks */
    }
  }
});

/** Create a file-backed DB at the current schema version, then wipe the ledger
 * so the next migration run sees "pending" (simulates an older database). */
function makeCurrentDb(path: string): void {
  const store = openStore(path);
  store.db.close();
}

function makePendingDb(path: string): void {
  makeCurrentDb(path);
  const db = openDatabase(path);
  try {
    db.exec('DELETE FROM schema_version');
  } finally {
    db.close();
  }
}

describe('prepareMigrationBackup', () => {
  it('skips :memory: and a missing file (empty)', () => {
    expect(prepareMigrationBackup(':memory:').reason).toBe('memory');
    const missing = join(tmpDir(), 'nope.db');
    expect(prepareMigrationBackup(missing).reason).toBe('empty');
    expect(existsSync(missing)).toBe(false);
  });

  it('skips an up-to-date database (no pending)', () => {
    const path = join(tmpDir(), 'current.db');
    makeCurrentDb(path);
    const result = prepareMigrationBackup(path);
    expect(result.reason).toBe('no-pending');
    expect(result.backupPath).toBeUndefined();
  });

  it('snapshots a non-empty database with pending migrations, integrity ok', () => {
    const path = join(tmpDir(), 'pending.db');
    makePendingDb(path);
    const result = prepareMigrationBackup(path);
    expect(result.reason).toBe('backed-up');
    expect(result.backupPath).toBeDefined();
    expect(existsSync(result.backupPath!)).toBe(true);
    const snap = openDatabase(result.backupPath!, { readonly: true, fileMustExist: true });
    try {
      const rows = snap.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(rows.every((r) => r.integrity_check === 'ok')).toBe(true);
    } finally {
      snap.close();
    }
  });

  it('throws when the backup cannot be written', () => {
    const path = join(tmpDir(), 'fail.db');
    makePendingDb(path);
    const now = 1_700_000_000_000;
    const ts = new Date(now).toISOString().replace(/[:.]/g, '-');
    const expected = `${resolve(path)}.pre-v${CURRENT_SCHEMA_VERSION}.${ts}.bak`;
    // Occupy the deterministic snapshot path with a directory so the copy fails.
    mkdirSync(expected);
    expect(() => prepareMigrationBackup(path, { now: () => now })).toThrowError(
      /pre-migration backup failed/,
    );
    // The placeholder directory is untouched (no real file was produced).
    expect(statSync(expected).isDirectory()).toBe(true);
  });
});

describe('migrate CLI pre-migration backup', () => {
  it('backs up a pending non-empty database before migrating, then migrates', () => {
    const path = join(tmpDir(), 'cli.db');
    makePendingDb(path);
    const code = runMigrate(['--db', path], { stdout: () => undefined, stderr: () => undefined });
    expect(code).toBe(0);
    const backups = readdirSync(resolve(path, '..')).filter((f) => f.endsWith('.bak'));
    expect(backups.length).toBe(1);
  });
});
