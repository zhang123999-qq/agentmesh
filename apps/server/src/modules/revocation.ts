/**
 * Token revocation RPC (US-021D).
 *
 * `agent.revokeToken` (admin-only) revokes a single issued JWT by its `jti`
 * until it expires. The caller passes the token being revoked; the server
 * derives `jti`/`exp` from it and never logs the token. The actual rejection
 * happens inside `TokenService.verify` (shared by the WS gateway and the HTTP
 * dispatcher), so a revoked token fails uniformly with `-32001`.
 */
import {
  agentRevokeTokenParamsSchema,
  JsonRpcErrorCode,
  METHODS,
  ProtocolError,
} from '@agentmesh/protocol';
import type { Logger } from 'pino';

import type { TokenRevocationRegistry } from '../auth/revocation.js';
import { requireRole } from '../auth/roles.js';
import type { TokenService } from '../auth/token.js';
import type { HandlerRegistry } from '../registry.js';

export interface RevocationModuleOptions {
  readonly tokens: TokenService;
  readonly revocations: TokenRevocationRegistry;
  readonly logger?: Logger;
}

export function registerRevocationModule(
  registry: HandlerRegistry,
  options: RevocationModuleOptions,
): void {
  registry.registerHandler(
    METHODS.agent.revokeToken,
    async (ctx, params) => {
      requireRole(ctx, ['admin']);
      const parsed = agentRevokeTokenParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new ProtocolError(
          JsonRpcErrorCode.InvalidParams,
          'agent.revokeToken params invalid',
          { issues: parsed.error.issues },
        );
      }

      // Verify the target token to recover its jti/exp (a revoked or expired
      // token throws -32001 here, which is the correct observable behaviour).
      const verified = await options.tokens.verify(parsed.data.targetToken);
      const jti = verified.tokenId;
      const expiresAt = verified.expiresAt;
      if (jti === undefined || expiresAt === undefined) {
        throw new ProtocolError(
          JsonRpcErrorCode.InvalidParams,
          'token has no jti/exp to revoke',
        );
      }

      options.revocations.revoke(jti, expiresAt);
      // Log jti + agentId (jti is a random opaque id, safe to log); never the token.
      options.logger?.info?.({
        agentId: verified.agentId,
        jti,
        expiresAt,
        msg: 'token.revoked',
      });
      return { revoked: true, jti, expiresAt };
    },
    { description: 'Revoke an issued token by jti (admin-only, US-021D)' },
  );
}
