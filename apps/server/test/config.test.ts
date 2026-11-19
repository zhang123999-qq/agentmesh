import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  DEFAULT_DB_PATH,
  DEFAULT_TASK_OPEN_TTL_SECONDS,
  DEFAULT_TASK_RECLAIM_INTERVAL_SECONDS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEV_JWT_SECRET,
  MIN_JWT_SECRET_LENGTH,
  PRODUCTION_MIN_JWT_SECRET_BYTES,
  SERVER_VERSION,
  describeConfig,
  describeSecurityWarnings,
  loadConfig,
} from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults in development', () => {
    const config = loadConfig({ NODE_ENV: 'development' });

    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.dbPath).toBe(DEFAULT_DB_PATH);
    expect(config.jwtSecret).toBe(DEV_JWT_SECRET);
    expect(config.logLevel).toBe('info');
    expect(config.version).toBe(SERVER_VERSION);
    expect(config.isProduction).toBe(false);
  });

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '9001',
      HOST: '127.0.0.1',
      DB_PATH: '/data/agentmesh.db',
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
      LOG_LEVEL: 'debug',
      SERVER_VERSION: '9.9.9',
    });

    expect(config).toMatchObject({
      port: 9001,
      host: '127.0.0.1',
      dbPath: '/data/agentmesh.db',
      logLevel: 'debug',
      version: '9.9.9',
      isProduction: true,
    });
  });

  it('accepts port 0 for ephemeral test ports', () => {
    expect(loadConfig({ NODE_ENV: 'test', PORT: '0' }).port).toBe(0);
  });

  it('rejects a non-numeric or out-of-range PORT', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'http' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: '70000' })).toThrow(
      /between 0 and 65535/,
    );
  });

  it('rejects an empty DB_PATH', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DB_PATH: '  ' })).toThrow(ConfigError);
  });

  it('requires JWT_SECRET in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET is required/);
  });

  it('rejects a too-short JWT_SECRET', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'short' }),
    ).toThrow(new RegExp(String(MIN_JWT_SECRET_LENGTH)));
  });

  it('requires 32 bytes of HMAC key in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'sixteen-chars-ok?',
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: '0123456789abcdef0123456789abcdef',
      }),
    ).not.toThrow();
  });

  it('rejects weak and zero-entropy JWT_SECRET values everywhere', () => {
    for (const weak of ['secret', 'changeme', 'test', 'password']) {
      expect(() => loadConfig({ NODE_ENV: 'test', JWT_SECRET: weak })).toThrow(/weak/);
    }
    expect(() =>
      loadConfig({ NODE_ENV: 'test', JWT_SECRET: 'a'.repeat(PRODUCTION_MIN_JWT_SECRET_BYTES) }),
    ).toThrow(/weak/);
  });

  it('reports development and production security warnings without failing', () => {
    const dev = loadConfig({
      NODE_ENV: 'development',
      JWT_SECRET: 'test-secret-value-1234567890',
    });
    expect(
      describeSecurityWarnings(dev).some((warning) => warning.includes('shorter than 32 bytes')),
    ).toBe(true);

    const prod = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
      ALLOW_ADMIN_SELF_REGISTER: 'true',
    });
    const warnings = describeSecurityWarnings(prod).join('\n');
    expect(warnings).toContain('ALLOWED_ORIGINS is empty');
    expect(warnings).toContain('ALLOW_ADMIN_SELF_REGISTER');
  });

  it('parses exact ALLOWED_ORIGINS and rejects wildcards or paths', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: '0123456789abcdef0123456789abcdef',
      ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:3000',
      ALLOW_MISSING_ORIGIN: 'false',
    });
    expect(config.allowedOrigins).toEqual([
      'https://app.example.com',
      'http://localhost:3000',
    ]);
    expect(config.allowMissingOrigin).toBe(false);

    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        JWT_SECRET: 'test-secret-value-1234567890',
        ALLOWED_ORIGINS: '*',
      }),
    ).toThrow(/must not use/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        JWT_SECRET: 'test-secret-value-1234567890',
        ALLOWED_ORIGINS: 'https://app.example.com/path',
      }),
    ).toThrow(/without a path/);
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'verbose' })).toThrow(
      /LOG_LEVEL must be one of/,
    );
  });

  it('describeConfig never exposes the JWT secret', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      JWT_SECRET: 'super-secret-value-1234',
    });
    const described = describeConfig(config);

    expect(described).not.toHaveProperty('jwtSecret');
    expect(JSON.stringify(described)).not.toContain('super-secret-value-1234');
  });

  it('returns a frozen config', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('defaults the authenticate throttle to 5 failures / 60s window / 60s lockout', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config).toMatchObject({
      authMaxFailedAttempts: 5,
      authFailWindowSeconds: 60,
      authLockoutSeconds: 60,
    });
    expect(describeConfig(config)).toMatchObject({
      authMaxFailedAttempts: 5,
      authFailWindowSeconds: 60,
      authLockoutSeconds: 60,
    });
  });

  it('reads AUTH_* throttle overrides and rejects invalid values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MAX_FAILED_ATTEMPTS: '3',
      AUTH_FAIL_WINDOW_SECONDS: '30',
      AUTH_LOCKOUT_SECONDS: '120',
    });
    expect(config).toMatchObject({
      authMaxFailedAttempts: 3,
      authFailWindowSeconds: 30,
      authLockoutSeconds: 120,
    });

    for (const [key, value] of [
      ['AUTH_MAX_FAILED_ATTEMPTS', 'many'],
      ['AUTH_MAX_FAILED_ATTEMPTS', '0'],
      ['AUTH_MAX_FAILED_ATTEMPTS', '101'],
      ['AUTH_FAIL_WINDOW_SECONDS', '0'],
      ['AUTH_LOCKOUT_SECONDS', '-5'],
    ] as const) {
      expect(() => loadConfig({ NODE_ENV: 'test', [key]: value })).toThrow(ConfigError);
    }
  });

  it('defaults the task reclaim knobs to "decide by deadline only" + 60s sweep', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    expect(config).toMatchObject({
      taskOpenTtlSeconds: DEFAULT_TASK_OPEN_TTL_SECONDS,
      taskReclaimIntervalSeconds: DEFAULT_TASK_RECLAIM_INTERVAL_SECONDS,
    });
    expect(config.taskOpenTtlSeconds).toBe(0);
    expect(describeConfig(config)).toMatchObject({
      taskOpenTtlSeconds: 0,
      taskReclaimIntervalSeconds: 60,
    });
  });

  it('reads TASK_* reclaim overrides and rejects invalid values', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      TASK_OPEN_TTL_SECONDS: '900',
      TASK_RECLAIM_INTERVAL_SECONDS: '5',
    });
    expect(config).toMatchObject({
      taskOpenTtlSeconds: 900,
      taskReclaimIntervalSeconds: 5,
    });

    for (const [key, value] of [
      ['TASK_OPEN_TTL_SECONDS', '-1'],
      ['TASK_OPEN_TTL_SECONDS', 'soon'],
      ['TASK_OPEN_TTL_SECONDS', '2592001'],
      ['TASK_RECLAIM_INTERVAL_SECONDS', '0'],
    ] as const) {
      expect(() => loadConfig({ NODE_ENV: 'test', [key]: value })).toThrow(ConfigError);
    }
  });
});
