import type { AgentMeshClient } from '@agentmesh/sdk';

import { optionalInt, requireString } from '../args.js';
import { emit, type CommandContext } from '../context.js';

/** `agentmesh workspace create --name <n> [--max-agents <n>]` (platform admin). */
export async function runWorkspaceCreate(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const name = requireString(ctx.args, 'name');
  const maxAgents = optionalInt(ctx.args, 'max-agents');
  const result = await client.createWorkspace({
    name,
    ...(maxAgents === undefined ? {} : { maxAgents }),
  });
  emit(
    ctx,
    result,
    `created workspace ${result.workspace.id} (invite: ${result.inviteCode}, maxAgents: ${result.workspace.maxAgents})`,
  );
}

/** `agentmesh workspace list` (platform admin). */
export async function runWorkspaceList(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const result = await client.listWorkspaces();
  const lines = result.workspaces
    .map(
      (w) =>
        `${w.id}  ${w.name}  agents<=${w.maxAgents}${w.disabledAt === null ? '' : '  [DISABLED]'}`,
    )
    .join('\n');
  emit(ctx, result, lines.length > 0 ? lines : '(no workspaces)');
}

/** `agentmesh workspace disable --workspace <id>` (platform admin). */
export async function runWorkspaceDisable(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const workspaceId = requireString(ctx.args, 'workspace');
  const result = await client.disableWorkspace({ workspaceId });
  emit(ctx, result, `disabled workspace ${workspaceId}`);
}
