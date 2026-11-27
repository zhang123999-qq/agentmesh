/**
 * @agentmesh/store — SQLite persistence layer.
 *
 * The server (and the migration entrypoint used by US-018) open a database
 * with {@link openDatabase}, bring the schema up to date with
 * {@link runMigrations}, then talk to the tables exclusively through the typed
 * DAOs bundled by {@link createRepositories}.
 *
 * ```ts
 * import { openDatabase, runMigrations, createRepositories } from '@agentmesh/store';
 *
 * const db = openDatabase('data/agentmesh.db');
 * runMigrations(db);
 * const repos = createRepositories(db);
 * repos.tasks.create({ id: 'tsk_1', title: 'build the thing', status: 'open' });
 * ```
 */

export * from './types.js';
export * from './db.js';
export * from './json.js';
export * from './migrations.js';

export * from './dao/accounts.js';
export * from './dao/channels.js';
export * from './dao/channel-members.js';
export * from './dao/messages.js';
export * from './dao/tasks.js';
export * from './dao/task-bids.js';
export * from './dao/events.js';
export * from './dao/snapshots.js';
export * from './dao/workspaces.js';
export * from './dao/revoked-tokens.js';

import { openDatabase, type AgentMeshDatabase } from './db.js';
import { runMigrations } from './migrations.js';
import { AccountsDao } from './dao/accounts.js';
import { ChannelMembersDao } from './dao/channel-members.js';
import { ChannelsDao } from './dao/channels.js';
import { EventsDao } from './dao/events.js';
import { MessagesDao } from './dao/messages.js';
import { SnapshotsDao } from './dao/snapshots.js';
import { TaskBidsDao } from './dao/task-bids.js';
import { TasksDao } from './dao/tasks.js';
import { WorkspacesDao } from './dao/workspaces.js';
import { RevokedTokensDao } from './dao/revoked-tokens.js';

/** All DAOs wired to one database handle. */
export interface Repositories {
  accounts: AccountsDao;
  channels: ChannelsDao;
  channelMembers: ChannelMembersDao;
  messages: MessagesDao;
  tasks: TasksDao;
  taskBids: TaskBidsDao;
  events: EventsDao;
  snapshots: SnapshotsDao;
  workspaces: WorkspacesDao;
  revokedTokens: RevokedTokensDao;
}

/** Build every DAO for a database handle (cheap: DAOs only hold the handle). */
export function createRepositories(db: AgentMeshDatabase): Repositories {
  return {
    accounts: new AccountsDao(db),
    channels: new ChannelsDao(db),
    channelMembers: new ChannelMembersDao(db),
    messages: new MessagesDao(db),
    tasks: new TasksDao(db),
    taskBids: new TaskBidsDao(db),
    events: new EventsDao(db),
    snapshots: new SnapshotsDao(db),
    workspaces: new WorkspacesDao(db),
    revokedTokens: new RevokedTokensDao(db),
  };
}

/**
 * Convenience for server startup: open, migrate, and return the handle plus
 * DAOs in one call. `path` defaults to `:memory:` for tests.
 */
export function openStore(
  path = ':memory:',
): { db: AgentMeshDatabase; repos: Repositories } {
  const db = openDatabase(path);
  runMigrations(db);
  return { db, repos: createRepositories(db) };
}
