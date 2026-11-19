import { JsonRpcErrorCode, ProtocolError } from '@agentmesh/protocol';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_LIST_ROLES,
  ADMIN_ROLES,
  hasRole,
  isAuthenticated,
  requireAuth,
  requireRole,
} from '../src/auth/roles.js';
import {
  createTokenService,
  DEFAULT_TOKEN_TTL_SECONDS,
  extractBearerToken,
  readTokenFromParams,
  TokenService,
} from '../src/auth/token.js';
import {
  DEFAULT_ALLOW_ADMIN_SELF_REGISTER,
  DEFAULT_JWT_EXPIRES_IN_SECONDS,
  DEFAULT_JWT_ISSUER,
  ConfigError,
  describeConfig,
  loadConfig,
} from '../src/config.js';

const SECRET = 'test-secret-value-1234567890';

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to throw');
}

describe('TokenService', () => {
  it('signs a JWT whose claims round-trip (agentId, role, exp)', async () => {
    const clock = (): number => 1_700_000_000_000;
    const tokens = createTokenService({
      secret: SECRET,
      expiresInSeconds: 120,
      clock,
    });

    const token = await tokens.sign({ agentId: 'agt_1', role: 'agent' });
    expect(token.split('.')).toHaveLength(3);

    const verified = await tokens.verify(token);
    expect(verified.agentId).toBe('agt_1');
    expect(verified.role).toBe('agent');
    expect(verified.issuedAt).toBe(1_700_000_000);
    expect(verified.expiresAt).toBe(1_700_000_120);
    expect(verified.tokenId).toEqual(expect.any(String));
    expect(tokens.expirationFor(1_700_000_000)).toBe(1_700_000_120);
  });

  it('defaults to a 1h lifetime', () => {
    const tokens = new TokenService({ secret: SECRET });
    expect(tokens.expiresInSeconds).toBe(DEFAULT_TOKEN_TTL_SECONDS);
    expect(DEFAULT_TOKEN_TTL_SECONDS).toBe(3600);
    expect(tokens.issuer).toBe(DEFAULT_JWT_ISSUER);
  });

  it('rejects an expired token with -32001 + reason token_expired', async () => {
    const tokens = createTokenService({ secret: SECRET });
    const expired = await tokens.sign(
      { agentId: 'agt_1', role: 'agent' },
      { expiresInSeconds: -60 },
    );

    await expect(tokens.verify(expired)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'token_expired' },
    });
  });

  it('rejects a tampered signature with -32001', async () => {
    const tokens = createTokenService({ secret: SECRET });
    const token = await tokens.sign({ agentId: 'agt_1', role: 'agent' });
    const parts = token.split('.') as [string, string, string];
    // Flip a byte in the payload segment, keep the original signature.
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const forged = Buffer.from(payload.replace('"agent"', '"admin"'), 'utf8').toString(
      'base64url',
    );

    await expect(
      tokens.verify(`${parts[0]}.${forged}.${parts[2]}`),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'invalid_token' },
    });
  });

  it('rejects tokens signed with another secret', async () => {
    const signer = createTokenService({ secret: 'another-secret-0123456789' });
    const verifier = createTokenService({ secret: SECRET });
    const token = await signer.sign({ agentId: 'agt_1', role: 'admin' });

    await expect(verifier.verify(token)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
    });
  });

  it('rejects a token whose header declares alg:none', async () => {
    const tokens = createTokenService({ secret: SECRET });
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
    const header = encode({ alg: 'none', typ: 'JWT' });
    const payload = encode({
      sub: 'agt_1',
      role: 'admin',
      iss: DEFAULT_JWT_ISSUER,
      aud: DEFAULT_JWT_ISSUER,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(tokens.verify(`${header}.${payload}.`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'invalid_token' },
    });
  });

  it('rejects a token whose header declares RS256 (algorithm confusion)', async () => {
    const tokens = createTokenService({ secret: SECRET });
    const token = await tokens.sign({ agentId: 'agt_1', role: 'agent' });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forgedHeader = Buffer.from(
      JSON.stringify({ ...decoded, alg: 'RS256' }),
      'utf8',
    ).toString('base64url');

    await expect(tokens.verify(`${forgedHeader}.${payload}.${signature}`)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
    });
  });

  it('rejects a token with the wrong issuer or audience', async () => {
    const verifier = createTokenService({ secret: SECRET });
    const wrongIssuer = createTokenService({ secret: SECRET, issuer: 'evil' });
    const wrongAudience = createTokenService({ secret: SECRET, audience: 'evil' });

    const issuerToken = await wrongIssuer.sign({ agentId: 'agt_1', role: 'agent' });
    const audienceToken = await wrongAudience.sign({ agentId: 'agt_1', role: 'agent' });

    await expect(verifier.verify(issuerToken)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'invalid_token' },
    });
    await expect(verifier.verify(audienceToken)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'invalid_token' },
    });
  });

  it('accepts a token just before expiry and rejects it beyond the skew tolerance', async () => {
    let now = 1_700_000_000_000;
    const tokens = createTokenService({ secret: SECRET, clock: () => now });
    const token = await tokens.sign({ agentId: 'agt_1', role: 'agent' }, { expiresInSeconds: 10 });

    now += 9_000;
    await expect(tokens.verify(token)).resolves.toMatchObject({ agentId: 'agt_1' });

    // Clock tolerance is 5s; move past exp + tolerance.
    now += 7_000;
    await expect(tokens.verify(token)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      data: { reason: 'token_expired' },
    });
  });

  it('never puts credentials or sensitive profile data in the JWT payload', async () => {
    const tokens = createTokenService({ secret: SECRET });
    const token = await tokens.sign({ agentId: 'agt_1', role: 'admin', workspaceId: 'default' });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    const allowed = new Set(['sub', 'role', 'workspaceId', 'iss', 'aud', 'iat', 'exp', 'jti']);
    for (const key of Object.keys(payload)) {
      expect(allowed.has(key), `unexpected JWT claim ${key}`).toBe(true);
    }
    for (const forbidden of ['secret', 'secretHash', 'secret_hash', 'password', 'owner', 'email']) {
      expect(payload).not.toHaveProperty(forbidden);
    }
  });

  it('rejects a correctly signed token carrying an unknown role', async () => {
    const tokens = createTokenService({ secret: SECRET });
    const forged = await new SignJWT({ role: 'root' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('agt_1')
      .setIssuer(DEFAULT_JWT_ISSUER)
      .setAudience(DEFAULT_JWT_ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET));

    await expect(tokens.verify(forged)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
      message: /unknown role/i,
    });
  });

  it('rejects garbage input and obviously invalid claim shapes at signing time', async () => {
    const tokens = createTokenService({ secret: SECRET });
    await expect(tokens.verify('not-a-jwt')).rejects.toBeInstanceOf(ProtocolError);
    await expect(tokens.verify('')).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      tokens.sign({ agentId: '', role: 'agent' }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      // Deliberately invalid role to prove the guard exists.
      tokens.sign({ agentId: 'agt_1', role: 'root' as unknown as 'agent' }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(() => new TokenService({ secret: '' })).toThrow(TypeError);
  });
});

describe('token extraction helpers', () => {
  it('parses Bearer headers case-insensitively and ignores other schemes', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('  bearer   abc  ')).toBe('abc');
    expect(extractBearerToken(['Bearer abc'])).toBe('abc');
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('reads params.token when present', () => {
    expect(readTokenFromParams({ token: 'abc' })).toBe('abc');
    expect(readTokenFromParams({ token: '' })).toBeUndefined();
    expect(readTokenFromParams({ token: 42 })).toBeUndefined();
    expect(readTokenFromParams(['abc'])).toBeUndefined();
    expect(readTokenFromParams(null)).toBeUndefined();
  });
});

describe('role helpers', () => {
  it('returns the verified identity from ctx.auth', () => {
    const ctx = { auth: { agentId: 'agt_1', role: 'admin' as const } };
    expect(isAuthenticated(ctx)).toBe(true);
    expect(requireAuth(ctx)).toEqual({ agentId: 'agt_1', role: 'admin' });
    expect(hasRole(ctx, ADMIN_ROLES)).toBe(true);
  });

  it('falls back to a legacy agentId + role pair', () => {
    expect(requireAuth({ agentId: 'agt_2', role: 'agent' })).toEqual({
      agentId: 'agt_2',
      role: 'agent',
    });
  });

  it('throws -32001 when unauthenticated', () => {
    const err = codeOf(() => requireAuth({})) as ProtocolError;
    expect(err).toBeInstanceOf(ProtocolError);
    expect(err.code).toBe(JsonRpcErrorCode.Unauthorized);
    // requireRole delegates to requireAuth: no identity is -32001, never -32002.
    expect(codeOf(() => requireRole({}, ACCOUNT_LIST_ROLES))).toMatchObject({
      code: JsonRpcErrorCode.Unauthorized,
    });
  });

  it('throws -32002 when the role is not allowed', () => {
    let thrown: unknown;
    try {
      requireRole({ auth: { agentId: 'agt_3', role: 'observer' } }, ADMIN_ROLES);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProtocolError);
    const err = thrown as ProtocolError;
    expect(err.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(err.data).toEqual({ role: 'observer', required: ['admin'] });
    expect(hasRole({ auth: { agentId: 'agt_3', role: 'observer' } }, ADMIN_ROLES)).toBe(
      false,
    );
  });
});

describe('auth config', () => {
  it('defaults to a 1h TTL, the agentmesh issuer and no admin self-registration', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config.jwtExpiresInSeconds).toBe(DEFAULT_JWT_EXPIRES_IN_SECONDS);
    expect(config.jwtIssuer).toBe(DEFAULT_JWT_ISSUER);
    expect(config.allowAdminSelfRegister).toBe(DEFAULT_ALLOW_ADMIN_SELF_REGISTER);
    expect(config.allowAdminSelfRegister).toBe(false);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      JWT_EXPIRES_IN_SECONDS: '60',
      JWT_ISSUER: 'agentmesh-test',
      ALLOW_ADMIN_SELF_REGISTER: 'true',
    });
    expect(config.jwtExpiresInSeconds).toBe(60);
    expect(config.jwtIssuer).toBe('agentmesh-test');
    expect(config.allowAdminSelfRegister).toBe(true);
  });

  it('rejects invalid TTL / boolean values', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_EXPIRES_IN_SECONDS: '1h' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ NODE_ENV: 'test', JWT_EXPIRES_IN_SECONDS: '0' })).toThrow(
      /between 1 and/,
    );
    expect(() =>
      loadConfig({ NODE_ENV: 'test', ALLOW_ADMIN_SELF_REGISTER: 'maybe' }),
    ).toThrow(/ALLOW_ADMIN_SELF_REGISTER must be a boolean/);
  });

  it('describeConfig exposes the TTL but never the secret', () => {
    const described = describeConfig(loadConfig({ NODE_ENV: 'test' }));
    expect(described.jwtExpiresInSeconds).toBe(DEFAULT_JWT_EXPIRES_IN_SECONDS);
    expect(described).not.toHaveProperty('jwtSecret');
    expect(JSON.stringify(described)).not.toContain('secret');
  });
});
