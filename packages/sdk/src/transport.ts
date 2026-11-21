/**
 * Transport abstraction.
 *
 * The SDK core never imports `ws`; browsers and Node inject a factory. The
 * browser factory below uses the global `WebSocket`, while Node callers can
 * wrap the `ws` package (or any compatible implementation) in a few lines.
 */

export interface TransportHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number, reason: string): void;
  onError(error: unknown): void;
}

export interface ClientTransport {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface TransportOptions {
  /** Optional handshake headers; browser WebSocket ignores them. */
  readonly headers?: Record<string, string>;
}

export type TransportFactory = (
  url: string,
  options: TransportOptions,
  handlers: TransportHandlers,
) => ClientTransport;

interface MessageEventLike {
  readonly data: unknown;
}
interface CloseEventLike {
  readonly code?: number;
  readonly reason?: string;
}
interface ErrorEventLike {
  readonly error?: unknown;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen?: (() => void) | null;
  onmessage?: ((event: MessageEventLike) => void) | null;
  onclose?: ((event: CloseEventLike) => void) | null;
  onerror?: ((event: ErrorEventLike) => void) | null;
}

/** Browser transport using the global WebSocket (no Node-only imports). */
export function browserTransportFactory(): TransportFactory {
  return (url, _options, handlers) => {
    const Constructor = (
      globalThis as unknown as {
        WebSocket?: new (url: string) => WebSocketLike;
      }
    ).WebSocket;
    if (Constructor === undefined) {
      throw new Error(
        'No global WebSocket available; inject a transportFactory (e.g. a ws adapter)',
      );
    }
    const socket = new Constructor(url);
    socket.onopen = () => handlers.onOpen();
    socket.onmessage = (event) => {
      handlers.onMessage(
        typeof event.data === 'string' ? event.data : String(event.data),
      );
    };
    socket.onclose = (event) =>
      handlers.onClose(event.code ?? 1006, event.reason ?? '');
    socket.onerror = (event) => handlers.onError(event.error ?? event);
    return {
      send: (text) => socket.send(text),
      close: (code, reason) => socket.close(code, reason),
    };
  };
}
