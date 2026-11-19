/**
 * Structured JSON logging (pino).
 *
 * Every line is one JSON object. Request-scoped lines always carry the
 * correlation fields `reqId`, `method`, `agentId` and `durationMs`, plus
 * `err` when something failed:
 *
 * ```json
 * {"level":"info","ts":"2026-11-17T09:00:00.000Z","service":"agentmesh-server",
 *  "reqId":"...","method":"task.list","agentId":"agt_1","durationMs":1.23,
 *  "msg":"rpc.request.completed"}
 * ```
 *
 * `system.error` notifications reuse the same `reqId` (see the dispatcher),
 * so a client-visible error can always be traced back to its log line.
 */

import { ProtocolError } from '@agentmesh/protocol';
import pino from 'pino';
import type { DestinationStream, Logger, LoggerOptions } from 'pino';

import { SERVER_NAME, type LogLevel } from './config.js';

/** Fields every request-scoped log line is guaranteed to contain. */
export interface RequestLogFields {
  readonly reqId: string;
  readonly method: string | null;
  readonly agentId: string | null;
}

/** Correlation fields plus the measured handler duration. */
export interface RequestLogLine extends RequestLogFields {
  readonly durationMs: number;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Extra base fields merged into every line (e.g. `{version}` in tests). */
  base?: Record<string, unknown>;
  /** pino destination stream; defaults to stdout. Useful for test capture. */
  destination?: DestinationStream;
}

/**
 * Create the server logger. Output is always JSON (no pretty transport) so
 * containers can ship logs without re-formatting.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { service: SERVER_NAME, ...options.base },
    // Rename pino's default `time` to `ts` and emit ISO-8601.
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    // Emit the level as a string label (info/warn/error/...).
    formatters: {
      level: (label) => ({ level: label }),
      bindings: (bindings) => bindings,
    },
    // Defence in depth: even if a caller accidentally logs a credential, the
    // output never contains it. Never rely on this instead of not logging it.
    redact: {
      paths: [
        'secret',
        'token',
        'password',
        'secretHash',
        'secret_hash',
        'err.body',
        'err.request',
        'err.payload',
        'req.body',
        'request.body',
        'req.payload',
        'request.payload',
        'req.headers.authorization',
        'authorization',
        '*.authorization',
        '*.secret',
        '*.token',
        '*.password',
        '*.secretHash',
        '*.secret_hash',
        'params.secret',
        'params.token',
      ],
      censor: '[Redacted]',
    },
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

/**
 * Serialize an unknown thrown value for the `err` log field. ProtocolError
 * keeps its JSON-RPC `code`/`data`, plain Errors keep name/message/stack.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof ProtocolError) {
    return {
      type: err.name,
      message: err.message,
      code: err.code,
      ...(err.data === undefined ? {} : { data: err.data }),
      ...(err.stack === undefined ? {} : { stack: err.stack }),
    };
  }
  if (err instanceof Error) {
    const serialized: Record<string, unknown> = {
      type: err.name,
      message: err.message,
    };
    if (err.stack !== undefined) serialized.stack = err.stack;
    const code = (err as { code?: unknown }).code;
    if (code !== undefined) serialized.code = code;
    return serialized;
  }
  return { type: 'UnknownError', message: String(err) };
}

/**
 * Build the mandatory correlation fields. Missing values become `null` so the
 * key is always present on the JSON line.
 */
export function requestLogFields(
  reqId: string,
  method: string | null,
  agentId: string | null,
): RequestLogFields {
  return { reqId, method, agentId };
}

/** Child logger bound to a request's correlation fields. */
export function requestLogger(parent: Logger, reqId: string): Logger {
  return parent.child({ reqId });
}
