/**
 * Pre-migration backup (US: backup institutionalization).
 *
 * `runMigrations` is forward-only (no down migrations), so a migration must never
 * run on a non-empty database without a recoverable snapshot first. This helper
 * is called by BOTH migration entrypoints:
 *  - the `migrate` CLI (manual), and
 *  - `startServer` before it opens a file-backed store (automatic startup
 *    migration — the path that is easiest to forget).
 *
 * Rules:
 *  - `:memory:` or a missing/zero-byte file → skip (`memory` / `empty`).
 *  - already at the current schema version → skip (`no-pending`).
 *  - a non-empty database with pending migrations → checkpoint WAL, copy to
 *    `<db>.pre-v<target>.<ts>.bak`, verify `PRAGMA integrity_check`, and on any
 *    failure throw so the caller ABORTS the migration.
 *
 * The copy is synchronous (no concurrent writer at startup / CLI time); WAL is
 * checkpointed into the main file first so the snapshot is complete.
 */
import { copyFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

import { CURRENT_SCHEMA_VERSION, openDatabase } from '@agentmesh/store';

export type MigrationBackupReason = 'memory' | 'empty' | 'no-pending' | 'backed-up';

export interface MigrationBackupResult {
  readonly reason: MigrationBackupReason;
  /** Absolute path of the snapshot when `reason === 'backed-up'`. */
  readonly backupPath?: string;
}

export interface MigrationBackupOptions {
  /** Injectable clock for deterministic backup filenames in tests. */
  readonly now?: () => number;
}

function readSchemaVersion(db: ReturnType<typeof openDatabase>): number {
  const hasLedger = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  if (hasLedger === undefined) return 0;
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version')
    .get() as { version: number };
  return row.version;
}

export function prepareMigrationBackup(
  dbPath: string,
  options: MigrationBackupOptions = {},
): MigrationBackupResult {
  if (dbPath === ':memory:') return { reason: 'memory' };
  const abs = resolve(dbPath);
  if (!existsSync(abs) || statSync(abs).size === 0) return { reason: 'empty' };

  const probe = openDatabase(abs, { readonly: true, fileMustExist: true });
  let current: number;
  try {
    current = readSchemaVersion(probe);
  } finally {
    probe.close();
  }
  if (current >= CURRENT_SCHEMA_VERSION) return { reason: 'no-pending' };

  // Pending migration on a non-empty database: fold WAL into the main file so the
  // snapshot is complete, then copy and verify.
  const checkpoint = openDatabase(abs, { fileMustExist: true });
  try {
    checkpoint.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    checkpoint.close();
  }

  const ts = new Date((options.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const backupPath = `${abs}.pre-v${CURRENT_SCHEMA_VERSION}.${ts}.bak`;
  try {
    copyFileSync(abs, backupPath);
    const verify = openDatabase(backupPath, { readonly: true, fileMustExist: true });
    try {
      const rows = verify.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (!rows.every((row) => row.integrity_check === 'ok')) {
        throw new Error('integrity_check did not report ok');
      }
    } finally {
      verify.close();
    }
  } catch (error) {
    // Never leave a partial/corrupt snapshot behind.
    try {
      if (existsSync(backupPath)) unlinkSync(backupPath);
    } catch {
      /* best effort */
    }
    throw new Error(
      `pre-migration backup failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return { reason: 'backed-up', backupPath };
}
