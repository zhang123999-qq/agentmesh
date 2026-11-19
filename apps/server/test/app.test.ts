import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROTOCOL_VERSION,
  JsonRpcErrorCode,
  createJsonRpcRequest,
} from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../src/app.js';
import { createHandlerRegistry } from '../src/registry.js';
import { silentLogger, testConfig } from './helpers.js';

const apps: FastifyInstance[] = [];

function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('buildServer', () => {
  it('serves GET /health with status, version and uptime', async () => {
    const app = track(
      buildServer({
        config: testConfig({ version: '1.2.3' }),
        logger: silentLogger(),
        uptime: () => 12.5,
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({
      status: 'ok',
      version: '1.2.3',
      protocolVersion: PROTOCOL_VERSION,
      uptime: 12.5,
    });
  });

  it('dispatches a JSON-RPC request over POST /rpc', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.list', async (_ctx, params) => [
      { id: 'tsk_1', params },
    ]);
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger(), registry }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: createJsonRpcRequest('task.list', { limit: 5 }, 11),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 11,
      result: [{ id: 'tsk_1', params: { limit: 5 } }],
    });
  });

  it('answers a request whose id is null (JSON-RPC allows id:null)', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.echo', async (_ctx, params) => params);
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger(), registry }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { jsonrpc: '2.0', id: null, method: 'task.echo', params: { a: 1 } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: { a: 1 },
    });
  });

  it('replies 200 with -32600 for a structurally invalid frame', async () => {
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger() }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: JsonRpcErrorCode.InvalidRequest },
    });
  });

  it('forwards the x-agent-id header as the handler agentId', async () => {
    const registry = createHandlerRegistry();
    const handler = vi.fn(async (_ctx: { agentId?: string }) => 'ok');
    registry.registerHandler('agent.whoami', handler);
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger(), registry }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { 'x-agent-id': 'agt_header' },
      payload: createJsonRpcRequest('agent.whoami', {}, 1),
    });

    expect(response.statusCode).toBe(200);
    const ctx = handler.mock.calls[0]?.[0] as { agentId?: string } | undefined;
    expect(ctx?.agentId).toBe('agt_header');
  });

  it('returns a JSON-RPC -32601 error for an unknown method', async () => {
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger() }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: createJsonRpcRequest('task.unknown', {}, 2),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      error: { code: JsonRpcErrorCode.MethodNotFound },
    });
  });

  it('replies 204 to a notification', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('agent.heartbeat', async () => undefined);
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger(), registry }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { jsonrpc: '2.0', method: 'agent.heartbeat' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('exposes the registry and dispatcher for feature modules', () => {
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger() }),
    );

    expect(app.config.version).toBe(testConfig().version);
    expect(app.registry.listMethods()).toEqual([]);
    expect(typeof app.dispatcher.dispatch).toBe('function');
  });
});

describe('request size limit', () => {
  it('rejects a JSON-RPC body above the 1 MiB limit with 413', async () => {
    const app = track(
      buildServer({ config: testConfig(), logger: silentLogger() }),
    );
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'test.echo',
      params: { pad: 'x'.repeat(1_100_000) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { 'content-type': 'application/json' },
      payload,
    });

    expect(response.statusCode).toBe(413);
  });
});
