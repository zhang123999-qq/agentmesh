/**
 * `agent.authenticate` brute-force throttling (US-005 security gap closure).
 *
 * A secret is a long-lived reusable credential, so repeated failures must cost
 * the attacker: after N failures inside a window the identity is locked out
 * (`-32005`, `reason: "too_many_attempts"`, `retryAfterMs`), with exponential
 * backoff, per-identity isolation and a reset on success.
 *
 * Time is injected (`now`), so the tests advance the clock instead of sleeping.
 */

import { EventStore } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS } from '@agentmesh/protocol';
import { openStore, type Repositories } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

import type { ServerStore } from '../src/app.js';
import {
  AuthFailureLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  MAX_LOCKOUT_MS,
} from '../src/auth/rate-limit.js';
import { createTokenService, type TokenService } from '../src/auth/token.js';
import type { DispatchContext, DispatchOutcome } from '../src/dispatcher.js';
import { RpcDispatcher } from '../src/dispatcher.js';
import { registerAccountsModule, type AccountsService } from '../src/modules/accounts.js';
import { createHandlerRegistry } from '../src/registry.js';
import { silentLogger } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';
const T0 = 1_700_000_000_000;
const SECOND = 1000;

interface Harness {
  db: ServerStore['db'];
  repos: Repositories;
  tokens: TokenService;
  service: AccountsService;
  /** Advance the injected clock (ms). */
  advance: (ms: number) => void;
  call: (method: string, params?: unknown, ctx?: DispatchContext) => Promise<DispatchOutcome>;
}

interface AuthResult {
  agentId: string;
  token: string;
  role: string;
  secret?: string;
}

function makeHarness(
  overrides: { maxFailedAttempts?: number; failWindowSeconds?: number; lockoutSeconds?: number } = {},
): Harness {
  const { db, repos } = openStore(':memory:');
  let now = T0;
  const events = new EventStore(db, { clock: () => now });
  const tokens = createTokenService({ secret: SECRET, clock: () => now });
  const registry = createHandlerRegistry();
  let counter = 0;
  const service = registerAccountsModule(registry, {
    db,
    accounts: repos.accounts,
    events,
    tokens,
    idFactory: () => {
      counter += 1;
      return `agt_${counter}`;
    },
    clock: () => now,
    authRateLimit: { ...DEFAULT_AUTH_RATE_LIMIT, ...overrides },
  });
  const dispatcher = new RpcDispatcher({
    registry,
    logger: silentLogger(),
    tokenVerifier: (token) => tokens.verify(token),
  });

  return {
    db,
    repos,
    tokens,
    service,
    advance: (ms) => {
      now += ms;
    },
    call: (method, params = {}, ctx = {}) =>
      dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method, params }, ctx),
  };
}

function resultOf<T>(outcome: DispatchOutcome): T {
  expect(outcome.response?.error).toBeUndefined();
  return outcome.response?.result as T;
}

function errorOf(outcome: DispatchOutcome): { code: number; message: string; data?: unknown } {
  const error = outcome.response?.error;
  expect(error).toBeDefined();
  return error as { code: number; message: string; data?: unknown };
}

async function register(h: Harness, name: string): Promise<AuthResult> {
  return resultOf<AuthResult>(await h.call(METHODS.agent.register, { name }));
}

/** N wrong-secret attempts; asserts each is a plain credential failure. */
async function failTimes(h: Harness, identifier: { name?: string; agentId?: string }, times: number): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    const error = errorOf(
      await h.call(METHODS.agent.authenticate, { ...identifier, secret: `wrong-${i}` }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.data).toEqual({ reason: 'invalid_credentials' });
  }
}

describe('agent.authenticate failure throttling', () => {
  it('locks the identity after the threshold, even for the correct secret', async () => {
    const h = makeHarness(); // defaults: 5 failures / 60s window / 60s lockout
    const account = await register(h, 'alpha');

    await failTimes(h, { name: 'alpha' }, 5);

    // 60s of lockout remain; the *correct* secret is rejected too.
    const locked = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(locked.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(locked.message).toMatch(/too many/i);
    expect(locked.data).toMatchObject({ reason: 'too_many_attempts' });
    expect((locked.data as { retryAfterMs: number }).retryAfterMs).toBe(60 * SECOND);

    // The rejection is soft (an RPC error), it never mints a token or writes
    // an event, and it does not leak whether the secret was right.
    expect(h.repos.events.list({ type: 'account.authenticated' })).toHaveLength(0);

    // One second before expiry it is still locked, with a shrunken retryAfter.
    h.advance(59 * SECOND);
    const almost = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(almost.code).toBe(JsonRpcErrorCode.RateLimited);
    expect((almost.data as { retryAfterMs: number }).retryAfterMs).toBe(SECOND);

    // After the lockout the correct secret works again.
    h.advance(SECOND);
    const ok = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(await h.tokens.verify(ok.token)).toMatchObject({
      agentId: account.agentId,
      workspaceId: 'default',
    });
  });

  it('shares one bucket between the name and the agentId of the same account', async () => {
    const h = makeHarness();
    const account = await register(h, 'alpha');

    await failTimes(h, { agentId: account.agentId }, 5);
    const locked = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(locked.code).toBe(JsonRpcErrorCode.RateLimited);
  });

  it('keeps different identities isolated', async () => {
    const h = makeHarness();
    const alpha = await register(h, 'alpha');
    const beta = await register(h, 'beta');

    await failTimes(h, { name: 'alpha' }, 5);
    expect(
      errorOf(await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: alpha.secret })).code,
    ).toBe(JsonRpcErrorCode.RateLimited);

    // beta is untouched: correct secret still logs in, its own failures still
    // return the ordinary -32001.
    const ok = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, { name: 'beta', secret: beta.secret }),
    );
    expect(ok.agentId).toBe(beta.agentId);
    const wrong = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'beta', secret: 'nope' }),
    );
    expect(wrong.code).toBe(JsonRpcErrorCode.Unauthorized);
  });

  it('resets the counter on a successful authentication', async () => {
    const h = makeHarness();
    const account = await register(h, 'alpha');

    await failTimes(h, { name: 'alpha' }, 4); // one short of the threshold
    resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );

    // The slate is clean: four more failures do not lock the account.
    await failTimes(h, { name: 'alpha' }, 4);
    const stillOk = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(stillOk.agentId).toBe(account.agentId);
  });

  it('forgets failures once the counting window lapses', async () => {
    const h = makeHarness();
    const account = await register(h, 'alpha');

    await failTimes(h, { name: 'alpha' }, 4);
    h.advance(61 * SECOND); // window closed, no lock was armed
    await failTimes(h, { name: 'alpha' }, 1); // a fresh window starts at 1

    const ok = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(ok.agentId).toBe(account.agentId);
  });

  it('doubles the lockout on repeated abuse (exponential backoff)', async () => {
    const h = makeHarness();
    const account = await register(h, 'alpha');

    await failTimes(h, { name: 'alpha' }, 5);
    h.advance(60 * SECOND); // first lockout (60s) over
    await failTimes(h, { name: 'alpha' }, 5);
    const second = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(second.code).toBe(JsonRpcErrorCode.RateLimited);
    expect((second.data as { retryAfterMs: number }).retryAfterMs).toBe(120 * SECOND);

    h.advance(120 * SECOND);
    await failTimes(h, { name: 'alpha' }, 5);
    const third = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect((third.data as { retryAfterMs: number }).retryAfterMs).toBe(240 * SECOND);
  });

  it('honours configured thresholds', async () => {
    const h = makeHarness({ maxFailedAttempts: 2, lockoutSeconds: 5 });
    const account = await register(h, 'alpha');

    await failTimes(h, { name: 'alpha' }, 2);
    const locked = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
    );
    expect(locked.code).toBe(JsonRpcErrorCode.RateLimited);
    expect((locked.data as { retryAfterMs: number }).retryAfterMs).toBe(5 * SECOND);

    h.advance(5 * SECOND);
    expect(
      resultOf<AuthResult>(
        await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
      ).agentId,
    ).toBe(account.agentId);
  });

  it('lets a valid token refresh an identity and clear its failures', async () => {
    const h = makeHarness();
    const account = await register(h, 'alpha');
    await failTimes(h, { name: 'alpha' }, 4);

    // A token already proves the identity: refresh needs no secret and resets.
    const fresh = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, { agentId: account.agentId }, {
        token: account.token,
      }),
    );
    expect(fresh.agentId).toBe(account.agentId);

    await failTimes(h, { name: 'alpha' }, 4);
    expect(
      resultOf<AuthResult>(
        await h.call(METHODS.agent.authenticate, { name: 'alpha', secret: account.secret }),
      ).agentId,
    ).toBe(account.agentId);
  });
});

describe('AuthFailureLimiter', () => {
  it('does not consume an attempt when only checking', () => {
    let now = T0;
    const limiter = new AuthFailureLimiter({ clock: () => now });
    for (let i = 0; i < 5; i += 1) limiter.recordFailure('k');

    const decision = limiter.check('k');
    expect(decision).toMatchObject({ allowed: false, retryAfterMs: 60 * SECOND });
    // Repeated checks keep the same expiry (they never extend the lockout).
    now += 10 * SECOND;
    expect(limiter.check('k')).toMatchObject({ allowed: false, retryAfterMs: 50 * SECOND });
  });

  it('bounds tracked identities so a flood cannot grow memory without limit', () => {
    const limiter = new AuthFailureLimiter({ maxEntries: 3, clock: () => 1_000 });
    for (let i = 0; i < 20; i += 1) limiter.recordFailure(`id-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  it('keeps an actively-checked identity while one-shot keys flood in (LRU)', () => {
    const limiter = new AuthFailureLimiter({ maxEntries: 3, clock: () => 1_000 });
    limiter.recordFailure('victim');

    for (let i = 0; i < 12; i += 1) {
      limiter.check('victim'); // active identity, touched before each insert
      limiter.recordFailure(`flood-${i}`);
    }

    expect(limiter.has('victim')).toBe(true);
  });

  it('caps the backoff and clears a key on success', () => {    let now = T0;
    const limiter = new AuthFailureLimiter({
      clock: () => now,
      maxFailedAttempts: 1,
      lockoutSeconds: 60,
    });
    let maxSeen = 0;
    for (let i = 0; i < 12; i += 1) {
      limiter.recordFailure('k');
      const decision = limiter.check('k');
      expect(decision.allowed).toBe(false);
      maxSeen = Math.max(maxSeen, (decision as { retryAfterMs: number }).retryAfterMs);
      now += (decision as { retryAfterMs: number }).retryAfterMs;
    }
    expect(maxSeen).toBe(MAX_LOCKOUT_MS);
    expect(limiter.size).toBe(1);

    limiter.recordSuccess('k');
    expect(limiter.size).toBe(0);
    expect(limiter.check('k')).toEqual({ allowed: true });
  });
});
