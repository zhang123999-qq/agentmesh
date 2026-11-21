/**
 * Node transport for the SDK.
 *
 * The SDK core deliberately does not import `ws`; the CLI is the Node entry
 * point and supplies this adapter. It is the only transport-specific code in
 * the CLI.
 */

import type { TransportFactory } from '@agentmesh/sdk';
import { WebSocket } from 'ws';

export const nodeTransport: TransportFactory = (url, _options, handlers) => {
  const socket = new WebSocket(url);
  socket.on('open', () => handlers.onOpen());
  socket.on('message', (data) => handlers.onMessage(String(data)));
  socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));
  socket.on('error', (error) => handlers.onError(error));
  return {
    send: (text) => socket.send(text),
    close: (code, reason) => socket.close(code, reason),
  };
};
