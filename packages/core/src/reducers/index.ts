/**
 * Reducer registry: one reducer + initial-state factory per aggregate kind.
 *
 * `replayAnyAggregate` uses this to rebuild an aggregate from its id alone
 * (e.g. an admin audit endpoint), while strongly-typed callers can import the
 * concrete reducer directly.
 */

import type { AggregateKind } from '../envelope.js';
import type { CoreEvent } from '../envelope.js';
import type { Reducer } from '../reducer.js';

import { accountReducer, initialAccountState, type AccountState } from './account.js';
import { channelReducer, initialChannelState, type ChannelState } from './channel.js';
import { initialMessageState, messageReducer, type MessageState } from './message.js';
import { initialTaskState, taskReducer, type TaskState } from './task.js';

export * from './account.js';
export * from './channel.js';
export * from './message.js';
export * from './task.js';

export type AggregateState = AccountState | ChannelState | MessageState | TaskState;

export interface ReducerEntry<S> {
  reducer: Reducer<S>;
  initialState: (aggregateId: string) => S;
}

export interface ReducerRegistry {
  account: ReducerEntry<AccountState>;
  channel: ReducerEntry<ChannelState>;
  message: ReducerEntry<MessageState>;
  task: ReducerEntry<TaskState>;
}

export const reducers: ReducerRegistry = {
  account: { reducer: accountReducer, initialState: initialAccountState },
  channel: { reducer: channelReducer, initialState: initialChannelState },
  message: { reducer: messageReducer, initialState: initialMessageState },
  task: { reducer: taskReducer, initialState: initialTaskState },
};

/** Rebuild any known aggregate kind from its already-loaded events. */
export function reduceByKind(
  kind: AggregateKind,
  aggregateId: string,
  events: readonly CoreEvent[],
): AggregateState {
  const entry = reducers[kind] as ReducerEntry<AggregateState>;
  return events.reduce<AggregateState>(entry.reducer, entry.initialState(aggregateId));
}
