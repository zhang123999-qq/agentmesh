import {
  createRepositories,
  openDatabase,
  runMigrations,
  type AgentMeshDatabase,
  type Repositories,
} from '../src/index.js';

export interface TestStore {
  db: AgentMeshDatabase;
  repos: Repositories;
}

/** Fresh in-memory database with the schema applied. */
export function makeStore(): TestStore {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return { db, repos: createRepositories(db) };
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

export function columnsOf(db: AgentMeshDatabase, table: string): ColumnInfo[] {
  return db.pragma(`table_info('${table}')`) as ColumnInfo[];
}

export function tableNames(db: AgentMeshDatabase): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function indexNames(db: AgentMeshDatabase, table: string): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(table) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
