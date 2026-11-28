/**
 * Persisted admin login session for the web console.
 *
 * The login page stores the JWT the server issued (`agent.authenticate`
 * returns it) in `localStorage` together with the identity it was issued
 * to; `SdkProvider` restores it on mount so a refresh no longer drops the
 * login. Only the short-lived JWT is stored — never the agent secret.
 *
 * Security note: like any SPA token storage, this is readable by page JS.
 * The console ships no third-party scripts, and the token is short-lived
 * and revocable (revocation also closes the live session, so a stored
 * revoked token fails fast on restore and is discarded).
 */

export interface StoredSession {
  readonly token: string;
  readonly agentId: string;
  readonly role: string;
}

export interface TokenClaims {
  readonly agentId: string;
  readonly role: string;
  readonly exp?: number;
}

export const SESSION_STORAGE_KEY = 'agentmesh.session.v1';

/** Minimal storage surface (localStorage in the browser, a fake in tests). */
export type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): SessionStorage | undefined {
  if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  return undefined;
}

/** Decode a JWT payload without verifying it (verification happens server-side). */
export function decodeTokenClaims(token: string): TokenClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[1] === undefined) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = atob(padded);
    const payload = JSON.parse(json) as Record<string, unknown>;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    if (typeof payload.role !== 'string' || payload.role.length === 0) return null;
    return {
      agentId: payload.sub,
      role: payload.role,
      ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Load the stored session, or `null` when there is none. A corrupt entry,
 * an identity mismatch against the token claims, or an expired token is
 * discarded (and cleared) instead of returned.
 */
export function loadSession(storage: SessionStorage | undefined = defaultStorage()): StoredSession | null {
  if (storage === undefined) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    clearSession(storage);
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as StoredSession).token !== 'string' ||
    typeof (parsed as StoredSession).agentId !== 'string' ||
    typeof (parsed as StoredSession).role !== 'string'
  ) {
    clearSession(storage);
    return null;
  }
  const session = parsed as StoredSession;
  const claims = decodeTokenClaims(session.token);
  if (claims === null || claims.agentId !== session.agentId || claims.role !== session.role) {
    clearSession(storage);
    return null;
  }
  if (claims.exp !== undefined && claims.exp * 1000 <= Date.now()) {
    clearSession(storage);
    return null;
  }
  return session;
}

export function saveSession(
  session: StoredSession,
  storage: SessionStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage full/blocked (private mode): login still works for this visit.
  }
}

export function clearSession(storage: SessionStorage | undefined = defaultStorage()): void {
  if (storage === undefined) return;
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Already gone / unavailable: nothing to do.
  }
}

/** True when the error is an auth failure (-32001 invalid/revoked token). */
export function isAuthError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === -32001
  );
}
