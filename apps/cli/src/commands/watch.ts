/**
 * `agentmesh task watch <taskId>` — live task event stream.
 *
 * This is a thin consumer of the SDK's `on()` fan-out: the CLI does not
 * reconnect, dedupe or resume by itself (US-016 hard constraint).
 */

import type { EventName } from '@agentmesh/sdk';
import type { EventNotification } from '@agentmesh/protocol';

import type { CommandContext } from '../context.js';

/** Subset of `AgentMeshClient` the watch loop needs (fakeable in tests). */
export interface WatchClient {
  connect(): Promise<void>;
  close(): void;
  on(
    type: EventName,
    handler: (payload: unknown, envelope?: EventNotification) => void,
  ): () => void;
}

export interface WatchOptions {
  readonly taskId: string;
  readonly json: boolean;
  readonly out: (text: string) => void;
  /** Test hook: resolve the watch loop without a real SIGINT. */
  readonly signal?: AbortSignal;
}

const WATCHED_EVENTS = [
  'task.bid.received',
  'task.awarded',
  'task.progress.updated',
  'task.completed',
  'task.failed',
  'task.review.decided',
  'task.reassigned',
  'task.cancelled',
  'task.dependency.failed',
] as const;

function field(payload: unknown, key: string): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  return (payload as Record<string, unknown>)[key];
}

function str(payload: unknown, key: string): string {
  const value = field(payload, key);
  return typeof value === 'string' ? value : '-';
}

function num(payload: unknown, key: string): string {
  const value = field(payload, key);
  return typeof value === 'number' ? String(value) : '-';
}

function summarize(type: string, payload: unknown): string {
  switch (type) {
    case 'task.bid.received':
      return `bid ${str(payload, 'bidId')} by ${str(payload, 'agentId')} price ${num(payload, 'price')}`;
    case 'task.awarded':
      return `awarded to ${str(payload, 'awardeeId')} (exploration ${String(field(payload, 'exploration') ?? false)})`;
    case 'task.progress.updated':
      return `${str(payload, 'agentId')} reported ${num(payload, 'progress')}%`;
    case 'task.completed':
      return 'submitted for review';
    case 'task.failed':
      return `failed${str(payload, 'reason') === '-' ? '' : `: ${str(payload, 'reason')}`}`;
    case 'task.review.decided':
      return `${str(payload, 'reviewerId')} decided ${str(payload, 'decision')}`;
    case 'task.reassigned':
      return `reassigned ${str(payload, 'fromAgentId')} → ${str(payload, 'toAgentId')}`;
    case 'task.cancelled':
      return `cancelled${str(payload, 'reason') === '-' ? '' : `: ${str(payload, 'reason')}`}`;
    case 'task.dependency.failed':
      return `dependency ${str(payload, 'subtaskId')} failed for parent ${str(payload, 'parentTaskId')}`;
    default:
      return '';
  }
}

/**
 * Resolve when `signal` aborts. Without a signal the promise only settles on
 * SIGINT, which is exactly the interactive behaviour.
 */
function waitForStop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onSigint = (): void => finish();
    const onAbort = (): void => finish();
    const finish = (): void => {
      process.off('SIGINT', onSigint);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    process.once('SIGINT', onSigint);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runTaskWatch(
  client: WatchClient,
  options: WatchOptions,
): Promise<void> {
  const { taskId, json, out } = options;
  const matches = (payload: unknown): boolean =>
    field(payload, 'taskId') === taskId ||
    field(payload, 'parentTaskId') === taskId;

  await client.connect();
  const unsubscribers: Array<() => void> = [];
  for (const type of WATCHED_EVENTS) {
    unsubscribers.push(
      client.on(type, (payload, envelope) => {
        if (!matches(payload)) return;
        if (json) {
          out(
            JSON.stringify({
              type,
              seq: envelope?.seq ?? null,
              payload,
            }),
          );
          return;
        }
        const summary = summarize(type, payload);
        out(`[${new Date().toISOString()}] ${type}${summary.length === 0 ? '' : ` — ${summary}`}`);
      }),
    );
  }

  out(`watching task ${taskId} — Ctrl+C to stop`);
  try {
    await waitForStop(options.signal);
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    client.close();
  }
}

export function watchOptionsFromContext(ctx: CommandContext, taskId: string): WatchOptions {
  return { taskId, json: ctx.json, out: ctx.out };
}
