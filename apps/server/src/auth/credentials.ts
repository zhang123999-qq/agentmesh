/**
 * Account credential primitives (US-005 security fix).
 *
 * `agent.register` mints a random secret and hands the plaintext back exactly
 * once. Only `sha256(secret)` is persisted (`accounts.secret_hash`), so a
 * database dump cannot be replayed against `agent.authenticate`, and the
 * server can never echo a credential it no longer holds.
 *
 * The digest is compared with `timingSafeEqual` to keep verification free of
 * byte-position timing leaks. A SHA-256 digest is sufficient here (unlike
 * password hashing): the secret is 256 bits of CSPRNG output, not a
 * human-chosen password, so brute-force/key-stretching concerns do not apply.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Entropy of a freshly issued secret, in bytes (base64url → 43 chars). */
export const SECRET_BYTE_LENGTH = 32;

/** Upper bound accepted from clients; anything larger is rejected as params. */
export const MAX_SECRET_LENGTH = 512;

const SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Generate a new account secret (base64url, 32 random bytes). */
export function generateAccountSecret(): string {
  return randomBytes(SECRET_BYTE_LENGTH).toString('base64url');
}

/** Digest stored in `accounts.secret_hash`. */
export function hashAccountSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of `secret` against a stored digest. Missing or
 * malformed digests (legacy rows) never match.
 */
export function secretHashMatches(
  secret: string,
  storedHash: string | null | undefined,
): boolean {
  if (typeof storedHash !== 'string' || !SECRET_HASH_PATTERN.test(storedHash)) {
    return false;
  }
  const candidate = Buffer.from(hashAccountSecret(secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
