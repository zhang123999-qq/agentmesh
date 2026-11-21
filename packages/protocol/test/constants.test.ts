import { describe, expect, it } from 'vitest';

import {
  GAP_TOO_LARGE,
  JsonRpcErrorCode,
  METHOD_NAMES,
  METHODS,
  PROTOCOL_VERSION,
  ProtocolError,
  errorMessageFor,
  isEventNotificationMethod,
  isGapTooLargeData,
  isMethodName,
  isProtocolVersionCompatible,
  negotiateProtocolVersion,
  parseProtocolVersion,
} from '../src/index.js';

describe('error codes', () => {
  it('pins the application error code values', () => {
    expect(JsonRpcErrorCode.Unauthorized).toBe(-32001);
    expect(JsonRpcErrorCode.Forbidden).toBe(-32002);
    expect(JsonRpcErrorCode.InvalidState).toBe(-32003);
    expect(JsonRpcErrorCode.NotFound).toBe(-32004);
    expect(JsonRpcErrorCode.RateLimited).toBe(-32005);
    expect(JsonRpcErrorCode.ProtocolVersionIncompatible).toBe(-32006);
    expect(JsonRpcErrorCode.VersionConflict).toBe(-32007);
  });

  it('exposes gap_too_large as a degradation signal', () => {
    expect(GAP_TOO_LARGE).toBe('gap_too_large');
    expect(
      isGapTooLargeData({
        signal: 'gap_too_large',
        epoch: 'e1',
        fromSeq: 1,
        currentSeq: 50000,
        window: 1000,
      }),
    ).toBe(true);
    expect(isGapTooLargeData({ signal: 'other' })).toBe(false);
  });

  it('serializes ProtocolError into a JSON-RPC error object', () => {
    const err = new ProtocolError(JsonRpcErrorCode.VersionConflict, undefined, {
      expectedVersion: 4,
    });
    expect(err.message).toBe(errorMessageFor(JsonRpcErrorCode.VersionConflict));
    expect(err.toErrorObject()).toEqual({
      code: -32007,
      message: 'Version conflict',
      data: { expectedVersion: 4 },
    });
    expect(ProtocolError.isVersionConflict(err)).toBe(true);
    expect(
      ProtocolError.isVersionConflict(new ProtocolError(JsonRpcErrorCode.Forbidden)),
    ).toBe(false);
  });
});

describe('method names', () => {
  it('lists every public method exactly once', () => {
    expect(new Set(METHOD_NAMES).size).toBe(METHOD_NAMES.length);
    expect(METHOD_NAMES).toHaveLength(22);
  });

  it('contains the required method names', () => {
    for (const method of [
      'agent.register',
      'agent.authenticate',
      'agent.list',
      'channel.create',
      'channel.join',
      'channel.leave',
      'channel.list',
      'message.send',
      'message.history',
      'task.publish',
      'task.list',
      'task.get',
      'task.bid',
      'task.bids',
      'task.award',
      'task.progress',
      'task.complete',
      'task.fail',
      'task.review',
      'task.reassign',
      'system.subscribe',
    ]) {
      expect(isMethodName(method)).toBe(true);
    }
    expect(METHODS.task.award).toBe('task.award');
  });

  it('rejects unknown methods', () => {
    expect(isMethodName('task.destroy')).toBe(false);
    expect(isMethodName('')).toBe(false);
  });

  it('treats event types as notification methods', () => {
    expect(isEventNotificationMethod('task.awarded')).toBe(true);
    expect(isEventNotificationMethod('system.error')).toBe(true);
    expect(isEventNotificationMethod('task.publish')).toBe(false);
  });
});

describe('protocol version negotiation', () => {
  it('exposes a semver protocol version', () => {
    expect(parseProtocolVersion(PROTOCOL_VERSION)).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
    });
    expect(parseProtocolVersion('1.0')).toBeNull();
  });

  it('requires a matching major version', () => {
    expect(isProtocolVersionCompatible('1.2.3')).toBe(true);
    expect(isProtocolVersionCompatible('2.0.0')).toBe(false);
    expect(isProtocolVersionCompatible('not-a-version')).toBe(false);
  });

  it('negotiates a version for backward-compatible clients', () => {
    expect(negotiateProtocolVersion()).toEqual({
      compatible: true,
      negotiated: PROTOCOL_VERSION,
    });
    expect(negotiateProtocolVersion('2.1.0').compatible).toBe(false);
    expect(negotiateProtocolVersion('1.0.0').requested).toBe('1.0.0');
  });
});
