/**
 * @agentmesh/core — event-sourcing core for AgentMesh.
 *
 * - {@link EventStore}: append/read facade over `@agentmesh/store`'s
 *   `events` table, adding per-aggregate versions and optional `prevHash`
 *   hash-chain links.
 * - Reducers per aggregate kind (account / channel / message / task).
 * - {@link replayAggregate}: rebuild state from the log.
 * - {@link SnapshotStore} / {@link Snapshotter}: periodic checkpoints and
 *   snapshot + incremental replay.
 *
 * ```ts
 * import { EventStore, replayAggregate, taskReducer, initialTaskState } from '@agentmesh/core';
 *
 * const store = new EventStore(db);
 * store.append({ aggregateId: 'task:tsk_1', type: 'task.published', payload: { title: 'x' } });
 * const { state } = replayAggregate(store, 'task:tsk_1', taskReducer, initialTaskState('task:tsk_1'));
 * ```
 */

export * from './envelope.js';
export * from './event-store.js';
export * from './payload.js';
export * from './reducer.js';
export * from './reducers/index.js';
export * from './replay.js';
export * from './snapshot.js';
