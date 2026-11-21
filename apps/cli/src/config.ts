/**
 * CLI configuration.
 *
 * Precedence (highest first): command-line flags → environment → profile file
 * → default file. See `docs/decisions.md` (US-016 decision 3).
 *
 * Only `url`, `agentId` and `token` are persisted. The account **secret** is
 * never written to disk or read from the environment: `login` exchanges it for
 * a token and drops it immediately.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ConfigValues {
  readonly url?: string;
  readonly agentId?: string;
  readonly token?: string;
}

export interface ConfigFlags {
  readonly url?: string;
  readonly token?: string;
  readonly agentId?: string;
  readonly profile?: string;
  readonly config?: string;
}

export interface ResolvedConfig {
  readonly url?: string;
  readonly agentId?: string;
  readonly token?: string;
  readonly profile?: string;
  /** File writes go here (profile file when selected, else the default). */
  readonly path: string;
}

/** Invalid/unreadable configuration (exit code 2, not an RPC error). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ResolveConfigOptions {
  readonly flags?: ConfigFlags;
  readonly env?: NodeJS.ProcessEnv;
  /** Test hook; overrides both `AGENTMESH_HOME` and `~`. */
  readonly homeDir?: string;
}

function readConfigFile(path: string): ConfigValues | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config ${path}: ${String(err)}`);
  }
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(`config ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`config ${path} must contain a JSON object`);
  }
  const value = parsed as Record<string, unknown>;
  const config: { url?: string; agentId?: string; token?: string } = {};
  for (const key of ['url', 'agentId', 'token'] as const) {
    const item = value[key];
    if (typeof item === 'string' && item.length > 0) config[key] = item;
  }
  return config;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function defaultHome(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return homeDir ?? nonEmpty(env.AGENTMESH_HOME) ?? join(homedir(), '.agentmesh');
}

export function resolveConfig(options: ResolveConfigOptions = {}): ResolvedConfig {
  const env = options.env ?? process.env;
  const flags = options.flags ?? {};
  const home = defaultHome(env, options.homeDir);

  const defaultPath = join(home, 'config.json');
  const basePath = nonEmpty(flags.config) ?? defaultPath;
  const base = readConfigFile(basePath);

  const profile = nonEmpty(flags.profile) ?? nonEmpty(env.AGENTMESH_PROFILE);
  const profilePath =
    profile === undefined ? undefined : join(home, 'profiles', `${profile}.json`);
  const profileValues = profilePath === undefined ? undefined : readConfigFile(profilePath);

  const url =
    nonEmpty(flags.url) ?? nonEmpty(env.AGENTMESH_URL) ?? profileValues?.url ?? base?.url;
  const token = nonEmpty(flags.token) ?? profileValues?.token ?? base?.token;
  const agentId =
    nonEmpty(flags.agentId) ?? profileValues?.agentId ?? base?.agentId;

  return {
    ...(url === undefined ? {} : { url }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(token === undefined ? {} : { token }),
    ...(profile === undefined ? {} : { profile }),
    path: profilePath ?? basePath,
  };
}

/** `undefined` values keep the current value; `null` removes the key. */
export type ConfigPatch = Partial<Record<'url' | 'agentId' | 'token', string | null>>;

export function saveConfig(path: string, patch: ConfigPatch): ConfigValues {
  const existing = readConfigFile(path) ?? {};
  const next: { url?: string; agentId?: string; token?: string } = { ...existing };
  for (const key of ['url', 'agentId', 'token'] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing file too.
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows / restricted filesystems: best effort only.
  }
  return next;
}

/** Effective server URL or a clear configuration error. */
export function requireUrl(config: ResolvedConfig): string {
  if (config.url === undefined) {
    throw new ConfigError(
      'no server URL configured; pass --url or set AGENTMESH_URL',
    );
  }
  return config.url;
}
