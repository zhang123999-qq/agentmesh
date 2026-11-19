/**
 * US-009 scoring and cold-start exploration.
 *
 * Pure functions so the winning bid can be tested without a database:
 * skill match 0.35, historical success 0.25, availability 0.10, normalised
 * price 0.15, normalised ETA 0.15. Weights are configurable but must sum to 1.
 */

export interface ScoringWeights {
  readonly skill: number;
  readonly history: number;
  readonly availability: number;
  readonly price: number;
  readonly eta: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = Object.freeze({
  skill: 0.35,
  history: 0.25,
  availability: 0.1,
  price: 0.15,
  eta: 0.15,
});

export const DEFAULT_HISTORY_CONFIDENCE_THRESHOLD = 5;

export function assertValidScoringWeights(weights: ScoringWeights): void {
  const entries: Array<[string, number]> = [
    ['skill', weights.skill],
    ['history', weights.history],
    ['availability', weights.availability],
    ['price', weights.price],
    ['eta', weights.eta],
  ];
  for (const [name, value] of entries) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`scoring weight "${name}" must be within [0, 1]`);
    }
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-6) {
    throw new TypeError(`scoring weights must sum to 1, got ${total}`);
  }
}

export interface BidForScoring {
  readonly bidId: string;
  readonly agentId: string;
  readonly price: number;
  readonly eta: number | null;
}

export interface AgentScoringStats {
  readonly skills: readonly string[];
  readonly completed: number;
  readonly failed: number;
  /** Tasks currently assigned with status `awarded` or `in_progress`. */
  readonly activeTasks: number;
}

export interface ScoredBid extends BidForScoring {
  readonly score: number;
  readonly skillScore: number;
  readonly historyScore: number;
  readonly availabilityScore: number;
  readonly priceScore: number;
  readonly etaScore: number;
  readonly historySamples: number;
}

export interface ScoringContext {
  readonly requiredSkills: readonly string[];
  readonly stats: ReadonlyMap<string, AgentScoringStats>;
  readonly weights?: ScoringWeights;
  readonly historyConfidenceThreshold?: number;
}

function skillMatchScore(
  required: readonly string[],
  skills: readonly string[],
): number {
  if (required.length === 0) return 1;
  const owned = new Set(skills);
  let matches = 0;
  for (const skill of required) {
    if (owned.has(skill)) matches += 1;
  }
  return matches / required.length;
}

/**
 * Success rate shrunk toward the neutral 0.5 when samples are scarce:
 * `(completed + 0.5*k) / (completed + failed + k)`. With k=5 an agent with
 * one success scores 0.583, five successes 0.75, and twenty 0.9.
 */
export function historySuccessScore(
  completed: number,
  failed: number,
  threshold: number,
): number {
  const total = completed + failed;
  if (total === 0) return 0.5;
  return (completed + 0.5 * threshold) / (total + threshold);
}

/** 1 / (1 + activeTaskCount): fewer active tasks ranks higher. */
export function availabilityScore(activeTasks: number): number {
  return 1 / (1 + Math.max(0, activeTasks));
}

function normaliseLowerIsBetter(
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return 0.5;
  if (max - min <= Number.EPSILON) return 1;
  return 1 - (value - min) / (max - min);
}

/**
 * Score every live bid. Price and ETA are normalised across this bid set
 * (lower is better); a missing ETA is neutral (0.5).
 */
export function scoreBids(
  bids: readonly BidForScoring[],
  context: ScoringContext,
): ScoredBid[] {
  const weights = context.weights ?? DEFAULT_SCORING_WEIGHTS;
  assertValidScoringWeights(weights);
  const threshold = context.historyConfidenceThreshold ?? DEFAULT_HISTORY_CONFIDENCE_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new TypeError('historyConfidenceThreshold must be a positive integer');
  }

  const prices = bids.map((bid) => bid.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const etas = bids
    .map((bid) => bid.eta)
    .filter((eta): eta is number => eta !== null && Number.isFinite(eta));
  const minEta = etas.length > 0 ? Math.min(...etas) : 0;
  const maxEta = etas.length > 0 ? Math.max(...etas) : 0;

  return bids
    .map((bid) => {
      const stats = context.stats.get(bid.agentId) ?? {
        skills: [],
        completed: 0,
        failed: 0,
        activeTasks: 0,
      };
      const skillScore = skillMatchScore(context.requiredSkills, stats.skills);
      const historyScore = historySuccessScore(
        stats.completed,
        stats.failed,
        threshold,
      );
      const availability = availabilityScore(stats.activeTasks);
      const priceScore = normaliseLowerIsBetter(bid.price, minPrice, maxPrice);
      const etaScore =
        bid.eta === null || !Number.isFinite(bid.eta)
          ? 0.5
          : normaliseLowerIsBetter(bid.eta, minEta, maxEta);
      const score =
        skillScore * weights.skill +
        historyScore * weights.history +
        availability * weights.availability +
        priceScore * weights.price +
        etaScore * weights.eta;
      return {
        ...bid,
        score,
        skillScore,
        historyScore,
        availabilityScore: availability,
        priceScore,
        etaScore,
        historySamples: stats.completed + stats.failed,
      };
    })
    .sort((a, b) => b.score - a.score || a.bidId.localeCompare(b.bidId));
}

/**
 * Cold-start candidate: skill-qualified but with fewer than
 * `historyConfidenceThreshold` finished tasks. Returns the best-scoring
 * eligible bid, or `undefined` when nobody qualifies.
 */
export function pickExplorationCandidate(
  scored: readonly ScoredBid[],
  threshold: number = DEFAULT_HISTORY_CONFIDENCE_THRESHOLD,
): ScoredBid | undefined {
  const eligible = scored.filter(
    (bid) => bid.skillScore >= 0.5 && bid.historySamples < threshold,
  );
  return eligible[0];
}

export interface ExplorationPolicy {
  shouldExplore(): boolean;
}

/** Default 5% exploration; `random` is injectable for deterministic tests. */
export class ProbabilisticExploration implements ExplorationPolicy {
  readonly #rate: number;
  readonly #random: () => number;

  constructor(options: { rate?: number; random?: () => number } = {}) {
    this.#rate = Math.min(1, Math.max(0, options.rate ?? 0.05));
    this.#random = options.random ?? Math.random;
  }

  shouldExplore(): boolean {
    return this.#random() < this.#rate;
  }
}

/** Deterministic exploration used when `DEMO_MODE=true` (US-017). */
export class AlwaysExploreForDemo implements ExplorationPolicy {
  shouldExplore(): boolean {
    return true;
  }
}
