import type { AgentMeshClient } from '@agentmesh/sdk';
import { describe, expect, it, vi } from 'vitest';

import { parseArgs, UsageError } from '../src/args.js';
import {
  runWorkspaceCreate,
  runWorkspaceDisable,
  runWorkspaceList,
} from '../src/commands/workspace.js';
import type { CommandContext } from '../src/context.js';

function context(argv: readonly string[], json = false): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const args = parseArgs(['workspace', ...argv]);
  return {
    lines,
    ctx: {
      args,
      config: {} as CommandContext['config'],
      json,
      out: (text) => lines.push(text),
      save: () => {},
    },
  };
}

function fakeClient(overrides: Partial<Record<keyof AgentMeshClient, unknown>> = {}) {
  const client = {
    createWorkspace: vi.fn(async (params: { name: string; maxAgents?: number }) => ({
      workspace: {
        id: 'ws_new',
        name: params.name,
        createdAt: 1,
        maxAgents: params.maxAgents ?? 100,
        disabledAt: null,
      },
      inviteCode: 'invite-1',
      inviteExpiresAt: 2,
    })),
    listWorkspaces: vi.fn(async () => ({
      workspaces: [
        { id: 'ws_a', name: 'Alpha', createdAt: 1, maxAgents: 50, disabledAt: null },
        { id: 'ws_b', name: 'Beta', createdAt: 2, maxAgents: 10, disabledAt: 3 },
      ],
    })),
    disableWorkspace: vi.fn(async (params: { workspaceId: string }) => ({
      disabled: true as const,
      workspaceId: params.workspaceId,
    })),
  };
  return Object.assign(client, overrides) as unknown as AgentMeshClient & typeof client;
}

describe('agentmesh workspace commands', () => {
  it('creates a tenant with an optional quota', async () => {
    const client = fakeClient();
    const { ctx, lines } = context(['create', '--name', 'Acme', '--max-agents', '50']);

    await runWorkspaceCreate(client, ctx);

    expect(client.createWorkspace).toHaveBeenCalledWith({ name: 'Acme', maxAgents: 50 });
    expect(lines[0]).toContain('created workspace ws_new');
    expect(lines[0]).toContain('invite-1');
    expect(lines[0]).toContain('maxAgents: 50');
  });

  it('omits maxAgents when the flag is absent and rejects a missing name', async () => {
    const client = fakeClient();
    const { ctx } = context(['create', '--name', 'Beta']);
    await runWorkspaceCreate(client, ctx);
    expect(client.createWorkspace).toHaveBeenCalledWith({ name: 'Beta' });

    const missing = context(['create']);
    await expect(runWorkspaceCreate(client, missing.ctx)).rejects.toBeInstanceOf(UsageError);
  });

  it('lists tenants with quota and a disabled marker', async () => {
    const client = fakeClient();
    const { ctx, lines } = context(['list']);

    await runWorkspaceList(client, ctx);

    expect(lines[0]).toContain('ws_a  Alpha  agents<=50');
    expect(lines[0]).toContain('ws_b  Beta  agents<=10  [DISABLED]');
  });

  it('prints (no workspaces) and JSON when requested', async () => {
    const empty = fakeClient({ listWorkspaces: vi.fn(async () => ({ workspaces: [] })) });
    const human = context(['list']);
    await runWorkspaceList(empty, human.ctx);
    expect(human.lines[0]).toBe('(no workspaces)');

    const client = fakeClient();
    const asJson = context(['list'], true);
    await runWorkspaceList(client, asJson.ctx);
    expect(JSON.parse(asJson.lines[0] ?? '{}')).toEqual({
      workspaces: [
        { id: 'ws_a', name: 'Alpha', createdAt: 1, maxAgents: 50, disabledAt: null },
        { id: 'ws_b', name: 'Beta', createdAt: 2, maxAgents: 10, disabledAt: 3 },
      ],
    });
  });

  it('disables a tenant and requires --workspace', async () => {
    const client = fakeClient();
    const { ctx, lines } = context(['disable', '--workspace', 'ws_b']);

    await runWorkspaceDisable(client, ctx);
    expect(client.disableWorkspace).toHaveBeenCalledWith({ workspaceId: 'ws_b' });
    expect(lines[0]).toBe('disabled workspace ws_b');

    const missing = context(['disable']);
    await expect(runWorkspaceDisable(client, missing.ctx)).rejects.toBeInstanceOf(UsageError);
  });
});
