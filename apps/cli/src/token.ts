/**
 * Local (unverified) JWT inspection for `whoami` / `doctor`.
 *
 * The CLI never validates tokens itself — the server does that on every
 * request. Decoding is only used to show the caller who it is and when the
 * stored token expires.
 */

export interface TokenClaims {
  readonly sub?: string;
  readonly role?: string;
  readonly workspaceId?: string;
  /** Epoch seconds. */
  readonly exp?: number;
  /** Epoch seconds. */
  readonly iat?: number;
}

function decodeBase64Url(segment: string): string | undefined {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    // `Buffer` exists in Node ≥22; the CLI is Node-only.
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

export function decodeTokenClaims(token: string): TokenClaims | undefined {
  const parts = token.split('.');
  const payload = parts[1];
  if (payload === undefined) return undefined;
  const text = decodeBase64Url(payload);
  if (text === undefined || text.length === 0) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const value = parsed as Record<string, unknown>;
    const claims: {
      sub?: string;
      role?: string;
      workspaceId?: string;
      exp?: number;
      iat?: number;
    } = {};
    if (typeof value.sub === 'string') claims.sub = value.sub;
    if (typeof value.role === 'string') claims.role = value.role;
    if (typeof value.workspaceId === 'string') claims.workspaceId = value.workspaceId;
    if (typeof value.exp === 'number') claims.exp = value.exp;
    if (typeof value.iat === 'number') claims.iat = value.iat;
    return claims;
  } catch {
    return undefined;
  }
}

export function isTokenExpired(claims: TokenClaims, nowMs = Date.now()): boolean {
  if (claims.exp === undefined) return false;
  return claims.exp * 1000 <= nowMs;
}

export function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
