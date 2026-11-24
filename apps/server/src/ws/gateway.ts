/**
 * WebSocket gateway (US-006).
 *
 * One gateway per server instance, attached to the same `http.Server` Fastify
 * listens on (`new WebSocketServer({ server, path })`), so `GET /health` and
 * `POST /rpc` keep working untouched: only upgrades to `WS_PATH` are handled
 * here.
 *
 * ## Responsibilities
 *
 * - **Handshake auth** — `Authorization: Bearer <jwt>` on the upgrade request
 *   (or an in-band `agent.authenticate` / `agent.register`) verified through
 *   the US-005 `TokenService`. A bad token is answered with `-32001` and the
 *   socket is closed; an unauthenticated socket may only call the public
 *   account methods.
 * - **Framing** — JSON-RPC request/response/notification envelopes are routed
 *   through the shared `RpcDispatcher` (same classification and error mapping
 *   as HTTP), control frames (`resume`, `ping`, `pong`) are handled locally.
 * - **Registry** — `Map<agentId, Set<WebSocket>>` plus the per-session objects.
 * - **Presence** — `presence.update` online/offline broadcasts to every other
 *   authenticated connection.
 * - **Heartbeat** — native WS ping every `heartbeatIntervalMs`; a socket that
 *   misses one interval is `terminate()`d.
 * - **Epoch / resume** — the epoch is generated once per gateway instance
 *   (`randomUUID()`), i.e. a server restart invalidates every client cursor.
 *   `welcome` carries `{epoch, seq, protocolVersion}`; `resume` compares the
 *   client's `lastSeenEpoch` (missing = compatible, for third parties) and
 *   replays `events.listSince(lastSeenSeq)` as event notifications, capped at
 *   `resumeMaxEvents` → `gap_too_large` with `detail: "buffer_exceeded"` or
 *   `"epoch_mismatch"` so the client cold-starts.
 * - **Live push** — the gateway subscribes to `EventsDao.onAppend`, so any event
 *   committed anywhere in the process (a handler, a projection, a test fixture)
 *   is turned into an event notification for every authenticated socket of that
 *   workspace. Each push carries the row's global `seq` and is deduped per
 *   socket through the same `WsSession.markSent` set `resume` uses, so a live
 *   push can never duplicate a seq that this socket already received — the
 *   client-side dedupe on the global `seq` then handles the remaining overlap
 *   between a resume replay and the live stream.
 * - **Rate limiting (soft)** — a per-connection bucket (default 100 req/s) and
 *   a per-agent bucket for message sending (default 10 msg/s, shared by all of
 *   that agent's sockets). Over-limit requests receive `-32005`; the socket
 *   stays open and recovers as the bucket refills.
 *
 *   The agent bucket is keyed by the identity the request **actually executes
 *   as**, not by the handshake binding alone: a third-party client that only
 *   authenticates per message (`params.token`) never binds its socket, so
 *   keying on `session.agentId` would skip the agent limit entirely (and let
 *   one agent multiply its budget by opening more sockets, US-006). The
 *   per-request token therefore wins over the handshake identity for that
 *   message — the gateway resolves it *before* dispatching, charges its
 *   bucket, and passes the same context to the dispatcher so the charged
 *   identity and the executed identity can never disagree. A socket that
 *   presents a different identity than its handshake binding is re-bound to
 *   it, so later frames stay consistent.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';

import {
  JsonRpcErrorCode,
  METHODS,
  ProtocolError,
  isNotificationEventType,
} from '@agentmesh/protocol';
import type { PresenceUpdatePayload } from '@agentmesh/protocol';
import type { EventsDao, StoredEvent } from '@agentmesh/store';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';

import {
  extractBearerToken,
  readTokenFromParams,
  type TokenService,
} from '../auth/token.js';
import type { AuthContext } from '../auth/roles.js';
import {
  createSystemErrorNotification,
  interpretFrame,
  type RpcDispatcher,
  type SystemErrorNotifier,
} from '../dispatcher.js';
import {
  buildAckFrame,
  buildGapTooLargeFrame,
  buildPongFrame,
  buildWelcomeFrame,
  controlFrameType,
  decodeFrame,
  errorResponseFrame,
  eventNotification,
  presenceNotification,
  readPingTs,
  readResumeFrame,
} from './framing.js';
import {
  TokenBucket,
  TokenBucketRegistry,
  WsSession,
  type WsSubscription,
} from './session.js';

/** Methods callable before the socket is authenticated. */
export const ANONYMOUS_WS_METHODS: readonly string[] = [
  METHODS.agent.register,
  METHODS.agent.authenticate,
];

/**
 * Methods throttled by the *agent* bucket. Sending a message is the write path
 * a runaway agent can flood, so it is separate from (and stricter than) the
 * per-connection request limit.
 */
export const DEFAULT_AGENT_RATE_LIMITED_METHODS: readonly string[] = [METHODS.message.send];

/** Close code for an upgrade with an invalid/expired token. */
export const WS_CLOSE_UNAUTHORIZED = 4401;
/** Close code used when the gateway shuts down. */
export const WS_CLOSE_SHUTDOWN = 1001;

export interface BucketLimits {
  readonly ratePerSecond: number;
  readonly burst: number;
}

export interface WsGatewayOptions {
  /** HTTP(S) server Fastify listens on; the gateway hooks `upgrade`. */
  readonly server: HttpServer;
  /** Upgrade path, default `/ws`. */
  readonly path?: string;
  readonly dispatcher: RpcDispatcher;
  readonly tokens: TokenService;
  readonly events: EventsDao;
  readonly logger: Logger;
  /**
   * Epoch of this `seq` space. Defaults to a fresh `randomUUID()` per
   * instance, which is exactly the "restart ⇒ new epoch" behaviour clients
   * need to detect a cold start.
   */
  readonly epoch?: string;
  /** Workspace used for cursors/presence until the identity pins one. */
  readonly workspaceId?: string;
  /** Server ping interval in ms; `0` disables the heartbeat. */
  readonly heartbeatIntervalMs?: number;
  /** Hard replay cap per resume. */
  readonly resumeMaxEvents?: number;
  /** Exact browser origins allowed to upgrade (CSWSH defence). */
  readonly allowedOrigins?: readonly string[];
  /** Allow upgrades with no Origin header (SDK/CLI). Default true. */
  readonly allowMissingOrigin?: boolean;
  /** Allow any localhost/127.0.0.1 origin (development default). */
  readonly allowLocalhostOrigins?: boolean;
  /** Largest accepted WS frame in bytes. Default 1 MiB. */
  readonly maxPayloadBytes?: number;
  readonly connectionLimit?: BucketLimits;
  readonly agentLimit?: BucketLimits;
  /** Methods counted against the agent bucket (default `message.send`). */
  readonly agentRateLimitedMethods?: readonly string[];
  /** Methods callable while unauthenticated. */
  readonly anonymousMethods?: readonly string[];
  /**
   * Subscribe to `events.onAppend` and push new notification events to live
   * sockets (default `true`). Tests that only exercise resume/framing turn it
   * off so an append does not arrive twice (live + replay).
   */
  readonly livePush?: boolean;
  /** Injectable clock (epoch ms) for deterministic rate-limit tests. */
  readonly clock?: () => number;
}

const DEFAULT_CONNECTION_LIMIT: BucketLimits = Object.freeze({
  ratePerSecond: 100,
  burst: 100,
});
const DEFAULT_AGENT_LIMIT: BucketLimits = Object.freeze({
  ratePerSecond: 10,
  burst: 10,
});

export class WsGateway {
  /** Epoch of the global `seq` space served by this instance. */
  readonly epoch: string;

  readonly #dispatcher: RpcDispatcher;
  readonly #tokens: TokenService;
  readonly #events: EventsDao;
  readonly #logger: Logger;
  readonly #workspaceId: string;
  readonly #heartbeatIntervalMs: number;
  readonly #resumeMaxEvents: number;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #allowMissingOrigin: boolean;
  readonly #allowLocalhostOrigins: boolean;
  readonly #connectionLimit: BucketLimits;
  readonly #agentLimit: BucketLimits;
  readonly #agentRateLimitedMethods: ReadonlySet<string>;
  readonly #anonymousMethods: ReadonlySet<string>;
  readonly #clock?: () => number;
  /** Unsubscribe handle for the `events.onAppend` live-push feed. */
  #unsubscribeAppend?: () => void;

  readonly #wss: WebSocketServer;
  readonly #sessions = new Set<WsSession>();
  /** agentId → live sockets (the connection registry). */
  /** workspaceId → agentId → live sockets (US-024: presence sharded per tenant). */
  readonly #connections = new Map<string, Map<string, Set<WsSession>>>();
  /** agentId → shared message bucket (bounded, oldest evicted). */
  readonly #agentBuckets: TokenBucketRegistry;
  /** Per-socket promise chain, so frames are handled in arrival order. */
  readonly #chains = new Map<string, Promise<void>>();

  #heartbeatTimer?: NodeJS.Timeout;
  #closed = false;

  constructor(options: WsGatewayOptions) {
    this.epoch = options.epoch ?? randomUUID();
    this.#dispatcher = options.dispatcher;
    this.#tokens = options.tokens;
    this.#events = options.events;
    this.#logger = options.logger;
    this.#workspaceId = options.workspaceId ?? 'default';
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.#resumeMaxEvents = Math.max(1, options.resumeMaxEvents ?? 1000);
    this.#allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.#allowMissingOrigin = options.allowMissingOrigin ?? true;
    this.#allowLocalhostOrigins = options.allowLocalhostOrigins ?? false;
    this.#connectionLimit = options.connectionLimit ?? DEFAULT_CONNECTION_LIMIT;
    if (options.clock !== undefined) this.#clock = options.clock;
    this.#agentLimit = options.agentLimit ?? DEFAULT_AGENT_LIMIT;
    this.#agentBuckets = new TokenBucketRegistry({
      ratePerSecond: this.#agentLimit.ratePerSecond,
      burst: this.#agentLimit.burst,
      ...(this.#clock === undefined ? {} : { clock: this.#clock }),
    });
    this.#agentRateLimitedMethods = new Set(
      options.agentRateLimitedMethods ?? DEFAULT_AGENT_RATE_LIMITED_METHODS,
    );
    this.#anonymousMethods = new Set(options.anonymousMethods ?? ANONYMOUS_WS_METHODS);

    this.#wss = new WebSocketServer({
      server: options.server,
      path: options.path ?? '/ws',
      maxPayload: Math.max(1, options.maxPayloadBytes ?? 1_048_576),
      // Cross-Site WebSocket Hijacking defence: browsers attach credentials to
      // cross-origin upgrades, so an allow-list is enforced before the
      // handshake (and before any token in the URL/header is trusted).
      verifyClient: (info, callback) => {
        if (this.#originAllowed(info.origin)) {
          callback(true);
          return;
        }
        this.#logger.warn({
          origin:
            typeof info.origin === 'string' && info.origin.length > 0
              ? info.origin
              : null,
          msg: 'ws.origin.rejected',
        });
        callback(false, 403, 'Forbidden');
      },
    });
    this.#wss.on('connection', (socket, request) => {
      this.#onConnection(socket, request);
    });
    this.#wss.on('error', (err: Error) => {
      this.#logger.error({ err: String(err), msg: 'ws.server.error' });
    });

    // Live push: turn every committed event into a notification for the
    // authenticated sockets of its workspace. Unsubscribed in `close()`.
    if (options.livePush !== false) {
      this.#unsubscribeAppend = this.#events.onAppend((event) => {
        this.publishEvent(event);
      });
    }

    if (this.#heartbeatIntervalMs > 0) {
      this.#heartbeatTimer = setInterval(() => {
        this.sweepHeartbeat();
      }, this.#heartbeatIntervalMs);
      // Never keep the process alive just for the heartbeat.
      this.#heartbeatTimer.unref?.();
    }
  }

  // ---------------------------------------------------------------- registry

  /**
   * Origin policy for browser upgrades.
   *
   * - no Origin: allowed only when `allowMissingOrigin` is true (SDK/CLI);
   * - exact allow-list match: allowed;
   * - development may additionally accept localhost / 127.0.0.1 / [::1].
   */
  #originAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin.length === 0) {
      return this.#allowMissingOrigin;
    }
    if (this.#allowedOrigins.has(origin)) {
      return true;
    }
    if (!this.#allowLocalhostOrigins) {
      return false;
    }
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      return (
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]'
      );
    } catch {
      return false;
    }
  }

  /** Live sockets for an agent in a workspace (empty set when offline). */
  socketsFor(agentId: string, workspaceId: string = this.#workspaceId): Set<WsSession> {
    return this.#connections.get(workspaceId)?.get(agentId) ?? new Set<WsSession>();
  }

  /** Agent ids with at least one open socket in the workspace. */
  onlineAgents(workspaceId: string = this.#workspaceId): string[] {
    return [...(this.#connections.get(workspaceId)?.keys() ?? [])].sort();
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  /** Diagnostics/tests: bounded per-agent bucket registry size. */
  get agentBucketCount(): number {
    return this.#agentBuckets.size;
  }

  /** Set per-session domain event subscription (US-020). */
  setSessionSubscription(
    sessionId: string,
    subscription: WsSubscription,
  ): void {
    const session = [...this.#sessions].find((s) => s.id === sessionId);
    if (session !== undefined) {
      session.subscription = subscription;
    }
  }

  /** Check if a session's subscription allows a domain event. */
  #sessionWantsDomainEvent(session: WsSession, eventType: string): boolean {
    const sub = session.subscription;
    if (sub === undefined || !sub.includeDomainEvents) return false;
    if (sub.types === undefined || sub.types.length === 0) return true;
    return sub.types.includes(eventType);
  }

  // ------------------------------------------------------------- connection

  #onConnection(socket: WebSocket, request: IncomingMessage): void {
    const sessionId = randomUUID();
    const session = new WsSession({
      id: sessionId,
      socket,
      workspaceId: this.#workspaceId,
      logger: this.#logger.child({ sessionId }),
      connectionBucket: new TokenBucket({
        ratePerSecond: this.#connectionLimit.ratePerSecond,
        burst: this.#connectionLimit.burst,
        ...(this.#clock === undefined ? {} : { clock: this.#clock }),
      }),
      ...(request.socket.remoteAddress === undefined
        ? {}
        : { remoteAddress: request.socket.remoteAddress }),
    });
    this.#sessions.add(session);
    this.#logger.info({
      sessionId: session.id,
      remote: request.socket.remoteAddress ?? null,
      msg: 'ws.connection.opened',
    });

    socket.on('message', (data: unknown) => {
      this.#enqueue(session, data);
    });
    socket.on('pong', () => {
      session.isAlive = true;
    });
    socket.on('error', (err: Error) => {
      this.#logger.warn({ sessionId: session.id, err: String(err), msg: 'ws.socket.error' });
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.#onClose(session, code, reason.toString());
    });

    // Upgrade-handshake authentication (preferred: nothing is sent first).
    const token = extractBearerToken(request.headers.authorization);
    if (token !== undefined) {
      void this.#authenticateWithToken(session, token);
    }
  }

  async #authenticateWithToken(session: WsSession, token: string): Promise<void> {
    try {
      const auth = await this.#tokens.verify(token);
      this.#bindSession(session, auth);
    } catch (err) {
      const reason =
        typeof err === 'object' && err !== null && 'data' in err
          ? ((err as { data?: { reason?: string } }).data?.reason ?? 'invalid_token')
          : 'invalid_token';
      this.#logger.warn({
        sessionId: session.id,
        reason,
        msg: 'ws.handshake.unauthorized',
      });
      session.send(
        errorResponseFrame(
          null,
          JsonRpcErrorCode.Unauthorized,
          'Invalid or expired token',
          { reason },
        ),
      );
      session.markClosed();
      session.socket.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
    }
  }

  /** Bind identity, register the socket and announce it. */
  #bindSession(session: WsSession, auth: AuthContext): void {
    const previous = session.agentId;
    const workspaceId = auth.workspaceId ?? session.workspaceId;
    const alreadyBound =
      previous === auth.agentId &&
      (this.#connections.get(workspaceId)?.get(auth.agentId)?.has(session) ?? false);

    session.bind(auth);
    session.agentBucket = this.#bucketForAgent(auth.agentId);

    if (alreadyBound) {
      // Token refresh on a live socket: identity unchanged, stay quiet.
      return;
    }

    if (previous !== undefined) {
      this.#detachAgent(session, previous, session.workspaceId);
      this.#maybeBroadcastOffline(previous, session.workspaceId);
    }
    this.#attachAgent(session, auth.agentId, workspaceId);
    this.#sendWelcome(session);
    this.#broadcastPresence(auth.agentId, 'online', workspaceId, session);
    this.#logger.info({
      sessionId: session.id,
      agentId: auth.agentId,
      role: auth.role,
      workspaceId: session.workspaceId,
      msg: 'ws.authenticated',
    });
  }

  #attachAgent(session: WsSession, agentId: string, workspaceId: string): void {
    let byAgent = this.#connections.get(workspaceId);
    if (byAgent === undefined) {
      byAgent = new Map();
      this.#connections.set(workspaceId, byAgent);
    }
    const sockets = byAgent.get(agentId);
    if (sockets === undefined) {
      byAgent.set(agentId, new Set([session]));
      return;
    }
    sockets.add(session);
  }

  #detachAgent(session: WsSession, agentId: string, workspaceId: string): void {
    const byAgent = this.#connections.get(workspaceId);
    if (byAgent === undefined) return;
    const sockets = byAgent.get(agentId);
    if (sockets === undefined) return;
    sockets.delete(session);
    if (sockets.size === 0) byAgent.delete(agentId);
    if (byAgent.size === 0) this.#connections.delete(workspaceId);
  }

  #bucketForAgent(agentId: string): TokenBucket {
    return this.#agentBuckets.get(agentId);
  }

  #onClose(session: WsSession, code: number, reason: string): void {
    session.markClosed();
    this.#sessions.delete(session);
    this.#chains.delete(session.id);
    const agentId = session.agentId;
    if (agentId !== undefined) {
      this.#detachAgent(session, agentId, session.workspaceId);
      this.#maybeBroadcastOffline(agentId, session.workspaceId);
    }
    this.#logger.info({
      sessionId: session.id,
      agentId: agentId ?? null,
      code,
      reason,
      msg: 'ws.connection.closed',
    });
  }

  // -------------------------------------------------------------- messaging

  /** Serialise frame handling per socket (responses stay in request order). */
  #enqueue(session: WsSession, data: unknown): void {
    const previous = this.#chains.get(session.id) ?? Promise.resolve();
    const next = previous
      .then(() => this.#handleFrame(session, data))
      .catch((err: unknown) => {
        this.#logger.error({ sessionId: session.id, err: String(err), msg: 'ws.frame.failed' });
      });
    this.#chains.set(session.id, next);
  }

  async #handleFrame(session: WsSession, data: unknown): Promise<void> {
    if (session.closed) return;
    const decoded = decodeFrame(data);
    if (!decoded.ok) {
      session.send(errorResponseFrame(null, JsonRpcErrorCode.ParseError, 'Parse error'));
      return;
    }

    const value = decoded.value;
    const controlType = controlFrameType(value);
    if (controlType !== undefined) {
      await this.#handleControlFrame(session, controlType, value);
      return;
    }
    await this.#handleRpc(session, value);
  }

  async #handleControlFrame(
    session: WsSession,
    controlType: string,
    value: unknown,
  ): Promise<void> {
    switch (controlType) {
      case 'ping':
        // Protocol-level heartbeat: echo the client timestamp.
        session.send(buildPongFrame(readPingTs(value)));
        return;
      case 'pong':
        session.isAlive = true;
        return;
      case 'resume':
        this.#handleResume(session, value);
        return;
      default:
        session.send(
          errorResponseFrame(null, JsonRpcErrorCode.InvalidRequest, 'Unknown control frame', {
            type: controlType,
          }),
        );
    }
  }

  async #handleRpc(session: WsSession, value: unknown): Promise<void> {
    const frame = interpretFrame(value);
    const isRequest = frame.kind === 'request';
    const requestId =
      frame.kind === 'request' ? frame.id : frame.kind === 'invalid' ? frame.id : null;
    const answerable = frame.kind === 'request' || frame.kind === 'invalid';

    // ---- connection-level rate limit (soft: -32005, socket stays open) ----
    const connectionDecision = session.connectionBucket.tryConsume();
    if (!connectionDecision.allowed) {
      this.#logger.warn({
        sessionId: session.id,
        agentId: session.agentId ?? null,
        scope: 'connection',
        retryAfterMs: connectionDecision.retryAfterMs,
        msg: 'ws.rate_limited',
      });
      if (answerable) {
        session.send(
          errorResponseFrame(
            requestId,
            JsonRpcErrorCode.RateLimited,
            'Rate limit exceeded',
            {
              scope: 'connection',
              limit: session.connectionBucket.ratePerSecond,
              burst: session.connectionBucket.burst,
              retryAfterMs: connectionDecision.retryAfterMs,
            },
          ),
        );
      }
      return;
    }

    // Identity resolved from this message's `params.token` (per-request auth).
    let requestAuth: AuthContext | undefined;

    if (frame.kind === 'request' || frame.kind === 'notification') {
      const method = frame.method;

      // ---- authentication gate ----
      if (!this.#mayCall(session, method, frame.params)) {
        this.#logger.warn({
          sessionId: session.id,
          method,
          msg: 'ws.unauthenticated',
        });
        if (isRequest) {
          session.send(
            errorResponseFrame(
              requestId,
              JsonRpcErrorCode.Unauthorized,
              'Authentication required',
              { reason: 'unauthenticated', method },
            ),
          );
        }
        return;
      }

      // ---- agent-level message limit (shared by all sockets of the agent) ----
      // The bucket key is the identity this message will *execute* as. A
      // `params.token` is an explicit per-request credential, so it takes
      // precedence over the handshake binding for this message; resolving it
      // here (and forwarding it to the dispatcher below) keeps the charged
      // bucket and the executed identity in agreement, and stops an unbound
      // third-party socket from escaping the agent limit altogether.
      if (this.#agentRateLimitedMethods.has(method)) {
        const resolved = await this.#resolveRequestAuth(session, frame.params);
        if (resolved.error !== undefined) {
          const error = resolved.error;
          this.#logger.warn({
            sessionId: session.id,
            method,
            code: error.code,
            msg: 'ws.request.auth.failed',
          });
          if (isRequest) {
            session.send(
              errorResponseFrame(requestId, error.code, error.message, error.data),
            );
          }
          return;
        }
        requestAuth = resolved.auth;
        if (
          requestAuth !== undefined &&
          (session.auth === undefined || session.auth.agentId !== requestAuth.agentId)
        ) {
          // Adopt the identity the message is charged to (also announces it),
          // so later frames on this socket are counted against the same agent.
          this.#bindSession(session, requestAuth);
        }
        const agentId = requestAuth?.agentId ?? session.agentId;
        if (agentId !== undefined) {
          const bucket = this.#bucketForAgent(agentId);
          const agentDecision = bucket.tryConsume();
          if (!agentDecision.allowed) {
            this.#logger.warn({
              sessionId: session.id,
              agentId,
              method,
              scope: 'agent',
              retryAfterMs: agentDecision.retryAfterMs,
              msg: 'ws.rate_limited',
            });
            if (isRequest) {
              session.send(
                errorResponseFrame(
                  requestId,
                  JsonRpcErrorCode.RateLimited,
                  'Rate limit exceeded',
                  {
                    scope: 'agent',
                    limit: bucket.ratePerSecond,
                    burst: bucket.burst,
                    retryAfterMs: agentDecision.retryAfterMs,
                  },
                ),
              );
            }
            return;
          }
        }
      }
    }

    const dispatchAuth = requestAuth ?? session.auth;
    const outcome = await this.#dispatcher.dispatch(value, {
      ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
      workspaceId: session.workspaceId,
      ...(dispatchAuth === undefined ? {} : { auth: dispatchAuth }),
      ...(session.remoteAddress === undefined
        ? {}
        : { remoteAddress: session.remoteAddress }),
      logger: session.logger,
    });

    if (outcome.response !== undefined) {
      session.send(outcome.response);
      // An in-band register/authenticate establishes the identity for the
      // socket: verify the freshly minted token and bind it.
      if (outcome.response.result !== undefined && outcome.response.result !== null) {
        const token = (outcome.response.result as { token?: unknown }).token;
        if (typeof token === 'string') {
          try {
            const auth = await this.#tokens.verify(token);
            this.#bindSession(session, auth);
          } catch (err) {
            this.#logger.warn({
              sessionId: session.id,
              err: String(err),
              msg: 'ws.inband.token.invalid',
            });
          }
        }
      }
    }
  }

  /** May this socket call `method` right now? */
  #mayCall(session: WsSession, method: string, params: unknown): boolean {
    if (session.authenticated) return true;
    if (this.#anonymousMethods.has(method)) return true;
    // A per-message token is verified by the dispatcher, which then binds the
    // request (not the socket) identity — allowed for third-party clients.
    return readTokenFromParams(params) !== undefined;
  }

  /**
   * Identity this message will execute as.
   *
   * Precedence is "explicit per-request credential wins": a `params.token`
   * (the only credential a per-request-auth third-party client sends) is
   * verified here, otherwise the handshake binding applies. The gateway needs
   * the answer *before* dispatching, because the agent bucket must be charged
   * to that identity — and it forwards the very same auth to the dispatcher,
   * so the bucket and the executed identity cannot diverge.
   *
   * An unverifiable token fails the whole message with `-32001` rather than
   * silently falling back to the socket identity (the dispatcher's rule).
   */
  async #resolveRequestAuth(
    session: WsSession,
    params: unknown,
  ): Promise<{ auth?: AuthContext; error?: ProtocolError }> {
    const token = readTokenFromParams(params);
    if (token !== undefined) {
      try {
        return { auth: await this.#tokens.verify(token) };
      } catch (err) {
        return {
          error:
            err instanceof ProtocolError
              ? err
              : new ProtocolError(
                  JsonRpcErrorCode.Unauthorized,
                  'Invalid or expired token',
                ),
        };
      }
    }
    return session.auth === undefined ? {} : { auth: session.auth };
  }

  #sendWelcome(session: WsSession): void {
    const seq = this.#events.head(session.workspaceId);
    session.send(
      buildWelcomeFrame({
        epoch: this.epoch,
        seq,
        ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        replayWindow: this.#resumeMaxEvents,
        heartbeatIntervalMs: this.#heartbeatIntervalMs,
        serverTime: Date.now(),
      }),
    );
    session.advance(seq);
  }

  // ------------------------------------------------------------------ resume

  /**
   * Client → server `resume`. Three outcomes:
   *
   * 1. `lastSeenEpoch` present **and** different → `gap_too_large`
   *    (`epoch_mismatch`): the server restarted, cursors are meaningless.
   * 2. gap larger than the replay window → `gap_too_large` (`buffer_exceeded`).
   * 3. otherwise `ack` (with epoch + watermark) followed by the missing event
   *    notifications in ascending `seq`, skipping `seq`s already sent on this
   *    socket.
   */
  #handleResume(session: WsSession, value: unknown): void {
    // The event log is tenant data: an unauthenticated socket must not be able
    // to `resume` its way into the replay stream. Only register/authenticate
    // (and protocol ping/pong) are reachable before the handshake.
    if (!session.authenticated) {
      this.#logger.warn({
        sessionId: session.id,
        msg: 'ws.unauthenticated',
      });
      session.send(
        errorResponseFrame(null, JsonRpcErrorCode.Unauthorized, 'Authentication required', {
          reason: 'unauthenticated',
          frame: 'resume',
        }),
      );
      return;
    }

    const resume = readResumeFrame(value);
    if (resume === undefined) {
      session.send(
        errorResponseFrame(
          null,
          JsonRpcErrorCode.InvalidParams,
          'Invalid resume frame',
          { reason: 'invalid_resume' },
        ),
      );
      return;
    }

    const currentSeq = this.#events.head(session.workspaceId);
    const epochMismatch =
      resume.lastSeenEpoch !== undefined && resume.lastSeenEpoch !== this.epoch;

    if (epochMismatch) {
      this.#logger.info({
        sessionId: session.id,
        agentId: session.agentId ?? null,
        clientEpoch: resume.lastSeenEpoch ?? null,
        epoch: this.epoch,
        msg: 'ws.resume.epoch_mismatch',
      });
      session.send(
        buildGapTooLargeFrame({
          epoch: this.epoch,
          fromSeq: resume.lastSeenSeq,
          currentSeq,
          window: this.#resumeMaxEvents,
          detail: 'epoch_mismatch',
        }),
      );
      return;
    }

    const gap = currentSeq - resume.lastSeenSeq;
    if (gap > this.#resumeMaxEvents) {
      this.#logger.warn({
        sessionId: session.id,
        lastSeenSeq: resume.lastSeenSeq,
        currentSeq,
        window: this.#resumeMaxEvents,
        msg: 'ws.resume.buffer_exceeded',
      });
      session.send(
        buildGapTooLargeFrame({
          epoch: this.epoch,
          fromSeq: resume.lastSeenSeq,
          currentSeq,
          window: this.#resumeMaxEvents,
          detail: 'buffer_exceeded',
        }),
      );
      return;
    }

    session.send(buildAckFrame(this.epoch, currentSeq));

    if (gap <= 0) {
      session.advance(currentSeq);
      return;
    }

    const rows = this.#events.listSince(
      resume.lastSeenSeq,
      this.#resumeMaxEvents,
      session.workspaceId,
    );
    let replayed = 0;
    for (const row of rows) {
      // Notification events always replay.
      if (isNotificationEventType(row.type)) {
        if (!session.markSent(row.seq)) continue;
        if (session.send(eventNotification(row))) replayed += 1;
        continue;
      }
      // Domain-only events: only replay if this session subscribed to them.
      if (this.#sessionWantsDomainEvent(session, row.type)) {
        if (!session.markSent(row.seq)) continue;
        if (session.send(eventNotification(row))) replayed += 1;
      }
    }
    session.advance(currentSeq);

    this.#logger.info({
      sessionId: session.id,
      agentId: session.agentId ?? null,
      lastSeenSeq: resume.lastSeenSeq,
      currentSeq,
      replayed,
      msg: 'ws.resume.completed',
    });
  }

  // ---------------------------------------------------------------- presence

  #broadcastPresence(
    agentId: string,
    status: PresenceUpdatePayload['status'],
    workspaceId: string,
    origin?: WsSession,
  ): void {
    const frame = presenceNotification({ agentId, status, at: Date.now() });
    for (const session of this.#sessions) {
      if (session === origin) continue;
      if (!session.authenticated) continue;
      // US-024: presence never crosses a workspace boundary.
      if (session.workspaceId !== workspaceId) continue;
      session.send(frame);
    }
  }

  /** Offline is only announced once the agent has no socket left in that workspace. */
  #maybeBroadcastOffline(agentId: string, workspaceId: string): void {
    if (this.#connections.get(workspaceId)?.has(agentId)) return;
    this.#broadcastPresence(agentId, 'offline', workspaceId);
  }

  // ---------------------------------------------------------------- broadcast

  /**
   * Push one freshly appended event to every authenticated socket of its
   * workspace as an event notification (`method: <event.type>`, `params.seq`).
   *
   * Semantics:
   * - Notification events are pushed to all authenticated sockets in the workspace.
   * - Domain-only event types (`message.created`, `task.bid.placed`, …) are
   *   only pushed to sessions that have subscribed via `system.subscribe`
   *   with `includeDomainEvents: true` and matching `types` filter.
   * - A `seq` already delivered on a socket is skipped (`WsSession.markSent`),
   *   so re-broadcasting the same row is a no-op *on the server side*;
   * - Unauthenticated sockets never see tenant data.
   *
   * @returns the number of sockets the notification was written to.
   */
  publishEvent(event: StoredEvent): number {
    const frame = eventNotification(event);
    let delivered = 0;
    const isNotification = isNotificationEventType(event.type);
    for (const session of this.#sessions) {
      if (!session.authenticated) continue;
      if (session.workspaceId !== event.workspaceId) continue;
      if (session.hasSent(event.seq)) continue;
      if (!isNotification && !this.#sessionWantsDomainEvent(session, event.type)) {
        continue;
      }
      // Only record the delivery once the write actually went out: a socket
      // that is closing must not lose the seq from its own dedupe set.
      if (!session.send(frame)) continue;
      session.markSent(event.seq);
      delivered += 1;
    }
    return delivered;
  }

  /**
   * Channel-scoped fan-out (US-007): push one notification event to the
   * authenticated sockets of `agentIds` **only**.
   *
   * `publishEvent` is workspace-wide because the event log is; a chat message
   * is not — only channel members may see it. The caller therefore supplies
   * the member list and this method resolves it against the live connection
   * registry, keeping every socket-level concern (workspace match, per-socket
   * `seq` dedupe, closed sockets) inside the gateway.
   *
   * @returns the number of sockets the notification was written to.
   */
  publishEventToAgents(event: StoredEvent, agentIds: Iterable<string>): number {
    if (!isNotificationEventType(event.type)) return 0;
    const frame = eventNotification(event);
    let delivered = 0;
    for (const agentId of agentIds) {
      const sockets = this.#connections.get(event.workspaceId)?.get(agentId);
      if (sockets === undefined) continue;
      for (const session of sockets) {
        if (!session.authenticated) continue;
        if (session.workspaceId !== event.workspaceId) continue;
        if (session.hasSent(event.seq)) continue;
        if (!session.send(frame)) continue;
        session.markSent(event.seq);
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Push a frame to every authenticated connection (e.g. `system.error`). */
  broadcast(frame: unknown): number {
    let delivered = 0;
    for (const session of this.#sessions) {
      if (!session.authenticated) continue;
      if (session.send(frame)) delivered += 1;
    }
    return delivered;
  }

  /** Notifier compatible with `RpcDispatcherOptions.onSystemError`. */
  readonly systemErrorNotifier: SystemErrorNotifier = (payload) => {
    this.broadcast(createSystemErrorNotification(payload));
  };

  // --------------------------------------------------------------- heartbeat

  /**
   * One heartbeat round: terminate sockets that missed the previous ping,
   * then ping the rest. Exposed for tests (deterministic, no timer needed).
   */
  sweepHeartbeat(): number {
    let terminated = 0;
    for (const session of this.#sessions) {
      if (session.closed) continue;
      if (!session.isAlive) {
        this.#logger.warn({ sessionId: session.id, msg: 'ws.heartbeat.timeout' });
        try {
          session.socket.terminate();
        } catch {
          /* already gone */
        }
        terminated += 1;
        continue;
      }
      session.isAlive = false;
      try {
        if (session.socket.readyState === WebSocket.OPEN) session.socket.ping();
      } catch (err) {
        this.#logger.warn({ sessionId: session.id, err: String(err), msg: 'ws.ping.failed' });
      }
    }
    return terminated;
  }

  // -------------------------------------------------------------- lifecycle

  /** Stop the heartbeat and close every socket (Fastify `onClose`). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeatTimer !== undefined) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    if (this.#unsubscribeAppend !== undefined) {
      this.#unsubscribeAppend();
      this.#unsubscribeAppend = undefined;
    }
    for (const session of this.#sessions) {
      session.markClosed();
      try {
        session.socket.terminate();
      } catch {
        /* already closed */
      }
    }
    this.#sessions.clear();
    this.#chains.clear();
    this.#connections.clear();
    await new Promise<void>((resolve) => {
      this.#wss.close(() => resolve());
    });
  }
}
