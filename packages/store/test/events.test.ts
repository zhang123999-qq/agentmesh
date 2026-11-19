import { describe, expect, it } from 'vitest';

import { withTransaction } from '../src/index.js';
import { makeStore } from './helpers.js';

const base = {
  type: 'task.bid.placed' as const,
  version: 0,
  payload: { taskId: 'tsk_1', bidId: 'bid_1' },
};

describe('EventsDao', () => {
  it('assigns a global, strictly increasing seq across aggregates', () => {
    const { repos } = makeStore();
    const e1 = repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 1, ts: 1 });
    const e2 = repos.events.append({ ...base, aggregateId: 'channel:chn_1', version: 1, ts: 2 });
    const e3 = repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 2, ts: 3 });

    expect([e1.seq, e2.seq, e3.seq]).toEqual([1, 2, 3]);
    expect(new Set([e1.seq, e2.seq, e3.seq]).size).toBe(3);
    expect(e1.prevHash).toBeNull();
    expect(e1.workspaceId).toBe('default');
    expect(repos.events.head()).toBe(3);
  });

  it('reads an event back with its payload deserialised', () => {
    const { repos } = makeStore();
    const appended = repos.events.append({
      ...base,
      aggregateId: 'task:tsk_1',
      version: 1,
      ts: 123,
      prevHash: 'sha256:deadbeef',
      payload: { taskId: 'tsk_1', bidId: 'bid_1', nested: { a: [1, 2] } },
    });

    const loaded = repos.events.get(appended.seq);
    expect(loaded).toEqual(appended);
    expect(loaded?.payload).toEqual({
      taskId: 'tsk_1',
      bidId: 'bid_1',
      nested: { a: [1, 2] },
    });
    expect(loaded?.prevHash).toBe('sha256:deadbeef');
    expect(repos.events.get(999)).toBeUndefined();
  });

  it('returns the persisted payload shape, matching a fresh get()', () => {
    const { repos } = makeStore();
    const raw = {
      taskId: 'tsk_1',
      when: { toJSON: () => '2026-01-01T00:00:00.000Z' },
    };
    const appended = repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 1, payload: raw });

    // Not the caller's raw object: the row is read back after insert.
    expect(appended.payload).not.toBe(raw);
    expect(appended).toEqual(repos.events.get(appended.seq));
    expect(appended.payload).toEqual(repos.events.get(appended.seq)?.payload);
    expect((appended.payload as unknown as { when: string }).when).toBe(
      '2026-01-01T00:00:00.000Z',
    );

    // `undefined` is normalised to `{}` in the payload column; append mirrors it.
    const empty = repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 2, payload: undefined });
    expect(empty.payload).toEqual({});
    expect(empty.payload).toEqual(repos.events.get(empty.seq)?.payload);
  });

  it('replays one aggregate in seq order and exposes its latest version', () => {
    const { repos } = makeStore();
    repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 1 });
    repos.events.append({ ...base, aggregateId: 'task:tsk_2', version: 1 });
    repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 2 });
    repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 3 });

    const history = repos.events.listByAggregate('task:tsk_1');
    expect(history.map((e) => e.version)).toEqual([1, 2, 3]);
    expect(repos.events.latestForAggregate('task:tsk_1')?.version).toBe(3);
    expect(repos.events.listByAggregate('task:tsk_1', { fromVersion: 2 }).map((e) => e.version)).toEqual([
      2,
      3,
    ]);
    expect(repos.events.listByAggregate('task:tsk_1', { limit: 1 })).toHaveLength(1);
    expect(repos.events.count({ aggregateId: 'task:tsk_1' })).toBe(3);
  });

  it('scans windows for resume / audit (list, listSince, type filter)', () => {
    const { repos } = makeStore();
    repos.events.append({ ...base, aggregateId: 'task:tsk_1', version: 1, ts: 1 });
    repos.events.append({
      ...base,
      type: 'task.awarded',
      aggregateId: 'task:tsk_1',
      version: 2,
      ts: 2,
    });
    repos.events.append({ ...base, aggregateId: 'channel:chn_1', version: 1, ts: 3 });

    expect(repos.events.listSince(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(repos.events.listSince(1, 1).map((e) => e.seq)).toEqual([2]);
    expect(repos.events.list({ fromSeq: 2, toSeq: 2 }).map((e) => e.seq)).toEqual([2]);
    expect(repos.events.list({ type: 'task.awarded' }).map((e) => e.ts)).toEqual([2]);
    expect(repos.events.list({ limit: 1 }).map((e) => e.seq)).toEqual([1]);
    expect(repos.events.count()).toBe(3);
  });

  it('appendMany writes atomically in order', () => {
    const { repos } = makeStore();
    const events = repos.events.appendMany([
      { ...base, aggregateId: 'a', ts: 1 },
      { ...base, aggregateId: 'b', ts: 2 },
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(repos.events.head()).toBe(2);
  });

  it('never reuses a seq after rows are removed out of band', () => {
    const { db, repos } = makeStore();
    repos.events.append({ ...base, aggregateId: 'a', version: 1 });
    const second = repos.events.append({ ...base, aggregateId: 'a', version: 2 });

    db.prepare('DELETE FROM events WHERE seq = ?').run(second.seq);
    const third = repos.events.append({ ...base, aggregateId: 'a', version: 3 });
    expect(third.seq).toBeGreaterThan(second.seq);
  });

  it('isolates workspaces in reads and head()', () => {
    const { repos } = makeStore();
    repos.events.append({
      ...base,
      aggregateId: 'a',
      workspaceId: 'other-ws',
      ts: 1,
    });
    expect(repos.events.head()).toBe(0);
    expect(repos.events.head('other-ws')).toBe(1);
    expect(repos.events.list()).toHaveLength(0);
    expect(repos.events.get(1)).toBeUndefined();
    expect(repos.events.get(1, 'other-ws')?.workspaceId).toBe('other-ws');
  });
});

describe('EventsDao append feed (live push)', () => {
  it('notifies subscribers with the persisted row, in seq order', () => {
    const { repos } = makeStore();
    const seen: number[] = [];
    const off = repos.events.onAppend((event) => seen.push(event.seq));

    const first = repos.events.append({ ...base, aggregateId: 'a', ts: 1 });
    const batch = repos.events.appendMany([
      { ...base, aggregateId: 'b', ts: 2 },
      { ...base, aggregateId: 'c', ts: 3 },
    ]);

    // One call per committed row: `append` emits immediately, `appendMany`
    // emits after the transaction, still oldest-first.
    expect(seen).toEqual([first.seq, ...batch.map((e) => e.seq)]);

    off();
    repos.events.append({ ...base, aggregateId: 'd', ts: 4 });
    expect(seen).toHaveLength(3);
  });

  it('passes the payload the caller can read back, and isolates listener errors', () => {
    const { repos } = makeStore();
    const received: Array<{ seq: number; payload: unknown }> = [];
    repos.events.onAppend(() => {
      throw new Error('subscriber bug');
    });
    repos.events.onAppend((event) => received.push({ seq: event.seq, payload: event.payload }));

    const appended = repos.events.append({
      ...base,
      aggregateId: 'a',
      ts: 1,
      payload: { taskId: 'tsk_1', bidId: 'bid_1' },
    });

    // A throwing subscriber must not break the append nor the other listeners.
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ seq: appended.seq, payload: appended.payload });
    expect(repos.events.head()).toBe(appended.seq);
  });

  it('drops callbacks from a nested transaction that rolls back', () => {
    const { db, repos } = makeStore();
    const seen: number[] = [];
    repos.events.onAppend((event) => seen.push(event.seq));

    withTransaction(db, () => {
      repos.events.append({ ...base, aggregateId: 'a', version: 1 });
      expect(() =>
        withTransaction(db, () => {
          repos.events.append({ ...base, aggregateId: 'a', version: 2 });
          throw new Error('inner rollback');
        }),
      ).toThrow('inner rollback');
    });

    // The outer frame committed; the inner savepoint's event did not.
    expect(repos.events.count()).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it('discards every callback when the outer transaction rolls back', () => {
    const { db, repos } = makeStore();
    const seen: number[] = [];
    repos.events.onAppend((event) => seen.push(event.seq));

    expect(() =>
      withTransaction(db, () => {
        withTransaction(db, () => {
          repos.events.append({ ...base, aggregateId: 'a', version: 1 });
        });
        throw new Error('outer rollback');
      }),
    ).toThrow('outer rollback');

    expect(repos.events.count()).toBe(0);
    expect(seen).toEqual([]);
  });

  it('refuses to append inside a raw db.transaction (no commit hook)', () => {
    const { db, repos } = makeStore();
    expect(() =>
      db.transaction(() => {
        repos.events.append({ ...base, aggregateId: 'a', version: 1 });
      })(),
    ).toThrow(/withTransaction/);
    expect(repos.events.count()).toBe(0);
  });

  it('is idempotent per listener (no duplicate registration)', () => {    const { repos } = makeStore();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    const off = repos.events.onAppend(listener);
    repos.events.onAppend(listener);

    repos.events.append({ ...base, aggregateId: 'a', version: 1, ts: 1 });
    expect(calls).toBe(1);

    off();
    repos.events.append({ ...base, aggregateId: 'a', version: 2, ts: 2 });
    expect(calls).toBe(1);
  });
});
