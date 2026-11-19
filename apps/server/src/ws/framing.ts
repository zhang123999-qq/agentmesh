/**
 * WebSocket framing helpers.
 *
 * A WS text frame is one of two things (see `@agentmesh/protocol`):
 *
 * 1. a **control frame** — `welcome` / `ack` / `gap_too_large` / `resume` /
 *    `ping` / `pong`: top-level JSON objects discriminated by `type`, used for
 *    handshake and resume bookkeeping;
 * 2. a **JSON-RPC envelope** — request / notification (inbound) or
 *    response (outbound), dispatched through the shared `RpcDispatcher`.
 *
 * This module is the only place that knows how to turn bytes into those
 * objects and how to build outbound frames, so `gateway.ts` / `session.ts`
 * stay transport plumbing and `@agentmesh/protocol` stays the single source
 * of truth for the wire contract.
 */

import {
  JSON_RPC_VERSION,
  PROTOCOL_VERSION,
  resumeFrameSchema,
} from '@agentmesh/protocol';
import type {
  AckFrame,
  ClientControlFrame,
  GapTooLargeFrame,
  JsonRpcErrorCode,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcParams,
  PingFrame,
  PongFrame,
  PresenceUpdatePayload,
  ResumeFrame,
  WelcomeFrame,
} from '@agentmesh/protocol';
import type { StoredEvent } from '@agentmesh/store';

import type { RpcResponse } from '../dispatcher.js';

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type DecodedFrame =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/** WS `RawData` (Buffer / ArrayBuffer / Buffer[]) → UTF-8 text. */
function rawToText(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data as Buffer[]).toString('utf8');
  }
  return undefined;
}

/**
 * Decode one inbound WS frame. Non-JSON text is *not* an exception: the
 * gateway answers it with a `-32700` frame, mirroring the HTTP transport.
 */
export function decodeFrame(data: unknown): DecodedFrame {
  const text = rawToText(data);
  if (text === undefined) return { ok: false, reason: 'unsupported payload type' };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid JSON' };
  }
}

/** Serialise any outbound frame (control frame or JSON-RPC envelope). */
export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Control frames
// ---------------------------------------------------------------------------

/** `type` of a control frame, when the value is a candidate one. */
export function controlFrameType(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const type = (value as Record<string, unknown>).type;
  return typeof type === 'string' ? type : undefined;
}

/** Validated `resume` frame, or `undefined` when it is malformed. */
export function readResumeFrame(value: unknown): ResumeFrame | undefined {
  const parsed = resumeFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Echo the `ts` of an inbound ping (absent stays absent). */
export function readPingTs(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const ts = (value as Record<string, unknown>).ts;
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined;
}

/**
 * Client-supplied control frame the gateway understands. `pong` is accepted
 * from clients too (a peer may answer our protocol-level ping explicitly).
 */
export function readClientControlFrame(value: unknown): ClientControlFrame | undefined {
  const type = controlFrameType(value);
  if (type === 'resume') return readResumeFrame(value);
  if (type === 'ping') {
    const ts = readPingTs(value);
    return ts === undefined ? { type: 'ping' } : { type: 'ping', ts };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Outbound frames
// ---------------------------------------------------------------------------

export interface WelcomeFrameInput {
  readonly epoch: string;
  readonly seq: number;
  readonly agentId?: string;
  readonly replayWindow?: number;
  readonly heartbeatIntervalMs?: number;
  readonly serverTime?: number;
}

/** `welcome` — always sent after authentication succeeds, always has `epoch`. */
export function buildWelcomeFrame(input: WelcomeFrameInput): WelcomeFrame {
  return {
    type: 'welcome',
    epoch: input.epoch,
    seq: input.seq,
    protocolVersion: PROTOCOL_VERSION,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.replayWindow === undefined ? {} : { replayWindow: input.replayWindow }),
    ...(input.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: input.heartbeatIntervalMs }),
    ...(input.serverTime === undefined ? {} : { serverTime: input.serverTime }),
  };
}

/** `ack` — confirms the replay window a resume is about to serve. */
export function buildAckFrame(epoch: string, seq: number, requestId?: JsonRpcId): AckFrame {
  return {
    type: 'ack',
    epoch,
    seq,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export interface GapTooLargeInput {
  readonly epoch: string;
  readonly fromSeq: number;
  readonly currentSeq: number;
  readonly window: number;
  readonly detail?: string;
}

/**
 * `gap_too_large` — the degradation signal. Two reasons exist today:
 * `epoch_mismatch` (server restarted, cursors are meaningless) and
 * `buffer_exceeded` (gap larger than the replay window). Both mean "do a cold
 * full-state fetch", never "retry resume".
 */
export function buildGapTooLargeFrame(input: GapTooLargeInput): GapTooLargeFrame {
  return {
    type: 'gap_too_large',
    signal: 'gap_too_large',
    epoch: input.epoch,
    fromSeq: input.fromSeq,
    currentSeq: input.currentSeq,
    window: input.window,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  };
}

export function buildPongFrame(ts?: number): PongFrame {
  return ts === undefined ? { type: 'pong' } : { type: 'pong', ts };
}

export function buildPingFrame(ts?: number): PingFrame {
  return ts === undefined ? { type: 'ping' } : { type: 'ping', ts };
}

// ---------------------------------------------------------------------------
// Event / presence notifications
// ---------------------------------------------------------------------------

/**
 * Event log row → push notification.
 *
 * `method` is the event type itself (see `EVENT_NOTIFICATION_METHODS`) and
 * `params` is the event envelope, so the client dedupes on the globally
 * unique `seq` carried inside it.
 */
export function eventNotification(event: StoredEvent): JsonRpcNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: event.type,
    params: {
      seq: event.seq,
      aggregateId: event.aggregateId,
      type: event.type,
      version: event.version,
      payload: event.payload,
      ts: event.ts,
      ...(event.prevHash === null ? {} : { prevHash: event.prevHash }),
    } as unknown as JsonRpcParams,
  };
}

/** Presence is ephemeral (not appended to the log) — see gateway docs. */
export function presenceNotification(payload: PresenceUpdatePayload): JsonRpcNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: 'presence.update',
    params: payload as unknown as JsonRpcParams,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC error frames
// ---------------------------------------------------------------------------

/** Error response with a free-form `id` (mirrors the dispatcher's shape). */
export function errorResponseFrame(
  id: unknown,
  code: JsonRpcErrorCode,
  message: string,
  data?: unknown,
): RpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
