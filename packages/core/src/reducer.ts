/**
 * Reducer contract: a pure `(state, event) => state` fold over an aggregate's
 * event history. Reducers never read the database and never mutate `state` in
 * place, so replay is deterministic: same events in, same state out.
 */

import type { CoreEvent } from './envelope.js';

export type Reducer<S> = (state: S, event: CoreEvent) => S;

/**
 * Fold a sequence of events into a state. Events must already be in log order
 * (`seq` ascending) — callers use the EventStore for that guarantee.
 */
export function reduceEvents<S>(
  events: readonly CoreEvent[],
  reducer: Reducer<S>,
  initialState: S,
): S {
  let state = initialState;
  for (const event of events) {
    state = reducer(state, event);
  }
  return state;
}
