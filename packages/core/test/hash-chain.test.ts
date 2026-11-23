import { describe, expect, it } from 'vitest';

import { verifyEventChainBatched } from '../src/index.js';
import { makeCore } from './helpers.js';

/**
 * US-021C: batched hash-chain verification. Must survive a large log without
 * loading it all into memory, and must report the first broken link by
 * `seq` + `aggregateId`.
 */
describe('verifyEventChainBatched', () => {
  it('verifies a normal chain in batches and counts every event', () => {
    const { store } = makeCore();
    for (let i = 0; i < 7; i += 1) {
      store.append({ aggregateId: `task:tsk_${i}`, type: 'task.published', payload: { i } });
    }

    const result = store.verifyChain({ batchSize: 2 });
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(7);
    expect(result.mismatch).toBeUndefined();
  });

  it('detects a tampered event and reports the following link by seq + aggregateId', () => {
    const { store, db } = makeCore();
    const e1 = store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: { a: 1 } });
    store.append({ aggregateId: 'channel:chn_1', type: 'channel.created', payload: { b: 2 } });
    store.append({ aggregateId: 'task:tsk_1', type: 'task.awarded', payload: { c: 3 } });

    // Tamper the payload of the first event out-of-band.
    db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify({ a: 999 }), e1.seq);

    const result = store.verifyChain({ batchSize: 1 });
    expect(result.valid).toBe(false);
    // The link that breaks is the *next* event (seq 2), whose prevHash points at
    // the original hash of event 1.
    expect(result.mismatch?.seq).toBe(2);
    expect(result.mismatch?.aggregateId).toBe('channel:chn_1');
    expect(result.mismatch?.expectedPrevHash).not.toBe(result.mismatch?.actualPrevHash);
  });

  it('crosses batch boundaries while still checking consecutive links', () => {
    const { store } = makeCore();
    for (let i = 0; i < 5; i += 1) {
      store.append({ aggregateId: `task:tsk_${i}`, type: 'task.published', payload: { i } });
    }

    // Prove the loader is actually paged: record the afterSeq values requested.
    const requested: number[] = [];
    const loadBatch = (afterSeq: number, limit: number) => {
      requested.push(afterSeq);
      return store.readAfter(afterSeq, limit);
    };
    const result = verifyEventChainBatched(loadBatch, { batchSize: 2 });
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(5);
    // [1,2] -> after 0; [3,4] -> after 2; [5] (len < batchSize) -> after 4, stop.
    expect(requested).toEqual([0, 2, 4]);
  });
});
