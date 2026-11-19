import { describe, expect, it } from 'vitest';

import {
  AlwaysExploreForDemo,
  assertValidScoringWeights,
  availabilityScore,
  DEFAULT_SCORING_WEIGHTS,
  historySuccessScore,
  pickExplorationCandidate,
  ProbabilisticExploration,
  scoreBids,
  type AgentScoringStats,
} from '../src/modules/task-scoring.js';

function stats(overrides: Partial<AgentScoringStats> = {}): AgentScoringStats {
  return {
    skills: [],
    completed: 0,
    failed: 0,
    activeTasks: 0,
    ...overrides,
  };
}

describe('scoring weights', () => {
  it('accepts the default weights and rejects sums other than 1', () => {
    expect(() => assertValidScoringWeights(DEFAULT_SCORING_WEIGHTS)).not.toThrow();
    expect(() =>
      assertValidScoringWeights({ ...DEFAULT_SCORING_WEIGHTS, skill: 0.5 }),
    ).toThrow(/sum to 1/);
    expect(() =>
      assertValidScoringWeights({ ...DEFAULT_SCORING_WEIGHTS, eta: -0.1 }),
    ).toThrow(/within/);
  });
});

describe('scoring components', () => {
  it('shrinks historical success toward 0.5 when samples are scarce', () => {
    expect(historySuccessScore(0, 0, 5)).toBe(0.5);
    expect(historySuccessScore(1, 0, 5)).toBeCloseTo(0.5833, 4);
    expect(historySuccessScore(5, 0, 5)).toBe(0.75);
    expect(historySuccessScore(20, 0, 5)).toBe(0.9);
    expect(historySuccessScore(0, 1, 5)).toBeCloseTo(0.4167, 4);
  });

  it('availability decreases monotonically with active tasks', () => {
    expect(availabilityScore(0)).toBe(1);
    expect(availabilityScore(1)).toBe(0.5);
    expect(availabilityScore(3)).toBe(0.25);
  });

  it('weights skill match highest and normalises price/ETA across bids', () => {
    const bids = [
      { bidId: 'bid_a', agentId: 'agt_a', price: 100, eta: 60 },
      { bidId: 'bid_b', agentId: 'agt_b', price: 200, eta: 30 },
    ];
    const scored = scoreBids(bids, {
      requiredSkills: ['typescript', 'sql'],
      stats: new Map([
        ['agt_a', stats({ skills: ['typescript', 'sql'] })],
        ['agt_b', stats({ skills: ['typescript'] })],
      ]),
    });

    const a = scored.find((bid) => bid.agentId === 'agt_a');
    const b = scored.find((bid) => bid.agentId === 'agt_b');
    expect(a?.skillScore).toBe(1);
    expect(b?.skillScore).toBe(0.5);
    expect(a?.priceScore).toBe(1); // cheaper
    expect(b?.priceScore).toBe(0); // more expensive
    expect(a?.etaScore).toBe(0); // slower
    expect(b?.etaScore).toBe(1); // faster
    expect(scored[0]?.agentId).toBe('agt_a');
  });

  it('treats a missing ETA as neutral', () => {
    const scored = scoreBids(
      [{ bidId: 'bid_a', agentId: 'agt_a', price: 10, eta: null }],
      { requiredSkills: [], stats: new Map([['agt_a', stats()]]) },
    );
    expect(scored[0]?.etaScore).toBe(0.5);
  });
});

describe('cold-start exploration', () => {
  const cold = {
    bidId: 'bid_cold',
    agentId: 'agt_cold',
    price: 10,
    eta: 10,
    score: 1,
    skillScore: 1,
    historyScore: 0.5,
    availabilityScore: 1,
    priceScore: 1,
    etaScore: 1,
    historySamples: 0,
  };
  const veteran = { ...cold, bidId: 'bid_vet', agentId: 'agt_vet', historySamples: 20 };

  it('picks the skill-qualified bidder with too few history samples', () => {
    expect(pickExplorationCandidate([veteran, cold], 5)?.agentId).toBe('agt_cold');
    expect(pickExplorationCandidate([veteran], 5)).toBeUndefined();
  });

  it('ProbabilisticExploration honours the injected random source', () => {
    expect(new ProbabilisticExploration({ rate: 0.05, random: () => 0.01 }).shouldExplore()).toBe(
      true,
    );
    expect(new ProbabilisticExploration({ rate: 0.05, random: () => 0.9 }).shouldExplore()).toBe(
      false,
    );
    expect(new AlwaysExploreForDemo().shouldExplore()).toBe(true);
  });
});
