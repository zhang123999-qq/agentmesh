import type { AgentMeshDatabase } from '../db.js';
import { DEFAULT_WORKSPACE_ID } from '../types.js';

/** Membership edge between a channel and an agent. */
export interface ChannelMember {
  channelId: string;
  agentId: string;
  joinedAt: number;
  workspaceId: string;
}

export interface AddChannelMemberInput {
  channelId: string;
  agentId: string;
  joinedAt?: number;
  workspaceId?: string;
}

interface ChannelMemberRow {
  channel_id: string;
  agent_id: string;
  joined_at: number;
  workspace_id: string;
}

function mapMember(row: ChannelMemberRow): ChannelMember {
  return {
    channelId: row.channel_id,
    agentId: row.agent_id,
    joinedAt: row.joined_at,
    workspaceId: row.workspace_id,
  };
}

/**
 * Typed CRUD for the `channel_members` join table.
 *
 * `add` is idempotent (composite primary key): joining twice keeps the
 * original `joined_at` instead of throwing, which matches the semantics of
 * `channel.join` (US-007).
 *
 * ## Multi-tenancy debt (M3 gate)
 *
 * The table's PRIMARY KEY is still `(channel_id, agent_id)` — it does NOT
 * include `workspace_id` — so two workspaces sharing a `(channel_id, agent_id)`
 * pair cannot coexist in this table. Migration v3 adds the additive
 * `uq_channel_members_ws` UNIQUE index on
 * `(workspace_id, channel_id, agent_id)` as a stepping stone, but making
 * multi-workspace coexistence real requires rebuilding `channel_members` with
 * the PK switched to `(workspace_id, channel_id, agent_id)`. That rebuild is
 * deferred to US-022+; the MVP runs a single workspace, so keep `add`/`get`
 * workspace-scoped but do not rely on cross-workspace rows here.
 */
export class ChannelMembersDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  add(input: AddChannelMemberInput): ChannelMember {
    const row: ChannelMemberRow = {
      channel_id: input.channelId,
      agent_id: input.agentId,
      joined_at: input.joinedAt ?? Date.now(),
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at, workspace_id)
         VALUES (@channel_id, @agent_id, @joined_at, @workspace_id)`,
      )
      .run(row);
    const existing = this.get(input.channelId, input.agentId, row.workspace_id);
    return existing ?? mapMember(row);
  }

  get(
    channelId: string,
    agentId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): ChannelMember | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM channel_members WHERE channel_id = ? AND agent_id = ? AND workspace_id = ?',
      )
      .get(channelId, agentId, workspaceId) as ChannelMemberRow | undefined;
    return row ? mapMember(row) : undefined;
  }

  isMember(
    channelId: string,
    agentId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): boolean {
    return this.get(channelId, agentId, workspaceId) !== undefined;
  }

  listByChannel(channelId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): ChannelMember[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_members
         WHERE channel_id = ? AND workspace_id = ?
         ORDER BY joined_at ASC, agent_id ASC`,
      )
      .all(channelId, workspaceId) as ChannelMemberRow[];
    return rows.map(mapMember);
  }

  listByAgent(agentId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): ChannelMember[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_members
         WHERE agent_id = ? AND workspace_id = ?
         ORDER BY joined_at ASC, channel_id ASC`,
      )
      .all(agentId, workspaceId) as ChannelMemberRow[];
    return rows.map(mapMember);
  }

  remove(
    channelId: string,
    agentId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): boolean {
    const result = this.db
      .prepare(
        'DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ? AND workspace_id = ?',
      )
      .run(channelId, agentId, workspaceId);
    return result.changes > 0;
  }

  count(channelId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM channel_members WHERE channel_id = ? AND workspace_id = ?',
      )
      .get(channelId, workspaceId) as { count: number };
    return row.count;
  }
}
