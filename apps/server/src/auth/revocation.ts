/**
 * In-memory token revocation registry (US-021D).
 *
 * Stores revoked `jti`s until their `exp` (epoch seconds), bounded by an LRU
 * cap. Single-process only: a restart forgets revocations, so a token revoked
 * before a restart is valid again until `exp` (documented in operations.md and
 * security.md; JWT_SECRET rotation remains the whole-set invalidation tool).
 *
 * Eviction policy when full: evict the least-recently-used jti — we never
 * reject a revoke, because honouring the latest revoke is the security-relevant
 * behaviour. `prune()`/`isRevoked()` lazily drop expired entries so the map does
 * not grow with dead jtis.
 */
export interface TokenRevocationOptions {
  /** Maximum remembered jtis (LRU). Default 10,000. */
  readonly maxEntries?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly clock?: () => number;
}

export class TokenRevocationRegistry {
  /** jti -> expiry (epoch seconds). Map insertion order is the LRU order. */
  readonly #expByJti = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #clock: () => number;

  constructor(options: TokenRevocationOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.#clock = options.clock ?? (() => Date.now());
  }

  get size(): number {
    return this.#expByJti.size;
  }

  #nowSeconds(): number {
    return Math.floor(this.#clock() / 1000);
  }

  /** Drop every entry whose expiry is at or before now. */
  prune(): void {
    const now = this.#nowSeconds();
    for (const [jti, exp] of this.#expByJti) {
      if (exp <= now) this.#expByJti.delete(jti);
    }
  }

  /** True when `jti` is revoked and not yet expired. Refreshes LRU recency. */
  isRevoked(jti: string | undefined): boolean {
    if (jti === undefined) return false;
    const exp = this.#expByJti.get(jti);
    if (exp === undefined) return false;
    if (exp <= this.#nowSeconds()) {
      this.#expByJti.delete(jti);
      return false;
    }
    // Refresh recency: delete + re-insert moves it to the "newest" end.
    this.#expByJti.delete(jti);
    this.#expByJti.set(jti, exp);
    return true;
  }

  /** Revoke `jti` until `expiresAt` (epoch seconds). Never rejects. */
  revoke(jti: string, expiresAt: number): void {
    this.prune();
    if (!this.#expByJti.has(jti) && this.#expByJti.size >= this.#maxEntries) {
      // Evict the least-recently-used entry (Map preserves insertion order).
      const oldest = this.#expByJti.keys().next().value;
      if (oldest !== undefined) this.#expByJti.delete(oldest);
    }
    // Delete + re-insert to mark this jti as most-recently-used.
    this.#expByJti.delete(jti);
    this.#expByJti.set(jti, expiresAt);
  }
}
