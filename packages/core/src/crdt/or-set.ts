/**
 * Pure OR-Set (observed-remove set) used by the bid set.
 *
 * Each `add` carries a unique tag. A `remove` is a set of observed tags, so a
 * concurrent add with an unseen tag survives the merge. The implementation is
 * immutable (every operation returns a new state), which makes merge
 * commutative/associative/idempotent and easy to property-test.
 *
 * Tags are `"<counter>|<writer>"` with a zero-padded counter, so lexicographic
 * order equals counter order and `stable_frontier` compaction is a simple
 * `counter <= frontier` test.
 */

export interface OrSetState {
  readonly adds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly removed: ReadonlySet<string>;
}

export function emptyOrSet(): OrSetState {
  return { adds: new Map(), removed: new Set() };
}

export function orSetTag(counter: number, writer: string): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError('OR-Set counter must be a non-negative safe integer');
  }
  if (writer.length === 0) {
    throw new TypeError('OR-Set writer must not be empty');
  }
  return `${String(counter).padStart(16, '0')}|${writer}`;
}

export function tagCounter(tag: string): number {
  const separator = tag.indexOf('|');
  if (separator <= 0) throw new TypeError(`invalid OR-Set tag: ${tag}`);
  const counter = Number(tag.slice(0, separator));
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError(`invalid OR-Set tag counter: ${tag}`);
  }
  return counter;
}

function cloneAdds(
  adds: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const copy = new Map<string, Set<string>>();
  for (const [element, tags] of adds) copy.set(element, new Set(tags));
  return copy;
}

/** Add `element` with a unique tag; duplicate tags are idempotent. */
export function addOrSet(
  state: OrSetState,
  element: string,
  tag: string,
): OrSetState {
  if (element.length === 0) throw new TypeError('OR-Set element must not be empty');
  const adds = cloneAdds(state.adds);
  const tags = adds.get(element) ?? new Set<string>();
  if (tags.has(tag)) return state;
  tags.add(tag);
  adds.set(element, tags);
  return { adds, removed: new Set(state.removed) };
}

/** Remove every observed tag (the OR-Set "remove" operation). */
export function removeOrSetTags(
  state: OrSetState,
  tags: readonly string[],
): OrSetState {
  if (tags.length === 0) return state;
  const removed = new Set(state.removed);
  let changed = false;
  for (const tag of tags) {
    if (!removed.has(tag)) {
      removed.add(tag);
      changed = true;
    }
  }
  return changed ? { adds: cloneAdds(state.adds), removed } : state;
}

/** Remove all currently observed tags of an element. */
export function removeOrSetElement(
  state: OrSetState,
  element: string,
): OrSetState {
  const tags = state.adds.get(element);
  return tags === undefined ? state : removeOrSetTags(state, [...tags]);
}

/** Union of adds and tombstones; a removed tag always wins. */
export function mergeOrSets(a: OrSetState, b: OrSetState): OrSetState {
  const adds = cloneAdds(a.adds);
  for (const [element, tags] of b.adds) {
    const target = adds.get(element) ?? new Set<string>();
    for (const tag of tags) target.add(tag);
    adds.set(element, target);
  }
  const removed = new Set(a.removed);
  for (const tag of b.removed) removed.add(tag);
  return { adds, removed };
}

export function liveTags(state: OrSetState, element: string): string[] {
  const tags = state.adds.get(element);
  if (tags === undefined) return [];
  return [...tags].filter((tag) => !state.removed.has(tag)).sort();
}

export function isElementLive(state: OrSetState, element: string): boolean {
  return liveTags(state, element).length > 0;
}

/** Live elements, sorted, each unique (duplicate adds never duplicate a key). */
export function liveElements(state: OrSetState): string[] {
  const live: string[] = [];
  for (const element of state.adds.keys()) {
    if (isElementLive(state, element)) live.push(element);
  }
  return live.sort();
}

/**
 * Drop tombstones at or below `frontier` and the dead add tags they cover.
 *
 * Live add tags are **never** dropped: they are the proof of liveness. Only
 * tags already in `removed` are compacted, so the live set is unchanged.
 */
export function compactOrSet(state: OrSetState, frontier: number): OrSetState {
  if (!Number.isSafeInteger(frontier) || frontier < 0) {
    throw new TypeError('OR-Set frontier must be a non-negative safe integer');
  }
  const adds = new Map<string, Set<string>>();
  for (const [element, tags] of state.adds) {
    const kept = new Set<string>();
    for (const tag of tags) {
      const dead = state.removed.has(tag);
      if (dead && tagCounter(tag) <= frontier) continue;
      kept.add(tag);
    }
    if (kept.size > 0) adds.set(element, kept);
  }
  const removed = new Set<string>();
  for (const tag of state.removed) {
    if (tagCounter(tag) > frontier) removed.add(tag);
  }
  return { adds, removed };
}

export interface BidOrSetRow {
  readonly id: string;
  readonly agentId: string;
  readonly tombstone: boolean;
  readonly createdAt: number;
  readonly stableFrontier: number | null;
}

/**
 * Build the bid OR-Set view over `task_bids` rows.
 *
 * Element = agent id (one live bid per agent); tag = `createdAt|bidId`. A
 * tombstoned row becomes a removed tag, so a concurrent add with a newer tag
 * still survives. `stableFrontier` rows can be compacted with
 * {@link compactBids}.
 */
export function orSetFromBidRows(rows: readonly BidOrSetRow[]): OrSetState {
  let state = emptyOrSet();
  for (const row of rows) {
    const tag = orSetTag(row.createdAt, row.id);
    state = addOrSet(state, row.agentId, tag);
    if (row.tombstone) state = removeOrSetTags(state, [tag]);
  }
  return state;
}

/** Highest `stableFrontier` across bid rows (0 when none). */
export function bidStableFrontier(rows: readonly BidOrSetRow[]): number {
  let frontier = 0;
  for (const row of rows) {
    if (row.stableFrontier !== null && row.stableFrontier > frontier) {
      frontier = row.stableFrontier;
    }
  }
  return frontier;
}

export function compactBids(
  rows: readonly BidOrSetRow[],
  frontier: number = bidStableFrontier(rows),
): OrSetState {
  return compactOrSet(orSetFromBidRows(rows), frontier);
}
