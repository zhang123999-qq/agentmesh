/**
 * Token revocation registry (US-021D / US-021D follow-up v11).
 *
 * The in-memory LRU is a **cache** over the persistent `revoked_tokens` table:
 *  - `isRevoked` checks memory first, then falls back to the DB (so an LRU
 *    eviction can never un-revoke a token);
 *  - `revoke` writes the DB row first (persistence is the source of truth) and
 *    then the cache;
 *  - `loadFromStore` warms the cache on startup (after migrate, before listen);
 *  - `cleanup` deletes expired rows on a timer.
 *
 * Without a store (embedded/transport-only builds and unit tests) the registry
 * degrades to the original in-memory behavior.
 */
import type { RevokedTokensDao } from '@agentmesh/store';
import type { Logger } from 'pino';

export interface TokenRevocationOptions {
  /** Maximum cached jtis (LRU). Default 10,000. */
  readonly maxEntries?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly clock?: () => number;
  /** Persistent store; absent ⇒ memory-only. */
  readonly store?: RevokedTokensDao;
  readonly logger?: Logger;
}

export class TokenRevocationRegistry {
  /** jti -> expiry (epoch seconds). Insertion order is the LRU order. */
  readonly #expByJti = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #clock: () => number;
  readonly #store?: RevokedTokensDao;
  readonly #logger?: Logger;
  #timer?: NodeJS.Timeout;
  #cleanedTotal = 0;

  constructor(options: TokenRevocationOptions = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.#clock = options.clock ?? (() => Date.now());
    this.#store = options.store;
    this.#logger = options.logger;
  }

  get size(): number {
    return this.#expByJti.size;
  }

  /** Total expired rows removed by cleanup (diagnostics / metrics). */
  get cleanedTotal(): number {
    return this.#cleanedTotal;
  }

  /** Listeners notified (with the revoked `jti`) after a revoke lands. */
  readonly #revokeListeners = new Set<(jti: string) => void>();

  /**
   * Subscribe to revocations (e.g. the WS gateway, which terminates live
   * sessions authenticated with the revoked token). Returns an unsubscribe
   * function. A listener throwing never breaks the revoke itself.
   */
  onRevoked(listener: (jti: string) => void): () => void {
    this.#revokeListeners.add(listener);
    return () => {
      this.#revokeListeners.delete(listener);
    };
  }

  #nowSeconds(): number {
    return Math.floor(this.#clock() / 1000);
  }

  /** Drop expired entries from the in-memory cache only. */
  prune(): void {
    const now = this.#nowSeconds();
    for (const [jti, exp] of this.#expByJti) {
      if (exp <= now) this.#expByJti.delete(jti);
    }
  }

  #remember(jti: string, exp: number): void {
    if (!this.#expByJti.has(jti) && this.#expByJti.size >= this.#maxEntries) {
      const oldest = this.#expByJti.keys().next().value;
      if (oldest !== undefined) this.#expByJti.delete(oldest);
    }
    this.#expByJti.delete(jti);
    this.#expByJti.set(jti, exp);
  }

  /**
   * True when `jti` is revoked and not yet expired. Checks the cache, then the
   * persistent store (caching a hit). An LRU eviction never un-revokes a token.
   */
  isRevoked(jti: string | undefined): boolean {
    if (jti === undefined) return false;
    const now = this.#nowSeconds();
    const cached = this.#expByJti.get(jti);
    if (cached !== undefined) {
      if (cached <= now) {
        this.#expByJti.delete(jti);
        return false;
      }
      this.#expByJti.delete(jti);
      this.#expByJti.set(jti, cached);
      return true;
    }
    if (this.#store?.isRevoked(jti, now) === true) {
      // Cache with the store's expiry (re-read so the cache entry is accurate).
      const rows = this.#store.loadUnexpired(now);
      const hit = rows.find((row) => row.jti === jti);
      if (hit !== undefined) this.#remember(jti, hit.expiresAt);
      return true;
    }
    return false;
  }

  /** Revoke `jti` until `expiresAt` (epoch seconds). Persists, then caches. */
  revoke(jti: string, expiresAt: number, workspaceId?: string): void {
    // Persistence first: if the DB write fails the token must NOT appear revoked
    // (a half-applied revoke would silently accept a token on the next restart).
    this.#store?.insert({
      jti,
      expiresAt,
      revokedAt: this.#nowSeconds(),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    this.#remember(jti, expiresAt);
    for (const listener of [...this.#revokeListeners]) {
      try {
        listener(jti);
      } catch (err) {
        this.#logger?.error?.({
          err: err instanceof Error ? err.message : String(err),
          jti,
          msg: 'revoked.tokens.listener.failed',
        });
      }
    }
  }

  /** Warm the cache from the store (startup: after migrate, before listen). */
  loadFromStore(): void {
    if (this.#store === undefined) return;
    const rows = this.#store.loadUnexpired(this.#nowSeconds());
    this.#expByJti.clear();
    for (const row of rows) this.#remember(row.jti, row.expiresAt);
  }

  /** Delete expired rows from the store (and prune the cache). Returns count. */
  cleanup(): number {
    this.prune();
    if (this.#store === undefined) return 0;
    const removed = this.#store.deleteExpired(this.#nowSeconds());
    this.#cleanedTotal += removed;
    return removed;
  }

  /** Active (unexpired) revocation count, for the /metrics gauge. */
  activeCount(): number {
    return this.#store !== undefined ? this.#store.countActive(this.#nowSeconds()) : this.#expByJti.size;
  }

  startCleanupTimer(intervalMs: number): void {
    if (this.#timer !== undefined || intervalMs <= 0) return;
    const timer = setInterval(() => {
      try {
        this.cleanup();
      } catch (err) {
        this.#logger?.error?.({
          err: err instanceof Error ? err.message : String(err),
          msg: 'revoked.tokens.cleanup.failed',
        });
      }
    }, intervalMs);
    timer.unref?.();
    this.#timer = timer;
    this.#logger?.info?.({ intervalMs, msg: 'revoked.tokens.cleanup.started' });
  }

  stopCleanupTimer(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
      this.#logger?.info?.({ msg: 'revoked.tokens.cleanup.cleared' });
    }
  }

  isCleanupRunning(): boolean {
    return this.#timer !== undefined;
  }
}
