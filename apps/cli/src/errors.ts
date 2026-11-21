/**
 * CLI error rendering.
 *
 * The server is the only authority on business state; the CLI adds the
 * remediation hints a human needs (US-016 decision 4). No automatic retry is
 * attempted for CAS conflicts — re-running after a concurrent change could
 * silently do something else than the operator intended.
 */

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

function dataField(data: unknown, key: string): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return (data as Record<string, unknown>)[key];
}

function readString(data: unknown, key: string): string | undefined {
  const value = dataField(data, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(data: unknown, key: string): number | undefined {
  const value = dataField(data, key);
  return typeof value === 'number' ? value : undefined;
}

function resourceId(data: unknown): string | undefined {
  for (const key of ['taskId', 'channelId', 'agentId', 'bidId', 'id']) {
    const value = readString(data, key);
    if (value !== undefined) return `${key}=${value}`;
  }
  return undefined;
}

export function formatCliError(error: unknown): string {
  if (error instanceof VersionConflictError) {
    const taskId = error.taskId;
    const expected = error.expectedVersion;
    const current = error.currentVersion;
    const lines = [
      `error ${error.code} version conflict${taskId ? ` for task ${taskId}` : ''}`,
    ];
    if (expected !== undefined) lines.push(`  expected: ${expected}`);
    if (current !== undefined) lines.push(`  current:  ${current}`);
    if (taskId !== undefined) {
      lines.push(
        `hint: the task changed concurrently. Re-read it with \`agentmesh task get ${taskId}\`` +
          (current === undefined
            ? ' and retry with the current version.'
            : ` and retry with --expected-version ${current}.`),
      );
    }
    return lines.join('\n');
  }

  if (error instanceof RateLimitedError) {
    const retryAfterMs = error.retryAfterMs;
    return [
      `error ${error.code} rate limited: ${error.message}`,
      ...(retryAfterMs === undefined
        ? []
        : [`hint: retry after ${retryAfterMs}ms`]),
    ].join('\n');
  }

  if (error instanceof ProtocolVersionError) {
    return [
      `error ${error.code} incompatible protocol version: ${error.message}`,
      'hint: upgrade the CLI or the server so their MAJOR protocol versions match.',
    ].join('\n');
  }

  if (error instanceof UnauthorizedError) {
    return [
      `error ${error.code} unauthorized: ${error.message}`,
      'hint: run `agentmesh login` (or check that --token has not expired).',
    ].join('\n');
  }

  if (error instanceof ForbiddenError) {
    const required = dataField(error.data, 'required');
    return [
      `error ${error.code} forbidden: ${error.message}`,
      ...(required === undefined
        ? []
        : [`hint: required role(s): ${JSON.stringify(required)}`]),
    ].join('\n');
  }

  if (error instanceof NotFoundError) {
    const id = resourceId(error.data);
    return [
      `error ${error.code} not found: ${error.message}`,
      ...(id === undefined ? [] : [`  ${id}`]),
    ].join('\n');
  }

  if (error instanceof InvalidStateError) {
    const reason = readString(error.data, 'reason');
    const status = readString(error.data, 'currentStatus');
    return [
      `error ${error.code} invalid state: ${error.message}`,
      ...(reason === undefined ? [] : [`  reason: ${reason}`]),
      ...(status === undefined ? [] : [`  status: ${status}`]),
    ].join('\n');
  }

  if (error instanceof AgentMeshError) {
    const suffix =
      error.data === undefined ? '' : `\n  data: ${JSON.stringify(error.data)}`;
    return `error ${error.code}: ${error.message}${suffix}`;
  }

  return `error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Structured form used with `--json`. */
export function jsonError(error: unknown): Record<string, unknown> {
  if (error instanceof AgentMeshError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.data === undefined ? {} : { data: error.data }),
        ...(error.method === undefined ? {} : { method: error.method }),
      },
    };
  }
  return { error: { message: error instanceof Error ? error.message : String(error) } };
}

/** Best-effort numeric field for tests/introspection. */
export function currentVersionOf(error: unknown): number | undefined {
  if (error instanceof VersionConflictError) return error.currentVersion;
  return readNumber((error as AgentMeshError | undefined)?.data, 'currentVersion');
}
