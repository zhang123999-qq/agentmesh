import type { AgentMeshDatabase } from '../db.js';
import { parseJsonArrayColumn, toJsonColumn } from '../json.js';
import { DEFAULT_WORKSPACE_ID, type AccountRole, type SqlValue } from '../types.js';

/** A persisted agent/admin account. */
export interface Account {
  id: string;
  name: string;
  owner: string | null;
  skills: string[];
  role: AccountRole;
  createdAt: number;
  workspaceId: string;
}

export interface CreateAccountInput {
  id: string;
  name: string;
  owner?: string | null;
  skills?: readonly string[];
  role?: AccountRole;
  createdAt?: number;
  workspaceId?: string;
}

export type UpdateAccountPatch = Partial<
  Pick<Account, 'name' | 'owner' | 'skills' | 'role'>
>;

export interface ListAccountsOptions {
  workspaceId?: string;
  role?: AccountRole;
  limit?: number;
  offset?: number;
}

interface AccountRow {
  id: string;
  name: string;
  owner: string | null;
  skills: string;
  role: string;
  created_at: number;
  workspace_id: string;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    skills: parseJsonArrayColumn<string>(row.skills),
    role: row.role as AccountRole,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
  };
}

/** Typed CRUD for the `accounts` table. */
export class AccountsDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: CreateAccountInput): Account {
    const row: AccountRow = {
      id: input.id,
      name: input.name,
      owner: input.owner ?? null,
      skills: toJsonColumn(input.skills ?? []),
      role: input.role ?? 'agent',
      created_at: input.createdAt ?? Date.now(),
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, owner, skills, role, created_at, workspace_id)
         VALUES (@id, @name, @owner, @skills, @role, @created_at, @workspace_id)`,
      )
      .run(row);
    return mapAccount(row);
  }

  get(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Account | undefined {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as AccountRow | undefined;
    return row ? mapAccount(row) : undefined;
  }

  getByName(name: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Account | undefined {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE name = ? AND workspace_id = ?')
      .get(name, workspaceId) as AccountRow | undefined;
    return row ? mapAccount(row) : undefined;
  }

  /**
   * Look a name up across every workspace.
   *
   * `accounts.name` carries a table-wide `UNIQUE` constraint (workspace
   * agnostic), so the service must judge duplicates with the same semantics it
   * is enforced with. Multi-tenant name reuse needs a migration to
   * `UNIQUE(workspace_id, name)` (US-022+); until then this is the truth.
   */
  getByNameAnyWorkspace(name: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE name = ?').get(name) as
      | AccountRow
      | undefined;
    return row ? mapAccount(row) : undefined;
  }

  /**
   * Stored credential digest for an account (`null` when none was issued,
   * e.g. pre-v4 rows). The plaintext secret is never persisted.
   */
  getSecretHash(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): string | null {
    const row = this.db
      .prepare('SELECT secret_hash FROM accounts WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as { secret_hash: string | null } | undefined;
    return row?.secret_hash ?? null;
  }

  /** Store (or clear) the credential digest; returns false when the row is absent. */
  setSecretHash(
    id: string,
    secretHash: string | null,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): boolean {
    const result = this.db
      .prepare('UPDATE accounts SET secret_hash = ? WHERE id = ? AND workspace_id = ?')
      .run(secretHash, id, workspaceId);
    return result.changes > 0;
  }

  list(options: ListAccountsOptions = {}): Account[] {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.role !== undefined) {
      where.push('role = ?');
      params.push(options.role);
    }
    let sql = `SELECT * FROM accounts WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    } else if (options.offset !== undefined) {
      // SQLite only accepts OFFSET together with LIMIT; `-1` means "no limit",
      // so offset-only pagination works instead of being silently ignored.
      sql += ' LIMIT -1 OFFSET ?';
      params.push(options.offset);
    }
    const rows = this.db.prepare(sql).all(...params) as AccountRow[];
    return rows.map(mapAccount);
  }

  update(
    id: string,
    patch: UpdateAccountPatch,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Account | undefined {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.owner !== undefined) {
      sets.push('owner = ?');
      params.push(patch.owner);
    }
    if (patch.skills !== undefined) {
      sets.push('skills = ?');
      params.push(toJsonColumn(patch.skills));
    }
    if (patch.role !== undefined) {
      sets.push('role = ?');
      params.push(patch.role);
    }
    if (sets.length === 0) {
      return this.get(id, workspaceId);
    }
    params.push(id, workspaceId);
    const result = this.db
      .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`)
      .run(...params);
    return result.changes > 0 ? this.get(id, workspaceId) : undefined;
  }

  delete(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    const result = this.db
      .prepare('DELETE FROM accounts WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    return result.changes > 0;
  }

  count(workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM accounts WHERE workspace_id = ?')
      .get(workspaceId) as { count: number };
    return row.count;
  }
}
