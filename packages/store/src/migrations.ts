/**
 * Schema migrations.
 *
 * ## Idempotency
 *
 * Two independent mechanisms make `runMigrations(db)` safe to call on every
 * server start (and repeatedly in tests):
 *
 *  1. a `schema_version` ledger records which migration versions were applied;
 *  2. every statement is `CREATE TABLE / INDEX IF NOT EXISTS`, so even a
 *     database whose ledger was lost is repaired instead of exploding.
 *
 * ## Design notes baked into the schema
 *
 * - `events.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`: the global,
 *   monotonically increasing, never-reused sequence used for resume/dedupe
 *   (see `@agentmesh/protocol` docs). SQLite does not reuse AUTOINCREMENT ids
 *   even after deletes, which is what "global epoch" semantics needs.
 * - `tasks.version` powers optimistic concurrency: US-009/013 issue
 *   `UPDATE ... WHERE id = ? AND version = ?` and translate 0 rows into
 *   error `-32007` (version conflict).
 * - `task_bids.tombstone` / `deleted_at` implement OR-Set element-level
 *   deletion for the bid set (US-012). The MVP only *writes* tombstones; no
 *   physical deletion happens here. `stable_frontier` is the aggregate-level
 *   logical cursor recording how far compaction has safely advanced
 *   (denormalised on rows; its aggregate value is `MAX(stable_frontier)`).
 * - every business table carries `workspace_id TEXT NOT NULL DEFAULT 'default'`
 *   plus an index, so multi-tenancy can be switched on without a migration.
 */

import type { AgentMeshDatabase } from './db.js';
import { DEFAULT_WORKSPACE_ID } from './types.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: AgentMeshDatabase) => void;
}

const INITIAL_SCHEMA_SQL = `
-- ---------------------------------------------------------------- accounts --
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  owner         TEXT,
  skills        TEXT NOT NULL DEFAULT '[]',
  role          TEXT NOT NULL DEFAULT 'agent',
  created_at    INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'
);
CREATE INDEX IF NOT EXISTS idx_accounts_workspace ON accounts(workspace_id);
CREATE INDEX IF NOT EXISTS idx_accounts_role ON accounts(workspace_id, role);

-- ---------------------------------------------------------------- channels --
CREATE TABLE IF NOT EXISTS channels (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'
);
CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);

-- --------------------------------------------------------- channel_members --
-- PK is (channel_id, agent_id) for historical reasons (single-workspace MVP).
-- v3 adds the additive UNIQUE index (workspace_id, channel_id, agent_id);
-- real multi-workspace coexistence needs a PK rebuild (US-022+).
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
  PRIMARY KEY (channel_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel ON channel_members(channel_id);

-- ---------------------------------------------------------------- messages --
-- seq mirrors events.seq: messages and the event stream share ONE global
-- sequence space, so history pages and live pushes dedupe identically.
-- v3 makes it UNIQUE (index "uq_messages_seq"); v1 databases get the constraint
-- incrementally without rebuilding the table.
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  sender_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_workspace_seq ON messages(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- ------------------------------------------------------------------- tasks --
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  required_skills  TEXT NOT NULL DEFAULT '[]',
  budget           REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,
  assignee         TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
  parent_id        TEXT,
  deadline         INTEGER,
  meta             TEXT,
  blocked_by       TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  workspace_id     TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'
);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(workspace_id, assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

-- --------------------------------------------------------------- task_bids --
CREATE TABLE IF NOT EXISTS task_bids (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  agent_id         TEXT NOT NULL,
  price            REAL NOT NULL,
  eta              INTEGER,
  approach         TEXT,
  confidence       REAL,
  tombstone        INTEGER NOT NULL DEFAULT 0,
  deleted_at       INTEGER,
  stable_frontier  INTEGER,
  created_at       INTEGER NOT NULL,
  workspace_id     TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'
);
CREATE INDEX IF NOT EXISTS idx_task_bids_task ON task_bids(task_id);
CREATE INDEX IF NOT EXISTS idx_task_bids_task_agent ON task_bids(task_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_task_bids_workspace ON task_bids(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_bids_tombstone ON task_bids(task_id, tombstone);

-- ------------------------------------------------------------------ events --
CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  aggregate_id  TEXT NOT NULL,
  type          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  payload       TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  prev_hash     TEXT,
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}'
);
CREATE INDEX IF NOT EXISTS idx_events_aggregate ON events(aggregate_id);
CREATE INDEX IF NOT EXISTS idx_events_aggregate_seq ON events(aggregate_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(workspace_id, type);
CREATE INDEX IF NOT EXISTS idx_events_workspace ON events(workspace_id);
`;

/**
 * v2 — aggregate snapshots (event-sourcing read-model checkpoints).
 *
 * `(aggregate_id, version)` is the natural key: replaying to a later version
 * supersedes an older checkpoint, and re-taking the same version is an upsert
 * (idempotent retry). `seq` records the global watermark the snapshot covers,
 * so incremental replay starts at `seq > snapshot.seq`.
 */
const SNAPSHOTS_SQL = `
CREATE TABLE IF NOT EXISTS snapshots (
  aggregate_id  TEXT NOT NULL,
  version       INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  state         TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
  PRIMARY KEY (aggregate_id, version)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_workspace ON snapshots(workspace_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_aggregate_seq ON snapshots(aggregate_id, seq);
`;

/**
 * v3 — storage hardening (M3 gate, no new user story).
 *
 * - `messages.seq` is documented as sharing ONE global sequence space with
 *   `events.seq`, so it must be globally unique. v1 only had non-unique
 *   indexes on it; this adds the missing UNIQUE index. `seq` alone is the key
 *   (not `(workspace_id, seq)`) because uniqueness is global by definition.
 * - `channel_members` gains a workspace-aware UNIQUE index, but the table's
 *   PRIMARY KEY stays `(channel_id, agent_id)`: proper multi-workspace
 *   coexistence needs a table rebuild (PK must become
 *   `(workspace_id, channel_id, agent_id)`), which is deferred to US-022+.
 *   The index below is additive and keeps single-workspace behaviour intact.
 *
 * Both statements are `IF NOT EXISTS`, so this migration is idempotent and can
 * be appended to an existing v2 database without rebuilding any table.
 */
const HARDENING_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_seq ON messages(seq);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_members_ws
  ON channel_members(workspace_id, channel_id, agent_id);
`;

/**
 * v4 — account credentials (US-005 security fix).
 *
 * `agent.register` now issues a per-account secret; only its SHA-256 hash is
 * persisted here. The column is nullable so accounts created before v4 (and
 * seeded fixtures) remain readable — they simply cannot use the
 * secret-based `agent.authenticate` path until a secret is issued.
 *
 * SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so idempotency is
 * enforced by inspecting `PRAGMA table_info(accounts)` first. This also keeps
 * the migration safe if a future build folds the column into v1.
 */
function hasColumn(db: AgentMeshDatabase, table: string, column: string): boolean {
  const columns = db.pragma(`table_info('${table}')`) as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

/**
 * v5 — event-log integrity backstop.
 *
 * `EventStore` now computes an aggregate's next version and its `prevHash`
 * under an `IMMEDIATE` write lock, so a single process cannot produce two
 * events with the same `(aggregate_id, version)`. This unique index is the
 * database-level guard for a second writer process: it turns a silent
 * duplicate-version write into a hard constraint error instead of corrupting
 * replay state. Existing databases that already contain duplicates will fail
 * the migration loudly (SQLite cannot build a unique index over them); that is
 * intentional — the duplicates must be repaired before serving traffic.
 */
const EVENT_INTEGRITY_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_aggregate_version
  ON events(workspace_id, aggregate_id, version);
`;

/**
 * v6 — allow multiple bid events at one aggregate version.
 *
 * The bidding design keeps `tasks.version` stable across bids, so a task can
 * have several `task.bid.placed` / `task.bid.received` events at the same
 * `(aggregate_id, version)`. v5's unconditional unique index is replaced by a
 * **partial** unique index that still guards every status/domain event while
 * excluding bid events. This preserves the duplicate-version backstop where it
 * matters (one status transition per version) without making the bid log
 * unrepresentable.
 */
const BID_EVENT_INDEX_SQL = `
DROP INDEX IF EXISTS uq_events_aggregate_version;
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_aggregate_version_status
  ON events(workspace_id, aggregate_id, version)
  WHERE type NOT IN ('task.bid.placed', 'task.bid.received');
`;

/**
 * v7 — task progress + side-effect event versions.
 *
 * `tasks.progress` is updated in place by `task.progress` (no version bump);
 * SQLite needs a column for that. The partial unique index from v6 is widened
 * to exclude `task.progress.updated` and `task.dependency.failed`: both are
 * side-effect notifications that can share the aggregate's current version
 * with a status event (or with each other) without representing a new state.
 */
const TASK_PROGRESS_SQL = 'ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0';
const TASK_COMPLETED_AT_SQL = 'ALTER TABLE tasks ADD COLUMN completed_at INTEGER';

const SIDE_EFFECT_EVENT_INDEX_SQL = `
DROP INDEX IF EXISTS uq_events_aggregate_version_status;
CREATE UNIQUE INDEX IF NOT EXISTS uq_events_aggregate_version_status
  ON events(workspace_id, aggregate_id, version)
  WHERE type NOT IN (
    'task.bid.placed',
    'task.bid.received',
    'task.progress.updated',
    'task.dependency.failed'
  );
`;

const ACCOUNT_CREDENTIALS_SQL = 'ALTER TABLE accounts ADD COLUMN secret_hash TEXT';

/**
 * v9 — multi-tenant schema (US-022, locked design US-021E).
 *
 * Every business table already carried `workspace_id NOT NULL DEFAULT 'default'`
 * since v1, so no column/backfill is needed for existing rows. v9 does two
 * things the single-workspace MVP deferred:
 *
 *  1. add a `workspaces` registry table and seed the `default` row (US-023/025
 *     need a place to create/list tenants);
 *  2. rebuild `channel_members` so its PRIMARY KEY includes `workspace_id`
 *     (`(workspace_id, channel_id, agent_id)`). The old PK was
 *     `(channel_id, agent_id)`; channel ids are already globally unique, but the
 *     workspace-scoped PK makes the invariant explicit and lets two workspaces
 *     ever share a `(channel_id, agent_id)` pair. The rebuild folds in the v3
 *     `uq_channel_members_ws` index (the PK now covers it), so that index is
 *     dropped by the table rebuild and not recreated.
 *
 * Backfill: none. `workspace_id` defaults are applied at INSERT time; existing
 * rows already read `'default'`. This migration is idempotent (PK guard + IF
 * NOT EXISTS + INSERT OR IGNORE).
 */
const WORKSPACES_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
`;

const CHANNEL_MEMBERS_REBUILD_SQL = `
DROP TABLE IF EXISTS channel_members_v9;
CREATE TABLE channel_members_v9 (
  workspace_id  TEXT NOT NULL DEFAULT '${DEFAULT_WORKSPACE_ID}',
  channel_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, channel_id, agent_id)
);
INSERT INTO channel_members_v9 (workspace_id, channel_id, agent_id, joined_at)
  SELECT workspace_id, channel_id, agent_id, joined_at FROM channel_members;
DROP TABLE channel_members;
ALTER TABLE channel_members_v9 RENAME TO channel_members;
CREATE INDEX IF NOT EXISTS idx_channel_members_agent
  ON channel_members(workspace_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_channel
  ON channel_members(channel_id);
`;

/** True once `channel_members` has been rebuilt with a workspace-scoped PK. */
function channelMembersPkIncludesWorkspace(db: AgentMeshDatabase): boolean {
  const columns = db.pragma("table_info('channel_members')") as Array<{
    name: string;
    pk: number;
  }>;
  const workspace = columns.find((c) => c.name === 'workspace_id');
  return workspace !== undefined && workspace.pk > 0;
}


export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(INITIAL_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: 'snapshots_schema',
    up: (db) => {
      db.exec(SNAPSHOTS_SQL);
    },
  },
  {
    version: 3,
    name: 'store_hardening',
    up: (db) => {
      db.exec(HARDENING_SQL);
    },
  },
  {
    version: 4,
    name: 'account_credentials',
    up: (db) => {
      if (!hasColumn(db, 'accounts', 'secret_hash')) {
        db.exec(ACCOUNT_CREDENTIALS_SQL);
      }
    },
  },
  {
    version: 5,
    name: 'event_log_integrity',
    up: (db) => {
      db.exec(EVENT_INTEGRITY_SQL);
    },
  },
  {
    version: 6,
    name: 'bid_events_per_version',
    up: (db) => {
      db.exec(BID_EVENT_INDEX_SQL);
    },
  },
  {
    version: 7,
    name: 'task_progress_and_side_effect_events',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'progress')) {
        db.exec(TASK_PROGRESS_SQL);
      }
      db.exec(SIDE_EFFECT_EVENT_INDEX_SQL);
    },
  },
  {
    version: 8,
    name: 'task_completed_at',
    up: (db) => {
      if (!hasColumn(db, 'tasks', 'completed_at')) {
        db.exec(TASK_COMPLETED_AT_SQL);
      }
    },
  },
  {
    version: 9,
    name: 'multi_tenant_schema',
    up: (db) => {
      db.exec(WORKSPACES_SQL);
      db.prepare('INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(
        DEFAULT_WORKSPACE_ID,
        'Default',
        Date.now(),
      );
      if (!channelMembersPkIncludesWorkspace(db)) {
        db.exec(CHANNEL_MEMBERS_REBUILD_SQL);
      }
    },
  },
];

/** Highest migration version shipped by this build. */
export const CURRENT_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (max, m) => (m.version > max ? m.version : max),
  0,
);

function ensureSchemaVersionTable(db: AgentMeshDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );
  `);
}

/** Version recorded in the ledger (0 = fresh database). */
export function getSchemaVersion(db: AgentMeshDatabase): number {
  ensureSchemaVersionTable(db);
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version')
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/** Applied migration ledger, oldest first. */
export function listAppliedMigrations(
  db: AgentMeshDatabase,
): Array<{ version: number; name: string; appliedAt: number }> {
  ensureSchemaVersionTable(db);
  const rows = db
    .prepare('SELECT version, name, applied_at FROM schema_version ORDER BY version ASC')
    .all() as Array<{ version: number; name: string; applied_at: number }>;
  return rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }));
}

export interface MigrationResult {
  /** Migration versions applied by this call (empty when already up to date). */
  readonly applied: number[];
  /** Schema version after the call. */
  readonly version: number;
}

/**
 * Apply every pending migration in order. Safe (and cheap) to call repeatedly;
 * each migration commits atomically together with its ledger row.
 */
export function runMigrations(db: AgentMeshDatabase): MigrationResult {
  ensureSchemaVersionTable(db);

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
  );
  const applied: number[] = [];

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    const current = getSchemaVersion(db);
    if (migration.version <= current) {
      continue;
    }
    db.transaction(() => {
      migration.up(db);
      upsert.run(migration.version, migration.name, Date.now());
    })();
    applied.push(migration.version);
  }

  return { applied, version: getSchemaVersion(db) };
}
