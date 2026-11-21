import { ForbiddenError } from '@agentmesh/sdk';
import type { AgentMeshClient, AuthResult } from '@agentmesh/sdk';
import { describe, expect, it } from 'vitest';

import {
  CodexAdapter,
  GrokAdapter,
  HermesAdapter,
  MuseAdapter,
  OpenclawAdapter,
  type AdapterAbortEvent,
  type AdapterAssignedEvent,
  type AdapterReviewEvent,
} from '../src/index.js';

type Handler = (payload: unknown, envelope?: unknown) => void;

class MockClient {
  readonly handlers = new Map<string, Set<Handler>>();
  readonly connectionHandlers = new Set<Handler>();
  readonly calls: Array<{ method: string; params: unknown }> = [];
  failNextProgress = false;

  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  onConnection(handler: Handler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  emit(type: string, payload: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(payload);
  }

  async register(params: unknown): Promise<AuthResult> {
    this.calls.push({ method: 'register', params });
    return { agentId: 'agt_1', token: 'token-1', role: 'agent', expiresAt: 1 };
  }

  async authenticate(params: unknown): Promise<AuthResult> {
    this.calls.push({ method: 'authenticate', params });
    return { agentId: 'agt_1', token: 'token-1', role: 'agent', expiresAt: 1 };
  }

  async joinChannel(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'join', params });
    return { joined: true };
  }

  async bid(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'bid', params });
    return { bid: {} };
  }

  async progress(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'progress', params });
    if (this.failNextProgress) {
      this.failNextProgress = false;
      throw new ForbiddenError('not assigned', { reason: 'not_assignee' });
    }
    return { task: {}, version: 1, seq: 1 };
  }

  async complete(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'complete', params });
    return { task: {}, version: 1, seq: 1 };
  }

  async fail(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'fail', params });
    return { task: {}, version: 1, seq: 1 };
  }

  async review(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'review', params });
    return { task: {}, version: 1, seq: 1 };
  }
}

function clientOf(mock: MockClient): AgentMeshClient {
  return mock as unknown as AgentMeshClient;
}

const base = {
  name: 'agent-a',
  skills: ['typescript'],
  role: 'admin' as const,
  availability: 0.5,
  maxConcurrentTasks: 2,
};

describe('adapter templates', () => {
  it('constructs all five templates with capabilities', () => {
    const mock = new MockClient();
    const deps = { client: clientOf(mock) };
    const adapters = [
      new GrokAdapter(deps, { ...base, provider: 'mock' }),
      new MuseAdapter(deps, { ...base, workspaceId: 'ws-1' }),
      new HermesAdapter(deps, { ...base, endpoint: 'https://hermes.example' }),
      new OpenclawAdapter(deps, { ...base, gatewayUrl: 'https://gateway.example' }),
      new CodexAdapter(deps, { ...base, sandboxId: 'sbx-1' }),
    ];

    expect(adapters.map((adapter) => adapter.provider)).toEqual([
      'grok',
      'muse',
      'hermes',
      'openclaw',
      'codex',
    ]);
    for (const adapter of adapters) {
      expect(adapter.getCapabilities()).toMatchObject({
        skills: ['typescript'],
        availability: 0.5,
        maxConcurrentTasks: 2,
        supportsReview: true,
      });
    }
  });

  it('validates template-specific config', () => {
    const deps = { client: clientOf(new MockClient()) };
    expect(
      () =>
        new GrokAdapter(deps, {
          ...base,
          provider: 'invalid' as unknown as 'mock',
        }),
    ).toThrow(/provider/);
    expect(
      () =>
        new MuseAdapter(deps, {
          ...base,
          workspaceId: '  ',
        }),
    ).toThrow(/workspaceId/);
    expect(
      () =>
        new HermesAdapter(deps, {
          ...base,
          endpoint: '',
        }),
    ).toThrow(/endpoint/);
    expect(
      () =>
        new OpenclawAdapter(deps, {
          ...base,
          gatewayUrl: '',
        }),
    ).toThrow(/gatewayUrl/);
    expect(
      () =>
        new CodexAdapter(deps, {
          ...base,
          sandboxId: '',
        }),
    ).toThrow(/sandboxId/);
  });

  it('registers through the injected SDK client', async () => {
    const mock = new MockClient();
    const adapter = new GrokAdapter({ client: clientOf(mock) }, { ...base, provider: 'mock' });
    const auth = await adapter.register();
    expect(auth.agentId).toBe('agt_1');
    expect(adapter.agentId).toBe('agt_1');
    expect(mock.calls[0]).toMatchObject({
      method: 'register',
      params: { name: 'agent-a', skills: ['typescript'], role: 'admin' },
    });
  });
});

describe('adapter abort / review contract', () => {
  it('fires onAborted on reassignment away from this agent', async () => {
    const mock = new MockClient();
    const aborts: AdapterAbortEvent[] = [];
    const assigned: AdapterAssignedEvent[] = [];
    const adapter = new GrokAdapter(
      {
        client: clientOf(mock),
        events: {
          onAborted: (event) => aborts.push(event),
          onTaskAssigned: (event) => assigned.push(event),
        },
      },
      { ...base, provider: 'mock' },
    );
    await adapter.register();

    mock.emit('task.awarded', {
      taskId: 'tsk_1',
      awardeeId: 'agt_1',
      awardedBy: 'admin',
      exploration: false,
    });
    expect(assigned.map((event) => event.taskId)).toEqual(['tsk_1']);

    mock.emit('task.reassigned', {
      taskId: 'tsk_1',
      fromAgentId: 'agt_1',
      toAgentId: 'agt_2',
      reassignedBy: 'admin',
    });
    expect(aborts).toEqual([
      expect.objectContaining({ taskId: 'tsk_1', reason: 'reassigned' }),
    ]);
  });

  it('fires onAborted on cancellation and on not_assignee', async () => {
    const mock = new MockClient();
    const aborts: AdapterAbortEvent[] = [];
    const adapter = new GrokAdapter(
      { client: clientOf(mock), events: { onAborted: (event) => aborts.push(event) } },
      { ...base, provider: 'mock' },
    );
    await adapter.register();

    mock.emit('task.awarded', {
      taskId: 'tsk_cancel',
      awardeeId: 'agt_1',
      awardedBy: 'admin',
      exploration: false,
    });
    mock.emit('task.cancelled', { taskId: 'tsk_cancel', reason: 'admin' });
    expect(aborts[0]).toMatchObject({ taskId: 'tsk_cancel', reason: 'cancelled' });

    mock.emit('task.awarded', {
      taskId: 'tsk_lost',
      awardeeId: 'agt_1',
      awardedBy: 'admin',
      exploration: false,
    });
    mock.failNextProgress = true;
    await expect(adapter.progress('tsk_lost', 50)).rejects.toBeInstanceOf(ForbiddenError);
    expect(aborts[1]).toMatchObject({ taskId: 'tsk_lost', reason: 'not_assignee' });
  });

  it('forwards review decisions', async () => {
    const mock = new MockClient();
    const reviews: AdapterReviewEvent[] = [];
    const adapter = new MuseAdapter(
      { client: clientOf(mock), events: { onReviewDecided: (event) => reviews.push(event) } },
      { ...base, workspaceId: 'ws-1' },
    );
    mock.emit('task.review.decided', {
      taskId: 'tsk_1',
      reviewerId: 'agt_admin',
      decision: 'approve',
      comment: 'ok',
      version: 3,
    });
    expect(reviews[0]).toMatchObject({
      taskId: 'tsk_1',
      decision: 'approve',
      comment: 'ok',
    });
    expect(adapter.getCapabilities().supportsReview).toBe(true);
  });

  it('reassigning to this agent emits onTaskAssigned', async () => {
    const mock = new MockClient();
    const assigned: AdapterAssignedEvent[] = [];
    // agentId is not set until register/authenticate; set it via config.
    const adapter = new GrokAdapter(
      { client: clientOf(mock), events: { onTaskAssigned: (event) => assigned.push(event) } },
      { ...base, provider: 'mock', agentId: 'agt_1' },
    );
    expect(adapter.agentId).toBe('agt_1');
    mock.emit('task.reassigned', {
      taskId: 'tsk_2',
      fromAgentId: 'agt_x',
      toAgentId: 'agt_1',
      reassignedBy: 'admin',
      humanTakeover: true,
    });
    expect(assigned.some((event) => event.taskId === 'tsk_2')).toBe(true);
  });
});
