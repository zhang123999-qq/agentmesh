/**
 * US-006 fault-injection harness — AC "无空洞 / 无重复 / 重启冷启动".
 *
 * The two acceptance criteria this file pins down are *recovery* properties, so
 * the harness never relies on real randomness or on wall-clock luck:
 *
 * - **Deterministic faults** — a 32-bit LCG (`Lcg`) with a fixed seed drives a
 *   scripted fault sequence: 30% of rounds drop the socket *before* the event
 *   is written (so the client provably misses it), 10% of online rounds
 *   re-deliver the same event a second time (`gateway.broadcast`, i.e. the
 *   duplicate-delivery path). Same seed ⇒ same fault script ⇒ same assertions.
 * - **Client model** — `RealtimeClientModel` is what a real SDK does: it keeps
 *   a `Map<seq, event>`, dedupes on the globally unique `seq`, tracks
 *   `lastSeenSeq` (= max received seq) and `lastSeenEpoch`, reconnects with
 *   `resume {lastSeenSeq, lastSeenEpoch}`, and on `gap_too_large`
 *   (`epoch_mismatch`) falls back to a full fetch (resume from seq 0 on the new
 *   epoch).
 *
 * Assertions are always on the *rendered* sequence: keys of the received map
 * must equal the appended seqs exactly — no hole, no duplicate, still ascending
 * (a duplicate arrival is swallowed by the map, so it never re-renders).
 *
 * Everything runs against real `startServer` instances on 127.0.0.1:0, real
 * SQLite (in-memory), real JWTs and the real `ws` client stack.
 */

import { METHODS } from '@agentmesh/protocol';
import {
  createRepositories,
  openStore,
  type AgentMeshDatabase,
  type EventsDao,
  type StoredEvent,
} from '@agentmesh/store';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createHandlerRegistry } from '../src/registry.js';
import { startServer } from '../src/index.js';
import { eventNotification } from '../src/ws/framing.js';
import type { WsGateway } from '../src/ws/gateway.js';
import { silentLogger, testConfig } from './helpers.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Deterministic pseudo-randomness
// ---------------------------------------------------------------------------

/**
 * 32-bit linear congruential generator (Numerical Recipes constants).
 *
 * `next()` is uniform enough for a 30%/10% fault script and — the point here —
 * fully reproducible: the same seed always yields the same sequence on every
 * machine, so a failing run can be replayed exactly.
 */
class Lcg {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Next value in `[0, 1)`. */
  next(): number {
    this.#state = (Math.imul(this.#state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.#state / 0x1_0000_0000;
  }
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

interface FaultHarness {
  app: FastifyInstance;
  url: string;
  epoch: string;
  events: EventsDao;
  gateway: WsGateway;
  close: () => Promise<void>;
}

const harnesses: FaultHarness[] = [];
const databases: AgentMeshDatabase[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

async function startHarness(sharedDb?: AgentMeshDatabase): Promise<FaultHarness> {
  const db = sharedDb ?? openStore(':memory:').db;
  if (sharedDb === undefined) databases.push(db);

  const app = await startServer({
    config: testConfig({ port: 0, host: '127.0.0.1' }),
    logger: silentLogger(),
    registry: createHandlerRegistry(),
    // Re-opening the same database is how a *restart* is simulated: same data,
    // fresh gateway instance, therefore a fresh epoch.
    store: { db, repos: createRepositories(db) },
    ws: { livePush: true },
  });

  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const store = app.store;
  if (store === undefined) throw new Error('fault harness requires a store');
  const gateway = app.ws;
  if (gateway === undefined) throw new Error('fault harness requires the ws gateway');

  const harness: FaultHarness = {
    app,
    url: `ws://127.0.0.1:${port}${app.config.wsPath}`,
    epoch: gateway.epoch,
    events: store.repos.events,
    gateway,
    close: async () => {
      await app.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

// ---------------------------------------------------------------------------
// Client model
// ---------------------------------------------------------------------------

interface Frame {
  type?: string;
  method?: string;
  params?: { seq?: number } & Record<string, unknown>;
  seq?: number;
  epoch?: string;
  detail?: string;
  result?: { agentId?: string; token?: string };
  error?: { code: number; message: string; data?: Record<string, unknown> };
  id?: unknown;
  [key: string]: unknown;
}

/** The rendered timeline: `seq → event`, exactly one entry per seq. */
class RealtimeClientModel {
  /** Rendered events, keyed by the globally unique `seq`. */
  readonly received = new Map<number, Record<string, unknown>>();
  /** Render order (first-seen only) — must stay ascending. */
  readonly renderOrder: number[] = [];
  /** Duplicate arrivals swallowed by the seq dedupe. */
  duplicates = 0;
  disconnects = 0;
  resumeAcks = 0;
  coldStarts = 0;
  readonly gapDetails: string[] = [];
  readonly frames: Frame[] = [];

  #socket?: WebSocket;
  #closed?: Promise<void>;
  #lastSeenEpoch?: string;
  /** First frame index of the *current* connection (frames outlive sockets). */
  #frameCursor = 0;
  #url: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly logger: (frame: Frame) => void = () => undefined,
  ) {
    this.#url = url;
  }

  /** Repoint the model at another server instance (restart simulation). */
  pointTo(url: string): void {
    this.#url = url;
  }

  /** Highest received seq — the resume cursor the AC talks about. */
  get lastSeenSeq(): number {
    let max = 0;
    for (const seq of this.received.keys()) if (seq > max) max = seq;
    return max;
  }

  get lastSeenEpoch(): string | undefined {
    return this.#lastSeenEpoch;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /** Open a socket and wait for `welcome` (auth is header-based). */
  async connect(): Promise<Frame> {
    // Frames from earlier connections stay in the log for debugging, but a new
    // socket must wait for *its own* welcome — otherwise a stale welcome makes
    // `reconnect()` send `resume` before the handshake has bound the identity.
    this.#frameCursor = this.frames.length;
    const socket = new WebSocket(this.#url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.#socket = socket;
    this.#closed = new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
    });
    // Listeners must exist before `open`: the server may write the first frame
    // (welcome) in the same tick the handshake completes.
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      this.frames.push(frame);
      this.logger(frame);
      this.#ingest(frame);
    });
    socket.on('error', () => undefined);

    await new Promise<void>((resolve, reject) => {
      if (socket.readyState === WebSocket.OPEN) {
        resolve();
        return;
      }
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(err));
    });

    const welcome = await this.waitFor(
      (frame) => frame.type === 'welcome',
      'welcome on the current socket',
      4000,
      this.#frameCursor,
    );
    // The epoch only ever changes through an explicit `ack` (the server we are
    // talking to) or `gap_too_large` (cold start); `welcome` seeds it once.
    this.#lastSeenEpoch ??= welcome.epoch;
    return welcome;
  }

  /** Simulated network drop: close the socket, count it, stay offline. */
  async disconnect(): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined) return;
    this.disconnects += 1;
    if (socket.readyState === WebSocket.OPEN) socket.close();
    await this.#closed;
    this.#socket = undefined;
    this.#closed = undefined;
  }

  /**
   * Reconnect and `resume` from the client's own cursor — the epoch of the
   * *events we hold*, not the epoch of the server we are dialling, which is
   * how a real client detects a restart.
   */
  async reconnect(): Promise<Frame> {
    const cursor = { seq: this.lastSeenSeq, epoch: this.#lastSeenEpoch };
    await this.disconnect();
    const welcome = await this.connect();
    this.sendResume(cursor.seq, cursor.epoch);
    // A real client waits for `ack` (+ the replayed tail) before it does
    // anything else; without that wait the next scripted drop could close the
    // socket before the server even reads the resume.
    await this.awaitResumeSettled(cursor.seq);
    return welcome;
  }

  /**
   * Wait until the `ack` answering our resume arrived — and, when the server
   * had something to replay, until the last replayed `seq` was rendered. This
   * is what keeps the client's cursor contiguous.
   */
  async awaitResumeSettled(cursor: number, from = this.#frameCursor): Promise<void> {
    const ack = await this.waitFor(
      (frame) => frame.type === 'ack' || frame.type === 'gap_too_large',
      'resume ack',
      4000,
      from,
    );
    if (ack.type === 'gap_too_large' || typeof ack.seq !== 'number') return;
    if (ack.seq <= cursor) return;
    await this.waitFor(
      (frame) => frame.params?.seq === ack.seq,
      `replay tail seq ${ack.seq}`,
      4000,
      from,
    );
  }

  /** Ask the server for anything after `lastSeenSeq` (tail sync). */
  sendResume(lastSeenSeq: number, epoch: string | undefined): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: 'resume',
        lastSeenSeq,
        ...(epoch === undefined ? {} : { lastSeenEpoch: epoch }),
      }),
    );
  }

  /** Wait until no new frame has arrived for `quietMs` (in-flight settles). */
  async settle(quietMs = 60): Promise<void> {
    let seen = this.frames.length;
    for (;;) {
      await delay(quietMs);
      if (this.frames.length === seen) return;
      seen = this.frames.length;
    }
  }

  async waitFor(
    predicate: (frame: Frame) => boolean,
    label: string,
    timeoutMs = 4000,
    from = 0,
  ): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.frames.slice(from).find(predicate);
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}; frames: ${JSON.stringify(this.frames)}`);
      }
      await delay(5);
    }
  }

  async waitForCount(count: number, label: string, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.size < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}: have ${this.received.size}/${count} seqs`,
        );
      }
      await delay(10);
    }
  }

  /** Rendered seqs in render order. */
  rendered(): number[] {
    return [...this.received.keys()];
  }

  // ---------------------------------------------------------------- ingest

  #ingest(frame: Frame): void {
    if (frame.type === 'welcome') return;

    if (frame.type === 'ack') {
      this.resumeAcks += 1;
      if (typeof frame.epoch === 'string') this.#lastSeenEpoch = frame.epoch;
      return;
    }

    if (frame.type === 'gap_too_large') {
      const detail = frame.detail ?? 'unknown';
      this.gapDetails.push(detail);
      if (detail === 'epoch_mismatch' && typeof frame.epoch === 'string') {
        // Server restarted: cursors are meaningless → cold start (full fetch).
        this.coldStarts += 1;
        this.#lastSeenEpoch = frame.epoch;
        this.sendResume(0, frame.epoch);
      }
      return;
    }

    const seq = frame.params?.seq;
    if (typeof frame.method !== 'string' || typeof seq !== 'number') return;
    if (this.received.has(seq)) {
      // Same global seq delivered twice (live push + duplicate/replay overlap).
      this.duplicates += 1;
      return;
    }
    this.received.set(seq, frame.params as Record<string, unknown>);
    this.renderOrder.push(seq);
  }
}

// ---------------------------------------------------------------------------
// Producers / assertions
// ---------------------------------------------------------------------------

const CHANNEL = 'ch_fault';

function appendMessage(events: EventsDao, index: number): StoredEvent {
  return events.append({
    aggregateId: CHANNEL,
    type: 'message.new',
    version: index,
    payload: {
      messageId: `msg_${index}`,
      channelId: CHANNEL,
      senderId: 'agt_fault',
      content: `payload-${index}`,
      createdAt: 1_700_000_000_000 + index,
    },
  });
}

/** Assert the rendered timeline is exactly the appended seqs, once, ascending. */
function expectRenderedTimeline(client: RealtimeClientModel, appended: readonly number[]): void {
  const rendered = client.rendered();
  const expected = [...appended].sort((a, b) => a - b);

  // 1. no hole, no extra: the exact set of appended seqs.
  expect(rendered).toHaveLength(expected.length);
  expect([...rendered].sort((a, b) => a - b)).toEqual(expected);

  // 2. no duplicate: a Map cannot hold one, but assert it explicitly anyway.
  expect(new Set(rendered).size).toBe(rendered.length);

  // 3. contiguous seq span — nothing was skipped in the middle.
  for (let i = 1; i < expected.length; i += 1) {
    expect(expected[i]).toBe((expected[i - 1] as number) + 1);
  }

  // 4. rendered in ascending order: a deduped replay never re-renders an old
  //    message after a newer one.
  expect(rendered).toEqual([...rendered].sort((a, b) => a - b));
}

/** Register an agent over its own socket and return `{agentId, token}`. */
async function registerAgent(url: string, name: string): Promise<{ token: string }> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (err) => reject(err));
  });
  socket.send(
    JSON.stringify({ jsonrpc: '2.0', id: 'reg', method: METHODS.agent.register, params: { name, owner: 'fault-tests' } }),
  );

  const deadline = Date.now() + 4000;
  for (;;) {
    const answer = frames.find((frame) => frame.id === 'reg');
    if (answer?.result?.token !== undefined) {
      socket.close();
      return { token: answer.result.token };
    }
    if (answer?.error !== undefined) {
      socket.close();
      throw new Error(`agent.register failed: ${JSON.stringify(answer.error)}`);
    }
    if (Date.now() > deadline) throw new Error('timed out registering the test agent');
    await delay(10);
  }
}

// ---------------------------------------------------------------------------
// AC: 30% disconnects + 10% duplicate delivery ⇒ no hole, no duplicate
// ---------------------------------------------------------------------------

describe('ws fault injection: disconnect 30% + duplicate 10%', () => {
  it('renders every event exactly once across scripted drops and duplicate deliveries', async () => {
    const harness = await startHarness();
    const { token } = await registerAgent(harness.url, 'fault-runner');

    const client = new RealtimeClientModel(harness.url, token);
    await client.connect();

    const rng = new Lcg(0x5eed_1234);
    const appended: number[] = [];
    let injectedDuplicates = 0;

    const EVENTS = 60;
    const DISCONNECT_RATE = 0.3;
    const DUPLICATE_RATE = 0.1;

    for (let index = 1; index <= EVENTS; index += 1) {
      // Fault #1 (30%): drop the socket *before* the event is written, so the
      // live push provably misses this client and only `resume` can recover it.
      if (client.connected && rng.next() < DISCONNECT_RATE) {
        await client.disconnect();
      }

      const row = appendMessage(harness.events, index);
      appended.push(row.seq);

      if (!client.connected) {
        // Reconnect with resume(lastSeenSeq, lastSeenEpoch): the gap fills from
        // the event log, in ascending seq order.
        await client.reconnect();
        continue;
      }

      // Fault #2 (10%): deliver the same event a second time on the wire.
      if (rng.next() < DUPLICATE_RATE) {
        harness.gateway.broadcast(eventNotification(row));
        injectedDuplicates += 1;
      }
    }

    // Tail sync: whatever was in flight when the loop ended.
    if (!client.connected) await client.reconnect();
    await client.settle();
    const cursor = client.lastSeenSeq;
    const from = client.frames.length;
    client.sendResume(cursor, client.lastSeenEpoch ?? harness.epoch);
    await client.awaitResumeSettled(cursor, from);
    await client.settle(20);
    await client.waitForCount(appended.length, 'all events rendered');

    expectRenderedTimeline(client, appended);

    // The script really did exercise both fault paths.
    expect(client.disconnects).toBeGreaterThan(0);
    expect(injectedDuplicates).toBeGreaterThan(0);
    expect(client.duplicates).toBeGreaterThan(0);
    // Duplicates are swallowed, never rendered twice.
    expect(client.received.size).toBe(EVENTS);

    // ...and it is reproducible: replaying the seed reproduces the exact same
    // fault script (one drop draw per round, one duplicate draw per online
    // round — the same order in which the harness consumed the stream).
    const replay = new Lcg(0x5eed_1234);
    const predictedDrops: number[] = [];
    const predictedDuplicates: number[] = [];
    for (let index = 1; index <= EVENTS; index += 1) {
      if (replay.next() < DISCONNECT_RATE) {
        predictedDrops.push(index);
        continue;
      }
      if (replay.next() < DUPLICATE_RATE) predictedDuplicates.push(index);
    }
    expect(predictedDrops).toHaveLength(client.disconnects);
    expect(predictedDuplicates).toHaveLength(injectedDuplicates);

    await client.disconnect();
  });

  it('replays an identical fault script for the same seed', () => {
    // The harness must be *reproducible*, not lucky: the same seed always
    // yields the same drops/duplicates, so a red run can be replayed exactly.
    const script = (seed: number): { drops: number[]; duplicates: number[] } => {
      const rng = new Lcg(seed);
      const drops: number[] = [];
      const duplicates: number[] = [];
      let online = true;
      for (let index = 1; index <= 60; index += 1) {
        if (online && rng.next() < 0.3) {
          drops.push(index);
          online = false;
        }
        if (!online) {
          online = true; // reconnected in the same round
          continue;
        }
        if (rng.next() < 0.1) duplicates.push(index);
      }
      return { drops, duplicates };
    };

    expect(script(7)).toEqual(script(7));
    expect(script(7)).not.toEqual(script(8));
    expect(script(7).drops.length).toBeGreaterThan(0);
    expect(script(7).duplicates.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC: restart ⇒ epoch mismatch ⇒ cold-start full fetch, still gapless
// ---------------------------------------------------------------------------

describe('ws fault injection: restart cold start', () => {
  it('detects epoch_mismatch after a restart and cold-starts without holes or duplicates', async () => {
    // One database, two gateway instances: `seq` keeps advancing, the epoch
    // does not — exactly what a real restart looks like.
    const db = openStore(':memory:').db;
    databases.push(db);

    const first = await startHarness(db);
    const { token } = await registerAgent(first.url, 'fault-restart');

    const client = new RealtimeClientModel(first.url, token);
    await client.connect();

    // Phase 1 — the client is online and receives live pushes.
    const appended: number[] = [];
    const online: number[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const row = appendMessage(first.events, index);
      appended.push(row.seq);
      online.push(row.seq);
    }
    await client.waitForCount(online.length, 'phase-1 live pushes');
    await client.settle();
    const cursorBeforeRestart = { seq: client.lastSeenSeq, epoch: client.lastSeenEpoch };
    expect(cursorBeforeRestart.epoch).toBe(first.epoch);

    // Phase 2 — the client drops, more events are written, the server restarts.
    await client.disconnect();
    for (let index = 6; index <= 9; index += 1) {
      appended.push(appendMessage(first.events, index).seq);
    }
    await first.close();

    const second = await startHarness(db);
    expect(second.epoch).not.toBe(first.epoch);

    // Phase 3 — reconnect to the new instance: the client presents the *old*
    // epoch (captured before the restart), so the server must reject the cursor.
    client.pointTo(second.url);
    const welcome = await client.connect();
    expect(welcome.epoch).toBe(second.epoch);
    client.sendResume(cursorBeforeRestart.seq, cursorBeforeRestart.epoch);

    const gap = await client.waitFor((frame) => frame.type === 'gap_too_large', 'gap signal');
    expect(gap.detail).toBe('epoch_mismatch');
    expect(gap.epoch).toBe(second.epoch);

    // Phase 4 — the client cold-starts (full fetch on the new epoch) and the
    // replay overlaps what it already rendered from phase 1.
    await client.waitForCount(appended.length, 'cold-start full fetch');
    await client.settle();

    expect(client.coldStarts).toBe(1);
    expect(client.gapDetails).toContain('epoch_mismatch');
    expectRenderedTimeline(client, appended);
    // The overlap (phase-1 messages replayed by the full fetch) was deduped,
    // never re-rendered: that is the "补偿消息与断线前已收到交集不得重复渲染" AC.
    expect(client.duplicates).toBeGreaterThanOrEqual(online.length);

    await client.disconnect();
    await second.close();
  });
});
