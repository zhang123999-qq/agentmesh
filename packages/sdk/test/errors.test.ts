import { JsonRpcErrorCode } from '@agentmesh/protocol';
import { describe, expect, it } from 'vitest';

import {
  AgentMeshError,
  errorFromResponse,
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  ProtocolVersionError,
  RateLimitedError,
  UnauthorizedError,
  VersionConflictError,
} from '../src/errors.js';

const CASES = [
  [JsonRpcErrorCode.Unauthorized, UnauthorizedError],
  [JsonRpcErrorCode.Forbidden, ForbiddenError],
  [JsonRpcErrorCode.InvalidState, InvalidStateError],
  [JsonRpcErrorCode.NotFound, NotFoundError],
  [JsonRpcErrorCode.RateLimited, RateLimitedError],
  [JsonRpcErrorCode.ProtocolVersionIncompatible, ProtocolVersionError],
  [JsonRpcErrorCode.VersionConflict, VersionConflictError],
] as const;

describe('errorFromResponse', () => {
  it.each(CASES)('maps %i to the dedicated error class', (code, Class) => {
    const error = errorFromResponse(code, 'nope', { detail: 1 }, 'task.get');
    expect(error).toBeInstanceOf(Class);
    expect(error).toBeInstanceOf(AgentMeshError);
    expect(error.code).toBe(code);
    expect(error.message).toBe('nope');
    expect(error.data).toEqual({ detail: 1 });
    expect(error.method).toBe('task.get');
    expect(error.name).toBe(Class.name);
  });

  it('falls back to AgentMeshError for unknown codes', () => {
    const error = errorFromResponse(-32601, 'Method not found', undefined, 'x.y');
    expect(error.constructor).toBe(AgentMeshError);
    expect(error.code).toBe(-32601);
    expect(error.data).toBeUndefined();
  });
});

describe('typed error accessors', () => {
  it('exposes RateLimited retryAfterMs only when numeric', () => {
    expect(new RateLimitedError('slow', { retryAfterMs: 1500 }).retryAfterMs).toBe(1500);
    expect(new RateLimitedError('slow', { retryAfterMs: '1500' }).retryAfterMs).toBeUndefined();
    expect(new RateLimitedError('slow').retryAfterMs).toBeUndefined();
  });

  it('exposes VersionConflict CAS fields only when well-typed', () => {
    const ok = new VersionConflictError('stale', {
      taskId: 'tsk_1',
      expectedVersion: 2,
      currentVersion: 3,
    });
    expect(ok.taskId).toBe('tsk_1');
    expect(ok.expectedVersion).toBe(2);
    expect(ok.currentVersion).toBe(3);

    const bad = new VersionConflictError('stale', {
      taskId: 42,
      expectedVersion: '2',
    });
    expect(bad.taskId).toBeUndefined();
    expect(bad.expectedVersion).toBeUndefined();
    expect(bad.currentVersion).toBeUndefined();
    expect(new VersionConflictError('stale').currentVersion).toBeUndefined();
  });
});
