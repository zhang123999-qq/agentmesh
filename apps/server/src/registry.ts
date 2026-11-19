/**
 * Plugin / feature-module registry.
 *
 * Feature modules (US-005 auth, US-007 tasks, …) plug into the server by
 * registering one handler per protocol method. The dispatcher owns the wire
 * concerns; handlers only see a decoded `params` value and a request-scoped
 * context.
 */

import type { Logger } from 'pino';

import type { AuthContext, Role } from './auth/roles.js';

export const DEFAULT_WORKSPACE_ID = 'default';

/** Per-request context handed to every handler. */
export interface HandlerContext {
  /** Unique id correlating logs and `system.error` notifications. */
  readonly reqId: string;
  /** Authenticated agent, when the transport knows it (US-005/006). */
  readonly agentId?: string;
  /** Tenant workspace; every store call is scoped by it. */
  readonly workspaceId: string;
  /** Child logger already bound to `reqId`/`method`/`agentId`. */
  readonly logger: Logger;
  /** Verified identity (JWT-backed) for this request, when present. */
  readonly auth?: AuthContext;
  /** Shortcut for `ctx.auth?.role`; populated by the dispatcher. */
  readonly role?: Role;
  /** Peer address of the transport connection, when the transport knows it. */
  readonly remoteAddress?: string;
}

/** Decoded JSON-RPC `params` (named object or positional array). */
export type HandlerParams = Record<string, unknown> | unknown[];

/**
 * A method handler. Throw `ProtocolError` for expected failures; anything else
 * is mapped to `-32603 Internal error` by the dispatcher.
 */
export type RpcHandler = (
  ctx: HandlerContext,
  params: unknown,
) => unknown | Promise<unknown>;

export interface RegisterHandlerOptions {
  /** Human-readable description (metadata only, for debugging). */
  readonly description?: string;
  /** Replace an existing handler instead of throwing. Default: false. */
  readonly override?: boolean;
}

/** Public registry API feature modules depend on. */
export interface HandlerRegistry {
  /**
   * Register a handler for a protocol method name.
   * @throws {DuplicateHandlerError} when the method is already registered and
   *   `options.override` is not `true`.
   */
  registerHandler(
    method: string,
    handler: RpcHandler,
    options?: RegisterHandlerOptions,
  ): void;

  hasHandler(method: string): boolean;
  getHandler(method: string): RpcHandler | undefined;
  getDescription(method: string): string | undefined;
  /** Registered method names, sorted for stable output. */
  listMethods(): string[];
}

export class DuplicateHandlerError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`handler already registered for method "${method}"`);
    this.name = 'DuplicateHandlerError';
    this.method = method;
  }
}

interface Registration {
  readonly handler: RpcHandler;
  readonly description?: string;
}

export class HandlerRegistryImpl implements HandlerRegistry {
  readonly #handlers = new Map<string, Registration>();

  registerHandler(
    method: string,
    handler: RpcHandler,
    options: RegisterHandlerOptions = {},
  ): void {
    if (typeof method !== 'string' || method.trim() === '') {
      throw new TypeError('method must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`handler for "${method}" must be a function`);
    }
    if (this.#handlers.has(method) && options.override !== true) {
      throw new DuplicateHandlerError(method);
    }
    const registration: Registration =
      options.description === undefined
        ? { handler }
        : { handler, description: options.description };
    this.#handlers.set(method, registration);
  }

  hasHandler(method: string): boolean {
    return this.#handlers.has(method);
  }

  getHandler(method: string): RpcHandler | undefined {
    return this.#handlers.get(method)?.handler;
  }

  getDescription(method: string): string | undefined {
    return this.#handlers.get(method)?.description;
  }

  listMethods(): string[] {
    return [...this.#handlers.keys()].sort();
  }
}

/** Create an empty registry (one per server instance). */
export function createHandlerRegistry(): HandlerRegistry {
  return new HandlerRegistryImpl();
}
