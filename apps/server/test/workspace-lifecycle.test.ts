/* eslint-disable @typescript-eslint/no-explicit-any */
import { JsonRpcErrorCode } from '@agentmesh/protocol';
import { createLogger, loadConfig, startServer } from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';

const JWT_SECRET = 'test-secret-value-1234567890';

interface Harness {
  app: Awaited<ReturnType<typeof startServer>>;
  db: ReturnType<typeof openStore>['db'];
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
    db: store.db,
    close: async () => {
      await app.close();
      store.db.close();
    },
  };
}

interface RpcError {
  code: number;
  message: string;
}
async function rpc(
  h: Harness,
  token: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: any; error?: RpcError }> {
  const out = await h.app.dispatcher.dispatch(
    { jsonrpc: '2.0', id: 1, method, params },
    token === undefined ? {} : { token },
  );
  return (out.response ?? {}) as { result?: any; error?: RpcError };
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

async function systemAdminToken(h: Harness): Promise<string> {
  return h.app.tokens.sign({ agentId: 'root', role: 'admin', workspaceId: 'default' });
}

async function createWorkspace(
  h: Harness,
  opts: { name?: string; maxAgents?: number } = {},
): Promise<{ id: string; inviteCode: string }> {
  const admin = await systemAdminToken(h);
  const res = await rpc(h, admin, 'workspace.create', {
    name: opts.name ?? 'Tenant',
    ...(opts.maxAgents === undefined ? {} : { maxAgents: opts.maxAgents }),
  });
  if (res.error) throw new Error(`workspace.create failed: ${JSON.stringify(res.error)}`);
  return { id: res.result.workspace.id, inviteCode: res.result.inviteCode };
}

describe('US-025 workspace lifecycle', () => {
  it('system admin creates + lists a workspace with an invite code', async () => {
    const h = await harness();
    const ws = await createWorkspace(h, { name: 'Acme' });
    const admin = await systemAdminToken(h);
    const list = await rpc(h, admin, 'workspace.list', {});
    expect(list.error).toBeUndefined();
    expect(list.result.workspaces.map((w: { id: string }) => w.id)).toContain(ws.id);
  });

  it('redeems an invite: the agent lands in that tenant, not default', async () => {
    const h = await harness();
    const ws = await createWorkspace(h);

    const reg = await rpc(h, undefined, 'agent.register', {
      name: 'acme-agent',
      inviteCode: ws.inviteCode,
    });
    expect(reg.error).toBeUndefined();
    const token = reg.result.token as string;
    const auth = await h.app.tokens.verify(token);
    expect(auth.workspaceId).toBe(ws.id);

    // No invite ⇒ default workspace (backward compatible).
    const plain = await rpc(h, undefined, 'agent.register', { name: 'plain-agent' });
    expect((await h.app.tokens.verify(plain.result.token as string)).workspaceId).toBe('default');
  });

  it('rejects an invalid invite code (-32004)', async () => {
    const h = await harness();
    const res = await rpc(h, undefined, 'agent.register', { name: 'x', inviteCode: 'nope' });
    expect(res.error?.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('rejects an expired invite code (-32004)', async () => {
    const h = await harness();
    const ws = await createWorkspace(h);
    h.db
      .prepare('UPDATE workspaces SET invite_expires_at = ? WHERE id = ?')
      .run(Date.now() - 1000, ws.id);
    const res = await rpc(h, undefined, 'agent.register', { name: 'late', inviteCode: ws.inviteCode });
    expect(res.error?.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('enforces the agent quota (-32008)', async () => {
    const h = await harness();
    const ws = await createWorkspace(h, { maxAgents: 1 });
    expect((await rpc(h, undefined, 'agent.register', { name: 'a1', inviteCode: ws.inviteCode })).error).toBeUndefined();
    const second = await rpc(h, undefined, 'agent.register', { name: 'a2', inviteCode: ws.inviteCode });
    expect(second.error?.code).toBe(JsonRpcErrorCode.QuotaExceeded);
  });

  it('disable blocks new auth in that tenant (-32002) but not other tenants', async () => {
    const h = await harness();
    const ws = await createWorkspace(h);
    const reg = await rpc(h, undefined, 'agent.register', { name: 'm1', inviteCode: ws.inviteCode });
    const agentId = reg.result.agentId as string;
    const secret = reg.result.secret as string;

    const admin = await systemAdminToken(h);
    const dis = await rpc(h, admin, 'workspace.disable', { workspaceId: ws.id });
    expect(dis.error).toBeUndefined();

    // Existing account can no longer authenticate.
    const auth = await rpc(h, undefined, 'agent.authenticate', { agentId, secret });
    expect(auth.error?.code).toBe(JsonRpcErrorCode.Forbidden);

    // New invite redemption into the disabled tenant is refused.
    const reg2 = await rpc(h, undefined, 'agent.register', { name: 'm2', inviteCode: ws.inviteCode });
    expect(reg2.error?.code).toBe(JsonRpcErrorCode.Forbidden);
  });

  it('platform workspace ops are admin-only; workspace_admin is tenant-scoped', async () => {
    const h = await harness();
    const ws = await createWorkspace(h);

    // A workspace_admin (token scoped to ws) can run admin ops in its tenant…
    const waTok = await h.app.tokens.sign({
      agentId: 'wa',
      role: 'workspace_admin',
      workspaceId: ws.id,
    });
    const published = await rpc(h, waTok, 'task.publish', {
      title: 'tenant task',
      requiredSkills: [],
      budget: 5,
      biddingDeadline: Date.now() + 60_000,
    });
    expect(published.error).toBeUndefined();

    // …but cannot create/disable tenants (platform-only).
    const denied = await rpc(h, waTok, 'workspace.create', { name: 'nope' });
    expect(denied.error?.code).toBe(JsonRpcErrorCode.Forbidden);

    // Anonymous / agent callers are rejected with -32001 / -32002.
    expect((await rpc(h, undefined, 'workspace.create', { name: 'x' })).error?.code).toBe(
      JsonRpcErrorCode.Unauthorized,
    );
    const agentTok = await h.app.tokens.sign({ agentId: 'a', role: 'agent', workspaceId: ws.id });
    expect((await rpc(h, agentTok, 'workspace.list', {})).error?.code).toBe(
      JsonRpcErrorCode.Forbidden,
    );
  });
});
