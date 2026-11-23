import { AgentMeshClient } from '@agentmesh/sdk';
import type { ClientTransport, TransportFactory, TransportHandlers } from '@agentmesh/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { clearSeqRegistry, markSeqSeen } from '../src/lib/seq-registry.js';

/**
 * Web integration (US-021G): drive the REAL SDK with a mock transport and feed
 * the delivered `seq`s through the same `seq-registry` the pages use. This
 * proves the "live stream + history page share one dedup key" contract against
 * real SDK parsing (not a hand-rolled mock of the client).
 */

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

function jwtWithSubject(subject: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: subject,
    role: 'admin',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}

function welcome(transport: MockTransport, epoch = 'epoch-1', seq = 0): void {
  transport.emit({ type: 'welcome', epoch, seq, protocolVersion: '1.0.0' });
}

function messageFrame(seq: number, messageId: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'message.new',
    params: {
      seq,
      aggregateId: 'channel:ch_1',
      type: 'message.new',
      version: 1,
      ts: 1,
      payload: {
        messageId,
        channelId: 'ch_1',
        senderId: 'agt_1',
        content: 'hi',
        createdAt: 1,
        seq,
      },
    },
  };
}

afterEach(() => clearSeqRegistry());

describe('web seq dedup against the real SDK', () => {
  it('renders a live message once and skips the same seq from an overlapping history page', async () => {
    const factory = new MockFactory();
    const client = new AgentMeshClient({
      url: 'ws://mock',
      transportFactory: factory.factory,
      autoReconnect: false,
    });
    const rendered: number[] = [];
    client.on('message.new', (payload) => {
      const seq = (payload as { seq?: unknown }).seq;
      if (typeof seq === 'number' && markSeqSeen(seq)) rendered.push(seq);
    });

    const connecting = client.connect();
    const transport = factory.last;
    transport.open();
    welcome(transport, 'epoch-1', 0);
    await connecting;

    // Live delivery of seq 5.
    transport.emit(messageFrame(5, 'm5'));
    // History page [4, 5] (5 overlaps the live one) through the same registry.
    for (const seq of [4, 5]) {
      if (markSeqSeen(seq)) rendered.push(seq);
    }

    expect(rendered).toEqual([5, 4]);
    client.close();
  });

  it('carries lastSeenEpoch in the resume frame after a reconnect', async () => {
    const factory = new MockFactory();
    const token = jwtWithSubject('agt_admin');
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
    first.emit({ jsonrpc: '2.0', id: auth?.id, result: { agentId: 'agt_admin', token, role: 'admin', expiresAt: 1 } });
    welcome(first, 'epoch-1', 0);
    await connecting;

    first.emit(messageFrame(5, 'm5'));
    expect(client.lastSeenSeq).toBe(5);

    first.handlers.onClose(1006, 'drop');
    await delay(30);

    expect(factory.transports).toHaveLength(2);
    const second = factory.last;
    second.open();
    const reauth = second.lastRequest('agent.authenticate');
    expect(reauth).toBeDefined();
    second.emit({ jsonrpc: '2.0', id: reauth?.id, result: { agentId: 'agt_admin', token, role: 'admin', expiresAt: 1 } });
    welcome(second, 'epoch-1', 10);

    const resume = second.sent.find((frame) => frame.type === 'resume');
    expect(resume).toMatchObject({ type: 'resume', lastSeenSeq: 5, lastSeenEpoch: 'epoch-1' });
    client.close();
  });
});
