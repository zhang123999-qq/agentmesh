import type { AgentMeshClient } from '@agentmesh/sdk';

import { optionalInt, optionalString, requireString } from '../args.js';
import { emit, type CommandContext } from '../context.js';
import { formatChannels } from '../format.js';

export async function runChannelCreate(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const name = requireString(ctx.args, 'name');
  const result = await client.createChannel({ name });
  emit(
    ctx,
    result,
    `created channel ${result.channel.channelId} (${result.channel.name})`,
  );
}

export async function runChannelJoin(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const channelId = requireString(ctx.args, 'channel');
  const agentId = optionalString(ctx.args, 'agent');
  const result = await client.joinChannel({
    channelId,
    ...(agentId === undefined ? {} : { agentId }),
  });
  emit(ctx, result, `joined channel ${channelId}`);
}

export async function runChannelLeave(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const channelId = requireString(ctx.args, 'channel');
  const agentId = optionalString(ctx.args, 'agent');
  const result = await client.leaveChannel({
    channelId,
    ...(agentId === undefined ? {} : { agentId }),
  });
  emit(ctx, result, `left channel ${channelId}`);
}

export async function runChannelList(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const limit = optionalInt(ctx.args, 'limit');
  const offset = optionalInt(ctx.args, 'offset');
  const result = await client.listChannels({
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  emit(ctx, result, formatChannels(result.channels));
}
