/**
 * Workspace lifecycle RPCs (US-025): create / list / disable.
 *
 * These are **platform-admin** operations (`admin` role only), not
 * workspace-scoped admin: a `workspace_admin` administers inside one tenant but
 * cannot mint or disable tenants. Creating a workspace also mints an invite code
 * (redeemable at `agent.register`) that lets agents join that tenant without
 * ever seeing its id.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  JsonRpcErrorCode,
  METHODS,
  ProtocolError,
  workspaceCreateParamsSchema,
  workspaceDisableParamsSchema,
} from '@agentmesh/protocol';
import type { WorkspacesDao } from '@agentmesh/store';
import type { Logger } from 'pino';

import { ADMIN_ROLES, requireRole } from '../auth/roles.js';
import type { HandlerRegistry } from '../registry.js';

export interface WorkspaceModuleOptions {
  readonly workspaces: WorkspacesDao;
  readonly logger?: Logger;
  /** Invite code lifetime (seconds). Default 7 days. */
  readonly inviteTtlSeconds?: number;
  readonly clock?: () => number;
}

const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

export function registerWorkspaceModule(
  registry: HandlerRegistry,
  options: WorkspaceModuleOptions,
): void {
  const clock = options.clock ?? (() => Date.now());
  const ttl = options.inviteTtlSeconds ?? DEFAULT_INVITE_TTL_SECONDS;

  registry.registerHandler(
    METHODS.workspace.create,
    async (ctx, params) => {
      requireRole(ctx, ADMIN_ROLES);
      const parsed = workspaceCreateParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new ProtocolError(
          JsonRpcErrorCode.InvalidParams,
          'workspace.create params invalid',
          { issues: parsed.error.issues },
        );
      }
      const now = clock();
      const id = `ws_${randomUUID()}`;
      const inviteCode = randomBytes(18).toString('base64url');
      const inviteExpiresAt = now + ttl * 1000;
      const ws = options.workspaces.create({
        id,
        name: parsed.data.name,
        createdAt: now,
        inviteCode,
        inviteExpiresAt,
        maxAgents: parsed.data.maxAgents ?? 100,
      });
      options.logger?.info?.({
        workspaceId: ws.id,
        maxAgents: ws.maxAgents,
        msg: 'workspace.created',
      });
      return {
        workspace: {
          id: ws.id,
          name: ws.name,
          createdAt: ws.createdAt,
          maxAgents: ws.maxAgents,
          disabledAt: ws.disabledAt,
        },
        inviteCode,
        inviteExpiresAt,
      };
    },
    { description: 'Create a tenant + invite code (platform admin only)' },
  );

  registry.registerHandler(
    METHODS.workspace.list,
    async (ctx) => {
      requireRole(ctx, ADMIN_ROLES);
      return {
        workspaces: options.workspaces.list().map((ws) => ({
          id: ws.id,
          name: ws.name,
          createdAt: ws.createdAt,
          maxAgents: ws.maxAgents,
          disabledAt: ws.disabledAt,
        })),
      };
    },
    { description: 'List tenants (platform admin only)' },
  );

  registry.registerHandler(
    METHODS.workspace.disable,
    async (ctx, params) => {
      requireRole(ctx, ADMIN_ROLES);
      const parsed = workspaceDisableParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new ProtocolError(
          JsonRpcErrorCode.InvalidParams,
          'workspace.disable params invalid',
          { issues: parsed.error.issues },
        );
      }
      const target = options.workspaces.get(parsed.data.workspaceId);
      if (target === undefined) {
        throw new ProtocolError(JsonRpcErrorCode.NotFound, 'workspace not found');
      }
      if (target.id === 'default') {
        throw new ProtocolError(
          JsonRpcErrorCode.Forbidden,
          'the default workspace cannot be disabled',
        );
      }
      const changed = options.workspaces.disable(target.id, clock());
      options.logger?.info?.({ workspaceId: target.id, msg: 'workspace.disabled' });
      return { disabled: true as const, workspaceId: target.id, changed };
    },
    { description: 'Disable a tenant — blocks new auth (platform admin only)' },
  );
}
