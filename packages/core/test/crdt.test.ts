import { describe, expect, it } from 'vitest';

import {
  addOrSet,
  bidStableFrontier,
  compactBids,
  compactOrSet,
  emptyOrSet,
  isElementLive,
  liveElements,
  liveTags,
  mergeOrSets,
  orSetFromBidRows,
  orSetTag,
  removeOrSetTags,
  tagCounter,
  type OrSetState,
} from '../src/index.js';
import {
  compareLwwStamps,
  createLww,
  LwwMap,
  lwwStamp,
  mergeLww,
} from '../src/index.js';

type Op =
  | { kind: 'add'; element: string; tag: string }
  | { kind: 'remove'; tags: string[] };

function applyOps(ops: readonly Op[]): OrSetState {
  let state = emptyOrSet();
  for (const op of ops) {
    state =
      op.kind === 'add'
        ? addOrSet(state, op.element, op.tag)
        : removeOrSetTags(state, op.tags);
  }
  return state;
}

describe('OR-Set', () => {
  const t1 = orSetTag(1, 'node-a');
  const t2 = orSetTag(2, 'node-a');
  const t3 = orSetTag(3, 'node-b');

  it('adds, removes and reports live elements', () => {
    let set = emptyOrSet();
    set = addOrSet(set, 'agt_a', t1);
    set = addOrSet(set, 'agt_b', t2);
    expect(liveElements(set)).toEqual(['agt_a', 'agt_b']);

    set = removeOrSetTags(set, [t1]);
    expect(liveElements(set)).toEqual(['agt_b']);
    expect(isElementLive(set, 'agt_a')).toBe(false);
  });

  it('keeps one live element when the same agent is added twice', () => {
    let set = addOrSet(emptyOrSet(), 'agt_a', t1);
    set = addOrSet(set, 'agt_a', t2);
    expect(liveElements(set)).toEqual(['agt_a']);
    expect(liveTags(set, 'agt_a')).toEqual([t1, t2]);
  });

  it('converges under different operation orders', () => {
    const ops: Op[] = [
      { kind: 'add', element: 'agt_a', tag: t1 },
      { kind: 'add', element: 'agt_b', tag: t2 },
      { kind: 'remove', tags: [t1] },
      { kind: 'add', element: 'agt_a', tag: t3 },
    ];
    const orders: Op[][] = [
      ops,
      [...ops].reverse(),
      [ops[0]!, ops[2]!, ops[1]!, ops[3]!],
      [ops[2]!, ops[0]!, ops[3]!, ops[1]!],
    ];
    const results = orders.map((order) => liveElements(applyOps(order)));
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]).toEqual(['agt_a', 'agt_b']);
  });

  it('merge is commutative, associative and idempotent', () => {
    const left = applyOps([
      { kind: 'add', element: 'agt_a', tag: t1 },
      { kind: 'add', element: 'agt_b', tag: t2 },
    ]);
    const right = applyOps([
      { kind: 'remove', tags: [t1] },
      { kind: 'add', element: 'agt_a', tag: t3 },
    ]);

    expect(liveElements(mergeOrSets(left, right))).toEqual(
      liveElements(mergeOrSets(right, left)),
    );
    expect(liveElements(mergeOrSets(mergeOrSets(left, right), left))).toEqual(
      liveElements(mergeOrSets(left, right)),
    );
    expect(liveElements(mergeOrSets(right, right))).toEqual(liveElements(right));
  });

  it('compacts dead tags without changing the live set', () => {
    const set = applyOps([
      { kind: 'add', element: 'agt_a', tag: t1 },
      { kind: 'add', element: 'agt_b', tag: t2 },
      { kind: 'add', element: 'agt_c', tag: t3 },
      { kind: 'remove', tags: [t1] },
      { kind: 'remove', tags: [t3] },
    ]);
    const before = liveElements(set);
    expect(before).toEqual(['agt_b']);

    const compacted = compactOrSet(set, 3);
    expect(liveElements(compacted)).toEqual(before);
    // Dead tags at/below the frontier are gone; live tags are retained.
    expect(compacted.removed.size).toBe(0);
    expect(liveTags(compacted, 'agt_b')).toEqual([t2]);
    expect(liveTags(compacted, 'agt_a')).toEqual([]);
  });

  it('builds the bid OR-Set from task_bids rows and compacts at stableFrontier', () => {
    const rows = [
      { id: 'bid_1', agentId: 'agt_a', tombstone: false, createdAt: 1, stableFrontier: 3 },
      { id: 'bid_2', agentId: 'agt_b', tombstone: false, createdAt: 2, stableFrontier: 3 },
      { id: 'bid_3', agentId: 'agt_a', tombstone: true, createdAt: 3, stableFrontier: 3 },
    ];
    const set = orSetFromBidRows(rows);
    expect(liveElements(set)).toEqual(['agt_a', 'agt_b']);
    expect(bidStableFrontier(rows)).toBe(3);
    expect(liveElements(compactBids(rows))).toEqual(['agt_a', 'agt_b']);
    expect(tagCounter(orSetTag(12, 'node'))).toBe(12);
  });
});

describe('LWW-Register / LWW-Map', () => {
  const s1 = lwwStamp(1, 'node-a');
  const s2 = lwwStamp(2, 'node-a');
  const s2b = lwwStamp(2, 'node-b');

  it('orders by counter then nodeId', () => {
    expect(compareLwwStamps(s1, s2)).toBeLessThan(0);
    expect(compareLwwStamps(s2, s2b)).toBeLessThan(0);
    expect(compareLwwStamps(s2, s2)).toBe(0);
  });

  it('merges by the higher stamp and is idempotent', () => {
    const older = createLww({ status: 'online' }, s1);
    const newer = createLww({ status: 'offline' }, s2);
    expect(mergeLww(older, newer).value).toEqual({ status: 'offline' });
    expect(mergeLww(newer, older).value).toEqual({ status: 'offline' });
    expect(mergeLww(newer, newer)).toEqual(newer);
  });

  it('resolves equal-counter conflicts deterministically by nodeId', () => {
    const a = createLww({ status: 'away' }, s2);
    const b = createLww({ status: 'offline' }, s2b);
    expect(mergeLww(a, b).value).toEqual(b.value);
    expect(mergeLww(b, a).value).toEqual(b.value);
  });

  it('LWW-Map converges under merge order and never hard-deletes', () => {
    const first = new LwwMap<string, { status: string }>();
    first.set('agt_a', { status: 'online' }, s1);
    first.set('agt_b', { status: 'online' }, s1);

    const second = new LwwMap<string, { status: string }>();
    second.set('agt_a', { status: 'offline' }, s2);
    second.set('agt_b', { status: 'away' }, s2);

    const left = new LwwMap<string, { status: string }>();
    left.merge(first);
    left.merge(second);
    const right = new LwwMap<string, { status: string }>();
    right.merge(second);
    right.merge(first);

    expect(left.entries()).toEqual(right.entries());
    expect(left.get('agt_a')).toEqual({ status: 'offline' });
    expect(left.get('agt_b')).toEqual({ status: 'away' });
    expect(left.has('agt_a')).toBe(true);
  });
});
