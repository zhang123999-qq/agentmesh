import { describe, expect, it } from 'vitest';

import {
  initialTaskState,
  reduceEvents,
  replayAggregate,
  replayAggregateWithLatestSnapshot,
  replayFromSnapshot,
  taskReducer,
  type CoreEvent,
  type EventStore,
} from '../src/index.js';
import { makeCore } from './helpers.js';

const AGG = 'task:tsk_1';

/** published → bid → awarded → progress (4 events, versions 1..4). */
function seedTask(store: EventStore): CoreEvent[] {
  return store.appendMany([
    {
      aggregateId: AGG,
      type: 'task.published',
      payload: { taskId: 'tsk_1', title: 'ship it', budget: 100 },
    },
    {
      aggregateId: AGG,
      type: 'task.bid.placed',
      payload: { bidId: 'bid_1', agentId: 'agt_1', price: 80 },
    },
    {
      aggregateId: AGG,
      type: 'task.awarded',
      payload: { taskId: 'tsk_1', awardeeId: 'agt_1', awardedBy: 'agt_admin' },
    },
    {
      aggregateId: AGG,
      type: 'task.progress.reported',
      payload: { taskId: 'tsk_1', agentId: 'agt_1', progress: 40 },
    },
  ]);
}

describe('replay', () => {
  it('full replay rebuilds the same state as live folding', () => {
    const { store } = makeCore();
    const events = seedTask(store);

    const replayed = replayAggregate(store, AGG, taskReducer, initialTaskState(AGG));
    expect(replayed.state).toEqual(reduceEvents(events, taskReducer, initialTaskState(AGG)));
    expect(replayed).toMatchObject({ version: 4, lastSeq: 4, applied: 4, fromSnapshot: false });
    expect(replayed.state).toMatchObject({
      status: 'in_progress',
      assignee: 'agt_1',
      progress: 40,
    });
  });

  it('ignores other aggregates interleaved in the global log', () => {
    const { store } = makeCore();
    store.append({ aggregateId: 'channel:chn_1', type: 'channel.created', payload: { name: 'c' } });
    const taskEvents = seedTask(store);
    store.append({ aggregateId: 'channel:chn_1', type: 'channel.member.joined', payload: { agentId: 'a' } });

    const replayed = replayAggregate(store, AGG, taskReducer, initialTaskState(AGG));
    expect(replayed.applied).toBe(taskEvents.length);
    expect(replayed.state.title).toBe('ship it');
    expect(replayed.lastSeq).toBe(5);
  });

  it('replays from a snapshot plus increments to the full-replay state', () => {
    const { store } = makeCore();
    const history = seedTask(store);
    const prefix = history.slice(0, 2);
    const prefixState = reduceEvents(prefix, taskReducer, initialTaskState(AGG));
    const snapshot = {
      aggregateId: AGG,
      version: 2,
      seq: prefix[1]?.seq ?? 0,
      state: prefixState,
      ts: 1,
    };

    const full = replayAggregate(store, AGG, taskReducer, initialTaskState(AGG));
    const fromSnapshot = replayFromSnapshot(snapshot, history, taskReducer);

    expect(fromSnapshot.state).toEqual(full.state);
    expect(fromSnapshot).toMatchObject({ version: 4, lastSeq: 4, applied: 2, fromSnapshot: true });
  });

  it('replayFromSnapshot ignores events already covered by the snapshot', () => {
    const { store } = makeCore();
    const history = seedTask(store);
    const prefix = history.slice(0, 3);
    const snapshot = {
      aggregateId: AGG,
      version: 3,
      seq: prefix[2]?.seq ?? 0,
      state: reduceEvents(prefix, taskReducer, initialTaskState(AGG)),
      ts: 1,
    };

    const fromSnapshot = replayFromSnapshot(snapshot, history, taskReducer);
    expect(fromSnapshot.applied).toBe(1);
    expect(fromSnapshot.version).toBe(4);
    expect(fromSnapshot.state.progress).toBe(40);
  });

  it('handles an empty aggregate', () => {
    const { store } = makeCore();
    const replayed = replayAggregate(store, 'task:none', taskReducer, initialTaskState('task:none'));
    expect(replayed).toEqual({
      state: initialTaskState('task:none'),
      version: 0,
      lastSeq: 0,
      applied: 0,
      fromSnapshot: false,
    });
  });

  it('replayAggregateWithLatestSnapshot falls back to full replay when none exists', () => {
    const { store } = makeCore();
    seedTask(store);
    const snapshots = { latest: () => undefined };
    const replayed = replayAggregateWithLatestSnapshot(
      store,
      snapshots,
      AGG,
      taskReducer,
      initialTaskState(AGG),
    );
    expect(replayed.fromSnapshot).toBe(false);
    expect(replayed.applied).toBe(4);
    expect(replayed.state.version).toBe(4);
  });
});
