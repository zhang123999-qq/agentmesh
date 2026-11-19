import { describe, expect, it } from 'vitest';

import {
  initialTaskState,
  reduceEvents,
  replayAggregate,
  replayFromSnapshot,
  SnapshotStore,
  Snapshotter,
  taskReducer,
  type CoreEvent,
} from '../src/index.js';
import { makeCore } from './helpers.js';

const AGG = 'task:tsk_1';

function seed(store: ReturnType<typeof makeCore>['store']): CoreEvent[] {
  return store.appendMany([
    { aggregateId: AGG, type: 'task.published', payload: { title: 'ship it' } },
    { aggregateId: AGG, type: 'task.bid.placed', payload: { bidId: 'bid_1', agentId: 'a', price: 5 } },
    { aggregateId: AGG, type: 'task.awarded', payload: { awardeeId: 'a', awardedBy: 'admin' } },
    { aggregateId: AGG, type: 'task.progress.reported', payload: { progress: 50 } },
  ]);
}

describe('SnapshotStore', () => {
  it('saves, upserts and lists checkpoints', () => {
    const { db } = makeCore();
    const snapshots = new SnapshotStore(db);
    const state = { progress: 1 };

    const saved = snapshots.save({ aggregateId: AGG, version: 1, seq: 1, state, ts: 10 });
    expect(saved).toEqual({ aggregateId: AGG, version: 1, seq: 1, state, ts: 10 });

    snapshots.save({ aggregateId: AGG, version: 2, seq: 4, state: { progress: 2 }, ts: 20 });
    snapshots.save({ aggregateId: AGG, version: 2, seq: 5, state: { progress: 3 }, ts: 30 });

    expect(snapshots.get(AGG, 2)?.seq).toBe(5);
    expect(snapshots.get(AGG, 2)?.state).toEqual({ progress: 3 });
    expect(snapshots.latest(AGG)?.version).toBe(2);
    expect(snapshots.list(AGG).map((s) => s.version)).toEqual([2, 1]);
    expect(snapshots.count(AGG)).toBe(2);
    expect(snapshots.count('task:other')).toBe(0);
  });

  it('prunes old checkpoints', () => {
    const { db } = makeCore();
    const snapshots = new SnapshotStore(db);
    for (const version of [1, 2, 3]) {
      snapshots.save({ aggregateId: AGG, version, seq: version, state: { version }, ts: 1 });
    }
    expect(snapshots.prune(AGG, 1)).toBe(2);
    expect(snapshots.list(AGG).map((s) => s.version)).toEqual([3]);
  });
});

describe('Snapshotter', () => {
  it('takes a checkpoint every N versions and no more', () => {
    const { db, store } = makeCore();
    const snapshots = new SnapshotStore(db);
    const snapshotter = new Snapshotter(snapshots, { everyNEvents: 2, clock: () => 42 });
    const history = seed(store);

    const initial = initialTaskState(AGG);
    const results = history.map((event, index) => {
      const prefix = history.slice(0, index + 1);
      const state = reduceEvents(prefix, taskReducer, initial);
      return snapshotter.maybeTake({
        aggregateId: AGG,
        state,
        version: event.version,
        seq: event.seq,
      });
    });

    expect(results.map((snapshot) => snapshot?.version ?? null)).toEqual([null, 2, null, 4]);
    expect(snapshots.count(AGG)).toBe(2);
    expect(snapshots.latest(AGG)?.state).toMatchObject({ progress: 50 });
    expect(snapshots.latest(AGG)?.seq).toBe(4);
    expect(snapshots.latest(AGG)?.ts).toBe(42);
  });

  it('never duplicates the newest checkpoint', () => {
    const { db } = makeCore();
    const snapshots = new SnapshotStore(db);
    const snapshotter = new Snapshotter(snapshots, { everyNEvents: 1 });
    const input = { aggregateId: AGG, state: { x: 1 }, version: 1, seq: 1 };

    expect(snapshotter.maybeTake(input)).not.toBeNull();
    expect(snapshotter.maybeTake(input)).toBeNull();
    expect(snapshotter.maybeTakeNow(input)).toBeNull();
    expect(snapshotter.maybeTakeNow({ ...input, version: 2, seq: 2 })).not.toBeNull();
    expect(snapshots.count(AGG)).toBe(2);
  });

  it('skips snapshots for version 0', () => {
    const { db } = makeCore();
    const snapshotter = new Snapshotter(new SnapshotStore(db), { everyNEvents: 1 });
    expect(snapshotter.maybeTake({ aggregateId: AGG, state: {}, version: 0, seq: 0 })).toBeNull();
  });
});

describe('snapshot + incremental replay', () => {
  it('equals a full replay after persisting and reloading the checkpoint', () => {
    const { db, store } = makeCore();
    const snapshots = new SnapshotStore(db);
    const history = seed(store);

    const prefix = history.slice(0, 2);
    const checkpointState = reduceEvents(prefix, taskReducer, initialTaskState(AGG));
    snapshots.save({
      aggregateId: AGG,
      version: 2,
      seq: prefix[1]?.seq ?? 0,
      state: checkpointState,
      ts: 1,
    });

    const full = replayAggregate(store, AGG, taskReducer, initialTaskState(AGG));
    const checkpoint = snapshots.latest<ReturnType<typeof initialTaskState>>(AGG);
    expect(checkpoint).toBeDefined();
    if (!checkpoint) {
      throw new Error('expected a snapshot');
    }

    const incremental = replayFromSnapshot(checkpoint, history, taskReducer);
    expect(incremental.state).toEqual(full.state);
    expect(incremental).toMatchObject({ version: 4, lastSeq: 4, applied: 2, fromSnapshot: true });
  });
});
