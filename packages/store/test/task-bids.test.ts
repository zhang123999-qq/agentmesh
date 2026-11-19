import { describe, expect, it } from 'vitest';

import { makeStore } from './helpers.js';

describe('TaskBidsDao', () => {
  it('creates a live bid with OR-Set metadata defaults', () => {
    const { repos } = makeStore();
    const bid = repos.taskBids.create({
      id: 'bid_1',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 99.5,
      eta: 30,
      approach: 'do it with tests',
      confidence: 0.8,
      createdAt: 11,
    });

    expect(bid).toMatchObject({
      id: 'bid_1',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 99.5,
      eta: 30,
      approach: 'do it with tests',
      confidence: 0.8,
      tombstone: false,
      deletedAt: null,
      stableFrontier: null,
      createdAt: 11,
      workspaceId: 'default',
    });
    expect(repos.taskBids.get('bid_1')).toEqual(bid);
    expect(repos.taskBids.get('bid_1', 'other-ws')).toBeUndefined();
  });

  it('upsertByAgent overwrites the bid of the same (task, agent) instead of adding a row', () => {
    const { repos } = makeStore();
    const first = repos.taskBids.upsertByAgent({
      id: 'bid_1',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 100,
      eta: 60,
    });
    const second = repos.taskBids.upsertByAgent({
      id: 'bid_2',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 80,
      eta: 45,
      confidence: 0.9,
    });

    expect(second.id).toBe(first.id);
    expect(second.price).toBe(80);
    expect(second.eta).toBe(45);
    expect(second.confidence).toBe(0.9);
    expect(repos.taskBids.count('tsk_1')).toBe(1);
    expect(repos.taskBids.count('tsk_1', { includeTombstones: true })).toBe(1);
  });

  it('upserts per workspace instead of silently keeping a stale bid elsewhere', () => {
    const { repos } = makeStore();
    const inDefault = repos.taskBids.upsertByAgent({
      id: 'bid_default',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 10,
    });
    expect(inDefault.workspaceId).toBe('default');
    const other = repos.taskBids.upsertByAgent({
      id: 'bid_other',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 20,
      workspaceId: 'ws-2',
    });
    expect(other.id).toBe('bid_other');
    expect(other.workspaceId).toBe('ws-2');
    expect(other.price).toBe(20);

    // The second upsert in ws-2 must actually update the ws-2 row, not fall
    // back to the (invisible) default-workspace row.
    const again = repos.taskBids.upsertByAgent({
      id: 'bid_other_2',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 33,
      eta: 7,
      workspaceId: 'ws-2',
    });
    expect(again.id).toBe('bid_other');
    expect(again.price).toBe(33);
    expect(again.eta).toBe(7);
    expect(again.workspaceId).toBe('ws-2');

    expect(repos.taskBids.get('bid_default')?.price).toBe(10);
    expect(repos.taskBids.listByTask('tsk_1').map((b) => b.id)).toEqual(['bid_default']);
    expect(
      repos.taskBids.listByTask('tsk_1', { workspaceId: 'ws-2' }).map((b) => b.id),
    ).toEqual(['bid_other']);
    expect(repos.taskBids.count('tsk_1', { workspaceId: 'ws-2' })).toBe(1);
  });

  it('keeps bids from different agents apart and orders them by creation', () => {
    const { repos } = makeStore();
    repos.taskBids.create({
      id: 'b1',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 10,
      createdAt: 2,
    });
    repos.taskBids.create({
      id: 'b2',
      taskId: 'tsk_1',
      agentId: 'agt_2',
      price: 20,
      createdAt: 1,
    });
    repos.taskBids.create({ id: 'b3', taskId: 'tsk_2', agentId: 'agt_1', price: 5 });

    expect(repos.taskBids.listByTask('tsk_1').map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(repos.taskBids.findLiveByTaskAndAgent('tsk_1', 'agt_2')?.id).toBe('b2');
    expect(repos.taskBids.findLiveByTaskAndAgent('tsk_1', 'agt_3')).toBeUndefined();
    expect(repos.taskBids.listByAgent('agt_1').map((b) => b.id)).toEqual(['b1', 'b3']);
  });

  it('markDeleted writes a tombstone but keeps the row (no physical delete)', () => {
    const { repos } = makeStore();
    repos.taskBids.create({ id: 'b1', taskId: 'tsk_1', agentId: 'agt_1', price: 10 });

    expect(repos.taskBids.markDeleted('b1', 999)).toBe(true);
    const tombstoned = repos.taskBids.get('b1');
    expect(tombstoned).toBeDefined();
    expect(tombstoned?.tombstone).toBe(true);
    expect(tombstoned?.deletedAt).toBe(999);

    // Live queries hide it; explicit opt-in reveals it.
    expect(repos.taskBids.listByTask('tsk_1')).toHaveLength(0);
    expect(repos.taskBids.listByTask('tsk_1', { includeTombstones: true })).toHaveLength(1);
    expect(repos.taskBids.count('tsk_1')).toBe(0);
    expect(repos.taskBids.count('tsk_1', { includeTombstones: true })).toBe(1);
    expect(repos.taskBids.findLiveByTaskAndAgent('tsk_1', 'agt_1')).toBeUndefined();

    // Idempotent: a second delete keeps the original deleted_at.
    expect(repos.taskBids.markDeleted('b1', 1_000)).toBe(true);
    expect(repos.taskBids.get('b1')?.deletedAt).toBe(999);
    expect(repos.taskBids.markDeleted('missing')).toBe(false);
  });

  it('a re-bid after a tombstone creates a fresh live row (OR-Set add wins)', () => {
    const { repos } = makeStore();
    repos.taskBids.create({ id: 'b1', taskId: 'tsk_1', agentId: 'agt_1', price: 10 });
    repos.taskBids.markDeleted('b1');

    const again = repos.taskBids.upsertByAgent({
      id: 'b2',
      taskId: 'tsk_1',
      agentId: 'agt_1',
      price: 12,
    });
    expect(again.id).toBe('b2');
    expect(again.tombstone).toBe(false);
    expect(repos.taskBids.listByTask('tsk_1').map((b) => b.id)).toEqual(['b2']);
    expect(repos.taskBids.count('tsk_1', { includeTombstones: true })).toBe(2);
  });

  it('advances the aggregate stable_frontier monotonically', () => {
    const { repos } = makeStore();
    repos.taskBids.create({ id: 'b1', taskId: 'tsk_1', agentId: 'agt_1', price: 10 });
    repos.taskBids.create({ id: 'b2', taskId: 'tsk_1', agentId: 'agt_2', price: 20 });

    expect(repos.taskBids.getStableFrontier('tsk_1')).toBe(0);
    expect(repos.taskBids.setStableFrontier('tsk_1', 5)).toBe(2);
    expect(repos.taskBids.getStableFrontier('tsk_1')).toBe(5);

    // A stale compactor cannot move the cursor backwards.
    expect(repos.taskBids.setStableFrontier('tsk_1', 3)).toBe(0);
    expect(repos.taskBids.getStableFrontier('tsk_1')).toBe(5);

    expect(repos.taskBids.setStableFrontier('tsk_1', 9)).toBe(2);
    expect(repos.taskBids.getStableFrontier('tsk_1')).toBe(9);
    expect(repos.taskBids.listByTask('tsk_1').map((b) => b.stableFrontier)).toEqual([9, 9]);
  });

  it('updates bid fields and physically deletes for compaction/tests only', () => {
    const { repos } = makeStore();
    repos.taskBids.create({ id: 'b1', taskId: 'tsk_1', agentId: 'agt_1', price: 10 });

    const updated = repos.taskBids.update('b1', { price: 11, confidence: 0.5, eta: 3 });
    expect(updated?.price).toBe(11);
    expect(updated?.confidence).toBe(0.5);
    expect(repos.taskBids.update('b1', {})?.price).toBe(11);
    expect(repos.taskBids.update('missing', { price: 1 })).toBeUndefined();

    expect(repos.taskBids.delete('b1')).toBe(true);
    expect(repos.taskBids.delete('b1')).toBe(false);
    expect(repos.taskBids.count('tsk_1', { includeTombstones: true })).toBe(0);
  });
});
