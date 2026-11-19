import { describe, expect, it } from 'vitest';

import {
  JSON_RPC_VERSION,
  JsonRpcErrorCode,
  createJsonRpcErrorResponse,
  createJsonRpcNotification,
  createJsonRpcRequest,
  createJsonRpcSuccessResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  jsonRpcMessageKind,
  jsonRpcMessageSchema,
  parseJsonRpcMessage,
} from '../src/index.js';

describe('JSON-RPC 2.0 request envelope', () => {
  it('accepts a request with named params', () => {
    const message = {
      jsonrpc: '2.0',
      id: 7,
      method: 'task.get',
      params: { taskId: 'tsk_1' },
    };
    expect(jsonRpcMessageSchema.safeParse(message).success).toBe(true);
    const parsed = parseJsonRpcMessage(message);
    expect(isJsonRpcRequest(parsed)).toBe(true);
    expect(jsonRpcMessageKind(parsed)).toBe('request');
  });

  it('accepts positional params and string ids', () => {
    const parsed = jsonRpcMessageSchema.parse({
      jsonrpc: '2.0',
      id: 'abc-1',
      method: 'system.subscribe',
      params: ['task.awarded'],
    });
    expect(isJsonRpcRequest(parsed)).toBe(true);
  });

  it('rejects a wrong jsonrpc version', () => {
    const result = jsonRpcMessageSchema.safeParse({
      jsonrpc: '1.0',
      id: 1,
      method: 'agent.list',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a request without method', () => {
    const result = jsonRpcMessageSchema.safeParse({ jsonrpc: '2.0', id: 1, params: {} });
    expect(result.success).toBe(false);
  });
});

describe('JSON-RPC 2.0 notification envelope', () => {
  it('accepts a notification and classifies it', () => {
    const parsed = jsonRpcMessageSchema.parse({
      jsonrpc: '2.0',
      method: 'task.awarded',
      params: { taskId: 'tsk_1' },
    });
    expect(isJsonRpcNotification(parsed)).toBe(true);
    expect(isJsonRpcRequest(parsed)).toBe(false);
    expect(jsonRpcMessageKind(parsed)).toBe('notification');
  });
});

describe('JSON-RPC 2.0 response envelope', () => {
  it('accepts a success response', () => {
    const parsed = jsonRpcMessageSchema.parse({
      jsonrpc: '2.0',
      id: 3,
      result: { ok: true },
    });
    expect(isJsonRpcResponse(parsed)).toBe(true);
    expect(jsonRpcMessageKind(parsed)).toBe('response');
  });

  it('accepts an error response with a null id', () => {
    const parsed = jsonRpcMessageSchema.parse({
      jsonrpc: '2.0',
      id: null,
      error: { code: JsonRpcErrorCode.ParseError, message: 'Parse error' },
    });
    expect(isJsonRpcResponse(parsed)).toBe(true);
  });

  it('rejects unknown error codes', () => {
    const result = jsonRpcMessageSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -99999, message: 'nope' },
    });
    expect(result.success).toBe(false);
  });
});

describe('builders', () => {
  it('builds messages that satisfy the schema', () => {
    const request = createJsonRpcRequest('channel.list', {});
    const notification = createJsonRpcNotification('presence.update', { agentId: 'a1' });
    const success = createJsonRpcSuccessResponse(request.id, { channels: [] });
    const failure = createJsonRpcErrorResponse(
      request.id,
      JsonRpcErrorCode.VersionConflict,
      'Version conflict',
      { expectedVersion: 3 },
    );

    for (const message of [request, notification, success, failure]) {
      expect(message.jsonrpc).toBe(JSON_RPC_VERSION);
      expect(jsonRpcMessageSchema.safeParse(message).success).toBe(true);
    }
    expect(failure.error.data).toEqual({ expectedVersion: 3 });
  });

  it('ids are unique per call by default', () => {
    const a = createJsonRpcRequest('agent.list');
    const b = createJsonRpcRequest('agent.list');
    expect(a.id).not.toBe(b.id);
  });
});
