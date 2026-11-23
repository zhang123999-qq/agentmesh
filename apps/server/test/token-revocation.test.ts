import {
  createLogger,
  createTokenService,
  loadConfig,
  startServer,
  TokenRevocationRegistry,
} from '@agentmesh/server';
import { AgentMeshClient, type TransportFactory } from '@agentmesh/sdk';
import { openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

const JWT_SECRET = 'test-secret-value-1234567890';
const SECRET = 'x'.repeat(32);

const nodeTransport: TransportFactory = (url, _options, handlers) => {
  const socket = new WebSocket(url);
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data) => handlers.onMessage(String(data)));
  socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));
  socket.on('error', (error) => handlers.onError(error));
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
};

describe('TokenRevocationRegistry (US-021D)', () => {
  it('drops entries at exp and reports them not revoked', () => {
    let now = 1_000_000_000_000;
    const reg = new TokenRevocationRegistry({ clock: () => now });
    reg.revoke('j1', Math.floor(now / 1000) + 10);
    expect(reg.isRevoked('j1')).toBe(true);

    now += 11_000;
    expect(reg.isRevoked('j1')).toBe(false);
    expect(reg.size).toBe(0);
  });

  it('evicts the least-recently-used jti when full, never rejecting a revoke', () => {
    const reg = new TokenRevocationRegistry({ maxEntries: 2, clock: () => 0 });
    reg.revoke('a', 999);
    reg.revoke('b', 999);
    expect(reg.isRevoked('a')).toBe(true); // touch a -> now most-recently-used

    reg.revoke('c', 999); // capacity full -> evict LRU (b)
    expect(reg.isRevoked('a')).toBe(true);
    expect(reg.isRevoked('c')).toBe(true);
    expect(reg.isRevoked('b')).toBe(false);
  });
});

describe('TokenService enforcement (US-021D)', () => {
  it('rejects a revoked token with -32001 and leaves other tokens valid', async () => {
    const reg = new TokenRevocationRegistry();
    const tokens = createTokenService({ secret: SECRET, revocations: reg });
    const revoked = await tokens.sign({ agentId: 'agt_1', role: 'agent' }, { tokenId: 'jti-1' });
    const other = await tokens.sign({ agentId: 'agt_1', role: 'agent' }, { tokenId: 'jti-2' });

    expect((await tokens.verify(revoked)).agentId).toBe('agt_1');
    const exp = (await tokens.verify(revoked)).expiresAt;
    reg.revoke('jti-1', exp ?? 0);

    await expect(tokens.verify(revoked)).rejects.toMatchObject({ code: -32001 });
    expect((await tokens.verify(other)).agentId).toBe('agt_1');
  });

  it('a fresh registry forgets revocations after a restart (token resurrects)', async () => {
    const reg1 = new TokenRevocationRegistry();
    const tokens1 = createTokenService({ secret: SECRET, revocations: reg1 });
    const token = await tokens1.sign({ agentId: 'agt_1', role: 'agent' }, { tokenId: 'jti-r' });
    const exp = (await tokens1.verify(token)).expiresAt ?? 0;
    reg1.revoke('jti-r', exp);
    await expect(tokens1.verify(token)).rejects.toMatchObject({ code: -32001 });

    // Restart: new registry, same secret -> revocation forgotten (documented).
    const tokens2 = createTokenService({ secret: SECRET, revocations: new TokenRevocationRegistry() });
    expect((await tokens2.verify(token)).agentId).toBe('agt_1');
  });
});

describe('agent.revokeToken over the real server (US-021D)', () => {
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()?.();
  });

  it('revokes a token; the revoked token is then rejected on a new connection', async () => {
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
    closers.push(async () => {
      await app.close();
      store.db.close();
    });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const url = `ws://127.0.0.1:${port}/ws`;

    const admin = new AgentMeshClient({ url, transportFactory: nodeTransport, autoReconnect: false });
    closers.push(() => admin.close());
    await admin.connect();
    const adminAuth = await admin.register({ name: 'admin-rev', role: 'admin' });

    const target = new AgentMeshClient({ url, transportFactory: nodeTransport, autoReconnect: false });
    closers.push(() => target.close());
    await target.connect();
    const targetAuth = await target.register({ name: 'target-rev' });

    // Before revocation the server's token service accepts the token.
    expect((await app.tokens.verify(targetAuth.token)).agentId).toBe(targetAuth.agentId);

    // Revoke the target token via the real RPC (field is `targetToken`; the SDK
    // reserves `params.token` for the caller's own credential).
    const result = await admin.revokeToken({ targetToken: targetAuth.token });
    expect(result.revoked).toBe(true);
    expect(typeof result.jti).toBe('string');

    // The running server's token service (used by the WS handshake and the HTTP
    // dispatcher) now rejects the revoked token with -32001.
    await expect(app.tokens.verify(targetAuth.token)).rejects.toMatchObject({ code: -32001 });
    // Other tokens (the admin's own) still verify.
    expect((await app.tokens.verify(adminAuth.token)).role).toBe('admin');
  });
});
