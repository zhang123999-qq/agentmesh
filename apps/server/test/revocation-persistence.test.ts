import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MIGRATIONS,
  openDatabase,
  openStore,
  runMigrations,
  type RevokedTokensDao,
} from '@agentmesh/store';
import {
  createLogger,
  createTokenService,
  loadConfig,
  startServer,
  TokenRevocationRegistry,
} from '@agentmesh/server';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareMigrationBackup } from '../src/cli/migration-backup.js';

const SECRET = 'x'.repeat(32);

describe('persistent token revocation (v11)', () => {
  it('revoked token is rejected via the DB path', async () => {
    const store = openStore(':memory:');
    try {
      const reg = new TokenRevocationRegistry({ store: store.repos.revokedTokens });
      const tokens = createTokenService({ secret: SECRET, revocations: reg });
      const token = await tokens.sign({ agentId: 'agt_1', role: 'agent' }, { tokenId: 'j1' });
      const exp = (await tokens.verify(token)).expiresAt ?? 0;
      reg.revoke('j1', exp, 'default');
      expect(store.repos.revokedTokens.isRevoked('j1')).toBe(true);
      await expect(tokens.verify(token)).rejects.toMatchObject({ code: -32001 });
    } finally {
      store.db.close();
    }
  });

  it('a revoked token stays revoked after a restart (persistence)', async () => {
    const store = openStore(':memory:');
    try {
      const reg1 = new TokenRevocationRegistry({ store: store.repos.revokedTokens });
      const tokens1 = createTokenService({ secret: SECRET, revocations: reg1 });
      const token = await tokens1.sign(
        { agentId: 'agt_1', role: 'agent' },
        { tokenId: 'j-restart' },
      );
      const exp = (await tokens1.verify(token)).expiresAt ?? 0;
      reg1.revoke('j-restart', exp, 'default');
      await expect(tokens1.verify(token)).rejects.toMatchObject({ code: -32001 });

      // "Restart": a brand-new registry + token service over the SAME store.
      const reg2 = new TokenRevocationRegistry({ store: store.repos.revokedTokens });
      reg2.loadFromStore();
      const tokens2 = createTokenService({ secret: SECRET, revocations: reg2 });
      await expect(tokens2.verify(token)).rejects.toMatchObject({ code: -32001 });
    } finally {
      store.db.close();
    }
  });

  it('LRU eviction does not un-revoke (falls back to the DB)', async () => {
    const store = openStore(':memory:');
    try {
      const reg = new TokenRevocationRegistry({
        store: store.repos.revokedTokens,
        maxEntries: 1,
      });
      const tokens = createTokenService({ secret: SECRET, revocations: reg });
      const t1 = await tokens.sign({ agentId: 'a', role: 'agent' }, { tokenId: 'j1' });
      const t2 = await tokens.sign({ agentId: 'a', role: 'agent' }, { tokenId: 'j2' });
      const exp = (await tokens.verify(t1)).expiresAt ?? 0;
      reg.revoke('j1', exp, 'default');
      reg.revoke('j2', exp, 'default'); // evicts j1 from the 1-entry LRU
      expect(reg.size).toBeLessThanOrEqual(1);
      expect(reg.isRevoked('j1')).toBe(true); // DB fallback
      await expect(tokens.verify(t1)).rejects.toMatchObject({ code: -32001 });
      await expect(tokens.verify(t2)).rejects.toMatchObject({ code: -32001 });
    } finally {
      store.db.close();
    }
  });

  it('cleanup deletes expired rows; active count reflects live revocations', () => {
    const store = openStore(':memory:');
    try {
      const reg = new TokenRevocationRegistry({ store: store.repos.revokedTokens });
      const nowSec = Math.floor(Date.now() / 1000);
      reg.revoke('expired', nowSec - 10, 'default');
      reg.revoke('live', nowSec + 3600, 'default');
      expect(reg.isRevoked('expired')).toBe(false);
      expect(reg.isRevoked('live')).toBe(true);
      expect(reg.activeCount()).toBe(1);
      expect(reg.cleanup()).toBe(1);
      expect(reg.cleanedTotal).toBe(1);
      expect(reg.activeCount()).toBe(1);
    } finally {
      store.db.close();
    }
  });

  it('cleanup timer lifecycle (off at 0, start/stop)', () => {
    const store = openStore(':memory:');
    try {
      const reg = new TokenRevocationRegistry({ store: store.repos.revokedTokens });
      expect(reg.isCleanupRunning()).toBe(false);
      reg.startCleanupTimer(0);
      expect(reg.isCleanupRunning()).toBe(false);
      reg.startCleanupTimer(50);
      expect(reg.isCleanupRunning()).toBe(true);
      reg.stopCleanupTimer();
      expect(reg.isCleanupRunning()).toBe(false);
    } finally {
      store.db.close();
    }
  });

  it('startup load failure throws (blocks startup)', () => {
    const failing = {
      loadUnexpired: () => {
        throw new Error('table corrupt');
      },
      isRevoked: () => false,
      insert: () => undefined,
      deleteExpired: () => 0,
      countActive: () => 0,
    } as unknown as RevokedTokensDao;
    const reg = new TokenRevocationRegistry({ store: failing });
    expect(() => reg.loadFromStore()).toThrowError(/table corrupt/);
  });
});

describe('v10 -> v11 migration with pre-migration backup', () => {
  it('backs up a non-empty v10 file database before applying v11', () => {
    const dir = mkdtempSync(join(tmpdir(), 'am-v11-'));
    try {
      const path = join(dir, 'db.sqlite');
      // Build a v10-shaped file DB (tables + data, ledger at 10).
      const db = openDatabase(path);
      db.exec(
        `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);`,
      );
      const record = db.prepare(
        'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
      );
      for (const migration of MIGRATIONS.filter((m) => m.version <= 10)) {
        db.transaction(() => {
          migration.up(db);
          record.run(migration.version, migration.name, 1);
        })();
      }
      db.prepare(
        `INSERT INTO accounts (id, name, skills, role, created_at)
         VALUES ('agt_v10', 'v10-account', '[]', 'agent', 1)`,
      ).run();
      db.close();

      const backup = prepareMigrationBackup(path);
      expect(backup.reason).toBe('backed-up');
      expect(backup.backupPath).toBeDefined();

      const db2 = openDatabase(path);
      try {
        const result = runMigrations(db2);
        expect(result.applied).toContain(11);
        const hasTable = db2
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='revoked_tokens'")
          .get();
        expect(hasTable).toBeDefined();
      } finally {
        db2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('revocation cleanup timer wired from config', () => {
  const closers: Array<{ close: () => Promise<void>; dbClose: () => void }> = [];
  afterEach(async () => {
    while (closers.length > 0) {
      const c = closers.pop();
      await c?.close();
      c?.dbClose();
    }
  });

  it('starts the cleanup timer and exposes the active-revoked gauge', async () => {
    const store = openStore(':memory:');
    const app = await startServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
        JWT_SECRET: 'test-secret-value-1234567890',
        LOG_LEVEL: 'silent',
        REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS: '3600',
      }),
      logger: createLogger({ level: 'silent' }),
      store: { db: store.db, repos: store.repos },
    });
    closers.push({ close: () => app.close(), dbClose: () => store.db.close() });
    expect(app.revocations.isCleanupRunning()).toBe(true);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toMatch(/agentmesh_revoked_tokens_active 0/);
  });
});
