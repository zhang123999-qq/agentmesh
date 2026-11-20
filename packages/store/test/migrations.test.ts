import { describe, expect, it } from 'vitest';

import {
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  getSchemaVersion,
  listAppliedMigrations,
  openDatabase,
  runMigrations,
} from '../src/index.js';
import { columnsOf, indexNames, makeStore, tableNames } from './helpers.js';

const BUSINESS_TABLES = [
  'accounts',
  'channels',
  'channel_members',
  'messages',
  'tasks',
  'task_bids',
  'events',
  'snapshots',
] as const;

describe('migrations', () => {
  it('creates every business table plus the schema_version ledger', () => {
    const { db } = makeStore();
    const names = tableNames(db);
    for (const table of BUSINESS_TABLES) {
      expect(names).toContain(table);
    }
    expect(names).toContain('schema_version');
  });

  it('records the applied migration version', () => {
    const { db } = makeStore();
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const applied = listAppliedMigrations(db);
    expect(applied.map((m) => m.name)).toEqual([
      'initial_schema',
      'snapshots_schema',
      'store_hardening',
      'account_credentials',
      'event_log_integrity',
      'bid_events_per_version',
      'task_progress_and_side_effect_events',
    ]);
    expect(applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('is idempotent: a second run applies nothing and does not throw', () => {
    const { db } = makeStore();
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(listAppliedMigrations(db)).toHaveLength(7);

    // Third run on the same handle: still fine.
    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db).filter((n) => n === 'tasks')).toHaveLength(1);
  });

  it('repairs a database whose ledger was wiped (IF NOT EXISTS)', () => {
    const { db } = makeStore();
    db.exec('DELETE FROM schema_version');
    expect(getSchemaVersion(db)).toBe(0);
    const result = runMigrations(db);
    expect(result.applied).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('appends only v3-v7 to an existing v2 database without rebuilding tables', () => {
    const db = openDatabase(':memory:');

    // Rebuild a v2-shaped database exactly the way an older build left it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  INTEGER NOT NULL
      );
    `);
    const record = db.prepare(
      'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.version <= 2)) {
      db.transaction(() => {
        migration.up(db);
        record.run(migration.version, migration.name, 1_000 + migration.version);
      })();
    }
    expect(getSchemaVersion(db)).toBe(2);
    expect(indexNames(db, 'messages')).not.toContain('uq_messages_seq');
    expect(indexNames(db, 'channel_members')).not.toContain('uq_channel_members_ws');

    // Legacy data that must survive the upgrade untouched.
    db.prepare(
      `INSERT INTO messages (id, channel_id, sender_id, seq, body, created_at)
       VALUES ('msg_legacy', 'chn_1', 'agt_1', 7, 'before upgrade', 5)`,
    ).run();
    db.prepare(
      `INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES ('chn_1', 'agt_1', 5)`,
    ).run();

    const schemaBefore = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string };

    const result = runMigrations(db);

    expect(result).toEqual({ applied: [3, 4, 5, 6, 7], version: 7 });
    expect(getSchemaVersion(db)).toBe(7);
    expect(listAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Only indexes were added — the table definition is byte-identical.
    const schemaAfter = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .get() as { sql: string };
    expect(schemaAfter.sql).toBe(schemaBefore.sql);

    expect(indexNames(db, 'messages')).toContain('uq_messages_seq');
    expect(indexNames(db, 'channel_members')).toContain('uq_channel_members_ws');
    expect(
      (db.prepare("SELECT body FROM messages WHERE id = 'msg_legacy'").get() as { body: string })
        .body,
    ).toBe('before upgrade');
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM channel_members').get() as { count: number },
    ).toEqual({ count: 1 });

    // Re-running after the upgrade is still a no-op.
    expect(runMigrations(db).applied).toEqual([]);
  });

  it('gives every business table workspace_id NOT NULL DEFAULT default + an index', () => {
    const { db } = makeStore();
    for (const table of BUSINESS_TABLES) {
      const workspace = columnsOf(db, table).find((c) => c.name === 'workspace_id');
      expect(workspace, `${table}.workspace_id`).toBeDefined();
      expect(workspace?.notnull).toBe(1);
      expect(workspace?.dflt_value).toBe("'default'");
      expect(
        indexNames(db, table).length,
        `${table} should have at least one index`,
      ).toBeGreaterThan(0);
    }
  });

  it('models CAS + OR-Set metadata as specified', () => {
    const { db } = makeStore();

    const taskVersion = columnsOf(db, 'tasks').find((c) => c.name === 'version');
    expect(taskVersion?.notnull).toBe(1);
    expect(taskVersion?.dflt_value).toBe('0');

    const bidColumns = columnsOf(db, 'task_bids');
    const tombstone = bidColumns.find((c) => c.name === 'tombstone');
    expect(tombstone?.notnull).toBe(1);
    expect(tombstone?.dflt_value).toBe('0');
    expect(bidColumns.find((c) => c.name === 'deleted_at')?.notnull).toBe(0);
    expect(bidColumns.find((c) => c.name === 'stable_frontier')).toBeDefined();

    const bidIndexes = indexNames(db, 'task_bids');
    expect(bidIndexes).toContain('idx_task_bids_task');
  });

  it('makes events.seq a global AUTOINCREMENT key with an aggregate index', () => {
    const { db } = makeStore();
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain('AUTOINCREMENT');
    expect(sql).toContain('seq');
    expect(indexNames(db, 'events')).toContain('idx_events_aggregate');
  });

  it('creates the v3 hardening indexes on a fresh database', () => {
    const { db } = makeStore();

    expect(indexNames(db, 'messages')).toContain('uq_messages_seq');
    expect(indexNames(db, 'channel_members')).toContain('uq_channel_members_ws');

    const indexSql = (name: string): string =>
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(name) as { sql: string }
      ).sql;
    expect(indexSql('uq_messages_seq')).toContain('UNIQUE');
    expect(indexSql('uq_messages_seq')).toContain('messages(seq)');
    expect(indexSql('uq_channel_members_ws')).toContain(
      'channel_members(workspace_id, channel_id, agent_id)',
    );

    // The channel_members primary key is deliberately NOT rebuilt by v3.
    const membersPk = columnsOf(db, 'channel_members')
      .filter((c) => c.pk > 0)
      .map((c) => c.name);
    expect(membersPk).toEqual(['channel_id', 'agent_id']);
  });

  it('adds a nullable accounts.secret_hash column (v4) to a fresh database', () => {
    const { db } = makeStore();
    const secretHash = columnsOf(db, 'accounts').find((c) => c.name === 'secret_hash');
    expect(secretHash, 'accounts.secret_hash').toBeDefined();
    expect(secretHash?.type).toBe('TEXT');
    // Nullable on purpose: pre-v4 / seeded rows simply have no credential.
    expect(secretHash?.notnull).toBe(0);
    expect(secretHash?.dflt_value).toBeNull();
  });

  it('keeps status events unique but allows multiple bid events per version (v6)', () => {
    const { db } = makeStore();
    const indexes = indexNames(db, 'events');
    expect(indexes).toContain('uq_events_aggregate_version_status');
    expect(indexes).not.toContain('uq_events_aggregate_version');

    const insertStatus = db.prepare(
      `INSERT INTO events (aggregate_id, type, version, payload, ts)
       VALUES ('task:tsk_1', 'task.published', 1, '{}', 1)`,
    );
    insertStatus.run();
    expect(() => insertStatus.run()).toThrow(/UNIQUE constraint failed/);

    // Bids are excluded from the partial index: many bids share the task
    // version because bidding must not churn `tasks.version`.
    const insertBid = db.prepare(
      `INSERT INTO events (aggregate_id, type, version, payload, ts)
       VALUES ('task:tsk_1', 'task.bid.placed', 1, '{}', 2)`,
    );
    insertBid.run();
    expect(() => insertBid.run()).not.toThrow();
    const insertNotification = db.prepare(
      `INSERT INTO events (aggregate_id, type, version, payload, ts)
       VALUES ('task:tsk_1', 'task.bid.received', 1, '{}', 3)`,
    );
    expect(() => insertNotification.run()).not.toThrow();
  });

  it('adds tasks.progress and allows duplicate side-effect events (v7)', () => {
    const { db } = makeStore();
    expect(columnsOf(db, 'tasks').map((column) => column.name)).toContain('progress');

    const insertProgress = db.prepare(
      `INSERT INTO events (aggregate_id, type, version, payload, ts)
       VALUES ('task:tsk_1', 'task.progress.updated', 1, '{}', 10)`,
    );
    insertProgress.run();
    expect(() => insertProgress.run()).not.toThrow();

    const insertDependency = db.prepare(
      `INSERT INTO events (aggregate_id, type, version, payload, ts)
       VALUES ('task:tsk_1', 'task.dependency.failed', 1, '{}', 11)`,
    );
    insertDependency.run();
    expect(() => insertDependency.run()).not.toThrow();
  });

  it('applies v4 idempotently even when the column already exists', () => {
    const { db } = makeStore();
    const v4 = MIGRATIONS.find((m) => m.version === 4);
    expect(v4?.name).toBe('account_credentials');

    // SQLite has no ADD COLUMN IF NOT EXISTS; the guard must swallow a re-run
    // instead of failing with "duplicate column name: secret_hash".
    expect(() => v4?.up(db)).not.toThrow();
    expect(columnsOf(db, 'accounts').filter((c) => c.name === 'secret_hash')).toHaveLength(1);

    // A manual body re-run must not corrupt the ledger.
    expect(listAppliedMigrations(db).map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(runMigrations(db).applied).toEqual([]);
  });

  it('upgrades an existing v3 database to v7 without rewriting account rows', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  INTEGER NOT NULL
      );
    `);
    const record = db.prepare(
      'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
    );
    for (const migration of MIGRATIONS.filter((m) => m.version <= 3)) {
      db.transaction(() => {
        migration.up(db);
        record.run(migration.version, migration.name, 1_000 + migration.version);
      })();
    }
    expect(getSchemaVersion(db)).toBe(3);
    expect(columnsOf(db, 'accounts').map((c) => c.name)).not.toContain('secret_hash');

    // A v3-era account (no credential concept yet).
    db.prepare(
      `INSERT INTO accounts (id, name, owner, skills, role, created_at, workspace_id)
       VALUES ('agt_legacy', 'legacy', 'alice', '[]', 'agent', 42, 'default')`,
    ).run();

    const result = runMigrations(db);

    expect(result).toEqual({ applied: [4, 5, 6, 7], version: 7 });
    expect(getSchemaVersion(db)).toBe(7);
    expect(columnsOf(db, 'accounts').map((c) => c.name)).toContain('secret_hash');

    const row = db
      .prepare('SELECT name, owner, created_at, workspace_id, secret_hash FROM accounts WHERE id = ?')
      .get('agt_legacy') as Record<string, unknown>;
    expect(row).toEqual({
      name: 'legacy',
      owner: 'alice',
      created_at: 42,
      workspace_id: 'default',
      secret_hash: null,
    });

    // And the upgrade is a one-off: nothing left to apply.
    expect(runMigrations(db).applied).toEqual([]);
  });

  it('does not create duplicate objects on repeated runs', () => {
    const { db } = makeStore();
    runMigrations(db);
    const before = tableNames(db);
    runMigrations(db);
    expect(tableNames(db)).toEqual(before);
  });
});
