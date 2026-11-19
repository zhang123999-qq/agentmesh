import { z } from 'zod';

/**
 * Standard error codes.
 *
 * -32600..-32603 are the JSON-RPC 2.0 reserved codes.
 * -32001..-32007 are the AgentMesh application codes.
 * `gap_too_large` is a *degradation signal* (not an error code): the server
 * returns it when a resume asks for more replay than the retained window can
 * serve, and the client must fall back to a cold full-state fetch.
 */

export const JsonRpcErrorCode = {
  // ---- JSON-RPC 2.0 reserved ----
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,

  // ---- AgentMesh application codes ----
  Unauthorized: -32001,
  Forbidden: -32002,
  InvalidState: -32003,
  NotFound: -32004,
  RateLimited: -32005,
  ProtocolVersionIncompatible: -32006,
  VersionConflict: -32007,
} as const;

export type JsonRpcErrorCode = (typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

const ERROR_CODE_VALUES: readonly number[] = Object.values(JsonRpcErrorCode);

export const jsonRpcErrorCodeSchema = z
  .number()
  .int()
  .refine((code): code is JsonRpcErrorCode => ERROR_CODE_VALUES.includes(code), {
    message: 'unknown AgentMesh error code',
  });

export const ERROR_MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  [JsonRpcErrorCode.ParseError]: 'Parse error',
  [JsonRpcErrorCode.InvalidRequest]: 'Invalid request',
  [JsonRpcErrorCode.MethodNotFound]: 'Method not found',
  [JsonRpcErrorCode.InvalidParams]: 'Invalid params',
  [JsonRpcErrorCode.InternalError]: 'Internal error',
  [JsonRpcErrorCode.Unauthorized]: 'Unauthorized',
  [JsonRpcErrorCode.Forbidden]: 'Forbidden',
  [JsonRpcErrorCode.InvalidState]: 'Invalid state transition',
  [JsonRpcErrorCode.NotFound]: 'Resource not found',
  [JsonRpcErrorCode.RateLimited]: 'Rate limit exceeded',
  [JsonRpcErrorCode.ProtocolVersionIncompatible]: 'Incompatible protocol version',
  [JsonRpcErrorCode.VersionConflict]: 'Version conflict',
});

/** Default human-readable message for a code. */
export function errorMessageFor(code: number): string {
  return ERROR_MESSAGES[code] ?? 'Unknown error';
}

// ---------------------------------------------------------------------------
// gap_too_large degradation signal
// ---------------------------------------------------------------------------

/**
 * Degradation signal returned when the replay window cannot cover the gap
 * between the client's `lastSeenSeq` and the current watermark.
 */
export const GAP_TOO_LARGE = 'gap_too_large' as const;

export const degradationSignalSchema = z.literal(GAP_TOO_LARGE);
export type DegradationSignal = z.infer<typeof degradationSignalSchema>;

/**
 * Structured `data` payload attached to a -32003 style rejection or to the
 * `gap_too_large` server frame. `window` is the number of events the server
 * is willing to replay.
 */
export const gapTooLargeDataSchema = z.object({
  signal: degradationSignalSchema,
  /** Epoch of the current seq space (see welcome frame). */
  epoch: z.string().min(1),
  /** First seq the client asked to be replayed from. */
  fromSeq: z.number().int().nonnegative(),
  /** Current global high-water mark. */
  currentSeq: z.number().int().nonnegative(),
  /** Max number of events that can be replayed in one resume. */
  window: z.number().int().positive(),
  /** Optional human-readable hint, e.g. "fall back to full state fetch". */
  detail: z.string().optional(),
});

export type GapTooLargeData = z.infer<typeof gapTooLargeDataSchema>;

export function isGapTooLargeData(value: unknown): value is GapTooLargeData {
  return gapTooLargeDataSchema.safeParse(value).success;
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

/**
 * Transport-independent protocol error. Server handlers throw it, the
 * dispatcher converts it into a JSON-RPC error response.
 */
export class ProtocolError extends Error {
  readonly code: JsonRpcErrorCode;
  readonly data?: unknown;

  constructor(code: JsonRpcErrorCode, message?: string, data?: unknown) {
    super(message ?? errorMessageFor(code));
    this.name = 'ProtocolError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  toErrorObject(): { code: JsonRpcErrorCode; message: string; data?: unknown } {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }

  static isVersionConflict(err: unknown): boolean {
    return err instanceof ProtocolError && err.code === JsonRpcErrorCode.VersionConflict;
  }
}
