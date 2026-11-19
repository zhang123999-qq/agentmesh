import { describe, expect, it } from 'vitest';

import { TokenBucketRegistry } from '../src/ws/session.js';

describe('TokenBucketRegistry', () => {
  it('evicts the oldest bucket when the identity ceiling is reached', () => {
    const registry = new TokenBucketRegistry({
      ratePerSecond: 1,
      burst: 1,
      maxEntries: 2,
      clock: () => 1_000,
    });

    registry.get('agt_a');
    registry.get('agt_b');
    registry.get('agt_c');

    expect(registry.size).toBe(2);
    // The first key was evicted; a fresh access recreates it (and evicts another).
    expect(registry.get('agt_a')).toBeDefined();
    expect(registry.size).toBe(2);
  });
});
