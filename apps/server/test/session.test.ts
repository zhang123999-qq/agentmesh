import { describe, expect, it } from 'vitest';

import { TokenBucketRegistry } from '../src/ws/session.js';

describe('TokenBucketRegistry', () => {
  it('evicts the least-recently-used bucket, keeping active identities', () => {
    const registry = new TokenBucketRegistry({
      ratePerSecond: 1,
      burst: 1,
      maxEntries: 2,
      clock: () => 1_000,
    });

    registry.get('agt_a');
    registry.get('agt_b');
    registry.get('agt_a'); // touch: a is now most-recently used
    registry.get('agt_c'); // must evict b, not a

    expect(registry.size).toBe(2);
    expect(registry.has('agt_a')).toBe(true);
    expect(registry.has('agt_b')).toBe(false);
  });
});
