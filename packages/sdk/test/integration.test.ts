import { createLogger, loadConfig, startServer } from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  AgentMeshClient,
  type TransportFactory,
} from '../src/index.js';
import { METHODS as _METHODS } from '@agentmesh/protocol';

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

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length > 0) {
    await closers.pop()?.();
  }
});

describe('SDK against the real server', () => {
  it('registers, joins a channel, sends a message and catches up via history', async () => {
    const { db, repos } = openStore(':memory:');
    const app = await startServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
        JWT_SECRET: 'test-secret-value-1234567890',
        LOG_LEVEL: 'silent',
      }),
      logger: createLogger({ level: 'silent' }),
      store: { db, repos },
    });
    closers.push(async () => {
      await app.close();
      db.close();
    });

    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const client = new AgentMeshClient({
      url: `ws://127.0.0.1:${port}/ws`,
      transportFactory: nodeTransport,
      autoReconnect: false,
    });
    closers.push(() => client.close());

    await client.connect();
    const auth = await client.register({ name: 'sdk-agent', skills: ['typescript'] });
    expect(auth.agentId).toMatch(/^agt_/);
    expect(auth.token.length).toBeGreaterThan(20);
    expect(client.state).toBe('connected');

    const created = await client.createChannel({ name: 'sdk-general' });
    const channelId = created.channel.channelId;
    const sent = await client.sendMessage({ channelId, body: 'hello from the sdk' });
    expect(sent.message.seq).toBeGreaterThan(0);

    const history = await client.history({ channelId, afterSeq: 0 });
    expect(history.messages.map((message) => message.body)).toContain(
      'hello from the sdk',
    );
    expect(history.channelTotal).toBeGreaterThanOrEqual(1);
    expect(history.messages[0]?.seq).toBe(sent.message.seq);
  }, 15_000);

  it('admin can subscribe to system events with includeDomainEvents', async () => {
    const { db, repos } = openStore(':memory:');
    const app = await startServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
        JWT_SECRET: 'test-secret-value-1234567890',
        LOG_LEVEL: 'silent',
        ALLOW_ADMIN_SELF_REGISTER: 'true',
      }),
      logger: createLogger({ level: 'silent' }),
      store: { db, repos },
    });
    closers.push(async () => {
      await app.close();
      db.close();
    });

    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const client = new AgentMeshClient({
      url: `ws://127.0.0.1:${port}/ws`,
      transportFactory: nodeTransport,
      autoReconnect: false,
    });
    closers.push(() => client.close());

    await client.connect();
    const adminAuth = await client.register({ name: 'admin-test', role: 'admin' });
    expect(adminAuth.role).toBe('admin');

    // Subscribe to system events with domain events
    const subResult = await client.subscribeSystem({
      includeDomainEvents: true,
      types: ['task.bid.placed', 'message.created'],
    });
    expect(subResult.subscribed).toBe(true);
    expect(subResult.includeDomainEvents).toBe(true);
    expect(subResult.types).toEqual(['task.bid.placed', 'message.created']);
  }, 15_000);
});
