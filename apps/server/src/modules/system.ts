/**
 * System feature module (US-020).
 *
 * Methods (see `METHODS.system` in `@agentmesh/protocol`):
 *
 * - `system.subscribe` — admin only: add an opt-in subscription for
 *   domain-only events to the existing notification broadcast on the
 *   calling socket. Does not replace or diminish the workspace-wide
 *   broadcast of notification events.
 */

import { METHODS } from '@agentmesh/protocol';
import type { HandlerRegistry } from '../registry.js';
import { WORKSPACE_ADMIN_ROLES, requireRole } from '../auth/roles.js';
import type { WsGateway } from '../ws/gateway.js';

export interface SystemModuleOptions {
  /** Gateway for per-session subscription state. */
  readonly gateway: WsGateway;
  /** Tenant scope; defaults to the gateway's workspace. */
  readonly workspaceId?: string;
}

export interface SubscribeInput {
  /** Include domain-only events (default false). Requires admin role. */
  includeDomainEvents?: boolean;
  /** Optional filter: only receive these event types (applies to domain events if enabled). */
  types?: readonly string[];
}

export interface SubscribeResult {
  readonly subscribed: true;
  readonly includeDomainEvents: boolean;
  readonly types: readonly string[] | undefined;
}

/**
 * Register the system module handlers.
 */
export function registerSystemModule(
  registry: HandlerRegistry,
  options: SystemModuleOptions,
): void {
  const { gateway } = options;

  registry.registerHandler(
    METHODS.system.subscribe,
    async (ctx, params) => {
      requireRole(ctx, WORKSPACE_ADMIN_ROLES);

      const input = params as Record<string, unknown>;
      const includeDomainEvents = input.includeDomainEvents === true;
      const types = Array.isArray(input.types)
        ? input.types.filter((t): t is string => typeof t === 'string' && t.length > 0)
        : undefined;

      // Mark this session's subscription in the gateway.
      const session = ctx.session;
      if (session !== undefined) {
        gateway.setSessionSubscription(session.id, {
          includeDomainEvents,
          types,
        });
      }

      return {
        subscribed: true as const,
        includeDomainEvents,
        types,
      };
    },
    {
      description:
        'Admin opt-in domain events subscription (added to existing notification broadcast)',
    },
  );
}