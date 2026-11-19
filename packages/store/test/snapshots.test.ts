import { describe, expect, it } from 'vitest';

import { makeStore } from './helpers.js';

const base = {
  aggregateId: 'task:tsk_1',
  seq: 10,
  state: { status: 'open', version: 1 },
  ts: 1_700_000_000_000,
};

describe('SnapshotsDao', () => {
  it('saves a snapshot and reads it back (state deserialised)', () => {
    const { repos } = makeStore();
    const saved = repos.snapshots.save({ ...base, version: 1 });
    expect(saved).toEqual({ ...base, version: 1, workspaceId: 'default' });

    const loaded = repos.snapshots.get('task:tsk_1', 1);
    expect(loaded?.state).toEqual({ status: 'open', version: 1 });
    expect(loaded?.seq).toBe(10);
    expect(repos.snapshots.get('task:tsk_1', 2)).toBeUndefined();
  });

  it('upserts on (aggregate_id, version) instead of duplicating', () => {
    const { repos } = makeStore();
    repos.snapshots.save({ ...base, version: 1, seq: 10, state: { a: 1 } });
    repos.snapshots.save({ ...base, version: 1, seq: 11, state: { a: 2 } });

    expect(repos.snapshots.count('task:tsk_1')).toBe(1);
    expect(repos.snapshots.get('task:tsk_1', 1)?.seq).toBe(11);
    expect(repos.snapshots.get('task:tsk_1', 1)?.state).toEqual({ a: 2 });
  });

  it('latest() returns the highest version', () => {
    const { repos } = makeStore();
    repos.snapshots.save({ ...base, version: 1, state: { v: 1 } });
    repos.snapshots.save({ ...base, version: 5, state: { v: 5 } });
    repos.snapshots.save({ ...base, version: 3, state: { v: 3 } });

    expect(repos.snapshots.latest('task:tsk_1')?.version).toBe(5);
    expect(repos.snapshots.latest('task:missing')).toBeUndefined();
    expect(repos.snapshots.list('task:tsk_1').map((s) => s.version)).toEqual([5, 3, 1]);
    expect(repos.snapshots.list('task:tsk_1', { limit: 2 }).map((s) => s.version)).toEqual([5, 3]);
  });

  it('prunes old snapshots keeping the newest N', () => {
    const { repos } = makeStore();
    for (const version of [1, 2, 3, 4]) {
      repos.snapshots.save({ ...base, version });
    }
    expect(repos.snapshots.prune('task:tsk_1', 2)).toBe(2);
    expect(repos.snapshots.list('task:tsk_1').map((s) => s.version)).toEqual([4, 3]);
    expect(repos.snapshots.prune('task:tsk_1', 0)).toBe(2);
    expect(repos.snapshots.count('task:tsk_1')).toBe(0);
  });

  it('isolates workspaces', () => {
    const { repos } = makeStore();
    repos.snapshots.save({ ...base, version: 1, workspaceId: 'other-ws' });

    expect(repos.snapshots.latest('task:tsk_1')).toBeUndefined();
    expect(repos.snapshots.count()).toBe(0);
    expect(repos.snapshots.latest('task:tsk_1', 'other-ws')?.version).toBe(1);
    expect(repos.snapshots.count(undefined, 'other-ws')).toBe(1);
  });
});
