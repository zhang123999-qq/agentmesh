import { afterEach, describe, expect, it } from 'vitest';

import { clearSeqRegistry, hasSeqBeenSeen, markSeqSeen } from '../src/lib/seq-registry.js';

/**
 * US-019 decision 3: a seq shared by the live stream and a history page must be
 * rendered exactly once across lists. These tests pin the dedup registry.
 */
describe('seq registry (US-019 decision 3)', () => {
  afterEach(() => clearSeqRegistry());

  it('marks a seq seen the first time and rejects repeats', () => {
    expect(markSeqSeen(5)).toBe(true);
    expect(markSeqSeen(5)).toBe(false);
    expect(markSeqSeen(5)).toBe(false);
    expect(hasSeqBeenSeen(5)).toBe(true);
  });

  it('dedups a live seq against an overlapping history page', () => {
    // Live delivered seq 5 first.
    expect(markSeqSeen(5)).toBe(true);
    // History page [4, 5] arrives: 4 is new, 5 is a duplicate.
    const rendered: number[] = [];
    for (const seq of [4, 5]) {
      if (markSeqSeen(seq)) rendered.push(seq);
    }
    expect(rendered).toEqual([4]);
  });

  it('clearSeqRegistry resets the seen set', () => {
    expect(markSeqSeen(7)).toBe(true);
    clearSeqRegistry();
    expect(hasSeqBeenSeen(7)).toBe(false);
    expect(markSeqSeen(7)).toBe(true);
  });
});
