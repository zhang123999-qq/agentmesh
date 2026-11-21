import { readFileSync } from 'node:fs';

import type { AgentMeshClient } from '@agentmesh/sdk';

import { optionalInt, optionalString, requireString, UsageError } from '../args.js';
import { emit, type CommandContext } from '../context.js';
import { formatHistory } from '../format.js';

function readStdin(): string {
  return readFileSync(0, 'utf8');
}

export async function runMessageSend(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const channelId = requireString(ctx.args, 'channel');
  const body =
    ctx.args.flags['body-stdin'] === true
      ? readStdin()
      : optionalString(ctx.args, 'body');
  if (body === undefined || body.length === 0) {
    throw new UsageError('message send requires --body (or --body-stdin)');
  }
  const result = await client.sendMessage({ channelId, body });
  emit(
    ctx,
    result,
    `sent ${result.message.messageId} to ${channelId} (seq ${result.message.seq}, delivered to ${result.delivered})`,
  );
}

export async function runMessageHistory(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const channelId = requireString(ctx.args, 'channel');
  const beforeSeq = optionalInt(ctx.args, 'before-seq');
  const afterSeq = optionalInt(ctx.args, 'after-seq');
  const limit = optionalInt(ctx.args, 'limit');
  const result = await client.history({
    channelId,
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(afterSeq === undefined ? {} : { afterSeq }),
    ...(limit === undefined ? {} : { limit }),
  });
  emit(ctx, result, formatHistory(result));
}
