/**
 * Server configuration loaded from the environment.
 *
 * Everything the bootstrap needs (listen port, SQLite path, JWT secret, log
 * level) comes from env vars so the same image runs in dev / CI / production.
 * `loadConfig` is pure: callers pass `process.env` (tests pass a fixture) and
 * receive a frozen, fully validated {@link ServerConfig}.
 */

import {
  DEFAULT_AUTH_FAIL_WINDOW_SECONDS,
  DEFAULT_AUTH_LOCKOUT_SECONDS,
  DEFAULT_AUTH_MAX_FAILED_ATTEMPTS,
} from './auth/rate-limit.js';

export const SERVER_NAME = 'agentmesh-server';
export const SERVER_VERSION = '0.1.0';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_DB_PATH = 'data/agentmesh.db';
export const MIN_JWT_SECRET_LENGTH = 16;
/** Production HMAC key floor: 32 bytes (64 hex / 43 Base64URL). */
export const PRODUCTION_MIN_JWT_SECRET_BYTES = 32;
/** Development-only fallback; never accepted when NODE_ENV=production. */
export const DEV_JWT_SECRET = 'dev-insecure-jwt-secret-change-me';

/**
 * Known-bad HMAC keys. An HS256 secret is the whole signing authority: if it
 * is guessable, anyone can mint an admin token. These are rejected everywhere,
 * not just in production.
 */
export const WEAK_JWT_SECRET_VALUES: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'changeme',
  'change-me',
  'change_me',
  'password',
  'passw0rd',
  'test',
  'testing',
  'dev',
  'development',
  'jwtsecret',
  'jwt-secret',
  'agentmesh',
  'admin',
]);

/** Default access-token lifetime (1 hour). */
export const DEFAULT_JWT_EXPIRES_IN_SECONDS = 3600;
/** Upper bound so a typo cannot mint effectively eternal tokens. */
export const MAX_JWT_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30; // 30 days
/** Default `iss` claim; clients may check it but the server always validates it. */
export const DEFAULT_JWT_ISSUER = 'agentmesh';

/** Self-service `role: "admin"` registration is off unless explicitly enabled. */
export const DEFAULT_ALLOW_ADMIN_SELF_REGISTER = false;
/** Demo mode forces the deterministic exploration branch (US-009/US-017). */
export const DEFAULT_DEMO_MODE = false;

/**
 * `agent.authenticate` brute-force guard (US-005): an identity that fails
 * `AUTH_MAX_FAILED_ATTEMPTS` times inside `AUTH_FAIL_WINDOW_SECONDS` is locked
 * out for `AUTH_LOCKOUT_SECONDS` (doubling on each repeat). The defaults live
 * in `auth/rate-limit.ts` (imported below) so there is one source of truth.
 */
/** Sanity bounds so a typo cannot disable (or permanently arm) the limiter. */
export const MAX_AUTH_MAX_FAILED_ATTEMPTS = 100;
export const MAX_AUTH_WINDOW_SECONDS = 86_400; // 1 day

/**
 * WebSocket gateway knobs (US-006).
 *
 * `RESUME_MAX_EVENTS` is a **hard** replay window: a resume asking for more
 * events than this is answered with `gap_too_large` so the client falls back
 * to a full state fetch instead of receiving an unbounded burst.
 *
 * The two rate limits are *soft* rejections (`-32005`); exceeding them never
 * closes the socket, it only throttles the offending connection/agent.
 */
export const DEFAULT_WS_PATH = '/ws';
export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 30_000;
/** Largest accepted HTTP body / WebSocket frame (1 MiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
/** Non-browser clients (SDK/CLI) do not send Origin; allow by default. */
export const DEFAULT_ALLOW_MISSING_ORIGIN = true;
export const DEFAULT_RESUME_MAX_EVENTS = 1000;
export const DEFAULT_WS_CONNECTION_RATE_LIMIT = 100; // req/s per connection
export const DEFAULT_WS_CONNECTION_BURST = 100;
export const DEFAULT_WS_AGENT_RATE_LIMIT = 10; // msg/s per agent
export const DEFAULT_WS_AGENT_BURST = 10;

/**
 * Task lifecycle knobs (US-008).
 *
 * `TASK_OPEN_TTL_SECONDS` is the safety net for tasks published without a
 * `deadline`: an `open` task older than this is reclaimed (cancelled) by the
 * sweeper. `0` disables the TTL sweep, leaving only explicit `deadline`s.
 * `TASK_RECLAIM_INTERVAL_SECONDS` is how often the server sweeps.
 */
export const DEFAULT_TASK_OPEN_TTL_SECONDS = 0;
export const MAX_TASK_OPEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
export const DEFAULT_TASK_RECLAIM_INTERVAL_SECONDS = 60;
/** Compaction interval (seconds); 0 = disabled. */
export const DEFAULT_TASK_BID_COMPACTION_INTERVAL_SECONDS = 0;
/** Run a hash-chain verification once at startup (US-021C). */
export const DEFAULT_HASH_CHAIN_VERIFY_ON_STARTUP = true;
/** Expose the Prometheus `/metrics` endpoint. Default: on (restrict via network). */
export const DEFAULT_METRICS_ENABLED = true;
/** Revoked-token cleanup interval (seconds); 0 disables the timer. */
export const DEFAULT_REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS = 3600;
/** Periodic hash-chain verification interval (seconds); 0 disables the timer. */
export const DEFAULT_HASH_CHAIN_VERIFY_INTERVAL_SECONDS = 3600;

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ServerConfig {
  /** TCP port to listen on (0 = pick an ephemeral port). */
  readonly port: number;
  /** Interface to bind, e.g. `0.0.0.0` in containers. */
  readonly host: string;
  /** SQLite database path (`:memory:` allowed for tests). */
  readonly dbPath: string;
  /** HMAC secret used to sign auth tokens (US-005 consumes it). */
  readonly jwtSecret: string;
  /** Access-token lifetime in seconds. */
  readonly jwtExpiresInSeconds: number;
  /** `iss` claim written into and validated on every token. */
  readonly jwtIssuer: string;
  /** Allow `agent.register` to mint an `admin` role (default false). */
  readonly allowAdminSelfRegister: boolean;
  /** Force `AlwaysExploreForDemo` for deterministic demo runs. */
  readonly demoMode: boolean;
  /** Failed `agent.authenticate` attempts tolerated per identity per window. */
  readonly authMaxFailedAttempts: number;
  /** Window (seconds) in which failures are counted. */
  readonly authFailWindowSeconds: number;
  /** Base lockout (seconds) after too many failures; doubles per repeat. */
  readonly authLockoutSeconds: number;
  /** Upgrade path served by the WebSocket gateway. */
  readonly wsPath: string;
  /**
   * Exact browser origins allowed to open a WebSocket (CSWSH defence).
   * Empty means: development allows localhost/127.0.0.1; production allows no
   * browser origin (non-browser clients still pass when missing Origin is
   * allowed).
   */
  readonly allowedOrigins: readonly string[];
  /**
   * Allow upgrades with no Origin header (SDK/CLI; not browsers). Default
   * **true in every environment**: Origin is a browser-added header, so a
   * missing one is normal for non-browser clients and Origin checks provide no
   * CSWSH protection for them. Set false only if every client is a browser.
   */
  readonly allowMissingOrigin: boolean;
  /** Server-initiated WS ping interval; unresponsive sockets are terminated. */
  readonly wsHeartbeatIntervalMs: number;
  /** Hard cap on events replayed by a single `resume` (gap_too_large above). */
  readonly resumeMaxEvents: number;
  /** Connection-level JSON-RPC rate limit (requests/second). */
  readonly wsConnectionRateLimit: number;
  /** Connection-level token bucket capacity. */
  readonly wsConnectionBurst: number;
  /** Per-agent message-send rate limit (messages/second, shared by all sockets). */
  readonly wsAgentRateLimit: number;
  /** Per-agent token bucket capacity. */
  readonly wsAgentBurst: number;
  /**
   * Reclaim `open` tasks older than this many seconds even when they have no
   * `deadline` (`0` disables the TTL sweep; deadlines are always honoured).
   */
  readonly taskOpenTtlSeconds: number;
  /** Sweep interval (seconds) of the `open`-task reclaim timer. */
  readonly taskReclaimIntervalSeconds: number;
  /** Compaction interval (seconds) of the bid set compaction timer; 0 = disabled. */
  readonly taskBidCompactionIntervalSeconds: number;
  /** Run a hash-chain verification once on startup (US-021C). */
  readonly hashChainVerifyOnStartup: boolean;
  /** Periodic hash-chain verification interval (seconds); 0 = disabled. */
  readonly hashChainVerifyIntervalSeconds: number;
  /** Expose the Prometheus `/metrics` endpoint (default true). */
  readonly metricsEnabled: boolean;
  /** Revoked-token cleanup interval (seconds); 0 disables the timer. */
  readonly revokedTokensCleanupIntervalSeconds: number;
  /** `development` | `test` | `production` | anything the deployer sets. */
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly logLevel: LogLevel;
  /** Build version reported by `GET /health`. */
  readonly version: string;
}

/** Thrown by {@link loadConfig} when an env var is invalid. */
export class ConfigError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = 'ConfigError';
    this.field = field;
  }
}

function readString(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (!value && !allowEmpty) {
    throw new ConfigError(`${key} must not be empty`, key);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`PORT must be an integer, got "${value}"`, 'PORT');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be between 0 and 65535, got ${port}`, 'PORT');
  }
  return port;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined || raw.trim() === '') return 'info';
  const value = raw.trim() as LogLevel;
  if (!(LOG_LEVELS as readonly string[]).includes(value)) {
    throw new ConfigError(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`,
      'LOG_LEVEL',
    );
  }
  return value;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBoolean(
  raw: string | undefined,
  key: string,
  fallback: boolean,
): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new ConfigError(`${key} must be a boolean (true/false), got "${raw.trim()}"`, key);
}

function parseJwtExpiresIn(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_JWT_EXPIRES_IN_SECONDS;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(
      `JWT_EXPIRES_IN_SECONDS must be an integer number of seconds, got "${value}"`,
      'JWT_EXPIRES_IN_SECONDS',
    );
  }
  const seconds = Number(value);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    seconds > MAX_JWT_EXPIRES_IN_SECONDS
  ) {
    throw new ConfigError(
      `JWT_EXPIRES_IN_SECONDS must be between 1 and ${MAX_JWT_EXPIRES_IN_SECONDS}, got ${seconds}`,
      'JWT_EXPIRES_IN_SECONDS',
    );
  }
  return seconds;
}

/**
 * Positive-integer env var with an inclusive upper bound (limiter knobs).
 * Unset/blank falls back; non-numeric or out-of-range values fail fast.
 */
function parsePositiveInt(
  raw: string | undefined,
  key: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${key} must be a positive integer, got "${value}"`, key);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ConfigError(`${key} must be between 1 and ${max}, got ${parsed}`, key);
  }
  return parsed;
}

/**
 * Non-negative integer env var (0 = "disabled") with an inclusive upper bound.
 * Unset/blank falls back; non-numeric or out-of-range values fail fast.
 */
function parseNonNegativeInt(
  raw: string | undefined,
  key: string,
  fallback: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${key} must be a non-negative integer, got "${value}"`, key);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new ConfigError(`${key} must be between 0 and ${max}, got ${parsed}`, key);
  }
  return parsed;
}

/**
 * Upgrade path: must start with `/` so a typo cannot silently expose the
 * gateway at an unrelated HTTP namespace.
 */function parseWsPath(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_WS_PATH;
  const value = raw.trim();
  if (!value.startsWith('/') || /\s/.test(value)) {
    throw new ConfigError(`WS_PATH must start with "/" and contain no spaces, got "${value}"`, 'WS_PATH');
  }
  return value;
}

/**
 * Comma-separated exact origins. Wildcards are deliberately rejected: the
 * whole point of the allow-list is to name the front-end that may open a
 * socket. Entries are normalised to `scheme://host[:port]`.
 */
function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const origins: string[] = [];
  for (const entry of entries) {
    if (entry === '*') {
      throw new ConfigError('ALLOWED_ORIGINS must not use "*"', 'ALLOWED_ORIGINS');
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new ConfigError(
        `ALLOWED_ORIGINS entry must be an absolute origin, got "${entry}"`,
        'ALLOWED_ORIGINS',
      );
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(
        `ALLOWED_ORIGINS entry must be http(s), got "${entry}"`,
        'ALLOWED_ORIGINS',
      );
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
      throw new ConfigError(
        `ALLOWED_ORIGINS entry must be an origin without a path, got "${entry}"`,
        'ALLOWED_ORIGINS',
      );
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

function isWeakJwtSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (WEAK_JWT_SECRET_VALUES.has(normalized)) return true;
  // Single repeated character ("aaaa…") has effectively no entropy.
  return /^(.)\1+$/.test(value);
}

function resolveJwtSecret(
  env: NodeJS.ProcessEnv,
  nodeEnv: string,
): string {
  const isProduction = nodeEnv === 'production';
  const raw = env.JWT_SECRET?.trim();
  if (!raw) {
    if (isProduction) {
      throw new ConfigError(
        'JWT_SECRET is required when NODE_ENV=production',
        'JWT_SECRET',
      );
    }
    return DEV_JWT_SECRET;
  }
  const minimum = isProduction
    ? PRODUCTION_MIN_JWT_SECRET_BYTES
    : MIN_JWT_SECRET_LENGTH;
  if (isWeakJwtSecret(raw)) {
    throw new ConfigError(
      'JWT_SECRET is a known weak value or has no entropy',
      'JWT_SECRET',
    );
  }
  if (Buffer.byteLength(raw, 'utf8') < minimum) {
    throw new ConfigError(
      isProduction
        ? `JWT_SECRET must be at least ${PRODUCTION_MIN_JWT_SECRET_BYTES} bytes when NODE_ENV=production`
        : `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters`,
      'JWT_SECRET',
    );
  }
  return raw;
}

/**
 * Read + validate server config from `env` (defaults to `process.env`).
 * Throws {@link ConfigError} on the first invalid field.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = readString(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  if (isProduction && allowedOrigins.length === 0) {
    throw new ConfigError(
      'ALLOWED_ORIGINS must be set when NODE_ENV=production; without it the web admin cannot open a WebSocket',
      'ALLOWED_ORIGINS',
    );
  }

  const config: ServerConfig = {
    port: parsePort(env.PORT),
    host: readString(env, 'HOST', DEFAULT_HOST),
    dbPath: readString(env, 'DB_PATH', DEFAULT_DB_PATH),
    jwtSecret: resolveJwtSecret(env, nodeEnv),
    jwtExpiresInSeconds: parseJwtExpiresIn(env.JWT_EXPIRES_IN_SECONDS),
    jwtIssuer: readString(env, 'JWT_ISSUER', DEFAULT_JWT_ISSUER),
    allowAdminSelfRegister: parseBoolean(
      env.ALLOW_ADMIN_SELF_REGISTER,
      'ALLOW_ADMIN_SELF_REGISTER',
      DEFAULT_ALLOW_ADMIN_SELF_REGISTER,
    ),
    demoMode: parseBoolean(env.DEMO_MODE, 'DEMO_MODE', DEFAULT_DEMO_MODE),
    authMaxFailedAttempts: parsePositiveInt(
      env.AUTH_MAX_FAILED_ATTEMPTS,
      'AUTH_MAX_FAILED_ATTEMPTS',
      DEFAULT_AUTH_MAX_FAILED_ATTEMPTS,
      MAX_AUTH_MAX_FAILED_ATTEMPTS,
    ),
    authFailWindowSeconds: parsePositiveInt(
      env.AUTH_FAIL_WINDOW_SECONDS,
      'AUTH_FAIL_WINDOW_SECONDS',
      DEFAULT_AUTH_FAIL_WINDOW_SECONDS,
      MAX_AUTH_WINDOW_SECONDS,
    ),
    authLockoutSeconds: parsePositiveInt(
      env.AUTH_LOCKOUT_SECONDS,
      'AUTH_LOCKOUT_SECONDS',
      DEFAULT_AUTH_LOCKOUT_SECONDS,
      MAX_AUTH_WINDOW_SECONDS,
    ),
    wsPath: parseWsPath(env.WS_PATH),
    allowedOrigins,
    allowMissingOrigin: parseBoolean(
      env.ALLOW_MISSING_ORIGIN,
      'ALLOW_MISSING_ORIGIN',
      DEFAULT_ALLOW_MISSING_ORIGIN,
    ),
    wsHeartbeatIntervalMs: parsePositiveInt(
      env.WS_HEARTBEAT_INTERVAL_MS,
      'WS_HEARTBEAT_INTERVAL_MS',
      DEFAULT_WS_HEARTBEAT_INTERVAL_MS,
      86_400_000,
    ),
    resumeMaxEvents: parsePositiveInt(
      env.RESUME_MAX_EVENTS,
      'RESUME_MAX_EVENTS',
      DEFAULT_RESUME_MAX_EVENTS,
      1_000_000,
    ),
    wsConnectionRateLimit: parsePositiveInt(
      env.WS_CONNECTION_RATE_LIMIT,
      'WS_CONNECTION_RATE_LIMIT',
      DEFAULT_WS_CONNECTION_RATE_LIMIT,
      1_000_000,
    ),
    wsConnectionBurst: parsePositiveInt(
      env.WS_CONNECTION_BURST,
      'WS_CONNECTION_BURST',
      DEFAULT_WS_CONNECTION_BURST,
      1_000_000,
    ),
    wsAgentRateLimit: parsePositiveInt(
      env.WS_AGENT_RATE_LIMIT,
      'WS_AGENT_RATE_LIMIT',
      DEFAULT_WS_AGENT_RATE_LIMIT,
      1_000_000,
    ),
    wsAgentBurst: parsePositiveInt(
      env.WS_AGENT_BURST,
      'WS_AGENT_BURST',
      DEFAULT_WS_AGENT_BURST,
      1_000_000,
    ),
    taskOpenTtlSeconds: parseNonNegativeInt(
      env.TASK_OPEN_TTL_SECONDS,
      'TASK_OPEN_TTL_SECONDS',
      DEFAULT_TASK_OPEN_TTL_SECONDS,
      MAX_TASK_OPEN_TTL_SECONDS,
    ),
    taskReclaimIntervalSeconds: parsePositiveInt(
      env.TASK_RECLAIM_INTERVAL_SECONDS,
      'TASK_RECLAIM_INTERVAL_SECONDS',
      DEFAULT_TASK_RECLAIM_INTERVAL_SECONDS,
      MAX_TASK_OPEN_TTL_SECONDS,
    ),
    taskBidCompactionIntervalSeconds: parseNonNegativeInt(
      env.TASK_BID_COMPACTION_INTERVAL_SECONDS,
      'TASK_BID_COMPACTION_INTERVAL_SECONDS',
      DEFAULT_TASK_BID_COMPACTION_INTERVAL_SECONDS,
      86_400, // max 24 hours
    ),
    hashChainVerifyOnStartup: parseBoolean(
      env.HASH_CHAIN_VERIFY_ON_STARTUP,
      'HASH_CHAIN_VERIFY_ON_STARTUP',
      DEFAULT_HASH_CHAIN_VERIFY_ON_STARTUP,
    ),
    hashChainVerifyIntervalSeconds: parseNonNegativeInt(
      env.HASH_CHAIN_VERIFY_INTERVAL_SECONDS,
      'HASH_CHAIN_VERIFY_INTERVAL_SECONDS',
      DEFAULT_HASH_CHAIN_VERIFY_INTERVAL_SECONDS,
      86_400, // max 24 hours
    ),
    metricsEnabled: parseBoolean(
      env.METRICS_ENABLED,
      'METRICS_ENABLED',
      DEFAULT_METRICS_ENABLED,
    ),
    revokedTokensCleanupIntervalSeconds: parseNonNegativeInt(
      env.REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS,
      'REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS',
      DEFAULT_REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS,
      86_400, // max 24 hours
    ),
    nodeEnv,
    isProduction,
    logLevel: parseLogLevel(env.LOG_LEVEL),
    version: readString(env, 'SERVER_VERSION', SERVER_VERSION),
  };

  return Object.freeze(config);
}

/**
 * Non-fatal security warnings emitted at startup. Config remains valid; these
 * are the "works in dev, dangerous in production" combinations.
 */
export function describeSecurityWarnings(config: ServerConfig): string[] {
  const warnings: string[] = [];
  if (
    !config.isProduction &&
    Buffer.byteLength(config.jwtSecret, 'utf8') < PRODUCTION_MIN_JWT_SECRET_BYTES
  ) {
    warnings.push(
      'JWT_SECRET is shorter than 32 bytes; acceptable for development, never for production',
    );
  }
  if (config.isProduction && config.allowedOrigins.length === 0) {
    // Unreachable through loadConfig (it fails fast), kept for callers that
    // construct ServerConfig directly in tests/embedding.
    warnings.push(
      'ALLOWED_ORIGINS is empty in production; every browser WebSocket Origin will be rejected',
    );
  }
  if (config.allowAdminSelfRegister && config.isProduction) {
    warnings.push(
      'ALLOW_ADMIN_SELF_REGISTER is enabled in production; any anonymous client can mint an admin',
    );
  }
  return warnings;
}

/**
 * Non-secret view of the config, safe to log at startup.
 */
export function describeConfig(config: ServerConfig): Record<string, unknown> {
  return {
    port: config.port,
    host: config.host,
    dbPath: config.dbPath,
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    version: config.version,
    jwtIssuer: config.jwtIssuer,
    jwtExpiresInSeconds: config.jwtExpiresInSeconds,
    allowAdminSelfRegister: config.allowAdminSelfRegister,
    demoMode: config.demoMode,
    authMaxFailedAttempts: config.authMaxFailedAttempts,
    authFailWindowSeconds: config.authFailWindowSeconds,
    authLockoutSeconds: config.authLockoutSeconds,
    wsPath: config.wsPath,
    allowedOrigins: [...config.allowedOrigins],
    allowMissingOrigin: config.allowMissingOrigin,
    wsHeartbeatIntervalMs: config.wsHeartbeatIntervalMs,
    resumeMaxEvents: config.resumeMaxEvents,
    wsConnectionRateLimit: config.wsConnectionRateLimit,
    wsConnectionBurst: config.wsConnectionBurst,
    wsAgentRateLimit: config.wsAgentRateLimit,
    wsAgentBurst: config.wsAgentBurst,
    taskOpenTtlSeconds: config.taskOpenTtlSeconds,
    taskReclaimIntervalSeconds: config.taskReclaimIntervalSeconds,
    taskBidCompactionIntervalSeconds: config.taskBidCompactionIntervalSeconds,
  };
}
