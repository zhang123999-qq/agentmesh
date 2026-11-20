/**
 * @agentmesh/protocol — the AgentMesh wire contract.
 *
 * Single source of truth for JSON-RPC 2.0 envelopes, event envelopes and
 * payloads, control frames, method names, error codes and protocol version
 * negotiation. Imported by the server, the SDK and the web app so all of them
 * speak one typed contract.
 */

export * from './version.js';
export * from './errors.js';
export * from './jsonrpc.js';
export * from './events.js';
export * from './frames.js';
export * from './methods.js';
export * from './params.js';
