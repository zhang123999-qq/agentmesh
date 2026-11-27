import type { AgentMeshDatabase } from '../db.js';
import { DEFAULT_WORKSPACE_ID } from '../types.js';

/**
 * Persistent token revocations (US-021D follow-up, v11).
 *
 * One row per revoked `jti`, kept until `expires_at` (epoch seconds). The
 * in-memory LRU caches the hot set; this table is the source of truth across
 * restarts. `workspace_id` is recorded so cross-tenant revoke checks stay
 * consistent with US-023.
 */
export interface RevokedToken {
  jti: string;
  expiresAt: number;
  revokedAt: number;
  workspaceId: string;
}

export interface InsertRevokedTokenInput {
  jti: string;
  expiresAt: number;
  revokedAt?: number;
  workspaceId?: string;
}

export class RevokedTokensDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  insert(input: InsertRevokedTokenInput): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO revoked_tokens (jti, expires_at, revoked_at, workspace_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        input.jti,
        input.expiresAt,
        input.revokedAt ?? Math.floor(Date.now() / 1000),
        input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      );
  }

  /** True when the `jti` is revoked and has not yet expired. */
  isRevoked(jti: string, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM revoked_tokens WHERE jti = ? AND expires_at > ?')
      .get(jti, nowSeconds);
    return row !== undefined;
  }

  /** Remove rows whose expiry has passed; returns how many were deleted. */
  deleteExpired(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
    return this.db
      .prepare('DELETE FROM revoked_tokens WHERE expires_at <= ?')
      .run(nowSeconds).changes;
  }

  /** Count of still-active revocations (for the `/metrics` gauge). */
  countActive(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM revoked_tokens WHERE expires_at > ?')
      .get(nowSeconds) as { count: number };
    return row.count;
  }

  /** Load unexpired revocations for the startup warm-up of the LRU. */
  loadUnexpired(
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Array<{ jti: string; expiresAt: number }> {
    const rows = this.db
      .prepare('SELECT jti, expires_at FROM revoked_tokens WHERE expires_at > ?')
      .all(nowSeconds) as Array<{ jti: string; expires_at: number }>;
    return rows.map((row) => ({ jti: row.jti, expiresAt: row.expires_at }));
  }
}
