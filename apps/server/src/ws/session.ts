/**
 * Per-connection state for the WebSocket gateway.
 *
 * A `WsSession` owns everything that is scoped to one socket:
 *
 * - **identity** — bound after a successful handshake (`Authorization: Bearer`)
 *   or after an in-band `agent.register` / `agent.authenticate`;
 * - **resume cursor** — `lastSeq`, the highest global `seq` already pushed to
 *   this socket;
 * - **dedupe memory** — every `seq` sent on this socket, so a replay can never
 *   re-deliver a message the client already rendered (the same global-`seq`
 *   contract the SDK relies on, see US-014);
 * - **rate limiting** — a connection-level token bucket. The *agent*-level
 *   bucket is shared between all sockets of one agent and therefore lives in
 *   the gateway; the session merely references it.
 *
 * The class deliberately has no knowledge of `ws` lifecycle events or of the
 * handler registry: the gateway drives it.
 */

import type { WebSocket } from 'ws';
import type { Logger } from 'pino';

import type { AuthContext } from '../auth/roles.js';
import { encodeFrame } from './framing.js';

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

export type BucketDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

export interface TokenBucketOptions {
  /** Sustained refill rate (units per second). */
  readonly ratePerSecond: number;
  /** Bucket capacity = largest tolerated burst. */
  readonly burst: number;
  /** Injectable clock (epoch ms) so tests can advance time deterministically. */
  readonly clock?: () => number;
}

/**
 * Classic token bucket.
 *
 * `tryConsume()` refills lazily from elapsed wall time and consumes one token
 * when available. It never throws — a rejection is a *soft* signal that the
 * caller maps onto `-32005 RateLimited`, keeping the socket open.
 */
export class TokenBucket {
  readonly #ratePerSecond: number;
  readonly #burst: number;
  readonly #clock: () => number;
  #tokens: number;
  #lastRefill: number;

  constructor(options: TokenBucketOptions) {
    this.#ratePerSecond = Math.max(1, options.ratePerSecond);
    this.#burst = Math.max(1, options.burst);
    this.#clock = options.clock ?? (() => Date.now());
    this.#tokens = this.#burst;
    this.#lastRefill = this.#clock();
  }

  get ratePerSecond(): number {
    return this.#ratePerSecond;
  }

  get burst(): number {
    return this.#burst;
  }

  tryConsume(): BucketDecision {
    const now = this.#clock();
    const elapsedMs = Math.max(0, now - this.#lastRefill);
    if (elapsedMs > 0) {
      this.#tokens = Math.min(
        this.#burst,
        this.#tokens + (elapsedMs / 1000) * this.#ratePerSecond,
      );
      this.#lastRefill = now;
    }
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return { allowed: true };
    }
    const missing = 1 - this.#tokens;
    return {
      allowed: false,
      retryAfterMs: Math.max(1, Math.ceil((missing / this.#ratePerSecond) * 1000)),
    };
  }
}

/** How many per-agent buckets the gateway keeps before evicting the oldest. */
export const DEFAULT_AGENT_BUCKET_LIMIT = 10_000;

export interface TokenBucketRegistryOptions {
  readonly ratePerSecond: number;
  readonly burst: number;
  /**
   * Maximum tracked identities. A hostile client cycling agent ids must not be
   * able to grow this map without bound; the oldest bucket is evicted first.
   */
  readonly maxEntries?: number;
  readonly clock?: () => number;
}

/** Bounded `agentId → TokenBucket` registry shared by all sockets of an agent. */
export class TokenBucketRegistry {
  readonly #buckets = new Map<string, TokenBucket>();
  readonly #options: TokenBucketRegistryOptions;
  readonly #maxEntries: number;

  constructor(options: TokenBucketRegistryOptions) {
    this.#options = options;
    this.#maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_AGENT_BUCKET_LIMIT);
  }

  get size(): number {
    return this.#buckets.size;
  }

  has(agentId: string): boolean {
    return this.#buckets.has(agentId);
  }

  get(agentId: string): TokenBucket {
    const existing = this.#buckets.get(agentId);
    if (existing !== undefined) {
      // LRU touch: re-insert at the tail so active agents are never evicted
      // in favour of a flood of one-shot identities.
      this.#buckets.delete(agentId);
      this.#buckets.set(agentId, existing);
      return existing;
    }

    if (this.#buckets.size >= this.#maxEntries) {
      const oldest = this.#buckets.keys().next().value;
      if (oldest !== undefined) this.#buckets.delete(oldest);
    }

    const created = new TokenBucket({
      ratePerSecond: this.#options.ratePerSecond,
      burst: this.#options.burst,
      ...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
    });
    this.#buckets.set(agentId, created);
    return created;
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** How many `seq`s one socket remembers for dedupe (bounded memory). */
export const DEFAULT_DEDUPE_WINDOW = 10_000;

export interface WsSessionOptions {
  readonly id: string;
  readonly socket: WebSocket;
  readonly logger: Logger;
  /** Tenant of unauthenticated traffic; replaced by the token's claim on bind. */
  readonly workspaceId: string;
  /** Connection-level bucket (created by the gateway). */
  readonly connectionBucket: TokenBucket;
  readonly dedupeWindow?: number;
  /** Peer address, used to throttle anonymous RPCs such as register. */
  readonly remoteAddress?: string;
}

export class WsSession {
  readonly id: string;
  readonly socket: WebSocket;
  readonly logger: Logger;
  /** Connection-level request bucket. */
  readonly connectionBucket: TokenBucket;
  /** Peer address supplied by the gateway (undefined when unavailable). */
  readonly remoteAddress?: string;

  /** Verified identity, once bound. */
  auth?: AuthContext;
  agentId?: string;
  workspaceId: string;

  /** Highest global `seq` pushed to this socket (resume watermark). */
  #lastSeq = 0;
  /** `seq`s already delivered on this socket (dedupe across reconnects). */
  readonly #sent = new Set<number>();
  readonly #sentOrder: number[] = [];
  readonly #dedupeWindow: number;

  /** Native `ws` heartbeat flag: cleared per interval, set by a pong. */
  isAlive = true;
  /** Set once the socket closed; further sends are dropped. */
  closed = false;

  /**
   * Per-agent message bucket, shared by every socket of that agent and
   * attached by the gateway when the session binds an identity.
   */
  agentBucket?: TokenBucket;

  constructor(options: WsSessionOptions) {
    this.id = options.id;
    this.socket = options.socket;
    this.logger = options.logger;
    this.workspaceId = options.workspaceId;
    this.connectionBucket = options.connectionBucket;
    this.#dedupeWindow = Math.max(1, options.dedupeWindow ?? DEFAULT_DEDUPE_WINDOW);
    if (options.remoteAddress !== undefined) {
      this.remoteAddress = options.remoteAddress;
    }
  }

  get authenticated(): boolean {
    return this.auth !== undefined;
  }

  get lastSeq(): number {
    return this.#lastSeq;
  }

  /** Bind a verified identity (handshake or in-band authenticate). */
  bind(auth: AuthContext): void {
    this.auth = auth;
    this.agentId = auth.agentId;
    if (auth.workspaceId !== undefined) {
      this.workspaceId = auth.workspaceId;
    }
  }

  /** Has this socket already delivered `seq`? */
  hasSent(seq: number): boolean {
    return this.#sent.has(seq);
  }

  /**
   * Record `seq` as delivered and advance the watermark.
   * @returns `false` when it was already delivered (caller must skip it).
   */
  markSent(seq: number): boolean {
    if (this.#sent.has(seq)) return false;
    this.#sent.add(seq);
    this.#sentOrder.push(seq);
    if (this.#sentOrder.length > this.#dedupeWindow) {
      const evicted = this.#sentOrder.shift();
      if (evicted !== undefined) this.#sent.delete(evicted);
    }
    this.advance(seq);
    return true;
  }

  /** Raise the resume watermark without recording a delivery. */
  advance(seq: number): void {
    if (seq > this.#lastSeq) this.#lastSeq = seq;
  }

  /** Write one frame; returns `false` when the socket is not writable. */
  send(frame: unknown): boolean {
    if (this.closed) return false;
    // `WebSocket.OPEN === 1`; comparing to the constant would require importing
    // the runtime class, `readyState` alone is enough here.
    if (this.socket.readyState !== 1) return false;
    try {
      this.socket.send(encodeFrame(frame));
      return true;
    } catch (err) {
      this.logger.warn({ sessionId: this.id, err: String(err), msg: 'ws.send.failed' });
      return false;
    }
  }

  /** Mark closed so late broadcasts cannot write to a dead socket. */
  markClosed(): void {
    this.closed = true;
  }
}
