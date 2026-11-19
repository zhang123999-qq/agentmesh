import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/app.js';
import { startServer } from '../src/index.js';
import { createLogger } from '../src/logging.js';
import { openStore } from '@agentmesh/store';
import { makeCapturingLogger, testConfig } from './helpers.js';

describe('log redaction', () => {
  it('never emits plaintext secrets, tokens or authorization headers', () => {
    const { logger, lines } = makeCapturingLogger('info');

    logger.info(
      {
        secret: 'plaintext-secret-value',
        token: 'bearer-token-value',
        password: 'user-password-value',
        secretHash: 'a'.repeat(64),
        nested: { secret: 'nested-secret-value' },
        req: { headers: { authorization: 'Bearer header-secret-value' } },
      },
      'security.redaction.test',
    );

    const output = JSON.stringify(lines[0]);
    for (const value of [
      'plaintext-secret-value',
      'bearer-token-value',
      'user-password-value',
      'nested-secret-value',
      'header-secret-value',
      'a'.repeat(64),
    ]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('[Redacted]');
  });

  it('keeps non-sensitive correlation fields intact', () => {
    const { logger, lines } = makeCapturingLogger('info');
    logger.info({ reqId: 'req-1', agentId: 'agt_1', method: 'task.list' }, 'ok');
    expect(lines[0]).toMatchObject({
      reqId: 'req-1',
      agentId: 'agt_1',
      method: 'task.list',
      msg: 'ok',
    });
    expect(createLogger({ level: 'silent' })).toBeDefined();
  });

  it('redacts request body/headers carried by an error object', () => {
    const { logger, lines } = makeCapturingLogger('error');
    logger.error(
      {
        err: {
          message: 'boom',
          body: { secret: 'error-body-secret-value' },
          request: { headers: { authorization: 'Bearer error-request-secret' } },
          payload: { secret: 'error-payload-secret-value' },
        },
      },
      'security.error.redaction',
    );
    const output = JSON.stringify(lines[0]);
    expect(output).not.toContain('error-body-secret-value');
    expect(output).not.toContain('error-request-secret');
    expect(output).not.toContain('error-payload-secret-value');
    expect(output).toContain('[Redacted]');
  });

  it('does not leak a failed authenticate secret into error logs', async () => {
    const { db, repos } = openStore(':memory:');
    const { logger, lines } = makeCapturingLogger('info');
    const app = buildServer({ config: testConfig(), logger, store: { db, repos } });
    try {
      const register = await app.inject({
        method: 'POST',
        url: '/rpc',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'agent.register',
          params: { name: 'alpha' },
        },
      });
      const registered = register.json() as {
        result?: { secret?: string; token?: string };
      };
      expect(registered.result?.secret).toBeTruthy();

      const wrongSecret = `wrong-secret-${'x'.repeat(20)}`;
      const authenticate = await app.inject({
        method: 'POST',
        url: '/rpc',
        payload: {
          jsonrpc: '2.0',
          id: 2,
          method: 'agent.authenticate',
          params: { name: 'alpha', secret: wrongSecret },
        },
      });
      expect(authenticate.json()).toMatchObject({ error: { code: -32001 } });

      const output = JSON.stringify(lines);
      expect(output).not.toContain(wrongSecret);
      expect(output).not.toContain(registered.result?.secret as string);
      expect(output).not.toContain(registered.result?.token as string);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('does not leak a rejected WebSocket handshake token into logs', async () => {
    const { db, repos } = openStore(':memory:');
    const { logger, lines } = makeCapturingLogger('info');
    const app = await startServer({
      config: testConfig({ port: 0, host: '127.0.0.1' }),
      logger,
      store: { db, repos },
    });
    try {
      const address = app.server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const badToken = `bad-token-${'y'.repeat(24)}`;
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
          headers: { authorization: `Bearer ${badToken}` },
        });
        const done = (): void => resolve();
        socket.once('close', done);
        socket.once('error', done);
      });

      const output = JSON.stringify(lines);
      expect(output).not.toContain(badToken);
    } finally {
      await app.close();
      db.close();
    }
  });
});
