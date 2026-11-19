import { z } from 'zod';

/**
 * Protocol version & negotiation.
 *
 * Version negotiation is carried on the handshake in two places:
 *  - the `protocolVersion` field of the JSON-RPC handshake params
 *    (see `protocolNegotiationSchema`, used by `agent.register` /
 *    `agent.authenticate` and by the WS upgrade),
 *  - the `protocolVersion` field of the `welcome` server frame, which echoes
 *    the version the server actually settled on.
 *
 * Compatibility rule (MVP): the MAJOR component must match. A client whose
 * major differs is rejected with `JsonRpcErrorCode.ProtocolVersionIncompatible`
 * (-32006) instead of being served with half-understood frames.
 */

export const PROTOCOL_VERSION = '1.0.0' as const;

/** Oldest protocol version this build can still talk to. */
export const MIN_SUPPORTED_PROTOCOL_VERSION = '1.0.0' as const;

export const protocolVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'protocolVersion must be MAJOR.MINOR.PATCH');

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;

export const clientInfoSchema = z.object({
  /** e.g. "agentmesh-sdk", "agentmesh-cli", "agentmesh-web" */
  name: z.string().min(1),
  version: z.string().min(1).optional(),
});

/**
 * Handshake negotiation field group. Transports merge these fields into the
 * params of the first request (or into the WS upgrade payload).
 */
export const protocolNegotiationSchema = z.object({
  protocolVersion: protocolVersionSchema,
  client: clientInfoSchema.optional(),
});

export type ProtocolNegotiation = z.infer<typeof protocolNegotiationSchema>;

export interface ParsedProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

export function parseProtocolVersion(version: string): ParsedProtocolVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

/**
 * Returns true when `remote` shares the MAJOR version with `supported`
 * (defaults to the version this build implements) and is not older than
 * `MIN_SUPPORTED_PROTOCOL_VERSION`.
 */
export function isProtocolVersionCompatible(
  remote: string,
  supported: string = PROTOCOL_VERSION,
): boolean {
  const a = parseProtocolVersion(remote);
  const b = parseProtocolVersion(supported);
  const floor = parseProtocolVersion(MIN_SUPPORTED_PROTOCOL_VERSION);
  if (!a || !b || !floor) return false;
  if (a.major !== b.major) return false;
  if (a.major === floor.major && a.minor < floor.minor) return false;
  return true;
}

export interface ProtocolNegotiationResult {
  compatible: boolean;
  /** Version the server will speak; the local version when incompatible. */
  negotiated: string;
  /** Version reported by the peer, if any. */
  requested?: string;
}

/**
 * Server-side negotiation helper: pick the version the session will use.
 * A missing version is treated as "same as ours" for third-party clients
 * that predate negotiation, but the response always states the version
 * explicitly so clients can detect a mismatch.
 */
export function negotiateProtocolVersion(
  requested?: string,
  supported: string = PROTOCOL_VERSION,
): ProtocolNegotiationResult {
  if (!requested) return { compatible: true, negotiated: supported };
  return {
    compatible: isProtocolVersionCompatible(requested, supported),
    negotiated: supported,
    requested,
  };
}
