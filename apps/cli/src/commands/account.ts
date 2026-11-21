import { readFileSync } from 'node:fs';

import { isAccountRole } from '@agentmesh/protocol';
import type { AgentMeshClient } from '@agentmesh/sdk';

import {
  optionalInt,
  optionalList,
  optionalString,
  requireString,
  UsageError,
} from '../args.js';
import { ConfigError } from '../config.js';
import { emit, type CommandContext } from '../context.js';
import { formatTable, formatTime } from '../format.js';
import { decodeTokenClaims, isTokenExpired, maskToken } from '../token.js';

function readStdin(): string {
  return readFileSync(0, 'utf8').replace(/\r?\n$/, '');
}

export async function runRegister(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const name = requireString(ctx.args, 'name');
  const owner = optionalString(ctx.args, 'owner');
  const skills = optionalList(ctx.args, 'skills');
  const role = optionalString(ctx.args, 'role');
  if (role !== undefined && !isAccountRole(role)) {
    throw new UsageError('--role must be one of admin, agent, observer');
  }

  const result = await client.register({
    name,
    ...(owner === undefined ? {} : { owner }),
    ...(skills === undefined ? {} : { skills }),
    ...(role === undefined ? {} : { role }),
  });
  ctx.save({ agentId: result.agentId, token: result.token });

  emit(
    ctx,
    result,
    [
      `registered ${result.agentId} (role ${result.role})`,
      ...(result.secret === undefined
        ? []
        : [`secret (shown once): ${result.secret}`]),
      `token saved to ${ctx.config.path}`,
    ].join('\n'),
  );
}

export async function runLogin(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const agentId =
    optionalString(ctx.args, 'agent-id') ??
    optionalString(ctx.args, 'agent') ??
    ctx.config.agentId;
  const name = optionalString(ctx.args, 'name');
  const secret = ctx.args.flags['secret-stdin'] === true
    ? readStdin()
    : optionalString(ctx.args, 'secret');

  if (agentId === undefined && name === undefined) {
    throw new UsageError('login requires --agent-id (or --name)');
  }
  if (secret === undefined && ctx.config.token === undefined) {
    throw new UsageError(
      'login requires --secret (or --secret-stdin), or an existing token to refresh',
    );
  }

  const result = await client.authenticate({
    ...(agentId === undefined ? {} : { agentId }),
    ...(name === undefined ? {} : { name }),
    ...(secret === undefined ? {} : { secret }),
  });
  ctx.save({ agentId: result.agentId, token: result.token });

  emit(
    ctx,
    result,
    [
      `authenticated as ${result.agentId} (role ${result.role})`,
      `expires at ${formatTime(result.expiresAt * 1000)}`,
      `token saved to ${ctx.config.path}`,
    ].join('\n'),
  );
}

export function runLogout(ctx: CommandContext): void {
  ctx.save({ token: null });
  emit(ctx, { loggedOut: true, path: ctx.config.path }, `logged out (${ctx.config.path})`);
}

export function runWhoami(ctx: CommandContext): void {
  if (ctx.config.token === undefined) {
    throw new ConfigError('not logged in; run `agentmesh login`');
  }
  const claims = decodeTokenClaims(ctx.config.token);
  if (claims === undefined) {
    throw new ConfigError('stored token is not a readable JWT; run `agentmesh login`');
  }
  const expired = isTokenExpired(claims);
  const view = {
    agentId: claims.sub ?? null,
    role: claims.role ?? null,
    workspaceId: claims.workspaceId ?? null,
    expiresAt: claims.exp === undefined ? null : claims.exp * 1000,
    expired,
    token: maskToken(ctx.config.token),
  };
  emit(
    ctx,
    view,
    [
      `agent:     ${view.agentId ?? '-'}`,
      `role:      ${view.role ?? '-'}`,
      `workspace: ${view.workspaceId ?? '-'}`,
      `expires:   ${view.expiresAt === null ? '-' : formatTime(view.expiresAt)}` +
        (expired ? ' (expired)' : ''),
      `token:     ${view.token}`,
    ].join('\n'),
  );
}

export async function runAgentList(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const role = optionalString(ctx.args, 'role');
  if (role !== undefined && !isAccountRole(role)) {
    throw new UsageError('--role must be one of admin, agent, observer');
  }
  const limit = optionalInt(ctx.args, 'limit');
  const offset = optionalInt(ctx.args, 'offset');
  const result = await client.listAccounts({
    ...(role === undefined ? {} : { role }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  emit(
    ctx,
    result,
    formatTable(
      ['ID', 'NAME', 'ROLE', 'OWNER', 'SKILLS'],
      result.accounts.map((account) => [
        account.agentId,
        account.name,
        account.role,
        account.owner ?? '-',
        account.skills.length === 0 ? '-' : account.skills.join(', '),
      ]),
    ),
  );
}
