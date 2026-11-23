import { VersionConflictError } from '@agentmesh/sdk';
import { describe, expect, it } from 'vitest';

import { mapLoginError, mapTaskActionError } from '../src/lib/admin-errors.js';

describe('mapLoginError', () => {
  it('maps -32001 / Unauthorized to invalid-credentials', () => {
    const fromCode = mapLoginError(new Error('RPC error -32001: Unauthorized'));
    expect(fromCode.kind).toBe('unauthorized');
    expect(fromCode.message).toBe('凭据无效或已过期');

    const fromText = mapLoginError(new Error('Unauthorized'));
    expect(fromText.kind).toBe('unauthorized');
  });

  it('maps -32002 to forbidden (needs admin)', () => {
    const result = mapLoginError(new Error('RPC error -32002: Forbidden'));
    expect(result.kind).toBe('forbidden');
    expect(result.message).toContain('admin');
  });

  it('passes through an unknown message', () => {
    const result = mapLoginError(new Error('boom'));
    expect(result.kind).toBe('other');
    expect(result.message).toBe('boom');
  });
});

describe('mapTaskActionError', () => {
  it('surfaces expected + current version from a VersionConflictError', () => {
    const err = new VersionConflictError('version conflict', {
      taskId: 'tsk_1',
      expectedVersion: 1,
      currentVersion: 2,
    });
    const result = mapTaskActionError(err, 'award', 1);
    expect(result.isVersionConflict).toBe(true);
    expect(result.expectedVersion).toBe(1);
    expect(result.currentVersion).toBe(2);
    expect(result.message).toContain('expected=1');
    expect(result.message).toContain('current=2');
  });

  it('recognises a plain -32007 message even without the typed error', () => {
    const result = mapTaskActionError(new Error('RPC error -32007: conflict'), 'complete', 3);
    expect(result.isVersionConflict).toBe(true);
    expect(result.expectedVersion).toBe(3);
    expect(result.message).toContain('expected=3');
  });

  it('passes through non-conflict errors', () => {
    const result = mapTaskActionError(new Error('network down'), 'review', 1);
    expect(result.isVersionConflict).toBe(false);
    expect(result.message).toBe('network down');
  });
});
