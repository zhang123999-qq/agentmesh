import { z } from 'zod';

import { jsonRpcErrorCodeSchema } from './errors.js';
import type { JsonRpcErrorCode } from './errors.js';

/**
 * JSON-RPC 2.0 envelopes.
 *
 * All AgentMesh transports (WebSocket for agents/SDK, HTTP POST for admin
 * tooling) frame their traffic with these schemas, so the server, the SDK and
 * the web app validate exactly the same wire format.
 *
 * Envelopes intentionally *strip* unknown members instead of rejecting them,
 * so that a newer peer adding optional fields does not break an older one.
 */

export const JSON_RPC_VERSION = '2.0' as const;

export const jsonRpcIdSchema = z.union([z.string().min(1), z.number().finite()]);
export type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;

/** JSON-RPC params: named (object) or positional (array). */
export const jsonRpcParamsSchema = z.union([
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
export type JsonRpcParams = z.infer<typeof jsonRpcParamsSchema>;

export const jsonRpcErrorObjectSchema = z.object({
  code: jsonRpcErrorCodeSchema,
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof jsonRpcErrorObjectSchema>;

/** A call that expects a response (`id` present). */
export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  method: z.string().min(1),
  params: jsonRpcParamsSchema.optional(),
});
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;

/** A fire-and-forget message (no `id`, never answered). */
export const jsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string().min(1),
  params: jsonRpcParamsSchema.optional(),
});
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

export const jsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: jsonRpcIdSchema,
  result: z.unknown(),
});
export type JsonRpcSuccessResponse = z.infer<typeof jsonRpcSuccessResponseSchema>;

export const jsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal(JSON_RPC_VERSION),
  id: z.union([jsonRpcIdSchema, z.null()]),
  error: jsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof jsonRpcErrorResponseSchema>;

export const jsonRpcResponseSchema = z.union([
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

/** Any framed message travelling over an AgentMesh transport. */
export const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcNotificationSchema,
  jsonRpcSuccessResponseSchema,
  jsonRpcErrorResponseSchema,
]);
export type JsonRpcMessage = z.infer<typeof jsonRpcMessageSchema>;

// ---------------------------------------------------------------------------
// Parsing & narrowing helpers
// ---------------------------------------------------------------------------

export function parseJsonRpcMessage(input: unknown): JsonRpcMessage {
  return jsonRpcMessageSchema.parse(input);
}

export function safeParseJsonRpcMessage(
  input: unknown,
): z.ZodSafeParseResult<JsonRpcMessage> {
  return jsonRpcMessageSchema.safeParse(input);
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isJsonRpcNotification(
  message: JsonRpcMessage,
): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'result' in message || 'error' in message;
}

export type JsonRpcMessageKind = 'request' | 'notification' | 'response';

export function jsonRpcMessageKind(message: JsonRpcMessage): JsonRpcMessageKind {
  if (isJsonRpcResponse(message)) return 'response';
  if (isJsonRpcNotification(message)) return 'notification';
  return 'request';
}

// ---------------------------------------------------------------------------
// Builders (used by the SDK, CLI and server)
// ---------------------------------------------------------------------------

let idCounter = 0;

/** Monotonic numeric request id generator (per-process). */
export function nextJsonRpcId(): number {
  idCounter += 1;
  return idCounter;
}

export function createJsonRpcRequest(
  method: string,
  params?: JsonRpcParams,
  id: JsonRpcId = nextJsonRpcId(),
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: JSON_RPC_VERSION, id, method }
    : { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

export function createJsonRpcNotification(
  method: string,
  params?: JsonRpcParams,
): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: JSON_RPC_VERSION, method }
    : { jsonrpc: JSON_RPC_VERSION, method, params };
}

export function createJsonRpcSuccessResponse(
  id: JsonRpcId,
  result: unknown,
): JsonRpcSuccessResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function createJsonRpcErrorResponse(
  id: JsonRpcId | null,
  code: JsonRpcErrorCode,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  const error: JsonRpcErrorObject =
    data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: JSON_RPC_VERSION, id, error };
}
