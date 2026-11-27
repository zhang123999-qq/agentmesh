import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  browserTransportFactory,
  type ClientTransport,
  type TransportHandlers,
  type WebSocketLike,
} from '../src/transport.js';

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | undefined;
  readonly url: string;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: { error?: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }
}

interface Recorded {
  opened: number;
  messages: string[];
  closes: Array<{ code: number; reason: string }>;
  errors: unknown[];
}

function handlers(recorded: Recorded): TransportHandlers {
  return {
    onOpen: () => {
      recorded.opened += 1;
    },
    onMessage: (text) => recorded.messages.push(text),
    onClose: (code, reason) => recorded.closes.push({ code, reason }),
    onError: (error) => recorded.errors.push(error),
  };
}

function open(
  options: { readonly headers?: Record<string, string> } = {},
): { socket: FakeSocket; transport: ClientTransport; recorded: Recorded } {
  const recorded: Recorded = { opened: 0, messages: [], closes: [], errors: [] };
  const transport = browserTransportFactory()('ws://test', options, handlers(recorded));
  const socket = FakeSocket.last;
  if (socket === undefined) throw new Error('factory did not construct a socket');
  return { socket, transport, recorded };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.last = undefined;
});

describe('browserTransportFactory', () => {
  it('throws when no global WebSocket exists', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(() =>
      browserTransportFactory()('ws://test', {}, handlers({
        opened: 0,
        messages: [],
        closes: [],
        errors: [],
      })),
    ).toThrow(/inject a transportFactory/);
  });

  it('forwards open, message, close and error events', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { socket, recorded } = open();

    socket.onopen?.();
    socket.onmessage?.({ data: '{"jsonrpc":"2.0"}' });
    socket.onmessage?.({ data: { toString: () => 'binary-ish' } });
    socket.onclose?.({});
    socket.onclose?.({ code: 1000, reason: 'bye' });
    const boom = new Error('boom');
    socket.onerror?.({ error: boom });
    const bare = { phase: 'error' };
    socket.onerror?.({ error: undefined, ...bare });

    expect(recorded.opened).toBe(1);
    expect(recorded.messages).toEqual(['{"jsonrpc":"2.0"}', 'binary-ish']);
    expect(recorded.closes).toEqual([
      { code: 1006, reason: '' },
      { code: 1000, reason: 'bye' },
    ]);
    expect(recorded.errors[0]).toBe(boom);
    expect(recorded.errors[1]).toMatchObject({ phase: 'error' });
  });

  it('delegates send and close to the socket', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const { socket, transport } = open({ headers: { authorization: 'Bearer x' } });

    transport.send('hello');
    transport.close(1000, 'done');

    expect(socket.sent).toEqual(['hello']);
    expect(socket.closedWith).toEqual({ code: 1000, reason: 'done' });
  });
});
