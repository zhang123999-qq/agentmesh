import { parseEventEnvelope } from '@agentmesh/protocol';
import { withTransaction } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

import {
  aggregateIdOf,
  hashEvent,
  parseAggregateId,
  tryParseAggregateId,
  verifyEventChain,
  type CoreEvent,
} from '../src/index.js';
import { FIXED_TS, makeCore, makeEvent } from './helpers.js';

describe('EventStore', () => {
  it('assigns a global seq across aggregates and per-aggregate versions', () => {
    const { store } = makeCore();
    const a1 = store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: {} });
    const b1 = store.append({ aggregateId: 'channel:chn_1', type: 'channel.created', payload: {} });
    const a2 = store.append({ aggregateId: 'task:tsk_1', type: 'task.awarded', payload: {} });

    expect([a1.seq, b1.seq, a2.seq]).toEqual([1, 2, 3]);
    expect([a1.version, b1.version, a2.version]).toEqual([1, 1, 2]);
    expect(store.head()).toBe(3);
    expect(store.count()).toBe(3);
    expect(store.aggregateVersion('task:tsk_1')).toBe(2);
    expect(store.aggregateVersion('task:missing')).toBe(0);
    expect(store.hasAggregate('channel:chn_1')).toBe(true);
    expect(store.latest()?.seq).toBe(3);
  });

  it('writes prevHash links over the global log (and verifies them)', () => {
    const { store } = makeCore();
    const first = store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: {} });
    const second = store.append({ aggregateId: 'channel:chn_1', type: 'channel.created', payload: {} });

    expect(first.prevHash).toBeUndefined();
    expect(second.prevHash).toBe(hashEvent(first));
    expect(verifyEventChain([first, second])).toEqual({ valid: true });

    const tampered = [{ ...first, payload: { hacked: true } }, second];
    expect(verifyEventChain(tampered)).toEqual({ valid: false, brokenAt: 1 });
  });

  it('only checks links between globally consecutive events', () => {
    const { store } = makeCore();
    const first = store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: {} });
    store.append({ aggregateId: 'channel:chn_1', type: 'channel.created', payload: {} });
    const third = store.append({ aggregateId: 'task:tsk_1', type: 'task.awarded', payload: {} });

    // Aggregate slice (seq 1, 3) has a gap: no verifiable link, not tampering.
    expect(store.loadAggregate('task:tsk_1').map((e) => e.seq)).toEqual([1, 3]);
    expect(verifyEventChain([first, third])).toEqual({ valid: true });
    // The contiguous global window is verifiable and intact.
    expect(verifyEventChain(store.readFrom(1))).toEqual({ valid: true });
  });

  it('can disable hash links and honours explicit ts / prevHash', () => {
    const noChain = makeCore({ hashChain: false });
    const plain = noChain.store.append({
      aggregateId: 'task:tsk_1',
      type: 'task.published',
      payload: {},
    });
    expect(plain.prevHash).toBeUndefined();

    const { store } = makeCore();
    const custom = store.append({
      aggregateId: 'task:tsk_1',
      type: 'task.published',
      payload: {},
      ts: 42,
      prevHash: 'sha256:custom',
    });
    expect(custom.ts).toBe(42);
    expect(custom.prevHash).toBe('sha256:custom');
    expect(store.loadAggregate('task:tsk_1')[0]?.prevHash).toBe('sha256:custom');
  });

  it('returns envelopes that satisfy the protocol schema', () => {
    const { store } = makeCore();
    const appended = store.append({
      aggregateId: 'message:msg_1',
      type: 'message.created',
      payload: { channelId: 'chn_1', senderId: 'agt_1', body: 'hello' },
    });
    const parsed = parseEventEnvelope(appended);
    expect(parsed.seq).toBe(appended.seq);
    expect(parsed.aggregateId).toBe('message:msg_1');
    expect(parsed.prevHash).toBeUndefined();
  });

  it('loads one aggregate in order and reads seq windows', () => {
    const { store } = makeCore();
    store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: { n: 1 } });
    store.append({ aggregateId: 'task:tsk_2', type: 'task.published', payload: { n: 2 } });
    store.append({ aggregateId: 'task:tsk_1', type: 'task.bid.placed', payload: { n: 3 } });
    store.append({ aggregateId: 'task:tsk_1', type: 'task.awarded', payload: { n: 4 } });

    expect(store.loadAggregate('task:tsk_1').map((e) => e.seq)).toEqual([1, 3, 4]);
    expect(store.loadAggregate('task:tsk_1', { fromVersion: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(store.loadAggregate('task:tsk_1', { limit: 1 }).map((e) => e.seq)).toEqual([1]);

    expect(store.readFrom(2).map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(store.readFrom(2, { toSeq: 3 }).map((e) => e.seq)).toEqual([2, 3]);
    expect(store.readFrom(1, { aggregateId: 'task:tsk_1' }).map((e) => e.seq)).toEqual([1, 3, 4]);
    expect(store.readAfter(2).map((e) => e.seq)).toEqual([3, 4]);
    expect(store.readAfter(4)).toEqual([]);
  });

  it('never announces a rolled-back event and reuses its seq for the retry', () => {
    const { db, repos, store } = makeCore();
    const seen: number[] = [];
    const unsubscribe = repos.events.onAppend((event) => seen.push(event.seq));

    let attempted: CoreEvent | undefined;
    expect(() =>
      withTransaction(db, () => {
        attempted = store.append({
          aggregateId: 'task:tsk_rollback',
          type: 'task.awarded',
          payload: { taskId: 'tsk_rollback' },
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // The transaction rolled back: no listener saw the phantom event.
    expect(seen).toEqual([]);
    expect(store.count()).toBe(0);

    // SQLite rolls the AUTOINCREMENT sequence back too, so the committed retry
    // reuses the exact seq the phantom would have had — and must be delivered.
    const committed = store.append({
      aggregateId: 'task:tsk_rollback',
      type: 'task.awarded',
      payload: { taskId: 'tsk_rollback' },
    });
    expect(committed.seq).toBe(attempted?.seq);
    expect(seen).toEqual([committed.seq]);
    unsubscribe();
  });

  it('appendMany writes atomically and chain-links the batch', () => {    const { store } = makeCore();
    const events = store.appendMany([
      { aggregateId: 'task:tsk_1', type: 'task.published', payload: {} },
      { aggregateId: 'task:tsk_1', type: 'task.bid.placed', payload: {} },
      { aggregateId: 'channel:chn_1', type: 'channel.created', payload: {} },
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.version)).toEqual([1, 2, 1]);
    const [first, second, third] = events as [CoreEvent, CoreEvent, CoreEvent];
    expect(second.prevHash).toBe(hashEvent(first));
    expect(third.prevHash).toBe(hashEvent(second));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      store.appendMany([
        { aggregateId: 'task:tsk_1', type: 'task.published', payload: {} },
        { aggregateId: 'task:tsk_1', type: 'task.published', payload: circular },
      ]),
    ).toThrow();
    expect(store.count()).toBe(3);
    expect(store.head()).toBe(3);
  });

  it('uses an injected clock for deterministic timestamps', () => {
    const { store } = makeCore();
    const first = store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: {} });
    const second = store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: {} });
    expect([first.ts, second.ts]).toEqual([FIXED_TS, FIXED_TS + 1]);
  });
});

describe('event envelope helpers', () => {
  it('parses aggregate ids', () => {
    expect(aggregateIdOf('task', 'tsk_1')).toBe('task:tsk_1');
    expect(parseAggregateId('task:tsk_1')).toEqual({ kind: 'task', id: 'tsk_1' });
    expect(parseAggregateId('message:msg:a:b')).toEqual({ kind: 'message', id: 'msg:a:b' });
    expect(tryParseAggregateId('gadget:1')).toBeUndefined();
    expect(tryParseAggregateId('task:')).toBeUndefined();
    expect(tryParseAggregateId('nocolon')).toBeUndefined();
    expect(() => parseAggregateId('gadget:1')).toThrow(/invalid aggregateId/);
    expect(() => aggregateIdOf('task', '')).toThrow();
  });

  it('hashes envelopes canonically (key order independent)', () => {
    const a = makeEvent({
      seq: 1,
      version: 1,
      type: 'task.published',
      aggregateId: 'task:tsk_1',
      payload: { title: 'x', tags: ['a', 'b'] },
    });
    const b = makeEvent({
      seq: 1,
      version: 1,
      type: 'task.published',
      aggregateId: 'task:tsk_1',
      payload: { tags: ['a', 'b'], title: 'x' },
    });
    expect(hashEvent(a)).toBe(hashEvent(b));
    expect(hashEvent(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
