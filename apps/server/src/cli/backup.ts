/**
 * Consistent SQLite backup via better-sqlite3's online backup API.
 *
 * This includes committed WAL contents and works while the server is running.
 * Restore procedure: stop the server, replace the database file, start again.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openDatabase } from '@agentmesh/store';

export interface BackupCliOptions {
  readonly dbPath: string;
  readonly outPath: string;
}

export function parseBackupArgs(argv: readonly string[]): BackupCliOptions {
  let dbPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith('--db=')) {
      dbPath = token.slice('--db='.length);
      continue;
    }
    if (token === '--db') {
      dbPath = argv[i + 1];
      if (dbPath === undefined) throw new Error('--db requires a path');
      i += 1;
      continue;
    }
    if (token.startsWith('--out=')) {
      outPath = token.slice('--out='.length);
      continue;
    }
    if (token === '--out') {
      outPath = argv[i + 1];
      if (outPath === undefined) throw new Error('--out requires a path');
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  if (outPath === undefined || outPath.length === 0) {
    throw new Error('--out is required');
  }
  return {
    dbPath: dbPath ?? process.env.DB_PATH ?? 'data/agentmesh.db',
    outPath,
  };
}

/** Copy the database and return a process exit code. Exported for tests. */
export async function runBackup(
  argv: readonly string[],
  deps: { stdout?: (line: string) => void; stderr?: (line: string) => void } = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const { dbPath, outPath } = parseBackupArgs(argv);
    if (resolve(dbPath) === resolve(outPath)) {
      throw new Error('backup destination must differ from the source database');
    }
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    const db = openDatabase(dbPath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(outPath);
    } finally {
      db.close();
    }
    // Verify the produced snapshot is a healthy SQLite database; a backup that
    // cannot be restored is worse than none.
    const verify = openDatabase(outPath, { readonly: true, fileMustExist: true });
    try {
      const rows = verify.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (!rows.every((row) => row.integrity_check === 'ok')) {
        throw new Error('backup integrity_check did not report ok');
      }
    } finally {
      verify.close();
    }
    out(JSON.stringify({ dbPath, outPath, ok: true, integrity: 'ok' }));
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  void runBackup(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
