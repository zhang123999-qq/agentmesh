import {
  accountReducer,
  EventStore,
  initialAccountState,
  replayAggregate,
} from '@agentmesh/core';
import type { AccountState } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS } from '@agentmesh/protocol';
import { openStore, type Repositories } from '@agentmesh/store';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer, type ServerStore } from '../src/app.js';
import { secretHashMatches } from '../src/auth/credentials.js';
import { createTokenService, type TokenService } from '../src/auth/token.js';
import { runSeedAdmin } from '../src/cli/seed-admin.js';
import type { DispatchContext, DispatchOutcome } from '../src/dispatcher.js';
import { RpcDispatcher } from '../src/dispatcher.js';
import { AccountsService, RegistrationLimiter, registerAccountsModule } from '../src/modules/accounts.js';
import { createHandlerRegistry } from '../src/registry.js';
import { silentLogger, testConfig } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';
const CLOCK = 1_700_000_000_000;

interface Harness {
  db: ServerStore['db'];
  repos: Repositories;
  events: EventStore;
  tokens: TokenService;
  service: AccountsService;
  call: (method: string, params?: unknown, ctx?: DispatchContext) => Promise<DispatchOutcome>;
}

function makeHarness(
  options: {
    allowAdminSelfRegister?: boolean;
    registerRateLimit?: { max: number; windowMs: number };
  } = {},
): Harness {
  const { db, repos } = openStore(':memory:');
  const events = new EventStore(db, { clock: () => CLOCK });
  const tokens = createTokenService({ secret: SECRET, clock: () => CLOCK });
  const registry = createHandlerRegistry();
  let counter = 0;
  const service = registerAccountsModule(registry, {
    db,
    accounts: repos.accounts,
    events,
    tokens,
    allowAdminSelfRegister: options.allowAdminSelfRegister ?? false,
    ...(options.registerRateLimit === undefined
      ? {}
      : { registerRateLimit: options.registerRateLimit }),
    idFactory: () => {
      counter += 1;
      return `agt_${counter}`;
    },
    clock: () => CLOCK,
  });
  const dispatcher = new RpcDispatcher({
    registry,
    logger: silentLogger(),
    tokenVerifier: (token) => tokens.verify(token),
  });

  return {
    db,
    repos,
    events,
    tokens,
    service,
    call: (method, params = {}, ctx = {}) =>
      dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method, params }, ctx),
  };
}

interface AuthResult {
  agentId: string;
  token: string;
  role: string;
  expiresAt: number;
  /** Plaintext credential — present only on the `agent.register` reply. */
  secret?: string;
}

interface RosterResult {
  accounts: Array<Record<string, unknown>>;
  total: number;
  limit: number | null;
  offset: number;
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

function replay(h: Harness, agentId: string): AccountState {
  return h.events
    .loadAggregate(`account:${agentId}`)
    .reduce(accountReducer, initialAccountState(`account:${agentId}`));
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('agent.register', () => {
  it('persists the account, appends account.registered and returns a scoped token', async () => {
    const h = makeHarness();

    const result = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, {
        name: 'alpha',
        owner: 'team-a',
        skills: ['typescript', 'sql', 'typescript'],
      }),
    );

    expect(result.agentId).toBe('agt_1');
    expect(result.role).toBe('agent');
    expect(typeof result.token).toBe('string');

    // A one-time plaintext secret is issued; only its digest is persisted.
    expect(typeof result.secret).toBe('string');
    expect(result.secret?.length).toBeGreaterThanOrEqual(32);
    const storedHash = h.repos.accounts.getSecretHash('agt_1');
    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(storedHash).not.toBe(result.secret);

    const claims = await h.tokens.verify(result.token);
    expect(claims).toMatchObject({ agentId: 'agt_1', role: 'agent', workspaceId: 'default' });
    expect(claims.expiresAt).toBe(Math.floor(CLOCK / 1000) + 3600);

    const stored = h.repos.accounts.get('agt_1');
    expect(stored).toMatchObject({
      id: 'agt_1',
      name: 'alpha',
      owner: 'team-a',
      skills: ['typescript', 'sql'],
      role: 'agent',
      createdAt: CLOCK,
    });

    const events = h.repos.events.list({ type: 'account.registered' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateId: 'account:agt_1',
      type: 'account.registered',
      version: 1,
      payload: {
        name: 'alpha',
        owner: 'team-a',
        skills: ['typescript', 'sql'],
        role: 'agent',
        createdAt: CLOCK,
      },
    });

    expect(replay(h, 'agt_1')).toMatchObject({
      exists: true,
      name: 'alpha',
      owner: 'team-a',
      skills: ['typescript', 'sql'],
      role: 'agent',
      version: 1,
      secretHash: storedHash,
    });
  });

  it('defaults role to agent and tolerates omitted owner/skills', async () => {
    const h = makeHarness();
    const result = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'beta' }),
    );

    expect(result.role).toBe('agent');
    const stored = h.repos.accounts.get(result.agentId);
    expect(stored?.owner).toBeNull();
    expect(stored?.skills).toEqual([]);
  });

  it('rejects a duplicate name with a neutral -32602 and writes nothing', async () => {
    const h = makeHarness();
    await h.call(METHODS.agent.register, { name: 'alpha' });

    const error = errorOf(await h.call(METHODS.agent.register, { name: 'alpha' }));

    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    // Neutral: neither the name nor whether it exists elsewhere is echoed.
    expect(error.message).toBe('name unavailable');
    expect(error.data).toEqual({ field: 'name' });
    expect(JSON.stringify(error)).not.toContain('alpha');
    expect(h.repos.accounts.count()).toBe(1);
    expect(h.repos.events.count()).toBe(1);
  });

  it('rejects a name already taken in another workspace (table-wide UNIQUE)', async () => {
    const h = makeHarness();
    h.repos.accounts.create({ id: 'agt_other', name: 'shared', workspaceId: 'other-ws' });

    const error = errorOf(await h.call(METHODS.agent.register, { name: 'shared' }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data).toEqual({ field: 'name' });
    // Nothing was written to this workspace; the other tenant's row is untouched.
    expect(h.repos.accounts.count()).toBe(0);
    expect(h.repos.accounts.list({ workspaceId: 'other-ws' })).toHaveLength(1);
  });

  it('refuses self-registering as admin by default (-32002)', async () => {
    const h = makeHarness();

    const error = errorOf(
      await h.call(METHODS.agent.register, { name: 'boss', role: 'admin' }),
    );

    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data).toMatchObject({ role: 'admin' });
    expect(h.repos.accounts.count()).toBe(0);
    expect(h.repos.events.count()).toBe(0);
  });

  it('allows admin registration when ALLOW_ADMIN_SELF_REGISTER is on', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });

    const result = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'boss', role: 'admin' }),
    );

    expect(result.role).toBe('admin');
    expect((await h.tokens.verify(result.token)).role).toBe('admin');
  });

  it('validates params with -32602', async () => {
    const h = makeHarness();

    for (const params of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(65) },
      { name: 'ok', role: 'root' },
      { name: 'ok', skills: 'typescript' },
      { name: 'ok', skills: [42] },
      { name: 'ok', owner: 7 },
    ]) {
      const error = errorOf(await h.call(METHODS.agent.register, params));
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    }

    const arrayParams = errorOf(await h.call(METHODS.agent.register, ['alpha']));
    expect(arrayParams.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(h.repos.accounts.count()).toBe(0);
  });
});

describe('agent.authenticate', () => {
  it('issues a fresh token for a known name + secret and appends account.authenticated', async () => {
    const h = makeHarness();
    const registered = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'alpha' }),
    );

    const result = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, {
        name: 'alpha',
        secret: registered.secret,
      }),
    );

    expect(result.agentId).toBe(registered.agentId);
    expect(result.token).not.toBe(registered.token);
    expect(result).not.toHaveProperty('secret');
    expect(await h.tokens.verify(result.token)).toMatchObject({
      agentId: registered.agentId,
      role: 'agent',
      workspaceId: 'default',
    });

    const events = h.repos.events.list({ aggregateId: `account:${registered.agentId}` });
    expect(events.map((event) => event.type)).toEqual([
      'account.registered',
      'account.authenticated',
    ]);
    expect(events[1]?.payload).toEqual({ agentId: registered.agentId, at: CLOCK });

    const state = replay(h, registered.agentId);
    expect(state.authenticationCount).toBe(1);
    expect(state.lastAuthenticatedAt).toBe(CLOCK);
  });

  it('also accepts an agentId, which wins over name', async () => {
    const h = makeHarness();
    const registered = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'alpha' }),
    );

    const other = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'beta' }),
    );
    const result = resultOf<AuthResult>(
      await h.call(METHODS.agent.authenticate, {
        agentId: registered.agentId,
        name: 'beta',
        secret: registered.secret,
      }),
    );

    expect(result.agentId).toBe(registered.agentId);
    expect(result.agentId).not.toBe(other.agentId);
  });

  it('rejects an unknown account with -32001 and requires an identifier', async () => {
    const h = makeHarness();

    const unknown = errorOf(
      await h.call(METHODS.agent.authenticate, { name: 'ghost', secret: 'whatever' }),
    );
    expect(unknown.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(unknown.message).toMatch(/unknown account/i);

    const missing = errorOf(await h.call(METHODS.agent.authenticate, {}));
    expect(missing.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(h.repos.events.count()).toBe(0);
  });
});

describe('agent.authenticate credential enforcement (security regression)', () => {
  async function registered(h: Harness): Promise<AuthResult> {
    return resultOf<AuthResult>(await h.call(METHODS.agent.register, { name: 'alpha' }));
  }

  it('refuses name-only and agentId-only calls with -32001 (no privilege escalation)', async () => {
    const h = makeHarness();
    const account = await registered(h);

    const byName = errorOf(await h.call(METHODS.agent.authenticate, { name: 'alpha' }));
    expect(byName.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(byName.data).toEqual({ reason: 'invalid_credentials' });

    const byId = errorOf(
      await h.call(METHODS.agent.authenticate, { agentId: account.agentId }),
    );
    expect(byId.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(byId.data).toEqual({ reason: 'invalid_credentials' });

    // No token is minted and no authentication event is written.
    expect(h.repos.events.list({ type: 'account.authenticated' })).toHaveLength(0);
  });

  it('rejects a wrong or empty secret with -32001', async () => {
    const h = makeHarness();
    await registered(h);

    for (const secret of ['nope', '', 'x'.repeat(43), 'x'.repeat(513)]) {
      const error = errorOf(
        await h.call(METHODS.agent.authenticate, { name: 'alpha', secret }),
      );
      // Over-long input is a params error; anything else is a credential failure.
      expect([JsonRpcErrorCode.Unauthorized, JsonRpcErrorCode.InvalidParams]).toContain(
        error.code,
      );
      if (error.code === JsonRpcErrorCode.Unauthorized) {
        expect(error.data).toEqual({ reason: 'invalid_credentials' });
      }
    }
    expect(h.repos.events.list({ type: 'account.authenticated' })).toHaveLength(0);
  });

  it('rejects a secret belonging to a different account', async () => {
    const h = makeHarness();
    await registered(h);
    const beta = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'beta' }),
    );

    const error = errorOf(
      await h.call(METHODS.agent.authenticate, {
        name: 'alpha',
        secret: beta.secret,
      }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.data).toEqual({ reason: 'invalid_credentials' });
  });

  it('accepts the issued secret and never echoes it again', async () => {
    const h = makeHarness();
    const account = await registered(h);

    const outcome = await h.call(METHODS.agent.authenticate, {
      agentId: account.agentId,
      secret: account.secret,
    });
    const result = resultOf<AuthResult>(outcome);

    expect(result.agentId).toBe(account.agentId);
    expect(typeof result.token).toBe('string');
    expect(JSON.stringify(outcome.response)).not.toContain(account.secret as string);
    expect(JSON.stringify(outcome.response)).not.toContain(
      h.repos.accounts.getSecretHash(account.agentId) as string,
    );
  });
});

describe('agent.list authorisation', () => {
  async function seed(h: Harness): Promise<{
    agent: AuthResult;
    observer: AuthResult;
    admin: AuthResult;
  }> {
    const agent = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'worker', skills: ['sql'] }),
    );
    const observer = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'watcher', role: 'observer' }),
    );
    const admin = resultOf<AuthResult>(
      await h.call(METHODS.agent.register, { name: 'boss', role: 'admin' }),
    );
    return { agent, observer, admin };
  }

  it('requires a token (-32001 without one)', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    await seed(h);

    const error = errorOf(await h.call(METHODS.agent.list, {}));
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.message).toMatch(/authentication required/i);
  });

  it('rejects an observer with -32002', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { observer } = await seed(h);

    const error = errorOf(
      await h.call(METHODS.agent.list, {}, { token: observer.token }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data).toMatchObject({ role: 'observer' });
  });

  it('lets agent and admin read the roster without leaking credentials', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { agent, admin } = await seed(h);

    for (const identity of [agent, admin]) {
      const roster = resultOf<RosterResult>(
        await h.call(METHODS.agent.list, {}, { token: identity.token }),
      );
      expect(roster.total).toBe(3);
      expect(roster.accounts.map((entry) => entry.name)).toEqual([
        'worker',
        'watcher',
        'boss',
      ]);
      for (const entry of roster.accounts) {
        expect(entry).not.toHaveProperty('token');
        expect(Object.keys(entry).sort()).toEqual(
          ['agentId', 'createdAt', 'name', 'owner', 'role', 'skills'].sort(),
        );
      }
    }
  });

  it('filters by role and paginates', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { admin } = await seed(h);

    const observers = resultOf<RosterResult>(
      await h.call(
        METHODS.agent.list,
        { role: 'observer' },
        { token: admin.token },
      ),
    );
    expect(observers.total).toBe(1);
    expect(observers.accounts.map((entry) => entry.name)).toEqual(['watcher']);

    const page = resultOf<RosterResult>(
      await h.call(METHODS.agent.list, { limit: 1, offset: 1 }, { token: admin.token }),
    );
    expect(page.accounts).toHaveLength(1);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);
    expect(page.total).toBe(3);

    const badRole = errorOf(
      await h.call(METHODS.agent.list, { role: 'root' }, { token: admin.token }),
    );
    expect(badRole.code).toBe(JsonRpcErrorCode.InvalidParams);

    const badLimit = errorOf(
      await h.call(METHODS.agent.list, { limit: 0 }, { token: admin.token }),
    );
    expect(badLimit.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('applies offset without a limit', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { admin } = await seed(h);

    const all = resultOf<RosterResult>(
      await h.call(METHODS.agent.list, {}, { token: admin.token }),
    );
    const tail = resultOf<RosterResult>(
      await h.call(METHODS.agent.list, { offset: 1 }, { token: admin.token }),
    );

    expect(tail.offset).toBe(1);
    expect(tail.limit).toBeNull();
    expect(tail.accounts.map((entry) => entry.name)).toEqual(
      all.accounts.slice(1).map((entry) => entry.name),
    );
    expect(tail.total).toBe(3);

    const past = resultOf<RosterResult>(
      await h.call(METHODS.agent.list, { offset: 99 }, { token: admin.token }),
    );
    expect(past.accounts).toEqual([]);
    expect(past.total).toBe(3);
  });

  it('pins the roster to the token workspace; a spoofed X-Workspace-Id is ignored', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { admin } = await seed(h);

    // Another tenant's account: must never appear in a `default` token's roster.
    h.repos.accounts.create({ id: 'agt_evil', name: 'intruder', workspaceId: 'other-ws' });

    const roster = resultOf<RosterResult>(
      await h.call(
        METHODS.agent.list,
        {},
        { token: admin.token, workspaceId: 'other-ws' },
      ),
    );

    expect(roster.total).toBe(3);
    expect(roster.accounts.map((entry) => entry.name)).toEqual([
      'worker',
      'watcher',
      'boss',
    ]);
    expect(roster.accounts.map((entry) => entry.name)).not.toContain('intruder');

    const claims = await h.tokens.verify(admin.token);
    expect(claims.workspaceId).toBe('default');
  });

  it('keeps the plaintext secret out of the roster and every event payload', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { admin, agent } = await seed(h);

    const rosterOutcome = await h.call(METHODS.agent.list, {}, { token: admin.token });
    const roster = resultOf<RosterResult>(rosterOutcome);
    const serialized = JSON.stringify(rosterOutcome.response);
    for (const entry of roster.accounts) {
      expect(entry).not.toHaveProperty('secret');
      expect(entry).not.toHaveProperty('secretHash');
      expect(entry).not.toHaveProperty('secret_hash');
    }
    expect(serialized).not.toMatch(/secret/i);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);

    // Domain events never carry the plaintext; the irreversible digest is
    // allowed on account.registered so replay can rebuild the credential.
    const events = h.repos.events.list({});
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain(agent.secret as string);
      expect(payload).not.toHaveProperty('secret');
      expect(payload).not.toHaveProperty('secret_hash');
      if ('secretHash' in payload) {
        expect(payload.secretHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it('accepts params.token and rejects an invalid token with -32001', async () => {
    const h = makeHarness({ allowAdminSelfRegister: true });
    const { agent } = await seed(h);

    const viaParams = resultOf<RosterResult>(
      await h.call(METHODS.agent.list, { token: agent.token }),
    );
    expect(viaParams.total).toBe(3);

    const error = errorOf(await h.call(METHODS.agent.list, {}, { token: 'garbage' }));
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(error.data).toMatchObject({ reason: 'invalid_token' });
  });
});

describe('HTTP transport wiring', () => {
  it('accepts Authorization: Bearer and enforces roles over POST /rpc', async () => {
    const { db, repos } = openStore(':memory:');
    const app = buildServer({
      config: testConfig(),
      logger: silentLogger(),
      store: { db, repos },
    });
    apps.push(app);

    const register = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: METHODS.agent.register,
        params: { name: 'worker', skills: ['ts'] },
      },
    });
    expect(register.statusCode).toBe(200);
    const worker = register.json() as { result: AuthResult };
    expect(worker.result.role).toBe('agent');

    const observer = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: METHODS.agent.register,
        params: { name: 'watcher', role: 'observer' },
      },
    });
    const observerToken = (observer.json() as { result: AuthResult }).result.token;

    const allowed = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${worker.result.token}` },
      payload: { jsonrpc: '2.0', id: 3, method: METHODS.agent.list, params: {} },
    });
    expect(allowed.statusCode).toBe(200);
    expect((allowed.json() as { result: RosterResult }).result.total).toBe(2);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${observerToken}` },
      payload: { jsonrpc: '2.0', id: 4, method: METHODS.agent.list, params: {} },
    });
    expect(forbidden.statusCode).toBe(200);
    expect(forbidden.json()).toMatchObject({
      id: 4,
      error: { code: JsonRpcErrorCode.Forbidden },
    });

    const anonymous = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { jsonrpc: '2.0', id: 5, method: METHODS.agent.list, params: {} },
    });
    expect(anonymous.json()).toMatchObject({
      id: 5,
      error: { code: JsonRpcErrorCode.Unauthorized },
    });
  });

  it('enforces credentials and ignores X-Workspace-Id over HTTP', async () => {
    const { db, repos } = openStore(':memory:');
    const app = buildServer({
      config: testConfig(),
      logger: silentLogger(),
      store: { db, repos },
    });
    apps.push(app);

    const register = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: METHODS.agent.register,
        params: { name: 'worker' },
      },
    });
    const worker = (register.json() as { result: AuthResult }).result;
    expect(typeof worker.secret).toBe('string');

    // Name-only login over HTTP must not mint a token.
    const anonymous = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: METHODS.agent.authenticate,
        params: { name: 'worker' },
      },
    });
    expect(anonymous.json()).toMatchObject({
      id: 2,
      error: { code: JsonRpcErrorCode.Unauthorized, data: { reason: 'invalid_credentials' } },
    });

    const authenticated = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: METHODS.agent.authenticate,
        params: { name: 'worker', secret: worker.secret },
      },
    });
    const refreshed = (authenticated.json() as { result: AuthResult }).result;
    expect(refreshed.agentId).toBe(worker.agentId);
    expect(refreshed).not.toHaveProperty('secret');

    // Spoofed tenant header cannot widen a `default` token's roster.
    repos.accounts.create({ id: 'agt_evil', name: 'intruder', workspaceId: 'other-ws' });
    const spoofed = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: {
        authorization: `Bearer ${worker.token}`,
        'x-workspace-id': 'other-ws',
      },
      payload: { jsonrpc: '2.0', id: 4, method: METHODS.agent.list, params: {} },
    });
    const roster = (spoofed.json() as { result: RosterResult }).result;
    expect(roster.total).toBe(1);
    expect(roster.accounts.map((entry) => entry.name)).toEqual(['worker']);
  });

  it('exposes the account module and store on the fastify instance', () => {
    const { db, repos } = openStore(':memory:');
    const app = buildServer({
      config: testConfig(),
      logger: silentLogger(),
      store: { db, repos },
    });
    apps.push(app);

    expect(app.registry.listMethods()).toEqual([
      METHODS.agent.authenticate,
      METHODS.agent.list,
      METHODS.agent.register,
      // US-007 registers alongside the account module whenever a store is wired.
      METHODS.channel.create,
      METHODS.channel.join,
      METHODS.channel.leave,
      METHODS.channel.list,
      METHODS.message.history,
      METHODS.message.send,
      // US-020 system module (registers when store is wired).
      METHODS.system.subscribe,
      // US-008 / US-009 register the task lifecycle methods alongside them.
      METHODS.task.award,
      METHODS.task.bid,
      METHODS.task.bids,
      METHODS.task.cancel,
      METHODS.task.complete,
      METHODS.task.fail,
      METHODS.task.get,
      METHODS.task.list,
      METHODS.task.progress,
      METHODS.task.publish,
      METHODS.task.reassign,
      METHODS.task.review,
    ]);
    expect(app.accounts).toBeInstanceOf(AccountsService);
    expect(app.store?.db).toBe(db);
    expect(typeof app.tokens.verify).toBe('function');
  });

  it('keeps the transport-only build free of feature modules', () => {
    const app = buildServer({ config: testConfig(), logger: silentLogger() });
    apps.push(app);

    expect(app.registry.listMethods()).toEqual([]);
    expect(app.accounts).toBeUndefined();
    expect(app.store).toBeUndefined();
  });
});

describe('seedAdmin (local bootstrap)', () => {
  it('creates an admin idempotently without the self-register flag', async () => {
    const h = makeHarness(); // ALLOW_ADMIN_SELF_REGISTER stays false
    const first = h.service.seedAdmin({ name: 'root', owner: 'ops' });
    expect(first.created).toBe(true);
    expect(first.role).toBe('admin');
    expect(first.secret).toBeTruthy();
    expect(h.repos.accounts.count()).toBe(1);
    expect(h.events.count('default')).toBe(1);

    const second = h.service.seedAdmin({ name: 'root' });
    expect(second.created).toBe(false);
    expect(second.agentId).toBe(first.agentId);
    expect(second.secret).toBeUndefined();
    expect(h.repos.accounts.count()).toBe(1);
    expect(h.events.count('default')).toBe(1); // no second account.registered

    const authenticated = await h.service.authenticate({
      name: 'root',
      secret: first.secret ?? '',
    });
    expect(authenticated.role).toBe('admin');
  });

  it('replays the seeded admin credential hash from account.registered', () => {
    const h = makeHarness();
    const seeded = h.service.seedAdmin({ name: 'root', owner: 'ops' });
    const aggregateId = `account:${seeded.agentId}`;
    const replayed = replayAggregate(
      h.events,
      aggregateId,
      accountReducer,
      initialAccountState(aggregateId),
    );
    const storedHash = h.repos.accounts.getSecretHash(seeded.agentId);

    expect(storedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(replayed.state.secretHash).toBe(storedHash);
    expect(secretHashMatches(seeded.secret ?? '', replayed.state.secretHash)).toBe(true);
  });

  it('replays a normally registered account credential hash', async () => {
    const h = makeHarness();
    const registered = await h.service.register({ name: 'worker' });
    const aggregateId = `account:${registered.agentId}`;
    const replayed = replayAggregate(
      h.events,
      aggregateId,
      accountReducer,
      initialAccountState(aggregateId),
    );
    const storedHash = h.repos.accounts.getSecretHash(registered.agentId);

    expect(replayed.state.secretHash).toBe(storedHash);
    expect(secretHashMatches(registered.secret, replayed.state.secretHash)).toBe(true);
  });

  it('replays a legacy registration without secretHash and refuses credentials', async () => {
    const h = makeHarness();
    const id = 'agt_legacy';
    h.repos.accounts.create({ id, name: 'legacy', createdAt: CLOCK, workspaceId: 'default' });
    h.events.append({
      aggregateId: `account:${id}`,
      type: 'account.registered',
      payload: { name: 'legacy', role: 'agent' },
      ts: CLOCK,
      workspaceId: 'default',
    });

    const aggregateId = `account:${id}`;
    const replayed = replayAggregate(
      h.events,
      aggregateId,
      accountReducer,
      initialAccountState(aggregateId),
    );
    expect(replayed.state.secretHash).toBeNull();

    await expect(
      h.service.authenticate({ name: 'legacy', secret: 'anything' }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Unauthorized });
  });

  it('refuses to reuse a name owned by a non-admin', async () => {
    const h = makeHarness();
    await h.service.register({ name: 'worker' });
    expect(() => h.service.seedAdmin({ name: 'worker' })).toThrow(/already exists/);
    expect(h.repos.accounts.count()).toBe(1);
  });

  it('seed CLI is idempotent and prints the secret exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-seed-'));
    const dbPath = join(dir, 'agentmesh.db');
    const config = testConfig({ dbPath });
    try {
      const firstOut: string[] = [];
      const firstErr: string[] = [];
      expect(
        runSeedAdmin(['--name', 'root', '--owner', 'ops'], {
          config,
          stdout: (line) => firstOut.push(line),
          stderr: (line) => firstErr.push(line),
        }),
      ).toBe(0);
      expect(firstErr).toEqual([]);
      expect(firstOut.join('\n')).toContain('admin created');
      expect(firstOut.join('\n')).toContain('secret: ');

      const secondOut: string[] = [];
      const secondErr: string[] = [];
      expect(
        runSeedAdmin(['--name=root'], {
          config,
          stdout: (line) => secondOut.push(line),
          stderr: (line) => secondErr.push(line),
        }),
      ).toBe(0);
      expect(secondErr).toEqual([]);
      expect(secondOut.join('\n')).toContain('admin already exists');
      expect(secondOut.join('\n')).not.toContain('secret: ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('anonymous registration throttling', () => {
  it('bounds its tracked remote addresses', () => {
    const limiter = new RegistrationLimiter({ maxEntries: 3, clock: () => 1_000 });
    for (let i = 0; i < 20; i += 1) limiter.check(`10.0.0.${i}`);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  it('keeps an active address while one-shot addresses flood in (LRU)', () => {
    const limiter = new RegistrationLimiter({ maxEntries: 2, clock: () => 1_000 });
    limiter.check('active');

    for (let i = 0; i < 10; i += 1) {
      limiter.check('active');
      limiter.check(`10.1.0.${i}`);
    }

    expect(limiter.has('active')).toBe(true);
  });

  it('limits attempts per remote address and leaves other addresses alone', async () => {
    const h = makeHarness({ registerRateLimit: { max: 2, windowMs: 60_000 } });

    await h.service.register({ name: 'a1' }, { remoteAddress: '10.0.0.1' });
    await h.service.register({ name: 'a2' }, { remoteAddress: '10.0.0.1' });
    await expect(
      h.service.register({ name: 'a3' }, { remoteAddress: '10.0.0.1' }),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'too_many_registrations' },
    });

    await expect(
      h.service.register({ name: 'b1' }, { remoteAddress: '10.0.0.2' }),
    ).resolves.toMatchObject({ role: 'agent' });
    expect(h.repos.accounts.count()).toBe(3);
  });
});

describe('account ids', () => {
  it('prefixes generated ids with agt_ and falls back to a random uuid', async () => {
    const { db, repos } = openStore(':memory:');
    const events = new EventStore(db);
    const tokens = createTokenService({ secret: SECRET });
    const registry = createHandlerRegistry();
    const service = registerAccountsModule(registry, {
      db,
      accounts: repos.accounts,
      events,
      tokens,
    });

    const first = await service.register({ name: 'one' });
    const second = await service.register({ name: 'two' });

    expect(first.agentId).toMatch(/^agt_[0-9a-f-]{36}$/);
    expect(second.agentId).not.toBe(first.agentId);
  });
});
