import type { AgentMeshDatabase } from '../db.js';
import { DEFAULT_WORKSPACE_ID, type SqlValue } from '../types.js';

/** A persisted chat message. `seq` lives in the global `events.seq` space. */
export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  /** Global, monotonically increasing cursor shared with the event log. */
  seq: number;
  body: string;
  createdAt: number;
  workspaceId: string;
}

export interface CreateMessageInput {
  id: string;
  channelId: string;
  senderId: string;
  /** The global event seq assigned when the message was appended. */
  seq: number;
  body: string;
  createdAt?: number;
  workspaceId?: string;
}

export type UpdateMessagePatch = Partial<Pick<Message, 'body'>>;

export interface ListMessagesOptions {
  workspaceId?: string;
  /** Exclusive lower bound: only messages with `seq > afterSeq`. */
  afterSeq?: number;
  /** Exclusive upper bound: only messages with `seq < beforeSeq`. */
  beforeSeq?: number;
  limit?: number;
  /** `asc` (oldest first, default) or `desc` (newest first). */
  order?: 'asc' | 'desc';
}

interface MessageRow {
  id: string;
  channel_id: string;
  sender_id: string;
  seq: number;
  body: string;
  created_at: number;
  workspace_id: string;
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    seq: row.seq,
    body: row.body,
    createdAt: row.created_at,
    workspaceId: row.workspace_id,
  };
}

/** Typed CRUD for the `messages` table (pagination-ready, US-010). */
export class MessagesDao {
  constructor(private readonly db: AgentMeshDatabase) {}

  create(input: CreateMessageInput): Message {
    const row: MessageRow = {
      id: input.id,
      channel_id: input.channelId,
      sender_id: input.senderId,
      seq: input.seq,
      body: input.body,
      created_at: input.createdAt ?? Date.now(),
      workspace_id: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, channel_id, sender_id, seq, body, created_at, workspace_id)
         VALUES (@id, @channel_id, @sender_id, @seq, @body, @created_at, @workspace_id)`,
      )
      .run(row);
    return mapMessage(row);
  }

  get(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Message | undefined {
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?')
      .get(id, workspaceId) as MessageRow | undefined;
    return row ? mapMessage(row) : undefined;
  }

  /**
   * Page of a channel's history. Default order is chronological (`asc`) so
   * callers can render directly; pass `order: 'desc'` for backward paging.
   */
  listByChannel(channelId: string, options: ListMessagesOptions = {}): Message[] {
    const where: string[] = ['channel_id = ?', 'workspace_id = ?'];
    const params: SqlValue[] = [channelId, options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.afterSeq !== undefined) {
      where.push('seq > ?');
      params.push(options.afterSeq);
    }
    if (options.beforeSeq !== undefined) {
      where.push('seq < ?');
      params.push(options.beforeSeq);
    }
    const direction = options.order === 'desc' ? 'DESC' : 'ASC';
    let sql = `SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY seq ${direction}`;
    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as MessageRow[];
    return rows.map(mapMessage);
  }

  /** Most recent `limit` messages of a channel, returned oldest-first. */
  latest(channelId: string, limit: number, workspaceId: string = DEFAULT_WORKSPACE_ID): Message[] {
    const rows = this.listByChannel(channelId, { workspaceId, limit, order: 'desc' });
    return rows.reverse();
  }

  update(
    id: string,
    patch: UpdateMessagePatch,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Message | undefined {
    if (patch.body === undefined) {
      return this.get(id, workspaceId);
    }
    const result = this.db
      .prepare('UPDATE messages SET body = ? WHERE id = ? AND workspace_id = ?')
      .run(patch.body, id, workspaceId);
    return result.changes > 0 ? this.get(id, workspaceId) : undefined;
  }

  delete(id: string, workspaceId: string = DEFAULT_WORKSPACE_ID): boolean {
    const result = this.db
      .prepare('DELETE FROM messages WHERE id = ? AND workspace_id = ?')
      .run(id, workspaceId);
    return result.changes > 0;
  }

  count(channelId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE channel_id = ? AND workspace_id = ?')
      .get(channelId, workspaceId) as { count: number };
    return row.count;
  }
}
