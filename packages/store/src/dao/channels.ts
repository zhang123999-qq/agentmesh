import type { AgentMeshDatabase } from '../db.js';
import { DEFAULT_WORKSPACE_ID, type SqlValue } from '../types.js';

/** A persisted chat channel. */
export interface Channel {
  id: string;
  name: string;
  createdBy: string | null;
  createdAt: number;
  workspaceId: string;
}

export interface CreateChannelInput {
  id: string;
  name: string;
  createdBy?: string | null;
  createdAt?: number;
  workspaceId?: string;
}

export type UpdateChannelPatch = Partial<Pick<Channel, 'name' | 'createdBy'>>;

export interface ListChannelsOptions {
  workspaceId?: string;
  createdBy?: string;
  limit?: number;
  offset?: number;
}

interface ChannelRow {
  id: string;
  name: string;
  created_by: string | null;
  created_at: number;
  workspace_id: string;
}

function mapChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
  };
}

/** Typed CRUD for the `channels` table. */
export class ChannelsDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: CreateChannelInput): Channel {
    const row: ChannelRow = {
      id: input.id,
      name: input.name,
      created_by: input.createdBy ?? null,
      created_at: input.createdAt ?? Date.now(),
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT INTO channels (id, name, created_by, created_at, workspace_id)
         VALUES (@id, @name, @created_by, @created_at, @workspace_id)`,
      )
      .run(row);
    return mapChannel(row);
  }

  get(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Channel | undefined {
    const row = this.db
      .prepare('SELECT * FROM channels WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as ChannelRow | undefined;
    return row ? mapChannel(row) : undefined;
  }

  list(options: ListChannelsOptions = {}): Channel[] {
    const where: string[] = ['workspace_id = ?'];
    const params: SqlValue[] = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.createdBy !== undefined) {
      where.push('created_by = ?');
      params.push(options.createdBy);
    }
    let sql = `SELECT * FROM channels WHERE ${where.join(' AND ')} ORDER BY created_at ASC, id ASC`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }
    const rows = this.db.prepare(sql).all(...params) as ChannelRow[];
    return rows.map(mapChannel);
  }

  update(
    id: string,
    patch: UpdateChannelPatch,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Channel | undefined {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.createdBy !== undefined) {
      sets.push('created_by = ?');
      params.push(patch.createdBy);
    }
    if (sets.length === 0) {
      return this.get(id, workspaceId);
    }
    params.push(id, workspaceId);
    const result = this.db
      .prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`)
      .run(...params);
    return result.changes > 0 ? this.get(id, workspaceId) : undefined;
  }

  delete(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    const result = this.db
      .prepare('DELETE FROM channels WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    return result.changes > 0;
  }

  count(workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM channels WHERE workspace_id = ?')
      .get(workspaceId) as { count: number };
    return row.count;
  }
}
