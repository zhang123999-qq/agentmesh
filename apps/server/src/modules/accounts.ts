/**
 * Account feature module: registration, authentication and the roster.
 *
 * Methods (see `METHODS.agent` in `@agentmesh/protocol`):
 *
 * - `agent.register`      — create an account, append `account.registered`,
 *                           return `{ agentId, token, role, expiresAt, secret }`.
 * - `agent.authenticate`  — exchange `{ agentId|name, secret }` for a fresh
 *                           token, append `account.authenticated`.
 * - `agent.list`          — read-only roster of the caller's workspace.
 *
 * Persistence is the `accounts` table; every write also appends a domain event
 * to the log so projections/replay (and later audit/WS push) see the same
 * facts.
 *
 * ## Credentials (security contract)
 *
 * `register` issues a CSPRNG secret and returns the plaintext **once**; only
 * `sha256(secret)` is stored (`accounts.secret_hash`, migration v4). `authenticate`
 * requires that secret — an identifier alone never mints a token, so knowing a
 * name or agent id (the roster is readable) cannot impersonate an account.
 * An already valid token may refresh itself without repeating the secret.
 * Secrets and digests never appear in responses other than that one register
 * reply, in events, in the roster or in logs.
 *
 * Because the secret is a **long-lived reusable credential**, `authenticate`
 * is throttled per identity: failures inside a window lock the identity out
 * (`-32005`, `data.reason = "too_many_attempts"`, `data.retryAfterMs`), with
 * exponential backoff and a reset on success (see `auth/rate-limit.ts`).
 * The limiter is a soft rejection — a `ProtocolError`, never a crash.
 *
 * ## Tenancy
 *
 * `register` always writes to the module's configured workspace (the
 * deployment default) — a spoofable request header must not be able to plant
 * identities in another tenant. Reads (`authenticate`, `list`) run in the
 * request workspace, which the dispatcher pins to the token's `workspaceId`
 * claim for authenticated calls.
 */

import { randomUUID } from 'node:crypto';

import type { AccountRegisteredPayload, AccountRole } from '@agentmesh/protocol';
import {
  JsonRpcErrorCode,
  METHODS,
  ProtocolError,
  isAccountRole,
} from '@agentmesh/protocol';
import { aggregateIdOf } from '@agentmesh/core';
import type { EventStore } from '@agentmesh/core';
import type { Account, AccountsDao, AgentMeshDatabase, WorkspacesDao } from '@agentmesh/store';
import { withTransaction } from '@agentmesh/store';

import {
  generateAccountSecret,
  hashAccountSecret,
  MAX_SECRET_LENGTH,
  secretHashMatches,
} from '../auth/credentials.js';
import {
  AuthFailureLimiter,
  type AuthRateLimitConfig,
} from '../auth/rate-limit.js';
import type { AuthContext, Role } from '../auth/roles.js';
import { ACCOUNT_LIST_ROLES, requireRole } from '../auth/roles.js';
import type { TokenService } from '../auth/token.js';
import type { HandlerRegistry } from '../registry.js';

/** Longest accepted account name / owner / skill label. */
const MAX_LABEL_LENGTH = 64;
const MAX_SKILLS = 32;

export interface AccountsModuleOptions {
  /** Connection used to wrap `INSERT + event append` in one transaction. */
  readonly db: AgentMeshDatabase;
  readonly accounts: AccountsDao;
  readonly events: EventStore;
  readonly tokens: TokenService;
  /** Tenant scope; defaults to the event store's workspace. */
  readonly workspaceId?: string;
  /** Allow self-service `role: "admin"` (config: `ALLOW_ADMIN_SELF_REGISTER`). */
  readonly allowAdminSelfRegister?: boolean;
  /**
   * Failed-attempt throttling for `agent.authenticate`
   * (config: `AUTH_MAX_FAILED_ATTEMPTS` / `AUTH_FAIL_WINDOW_SECONDS` /
   * `AUTH_LOCKOUT_SECONDS`). Omitted values use the built-in defaults.
   */
  readonly authRateLimit?: Partial<AuthRateLimitConfig>;
  /** Limiter override (tests inject one with a controllable clock). */
  readonly limiter?: AuthFailureLimiter;
  /** Anonymous registration budget (`agent.register` per remote address). */
  readonly registerRateLimit?: Partial<RegisterRateLimitConfig>;
  /** Registration limiter override (tests inject one with a controllable clock). */
  readonly registerLimiter?: RegistrationLimiter;
  /** Tenant registry for invite redemption, quota and disabled checks (US-025). */
  readonly workspaces?: WorkspacesDao;
  /** Account id generator (tests inject a deterministic one). */
  readonly idFactory?: () => string;
  /** Injectable clock for deterministic timestamps. */
  readonly clock?: () => number;
}

export interface RegisterAccountInput {
  readonly name: string;
  readonly owner?: string;
  readonly skills?: readonly string[];
  readonly role?: Role;
}

export interface AuthenticateInput {
  readonly agentId?: string;
  readonly name?: string;
  /** Account secret issued by `agent.register` (required unless refreshing). */
  readonly secret?: string;
}

/** Local bootstrap input for the seed-admin CLI (never exposed over RPC). */
export interface SeedAdminInput {
  readonly name: string;
  readonly owner?: string;
  readonly skills?: readonly string[];
}

export interface SeedAdminResult {
  readonly agentId: string;
  readonly name: string;
  readonly role: 'admin';
  readonly createdAt: number;
  /** Plaintext secret, present only when this call created the account. */
  readonly secret?: string;
  /** `false` when an admin with this name already existed (idempotent retry). */
  readonly created: boolean;
}

export interface AccountListQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly role?: AccountRole;
}

/** Wire shape of an account (never includes credentials/secrets). */
export interface AccountView {
  readonly agentId: string;
  readonly name: string;
  readonly owner: string | null;
  readonly skills: string[];
  readonly role: Role;
  readonly createdAt: number;
}

export interface AuthenticatedAccount {
  readonly agentId: string;
  readonly token: string;
  readonly role: Role;
  /** Epoch seconds when `token` expires (convenience for clients). */
  readonly expiresAt: number;
}

/**
 * Register reply. `secret` is the only time the plaintext credential ever
 * leaves the server; it is absent from every other method and from events.
 */
export interface RegisterAccountResult extends AuthenticatedAccount {
  readonly secret: string;
}

export interface AccountListResult {
  readonly accounts: AccountView[];
  readonly total: number;
  readonly limit: number | null;
  readonly offset: number;
}

// ---------------------------------------------------------------------------
// Param validation (structured `-32602` instead of leaking zod messages)
// ---------------------------------------------------------------------------

function invalidParams(message: string, field?: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidParams,
    `Invalid params: ${message}`,
    field === undefined ? undefined : { field },
  );
}

/**
 * Neutral duplicate-name rejection: `-32602` with the field only.
 * The submitted name is deliberately not echoed, and the wording does not
 * confirm whether the name is registered here or in another workspace.
 */
function nameUnavailable(): ProtocolError {
  return new ProtocolError(JsonRpcErrorCode.InvalidParams, 'name unavailable', {
    field: 'name',
  });
}

/**
 * Soft rejection for a throttled identity (`-32005`, reason
 * `too_many_attempts`) carrying the remaining lockout so clients back off.
 * It is a `ProtocolError`, so the dispatcher returns it as an ordinary RPC
 * error instead of a `-32603`/`system.error` crash.
 */
function tooManyAttempts(retryAfterMs: number): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.RateLimited,
    'Too many failed authentication attempts',
    { reason: 'too_many_attempts', retryAfterMs },
  );
}

/** Anonymous registration budget per remote address. */
export const DEFAULT_REGISTER_LIMIT_MAX = 30;
export const DEFAULT_REGISTER_LIMIT_WINDOW_MS = 60_000;

export interface RegisterRateLimitConfig {
  readonly max: number;
  readonly windowMs: number;
  /** Bucket ceiling before stale entries are swept (bounds memory). */
  readonly maxEntries: number;
}

/** Small fixed-window limiter for the unauthenticated `agent.register` path. */
export class RegistrationLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #maxEntries: number;
  readonly #clock: () => number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: Partial<RegisterRateLimitConfig> & { clock?: () => number } = {}) {
    this.#max = Math.max(1, options.max ?? DEFAULT_REGISTER_LIMIT_MAX);
    this.#windowMs = Math.max(1, options.windowMs ?? DEFAULT_REGISTER_LIMIT_WINDOW_MS);
    this.#maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.#clock = options.clock ?? (() => Date.now());
  }

  get size(): number {
    return this.#hits.size;
  }

  has(key: string): boolean {
    return this.#hits.has(key);
  }

  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.#clock();
    const bucket = this.#hits.get(key);
    if (bucket !== undefined && now < bucket.resetAt) {
      // LRU touch: keep active addresses while one-shot keys are evicted.
      this.#hits.delete(key);
      this.#hits.set(key, bucket);
      if (bucket.count >= this.#max) {
        return { allowed: false, retryAfterMs: bucket.resetAt - now };
      }
      bucket.count += 1;
      return { allowed: true };
    }
    this.#makeRoom(now);
    this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
    return { allowed: true };
  }

  /** Drop expired buckets, then the oldest live one if still at the ceiling. */
  #makeRoom(now: number): void {
    if (this.#hits.size < this.#maxEntries) return;
    for (const [key, bucket] of this.#hits) {
      if (now >= bucket.resetAt) this.#hits.delete(key);
    }
    while (this.#hits.size >= this.#maxEntries) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
  }
}

function tooManyRegistrations(retryAfterMs: number): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.RateLimited,
    'Too many registration attempts',
    { reason: 'too_many_registrations', retryAfterMs },
  );
}

function asParamsObject(params: unknown, method: string): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw invalidParams(`${method} params must be an object`);
  }
  return params as Record<string, unknown>;
}

function readLabel(
  params: Record<string, unknown>,
  field: string,
  { fallback }: { fallback?: string } = {},
): string | undefined {
  const raw = params[field];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    throw invalidParams(`${field} must be a string`, field);
  }
  const value = raw.trim();
  if (value.length === 0) return fallback;
  if (value.length > MAX_LABEL_LENGTH) {
    throw invalidParams(`${field} must be at most ${MAX_LABEL_LENGTH} characters`, field);
  }
  return value;
}

function readSkills(params: Record<string, unknown>): string[] | undefined {
  const raw = params.skills;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw invalidParams('skills must be an array of strings', 'skills');
  }
  if (raw.length > MAX_SKILLS) {
    throw invalidParams(`skills must contain at most ${MAX_SKILLS} entries`, 'skills');
  }
  const skills: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw invalidParams('skills must be an array of strings', 'skills');
    }
    const value = item.trim();
    if (value.length === 0) continue;
    if (value.length > MAX_LABEL_LENGTH) {
      throw invalidParams(
        `each skill must be at most ${MAX_LABEL_LENGTH} characters`,
        'skills',
      );
    }
    if (!skills.includes(value)) skills.push(value);
  }
  return skills;
}

function readRole(params: Record<string, unknown>): Role | undefined {
  const raw = params.role;
  if (raw === undefined || raw === null) return undefined;
  if (!isAccountRole(raw)) {
    throw invalidParams('role must be one of admin, agent, observer', 'role');
  }
  return raw;
}

function parseRegisterInput(params: unknown): RegisterAccountInput {
  const input = asParamsObject(params, METHODS.agent.register);
  const name = readLabel(input, 'name');
  if (name === undefined) {
    throw invalidParams('name is required', 'name');
  }
  const owner = readLabel(input, 'owner');
  const skills = readSkills(input);
  const role = readRole(input);
  return {
    name,
    ...(owner === undefined ? {} : { owner }),
    ...(skills === undefined ? {} : { skills }),
    ...(role === undefined ? {} : { role }),
  };
}

/**
 * Secrets are opaque base64url strings: read them verbatim (no trimming) and
 * only bound the length so a hostile client cannot make hashing expensive.
 */
function readSecret(input: Record<string, unknown>): string | undefined {
  const raw = input.secret;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw invalidParams('secret must be a string', 'secret');
  }
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_SECRET_LENGTH) {
    throw invalidParams(`secret must be at most ${MAX_SECRET_LENGTH} characters`, 'secret');
  }
  return raw;
}

function parseAuthenticateInput(params: unknown): AuthenticateInput {
  const input = asParamsObject(params, METHODS.agent.authenticate);
  const agentId = readLabel(input, 'agentId');
  const name = readLabel(input, 'name');
  const secret = readSecret(input);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    ...(name === undefined ? {} : { name }),
    ...(secret === undefined ? {} : { secret }),
  };
}

/** SQLite `UNIQUE constraint failed` (e.g. a concurrent duplicate register). */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as unknown as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

function readPagination(
  params: Record<string, unknown>,
): { limit?: number; offset: number } {
  const rawLimit = params.limit;
  const rawOffset = params.offset;
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
      throw invalidParams('limit must be a positive integer', 'limit');
    }
    limit = rawLimit;
  }
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      throw invalidParams('offset must be a non-negative integer', 'offset');
    }
    offset = rawOffset;
  }
  return limit === undefined ? { offset } : { limit, offset };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Domain service behind the three RPC handlers (unit-testable on its own). */
export class AccountsService {
  readonly #db: AgentMeshDatabase;
  readonly #accounts: AccountsDao;
  readonly #events: EventStore;
  readonly #tokens: TokenService;
  readonly #workspaceId: string;
  readonly #allowAdminSelfRegister: boolean;
  readonly #idFactory: () => string;
  readonly #clock: () => number;
  readonly #limiter: AuthFailureLimiter;
  readonly #registerLimiter: RegistrationLimiter;
  readonly #workspaces: WorkspacesDao | undefined;

  constructor(options: AccountsModuleOptions) {
    this.#db = options.db;
    this.#accounts = options.accounts;
    this.#events = options.events;
    this.#tokens = options.tokens;
    this.#workspaceId = options.workspaceId ?? 'default';
    this.#allowAdminSelfRegister = options.allowAdminSelfRegister ?? false;
    this.#idFactory = options.idFactory ?? (() => `agt_${randomUUID()}`);
    this.#clock = options.clock ?? (() => Date.now());
    // Failure counters share the service clock so lockouts are deterministic
    // under injected time in tests.
    this.#limiter =
      options.limiter ??
      new AuthFailureLimiter({ ...options.authRateLimit, clock: this.#clock });
    this.#registerLimiter =
      options.registerLimiter ??
      new RegistrationLimiter({ ...options.registerRateLimit, clock: this.#clock });
    this.#workspaces = options.workspaces;
  }

  /** The authenticate throttler (exposed for diagnostics/tests). */
  get limiter(): AuthFailureLimiter {
    return this.#limiter;
  }

  /**
   * Create an account, append `account.registered`, mint a token + secret.
   *
   * `role` defaults to `agent`; self-registering as `admin` is rejected with
   * `-32002` unless the deployment sets `ALLOW_ADMIN_SELF_REGISTER=true`.
   *
   * Names are judged globally, matching the table's own `UNIQUE` constraint.
   * The error is deliberately neutral (`name unavailable`, no echoed name) so
   * the response cannot be used as an account-existence oracle.
   */
  async register(
    input: RegisterAccountInput,
    options: {
      readonly remoteAddress?: string;
      /** Target tenant (invite redemption). Defaults to the service tenant. */
      readonly workspaceId?: string;
      /** True when registration was authorised by a valid invite code. */
      readonly viaInvite?: boolean;
    } = {},
  ): Promise<RegisterAccountResult> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_LABEL_LENGTH) {
      throw invalidParams(
        `name must be 1-${MAX_LABEL_LENGTH} characters`,
        'name',
      );
    }
    // `agent.register` is the only unauthenticated write. Throttle it per
    // remote address so a single client cannot mint accounts/events without
    // bound; direct service calls in tests omit the address and are unlimited.
    if (options.remoteAddress !== undefined) {
      const decision = this.#registerLimiter.check(options.remoteAddress);
      if (!decision.allowed) throw tooManyRegistrations(decision.retryAfterMs);
    }
    const role: Role = input.role ?? 'agent';
    if (!isAccountRole(role)) {
      throw invalidParams('role must be one of admin, workspace_admin, agent, observer', 'role');
    }
    if (role === 'admin' && !this.#allowAdminSelfRegister) {
      throw new ProtocolError(
        JsonRpcErrorCode.Forbidden,
        'admin self-registration is disabled',
        { role, hint: 'set ALLOW_ADMIN_SELF_REGISTER=true or seed an admin' },
      );
    }
    // `workspace_admin` is only mintable through a valid invite (the code is the
    // trust anchor for provisioning a tenant admin); never via anonymous register.
    if (role === 'workspace_admin' && options.viaInvite !== true) {
      throw new ProtocolError(
        JsonRpcErrorCode.Forbidden,
        'workspace_admin accounts are provisioned via an invite code',
      );
    }
    const workspaceId = options.workspaceId ?? this.#workspaceId;
    if (options.viaInvite === true) {
      const ws = this.#workspaces?.get(workspaceId);
      if (ws === undefined) {
        throw new ProtocolError(JsonRpcErrorCode.NotFound, 'workspace not found');
      }
      if (ws.disabledAt !== null) {
        throw new ProtocolError(JsonRpcErrorCode.Forbidden, 'workspace is disabled');
      }
    }
    // DB truth: `accounts.name` is UNIQUE across the table, so judge
    // duplicates the same way instead of per (name, workspaceId).
    if (this.#accounts.getByNameAnyWorkspace(name) !== undefined) {
      throw nameUnavailable();
    }

    const createdAt = this.#clock();
    const id = this.#nextId();
    const skills = [...(input.skills ?? [])];
    const owner = input.owner ?? null;
    const secret = generateAccountSecret();
    const secretHash = hashAccountSecret(secret);
    const payload: AccountRegisteredPayload = {
      name,
      skills,
      role,
      createdAt,
      secretHash,
      ...(owner === null ? {} : { owner }),
    };

    try {
      withTransaction(this.#db, () => {
        // Quota enforcement runs **inside** the IMMEDIATE transaction: the
        // count read and the INSERT must be atomic. A pre-transaction check
        // has a race window where another writer (another instance, or a
        // second connection) inserts between the check and this INSERT,
        // exceeding `maxAgents`. `withTransaction` takes the write lock before
        // the callback, so re-reading the tenant here serializes the check
        // with every competing registration.
        if (options.viaInvite === true && this.#workspaces !== undefined) {
          const current = this.#workspaces.get(workspaceId);
          if (current === undefined) {
            throw new ProtocolError(JsonRpcErrorCode.NotFound, 'workspace not found');
          }
          if (this.#accounts.count(workspaceId) >= current.maxAgents) {
            throw new ProtocolError(
              JsonRpcErrorCode.QuotaExceeded,
              'workspace agent quota exceeded',
              { maxAgents: current.maxAgents },
            );
          }
        }
        this.#accounts.create({
          id,
          name,
          owner,
          skills,
          role,
          createdAt,
          workspaceId,
        });
        this.#accounts.setSecretHash(id, secretHash, workspaceId);
        this.#events.append({
          aggregateId: aggregateIdOf('account', id),
          type: 'account.registered',
          payload,
          ts: createdAt,
          workspaceId,
        });
      });
    } catch (err) {
      // Lost a race against a concurrent registration of the same name.
      if (isUniqueViolation(err)) throw nameUnavailable();
      throw err;
    }

    return {
      ...(await this.#authenticateAs({ agentId: id, role }, workspaceId)),
      secret,
    };
  }

  /**
   * Local-only bootstrap: create the first `admin` without the self-register
   * flag. Used by the `seed:admin` CLI, never wired into the RPC registry.
   *
   * Idempotent by account name: an existing admin is returned with
   * `created: false` and no secret (the plaintext is unrecoverable), while a
   * name owned by a non-admin is rejected instead of being silently reused.
   */
  seedAdmin(input: SeedAdminInput): SeedAdminResult {
    const name = input.name.trim();
    if (name.length === 0 || name.length > MAX_LABEL_LENGTH) {
      throw invalidParams(`name must be 1-${MAX_LABEL_LENGTH} characters`, 'name');
    }

    const existing = this.#accounts.getByNameAnyWorkspace(name);
    if (existing !== undefined) {
      if (existing.role !== 'admin') {
        throw invalidParams(
          `account "${name}" already exists with role "${existing.role}"`,
          'name',
        );
      }
      return {
        agentId: existing.id,
        name: existing.name,
        role: 'admin',
        createdAt: existing.createdAt,
        created: false,
      };
    }

    const createdAt = this.#clock();
    const id = this.#nextId();
    const skills = [...(input.skills ?? [])];
    const owner = input.owner ?? null;
    const secret = generateAccountSecret();
    const secretHash = hashAccountSecret(secret);
    const payload: AccountRegisteredPayload = {
      name,
      skills,
      role: 'admin',
      createdAt,
      secretHash,
      ...(owner === null ? {} : { owner }),
    };

    try {
      withTransaction(this.#db, () => {
        this.#accounts.create({
          id,
          name,
          owner,
          skills,
          role: 'admin',
          createdAt,
          workspaceId: this.#workspaceId,
        });
        this.#accounts.setSecretHash(id, secretHash, this.#workspaceId);
        this.#events.append({
          aggregateId: aggregateIdOf('account', id),
          type: 'account.registered',
          payload,
          ts: createdAt,
          workspaceId: this.#workspaceId,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameUnavailable();
      throw err;
    }

    return {
      agentId: id,
      name,
      role: 'admin',
      createdAt,
      secret,
      created: true,
    };
  }

  /**
   * Exchange credentials for a fresh token and append `account.authenticated`
   * (the last-seen watermark used by the reducer).
   *
   * `agentId` wins when both are supplied. Unknown identities fail with
   * `-32001` (not `-32004`) so the response does not confirm existence.
   *
   * A credential is mandatory: `secret` for a normal login, or an already
   * valid token belonging to the *same* account when refreshing (passed as
   * `options.refreshFrom`). Anything else is `-32001 invalid_credentials` and
   * writes no event.
   *
   * ## Throttling
   *
   * Failures are counted per identity (resolved account id; the normalized
   * submitted identifier for unknown accounts) by an in-process
   * {@link AuthFailureLimiter}. Once the threshold is hit inside the window,
   * every attempt — **including one carrying the correct secret** — is
   * rejected with `-32005 too_many_attempts` + `retryAfterMs` until the
   * lockout lapses. A successful secret check (or a valid token refresh)
   * clears the counter. Different identities never share a bucket.
   */
  async authenticate(
    input: AuthenticateInput,
    options: { readonly refreshFrom?: AuthContext; readonly workspaceId?: string } = {},
  ): Promise<AuthenticatedAccount> {
    const workspaceId = options.workspaceId ?? this.#workspaceId;
    const agentId = input.agentId?.trim();
    const name = input.name?.trim();
    if ((agentId === undefined || agentId.length === 0) && (name === undefined || name.length === 0)) {
      throw invalidParams('agentId or name is required');
    }

    // Normalized identifier used for the limiter bucket when no account
    // resolves (agentId wins over name, matching the lookup below).
    const submittedKey =
      agentId !== undefined && agentId.length > 0
        ? `identifier:agentId:${agentId}`
        : `identifier:name:${(name ?? '').toLowerCase()}`;

    let account =
      agentId !== undefined && agentId.length > 0
        ? this.#accounts.get(agentId, workspaceId)
        : this.#accounts.getByName(name ?? '', workspaceId);
    if (account === undefined) {
      // Fall back to a global lookup so a non-default tenant's member can
      // authenticate by id/name without knowing its workspace (US-025 onboarding).
      account =
        agentId !== undefined && agentId.length > 0
          ? this.#accounts.getAnyWorkspace(agentId)
          : this.#accounts.getByNameAnyWorkspace(name ?? '');
    }
    if (account === undefined) {
      // Probing unknown identities is still a failed attempt (own bucket, so
      // it can never lock out a real account).
      const decision = this.#limiter.check(submittedKey);
      if (!decision.allowed) throw tooManyAttempts(decision.retryAfterMs);
      this.#limiter.recordFailure(submittedKey);
      throw new ProtocolError(
        JsonRpcErrorCode.Unauthorized,
        `Unknown account: ${agentId ?? name}`,
      );
    }

    // Known account: one bucket per account id, so reaching it by name or by
    // id shares the same counter.
    const workspace = this.#workspaces?.get(account.workspaceId);
    if (workspace !== undefined && workspace.disabledAt !== null) {
      throw new ProtocolError(JsonRpcErrorCode.Forbidden, 'workspace is disabled');
    }
    const key = `account:${account.id}`;
    // A verified token may refresh only its own identity; it is never proof of
    // another account's identity. It also proves the identity, so it resets
    // the failure counter instead of consuming an attempt.
    const refreshAllowed = options.refreshFrom?.agentId === account.id;
    if (!refreshAllowed) {
      // Checked *before* verification: a locked identity is rejected even
      // when the submitted secret happens to be correct.
      const decision = this.#limiter.check(key);
      if (!decision.allowed) throw tooManyAttempts(decision.retryAfterMs);

      const provided = input.secret;
      const storedHash = this.#accounts.getSecretHash(account.id, account.workspaceId);
      if (provided === undefined || !secretHashMatches(provided, storedHash)) {
        this.#limiter.recordFailure(key);
        throw new ProtocolError(
          JsonRpcErrorCode.Unauthorized,
          'Invalid credentials',
          { reason: 'invalid_credentials' },
        );
      }
    }
    this.#limiter.recordSuccess(key);

    const at = this.#clock();
    this.#events.append({
      aggregateId: aggregateIdOf('account', account.id),
      type: 'account.authenticated',
      payload: { agentId: account.id, at },
      ts: at,
      workspaceId: account.workspaceId,
    });

    return this.#authenticateAs(
      { agentId: account.id, role: account.role },
      account.workspaceId,
    );
  }

  /**
   * Roster of one workspace, newest last. `role` narrows the projection (not a
   * permission). `workspaceId` comes from the request (token-pinned for
   * authenticated calls), never from the account's own choice.
   */
  list(query: AccountListQuery = {}, workspaceId: string = this.#workspaceId): AccountListResult {
    if (query.role !== undefined && !isAccountRole(query.role)) {
      throw invalidParams('role must be one of admin, agent, observer', 'role');
    }
    const accounts = this.#accounts.list({
      workspaceId,
      ...(query.role === undefined ? {} : { role: query.role }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    const total =
      query.role === undefined
        ? this.#accounts.count(workspaceId)
        : this.#accounts.list({ workspaceId, role: query.role }).length;

    return {
      accounts: accounts.map(toAccountView),
      total,
      limit: query.limit ?? null,
      offset: query.offset ?? 0,
    };
  }

  /** Agent id must be unique; regenerate on the (astronomically unlikely) clash. */
  #nextId(): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.#idFactory();
      if (this.#accounts.get(id, this.#workspaceId) === undefined) {
        return id;
      }
    }
    throw new Error('could not allocate a unique account id');
  }

  async #authenticateAs(
    identity: { agentId: string; role: Role },
    workspaceId: string,
  ): Promise<AuthenticatedAccount> {
    const token = await this.#tokens.sign({
      agentId: identity.agentId,
      role: identity.role,
      workspaceId,
    });
    return {
      agentId: identity.agentId,
      token,
      role: identity.role,
      expiresAt: this.#tokens.expirationFor(),
    };
  }
}

function toAccountView(account: Account): AccountView {
  return {
    agentId: account.id,
    name: account.name,
    owner: account.owner,
    skills: [...account.skills],
    role: account.role,
    createdAt: account.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Wire the account methods into `registry`.
 * @returns the service instance (handy for tests and future modules).
 */
export function registerAccountsModule(
  registry: HandlerRegistry,
  options: AccountsModuleOptions,
): AccountsService {
  const service = new AccountsService(options);

  registry.registerHandler(
    METHODS.agent.register,
    async (ctx, params) => {
      const raw = asParamsObject(params, METHODS.agent.register);
      const input = parseRegisterInput(params);
      const inviteCode =
        typeof raw.inviteCode === 'string' && raw.inviteCode.length > 0 ? raw.inviteCode : undefined;
      const remote = ctx.remoteAddress === undefined ? {} : { remoteAddress: ctx.remoteAddress };

      let registered;
      if (inviteCode === undefined) {
        registered = await service.register(input, remote);
      } else {
        const workspaces = options.workspaces;
        if (workspaces === undefined) {
          throw new ProtocolError(JsonRpcErrorCode.NotFound, 'invite codes are not accepted');
        }
        const ws = workspaces.findByInvite(inviteCode);
        const now = (options.clock ?? Date.now)();
        if (ws === undefined || ws.inviteExpiresAt === null || ws.inviteExpiresAt <= now) {
          throw new ProtocolError(JsonRpcErrorCode.NotFound, 'invalid or expired invite code');
        }
        // An invite may only provision a tenant member or tenant admin.
        if (input.role !== undefined && input.role !== 'agent' && input.role !== 'workspace_admin') {
          throw new ProtocolError(
            JsonRpcErrorCode.InvalidParams,
            'invite registration allows role agent or workspace_admin',
          );
        }
        registered = await service.register(input, {
          ...remote,
          workspaceId: ws.id,
          viaInvite: true,
        });
      }
      ctx.logger.info({
        agentId: registered.agentId,
        role: registered.role,
        msg: 'account.registered',
      });
      return registered;
    },
    { description: 'Register an agent account (optionally via invite) and receive a scoped JWT' },
  );

  registry.registerHandler(
    METHODS.agent.authenticate,
    async (ctx, params) => {
      const result = await service.authenticate(parseAuthenticateInput(params), {
        ...(ctx.auth === undefined ? {} : { refreshFrom: ctx.auth }),
        workspaceId: ctx.workspaceId,
      });
      // Never log the secret/hash: only the resolved identity is recorded.
      ctx.logger.info({
        agentId: result.agentId,
        role: result.role,
        msg: 'account.authenticated',
      });
      return result;
    },
    { description: 'Exchange agent credentials for a fresh access token' },
  );

  registry.registerHandler(
    METHODS.agent.list,
    async (ctx, params) => {
      // admin + agent may read the roster; observer is read-only elsewhere.
      requireRole(ctx, ACCOUNT_LIST_ROLES);
      const input = asParamsObject(params, METHODS.agent.list);
      const { limit, offset } = readPagination(input);
      const role = readRole(input);
      // `ctx.workspaceId` is token-pinned by the dispatcher for authenticated
      // calls, so the roster can never cross tenants.
      return service.list(
        {
          ...(limit === undefined ? {} : { limit }),
          offset,
          ...(role === undefined ? {} : { role }),
        },
        ctx.workspaceId,
      );
    },
    { description: 'List agent accounts (requires admin or agent role)' },
  );

  return service;
}
