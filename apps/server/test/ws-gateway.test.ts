/**
 * Integration tests for the US-006 WebSocket gateway.
 *
 * Everything here runs against a **real** Fastify HTTP server listening on an
 * ephemeral port (127.0.0.1:0) with the real `ws` upgrade plumbing, the real
 * dispatcher, the real SQLite event log and real JWTs. The client side is the
 * `ws` package — the same stack a third-party client would use — so these
 * tests cover the wire contract, not internal method calls.
 *
 * Covered:
 * - Bearer handshake → `welcome {epoch, seq, protocolVersion}`;
 * - JSON-RPC id correlation (requests answered, notifications silent);
 * - protocol ping/pong + native heartbeat (responsive socket survives, silent
 *   socket is terminated);
 * - presence online/offline broadcasts;
 * - live push: an appended notification event reaches every authenticated
 *   socket with its global `seq`, domain-only events stay off the wire, the
 *   per-socket dedupe refuses a second delivery and anonymous sockets get
 *   nothing;
 * - resume: ascending gap replay, per-socket dedupe, epoch match/mismatch,
 *   missing `lastSeenEpoch` compatibility, `gap_too_large` window overflow;
 * - soft rate limiting (`-32005`, socket stays open and recovers) at both the
 *   connection and the agent scope;
 * - bad token (`-32001`, socket closed) and unauthenticated protected calls.
 */

import { JsonRpcErrorCode, METHODS, PROTOCOL_VERSION } from '@agentmesh/protocol';
import type { EventsDao } from '@agentmesh/store';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createHandlerRegistry } from '../src/registry.js';
import { startServer } from '../src/index.js';
import { WS_CLOSE_UNAUTHORIZED, type WsGateway, type WsGatewayOptions } from '../src/ws/gateway.js';
import { silentLogger, testConfig } from './helpers.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface RpcError {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

interface Frame {
  type?: string;
  id?: unknown;
  method?: string;
  params?: { seq?: number; agentId?: string; status?: string } & Record<string, unknown>;
  result?: unknown;
  error?: RpcError;
  epoch?: string;
  seq?: number;
  detail?: string;
  [key: string]: unknown;
}

/** Thin test client: records every frame and every native ping. */
class TestClient {
  readonly frames: Frame[] = [];
  pings = 0;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    this.closed = new Promise((resolve) => {
      socket.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)) as Frame);
    });
    socket.on('ping', () => {
      this.pings += 1;
    });
    // `terminate()` surfaces as close, but never leave an `error` unhandled.
    socket.on('error', () => undefined);
  }

  static async open(url: string, options: WebSocket.ClientOptions = {}): Promise<TestClient> {
    const socket = new WebSocket(url, options);
    // Attach listeners *before* `open`: the server may write the very first
    // frame (e.g. -32001) before the `open` promise resolves.
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(err));
      // `ws` reports a non-101 upgrade here; without this listener the open
      // promise would hang until the test timeout.
      socket.once('unexpected-response', (_request, response) => {
        const status = (response as { statusCode?: number }).statusCode ?? 0;
        socket.terminate();
        reject(new Error(`unexpected server response: ${status}`));
      });
    });
    return client;
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(frame: unknown): void {
    this.#socket.send(JSON.stringify(frame));
  }

  async request(method: string, params: unknown, id: unknown): Promise<Frame> {
    this.send({ jsonrpc: '2.0', id, method, params });
    return this.waitFor((frame) => frame.id === id);
  }

  framesOf(predicate: (frame: Frame) => boolean): Frame[] {
    return this.frames.filter(predicate);
  }

  /** Poll for the first matching frame (frames are ordered, but may race). */
  async waitFor(
    predicate: (frame: Frame) => boolean,
    { label = 'frame', timeoutMs = 3000 }: { label?: string; timeoutMs?: number } = {},
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.find(predicate);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}; got: ${JSON.stringify(this.frames)}`);
      }
      await delay(10);
    }
  }

  /** Poll until a condition over the recorded frames/events is true. */
  async waitUntil(
    condition: () => boolean,
    { label = 'condition', timeoutMs = 3000 }: { label?: string; timeoutMs?: number } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (condition()) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}; got: ${JSON.stringify(this.frames)}`);
      }
      await delay(10);
    }
  }

  async close(): Promise<void> {
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.close();
    await this.closed;
  }
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

type WsOverrides = Omit<
  WsGatewayOptions,
  'server' | 'dispatcher' | 'tokens' | 'events' | 'logger'
>;

interface Harness {
  app: FastifyInstance;
  url: string;
  events: EventsDao;
  gateway: WsGateway;
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

async function startHarness(
  options: { ws?: WsOverrides; config?: Partial<ReturnType<typeof testConfig>> } = {},
): Promise<Harness> {
  const registry = createHandlerRegistry();
  registry.registerHandler('test.echo', async (_ctx, params) => params);
  registry.registerHandler(METHODS.message.send, async (_ctx, params) => ({ ok: true, params }));

  const app = await startServer({
    config: testConfig({ port: 0, host: '127.0.0.1', ...options.config }),
    logger: silentLogger(),
    registry,
    // This suite stubs `message.send` itself (it only exercises the transport),
    // so the real US-007 module must not claim the method.
    registerChannels: false,
    // These suites pin down handshake/framing/resume in isolation, so an
    // append must not also arrive as a live push (the same frame would be
    // delivered twice: once live, once replayed). The dedicated
    // `ws live push` block below turns it back on.
    ws: { livePush: false, ...options.ws },
  });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const store = app.store;
  if (store === undefined) throw new Error('harness requires a store');
  const gateway = app.ws;
  if (gateway === undefined) throw new Error('harness requires the ws gateway');

  let closed = false;
  const harness: Harness = {
    app,
    url: `ws://127.0.0.1:${port}${app.config.wsPath}`,
    events: store.repos.events,
    gateway,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

interface RegisteredAgent {
  agentId: string;
  token: string;
  client: TestClient;
  welcome: Frame;
}

/** Register an agent over the socket itself (anonymous `agent.register`). */
async function registerAgent(
  harness: Harness,
  name: string,
  options: WebSocket.ClientOptions = {},
): Promise<RegisteredAgent> {
  const client = await TestClient.open(harness.url, options);
  const response = await client.request(METHODS.agent.register, { name, owner: 'tests' }, 'reg');
  const result = response.result as { agentId?: string; token?: string } | undefined;
  if (result?.agentId === undefined || result.token === undefined) {
    throw new Error(`agent.register failed: ${JSON.stringify(response)}`);
  }
  // In-band authentication also emits the welcome frame and binds the socket.
  const welcome = await client.waitFor((frame) => frame.type === 'welcome', {
    label: 'welcome after agent.register',
  });
  return { agentId: result.agentId, token: result.token, client, welcome };
}

function authHeader(token: string): WebSocket.ClientOptions {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function appendEvent(harness: Harness, index: number): Promise<number> {
  const stored = harness.events.append({
    aggregateId: 'ch_ws_resume',
    type: 'message.new',
    version: index,
    payload: { messageId: `msg_${index}`, channelId: 'ch_ws_resume', senderId: 'agt_x', body: `m${index}` },
  });
  return stored.seq;
}

// ---------------------------------------------------------------------------
// Handshake / framing
// ---------------------------------------------------------------------------

describe('ws handshake', () => {
  it('authenticates a Bearer token and answers welcome{epoch,seq,protocolVersion}', async () => {
    const harness = await startHarness();
    const registrar = await registerAgent(harness, 'alpha');
    await registrar.client.close();

    const client = await TestClient.open(harness.url, authHeader(registrar.token));
    const welcome = await client.waitFor((frame) => frame.type === 'welcome');

    expect(welcome.epoch).toBe(harness.gateway.epoch);
    expect(typeof welcome.epoch).toBe('string');
    expect(welcome.seq).toBe(harness.events.head('default'));
    expect(welcome.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(welcome.agentId).toBe(registrar.agentId);
    expect(welcome.replayWindow).toBe(1000);

    await client.close();
  });

  it('rejects a forged token with -32001 and closes the socket', async () => {
    const harness = await startHarness();
    const client = await TestClient.open(harness.url, authHeader('not.a.real.jwt'));

    const error = await client.waitFor((frame) => frame.error !== undefined);
    expect(error.error?.code).toBe(JsonRpcErrorCode.Unauthorized);

    const closed = await client.closed;
    expect(closed.code).toBe(WS_CLOSE_UNAUTHORIZED);
  });

  it('lets an unauthenticated socket call only register/authenticate, not resume', async () => {
    const harness = await startHarness();
    const client = await TestClient.open(harness.url);

    const denied = await client.request('test.echo', { a: 1 }, 7);
    expect(denied.error?.code).toBe(JsonRpcErrorCode.Unauthorized);
    expect(denied.error?.data?.reason).toBe('unauthenticated');
    // Soft failure: the socket is still usable.
    expect(client.readyState).toBe(WebSocket.OPEN);

    // Notifications are answered with silence, never with an error frame.
    client.send({ jsonrpc: '2.0', method: 'test.echo', params: {} });
    await delay(100);
    expect(client.framesOf((frame) => 'result' in frame || 'error' in frame)).toHaveLength(1);

    // The event log is tenant data: resume must not be reachable pre-auth.
    client.send({ type: 'resume', lastSeenSeq: 0 });
    const resumeDenied = await client.waitFor(
      (frame) => frame.error?.data?.frame === 'resume',
    );
    expect(resumeDenied.error?.code).toBe(JsonRpcErrorCode.Unauthorized);

    expect(client.framesOf((frame) => frame.type === 'welcome')).toHaveLength(0);
    await client.close();
  });

  it('answers requests with the matching id and stays silent for notifications', async () => {
    const harness = await startHarness();
    const { client } = await registerAgent(harness, 'rpc');

    const baseline = client.framesOf((frame) => 'result' in frame || 'error' in frame).length;
    const response = await client.request('test.echo', { hello: 'ws' }, 42);
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 42, result: { hello: 'ws' } });

    // JSON-RPC ids may be strings too (US-004 semantics are shared).
    const stringId = await client.request('test.echo', { n: 1 }, 'req-17');
    expect(stringId.result).toEqual({ n: 1 });

    client.send({ jsonrpc: '2.0', method: 'test.echo', params: {} });
    await delay(120);
    const answers = client.framesOf((frame) => 'result' in frame || 'error' in frame);
    expect(answers).toHaveLength(baseline + 2);

    await client.close();
  });
});

describe('ws lifecycle', () => {
  it('shuts the HTTP server down while a client is still connected', async () => {
    const harness = await startHarness();
    const client = await TestClient.open(harness.url, {
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    await client.closed;

    const live = await TestClient.open(harness.url);
    expect(harness.gateway.sessionCount).toBe(1);

    // Upgraded sockets keep `http.Server.close()` waiting forever unless the
    // gateway terminates them from Fastify's `preClose` hook.
    await harness.close();
    expect(harness.gateway.sessionCount).toBe(0);
    await live.closed;
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('ws heartbeat', () => {
  it('answers protocol ping with pong and keeps native heartbeats alive', async () => {
    const harness = await startHarness();
    const { client } = await registerAgent(harness, 'heartbeat');

    client.send({ type: 'ping', ts: 1234 });
    const pong = await client.waitFor((frame) => frame.type === 'pong');
    expect(pong.ts).toBe(1234);

    // Native WS ping/pong: the client answers automatically, so the socket
    // must survive repeated sweeps.
    expect(harness.gateway.sweepHeartbeat()).toBe(0);
    await client.waitUntil(() => client.pings > 0, { label: 'native ping' });
    await delay(100);
    expect(harness.gateway.sweepHeartbeat()).toBe(0);
    expect(client.readyState).toBe(WebSocket.OPEN);

    await client.close();
  });

  it('terminates a socket that misses the heartbeat and announces offline', async () => {
    const harness = await startHarness();
    const registrar = await registerAgent(harness, 'silent-peer');
    await registrar.client.close();
    const observer = await registerAgent(harness, 'heartbeat-observer');
    const silent = await TestClient.open(harness.url, {
      ...authHeader(registrar.token),
      autoPong: false,
    });
    await silent.waitFor((frame) => frame.type === 'welcome');

    expect(harness.gateway.sweepHeartbeat()).toBe(0);
    await silent.waitUntil(() => silent.pings > 0, { label: 'native ping' });
    await delay(100);
    expect(harness.gateway.sweepHeartbeat()).toBe(1);

    const closed = await silent.closed;
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    await silent.closed;
    const offline = await observer.client.waitFor(
      (frame) =>
        frame.method === 'presence.update' &&
        (frame.params as Record<string, unknown> | undefined)?.agentId ===
          registrar.agentId &&
        (frame.params as Record<string, unknown> | undefined)?.status === 'offline',
      { label: 'heartbeat offline presence' },
    );
    expect(offline.params).toMatchObject({
      agentId: registrar.agentId,
      status: 'offline',
    });
    await delay(50);
    expect(harness.gateway.onlineAgents()).not.toContain(registrar.agentId);
    await observer.client.close();
  });
});

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

describe('ws presence', () => {
  it('broadcasts online and offline presence to other connections', async () => {
    const harness = await startHarness();
    const first = await registerAgent(harness, 'presence-a');
    const second = await registerAgent(harness, 'presence-b');

    const online = await first.client.waitFor(
      (frame) =>
        frame.method === 'presence.update' &&
        frame.params?.agentId === second.agentId &&
        frame.params?.status === 'online',
      { label: 'presence online' },
    );
    expect(online.params?.agentId).toBe(second.agentId);

    await second.client.close();

    const offline = await first.client.waitFor(
      (frame) =>
        frame.method === 'presence.update' &&
        frame.params?.agentId === second.agentId &&
        frame.params?.status === 'offline',
      { label: 'presence offline' },
    );
    expect(offline.params?.status).toBe('offline');

    await first.client.close();
  });
});

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

describe('ws resume', () => {
  it('replays the missing seqs in ascending order and never repeats one', async () => {
    const harness = await startHarness();
    const { client, welcome } = await registerAgent(harness, 'resume');
    const base = welcome.seq as number;

    const appended: number[] = [];
    for (const index of [1, 2, 3]) appended.push(await appendEvent(harness, index));

    client.send({ type: 'resume', lastSeenSeq: base, lastSeenEpoch: welcome.epoch });

    const ack = await client.waitFor((frame) => frame.type === 'ack');
    expect(ack.epoch).toBe(welcome.epoch);
    expect(ack.seq).toBe(appended[appended.length - 1]);

    await client.waitFor((frame) => frame.params?.seq === appended[2], {
      label: 'last replayed event',
    });
    const replayed = client.framesOf((frame) => frame.method === 'message.new');
    expect(replayed.map((frame) => frame.params?.seq)).toEqual(appended);

    // A second resume from the same (stale) cursor only acknowledges the
    // watermark: every seq was already delivered on this socket.
    const eventsBefore = replayed.length;
    client.send({ type: 'resume', lastSeenSeq: base, lastSeenEpoch: welcome.epoch });
    await client.waitUntil(() => client.framesOf((frame) => frame.type === 'ack').length === 2, {
      label: 'second ack',
    });
    await delay(120);
    expect(client.framesOf((frame) => frame.method === 'message.new')).toHaveLength(eventsBefore);

    await client.close();
  });

  it('treats a missing lastSeenEpoch as a match (third-party compatibility)', async () => {
    const harness = await startHarness();
    const { client, welcome } = await registerAgent(harness, 'resume-legacy');
    const base = welcome.seq as number;
    const seq = await appendEvent(harness, 1);

    client.send({ type: 'resume', lastSeenSeq: base });

    const ack = await client.waitFor((frame) => frame.type === 'ack');
    expect(ack.epoch).toBe(harness.gateway.epoch);
    const replayed = await client.waitFor((frame) => frame.method === 'message.new');
    expect(replayed.params?.seq).toBe(seq);
    expect(client.framesOf((frame) => frame.type === 'gap_too_large')).toHaveLength(0);

    await client.close();
  });

  it('signals gap_too_large(epoch_mismatch) without replaying when epochs differ', async () => {
    const harness = await startHarness();
    const { client, welcome } = await registerAgent(harness, 'resume-epoch');
    await appendEvent(harness, 1);

    client.send({
      type: 'resume',
      lastSeenSeq: welcome.seq,
      lastSeenEpoch: 'epoch-from-another-process',
    });

    const gap = await client.waitFor((frame) => frame.type === 'gap_too_large');
    expect(gap.signal).toBe('gap_too_large');
    expect(gap.epoch).toBe(harness.gateway.epoch);
    expect(gap.detail).toBe('epoch_mismatch');
    expect(gap.fromSeq).toBe(welcome.seq);
    expect(gap.currentSeq).toBe(harness.events.head('default'));

    await delay(120);
    expect(client.framesOf((frame) => frame.method === 'message.new')).toHaveLength(0);
    expect(client.framesOf((frame) => frame.type === 'ack')).toHaveLength(0);

    await client.close();
  });

  it('signals gap_too_large(buffer_exceeded) when the gap exceeds RESUME_MAX_EVENTS', async () => {
    const harness = await startHarness({ ws: { resumeMaxEvents: 2 } });
    const { client, welcome } = await registerAgent(harness, 'resume-window');
    expect(welcome.replayWindow).toBe(2);

    const base = welcome.seq as number;
    for (const index of [1, 2, 3]) await appendEvent(harness, index);

    client.send({ type: 'resume', lastSeenSeq: base, lastSeenEpoch: welcome.epoch });

    const gap = await client.waitFor((frame) => frame.type === 'gap_too_large');
    expect(gap.detail).toBe('buffer_exceeded');
    expect(gap.window).toBe(2);
    expect(gap.fromSeq).toBe(base);
    expect(gap.currentSeq).toBe(base + 3);

    await delay(120);
    expect(client.framesOf((frame) => frame.method === 'message.new')).toHaveLength(0);

    await client.close();
  });

  it('uses a fresh epoch per gateway instance, so a restart forces a cold start', async () => {
    const first = await startHarness();
    const registered = await registerAgent(first, 'epoch-one');
    const firstEpoch = registered.welcome.epoch;

    // A second server process: same JWT secret (so the old token still
    // verifies) but a brand-new epoch and seq space.
    const second = await startHarness();
    expect(second.gateway.epoch).not.toBe(firstEpoch);

    const client = await TestClient.open(second.url, authHeader(registered.token));
    const welcome = await client.waitFor((frame) => frame.type === 'welcome');
    expect(welcome.epoch).toBe(second.gateway.epoch);

    client.send({ type: 'resume', lastSeenSeq: registered.welcome.seq, lastSeenEpoch: firstEpoch });
    const gap = await client.waitFor((frame) => frame.type === 'gap_too_large');
    expect(gap.detail).toBe('epoch_mismatch');
    expect(gap.epoch).toBe(second.gateway.epoch);

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// Live push
// ---------------------------------------------------------------------------

describe('ws live push', () => {
  it('pushes a freshly appended event to authenticated sockets with its seq', async () => {
    const harness = await startHarness({ ws: { livePush: true } });
    const first = await registerAgent(harness, 'live-a');
    const second = await registerAgent(harness, 'live-b');

    const stored = harness.events.append({
      aggregateId: 'ch_live',
      type: 'message.new',
      version: 1,
      payload: {
        messageId: 'msg_live_1',
        channelId: 'ch_live',
        senderId: 'agt_live_a',
        content: 'hello live',
        createdAt: 1,
      },
    });

    const pushed = await first.client.waitFor((frame) => frame.method === 'message.new', {
      label: 'live push to first socket',
    });
    expect(pushed.params?.seq).toBe(stored.seq);
    expect(pushed.params?.payload).toMatchObject({ messageId: 'msg_live_1' });

    const alsoPushed = await second.client.waitFor(
      (frame) => frame.method === 'message.new' && frame.params?.seq === stored.seq,
      { label: 'live push to second socket' },
    );
    expect(alsoPushed.params?.seq).toBe(stored.seq);

    await first.client.close();
    await second.client.close();
  });

  it('never pushes the same seq twice per socket and keeps domain-only events private', async () => {
    const harness = await startHarness({ ws: { livePush: true } });
    const subscriber = await registerAgent(harness, 'live-dedupe');

    const stored = harness.events.append({
      aggregateId: 'ch_live',
      type: 'message.new',
      version: 1,
      payload: {
        messageId: 'msg_live_2',
        channelId: 'ch_live',
        senderId: 'agt_live',
        content: 'once',
        createdAt: 1,
      },
    });
    await subscriber.client.waitFor((frame) => frame.params?.seq === stored.seq, {
      label: 'initial live push',
    });

    // Re-publishing the same row is a server-side no-op: the per-socket dedupe
    // set already holds `seq`, exactly like a resume replay would.
    expect(harness.gateway.publishEvent(stored)).toBe(0);

    // Domain-only rows are projection input and must not reach the wire.
    const domainOnly = harness.events.append({
      aggregateId: 'ch_live',
      type: 'message.created',
      version: 2,
      payload: { messageId: 'msg_live_3', channelId: 'ch_live', seq: 1 },
    });
    expect(harness.gateway.publishEvent(domainOnly)).toBe(0);

    await delay(150);
    expect(
      subscriber.client.framesOf((frame) => frame.params?.seq === stored.seq),
    ).toHaveLength(1);
    expect(
      subscriber.client.framesOf((frame) => frame.params?.seq === domainOnly.seq),
    ).toHaveLength(0);

    await subscriber.client.close();
  });

  it('does not leak live pushes to unauthenticated sockets', async () => {
    const harness = await startHarness({ ws: { livePush: true } });
    const anonymous = await TestClient.open(harness.url);
    const subscriber = await registerAgent(harness, 'live-anon');

    const stored = harness.events.append({
      aggregateId: 'ch_live',
      type: 'message.new',
      version: 1,
      payload: {
        messageId: 'msg_live_4',
        channelId: 'ch_live',
        senderId: 'agt_live',
        content: 'tenant data',
        createdAt: 1,
      },
    });

    await subscriber.client.waitFor((frame) => frame.params?.seq === stored.seq, {
      label: 'live push to authenticated socket',
    });
    await delay(150);
    expect(anonymous.framesOf((frame) => frame.method === 'message.new')).toHaveLength(0);

    await anonymous.close();
    await subscriber.client.close();
  });
});

// ---------------------------------------------------------------------------
// Soft rate limiting
// ---------------------------------------------------------------------------

describe('ws rate limiting', () => {
  it('rejects over-limit connection traffic with -32005 but keeps the socket open', async () => {
    let now = 1_700_000_000_000;
    const harness = await startHarness({
      ws: {
        connectionLimit: { ratePerSecond: 1, burst: 2 },
        clock: () => now,
      },
    });
    const registrar = await registerAgent(harness, 'conn-limit');
    const client = await TestClient.open(harness.url, authHeader(registrar.token));
    await client.waitFor((frame) => frame.type === 'welcome');
    await registrar.client.close();

    const first = await client.request('test.echo', { n: 1 }, 1);
    const second = await client.request('test.echo', { n: 2 }, 2);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();

    const limited = await client.request('test.echo', { n: 3 }, 3);
    expect(limited.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(limited.error?.data?.scope).toBe('connection');
    expect(limited.error?.data?.retryAfterMs).toBeGreaterThan(0);
    // Soft rejection: the socket must stay usable, not close.
    expect(client.readyState).toBe(WebSocket.OPEN);

    // One token refills after a second → the next request succeeds.
    now += 1000;
    const recovered = await client.request('test.echo', { n: 4 }, 4);
    expect(recovered.result).toEqual({ n: 4 });
    expect(client.readyState).toBe(WebSocket.OPEN);

    await client.close();
  });

  it('rejects over-limit message.send traffic per agent with -32005 and recovers', async () => {
    let now = 1_700_000_000_000;
    const harness = await startHarness({
      ws: {
        agentLimit: { ratePerSecond: 1, burst: 2 },
        clock: () => now,
      },
    });
    const registrar = await registerAgent(harness, 'agent-limit');
    const client = await TestClient.open(harness.url, authHeader(registrar.token));
    await client.waitFor((frame) => frame.type === 'welcome');
    await registrar.client.close();

    const first = await client.request(METHODS.message.send, { channelId: 'c', body: '1' }, 1);
    const second = await client.request(METHODS.message.send, { channelId: 'c', body: '2' }, 2);
    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();

    const limited = await client.request(METHODS.message.send, { channelId: 'c', body: '3' }, 3);
    expect(limited.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(limited.error?.data?.scope).toBe('agent');
    expect(client.readyState).toBe(WebSocket.OPEN);

    now += 1000;
    const recovered = await client.request(METHODS.message.send, { channelId: 'c', body: '4' }, 4);
    expect(recovered.error).toBeUndefined();

    await client.close();
  });

  it('enforces the agent limit for sockets that only authenticate per request (params.token)', async () => {
    let now = 1_700_000_000_000;
    const harness = await startHarness({
      ws: {
        agentLimit: { ratePerSecond: 1, burst: 2 },
        clock: () => now,
      },
    });
    const registrar = await registerAgent(harness, 'per-request-auth');
    await registrar.client.close();

    // No handshake credential: this socket stays unbound and every message is
    // authenticated by `params.token` — the third-party client path US-006
    // must still throttle per agent.
    const client = await TestClient.open(harness.url);
    const answers: Frame[] = [];
    for (let i = 1; i <= 6; i += 1) {
      answers.push(
        await client.request(
          METHODS.message.send,
          { token: registrar.token, channelId: 'c', body: String(i) },
          i,
        ),
      );
    }

    const accepted = answers.filter((frame) => frame.error === undefined);
    const limited = answers.filter(
      (frame) => frame.error?.code === JsonRpcErrorCode.RateLimited,
    );
    expect(accepted).toHaveLength(2);
    expect(limited).toHaveLength(4);
    for (const frame of limited) expect(frame.error?.data?.scope).toBe('agent');
    // Soft rejection: the socket survives the burst.
    expect(client.readyState).toBe(WebSocket.OPEN);

    now += 1000;
    const recovered = await client.request(
      METHODS.message.send,
      { token: registrar.token, channelId: 'c', body: 'after' },
      7,
    );
    expect(recovered.error).toBeUndefined();
    expect(client.readyState).toBe(WebSocket.OPEN);

    await client.close();
  });

  it('shares one agent bucket across unbound per-request-auth sockets (no budget amplification)', async () => {
    const now = 1_700_000_000_000;
    const harness = await startHarness({
      ws: {
        agentLimit: { ratePerSecond: 1, burst: 2 },
        clock: () => now,
      },
    });
    const registrar = await registerAgent(harness, 'per-request-fanout');
    await registrar.client.close();

    const first = await TestClient.open(harness.url);
    const second = await TestClient.open(harness.url);
    const a = await first.request(
      METHODS.message.send,
      { token: registrar.token, channelId: 'c', body: 'a1' },
      1,
    );
    const b = await second.request(
      METHODS.message.send,
      { token: registrar.token, channelId: 'c', body: 'b1' },
      1,
    );
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();

    // Budget exhausted: a brand-new socket buys no extra tokens.
    const c = await first.request(
      METHODS.message.send,
      { token: registrar.token, channelId: 'c', body: 'a2' },
      2,
    );
    const d = await second.request(
      METHODS.message.send,
      { token: registrar.token, channelId: 'c', body: 'b2' },
      2,
    );
    expect(c.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(d.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(c.error?.data?.scope).toBe('agent');
    expect(d.error?.data?.scope).toBe('agent');

    await first.close();
    await second.close();
  });

  it('charges the per-request identity, not the socket binding, when they disagree', async () => {
    const now = 1_700_000_000_000;
    const harness = await startHarness({
      ws: {
        agentLimit: { ratePerSecond: 1, burst: 2 },
        clock: () => now,
      },
    });
    const owner = await registerAgent(harness, 'bound-owner');
    const other = await registerAgent(harness, 'params-other');
    await owner.client.close();
    await other.client.close();

    // Bound to `owner` by the handshake, but every message is authenticated as
    // `other`: the bucket consumed must be `other`'s.
    const client = await TestClient.open(harness.url, authHeader(owner.token));
    await client.waitFor((frame) => frame.type === 'welcome');
    for (let i = 1; i <= 2; i += 1) {
      const frame = await client.request(
        METHODS.message.send,
        { token: other.token, channelId: 'c', body: String(i) },
        i,
      );
      expect(frame.error).toBeUndefined();
    }
    const limited = await client.request(
      METHODS.message.send,
      { token: other.token, channelId: 'c', body: '3' },
      3,
    );
    expect(limited.error?.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(limited.error?.data?.scope).toBe('agent');

    // `owner`'s own bucket was never charged, so its socket still sends.
    const ownerClient = await TestClient.open(harness.url, authHeader(owner.token));
    await ownerClient.waitFor((frame) => frame.type === 'welcome');
    const untouched = await ownerClient.request(
      METHODS.message.send,
      { channelId: 'c', body: 'owner-1' },
      1,
    );
    expect(untouched.error).toBeUndefined();

    await client.close();
    await ownerClient.close();
  });
});

// ---------------------------------------------------------------------------
// Origin allow-list (CSWSH defence) and frame size limit
// ---------------------------------------------------------------------------

describe('ws origin validation', () => {
  it('rejects a browser Origin that is not on the allow-list', async () => {
    const harness = await startHarness({
      config: { allowedOrigins: ['https://app.example'], allowMissingOrigin: false },
    });

    await expect(
      TestClient.open(harness.url, { origin: 'https://evil.example' }),
    ).rejects.toThrow();
  });

  it('accepts an allow-listed browser Origin', async () => {
    const harness = await startHarness({
      config: { allowedOrigins: ['https://app.example'], allowMissingOrigin: false },
    });
    const client = await TestClient.open(harness.url, { origin: 'https://app.example' });
    expect(client.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it('honours the missing-Origin policy for non-browser clients', async () => {
    const strict = await startHarness({ config: { allowMissingOrigin: false } });
    await expect(TestClient.open(strict.url)).rejects.toThrow();

    const relaxed = await startHarness({ config: { allowMissingOrigin: true } });
    const client = await TestClient.open(relaxed.url);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it('allows SDK/CLI clients with no Origin by default in production', async () => {
    const harness = await startHarness({
      config: {
        isProduction: true,
        nodeEnv: 'production',
        allowedOrigins: ['https://app.example'],
        allowMissingOrigin: true,
      },
    });
    const client = await TestClient.open(harness.url);
    expect(client.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it('rejects no-Origin clients in production when ALLOW_MISSING_ORIGIN=false', async () => {
    const harness = await startHarness({
      config: {
        isProduction: true,
        nodeEnv: 'production',
        allowedOrigins: ['https://app.example'],
        allowMissingOrigin: false,
      },
    });
    await expect(TestClient.open(harness.url)).rejects.toThrow();
  });
});

describe('ws frame size limit', () => {
  it('closes a socket that sends a frame above the 1 MiB payload limit', async () => {
    const harness = await startHarness();
    const client = await TestClient.open(harness.url);

    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'test.echo',
      params: { pad: 'x'.repeat(1_100_000) },
    });

    const closed = await client.closed;
    expect(closed.code).toBe(1009);
  });
});

describe('ws live bid notification', () => {
  it('pushes task.bid.received to an online admin', async () => {
    const harness = await startHarness({
      config: { allowAdminSelfRegister: true },
      ws: { livePush: true },
    });
    const adminClient = await TestClient.open(harness.url);
    const registered = await adminClient.request(
      METHODS.agent.register,
      { name: 'admin', role: 'admin' },
      'admin-reg',
    );
    expect((registered.result as { agentId?: string }).agentId).toBeTruthy();
    await adminClient.waitFor((frame) => frame.type === 'welcome');

    const worker = await registerAgent(harness, 'worker');
    const published = await adminClient.request(
      METHODS.task.publish,
      { title: 'live bid', biddingDeadline: Date.now() + 60_000 },
      'publish',
    );
    const taskId = (published.result as { task?: { id?: string } }).task?.id;
    expect(taskId).toBeTruthy();

    const bidResponse = await worker.client.request(
      METHODS.task.bid,
      { taskId: taskId as string, price: 10 },
      'bid',
    );
    expect(bidResponse.error).toBeUndefined();

    const notification = await adminClient.waitFor(
      (frame) =>
        frame.method === 'task.bid.received' &&
        (
          (frame.params as Record<string, unknown> | undefined)?.payload as
            | Record<string, unknown>
            | undefined
        )?.taskId === taskId,
      { label: 'task.bid.received live push' },
    );
    expect(notification.params).toMatchObject({
      payload: { taskId, agentId: worker.agentId, price: 10 },
    });

    await worker.client.close();
    await adminClient.close();
  });
});

describe('ws live task progress notification', () => {
  it('pushes task.progress.updated to an online admin', async () => {
    const harness = await startHarness({
      config: { allowAdminSelfRegister: true },
      ws: { livePush: true },
    });
    const adminClient = await TestClient.open(harness.url);
    await adminClient.request(
      METHODS.agent.register,
      { name: 'admin-progress', role: 'admin' },
      'admin-progress-reg',
    );
    await adminClient.waitFor((frame) => frame.type === 'welcome');
    const worker = await registerAgent(harness, 'worker-progress');

    const published = await adminClient.request(
      METHODS.task.publish,
      { title: 'progress task', biddingDeadline: Date.now() + 60_000 },
      'publish-progress',
    );
    const task = (published.result as { task?: { id?: string; version?: number } }).task;
    expect(task?.id).toBeTruthy();
    expect(task?.version).toBe(1);

    await worker.client.request(
      METHODS.task.bid,
      { taskId: task?.id as string, price: 10 },
      'bid-progress',
    );
    const awarded = await adminClient.request(
      METHODS.task.award,
      {
        taskId: task?.id as string,
        expectedVersion: 1,
        awardeeId: worker.agentId,
      },
      'award-progress',
    );
    expect((awarded.result as { task?: { version?: number } }).task?.version).toBe(2);

    const reported = await worker.client.request(
      METHODS.task.progress,
      { taskId: task?.id as string, progress: 40 },
      'progress',
    );
    expect(reported.error).toBeUndefined();

    const notification = await adminClient.waitFor(
      (frame) =>
        frame.method === 'task.progress.updated' &&
        (
          (frame.params as Record<string, unknown> | undefined)?.payload as
            | Record<string, unknown>
            | undefined
        )?.taskId === task?.id,
      { label: 'task.progress.updated live push' },
    );
    expect(notification.params).toMatchObject({
      payload: { taskId: task?.id, progress: 40 },
    });

    await worker.client.close();
    await adminClient.close();
  });
});
