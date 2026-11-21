import { describe, expect, it } from 'vitest';

import {
  AgentMeshClient,
  VersionConflictError,
  type ConnectionEvent,
} from '../src/index.js';
import type {
  ClientTransport,
  TransportFactory,
  TransportHandlers,
} from '../src/index.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function jwtWithSubject(subject: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: subject,
    role: 'agent',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

class MockTransport implements ClientTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  constructor(readonly handlers: TransportHandlers) {}

  open(): void {
    this.handlers.onOpen();
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose(1000, 'mock close');
  }

  emit(frame: unknown): void {
    this.handlers.onMessage(JSON.stringify(frame));
  }

  lastRequest(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((frame) => frame.method === method);
  }
}

class MockFactory {
  readonly transports: MockTransport[] = [];

  readonly factory: TransportFactory = (_url, _options, handlers) => {
    const transport = new MockTransport(handlers);
    this.transports.push(transport);
    return transport;
  };

  get last(): MockTransport {
    const transport = this.transports[this.transports.length - 1];
    if (transport === undefined) throw new Error('no mock transport yet');
    return transport;
  }
}

function welcome(transport: MockTransport, epoch = 'epoch-1', seq = 0): void {
  transport.emit({
    type: 'welcome',
    epoch,
    seq,
    protocolVersion: '1.0.0',
  });
}

function respond(
  transport: MockTransport,
  request: Record<string, unknown>,
  result: unknown,
): void {
  transport.emit({ jsonrpc: '2.0', id: request.id, result });
}

function eventFrame(seq: number, type = 'task.awarded'): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: type,
    params: {
      seq,
      aggregateId: 'task:tsk_1',
      type,
      version: 1,
      payload: {
        taskId: 'tsk_1',
        awardeeId: 'agt_1',
        awardedBy: 'agt_admin',
        exploration: false,
      },
      ts: 1,
    },
  };
}

function notificationFrame(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: type,
    params: { seq, aggregateId: 'task:tsk_1', type, version: 1, payload, ts: 1 },
  };
}

describe('AgentMeshClient transport', () => {
  it('connects, processes welcome and dispatches typed events', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: false,
    });
    const connected: ConnectionEvent[] = [];
    client.onConnection((event) => connected.push(event));
    const received: number[] = [];
    client.on('task.awarded', (payload) => received.push(payload.taskId === 'tsk_1' ? 1 : 0));

    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport, 'epoch-1', 10);
    await connecting;

    expect(client.state).toBe('connected');
    expect(client.epoch).toBe('epoch-1');
    expect(connected.some((event) => event.status === 'connected')).toBe(true);

    transport.emit(eventFrame(11));
    transport.emit(eventFrame(11));
    expect(received).toEqual([1]);
    expect(client.lastSeenSeq).toBe(11);
    client.close();
  });

  it('re-authenticates on reconnect and always sends lastSeenEpoch in resume', async () => {
    const factory = new MockFactory();
    const token = jwtWithSubject('agt_1');
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      token,
      autoReconnect: true,
      reconnectDelayMs: 5,
      gapPolicy: 'strict',
    });

    const connecting = client.connect();
    const first = factory.last;
    first.open();
    const auth = first.lastRequest('agent.authenticate');
    expect(auth).toBeDefined();
    respond(first, auth as Record<string, unknown>, {
      agentId: 'agt_1',
      token,
      role: 'agent',
      expiresAt: 1,
    });
    welcome(first, 'epoch-1', 0);
    await connecting;

    first.emit(eventFrame(5));
    expect(client.lastSeenSeq).toBe(5);

    first.handlers.onClose(1006, 'drop');
    expect(client.state).toBe('reconnecting');
    await delay(30);

    expect(factory.transports).toHaveLength(2);
    const second = factory.last;
    second.open();
    const reauth = second.lastRequest('agent.authenticate');
    expect(reauth).toBeDefined();
    respond(second, reauth as Record<string, unknown>, {
      agentId: 'agt_1',
      token,
      role: 'agent',
      expiresAt: 1,
    });
    welcome(second, 'epoch-1', 10);

    const resume = second.sent.find((frame) => frame.type === 'resume');
    expect(resume).toBeDefined();
    expect(resume).toMatchObject({
      type: 'resume',
      lastSeenSeq: 5,
      lastSeenEpoch: 'epoch-1',
    });
    client.close();
  });

  it('maps -32007 to VersionConflictError with task context', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: false,
    });
    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport);
    await connecting;

    const pending = client.getTask({ taskId: 'tsk_1' });
    const request = transport.lastRequest('task.get') as Record<string, unknown>;
    transport.emit({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32007,
        message: 'Task changed',
        data: { taskId: 'tsk_1', expectedVersion: 1, currentVersion: 2 },
      },
    });

    await expect(pending).rejects.toBeInstanceOf(VersionConflictError);
    await pending.catch((error: unknown) => {
      expect(error).toMatchObject({
        taskId: 'tsk_1',
        expectedVersion: 1,
        currentVersion: 2,
      });
    });
    client.close();
  });

  it('auto cold-starts on gap_too_large and notifies the caller', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: true,
      reconnectDelayMs: 5,
      gapPolicy: 'auto',
    });
    const events: ConnectionEvent[] = [];
    client.onConnection((event) => events.push(event));

    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport, 'epoch-1', 20);
    await connecting;

    transport.emit({
      type: 'gap_too_large',
      signal: 'gap_too_large',
      epoch: 'epoch-2',
      fromSeq: 0,
      currentSeq: 100,
      window: 10,
      detail: 'buffer_exceeded',
    });

    expect(events.some((event) => event.status === 'gapTooLarge')).toBe(true);
    await delay(30);
    expect(factory.transports.length).toBeGreaterThanOrEqual(2);
    client.close();
  });

  it('strict gap policy surfaces gapTooLarge without reconnecting', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: true,
      reconnectDelayMs: 5,
      gapPolicy: 'strict',
    });
    const events: ConnectionEvent[] = [];
    client.onConnection((event) => events.push(event));

    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport);
    await connecting;

    transport.emit({
      type: 'gap_too_large',
      signal: 'gap_too_large',
      epoch: 'epoch-2',
      fromSeq: 0,
      currentSeq: 100,
      window: 10,
    });
    expect(events.some((event) => event.status === 'gapTooLarge')).toBe(true);
    await delay(30);
    expect(factory.transports).toHaveLength(1);
    expect(client.state).toBe('gapTooLarge');
    client.close();
  });

  it('dispatches notifications whose optional fields are omitted', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: false,
    });
    const seen: string[] = [];
    client.on('task.progress.updated', (payload) => seen.push(`progress:${payload.progress}`));
    client.on('task.completed', (payload) => seen.push(`completed:${payload.taskId}`));
    client.on('task.cancelled', (payload) => seen.push(`cancelled:${payload.taskId}`));

    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport);
    await connecting;

    transport.emit(
      notificationFrame(21, 'task.progress.updated', {
        taskId: 'tsk_1',
        agentId: 'agt_1',
        progress: 50,
      }),
    );
    transport.emit(notificationFrame(22, 'task.completed', { taskId: 'tsk_1' }));
    transport.emit(notificationFrame(23, 'task.cancelled', { taskId: 'tsk_1' }));

    expect(seen).toEqual(['progress:50', 'completed:tsk_1', 'cancelled:tsk_1']);
    client.close();
  });

  it('sendRaw sends the frame verbatim', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: false,
    });
    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport);
    await connecting;

    client.sendRaw({ custom: 'frame', n: 1 });
    expect(transport.sent.at(-1)).toEqual({ custom: 'frame', n: 1 });
    client.close();
  });
});
