/**
 * Integration tests for the US-007 channel/message module.
 *
 * Two layers:
 *
 * 1. `ChannelsService` behind the real dispatcher + real SQLite (`:memory:`):
 *    params validation, authorization codes, idempotency, the event log and —
 *    the contract this story exists for — `messages.seq == events.seq`.
 * 2. A real HTTP + WebSocket server (`startServer`) proving that a message
 *    reaches the **online members** of the channel and nobody else.
 */

import { channelReducer, EventStore, initialChannelState } from '@agentmesh/core';
import type { ChannelState } from '@agentmesh/core';
import { JsonRpcErrorCode, METHODS } from '@agentmesh/protocol';
import { openStore, type Repositories } from '@agentmesh/store';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer, type ServerStore } from '../src/app.js';
import { createTokenService, type TokenService } from '../src/auth/token.js';
import type { DispatchContext, DispatchOutcome } from '../src/dispatcher.js';
import { RpcDispatcher } from '../src/dispatcher.js';
import { registerAccountsModule } from '../src/modules/accounts.js';
import { ChannelsService, registerChannelsModule } from '../src/modules/channels.js';
import { createHandlerRegistry } from '../src/registry.js';
import { startServer } from '../src/index.js';
import { silentLogger, testConfig } from './helpers.js';

const SECRET = 'test-secret-value-1234567890';
const CLOCK = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FanoutCall {
  type: string;
  seq: number;
  agentIds: string[];
}

interface Harness {
  db: ServerStore['db'];
  repos: Repositories;
  events: EventStore;
  tokens: TokenService;
  service: ChannelsService;
  fanoutCalls: FanoutCall[];
  call: (method: string, params?: unknown, ctx?: DispatchContext) => Promise<DispatchOutcome>;
  register: (name: string, role?: 'admin' | 'agent' | 'observer') => Promise<{
    agentId: string;
    token: string;
    role: string;
  }>;
}

function makeHarness(): Harness {
  const { db, repos } = openStore(':memory:');
  const now = CLOCK;
  const events = new EventStore(db, { clock: () => now });
  const tokens = createTokenService({ secret: SECRET, clock: () => now });
  const registry = createHandlerRegistry();
  const fanoutCalls: FanoutCall[] = [];
  let counter = 0;
  const nextId = (kind: 'channel' | 'message'): string => {
    counter += 1;
    return `${kind === 'channel' ? 'chn' : 'msg'}_${counter}`;
  };

  registerAccountsModule(registry, {
    db,
    accounts: repos.accounts,
    events,
    tokens,
    allowAdminSelfRegister: true,
    idFactory: () => {
      counter += 1;
      return `agt_${counter}`;
    },
    clock: () => now,
  });

  const service = registerChannelsModule(registry, {
    db,
    channels: repos.channels,
    members: repos.channelMembers,
    messages: repos.messages,
    events,
    idFactory: nextId,
    clock: () => now,
    fanout: (event, agentIds) => {
      fanoutCalls.push({
        type: event.type,
        seq: event.seq,
        agentIds: [...agentIds],
      });
      return agentIds.length;
    },
  });

  const dispatcher = new RpcDispatcher({
    registry,
    logger: silentLogger(),
    tokenVerifier: (token) => tokens.verify(token),
  });

  const call: Harness['call'] = (method, params = {}, ctx = {}) =>
    dispatcher.dispatch({ jsonrpc: '2.0', id: 1, method, params }, ctx);

  return {
    db,
    repos,
    events,
    tokens,
    service,
    fanoutCalls,
    call,
    register: async (name, role = 'agent') => {
      const registerOutcome = await call(METHODS.agent.register, {
        name,
        ...(role === 'agent' ? {} : { role }),
      });
      return resultOf<{ agentId: string; token: string; role: string }>(registerOutcome);
    },
  };
}

function resultOf<T>(outcome: DispatchOutcome): T {
  expect(outcome.response?.error).toBeUndefined();
  return outcome.response?.result as T;
}

function errorOf(outcome: DispatchOutcome): {
  code: number;
  message: string;
  data?: Record<string, unknown>;
} {
  const error = outcome.response?.error;
  expect(error).toBeDefined();
  return error as { code: number; message: string; data?: Record<string, unknown> };
}

function replayChannel(h: Harness, channelId: string): ChannelState {
  const aggregateId = `channel:${channelId}`;
  return h.events
    .loadAggregate(aggregateId)
    .reduce(channelReducer, initialChannelState(aggregateId));
}

interface ChannelResult {
  channel: {
    channelId: string;
    name: string;
    createdBy: string | null;
    createdAt: number;
    memberCount: number;
    members: string[];
    joined: boolean;
  };
  seq: number;
}

interface JoinResult {
  channelId: string;
  agentId: string;
  joined: boolean;
  joinedAt: number | null;
  memberCount: number;
  seq?: number;
}

interface LeaveResult {
  channelId: string;
  agentId: string;
  left: boolean;
  memberCount: number;
  seq?: number;
}

interface ListResult {
  channels: ChannelResult['channel'][];
  total: number;
  limit: number | null;
  offset: number;
}

interface MessageResult {
  message: {
    messageId: string;
    channelId: string;
    senderId: string;
    body: string;
    seq: number;
    createdAt: number;
  };
  delivered: number;
}

interface HistoryResult {
  channelId: string;
  messages: MessageResult['message'][];
  total: number;
  limit: number;
  nextBeforeSeq: number | null;
  nextAfterSeq: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// ---------------------------------------------------------------------------
// channel.create
// ---------------------------------------------------------------------------

describe('channel.create', () => {
  it('creates the channel, makes the creator a member and appends both events', async () => {
    const h = makeHarness();
    const alice = await h.register('alice');
    const ctx = { token: alice.token };

    const result = resultOf<ChannelResult>(
      await h.call(METHODS.channel.create, { name: '  general  ' }, ctx),
    );

    expect(result.channel.name).toBe('general');
    expect(result.channel.createdBy).toBe(alice.agentId);
    expect(result.channel.memberCount).toBe(1);
    expect(result.channel.members).toEqual([alice.agentId]);
    expect(result.channel.joined).toBe(true);

    // Projection: the row exists in the request workspace with that name.
    const stored = h.repos.channels.get(result.channel.channelId, 'default');
    expect(stored?.name).toBe('general');
    expect(h.repos.channelMembers.isMember(result.channel.channelId, alice.agentId)).toBe(true);

    // Event log: channel.created (with its seq returned) + the creator's join.
    const log = h.events.loadAggregate(`channel:${result.channel.channelId}`);
    expect(log.map((event) => event.type)).toEqual([
      'channel.created',
      'channel.member.joined',
    ]);
    expect(log[0]?.seq).toBe(result.seq);
    expect(log[0]?.payload).toMatchObject({
      channelId: result.channel.channelId,
      name: 'general',
      createdBy: alice.agentId,
    });
    expect(log[0]?.version).toBe(1);
    expect(log[1]?.version).toBe(2);

    // Replaying the aggregate rebuilds the same membership the table holds.
    expect(replayChannel(h, result.channel.channelId)).toMatchObject({
      exists: true,
      name: 'general',
      createdBy: alice.agentId,
      members: { [alice.agentId]: { agentId: alice.agentId } },
    });
  });

  it('requires authentication (-32001) and a non-empty name (-32602)', async () => {
    const h = makeHarness();
    expect(errorOf(await h.call(METHODS.channel.create, { name: 'x' })).code).toBe(
      JsonRpcErrorCode.Unauthorized,
    );

    const alice = await h.register('alice');
    // `agent.register` itself appends one account event; only channel facts
    // are asserted below.
    const eventsBefore = h.events.count();
    const blank = errorOf(await h.call(METHODS.channel.create, { name: '   ' }, { token: alice.token }));
    expect(blank.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(blank.data?.field).toBe('name');

    const longName = errorOf(
      await h.call(METHODS.channel.create, { name: 'n'.repeat(65) }, { token: alice.token }),
    );
    expect(longName.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(h.repos.channels.count()).toBe(0);
    expect(h.events.count()).toBe(eventsBefore);
  });

  it('rejects observers (read-only role) with -32002', async () => {
    const h = makeHarness();
    const watcher = await h.register('watcher', 'observer');
    const error = errorOf(
      await h.call(METHODS.channel.create, { name: 'general' }, { token: watcher.token }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data).toMatchObject({ role: 'observer' });
  });
});

// ---------------------------------------------------------------------------
// channel.join / channel.leave
// ---------------------------------------------------------------------------

describe('channel.join and channel.leave', () => {
  it('adds a second member, is idempotent and keeps one event per real join', async () => {
    const h = makeHarness();
    const alice = await h.register('alice');
    const bob = await h.register('bob');
    const created = resultOf<ChannelResult>(
      await h.call(METHODS.channel.create, { name: 'general' }, { token: alice.token }),
    );
    const channelId = created.channel.channelId;

    const joined = resultOf<JoinResult>(
      await h.call(METHODS.channel.join, { channelId }, { token: bob.token }),
    );
    expect(joined).toMatchObject({ channelId, agentId: bob.agentId, joined: true, memberCount: 2 });
    expect(typeof joined.seq).toBe('number');

    const again = resultOf<JoinResult>(
      await h.call(METHODS.channel.join, { channelId }, { token: bob.token }),
    );
    expect(again).toMatchObject({ joined: false, memberCount: 2, joinedAt: joined.joinedAt });
    expect(again.seq).toBeUndefined();

    // Exactly one join event for bob (the creator's is separate).
    const joins = h.events
      .loadAggregate(`channel:${channelId}`)
      .filter((event) => event.type === 'channel.member.joined');
    expect(joins).toHaveLength(2);
    expect(joins[1]?.seq).toBe(joined.seq);

    // List reflects both members, in join order.
    const listed = resultOf<ListResult>(
      await h.call(METHODS.channel.list, {}, { token: bob.token }),
    );
    expect(listed.total).toBe(1);
    expect(listed.channels[0]?.members).toEqual([alice.agentId, bob.agentId]);
    expect(listed.channels[0]?.memberCount).toBe(2);
    expect(listed.channels[0]?.joined).toBe(true);
  });

  it('leave removes membership, is idempotent and appends channel.member.left', async () => {
    const h = makeHarness();
    const alice = await h.register('alice');
    const bob = await h.register('bob');
    const created = resultOf<ChannelResult>(
      await h.call(METHODS.channel.create, { name: 'general' }, { token: alice.token }),
    );
    const channelId = created.channel.channelId;
    await h.call(METHODS.channel.join, { channelId }, { token: bob.token });

    const left = resultOf<LeaveResult>(
      await h.call(METHODS.channel.leave, { channelId }, { token: bob.token }),
    );
    expect(left).toMatchObject({ left: true, memberCount: 1, agentId: bob.agentId });
    expect(typeof left.seq).toBe('number');
    expect(h.repos.channelMembers.isMember(channelId, bob.agentId)).toBe(false);

    const again = resultOf<LeaveResult>(
      await h.call(METHODS.channel.leave, { channelId }, { token: bob.token }),
    );
    expect(again.left).toBe(false);
    expect(again.seq).toBeUndefined();

    const leftEvents = h.events
      .loadAggregate(`channel:${channelId}`)
      .filter((event) => event.type === 'channel.member.left');
    expect(leftEvents).toHaveLength(1);
    expect(leftEvents[0]?.seq).toBe(left.seq);
    expect(leftEvents[0]?.payload).toMatchObject({ agentId: bob.agentId });

    // Replay agrees: bob is gone, alice remains.
    const state = replayChannel(h, channelId);
    expect(Object.keys(state.members)).toEqual([alice.agentId]);
  });

  it('lets an admin manage another agent but rejects a plain member doing so', async () => {
    const h = makeHarness();
    const admin = await h.register('root', 'admin');
    const alice = await h.register('alice');
    const bob = await h.register('bob');
    const created = resultOf<ChannelResult>(
      await h.call(METHODS.channel.create, { name: 'ops' }, { token: admin.token }),
    );
    const channelId = created.channel.channelId;

    const byMember = errorOf(
      await h.call(METHODS.channel.join, { channelId, agentId: bob.agentId }, { token: alice.token }),
    );
    expect(byMember.code).toBe(JsonRpcErrorCode.Forbidden);

    const added = resultOf<JoinResult>(
      await h.call(METHODS.channel.join, { channelId, agentId: bob.agentId }, { token: admin.token }),
    );
    expect(added).toMatchObject({ agentId: bob.agentId, joined: true, memberCount: 2 });

    const removed = resultOf<LeaveResult>(
      await h.call(METHODS.channel.leave, { channelId, agentId: bob.agentId }, { token: admin.token }),
    );
    expect(removed).toMatchObject({ agentId: bob.agentId, left: true, memberCount: 1 });
  });

  it('rejects unknown channels with -32004 and missing channelId with -32602', async () => {
    const h = makeHarness();
    const alice = await h.register('alice');
    const ctx = { token: alice.token };

    const notFound = errorOf(await h.call(METHODS.channel.join, { channelId: 'chn_nope' }, ctx));
    expect(notFound.code).toBe(JsonRpcErrorCode.NotFound);
    expect(notFound.data?.channelId).toBe('chn_nope');

    const missing = errorOf(await h.call(METHODS.channel.join, {}, ctx));
    expect(missing.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(missing.data?.field).toBe('channelId');

    expect(errorOf(await h.call(METHODS.channel.leave, { channelId: 'chn_nope' }, ctx)).code).toBe(
      JsonRpcErrorCode.NotFound,
    );
  });

  it('lists only the workspace of the caller', async () => {
    const h = makeHarness();
    const alice = await h.register('alice');
    await h.call(METHODS.channel.create, { name: 'default-only' }, { token: alice.token });

    const own = resultOf<ListResult>(
      await h.call(METHODS.channel.list, {}, { token: alice.token }),
    );
    expect(own.total).toBe(1);

    // A verified token pins the tenant (the dispatcher ignores a spoofed
    // `workspaceId` header), so cross-tenant reads are asserted on the service
    // directly: another workspace sees nothing.
    const other = h.service.list({}, { agentId: alice.agentId, role: 'agent' }, 'ws-2');
    expect(other.total).toBe(0);
    expect(other.channels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// message.send
// ---------------------------------------------------------------------------

describe('message.send', () => {
  async function setup() {
    const h = makeHarness();
    const alice = await h.register('alice');
    const bob = await h.register('bob');
    const created = resultOf<ChannelResult>(
      await h.call(METHODS.channel.create, { name: 'general' }, { token: alice.token }),
    );
    return { h, alice, bob, channelId: created.channel.channelId };
  }

  it('persists the message with the event seq and logs message.created', async () => {
    const { h, alice, channelId } = await setup();
    const before = h.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as {
      seq: number;
    };

    const result = resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body: 'hello world' }, { token: alice.token }),
    );

    expect(result.message).toMatchObject({
      channelId,
      senderId: alice.agentId,
      body: 'hello world',
    });
    expect(result.message.seq).toBeGreaterThan(before.seq);

    // Projection row: same seq, same body.
    const row = h.repos.messages.get(result.message.messageId, 'default');
    expect(row).toMatchObject({
      channelId,
      senderId: alice.agentId,
      seq: result.message.seq,
      body: 'hello world',
    });

    // Event log: `message.created` on the channel aggregate with that seq.
    const event = h.events.readFrom(1).find((candidate) => candidate.seq === result.message.seq);
    expect(event?.type).toBe('message.created');
    expect(event?.aggregateId).toBe(`channel:${channelId}`);
    expect(event?.payload).toMatchObject({
      messageId: result.message.messageId,
      channelId,
      senderId: alice.agentId,
      body: 'hello world',
    });
    expect(h.events.head()).toBe(result.message.seq);

    // The push is a `message.new` notification reusing the same seq.
    expect(h.fanoutCalls).toHaveLength(1);
    expect(h.fanoutCalls[0]).toMatchObject({
      type: 'message.new',
      seq: result.message.seq,
      agentIds: [alice.agentId],
    });
  });

  it('assigns a distinct global seq per message (no duplicates)', async () => {
    const { h, alice, channelId } = await setup();
    const first = resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body: 'one' }, { token: alice.token }),
    );
    const second = resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body: 'two' }, { token: alice.token }),
    );
    const third = resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body: 'three' }, { token: alice.token }),
    );

    const seqs = [first, second, third].map((entry) => entry.message.seq);
    expect(new Set(seqs).size).toBe(3);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // Every persisted row agrees with its event, and the UNIQUE index holds.
    const rows = h.repos.messages.listByChannel(channelId);
    expect(rows.map((row) => row.seq)).toEqual(seqs);
    expect(rows.map((row) => row.body)).toEqual(['one', 'two', 'three']);
    const eventSeqs = new Set(h.events.readFrom(1).map((event) => event.seq));
    for (const seq of seqs) expect(eventSeqs.has(seq)).toBe(true);
  });

  it('rejects a non-member with -32002 and writes nothing', async () => {
    const { h, bob, channelId } = await setup();
    const eventsBefore = h.events.count();

    const error = errorOf(
      await h.call(METHODS.message.send, { channelId, body: 'intrusion' }, { token: bob.token }),
    );
    expect(error.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(error.data).toMatchObject({ channelId, reason: 'not_a_member' });
    expect(h.repos.messages.count(channelId)).toBe(0);
    expect(h.events.count()).toBe(eventsBefore);
    expect(h.fanoutCalls).toEqual([]);
  });

  it('rejects an unauthenticated sender with -32001', async () => {
    const { h, channelId } = await setup();
    const error = errorOf(await h.call(METHODS.message.send, { channelId, body: 'anon' }));
    expect(error.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(h.repos.messages.count(channelId)).toBe(0);
  });

  it('rejects observers, unknown channels and invalid bodies', async () => {
    const { h, alice, channelId } = await setup();
    const watcher = await h.register('watcher', 'observer');

    expect(
      errorOf(await h.call(METHODS.message.send, { channelId, body: 'hi' }, { token: watcher.token }))
        .code,
    ).toBe(JsonRpcErrorCode.Forbidden);

    expect(
      errorOf(await h.call(METHODS.message.send, { channelId: 'chn_nope', body: 'hi' }, { token: alice.token }))
        .code,
    ).toBe(JsonRpcErrorCode.NotFound);

    const blank = errorOf(
      await h.call(METHODS.message.send, { channelId, body: '   ' }, { token: alice.token }),
    );
    expect(blank.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(blank.data?.field).toBe('body');

    const tooLong = errorOf(
      await h.call(
        METHODS.message.send,
        { channelId, body: 'x'.repeat(4001) },
        { token: alice.token },
      ),
    );
    expect(tooLong.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(h.repos.messages.count(channelId)).toBe(0);
    expect(h.fanoutCalls).toEqual([]);
  });

  it('fans out only to current members (join then leave changes the audience)', async () => {
    const { h, alice, bob, channelId } = await setup();
    await h.call(METHODS.channel.join, { channelId }, { token: bob.token });

    resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body: 'hi all' }, { token: alice.token }),
    );
    expect(h.fanoutCalls.at(-1)?.agentIds).toEqual([alice.agentId, bob.agentId]);

    await h.call(METHODS.channel.leave, { channelId }, { token: bob.token });
    const after = resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body: 'just us' }, { token: alice.token }),
    );
    expect(h.fanoutCalls.at(-1)?.agentIds).toEqual([alice.agentId]);
    expect(after.delivered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('module wiring', () => {
  it('decorates app.channels and exposes the method set when a store is wired', () => {
    const { db, repos } = openStore(':memory:');
    const app = buildServer({ config: testConfig(), logger: silentLogger(), store: { db, repos } });
    apps.push(app);

    expect(app.channels).toBeInstanceOf(ChannelsService);
    expect(app.registry.listMethods()).toEqual(
      expect.arrayContaining([
        METHODS.channel.create,
        METHODS.channel.join,
        METHODS.channel.leave,
        METHODS.channel.list,
        METHODS.message.send,
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Live push over a real WebSocket (members only)
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Frame {
  type?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: {
    agentId?: string;
    token?: string;
    channel?: { channelId?: string };
    message?: { messageId?: string; seq?: number; body?: string };
  };
  error?: { code: number; message: string; data?: Record<string, unknown> };
}

class Client {
  readonly frames: Frame[] = [];
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)) as Frame);
    });
    // `terminate()` surfaces as close; never leave an `error` unhandled.
    socket.on('error', () => undefined);
  }

  static async open(url: string, token?: string): Promise<Client> {
    const socket = new WebSocket(url, {
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(err));
    });
    return client;
  }

  send(frame: unknown): void {
    this.#socket.send(JSON.stringify(frame));
  }

  async request(method: string, params: unknown, id: unknown): Promise<Frame> {
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.waitFor((frame) => frame.id === id);
  }

  async waitFor(predicate: (frame: Frame) => boolean, label = 'frame'): Promise<Frame> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}; got ${JSON.stringify(this.frames)}`);
      }
      await delay(10);
    }
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    await new Promise<void>((resolve) => this.#socket.once('close', () => resolve()));
  }
}

describe('message broadcast over websocket', () => {
  it('pushes message.new to online members only', async () => {
    const app = await startServer({
      config: testConfig({ port: 0, host: '127.0.0.1' }),
      logger: silentLogger(),
    });
    apps.push(app);
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const wsUrl = `ws://127.0.0.1:${port}${app.config.wsPath}`;

    // Two identities over HTTP RPC: alice (member) and bob (not yet a member).
    const rpc = async (method: string, params: unknown, token?: string): Promise<Frame> => {
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await response.json()) as Frame;
    };

    const alice = (await rpc(METHODS.agent.register, { name: 'ws-alice' })).result;
    const bob = (await rpc(METHODS.agent.register, { name: 'ws-bob' })).result;
    if (alice?.token === undefined || bob?.token === undefined) {
      throw new Error('registration failed');
    }
    const created = await rpc(METHODS.channel.create, { name: 'live' }, alice.token);
    const channelId = created.result?.channel?.channelId;
    if (channelId === undefined) throw new Error('channel.create failed');

    const aliceSocket = await Client.open(wsUrl, alice.token);
    const bobSocket = await Client.open(wsUrl, bob.token);
    await aliceSocket.waitFor((frame) => frame.type === 'welcome', 'alice welcome');
    await bobSocket.waitFor((frame) => frame.type === 'welcome', 'bob welcome');

    // Alice is the creator/member: she must receive her own message.
    const sent = await aliceSocket.request(
      METHODS.message.send,
      { channelId, body: 'members only' },
      1,
    );
    expect(sent.error).toBeUndefined();

    const pushed = await aliceSocket.waitFor(
      (frame) => frame.method === 'message.new',
      'message.new for alice',
    );
    expect(pushed.params).toMatchObject({
      payload: { channelId, senderId: alice.agentId, content: 'members only' },
    });
    expect(pushed.params?.seq).toBe(sent.result?.message?.seq);

    // Bob is not a member: nothing may reach his socket.
    await delay(200);
    expect(bobSocket.frames.filter((frame) => frame.method === 'message.new')).toHaveLength(0);

    // Once Bob joins he is a member and the next message reaches him.
    expect((await rpc(METHODS.channel.join, { channelId }, bob.token)).error).toBeUndefined();
    const second = await aliceSocket.request(
      METHODS.message.send,
      { channelId, body: 'now with bob' },
      2,
    );
    expect(second.error).toBeUndefined();
    const bobPushed = await bobSocket.waitFor(
      (frame) => frame.method === 'message.new',
      'message.new for bob',
    );
    expect(bobPushed.params).toMatchObject({ payload: { content: 'now with bob' } });

    await aliceSocket.close();
    await bobSocket.close();
  });
});

// ---------------------------------------------------------------------------
// message.history (US-010)
// ---------------------------------------------------------------------------

describe('message.history', () => {
  async function setup(
    h: Harness,
    name = 'history',
  ): Promise<{ owner: { agentId: string; token: string }; channelId: string }> {
    const owner = await h.register(`${name}-owner`);
    const created = resultOf<ChannelResult>(
      await h.call(METHODS.channel.create, { name }, { token: owner.token }),
    );
    return { owner, channelId: created.channel.channelId };
  }

  async function send(
    h: Harness,
    token: string,
    channelId: string,
    body: string,
  ): Promise<MessageResult['message']> {
    return resultOf<MessageResult>(
      await h.call(METHODS.message.send, { channelId, body }, { token }),
    ).message;
  }

  it('returns an empty page for a fresh channel', async () => {
    const h = makeHarness();
    const { owner, channelId } = await setup(h);

    const page = resultOf<HistoryResult>(
      await h.call(METHODS.message.history, { channelId }, { token: owner.token }),
    );
    expect(page).toMatchObject({
      channelId,
      messages: [],
      total: 0,
      nextBeforeSeq: null,
      nextAfterSeq: null,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it('returns the newest page oldest-first with global seq cursors', async () => {
    const h = makeHarness();
    const { owner, channelId } = await setup(h);
    const sent = [];
    for (let i = 1; i <= 5; i += 1) {
      sent.push(await send(h, owner.token, channelId, `m${i}`));
    }

    const page = resultOf<HistoryResult>(
      await h.call(
        METHODS.message.history,
        { channelId, limit: 2 },
        { token: owner.token },
      ),
    );

    expect(page.messages.map((message) => message.body)).toEqual(['m4', 'm5']);
    expect(page.messages.map((message) => message.seq)).toEqual([
      sent[3]?.seq,
      sent[4]?.seq,
    ]);
    expect(page.total).toBe(5);
    expect(page.limit).toBe(2);
    expect(page.nextBeforeSeq).toBe(sent[3]?.seq);
    expect(page.nextAfterSeq).toBe(sent[4]?.seq);
    expect(page.hasMoreBefore).toBe(true);
    expect(page.hasMoreAfter).toBe(false);
  });

  it('pages backwards with beforeSeq without gaps or duplicates', async () => {
    const h = makeHarness();
    const { owner, channelId } = await setup(h);
    const sent = [];
    for (let i = 1; i <= 5; i += 1) {
      sent.push(await send(h, owner.token, channelId, `m${i}`));
    }

    const collected: number[] = [];
    let beforeSeq: number | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = resultOf<HistoryResult>(
        await h.call(
          METHODS.message.history,
          {
            channelId,
            limit: 2,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
          },
          { token: owner.token },
        ),
      );
      collected.unshift(...page.messages.map((message) => message.seq));
      if (!page.hasMoreBefore || page.nextBeforeSeq === null) break;
      beforeSeq = page.nextBeforeSeq;
    }

    expect(collected).toEqual(sent.map((message) => message.seq));
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('compensates forward with afterSeq (offline catch-up)', async () => {
    const h = makeHarness();
    const { owner, channelId } = await setup(h);
    await send(h, owner.token, channelId, 'before-1');
    await send(h, owner.token, channelId, 'before-2');
    const cutoff = (await send(h, owner.token, channelId, 'cutoff')).seq;

    const missed = [
      await send(h, owner.token, channelId, 'missed-1'),
      await send(h, owner.token, channelId, 'missed-2'),
    ];

    const page = resultOf<HistoryResult>(
      await h.call(
        METHODS.message.history,
        { channelId, afterSeq: cutoff, limit: 10 },
        { token: owner.token },
      ),
    );
    expect(page.messages.map((message) => message.body)).toEqual([
      'missed-1',
      'missed-2',
    ]);
    expect(page.messages.map((message) => message.seq)).toEqual(
      missed.map((message) => message.seq),
    );
    expect(page.hasMoreAfter).toBe(false);

    const firstOnly = resultOf<HistoryResult>(
      await h.call(
        METHODS.message.history,
        { channelId, afterSeq: cutoff, limit: 1 },
        { token: owner.token },
      ),
    );
    expect(firstOnly.messages).toHaveLength(1);
    expect(firstOnly.hasMoreAfter).toBe(true);
    expect(firstOnly.nextAfterSeq).toBe(missed[0]?.seq);
  });

  it('returns history seq in the same global space as the event log', async () => {
    const h = makeHarness();
    const { owner, channelId } = await setup(h);
    const message = await send(h, owner.token, channelId, 'seq check');

    const page = resultOf<HistoryResult>(
      await h.call(METHODS.message.history, { channelId }, { token: owner.token }),
    );
    const created = h.events
      .loadAggregate(`channel:${channelId}`)
      .find((event) => event.type === 'message.created');
    expect(page.messages[0]?.seq).toBe(message.seq);
    expect(page.messages[0]?.seq).toBe(created?.seq);
  });

  it('rejects non-members with -32002 and unknown channels with -32004', async () => {
    const h = makeHarness();
    const { channelId } = await setup(h);
    const outsider = await h.register('history-outsider');

    const forbidden = errorOf(
      await h.call(
        METHODS.message.history,
        { channelId },
        { token: outsider.token },
      ),
    );
    expect(forbidden.code).toBe(JsonRpcErrorCode.Forbidden);
    expect(forbidden.data).toMatchObject({ reason: 'not_a_member' });

    const missing = errorOf(
      await h.call(
        METHODS.message.history,
        { channelId: 'chn_missing' },
        { token: outsider.token },
      ),
    );
    expect(missing.code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('validates cursor and limit params with -32602', async () => {
    const h = makeHarness();
    const { owner, channelId } = await setup(h);

    for (const params of [
      { channelId, beforeSeq: -1 },
      { channelId, afterSeq: 1.5 },
      { channelId, limit: 0 },
      { channelId, limit: 201 },
      { channelId, limit: '10' },
    ]) {
      const error = errorOf(
        await h.call(METHODS.message.history, params, { token: owner.token }),
      );
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    }
  });
});
