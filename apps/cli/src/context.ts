import type { AgentMeshClient } from '@agentmesh/sdk';

import type { ParsedArgs } from './args.js';
import type { ConfigPatch, ResolvedConfig } from './config.js';

/** Everything a command needs besides the connected client. */
export interface CommandContext {
  readonly args: ParsedArgs;
  readonly config: ResolvedConfig;
  readonly json: boolean;
  readonly out: (text: string) => void;
  /** Persist `url` / `agentId` / `token` to the active config file. */
  readonly save: (patch: ConfigPatch) => void;
}

export type ClientFactory = (
  config: ResolvedConfig,
  options: { readonly autoReconnect: boolean },
) => AgentMeshClient;

/** Print `human` normally, or the JSON view (same shape as the SDK result). */
export function emit(ctx: CommandContext, value: unknown, human: string): void {
  ctx.out(ctx.json ? JSON.stringify(value, null, 2) : human);
}
