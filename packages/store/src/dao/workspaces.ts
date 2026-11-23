import type { AgentMeshDatabase } from '../db.js';

/**
 * Tenant registry (US-022). The `workspaces` table plus the seeded `default`
 * row give US-023/US-025 a place to create and enumerate tenants. Business rows
 * stay scoped by their own `workspace_id`; this DAO only manages the registry.
 */
export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: number;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export class WorkspacesDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: { id: string; name: string; createdAt?: number }): Workspace {
    const row: WorkspaceRow = {
      id: input.id,
      name: input.name,
      created_at: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare('INSERT INTO workspaces (id, name, created_at) VALUES (@id, @name, @created_at)')
      .run(row);
    return mapWorkspace(row);
  }

  get(id: string): Workspace | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE id = ?')
      .get(id) as WorkspaceRow | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id) !== undefined;
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at ASC, id ASC')
      .all() as WorkspaceRow[];
    return rows.map(mapWorkspace);
  }
}
