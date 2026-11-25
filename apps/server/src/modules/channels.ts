/**
 * Channel + message feature module (US-007).
 *
 * Methods (see `METHODS.channel` / `METHODS.message` in `@agentmesh/protocol`):
 *
 * - `channel.create` — create a channel in the caller's workspace, make the
 *   creator its first member, append `channel.created` (+ `channel.member.joined`).
 * - `channel.join`   — idempotent membership edge append (`channel.member.joined`).
 * - `channel.leave`  — idempotent removal append (`channel.member.left`).
 * - `channel.list`   — channels of the request workspace with members.
 * - `message.send`   — append `message.created` **and** persist the message row
 *   with the event's global `seq`, then push `message.new` to online members.
 *
 * ## `seq` is one space (locked contract)
 *
 * `messages.seq` is not a per-channel counter: it is the global `events.seq`
 * assigned by SQLite AUTOINCREMENT for the `message.created` event this row
 * was born from. `messages.seq` carries a UNIQUE index (`uq_messages_seq`,
 * migration v3), so "the same seq twice" is impossible by construction —
 * `message.send` appends the event first, reads back its `seq`, and writes the
 * row inside the *same* transaction. The result is that a message row and its
 * event always agree on the cursor, and a client can dedupe live pushes and
 * history pages against the same resume watermark.
 *
 * ## Event log layout
 *
 * All channel facts use the channel aggregate (`channel:<channelId>`): the
 * channel is the natural partition, so `loadAggregate('channel:chn_1')`
 * replays the channel's whole timeline (metadata, membership, messages) into
 * one stream. Message events carry `messageId` in the payload; the message
 * reducer reads `content` (notification) or `body` (domain) interchangeably.
 *
 * ## Broadcasting (who may see a message)
 *
 * `message.created` is a **domain-only** event type, so the US-006 live-push
 * feed deliberately does not put it on the wire (there is no notification
 * schema for it, and it must not be broadcast workspace-wide — a message is
 * private to the channel). Instead this module performs the fan-out itself,
 * after the transaction commits, with the channel's member list:
 *
 * ```ts
 * fanout(notificationEvent, memberIds)  // gateway.publishEventToAgents(...)
 * ```
 *
 * The gateway resolves the member ids to live sockets, so only online members
 * receive the push (non-members never do) — the "ideal" channel-filtered
 * delivery from the story, not a workspace-wide broadcast. The pushed frame is
 * a `message.new` notification carrying **the same `seq`** as the logged
 * `message.created` event, so a client's dedupe set and resume watermark stay
 * coherent across live and replay paths (`resume` skips domain-only types, so
 * the message itself must be fetched from history — `message.history` is
 * US-010).
 *
 * ## Authorization
 *
 * Every method requires a verified identity (`-32001`). Writes are limited to
 * `admin`/`agent` (an `observer` is read-only, `-32002`). Regular members may
 * only join/leave *themselves*; adding or removing somebody else is
 * member management and requires `admin` (`-32002`). Sending to a channel the
 * caller is not a member of is `-32002` with `data.reason = "not_a_member"`;
 * an unknown channel is `-32004`.
 */

import { randomUUID } from 'node:crypto';

import { aggregateIdOf } from '@agentmesh/core';
import type { CoreEvent, EventStore } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS, ProtocolError } from '@agentmesh/protocol';
import type {
  AgentMeshDatabase,
  ChannelMembersDao,
  ChannelsDao,
  MessagesDao,
  StoredEvent,
} from '@agentmesh/store';
import { withTransaction } from '@agentmesh/store';

import type { AuthContext } from '../auth/roles.js';
import { WORKSPACE_ADMIN_ROLES, requireRole } from '../auth/roles.js';
import type { HandlerRegistry } from '../registry.js';

/** Longest accepted channel name. */
export const MAX_CHANNEL_NAME_LENGTH = 64;
/** Longest accepted message body. */
export const MAX_MESSAGE_BODY_LENGTH = 4000;
/** Default / maximum page size for `message.history`. */
export const DEFAULT_MESSAGE_HISTORY_LIMIT = 50;
export const MAX_MESSAGE_HISTORY_LIMIT = 200;

/** Roles allowed to mutate channels / send messages (`observer` is read-only). */
export const CHANNEL_WRITE_ROLES: readonly AuthContext['role'][] = ['admin', 'agent'];
/** Roles allowed to read the channel list. */
export const CHANNEL_READ_ROLES: readonly AuthContext['role'][] = ['admin', 'agent', 'observer'];

/**
 * Channel-scoped fan-out hook (wired to `WsGateway.publishEventToAgents` in
 * `app.ts`). Kept as a function so the module never imports the transport and
 * unit tests can observe exactly who would receive a message.
 */
export type ChannelFanout = (event: StoredEvent, agentIds: readonly string[]) => number;

export interface ChannelsModuleOptions {
  /** Connection used to wrap `INSERT + event append` in one transaction. */
  readonly db: AgentMeshDatabase;
  readonly channels: ChannelsDao;
  readonly members: ChannelMembersDao;
  readonly messages: MessagesDao;
  readonly events: EventStore;
  /** Tenant scope; defaults to the event store's workspace. */
  readonly workspaceId?: string;
  /** Live push hook (default: none — nothing is broadcast). */
  readonly fanout?: ChannelFanout;
  /** Id generator (tests inject a deterministic one). */
  readonly idFactory?: (kind: 'channel' | 'message') => string;
  /** Injectable clock for deterministic timestamps. */
  readonly clock?: () => number;
}

/** Wire shape of a channel (always includes the member list). */
export interface ChannelView {
  readonly channelId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly memberCount: number;
  readonly members: string[];
  /** Whether the caller is a member (convenience for clients). */
  readonly joined: boolean;
}

export interface CreateChannelResult {
  readonly channel: ChannelView;
  /** `seq` of the `channel.created` event. */
  readonly seq: number;
}

export interface JoinChannelResult {
  readonly channelId: string;
  readonly agentId: string;
  /** `false` when the agent was already a member (idempotent no-op). */
  readonly joined: boolean;
  readonly joinedAt: number | null;
  readonly memberCount: number;
  /** `seq` of the appended `channel.member.joined` event (absent on no-op). */
  readonly seq?: number;
}

export interface LeaveChannelResult {
  readonly channelId: string;
  readonly agentId: string;
  /** `false` when the agent was not a member (idempotent no-op). */
  readonly left: boolean;
  readonly memberCount: number;
  /** `seq` of the appended `channel.member.left` event (absent on no-op). */
  readonly seq?: number;
}

export interface ChannelListResult {
  readonly channels: ChannelView[];
  readonly total: number;
  readonly limit: number | null;
  readonly offset: number;
}

export interface MessageView {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly body: string;
  /** Global `events.seq` of the `message.created` event that created this row. */
  readonly seq: number;
  readonly createdAt: number;
}

export interface SendMessageResult {
  readonly message: MessageView;
  /** Number of live sockets the `message.new` push reached. */
  readonly delivered: number;
}

export interface MessageHistoryQuery {
  readonly channelId: string;
  /** Exclusive upper bound: only messages with `seq < beforeSeq`. */
  readonly beforeSeq?: number;
  /** Exclusive lower bound: only messages with `seq > afterSeq`. */
  readonly afterSeq?: number;
  /** Page size, 1..MAX_MESSAGE_HISTORY_LIMIT. Default 50. */
  readonly limit?: number;
}

export interface MessageHistoryResult {
  readonly channelId: string;
  /** Oldest-first page. Every message carries its global `seq`. */
  readonly messages: MessageView[];
  /** Total messages in the channel at query time (not the page size). */
  readonly channelTotal: number;
  readonly limit: number;
  readonly nextBeforeSeq: number | null;
  readonly nextAfterSeq: number | null;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
}

function toMessageView(row: {
  id: string;
  channelId: string;
  senderId: string;
  body: string;
  seq: number;
  createdAt: number;
}): MessageView {
  return {
    messageId: row.id,
    channelId: row.channelId,
    senderId: row.senderId,
    body: row.body,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Param validation (structured `-32602` instead of leaking zod messages)
// ---------------------------------------------------------------------------

function invalidParams(message: string, field?: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.InvalidParams,
    `Invalid params: ${message}`,
    field === undefined ? undefined : { field },
  );
}

function asParamsObject(params: unknown, method: string): Record<string, unknown> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw invalidParams(`${method} params must be an object`);
  }
  return params as Record<string, unknown>;
}

function readRequiredString(
  input: Record<string, unknown>,
  field: string,
  maxLength: number,
  { trim = true }: { trim?: boolean } = {},
): string {
  const raw = input[field];
  if (typeof raw !== 'string') {
    throw invalidParams(`${field} must be a string`, field);
  }
  const value = trim ? raw.trim() : raw;
  if (value.length === 0) {
    throw invalidParams(`${field} must not be empty`, field);
  }
  if (value.length > maxLength) {
    throw invalidParams(`${field} must be at most ${maxLength} characters`, field);
  }
  return value;
}

function readOptionalAgentId(input: Record<string, unknown>): string | undefined {
  const raw = input.agentId;
  if (raw === undefined || raw === null) return undefined;
  return readRequiredString(input, 'agentId', 128);
}

function readPagination(input: Record<string, unknown>): { limit?: number; offset: number } {
  const rawLimit = input.limit;
  const rawOffset = input.offset;
  let limit: number | undefined;
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isSafeInteger(rawLimit) || rawLimit <= 0) {
      throw invalidParams('limit must be a positive integer', 'limit');
    }
    limit = rawLimit;
  }
  let offset = 0;
  if (rawOffset !== undefined && rawOffset !== null) {
    if (typeof rawOffset !== 'number' || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      throw invalidParams('offset must be a non-negative integer', 'offset');
    }
    offset = rawOffset;
  }
  return limit === undefined ? { offset } : { limit, offset };
}

function notFoundChannel(channelId: string): ProtocolError {
  return new ProtocolError(JsonRpcErrorCode.NotFound, `Unknown channel: ${channelId}`, {
    channelId,
  });
}

function notAMember(channelId: string): ProtocolError {
  return new ProtocolError(
    JsonRpcErrorCode.Forbidden,
    'Only channel members may access this channel',
    { channelId, reason: 'not_a_member' },
  );
}

function readOptionalSeq(
  input: Record<string, unknown>,
  field: string,
): number | undefined {
  const raw = input[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw invalidParams(`${field} must be a non-negative integer`, field);
  }
  return raw;
}

function readHistoryLimit(input: Record<string, unknown>): number {
  const raw = input.limit;
  if (raw === undefined || raw === null) return DEFAULT_MESSAGE_HISTORY_LIMIT;
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw <= 0 ||
    raw > MAX_MESSAGE_HISTORY_LIMIT
  ) {
    throw invalidParams(
      `limit must be between 1 and ${MAX_MESSAGE_HISTORY_LIMIT}`,
      'limit',
    );
  }
  return raw;
}

/**
 * Build the push frame for a persisted message: a `message.new` notification
 * that reuses the logged event's `seq` (one cursor space for live + replay).
 */
function messageNotificationEvent(
  event: CoreEvent,
  row: {
    readonly id: string;
    readonly channelId: string;
    readonly senderId: string;
    readonly body: string;
    readonly createdAt: number;
  },
  workspaceId: string,
): StoredEvent {
  return {
    seq: event.seq,
    aggregateId: event.aggregateId,
    type: 'message.new',
    version: event.version,
    payload: {
      messageId: row.id,
      channelId: row.channelId,
      senderId: row.senderId,
      content: row.body,
      createdAt: row.createdAt,
      seq: event.seq,
    },
    ts: event.ts,
    prevHash: event.prevHash ?? null,
    workspaceId,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Domain service behind the five RPC handlers (unit-testable on its own). */
export class ChannelsService {
  readonly #db: AgentMeshDatabase;
  readonly #channels: ChannelsDao;
  readonly #members: ChannelMembersDao;
  readonly #messages: MessagesDao;
  readonly #events: EventStore;
  readonly #workspaceId: string;
  readonly #fanout?: ChannelFanout;
  readonly #idFactory: (kind: 'channel' | 'message') => string;
  readonly #clock: () => number;

  constructor(options: ChannelsModuleOptions) {
    this.#db = options.db;
    this.#channels = options.channels;
    this.#members = options.members;
    this.#messages = options.messages;
    this.#events = options.events;
    this.#workspaceId = options.workspaceId ?? 'default';
    this.#idFactory =
      options.idFactory ??
      ((kind) => `${kind === 'channel' ? 'chn' : 'msg'}_${randomUUID()}`);
    this.#clock = options.clock ?? (() => Date.now());
    if (options.fanout !== undefined) this.#fanout = options.fanout;
  }

  // ------------------------------------------------------------------ create

  /**
   * Create a channel and make the creator its first member.
   *
   * One transaction covers the row, the membership edge and both events, so a
   * channel can never exist without its creator in it (nor with an event log
   * that disagrees with the projection).
   */
  create(
    input: { readonly name: string },
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): CreateChannelResult {
    const name = input.name.trim();
    if (name.length === 0) {
      throw invalidParams('name must not be empty', 'name');
    }
    if (name.length > MAX_CHANNEL_NAME_LENGTH) {
      throw invalidParams(
        `name must be at most ${MAX_CHANNEL_NAME_LENGTH} characters`,
        'name',
      );
    }

    const createdAt = this.#clock();
    const channelId = this.#nextId('channel');
    const aggregateId = aggregateIdOf('channel', channelId);

    const created = withTransaction(this.#db, () => {
      const channel = this.#channels.create({
        id: channelId,
        name,
        createdBy: actor.agentId,
        createdAt,
        workspaceId,
      });
      this.#members.add({
        channelId,
        agentId: actor.agentId,
        joinedAt: createdAt,
        workspaceId,
      });
      const createdEvent = this.#events.append({
        aggregateId,
        type: 'channel.created',
        payload: { channelId, name, createdBy: actor.agentId, createdAt },
        ts: createdAt,
        workspaceId,
      });
      // The creator's membership is a fact of the channel's history, not an
      // implicit side effect, so replaying the aggregate rebuilds the same
      // member set the projection holds.
      this.#events.append({
        aggregateId,
        type: 'channel.member.joined',
        payload: { channelId, agentId: actor.agentId, joinedAt: createdAt },
        ts: createdAt,
        workspaceId,
      });
      return { channel, event: createdEvent };
    });

    return {
      channel: this.#view(created.channel.id, actor.agentId, workspaceId),
      seq: created.event.seq,
    };
  }

  // -------------------------------------------------------------------- join

  /**
   * Add `agentId` (default: the caller) to a channel.
   *
   * Joining twice is a no-op: the original `joinedAt` is kept and **no** event
   * is appended, so a retry cannot grow the log or duplicate the membership.
   * Adding somebody else is member management and requires `admin`.
   */
  join(
    input: { readonly channelId: string; readonly agentId?: string },
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): JoinChannelResult {
    const channel = this.#requireChannel(input.channelId, workspaceId);
    const agentId = input.agentId ?? actor.agentId;
    if (agentId !== actor.agentId) {
      requireRole({ auth: actor }, WORKSPACE_ADMIN_ROLES);
    }

    const existing = this.#members.get(channel.id, agentId, channel.workspaceId);
    if (existing !== undefined) {
      return {
        channelId: channel.id,
        agentId,
        joined: false,
        joinedAt: existing.joinedAt,
        memberCount: this.#members.count(channel.id, channel.workspaceId),
      };
    }

    const joinedAt = this.#clock();
    const event = withTransaction(this.#db, () => {
      this.#members.add({
        channelId: channel.id,
        agentId,
        joinedAt,
        workspaceId: channel.workspaceId,
      });
      return this.#events.append({
        aggregateId: aggregateIdOf('channel', channel.id),
        type: 'channel.member.joined',
        payload: { channelId: channel.id, agentId, joinedAt },
        ts: joinedAt,
        workspaceId: channel.workspaceId,
      });
    });

    return {
      channelId: channel.id,
      agentId,
      joined: true,
      joinedAt,
      memberCount: this.#members.count(channel.id, channel.workspaceId),
      seq: event.seq,
    };
  }

  // ------------------------------------------------------------------- leave

  /**
   * Remove `agentId` (default: the caller) from a channel.
   *
   * Leaving when not a member is a no-op (`left: false`, no event). Removing
   * somebody else requires `admin`.
   */
  leave(
    input: { readonly channelId: string; readonly agentId?: string },
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): LeaveChannelResult {
    const channel = this.#requireChannel(input.channelId, workspaceId);
    const agentId = input.agentId ?? actor.agentId;
    if (agentId !== actor.agentId) {
      requireRole({ auth: actor }, WORKSPACE_ADMIN_ROLES);
    }

    const existing = this.#members.get(channel.id, agentId, channel.workspaceId);
    if (existing === undefined) {
      return {
        channelId: channel.id,
        agentId,
        left: false,
        memberCount: this.#members.count(channel.id, channel.workspaceId),
      };
    }

    const leftAt = this.#clock();
    const event = withTransaction(this.#db, () => {
      this.#members.remove(channel.id, agentId, channel.workspaceId);
      return this.#events.append({
        aggregateId: aggregateIdOf('channel', channel.id),
        type: 'channel.member.left',
        payload: { channelId: channel.id, agentId, leftAt },
        ts: leftAt,
        workspaceId: channel.workspaceId,
      });
    });

    return {
      channelId: channel.id,
      agentId,
      left: true,
      memberCount: this.#members.count(channel.id, channel.workspaceId),
      seq: event.seq,
    };
  }

  // -------------------------------------------------------------------- list

  /** Channels of the request workspace, oldest first, each with its members. */
  list(
    query: { readonly limit?: number; readonly offset?: number },
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): ChannelListResult {
    const channels = this.#channels.list({
      workspaceId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    return {
      channels: channels.map((channel) => this.#view(channel.id, actor.agentId, workspaceId)),
      total: this.#channels.count(workspaceId),
      limit: query.limit ?? null,
      offset: query.offset ?? 0,
    };
  }

  // -------------------------------------------------------------------- send

  /**
   * Persist a message and fan it out to the channel's online members.
   *
   * Order matters (see the module docs): the event is appended **inside** the
   * transaction and its global `seq` becomes the message row's `seq`, so the
   * row, the event and the live push all agree on one cursor. The push happens
   * only after the commit, so a rolled-back transaction can never be
   * announced — the append feed ignores `message.created` anyway (domain-only).
   */
  send(
    input: { readonly channelId: string; readonly body: string },
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): SendMessageResult {
    const channel = this.#requireChannel(input.channelId, workspaceId);
    // A non-member must not even learn whether the channel accepts writes:
    // the rejection below is a plain `-32002`, identical to a role rejection.
    if (!this.#members.isMember(channel.id, actor.agentId, channel.workspaceId)) {
      throw notAMember(channel.id);
    }

    const body = input.body;
    if (body.trim().length === 0) {
      throw invalidParams('body must not be empty', 'body');
    }
    if (body.length > MAX_MESSAGE_BODY_LENGTH) {
      throw invalidParams(
        `body must be at most ${MAX_MESSAGE_BODY_LENGTH} characters`,
        'body',
      );
    }

    const createdAt = this.#clock();
    const messageId = this.#nextId('message');

    const persisted = withTransaction(this.#db, () => {
      const event = this.#events.append({
        aggregateId: aggregateIdOf('channel', channel.id),
        type: 'message.created',
        payload: {
          messageId,
          channelId: channel.id,
          senderId: actor.agentId,
          body,
          createdAt,
        },
        ts: createdAt,
        workspaceId: channel.workspaceId,
      });
      // `messages.seq` == the event's global seq (UNIQUE index enforces that
      // this cursor can never be handed out twice).
      const row = this.#messages.create({
        id: messageId,
        channelId: channel.id,
        senderId: actor.agentId,
        seq: event.seq,
        body,
        createdAt,
        workspaceId: channel.workspaceId,
      });
      return { event, row };
    });

    const message: MessageView = {
      messageId: persisted.row.id,
      channelId: persisted.row.channelId,
      senderId: persisted.row.senderId,
      body: persisted.row.body,
      seq: persisted.row.seq,
      createdAt: persisted.row.createdAt,
    };

    let delivered = 0;
    if (this.#fanout !== undefined) {
      const memberIds = this.#members
        .listByChannel(channel.id, channel.workspaceId)
        .map((member) => member.agentId);
      delivered = this.#fanout(
        messageNotificationEvent(persisted.event, persisted.row, channel.workspaceId),
        memberIds,
      );
    }

    return { message, delivered };
  }

  /**
   * Page a channel's durable history by the global `seq` cursor.
   *
   * - `afterSeq` = forward compensation (strictly newer messages);
   * - `beforeSeq` = backward paging (strictly older messages);
   * - neither = newest page, returned oldest-first.
   * The result is always ascending by `seq`. `seq` is the global event cursor,
   * so a client can merge live pushes and this page with one dedupe key.
   */
  history(
    query: MessageHistoryQuery,
    actor: AuthContext,
    workspaceId: string = this.#workspaceId,
  ): MessageHistoryResult {
    const channel = this.#requireChannel(query.channelId, workspaceId);
    if (!this.#members.isMember(channel.id, actor.agentId, channel.workspaceId)) {
      throw notAMember(channel.id);
    }

    const limit = query.limit ?? DEFAULT_MESSAGE_HISTORY_LIMIT;
    const forward = query.afterSeq !== undefined;
    const rows = forward
      ? this.#messages.listByChannel(channel.id, {
          workspaceId: channel.workspaceId,
          afterSeq: query.afterSeq,
          ...(query.beforeSeq === undefined ? {} : { beforeSeq: query.beforeSeq }),
          limit: limit + 1,
        })
      : this.#messages.listByChannel(channel.id, {
          workspaceId: channel.workspaceId,
          ...(query.beforeSeq === undefined ? {} : { beforeSeq: query.beforeSeq }),
          limit: limit + 1,
          order: 'desc',
        });

    const page = forward
      ? rows.slice(0, limit)
      : rows.slice(0, limit).reverse();
    const first = page[0];
    const last = page[page.length - 1];

    const hasMoreBefore = forward
      ? first !== undefined &&
        this.#messages.listByChannel(channel.id, {
          workspaceId: channel.workspaceId,
          beforeSeq: first.seq,
          limit: 1,
        }).length > 0
      : rows.length > limit;
    const hasMoreAfter = forward
      ? rows.length > limit
      : last !== undefined &&
        this.#messages.listByChannel(channel.id, {
          workspaceId: channel.workspaceId,
          afterSeq: last.seq,
          limit: 1,
        }).length > 0;

    return {
      channelId: channel.id,
      messages: page.map(toMessageView),
      channelTotal: this.#messages.count(channel.id, channel.workspaceId),
      limit,
      nextBeforeSeq: first?.seq ?? null,
      nextAfterSeq: last?.seq ?? null,
      hasMoreBefore,
      hasMoreAfter,
    };
  }

  // ---------------------------------------------------------------- internal

  #requireChannel(channelId: string, workspaceId: string = this.#workspaceId) {
    const channel = this.#channels.get(channelId, workspaceId);
    if (channel === undefined) throw notFoundChannel(channelId);
    return channel;
  }

  #view(channelId: string, actorAgentId: string, workspaceId = this.#workspaceId): ChannelView {
    const channel = this.#channels.get(channelId, workspaceId);
    if (channel === undefined) throw notFoundChannel(channelId);
    const members = this.#members
      .listByChannel(channelId, workspaceId)
      .map((member) => member.agentId);
    return {
      channelId: channel.id,
      name: channel.name,
      createdBy: channel.createdBy,
      createdAt: channel.createdAt,
      memberCount: members.length,
      members,
      joined: members.includes(actorAgentId),
    };
  }

  /** Channel ids must be unique; regenerate on the (unlikely) clash. */
  #nextId(kind: 'channel' | 'message'): string {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = this.#idFactory(kind);
      const clash =
        kind === 'channel'
          ? this.#channels.get(id, this.#workspaceId) !== undefined
          : this.#messages.get(id, this.#workspaceId) !== undefined;
      if (!clash) return id;
    }
    throw new Error(`could not allocate a unique ${kind} id`);
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Wire the channel/message methods into `registry`.
 * @returns the service instance (handy for tests and future modules).
 */
export function registerChannelsModule(
  registry: HandlerRegistry,
  options: ChannelsModuleOptions,
): ChannelsService {
  const service = new ChannelsService(options);

  registry.registerHandler(
    METHODS.channel.create,
    async (ctx, params) => {
      const auth = requireRole(ctx, CHANNEL_WRITE_ROLES);
      const input = asParamsObject(params, METHODS.channel.create);
      const name = readRequiredString(input, 'name', MAX_CHANNEL_NAME_LENGTH);
      const result = service.create({ name }, auth, ctx.workspaceId);
      ctx.logger.info({
        channelId: result.channel.channelId,
        agentId: auth.agentId,
        seq: result.seq,
        msg: 'channel.created',
      });
      return result;
    },
    { description: 'Create a channel (creator becomes its first member)' },
  );

  registry.registerHandler(
    METHODS.channel.join,
    async (ctx, params) => {
      const auth = requireRole(ctx, CHANNEL_WRITE_ROLES);
      const input = asParamsObject(params, METHODS.channel.join);
      const channelId = readRequiredString(input, 'channelId', 128);
      const agentId = readOptionalAgentId(input);
      const result = service.join(
        agentId === undefined ? { channelId } : { channelId, agentId },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        channelId: result.channelId,
        agentId: result.agentId,
        joined: result.joined,
        msg: 'channel.joined',
      });
      return result;
    },
    { description: 'Join a channel (idempotent; admin may add another agent)' },
  );

  registry.registerHandler(
    METHODS.channel.leave,
    async (ctx, params) => {
      const auth = requireRole(ctx, CHANNEL_WRITE_ROLES);
      const input = asParamsObject(params, METHODS.channel.leave);
      const channelId = readRequiredString(input, 'channelId', 128);
      const agentId = readOptionalAgentId(input);
      const result = service.leave(
        agentId === undefined ? { channelId } : { channelId, agentId },
        auth,
        ctx.workspaceId,
      );
      ctx.logger.info({
        channelId: result.channelId,
        agentId: result.agentId,
        left: result.left,
        msg: 'channel.left',
      });
      return result;
    },
    { description: 'Leave a channel (idempotent; admin may remove another agent)' },
  );

  registry.registerHandler(
    METHODS.channel.list,
    async (ctx, params) => {
      const auth = requireRole(ctx, CHANNEL_READ_ROLES);
      const input = asParamsObject(params, METHODS.channel.list);
      const { limit, offset } = readPagination(input);
      return service.list(
        {
          ...(limit === undefined ? {} : { limit }),
          offset,
        },
        auth,
        ctx.workspaceId,
      );
    },
    { description: 'List channels of the workspace with their members' },
  );

  registry.registerHandler(
    METHODS.message.send,
    async (ctx, params) => {
      const auth = requireRole(ctx, CHANNEL_WRITE_ROLES);
      const input = asParamsObject(params, METHODS.message.send);
      const channelId = readRequiredString(input, 'channelId', 128);
      const body = readRequiredString(input, 'body', MAX_MESSAGE_BODY_LENGTH, {
        trim: false,
      });
      const result = service.send({ channelId, body }, auth, ctx.workspaceId);
      ctx.logger.info({
        channelId,
        messageId: result.message.messageId,
        agentId: auth.agentId,
        seq: result.message.seq,
        delivered: result.delivered,
        msg: 'message.sent',
      });
      return result;
    },
    { description: 'Send a message to a channel you are a member of' },
  );

  registry.registerHandler(
    METHODS.message.history,
    async (ctx, params) => {
      const auth = requireRole(ctx, CHANNEL_READ_ROLES);
      const input = asParamsObject(params, METHODS.message.history);
      const channelId = readRequiredString(input, 'channelId', 128);
      const beforeSeq = readOptionalSeq(input, 'beforeSeq');
      const afterSeq = readOptionalSeq(input, 'afterSeq');
      const limit = readHistoryLimit(input);
      return service.history(
        {
          channelId,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(afterSeq === undefined ? {} : { afterSeq }),
          limit,
        },
        auth,
        ctx.workspaceId,
      );
    },
    { description: 'Page channel history by global seq (members only)' },
  );

  return service;
}
