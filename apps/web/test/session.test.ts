import { describe, expect, it } from 'vitest';

import {
  clearSession,
  decodeTokenClaims,
  loadSession,
  saveSession,
  SESSION_STORAGE_KEY,
  type SessionStorage,
} from '../src/lib/session.js';

function makeStorage(): { storage: SessionStorage; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    storage: {
      getItem: (key: string) => raw.get(key) ?? null,
      setItem: (key: string, value: string) => {
        raw.set(key, value);
      },
      removeItem: (key: string) => {
        raw.delete(key);
      },
    },
  };
}

function jwt(subject: string, role: string, exp?: number): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: subject,
    role,
    ...(exp === undefined ? {} : { exp }),
  })}.signature`;
}

describe('decodeTokenClaims', () => {
  it('reads sub/role/exp from the payload', () => {
    expect(decodeTokenClaims(jwt('agt_1', 'admin', 123))).toEqual({
      agentId: 'agt_1',
      role: 'admin',
      exp: 123,
    });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeTokenClaims('not-a-jwt')).toBeNull();
    expect(decodeTokenClaims('a.b.c')).toBeNull();
    expect(decodeTokenClaims(jwt('', 'admin'))).toBeNull();
  });
});

describe('session persistence', () => {
  it('round-trips a session through storage', () => {
    const { storage } = makeStorage();
    const token = jwt('agt_1', 'admin', Math.floor(Date.now() / 1000) + 3600);
    saveSession({ token, agentId: 'agt_1', role: 'admin' }, storage);
    expect(loadSession(storage)).toEqual({ token, agentId: 'agt_1', role: 'admin' });
  });

  it('returns null when nothing is stored', () => {
    const { storage } = makeStorage();
    expect(loadSession(storage)).toBeNull();
  });

  it('discards and clears an expired token', () => {
    const { storage, raw } = makeStorage();
    const token = jwt('agt_1', 'admin', Math.floor(Date.now() / 1000) - 10);
    saveSession({ token, agentId: 'agt_1', role: 'admin' }, storage);
    expect(loadSession(storage)).toBeNull();
    expect(raw.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it('discards and clears a session whose identity mismatches the token', () => {
    const { storage, raw } = makeStorage();
    const token = jwt('agt_1', 'admin', Math.floor(Date.now() / 1000) + 3600);
    saveSession({ token, agentId: 'agt_2', role: 'admin' }, storage);
    expect(loadSession(storage)).toBeNull();
    expect(raw.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it('discards and clears corrupt stored JSON', () => {
    const { storage, raw } = makeStorage();
    storage.setItem(SESSION_STORAGE_KEY, '{not json');
    expect(loadSession(storage)).toBeNull();
    expect(raw.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it('clearSession removes the entry', () => {
    const { storage, raw } = makeStorage();
    const token = jwt('agt_1', 'admin', Math.floor(Date.now() / 1000) + 3600);
    saveSession({ token, agentId: 'agt_1', role: 'admin' }, storage);
    clearSession(storage);
    expect(raw.has(SESSION_STORAGE_KEY)).toBe(false);
    expect(loadSession(storage)).toBeNull();
  });
});
