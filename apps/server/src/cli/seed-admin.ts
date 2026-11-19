/**
 * `seed:admin` — local bootstrap for the first admin account.
 *
 * The RPC surface deliberately cannot create an `admin` unless
 * `ALLOW_ADMIN_SELF_REGISTER=true`, which opens admin minting to every
 * anonymous client for as long as the flag is on. This CLI is the supported
 * alternative: it runs on the host against the SQLite file, is never reachable
 * over HTTP/WS, and is idempotent by account name.
 *
 * Usage (after `npm run build`):
 *
 * ```bash
 * DB_PATH=data/agentmesh.db \
 *   npm run seed:admin -w @agentmesh/server -- --name admin --owner ops
 * ```
 *
 * The generated secret is printed **once**. Store it, then trade it for a JWT
 * via `agent.authenticate { name, secret }`.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EventStore } from '@agentmesh/core';
import { openStore } from '@agentmesh/store';

import { createTokenService } from '../auth/token.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { AccountsService } from '../modules/accounts.js';

export interface SeedAdminCliOptions {
  readonly name?: string;
  readonly owner?: string;
  readonly dbPath?: string;
  readonly help?: boolean;
}

export class SeedAdminUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedAdminUsageError';
  }
}

function readFlagValue(
  argv: readonly string[],
  index: number,
  token: string,
): { value: string; nextIndex: number } {
  const equals = token.indexOf('=');
  if (equals !== -1) {
    const value = token.slice(equals + 1);
    if (value.length === 0) {
      throw new SeedAdminUsageError(`${token.slice(0, equals)} requires a value`);
    }
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new SeedAdminUsageError(`${token} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

/** Parse `--name`, `--owner`, `--db` (and `--flag=value` forms). */
export function parseSeedAdminArgs(argv: readonly string[]): SeedAdminCliOptions {
  let name: string | undefined;
  let owner: string | undefined;
  let dbPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--help' || token === '-h') return { help: true };
    if (token === '--name' || token.startsWith('--name=')) {
      const parsed = readFlagValue(argv, i, token);
      name = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (token === '--owner' || token.startsWith('--owner=')) {
      const parsed = readFlagValue(argv, i, token);
      owner = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (token === '--db' || token.startsWith('--db=')) {
      const parsed = readFlagValue(argv, i, token);
      dbPath = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    throw new SeedAdminUsageError(`unknown argument: ${token}`);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(owner === undefined ? {} : { owner }),
    ...(dbPath === undefined ? {} : { dbPath }),
  };
}

export const SEED_ADMIN_USAGE = `Usage: seed-admin --name <admin-name> [--owner <owner>] [--db <sqlite-path>]

Creates the first admin account locally (idempotent by name). The printed
secret is shown once and is stored only as a SHA-256 digest.`;

export interface SeedAdminDeps {
  /** Validated config; defaults to `loadConfig()` (reads `DB_PATH` etc.). */
  readonly config?: ServerConfig;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

/** Run the CLI and return a process exit code. Exported for tests. */
export function runSeedAdmin(argv: readonly string[], deps: SeedAdminDeps = {}): number {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let options: SeedAdminCliOptions;
  try {
    options = parseSeedAdminArgs(argv);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(SEED_ADMIN_USAGE);
    return 2;
  }

  if (options.help === true) {
    out(SEED_ADMIN_USAGE);
    return 0;
  }
  if (options.name === undefined || options.name.trim().length === 0) {
    err('--name is required');
    err(SEED_ADMIN_USAGE);
    return 2;
  }

  try {
    const config = deps.config ?? loadConfig();
    const dbPath = options.dbPath ?? config.dbPath;
    const { db, repos } = openStore(dbPath);
    try {
      const events = new EventStore(db, { workspaceId: 'default' }, repos.events);
      const tokens = createTokenService({
        secret: config.jwtSecret,
        expiresInSeconds: config.jwtExpiresInSeconds,
        issuer: config.jwtIssuer,
      });
      const accounts = new AccountsService({
        db,
        accounts: repos.accounts,
        events,
        tokens,
        workspaceId: 'default',
      });
      const result = accounts.seedAdmin({
        name: options.name,
        ...(options.owner === undefined ? {} : { owner: options.owner }),
      });

      if (!result.created) {
        out(
          `admin already exists: agentId=${result.agentId} name=${result.name} (no changes)`,
        );
        return 0;
      }
      out(`admin created: agentId=${result.agentId} name=${result.name}`);
      out(`secret: ${result.secret ?? ''}`);
      out(
        'Save this secret now; it is stored only as a digest and cannot be shown again.',
      );
      out('Obtain a token with agent.authenticate { name, secret }.');
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
  process.exitCode = runSeedAdmin(process.argv.slice(2));
}
