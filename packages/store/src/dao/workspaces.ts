import type { AgentMeshDatabase } from '../db.js';

/**
 * Tenant registry (US-022/025). Beyond the id/name, each workspace carries an
 * optional invite code (onboarding), a disabled marker, and an agent quota.
 * Business rows stay scoped by their own `workspace_id`; this DAO only manages
 * the registry.
 */
export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  inviteCode: string | null;
  inviteExpiresAt: number | null;
  disabledAt: number | null;
  maxAgents: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  created_at: number;
  invite_code: string | null;
  invite_expires_at: number | null;
  disabled_at: number | null;
  max_agents: number;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    inviteCode: row.invite_code,
    inviteExpiresAt: row.invite_expires_at,
    disabledAt: row.disabled_at,
    maxAgents: row.max_agents,
  };
}

export interface CreateWorkspaceInput {
  id: string;
  name: string;
  createdAt?: number;
  inviteCode?: string | null;
  inviteExpiresAt?: number | null;
  disabledAt?: number | null;
  maxAgents?: number;
}

export class WorkspacesDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: CreateWorkspaceInput): Workspace {
    const row: WorkspaceRow = {
      id: input.id,
      name: input.name,
      created_at: input.createdAt ?? Date.now(),
      invite_code: input.inviteCode ?? null,
      invite_expires_at: input.inviteExpiresAt ?? null,
      disabled_at: input.disabledAt ?? null,
      max_agents: input.maxAgents ?? 100,
    };
    this.db
      .prepare(
        `INSERT INTO workspaces
           (id, name, created_at, invite_code, invite_expires_at, disabled_at, max_agents)
         VALUES
           (@id, @name, @created_at, @invite_code, @invite_expires_at, @disabled_at, @max_agents)`,
      )
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

  /** Resolve an invite code to its workspace (caller checks expiry/disabled). */
  findByInvite(code: string): Workspace | undefined {
    const row = this.db
      .prepare('SELECT * FROM workspaces WHERE invite_code = ?')
      .get(code) as WorkspaceRow | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  /** Mark a workspace disabled (idempotent; keeps the first reason time). */
  disable(id: string, disabledAt: number = Date.now()): boolean {
    const result = this.db
      .prepare(
        'UPDATE workspaces SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ? AND id != ?',
      )
      .run(disabledAt, id, 'default');
    // `default` cannot be disabled; treat as "not changed" for disallowed ids.
    return result.changes > 0;
  }

  list(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY created_at ASC, id ASC')
      .all() as WorkspaceRow[];
    return rows.map(mapWorkspace);
  }
}
