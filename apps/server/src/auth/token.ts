/**
 * JWT issue / verify for agent identities.
 *
 * Tokens are HS256-signed with `config.jwtSecret` and carry the minimum an
 * authorisation decision needs:
 *
 * ```json
 * { "sub": "agt_…", "role": "agent", "workspaceId": "default",
 *   "iss": "agentmesh", "aud": "agentmesh", "iat": 1763…, "exp": 1763…,
 *   "jti": "…" }
 * ```
 *
 * `sub` is the agent id (the JWT-standard "who"), `role` is the AgentMesh
 * authorisation claim and `workspaceId` is the tenant the identity belongs to.
 * The dispatcher binds the request workspace to that claim — a client header
 * can never widen it. Tokens minted before the claim existed verify with the
 * `default` workspace, which is exactly what they were issued for.
 *
 * Verification failures are surfaced as `ProtocolError(-32001)` so transports
 * and handlers get one uniform code.
 */

import { randomUUID } from 'node:crypto';

import { JsonRpcErrorCode, ProtocolError } from '@agentmesh/protocol';
import { jwtVerify, SignJWT } from 'jose';
import { errors as joseErrors } from 'jose';

import { isRole, type Role } from './roles.js';

/** Only one algorithm is accepted; nothing else can be negotiated in. */
export const TOKEN_ALGORITHM = 'HS256';
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;
export const DEFAULT_TOKEN_ISSUER = 'agentmesh';
const DEFAULT_TOKEN_AUDIENCE = 'agentmesh';
/** Tolerate small clock skew between token issuer and checker. */
const CLOCK_TOLERANCE_SECONDS = 5;

/** Workspace assumed for tokens that predate the `workspaceId` claim. */
export const DEFAULT_TOKEN_WORKSPACE = 'default';

/** Claims written by the server and consumed by authorisation helpers. */
export interface TokenClaims {
  /** Account id (`accounts.id`). */
  readonly agentId: string;
  readonly role: Role;
  /**
   * Tenant of the identity. Optional on the sign side (defaults to
   * `default`); always present after verification.
   */
  readonly workspaceId?: string;
}

/** Claims recovered from a verified token. */
export interface VerifiedToken extends TokenClaims {
  /** Tenant fixed at issue time; never derived from request headers. */
  readonly workspaceId: string;
  /** Issued-at, epoch seconds. */
  readonly issuedAt?: number;
  /** Expiry, epoch seconds. */
  readonly expiresAt?: number;
  /** Unique token id (`jti`). */
  readonly tokenId?: string;
}

export interface TokenServiceOptions {
  /** HMAC secret (`config.jwtSecret`); validated by `loadConfig` already. */
  readonly secret: string;
  /** Lifetime of newly minted tokens. Default 1 hour. */
  readonly expiresInSeconds?: number;
  /** `iss` claim. Default `agentmesh`. */
  readonly issuer?: string;
  /** `aud` claim. Default `agentmesh`. */
  readonly audience?: string;
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly clock?: () => number;
}

/** Thrown as `-32001`; `data.reason` tells clients whether to re-authenticate. */
function unauthorized(reason: 'invalid_token' | 'token_expired', message: string): ProtocolError {
  return new ProtocolError(JsonRpcErrorCode.Unauthorized, message, { reason });
}

function nowSeconds(clock: () => number): number {
  return Math.floor(clock() / 1000);
}

/**
 * Stateless issuer/verifier. Cheap to construct; one instance per server.
 */
export class TokenService {
  readonly #key: Uint8Array;
  readonly #expiresInSeconds: number;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #clock: () => number;

  constructor(options: TokenServiceOptions) {
    if (typeof options.secret !== 'string' || options.secret.length === 0) {
      throw new TypeError('TokenService requires a non-empty secret');
    }
    const ttl = options.expiresInSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) {
      throw new TypeError(`TokenService expiresInSeconds must be positive, got ${ttl}`);
    }
    this.#key = new TextEncoder().encode(options.secret);
    this.#expiresInSeconds = ttl;
    this.#issuer = options.issuer ?? DEFAULT_TOKEN_ISSUER;
    this.#audience = options.audience ?? DEFAULT_TOKEN_AUDIENCE;
    this.#clock = options.clock ?? (() => Date.now());
  }

  get expiresInSeconds(): number {
    return this.#expiresInSeconds;
  }

  get issuer(): string {
    return this.#issuer;
  }

  /** Epoch seconds a token minted now will expire at. */
  expirationFor(issuedAtSeconds: number = nowSeconds(this.#clock)): number {
    return issuedAtSeconds + this.#expiresInSeconds;
  }

  /**
   * Mint a compact JWS for `claims`.
   *
   * `expiresInSeconds` overrides the configured TTL (clamped by config
   * validation upstream); `tokenId` makes the `jti` deterministic in tests.
   */
  async sign(
    claims: TokenClaims,
    options: { expiresInSeconds?: number; tokenId?: string } = {},
  ): Promise<string> {
    if (typeof claims.agentId !== 'string' || claims.agentId.length === 0) {
      throw new TypeError('token claims require a non-empty agentId');
    }
    if (!isRole(claims.role)) {
      throw new TypeError(`token claims require a valid role, got "${String(claims.role)}"`);
    }

    const ttl = options.expiresInSeconds ?? this.#expiresInSeconds;
    const issuedAt = nowSeconds(this.#clock);
    const workspaceId =
      typeof claims.workspaceId === 'string' && claims.workspaceId.length > 0
        ? claims.workspaceId
        : DEFAULT_TOKEN_WORKSPACE;

    return new SignJWT({ role: claims.role, workspaceId })
      .setProtectedHeader({ alg: TOKEN_ALGORITHM, typ: 'JWT' })
      .setSubject(claims.agentId)
      .setIssuer(this.#issuer)
      .setAudience(this.#audience)
      .setIssuedAt(issuedAt)
      .setJti(options.tokenId ?? randomUUID())
      .setExpirationTime(issuedAt + ttl)
      .sign(this.#key);
  }

  /**
   * Verify signature, issuer, audience and expiry, then normalise the claims.
   * @throws {ProtocolError} `-32001` for any unverifiable token.
   */
  async verify(token: string): Promise<VerifiedToken> {
    if (typeof token !== 'string' || token.length === 0) {
      throw unauthorized('invalid_token', 'Invalid or expired token');
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(token, this.#key, {
        algorithms: [TOKEN_ALGORITHM],
        issuer: this.#issuer,
        audience: this.#audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        // Honour the injected clock so expiry is deterministic in tests and a
        // host with a skewed clock still behaves predictably in production.
        currentDate: new Date(this.#clock()),
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw unauthorized('token_expired', 'Token expired');
      }
      throw unauthorized('invalid_token', 'Invalid or expired token');
    }

    const agentId = payload.sub;
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw unauthorized('invalid_token', 'Token is missing its subject');
    }
    if (!isRole(payload.role)) {
      throw unauthorized('invalid_token', 'Token carries an unknown role');
    }

    const workspaceId =
      typeof payload.workspaceId === 'string' && payload.workspaceId.length > 0
        ? payload.workspaceId
        : DEFAULT_TOKEN_WORKSPACE;

    return {
      agentId,
      role: payload.role,
      workspaceId,
      ...(typeof payload.iat === 'number' ? { issuedAt: payload.iat } : {}),
      ...(typeof payload.exp === 'number' ? { expiresAt: payload.exp } : {}),
      ...(typeof payload.jti === 'string' ? { tokenId: payload.jti } : {}),
    };
  }
}

/** Convenience factory mirroring the other module `create*` helpers. */
export function createTokenService(options: TokenServiceOptions): TokenService {
  return new TokenService(options);
}

// ---------------------------------------------------------------------------
// Token extraction (transports hand over whatever they found)
// ---------------------------------------------------------------------------

/**
 * Parse `Authorization: Bearer <token>` (case-insensitive scheme).
 * Returns `undefined` for missing/other schemes rather than throwing, so the
 * handler can decide whether authentication is required.
 */
export function extractBearerToken(
  header: string | string[] | undefined | null,
): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(raw);
  return match?.[1];
}

/**
 * Read `params.token` from a decoded JSON-RPC params object. WebSocket
 * clients (US-006) may authenticate per-message this way; HTTP prefers the
 * `Authorization` header.
 */
export function readTokenFromParams(params: unknown): string | undefined {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const token = (params as Record<string, unknown>).token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}
