import { z } from 'zod';

import { GAP_TOO_LARGE } from './errors.js';
import { epochSchema, watermarkSeqSchema } from './events.js';
import { jsonRpcIdSchema } from './jsonrpc.js';
import { protocolVersionSchema } from './version.js';

/**
 * Transport control frames (WebSocket top-level frames, not JSON-RPC
 * envelopes). They carry the `seq`/`epoch` bookkeeping needed for resume.
 *
 * - `welcome`  server → client, on every (re)connect: epoch + current seq
 *              watermark + negotiated protocol version.
 * - `ack`      server → client, after a resume: confirms the replay window
 *              it is about to serve (always carries `epoch`).
 * - `gap_too_large` server → client: replay window exceeded, the client must
 *              fall back to a cold full-state fetch.
 * - `resume`   client → server: `lastSeenSeq` + `lastSeenEpoch`.
 */

export const welcomeFrameSchema = z.object({
  type: z.literal('welcome'),
  /** Generation of the `seq` space; a new epoch invalidates old cursors. */
  epoch: epochSchema,
  /** Global high-water mark at connect time. */
  seq: watermarkSeqSchema,
  /** Protocol version the server settled on (negotiation result). */
  protocolVersion: protocolVersionSchema,
  /** Agent bound to this connection when already authenticated. */
  agentId: z.string().optional(),
  /** Server wall clock (ms) for client clock skew detection. */
  serverTime: z.number().int().nonnegative().optional(),
  /** Max events the server will replay in a single resume. */
  replayWindow: z.number().int().positive().optional(),
  /** Heartbeat interval the client should honour. */
  heartbeatIntervalMs: z.number().int().positive().optional(),
});
export type WelcomeFrame = z.infer<typeof welcomeFrameSchema>;

export const ackFrameSchema = z.object({
  type: z.literal('ack'),
  /** Always present: clients must compare it with their own epoch. */
  epoch: epochSchema,
  /** High-water mark the replay will reach. */
  seq: watermarkSeqSchema,
  /** JSON-RPC id of the request being acknowledged, when applicable. */
  requestId: jsonRpcIdSchema.optional(),
});
export type AckFrame = z.infer<typeof ackFrameSchema>;

export const resumeFrameSchema = z.object({
  type: z.literal('resume'),
  /** Last globally unique `seq` the client fully processed (0 = none). */
  lastSeenSeq: watermarkSeqSchema,
  /**
   * Epoch the client believes it is in. Optional for third-party backward
   * compatibility: when absent the server assumes a match. The official SDK
   * always sends it (see US-006 / US-014).
   */
  lastSeenEpoch: epochSchema.optional(),
  protocolVersion: protocolVersionSchema.optional(),
});
export type ResumeFrame = z.infer<typeof resumeFrameSchema>;

export const gapTooLargeFrameSchema = z.object({
  type: z.literal('gap_too_large'),
  signal: z.literal(GAP_TOO_LARGE),
  epoch: epochSchema,
  /** First seq the client asked to be replayed from. */
  fromSeq: watermarkSeqSchema,
  /** Current global high-water mark. */
  currentSeq: watermarkSeqSchema,
  /** Max events replayable in one resume. */
  window: z.number().int().positive(),
  detail: z.string().optional(),
});
export type GapTooLargeFrame = z.infer<typeof gapTooLargeFrameSchema>;

export const pingFrameSchema = z.object({
  type: z.literal('ping'),
  ts: z.number().int().nonnegative().optional(),
});
export type PingFrame = z.infer<typeof pingFrameSchema>;

export const pongFrameSchema = z.object({
  type: z.literal('pong'),
  ts: z.number().int().nonnegative().optional(),
});
export type PongFrame = z.infer<typeof pongFrameSchema>;

/** Frames a client is allowed to send. */
export const clientControlFrameSchema = z.discriminatedUnion('type', [
  resumeFrameSchema,
  pingFrameSchema,
]);
export type ClientControlFrame = z.infer<typeof clientControlFrameSchema>;

/** Frames the server may send. */
export const serverControlFrameSchema = z.discriminatedUnion('type', [
  welcomeFrameSchema,
  ackFrameSchema,
  gapTooLargeFrameSchema,
  pongFrameSchema,
]);
export type ServerControlFrame = z.infer<typeof serverControlFrameSchema>;

export const controlFrameSchema = z.discriminatedUnion('type', [
  welcomeFrameSchema,
  ackFrameSchema,
  resumeFrameSchema,
  gapTooLargeFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
]);
export type ControlFrame = z.infer<typeof controlFrameSchema>;

export function isControlFrame(value: unknown): value is ControlFrame {
  return controlFrameSchema.safeParse(value).success;
}
