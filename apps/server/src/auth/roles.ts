/**
 * Roles and authorisation helpers.
 *
 * Three roles exist:
 *
 * | role       | meaning                                                    |
 * |------------|------------------------------------------------------------|
 * | `admin`    | full operator: manage accounts, override task assignment   |
 * | `agent`    | worker identity: publish/bid/work, read the roster         |
 * | `observer` | read-only spectator: no mutations, no account listing      |
 *
 * Handlers call {@link requireRole} (or {@link requireAuth}) at the top of
 * their implementation. Failures are *expected* protocol errors, so the
 * dispatcher maps them to the standard codes and does not emit `system.error`:
 *
 * - no/invalid identity → `-32001 Unauthorized`
 * - known identity, role not allowed → `-32002 Forbidden`
 *
 * The helpers accept any object carrying `auth` / `agentId` / `role`, which
 * keeps this module free of an import cycle with the handler registry while
 * still type-checking against `HandlerContext`.
 */

import { JsonRpcErrorCode, ProtocolError } from '@agentmesh/protocol';
import type { AccountRole } from '@agentmesh/protocol';

/** Canonical role names (aliased from the protocol contract). */
export const ROLES = ['admin', 'workspace_admin', 'agent', 'observer'] as const;

/** Alias kept for readability in the server's own code. */
export type Role = AccountRole;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Identity established for one request (from a verified JWT). */
export interface AuthContext {
  readonly agentId: string;
  readonly role: Role;
  /**
   * Tenant the identity was issued for. When present the dispatcher uses it as
   * the request workspace, overriding any transport header.
   */
  readonly workspaceId?: string;
  /** Epoch seconds; present when the identity came from a JWT. */
  readonly expiresAt?: number;
  /**
   * JWT `jti`, present when the identity came from a token. The WS gateway
   * uses it to terminate live sessions when that token is revoked.
   */
  readonly tokenId?: string;
}

/**
 * Structural subset of `HandlerContext` the authorisation helpers need.
 * Using a structural type (instead of importing `HandlerContext`) avoids a
 * module cycle: `registry.ts` imports `Role` from here.
 */
export interface AuthCarrier {
  readonly agentId?: string;
  readonly role?: Role;
  readonly auth?: AuthContext;
}

/** Roles allowed to list accounts (read-only roster). */
export const ACCOUNT_LIST_ROLES: readonly Role[] = ['admin', 'workspace_admin', 'agent'];
/**
 * Roles allowed to mutate other accounts / administrative state **within their
 * own workspace** (US-025). `workspace_admin` is an admin scoped to one tenant;
 * platform-wide operations (workspace.create/list/disable) stay `admin` only.
 */
export const WORKSPACE_ADMIN_ROLES: readonly Role[] = ['admin', 'workspace_admin'];
/** Platform-wide admin only (cross-tenant operations). */
export const ADMIN_ROLES: readonly Role[] = ['admin'];

/** True when the request carries a verified identity. */
export function isAuthenticated(ctx: AuthCarrier): ctx is AuthCarrier & {
  auth: AuthContext;
} {
  return ctx.auth !== undefined;
}

/**
 * Return the caller's identity or throw `-32001`.
 *
 * Falls back to a legacy `agentId` + `role` pair on the context so transports
 * that authenticate out-of-band (tests, future mTLS) work unchanged.
 */
export function requireAuth(ctx: AuthCarrier): AuthContext {
  if (ctx.auth !== undefined) {
    return ctx.auth;
  }
  if (ctx.agentId !== undefined && ctx.role !== undefined) {
    return { agentId: ctx.agentId, role: ctx.role };
  }
  throw new ProtocolError(JsonRpcErrorCode.Unauthorized, 'Authentication required');
}

/**
 * Require one of `allowed` roles; throws `-32001` when unauthenticated and
 * `-32002` when the identity is known but not permitted.
 *
 * ```ts
 * const auth = requireRole(ctx, ADMIN_ROLES);
 * ```
 */
export function requireRole(
  ctx: AuthCarrier,
  allowed: readonly Role[],
): AuthContext {
  const auth = requireAuth(ctx);
  if (!allowed.includes(auth.role)) {
    throw new ProtocolError(
      JsonRpcErrorCode.Forbidden,
      `Role "${auth.role}" is not allowed to call this method`,
      { role: auth.role, required: allowed },
    );
  }
  return auth;
}

/** Non-throwing variant for branching inside a handler. */
export function hasRole(ctx: AuthCarrier, allowed: readonly Role[]): boolean {
  return ctx.auth !== undefined && allowed.includes(ctx.auth.role);
}
