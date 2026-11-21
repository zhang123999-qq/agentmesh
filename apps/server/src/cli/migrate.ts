/**
 * Standalone migration entrypoint (`npm run migrate -w @agentmesh/server`).
 *
 * The server still migrates automatically on startup (`openStore`); this
 * command exists so deployments can run migrations as a separate, observable
 * step. `runMigrations` is idempotent, so running both is safe.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CURRENT_SCHEMA_VERSION,
  getSchemaVersion,
  openDatabase,
  runMigrations,
} from '@agentmesh/store';

export interface MigrateCliOptions {
  readonly dbPath: string;
}

export function parseMigrateArgs(argv: readonly string[]): MigrateCliOptions {
  let dbPath: string | undefined;
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
    throw new Error(`unknown argument: ${token}`);
  }
  return { dbPath: dbPath ?? process.env.DB_PATH ?? 'data/agentmesh.db' };
}

/** Run migrations and return a process exit code. Exported for tests. */
export function runMigrate(
  argv: readonly string[],
  deps: { stdout?: (line: string) => void; stderr?: (line: string) => void } = {},
): number {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const { dbPath } = parseMigrateArgs(argv);
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    const db = openDatabase(dbPath);
    try {
      const result = runMigrations(db);
      const version = getSchemaVersion(db);
      out(
        JSON.stringify({
          dbPath,
          applied: result.applied,
          version,
          targetVersion: CURRENT_SCHEMA_VERSION,
        }),
      );
      return 0;
    } finally {
      db.close();
    }
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
  process.exitCode = runMigrate(process.argv.slice(2));
}
