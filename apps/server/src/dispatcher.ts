/**
 * JSON-RPC dispatcher.
 *
 * Owns the transport-independent part of the server: parse a framed message,
 * classify it (request / notification / response), route by method to the
 * plugin registry, run the handler and map thrown errors onto JSON-RPC error
 * objects. Transports (HTTP POST now, WebSocket in US-006) only frame bytes
 * and call {@link RpcDispatcher.dispatch}.
 *
 * Classification follows JSON-RPC 2.0 semantics rather than a zod union:
 * a *notification* is a request that has **no `id` member at all**. A frame
 * with `id: null` (or any other id value) is a request and must be answered
 * with that same id. Only structurally broken JSON-RPC objects are rejected
 * with `-32600`; unparseable text is `-32700`.
 *
 * Correlation: every dispatched message gets a unique `reqId` which is
 * injected into the log context *and* into any emitted `system.error`
 * notification, so a client-visible failure can be traced to its log line.
 */

import { randomUUID } from 'node:crypto';

import { JSON_RPC_VERSION, JsonRpcErrorCode, ProtocolError } from '@agentmesh/protocol';
import type {
  JsonRpcErrorObject,
  JsonRpcId,
  JsonRpcMessageKind,
  JsonRpcNotification,
  JsonRpcParams,
  SystemErrorPayload,
} from '@agentmesh/protocol';
import type { Logger } from 'pino';

import { serializeError } from './logging.js';
import { readTokenFromParams } from './auth/token.js';
import type { AuthContext } from './auth/roles.js';
import { DEFAULT_WORKSPACE_ID, type HandlerRegistry } from './registry.js';

/** Transport-provided context for one inbound message. */
export interface DispatchContext {
  /** Set by the transport when the connection is authenticated. */
  readonly agentId?: string;
  /**
   * Transport-suggested tenant scope, defaults to `default`. Ignored whenever
   * the request carries a verified token: then `auth.workspaceId` is the scope.
   */
  readonly workspaceId?: string;
  /** Optional pre-allocated id (e.g. HTTP header); generated when absent. */
  readonly reqId?: string;
  /** Optional parent logger (e.g. a connection-scoped child). */
  readonly logger?: Logger;
  /** Identity already verified by the transport (WS handshake in US-006). */
  readonly auth?: AuthContext;
  /**
   * Raw bearer token found by the transport (HTTP `Authorization` header).
   * Verified by the dispatcher and never forwarded to handlers.
   */
  readonly token?: string;
  /** Peer address of the transport connection, used for anonymous limits. */
  readonly remoteAddress?: string;
}

/**
 * Response envelope as emitted by the dispatcher.
 *
 * `id` is the client's id echoed **verbatim**: JSON-RPC ids are strings or
 * numbers (`null` when the server could not read one, e.g. `-32700`), but a
 * well-formed request carrying a non-standard id (object, boolean, …) must
 * still be answered with exactly that value so the client can correlate it.
 */
export interface RpcResponse {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: unknown;
  readonly result?: unknown;
  readonly error?: JsonRpcErrorObject;
}

/** Result of one dispatch, including the correlation id and timings. */
export interface DispatchOutcome {
  readonly reqId: string;
  readonly kind: JsonRpcMessageKind | 'invalid';
  readonly method: string | null;
  readonly agentId: string | null;
  readonly durationMs: number;
  /** Present for requests (success or error); absent for notifications. */
  readonly response?: RpcResponse;
}

/** Hook used to publish a `system.error` notification (wired to WS in US-006). */
export type SystemErrorNotifier = (
  payload: SystemErrorPayload,
) => void | Promise<void>;

export interface RpcDispatcherOptions {
  readonly registry: HandlerRegistry;
  readonly logger: Logger;
  readonly workspaceId?: string;
  /** Override id generation (tests inject a deterministic counter). */
  readonly reqIdFactory?: () => string;
  /** Emit a `system.error` notification for unexpected internal errors. */
  readonly onSystemError?: SystemErrorNotifier;
  /**
   * Verify a bearer token into an identity. Wired to `TokenService.verify` by
   * `buildServer`; omitted in tests that do not exercise authentication.
   */
  readonly tokenVerifier?: (token: string) => Promise<AuthContext> | AuthContext;
}

/**
 * Build the JSON-RPC notification a server pushes when a request fails
 * internally. The payload carries the same `reqId` as the dispatcher log line.
 */
export function createSystemErrorNotification(
  payload: SystemErrorPayload,
): JsonRpcNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: 'system.error',
    // SystemErrorPayload is a plain object; the params union also accepts
    // positional arrays, hence the narrowing cast.
    params: payload as unknown as JsonRpcParams,
  };
}

function readAgentId(params: unknown): string | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return null;
  }
  const agentId = (params as Record<string, unknown>).agentId;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : null;
}

function errorObjectFor(err: unknown): JsonRpcErrorObject {
  if (err instanceof ProtocolError) {
    return err.data === undefined
      ? { code: err.code, message: err.message }
      : { code: err.code, message: err.message, data: err.data };
  }
  // Never leak internals over the wire; the full error goes to the log line.
  return {
    code: JsonRpcErrorCode.InternalError,
    message: 'Internal error',
  };
}

// ---------------------------------------------------------------------------
// Frame classification
// ---------------------------------------------------------------------------

/** True for a JSON object (arrays and `null` excluded). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own-property check: `id: undefined` still counts as "id present". */
function hasMember(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Result of interpreting one decoded frame.
 *
 * - `request`      — has `method` **and** an `id` member (any id value).
 * - `notification` — has `method` and no `id` member (never answered).
 * - `response`     — has `result`/`error` and no `method` (server-side drop).
 * - `invalid`      — not a legal JSON-RPC envelope → `-32600`.
 */
export type FrameInterpretation =
  | {
      readonly kind: 'request';
      readonly id: unknown;
      readonly method: string;
      readonly params: unknown;
    }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'response' }
  | { readonly kind: 'invalid'; readonly id: JsonRpcId | null; readonly reason: string };

/**
 * Classify one decoded frame with JSON-RPC 2.0 semantics.
 *
 * Exported so transports that need to inspect a frame *before* dispatching
 * (the WS gateway gates rate limits / authentication on the method) use the
 * exact same rules as the dispatcher instead of duplicating them.
 */
export function interpretFrame(value: unknown): FrameInterpretation {
  if (!isJsonObject(value)) {
    return { kind: 'invalid', id: null, reason: 'frame is not a JSON object' };
  }

  // Only JSON-RPC-legal ids (string / number / null) can be reflected on an
  // error response; anything else degrades to a null id.
  const echoId: JsonRpcId | null =
    typeof value.id === 'string' || typeof value.id === 'number' || value.id === null
      ? value.id
      : null;

  if (hasMember(value, 'method')) {
    if (value.jsonrpc !== JSON_RPC_VERSION) {
      return { kind: 'invalid', id: echoId, reason: 'unsupported jsonrpc version' };
    }
    if (typeof value.method !== 'string' || value.method.length === 0) {
      return { kind: 'invalid', id: echoId, reason: 'method must be a non-empty string' };
    }
    if (
      hasMember(value, 'params') &&
      !isJsonObject(value.params) &&
      !Array.isArray(value.params)
    ) {
      return { kind: 'invalid', id: echoId, reason: 'params must be an object or an array' };
    }
    return hasMember(value, 'id')
      ? { kind: 'request', id: value.id, method: value.method, params: value.params }
      : { kind: 'notification', method: value.method, params: value.params };
  }

  if (hasMember(value, 'result') || hasMember(value, 'error')) {
    return { kind: 'response' };
  }

  return { kind: 'invalid', id: echoId, reason: 'no method, result or error member' };
}

function successResponse(id: unknown, result: unknown): RpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function errorResponse(
  id: unknown,
  code: JsonRpcErrorCode,
  message: string,
  data?: unknown,
): RpcResponse {
  const error: JsonRpcErrorObject =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSON_RPC_VERSION, id, error };
}

/** JSON-RPC dispatcher: one per server instance, shared by all transports. */
export class RpcDispatcher {
  readonly #registry: HandlerRegistry;
  readonly #logger: Logger;
  readonly #workspaceId: string;
  readonly #reqIdFactory: () => string;
  readonly #onSystemError?: SystemErrorNotifier;
  readonly #tokenVerifier?: (token: string) => Promise<AuthContext> | AuthContext;

  constructor(options: RpcDispatcherOptions) {
    this.#registry = options.registry;
    this.#logger = options.logger;
    this.#workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
    this.#reqIdFactory = options.reqIdFactory ?? (() => randomUUID());
    if (options.onSystemError !== undefined) {
      this.#onSystemError = options.onSystemError;
    }
    if (options.tokenVerifier !== undefined) {
      this.#tokenVerifier = options.tokenVerifier;
    }
  }

  get registry(): HandlerRegistry {
    return this.#registry;
  }

  /**
   * Dispatch one raw framed message.
   *
   * - unparseable JSON text → `-32700` error response (`id: null`)
   * - legal JSON but not a legal JSON-RPC envelope → `-32600` (echoes the
   *   request id when it is a string/number/null, else `null`)
   * - `method` + `id` member (including `id: null`) → request, always answered
   * - `method` without an `id` member → notification, never answered
   * - unexpected response frame → ignored (logged at warn)
   * - unknown method → `-32601` for requests; notifications get no reply
   * - handler `ProtocolError` → its `code`/`message`/`data` are preserved
   * - any other throw → `-32603 Internal error` + `system.error` notification
   */
  async dispatch(
    rawMessage: unknown,
    ctx: DispatchContext = {},
  ): Promise<DispatchOutcome> {
    const reqId = ctx.reqId ?? this.#reqIdFactory();
    const callerLogger = ctx.logger ?? this.#logger;
    const log = callerLogger.child({ reqId });
    const startedAt = process.hrtime.bigint();

    const elapsed = (): number => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      return Math.round(durationMs * 1000) / 1000;
    };

    const finish = (
      outcome: Omit<DispatchOutcome, 'reqId' | 'durationMs'>,
      durationMs: number = elapsed(),
    ): DispatchOutcome => ({ ...outcome, reqId, durationMs });

    // ---- decode ----------------------------------------------------------
    // Transports normally hand over an already-parsed value; raw text is
    // accepted too so `-32700` stays reachable from a plain POST body.
    let parsed: unknown = rawMessage;
    if (typeof rawMessage === 'string') {
      try {
        parsed = JSON.parse(rawMessage) as unknown;
      } catch (err) {
        const durationMs = elapsed();
        log.warn({
          method: null,
          agentId: null,
          durationMs,
          err: serializeError(err),
          msg: 'rpc.parse.error',
        });
        return finish(
          {
            kind: 'invalid',
            method: null,
            agentId: null,
            response: errorResponse(null, JsonRpcErrorCode.ParseError, 'Parse error'),
          },
          durationMs,
        );
      }
    }

    // ---- classify --------------------------------------------------------
    const frame = interpretFrame(parsed);

    // A server never expects a response frame; drop it but keep a trace.
    if (frame.kind === 'response') {
      log.warn({
        method: null,
        agentId: null,
        durationMs: 0,
        msg: 'rpc.unexpected.response',
      });
      return finish({ kind: 'response', method: null, agentId: null }, 0);
    }

    if (frame.kind === 'invalid') {
      const durationMs = elapsed();
      log.warn({
        method: null,
        agentId: null,
        durationMs,
        code: JsonRpcErrorCode.InvalidRequest,
        reason: frame.reason,
        msg: 'rpc.invalid.request',
      });
      return finish(
        {
          kind: 'invalid',
          method: null,
          agentId: null,
          response: errorResponse(
            frame.id,
            JsonRpcErrorCode.InvalidRequest,
            'Invalid request',
          ),
        },
        durationMs,
      );
    }

    const method = frame.method;
    const isRequest = frame.kind === 'request';
    const id: unknown = isRequest ? frame.id : null;
    // Transport-supplied identity wins; fall back to params.agentId for logs.
    const agentId = ctx.agentId ?? readAgentId(frame.params) ?? null;
    const handler = this.#registry.getHandler(method);

    if (handler === undefined) {
      const durationMs = elapsed();
      log.warn({
        method,
        agentId,
        durationMs,
        code: JsonRpcErrorCode.MethodNotFound,
        msg: 'rpc.method.not_found',
      });
      return finish(
        {
          kind: frame.kind,
          method,
          agentId,
          ...(isRequest
            ? {
                response: errorResponse(
                  id,
                  JsonRpcErrorCode.MethodNotFound,
                  `Method not found: ${method}`,
                ),
              }
            : {}),
        },
        durationMs,
      );
    }

    // ---- authenticate ----------------------------------------------------
    // A transport may have verified the token already (`ctx.auth`, e.g. the WS
    // handshake); otherwise verify the bearer token it found (`Authorization`
    // header over HTTP) or one carried in `params.token`. An invalid token
    // fails the whole message with -32001 instead of degrading to anonymous —
    // otherwise a client could "try again" with a broken credential unnoticed.
    const authOutcome = await this.#resolveAuth(ctx, frame.params);
    if (authOutcome.error !== undefined) {
      const durationMs = elapsed();
      log.warn({
        method,
        agentId,
        durationMs,
        code: authOutcome.error.code,
        err: serializeError(authOutcome.error),
        msg: 'rpc.auth.failed',
      });
      return finish(
        {
          kind: frame.kind,
          method,
          agentId,
          ...(isRequest
            ? {
                response: errorResponse(
                  id,
                  authOutcome.error.code,
                  authOutcome.error.message,
                  authOutcome.error.data,
                ),
              }
            : {}),
        },
        durationMs,
      );
    }
    const auth = authOutcome.auth;
    // A verified identity pins the tenant: the token's `workspaceId` wins over
    // any transport hint (`X-Workspace-Id`), so a client cannot widen its scope
    // by rewriting a header. Anonymous requests keep the transport/default
    // workspace; `requireRole` decides whether that is enough for the method.
    const workspaceId = auth?.workspaceId ?? ctx.workspaceId ?? this.#workspaceId;
    // The authenticated identity also wins for the handler's `agentId`, so a
    // spoofed header cannot make audit logs disagree with authorisation.
    const callerId = auth?.agentId ?? agentId;

    // ---- invoke ----------------------------------------------------------
    const handlerLogger = log.child({ method, agentId: callerId });
    try {
      const result = await handler(
        {
          reqId,
          ...(callerId === null ? {} : { agentId: callerId }),
          workspaceId,
          logger: handlerLogger,
          ...(auth === undefined ? {} : { auth, role: auth.role }),
          ...(ctx.remoteAddress === undefined
            ? {}
            : { remoteAddress: ctx.remoteAddress }),
        },
        frame.params ?? {},
      );
      const durationMs = elapsed();
      log.info({
        method,
        agentId: callerId,
        durationMs,
        msg: isRequest ? 'rpc.request.completed' : 'rpc.notification.handled',
      });
      return finish(
        {
          kind: frame.kind,
          method,
          agentId: callerId,
          ...(isRequest ? { response: successResponse(id, result ?? null) } : {}),
        },
        durationMs,
      );
    } catch (err) {
      const durationMs = elapsed();
      const errorObject = errorObjectFor(err);
      const expected = err instanceof ProtocolError;

      log[expected ? 'warn' : 'error']({
        method,
        agentId: callerId,
        durationMs,
        code: errorObject.code,
        err: serializeError(err),
        msg: 'rpc.request.failed',
      });

      if (!expected) {
        await this.#emitSystemError({
          message: errorObject.message,
          code: errorObject.code,
          reqId,
          method,
          ...(callerId === null ? {} : { agentId: callerId }),
        });
      }

      return finish(
        {
          kind: frame.kind,
          method,
          agentId: callerId,
          ...(isRequest
            ? {
                response: errorResponse(
                  id,
                  errorObject.code,
                  errorObject.message,
                  errorObject.data,
                ),
              }
            : {}),
        },
        durationMs,
      );
    }
  }

  /**
   * Resolve the caller identity for one message.
   *
   * Precedence: already-verified `ctx.auth` → `ctx.token` (transport) →
   * `params.token`. Absent credentials resolve to "anonymous" (no error);
   * handlers decide whether authentication is required via `requireRole`.
   */
  async #resolveAuth(
    ctx: DispatchContext,
    params: unknown,
  ): Promise<{ auth?: AuthContext; error?: ProtocolError }> {
    if (ctx.auth !== undefined) {
      return { auth: ctx.auth };
    }
    const token = ctx.token ?? readTokenFromParams(params);
    if (token === undefined || this.#tokenVerifier === undefined) {
      return {};
    }
    try {
      return { auth: await this.#tokenVerifier(token) };
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

  async #emitSystemError(payload: SystemErrorPayload): Promise<void> {
    if (this.#onSystemError === undefined) return;
    try {
      await this.#onSystemError(payload);
    } catch (err) {
      this.#logger.warn({
        reqId: payload.reqId ?? null,
        method: payload.method ?? null,
        agentId: payload.agentId ?? null,
        err: serializeError(err),
        msg: 'rpc.system_error.emit.failed',
      });
    }
  }
}

/** Convenience factory used by `buildServer`. */
export function createDispatcher(options: RpcDispatcherOptions): RpcDispatcher {
  return new RpcDispatcher(options);
}
