import { describe, expect, it, vi } from 'vitest';

import {
  JsonRpcErrorCode,
  ProtocolError,
  createJsonRpcRequest,
  type JsonRpcErrorResponse,
  type JsonRpcSuccessResponse,
} from '@agentmesh/protocol';

import { RpcDispatcher } from '../src/dispatcher.js';
import { createHandlerRegistry } from '../src/registry.js';
import type { HandlerContext } from '../src/registry.js';
import { makeCapturingLogger } from './helpers.js';

function asSuccess(message: unknown): JsonRpcSuccessResponse {
  return message as JsonRpcSuccessResponse;
}

function asError(message: unknown): JsonRpcErrorResponse {
  return message as JsonRpcErrorResponse;
}

describe('RpcDispatcher', () => {
  it('routes a request to the registered handler and returns a result', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.echo', async (_ctx, params) => ({ echo: params }));
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch(
      createJsonRpcRequest('task.echo', { agentId: 'agt_7', title: 'hi' }, 42),
    );

    expect(outcome.kind).toBe('request');
    expect(outcome.method).toBe('task.echo');
    expect(outcome.agentId).toBe('agt_7');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    const response = asSuccess(outcome.response);
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 42,
      result: { echo: { agentId: 'agt_7', title: 'hi' } },
    });

    const line = lines.find((entry) => entry.msg === 'rpc.request.completed');
    expect(line).toBeDefined();
    expect(line).toMatchObject({
      level: 'info',
      reqId: outcome.reqId,
      method: 'task.echo',
      agentId: 'agt_7',
    });
    expect(typeof line?.ts).toBe('string');
    expect(typeof line?.durationMs).toBe('number');
  });

  it('passes a request-scoped context to handlers', async () => {
    const registry = createHandlerRegistry();
    const captured: { ctx?: HandlerContext } = {};
    registry.registerHandler('agent.whoami', async (ctx) => {
      captured.ctx = ctx;
      return ctx.agentId;
    });
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger, workspaceId: 'ws-1' });

    const outcome = await dispatcher.dispatch(
      createJsonRpcRequest('agent.whoami', { agentId: 'agt_1' }),
    );

    expect(outcome.response).toMatchObject({ result: 'agt_1' });
    expect(captured.ctx).toBeDefined();
    expect(captured.ctx).toMatchObject({
      reqId: outcome.reqId,
      agentId: 'agt_1',
      workspaceId: 'ws-1',
    });
    expect(typeof captured.ctx?.logger.info).toBe('function');
  });

  it('generates a unique reqId per dispatched message', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('ping', async () => 'pong');
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const a = await dispatcher.dispatch(createJsonRpcRequest('ping'));
    const b = await dispatcher.dispatch(createJsonRpcRequest('ping'));

    expect(a.reqId).not.toBe(b.reqId);
  });

  it('honours a caller-provided reqId', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('ping', async () => 'pong');
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch(createJsonRpcRequest('ping'), {
      reqId: 'fixed-req-id',
    });

    expect(outcome.reqId).toBe('fixed-req-id');
    expect(lines.some((line) => line.reqId === 'fixed-req-id')).toBe(true);
  });

  it('returns -32601 for an unknown method on a request', async () => {
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch(createJsonRpcRequest('task.missing', {}, 'r1'));

    const error = asError(outcome.response);
    expect(error.id).toBe('r1');
    expect(error.error.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it('does not reply to a notification, even for an unknown method', async () => {
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch({
      jsonrpc: '2.0',
      method: 'task.missing',
    });

    expect(outcome.kind).toBe('notification');
    expect(outcome.response).toBeUndefined();
    expect(lines.some((line) => line.msg === 'rpc.method.not_found')).toBe(true);
  });

  it('runs notification handlers without producing a response', async () => {
    const registry = createHandlerRegistry();
    const handler = vi.fn(async () => undefined);
    registry.registerHandler('agent.heartbeat', handler);
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch({
      jsonrpc: '2.0',
      method: 'agent.heartbeat',
      params: { agentId: 'agt_2' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(outcome.response).toBeUndefined();
    const line = lines.find((entry) => entry.msg === 'rpc.notification.handled');
    expect(line).toMatchObject({
      reqId: outcome.reqId,
      method: 'agent.heartbeat',
      agentId: 'agt_2',
    });
  });

  it('treats a message with an id as a request even when params are absent', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.echo', async (_ctx, params) => params);
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 'string-id',
      method: 'task.echo',
    });

    expect(outcome.kind).toBe('request');
    const response = asSuccess(outcome.response);
    expect(response.id).toBe('string-id');
    expect(response.result).toEqual({});
  });

  it('preserves ProtocolError code, message and data', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.get', async () => {
      throw new ProtocolError(JsonRpcErrorCode.NotFound, 'Task not found', {
        taskId: 'tsk_404',
      });
    });
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch(
      createJsonRpcRequest('task.get', { taskId: 'tsk_404' }, 7),
    );

    const error = asError(outcome.response);
    expect(error.id).toBe(7);
    expect(error.error).toEqual({
      code: JsonRpcErrorCode.NotFound,
      message: 'Task not found',
      data: { taskId: 'tsk_404' },
    });
    expect(lines.some((line) => line.msg === 'rpc.request.failed')).toBe(true);
  });

  it('maps unexpected errors to -32603 and emits system.error with the same reqId', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.bomb', async () => {
      throw new Error('kaboom');
    });
    const { logger, lines } = makeCapturingLogger();
    const onSystemError = vi.fn();
    const dispatcher = new RpcDispatcher({ registry, logger, onSystemError });

    const outcome = await dispatcher.dispatch(
      createJsonRpcRequest('task.bomb', { agentId: 'agt_9' }, 3),
    );

    const error = asError(outcome.response);
    expect(error.error.code).toBe(JsonRpcErrorCode.InternalError);
    expect(error.error.message).toBe('Internal error');
    expect(onSystemError).toHaveBeenCalledWith({
      message: 'Internal error',
      code: JsonRpcErrorCode.InternalError,
      reqId: outcome.reqId,
      method: 'task.bomb',
      agentId: 'agt_9',
    });

    const line = lines.find((entry) => entry.msg === 'rpc.request.failed');
    expect(line).toMatchObject({
      level: 'error',
      reqId: outcome.reqId,
      method: 'task.bomb',
      agentId: 'agt_9',
      code: JsonRpcErrorCode.InternalError,
    });
    expect((line?.err as { message?: string } | undefined)?.message).toBe('kaboom');
  });

  it('returns -32700 with a null id for unparseable JSON text', async () => {
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch('{"jsonrpc":"2.0","id":1,');

    expect(outcome.kind).toBe('invalid');
    expect(outcome.method).toBeNull();
    const error = asError(outcome.response);
    expect(error.id).toBeNull();
    expect(error.error.code).toBe(JsonRpcErrorCode.ParseError);
    const line = lines.find((entry) => entry.msg === 'rpc.parse.error');
    expect(line).toMatchObject({ reqId: outcome.reqId, method: null, agentId: null });
  });

  // ---- US-004 fix: JSON-RPC semantic classification ---------------------
  // A notification is a request *without an id member*. Any id value — even
  // `null`, `""`, `0`, an object or a boolean — identifies a request that
  // must be answered with the very same id.

  describe.each([
    ['null', null],
    ['an empty string', ''],
    ['zero', 0],
    ['an object', { x: 1 }],
    ['false', false],
  ])('a frame with id %s', (_label, id) => {
    it('is treated as a request and answered with the same id', async () => {
      const registry = createHandlerRegistry();
      registry.registerHandler('echo', async (_ctx, params) => ({ echo: params }));
      const { logger, lines } = makeCapturingLogger();
      const dispatcher = new RpcDispatcher({ registry, logger });

      const outcome = await dispatcher.dispatch({
        jsonrpc: '2.0',
        id,
        method: 'echo',
        params: { hello: 'world' },
      });

      expect(outcome.kind).toBe('request');
      expect(outcome.method).toBe('echo');
      const response = asSuccess(outcome.response);
      expect(response.id).toEqual(id);
      expect(response.result).toEqual({ echo: { hello: 'world' } });
      expect(lines.some((line) => line.msg === 'rpc.request.completed')).toBe(true);
    });
  });

  it('echoes id:null on the success response (never silently drops it)', async () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('echo', async () => 'pong');
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch({ jsonrpc: '2.0', id: null, method: 'echo' });

    expect(outcome.response).toBeDefined();
    expect(asSuccess(outcome.response)).toEqual({
      jsonrpc: '2.0',
      id: null,
      result: 'pong',
    });
  });

  it('answers id:null requests even when the method is unknown', async () => {
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: null,
      method: 'task.missing',
    });

    expect(outcome.kind).toBe('request');
    expect(asError(outcome.response).id).toBeNull();
    expect(asError(outcome.response).error.code).toBe(JsonRpcErrorCode.MethodNotFound);
  });

  it('keeps a frame without an id member a notification (no reply)', async () => {
    const registry = createHandlerRegistry();
    const handler = vi.fn(async () => 'ignored');
    registry.registerHandler('echo', handler);
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({ registry, logger });

    const outcome = await dispatcher.dispatch({ jsonrpc: '2.0', method: 'echo' });

    expect(outcome.kind).toBe('notification');
    expect(outcome.response).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe.each([
    ['an empty object', {}],
    ['a wrong jsonrpc version', { jsonrpc: '1.0', id: 5, method: 'echo' }],
    ['an empty method', { jsonrpc: '2.0', id: 5, method: '' }],
    ['non-string method', { jsonrpc: '2.0', id: 5, method: 42 }],
    ['invalid params', { jsonrpc: '2.0', id: 5, method: 'echo', params: 'nope' }],
    ['a missing method', { jsonrpc: '2.0', id: 5, params: {} }],
    ['a bare JSON array', [] as unknown],
  ])('a structurally invalid frame: %s', (_label, frame) => {
    it('returns -32600 Invalid request', async () => {
      const registry = createHandlerRegistry();
      const handler = vi.fn(async () => 'ok');
      registry.registerHandler('echo', handler);
      const { logger, lines } = makeCapturingLogger();
      const dispatcher = new RpcDispatcher({ registry, logger });

      const outcome = await dispatcher.dispatch(frame);

      expect(outcome.kind).toBe('invalid');
      expect(outcome.method).toBeNull();
      const error = asError(outcome.response);
      expect(error.error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(handler).not.toHaveBeenCalled();
      expect(lines.some((line) => line.msg === 'rpc.invalid.request')).toBe(true);
    });
  });

  it('echoes the extractable id on a -32600 response', async () => {
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch({ jsonrpc: '1.0', id: 'r7', method: 'echo' });

    expect(asError(outcome.response).id).toBe('r7');
    expect(asError(outcome.response).error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it('uses a null id on -32600 when no legal id can be extracted', async () => {
    const { logger } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch({ jsonrpc: '2.0', id: { x: 1 } });

    expect(asError(outcome.response).id).toBeNull();
    expect(asError(outcome.response).error.code).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it('ignores response frames received by the server', async () => {
    const { logger, lines } = makeCapturingLogger();
    const dispatcher = new RpcDispatcher({
      registry: createHandlerRegistry(),
      logger,
    });

    const outcome = await dispatcher.dispatch({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    });

    expect(outcome.kind).toBe('response');
    expect(outcome.response).toBeUndefined();
    expect(lines.some((line) => line.msg === 'rpc.unexpected.response')).toBe(true);
  });
});
