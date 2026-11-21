import type { EventNotification } from '@agentmesh/protocol';
import type { EventName } from '@agentmesh/sdk';
import { describe, expect, it } from 'vitest';

import { runTaskWatch, type WatchClient } from '../src/commands/watch.js';

type Handler = (payload: unknown, envelope?: EventNotification) => void;

class FakeWatchClient implements WatchClient {
  readonly handlers = new Map<string, Set<Handler>>();
  closed = false;
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  close(): void {
    this.closed = true;
  }

  on(type: EventName, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  emit(type: EventName, payload: unknown, seq: number): void {
    const envelope = { seq } as EventNotification;
    for (const handler of this.handlers.get(type) ?? []) {
      handler(payload, envelope);
    }
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('agentmesh task watch', () => {
  it('prints only events for the watched task and closes on abort', async () => {
    const client = new FakeWatchClient();
    const controller = new AbortController();
    const lines: string[] = [];

    const done = runTaskWatch(client, {
      taskId: 'tsk_1',
      json: false,
      out: (line) => lines.push(line),
      signal: controller.signal,
    });
    await tick();

    client.emit(
      'task.awarded',
      { taskId: 'tsk_1', awardeeId: 'agt_a', awardedBy: 'agt_admin', exploration: true },
      10,
    );
    client.emit(
      'task.awarded',
      { taskId: 'tsk_other', awardeeId: 'agt_b', awardedBy: 'agt_admin', exploration: false },
      11,
    );
    client.emit(
      'task.dependency.failed',
      { parentTaskId: 'tsk_1', subtaskId: 'tsk_2', blockedBy: ['tsk_2'] },
      12,
    );

    controller.abort();
    await done;

    expect(lines[0]).toContain('watching task tsk_1');
    expect(lines.some((line) => line.includes('task.awarded') && line.includes('agt_a'))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes('tsk_other'))).toBe(false);
    expect(lines.some((line) => line.includes('task.dependency.failed'))).toBe(true);
    expect(client.closed).toBe(true);
  });

  it('emits one JSON object per event with --json', async () => {
    const client = new FakeWatchClient();
    const controller = new AbortController();
    const lines: string[] = [];

    const done = runTaskWatch(client, {
      taskId: 'tsk_9',
      json: true,
      out: (line) => lines.push(line),
      signal: controller.signal,
    });
    await tick();
    client.emit(
      'task.progress.updated',
      { taskId: 'tsk_9', agentId: 'agt_a', progress: 50 },
      21,
    );
    controller.abort();
    await done;

    const eventLine = lines.find((line) => line.startsWith('{'));
    expect(eventLine).toBeDefined();
    expect(JSON.parse(eventLine ?? '{}')).toMatchObject({
      type: 'task.progress.updated',
      seq: 21,
      payload: { taskId: 'tsk_9', progress: 50 },
    });
  });
});
