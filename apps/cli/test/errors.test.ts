import {
  AgentMeshError,
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  ProtocolVersionError,
  RateLimitedError,
  UnauthorizedError,
  VersionConflictError,
} from '@agentmesh/sdk';
import { describe, expect, it } from 'vitest';

import { formatCliError, jsonError } from '../src/errors.js';

describe('CLI error rendering', () => {
  it('explains -32007 with expected/current and a retry command', () => {
    const error = new VersionConflictError('Version conflict', {
      taskId: 'tsk_1',
      expectedVersion: 3,
      currentVersion: 5,
    });
    const text = formatCliError(error);
    expect(text).toContain('version conflict for task tsk_1');
    expect(text).toContain('expected: 3');
    expect(text).toContain('current:  5');
    expect(text).toContain('agentmesh task get tsk_1');
    expect(text).toContain('--expected-version 5');
  });

  it('reports retryAfterMs for -32005', () => {
    const text = formatCliError(
      new RateLimitedError('Rate limit exceeded', { retryAfterMs: 1500 }),
    );
    expect(text).toContain('rate limited');
    expect(text).toContain('retry after 1500ms');
  });

  it('asks for an upgrade on -32006', () => {
    const text = formatCliError(new ProtocolVersionError('Incompatible protocol version'));
    expect(text).toContain('incompatible protocol version');
    expect(text).toContain('upgrade');
  });

  it('prints the resource id on -32004', () => {
    const text = formatCliError(new NotFoundError('Task not found', { taskId: 'tsk_missing' }));
    expect(text).toContain('not found');
    expect(text).toContain('taskId=tsk_missing');
  });

  it('hints login on -32001 and shows required roles on -32002', () => {
    expect(formatCliError(new UnauthorizedError('Authentication required'))).toContain(
      'agentmesh login',
    );
    expect(
      formatCliError(new ForbiddenError('nope', { role: 'agent', required: ['admin'] })),
    ).toContain('["admin"]');
  });

  it('surfaces invalid-state reasons', () => {
    const text = formatCliError(
      new InvalidStateError('Invalid state', { reason: 'subtasks_incomplete' }),
    );
    expect(text).toContain('reason: subtasks_incomplete');
  });

  it('keeps code and data for generic errors', () => {
    const text = formatCliError(new AgentMeshError(-32602, 'Invalid params', { field: 'taskId' }));
    expect(text).toContain('error -32602');
    expect(text).toContain('{"field":"taskId"}');
  });

  it('creates a JSON error object for --json', () => {
    const view = jsonError(
      new VersionConflictError('Version conflict', {
        taskId: 'tsk_1',
        expectedVersion: 1,
        currentVersion: 2,
      }),
    );
    expect(view).toEqual({
      error: {
        code: -32007,
        message: 'Version conflict',
        data: { taskId: 'tsk_1', expectedVersion: 1, currentVersion: 2 },
        method: undefined,
      },
    });
  });
});
