/**
 * LWW-Register / LWW-Map with a logical stamp `(counter, nodeId)`.
 *
 * Physical clocks are not a valid tie-breaker across nodes; the counter is a
 * Lamport-style logical clock and `nodeId` breaks equal-counter ties
 * deterministically. Merge is commutative, associative and idempotent.
 */

export interface LwwStamp {
  readonly counter: number;
  readonly nodeId: string;
}

export interface LwwValue<T> {
  readonly value: T;
  readonly stamp: LwwStamp;
}

export function lwwStamp(counter: number, nodeId: string): LwwStamp {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new TypeError('LWW counter must be a non-negative safe integer');
  }
  if (nodeId.length === 0) throw new TypeError('LWW nodeId must not be empty');
  return { counter, nodeId };
}

export function createLww<T>(value: T, stamp: LwwStamp): LwwValue<T> {
  return { value, stamp };
}

/** Negative when `a` is older, positive when newer, 0 when identical. */
export function compareLwwStamps(a: LwwStamp, b: LwwStamp): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.nodeId.localeCompare(b.nodeId);
}

function stableValueKey(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      const source = input as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) sorted[key] = sort(source[key]);
      return sorted;
    }
    return input;
  };
  return JSON.stringify(sort(value)) ?? 'undefined';
}

/**
 * Merge two registers. A higher stamp wins; equal stamps with equal values
 * return `a`; equal stamps with conflicting values use a deterministic value
 * ordering (so two replicas still converge on the same winner).
 */
export function mergeLww<T>(a: LwwValue<T>, b: LwwValue<T>): LwwValue<T> {
  const order = compareLwwStamps(a.stamp, b.stamp);
  if (order > 0) return a;
  if (order < 0) return b;
  if (stableValueKey(a.value) === stableValueKey(b.value)) return a;
  return stableValueKey(a.value) >= stableValueKey(b.value) ? a : b;
}

/** Last-writer-wins map (e.g. per-agent presence). Never hard-deletes. */
export class LwwMap<K, V> {
  readonly #entries = new Map<K, LwwValue<V>>();

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key)?.value;
  }

  /** Apply a value; an older stamp is ignored. */
  set(key: K, value: V, stamp: LwwStamp): void {
    const current = this.#entries.get(key);
    if (current === undefined) {
      this.#entries.set(key, createLww(value, stamp));
      return;
    }
    this.#entries.set(key, mergeLww(current, createLww(value, stamp)));
  }

  /** Merge another replica; commutative/idempotent per key. */
  merge(other: LwwMap<K, V>): void {
    for (const [key, incoming] of other.#entries) {
      const current = this.#entries.get(key);
      this.#entries.set(
        key,
        current === undefined ? incoming : mergeLww(current, incoming),
      );
    }
  }

  entries(): Array<[K, V]> {
    return [...this.#entries.entries()]
      .map(([key, entry]) => [key, entry.value] as [K, V])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }

  values(): V[] {
    return this.entries().map(([, value]) => value);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }
}
