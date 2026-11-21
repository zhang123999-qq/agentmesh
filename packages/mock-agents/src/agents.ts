import {
  BaseAgentAdapter,
  type AgentAdapterConfig,
  type AgentAdapterEvents,
  type AgentCapabilities,
  type CompleteOptions,
  type PlaceBidInput,
} from '@agentmesh/adapters';
import type { AgentMeshClient, AuthResult, TaskView } from '@agentmesh/sdk';
import type { TaskReviewDecision } from '@agentmesh/protocol';

export interface MockAgentOptions {
  readonly name: string;
  readonly role?: 'admin' | 'agent' | 'observer';
  readonly skills?: readonly string[];
  readonly availability?: number;
  readonly maxConcurrentTasks?: number;
  readonly events?: AgentAdapterEvents;
}

/**
 * A deterministic mock worker over the real SDK + adapter contract.
 * No provider API is called; "execution" is progress/complete reporting.
 */
export class MockAgent {
  readonly adapter: BaseAgentAdapter;
  readonly client: AgentMeshClient;

  constructor(client: AgentMeshClient, options: MockAgentOptions) {
    this.client = client;
    const config: AgentAdapterConfig = {
      name: options.name,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      ...(options.availability === undefined ? {} : { availability: options.availability }),
      ...(options.maxConcurrentTasks === undefined
        ? {}
        : { maxConcurrentTasks: options.maxConcurrentTasks }),
    };
    this.adapter = new BaseAgentAdapter(
      'mock',
      {
        client,
        ...(options.events === undefined ? {} : { events: options.events }),
      },
      config,
    );
  }

  get agentId(): string | undefined {
    return this.adapter.agentId;
  }

  getCapabilities(): AgentCapabilities {
    return this.adapter.getCapabilities();
  }

  register(): Promise<AuthResult> {
    return this.adapter.register();
  }

  authenticate(params: { name?: string; agentId?: string; secret?: string }): Promise<AuthResult> {
    return this.adapter.authenticate(params);
  }

  join(channelId: string): Promise<unknown> {
    return this.adapter.join(channelId);
  }

  bid(taskId: string, bid: PlaceBidInput): Promise<unknown> {
    return this.adapter.bid(taskId, bid);
  }

  progress(taskId: string, progress: number, options: CompleteOptions = {}): Promise<unknown> {
    return this.adapter.progress(taskId, progress, options);
  }

  complete(taskId: string, expectedVersion: number, options: CompleteOptions = {}): Promise<unknown> {
    return this.adapter.complete(taskId, expectedVersion, options);
  }

  fail(taskId: string, expectedVersion: number, reason?: string): Promise<unknown> {
    return this.adapter.fail(taskId, expectedVersion, reason);
  }

  review(
    taskId: string,
    expectedVersion: number,
    decision: TaskReviewDecision,
    comment?: string,
  ): Promise<unknown> {
    return this.adapter.review?.(taskId, expectedVersion, decision, comment) ?? Promise.resolve();
  }

  /**
   * Simulated work: report progress, then complete the task using the latest
   * version from `getTask` (US-015 onTaskAssigned only carries the triple).
   */
  async executeTask(
    taskId: string,
    progress: number,
    options: CompleteOptions = {},
  ): Promise<TaskView> {
    await this.adapter.progress(taskId, progress, options);
    const task = await this.client.getTask({ taskId });
    await this.adapter.complete(taskId, task.version, options);
    return this.client.getTask({ taskId });
  }

  /** Stops adapter subscriptions; the injected SDK client is closed by the host. */
  close(): void {
    this.adapter.close();
  }
}

export class PlannerAgent extends MockAgent {
  constructor(client: AgentMeshClient, options: Omit<MockAgentOptions, 'role' | 'skills'>) {
    super(client, { ...options, role: 'admin', skills: ['planning'] });
  }
}

export class CoderAgent extends MockAgent {
  constructor(client: AgentMeshClient, options: Omit<MockAgentOptions, 'role' | 'skills'>) {
    super(client, { ...options, role: 'agent', skills: ['typescript'] });
  }
}

export class ReviewerAgent extends MockAgent {
  constructor(client: AgentMeshClient, options: Omit<MockAgentOptions, 'role' | 'skills'>) {
    super(client, { ...options, role: 'agent', skills: ['review'] });
  }
}
