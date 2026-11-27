import { JsonRpcErrorCode, METHODS } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';

import { createTokenService } from '../src/auth/token.js';
import { RpcDispatcher, type DispatchContext } from '../src/dispatcher.js';
import { registerSystemModule } from '../src/modules/system.js';
import { createHandlerRegistry } from '../src/registry.js';
import type { WsGateway } from '../src/ws/gateway.js';
import type { WsSubscription } from '../src/ws/session.js';
import { silentLogger } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';

function makeHarness() {
  const calls: Array<{ sessionId: string; subscription: WsSubscription }> = [];
  const gateway = {
    setSessionSubscription: (sessionId: string, subscription: WsSubscription) => {
      calls.push({ sessionId, subscription });
    },
  } as unknown as WsGateway;

  const registry = createHandlerRegistry();
  registerSystemModule(registry, { gateway });
  const tokens = createTokenService({ secret: SECRET });
  const dispatcher = new RpcDispatcher({
    registry,
    logger: silentLogger(),
    tokenVerifier: (token) => tokens.verify(token),
  });

  return {
    calls,
    async call(params: unknown, ctx: DispatchContext = {}) {
      const outcome = await dispatcher.dispatch(
        { jsonrpc: '2.0', id: 1, method: METHODS.system.subscribe, params },
        ctx,
      );
      return (outcome.response ?? {}) as {
        result?: Record<string, unknown>;
        error?: { code: number };
      };
    },
  };
}

async function adminToken(): Promise<string> {
  return createTokenService({ secret: SECRET }).sign({
    agentId: 'agt_admin',
    role: 'admin',
    workspaceId: 'default',
  });
}

describe('system.subscribe handler', () => {
  it('marks the calling session and returns the applied subscription', async () => {
    const h = makeHarness();
    const token = await adminToken();
    const res = await h.call(
      { includeDomainEvents: true, types: ['message.created', 5, '', 'task.bid.placed'] },
      { token, session: { id: 'sess-1' } },
    );

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      subscribed: true,
      includeDomainEvents: true,
      types: ['message.created', 'task.bid.placed'],
    });
    expect(h.calls).toEqual([
      {
        sessionId: 'sess-1',
        subscription: {
          includeDomainEvents: true,
          types: ['message.created', 'task.bid.placed'],
        },
      },
    ]);
  });

  it('defaults to notifications only and replaces a prior subscription', async () => {
    const h = makeHarness();
    const token = await adminToken();

    await h.call({}, { token, session: { id: 'sess-2' } });
    await h.call({ includeDomainEvents: false }, { token, session: { id: 'sess-2' } });

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.subscription).toEqual({ includeDomainEvents: false, types: undefined });
    expect(h.calls[1]?.subscription).toEqual({ includeDomainEvents: false, types: undefined });
  });

  it('returns a result without touching the gateway on non-WS transports', async () => {
    const h = makeHarness();
    const token = await adminToken();

    const res = await h.call({ includeDomainEvents: true }, { token });
    expect(res.error).toBeUndefined();
    expect(res.result?.subscribed).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('is workspace-admin only: agents and anonymous callers are rejected', async () => {
    const h = makeHarness();
    const agent = await createTokenService({ secret: SECRET }).sign({
      agentId: 'agt_agent',
      role: 'agent',
      workspaceId: 'default',
    });

    const denied = await h.call({ includeDomainEvents: true }, { token: agent });
    expect(denied.error?.code).toBe(JsonRpcErrorCode.Forbidden);

    const anonymous = await h.call({ includeDomainEvents: true });
    expect(anonymous.error?.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(h.calls).toHaveLength(0);
  });
});
