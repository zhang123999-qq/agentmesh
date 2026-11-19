/**
 * In-process failed-authentication limiter (US-005, secret brute-force guard).
 *
 * An account secret is a **long-lived reusable credential** (issued once by
 * `agent.register`, stored only as `sha256(secret)`, replayed by every later
 * `agent.authenticate`). That makes `authenticate` an online guessing oracle
 * unless failures are throttled, so each identity gets its own bucket:
 *
 * - failures are counted inside a sliding-ish window (`failWindowSeconds`) —
 *   the window starts at the first failure and is discarded once it lapses;
 * - once `maxFailedAttempts` failures land inside the window the identity is
 *   locked out for `lockoutSeconds`, doubling on each repeated lockout
 *   (exponential backoff) up to {@link MAX_LOCKOUT_MS};
 * - a successful verification (or a token refresh proving the same identity)
 *   clears the bucket, so ordinary users never notice the limiter.
 *
 * The state is **process-local** on purpose: one server instance per (SQLite)
 * database in this deployment, no shared cache to depend on. A restart clears
 * the counters — acceptable because the lockout only slows online guessing;
 * it is documented in `apps/server/README.md`.
 *
 * The limiter is a *soft* rejection: callers map `{ allowed: false }` onto the
 * JSON-RPC `-32005 RateLimited` error (with `retryAfterMs`), never onto a
 * thrown non-protocol exception, so a throttled call cannot break a session.
 */

/** Failures accepted inside the window before an identity is locked out. */
export const DEFAULT_AUTH_MAX_FAILED_ATTEMPTS = 5;
/** Length of the failure-counting window. */
export const DEFAULT_AUTH_FAIL_WINDOW_SECONDS = 60;
/** Base lockout; doubles per consecutive lockout (exponential backoff). */
export const DEFAULT_AUTH_LOCKOUT_SECONDS = 60;
/** Ceiling for the backed-off lockout so a typo cannot lock out for days. */
export const MAX_LOCKOUT_MS = 60 * 60 * 1000; // 1 hour

export interface AuthRateLimitConfig {
  readonly maxFailedAttempts: number;
  readonly failWindowSeconds: number;
  readonly lockoutSeconds: number;
}

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimitConfig = Object.freeze({
  maxFailedAttempts: DEFAULT_AUTH_MAX_FAILED_ATTEMPTS,
  failWindowSeconds: DEFAULT_AUTH_FAIL_WINDOW_SECONDS,
  lockoutSeconds: DEFAULT_AUTH_LOCKOUT_SECONDS,
});

/** Result of asking "may this identity attempt authentication right now?". */
export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

interface FailureBucket {
  /** Failures recorded in the current window. */
  failures: number;
  /** Epoch ms when the current window opened (first failure). */
  windowStartedAt: number;
  /** Epoch ms until which attempts are rejected; 0 = not locked. */
  lockedUntil: number;
  /** Consecutive lockouts (drives the exponential backoff exponent). */
  lockouts: number;
}

export interface AuthFailureLimiterOptions extends Partial<AuthRateLimitConfig> {
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly clock?: () => number;
  /** Bucket ceiling before stale entries are swept (default 10_000). */
  readonly maxEntries?: number;
}

/**
 * Per-identity failed-attempt counters with window + exponential lockout.
 *
 * Keys are opaque strings chosen by the caller (the account module keys by the
 * resolved account id, falling back to the normalized submitted identifier),
 * so two different identities can never affect each other.
 */
export class AuthFailureLimiter {
  readonly #maxFailedAttempts: number;
  readonly #windowMs: number;
  readonly #lockoutMs: number;
  readonly #maxEntries: number;
  readonly #clock: () => number;
  readonly #buckets = new Map<string, FailureBucket>();

  constructor(options: AuthFailureLimiterOptions = {}) {
    this.#maxFailedAttempts = Math.max(
      1,
      options.maxFailedAttempts ?? DEFAULT_AUTH_MAX_FAILED_ATTEMPTS,
    );
    this.#windowMs =
      Math.max(1, options.failWindowSeconds ?? DEFAULT_AUTH_FAIL_WINDOW_SECONDS) * 1000;
    this.#lockoutMs =
      Math.max(1, options.lockoutSeconds ?? DEFAULT_AUTH_LOCKOUT_SECONDS) * 1000;
    this.#maxEntries = Math.max(1, options.maxEntries ?? 10_000);
    this.#clock = options.clock ?? (() => Date.now());
  }

  /** Configured threshold (exposed for docs/tests). */
  get maxFailedAttempts(): number {
    return this.#maxFailedAttempts;
  }

  /**
   * May `key` attempt authentication now? Never mutates the failure count:
   * only {@link recordFailure} does, so a correct secret after a lockout
   * expiry is not penalised twice.
   */
  check(key: string): RateLimitDecision {
    const now = this.#clock();
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return { allowed: true };
    if (bucket.lockedUntil > now) {
      return { allowed: false, retryAfterMs: bucket.lockedUntil - now };
    }
    if (bucket.lockedUntil !== 0 && bucket.lockedUntil <= now) {
      // Lock expired; the next failure starts a fresh window but keeps the
      // backoff exponent so repeated abuse escalates.
      bucket.lockedUntil = 0;
    }
    if (bucket.failures > 0 && now - bucket.windowStartedAt >= this.#windowMs) {
      bucket.failures = 0;
    }
    return { allowed: true };
  }

  /**
   * Record one failed verification. Locks the key once the threshold is hit;
   * the counting window is then restarted so the post-lockout allowance is
   * full (`maxFailedAttempts` again) rather than an immediate re-lock.
   */
  recordFailure(key: string): void {
    const now = this.#clock();
    this.#sweepIfNeeded(now);
    const bucket = this.#buckets.get(key) ?? {
      failures: 0,
      windowStartedAt: now,
      lockedUntil: 0,
      lockouts: 0,
    };
    this.#buckets.set(key, bucket);

    if (bucket.lockedUntil > now) return; // already locked; nothing to add
    if (bucket.failures === 0 || now - bucket.windowStartedAt >= this.#windowMs) {
      bucket.failures = 0;
      bucket.windowStartedAt = now;
    }
    bucket.failures += 1;
    if (bucket.failures < this.#maxFailedAttempts) return;

    bucket.lockedUntil = now + this.#backoffMs(bucket.lockouts);
    bucket.lockouts += 1;
    bucket.failures = 0;
    bucket.windowStartedAt = now;
  }

  /** Forget a key: a proven identity (secret or refresh) clears its counters. */
  recordSuccess(key: string): void {
    this.#buckets.delete(key);
  }

  /** Diagnostics/tests: number of tracked identities. */
  get size(): number {
    return this.#buckets.size;
  }

  /** `base * 2^lockouts`, capped at {@link MAX_LOCKOUT_MS}. */
  #backoffMs(lockouts: number): number {
    const exponent = Math.min(lockouts, 10);
    return Math.min(this.#lockoutMs * 2 ** exponent, MAX_LOCKOUT_MS);
  }

  /**
   * Drop buckets that can no longer matter. Runs only when the map grows past
   * `maxEntries`, so normal traffic pays nothing: a hostile client cycling
   * identifiers cannot grow the process memory without bound.
   */
  #sweepIfNeeded(now: number): void {
    if (this.#buckets.size < this.#maxEntries) return;
    for (const [key, bucket] of this.#buckets) {
      const idle =
        bucket.lockedUntil <= now &&
        (bucket.failures === 0 || now - bucket.windowStartedAt >= this.#windowMs);
      if (idle) this.#buckets.delete(key);
    }
    // Strict bound: a flood of distinct non-idle identities must not grow the
    // map past the ceiling. Evict insertion order (oldest first).
    while (this.#buckets.size >= this.#maxEntries) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest === undefined) break;
      this.#buckets.delete(oldest);
    }
  }
}
