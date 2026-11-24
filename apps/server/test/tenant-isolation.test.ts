import { JsonRpcErrorCode } from '@agentmesh/protocol';
import { createLogger, loadConfig, startServer } from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';

const JWT_SECRET = 'test-secret-value-1234567890';

interface Harness {
  app: Awaited<ReturnType<typeof startServer>>;
  close: () => Promise<void>;
}

async function makeServer(): Promise<Harness> {
  const store = openStore(':memory:');
  const app = await startServer({
    config: loadConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: ':memory:',
      JWT_SECRET,
      LOG_LEVEL: 'silent',
      ALLOW_ADMIN_SELF_REGISTER: 'true',
    }),
    logger: createLogger({ level: 'silent' }),
    store: { db: store.db, repos: store.repos },
  });
  return {
    app,
    close: async () => {
      await app.close();
      store.db.close();
    },
  };
}

/** Dispatch one JSON-RPC request as `token`'s identity; return {result|error}. */
async function rpc(
  h: Harness,
  token: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const out = await h.app.dispatcher.dispatch(
    { jsonrpc: '2.0', id: 1, method, params },
    { token },
  );
  return (out.response ?? {}) as { result?: unknown; error?: { code: number; message: string } };
}

const closers: Harness[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.close();
});

async function harness(): Promise<Harness> {
  const h = await makeServer();
  closers.push(h);
  return h;
}

describe('multi-tenant RPC isolation (US-023)', () => {
  it('scopes every RPC to the token workspace; cross-tenant reads are -32004', async () => {
    const h = await harness();
    const defaultAdmin = await h.app.tokens.sign({
      agentId: 'agt_root',
      role: 'admin',
      workspaceId: 'default',
    });
    const otherAdmin = await h.app.tokens.sign({
      agentId: 'agt_other',
      role: 'admin',
      workspaceId: 'ws-b',
    });

    // Seed data in the `default` workspace using the default admin.
    const published = await rpc(h, defaultAdmin, 'task.publish', {
      title: 'tenant test task',
      requiredSkills: ['x'],
      budget: 10,
      biddingDeadline: Date.now() + 60_000,
    });
    expect(published.error).toBeUndefined();
    const taskId = (published.result as { task: { id: string } }).task.id;

    const created = await rpc(h, defaultAdmin, 'channel.create', { name: 'tenant-chan' });
    expect(created.error).toBeUndefined();
    const channelId = (created.result as { channel: { channelId: string } }).channel.channelId;

    const sent = await rpc(h, defaultAdmin, 'message.send', { channelId, body: 'hello' });
    expect(sent.error).toBeUndefined();

    // Positive: the default admin sees its own data.
    expect((await rpc(h, defaultAdmin, 'task.get', { taskId })).error).toBeUndefined();
    const defaultChannels = (await rpc(h, defaultAdmin, 'channel.list', {})).result as {
      channels: unknown[];
    };
    expect(defaultChannels.channels).toHaveLength(1);

    // Negative: a ws-b admin cannot see or touch default-workspace resources.
    expect((await rpc(h, otherAdmin, 'task.get', { taskId })).error?.code).toBe(
      JsonRpcErrorCode.NotFound,
    );
    const otherChannels = (await rpc(h, otherAdmin, 'channel.list', {})).result as {
      channels: unknown[];
    };
    expect(otherChannels.channels).toHaveLength(0);
    expect((await rpc(h, otherAdmin, 'message.history', { channelId })).error?.code).toBe(
      JsonRpcErrorCode.NotFound,
    );
    expect((await rpc(h, otherAdmin, 'channel.join', { channelId })).error?.code).toBe(
      JsonRpcErrorCode.NotFound,
    );
  });

  it('a ws-b admin creates channels in ws-b, not in default', async () => {
    const h = await harness();
    const defaultAdmin = await h.app.tokens.sign({
      agentId: 'agt_root',
      role: 'admin',
      workspaceId: 'default',
    });
    const otherAdmin = await h.app.tokens.sign({
      agentId: 'agt_other',
      role: 'admin',
      workspaceId: 'ws-b',
    });

    const createdB = await rpc(h, otherAdmin, 'channel.create', { name: 'ws-b-chan' });
    expect(createdB.error).toBeUndefined();

    expect(
      ((await rpc(h, defaultAdmin, 'channel.list', {})).result as { channels: unknown[] }).channels,
    ).toHaveLength(0);
    expect(
      ((await rpc(h, otherAdmin, 'channel.list', {})).result as { channels: unknown[] }).channels,
    ).toHaveLength(1);
  });

  it('agent.revokeToken rejects a token from another workspace (-32002)', async () => {
    const h = await harness();
    const defaultAdmin = await h.app.tokens.sign({
      agentId: 'agt_root',
      role: 'admin',
      workspaceId: 'default',
    });
    const otherAdmin = await h.app.tokens.sign({
      agentId: 'agt_other',
      role: 'admin',
      workspaceId: 'ws-b',
    });
    const target = await h.app.tokens.sign({
      agentId: 'agt_victim',
      role: 'agent',
      workspaceId: 'default',
    });

    const cross = await rpc(h, otherAdmin, 'agent.revokeToken', { targetToken: target });
    expect(cross.error?.code).toBe(JsonRpcErrorCode.Forbidden);

    // Same-workspace admin can revoke it.
    const same = await rpc(h, defaultAdmin, 'agent.revokeToken', { targetToken: target });
    expect(same.error).toBeUndefined();
  });

  it('system.subscribe is admin-only (-32002 for agents)', async () => {
    const h = await harness();
    const agent = await h.app.tokens.sign({ agentId: 'agt_a', role: 'agent' });
    const denied = await rpc(h, agent, 'system.subscribe', { includeDomainEvents: true });
    expect(denied.error?.code).toBe(JsonRpcErrorCode.Forbidden);
  });

  it('default workspace stays backward compatible (self-register + use)', async () => {
    const h = await harness();
    // Unauthenticated register lands in the default workspace and works.
    const reg = await h.app.dispatcher.dispatch(
      { jsonrpc: '2.0', id: 1, method: 'agent.register', params: { name: 'newbie' } },
      {},
    );
    expect(reg.response?.error).toBeUndefined();
  });
});
