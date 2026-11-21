import { ForbiddenError } from '@agentmesh/sdk';
import type { AgentMeshClient, AuthResult, RegisterParams } from '@agentmesh/sdk';
import type { TaskReviewDecision } from '@agentmesh/protocol';

import type {
  AdapterAbortEvent,
  AdapterAbortReason,
  AdapterDependencies,
  AgentAdapter,
  AgentAdapterConfig,
  AgentAdapterEvents,
  AgentCapabilities,
  CompleteOptions,
  PlaceBidInput,
} from './types.js';

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateConfig(config: AgentAdapterConfig): void {
  requireNonEmpty(config.name, 'name');
  if (config.owner !== undefined) requireNonEmpty(config.owner, 'owner');
  if (config.skills !== undefined) {
    if (!Array.isArray(config.skills) || config.skills.some((skill) => typeof skill !== 'string')) {
      throw new TypeError('skills must be an array of strings');
    }
  }
  if (
    config.availability !== undefined &&
    (typeof config.availability !== 'number' ||
      !Number.isFinite(config.availability) ||
      config.availability < 0 ||
      config.availability > 1)
  ) {
    throw new TypeError('availability must be a number between 0 and 1');
  }
  if (
    config.maxConcurrentTasks !== undefined &&
    (!Number.isSafeInteger(config.maxConcurrentTasks) || config.maxConcurrentTasks < 1)
  ) {
    throw new TypeError('maxConcurrentTasks must be a positive integer');
  }
}

/**
 * Shared adapter implementation over an injected `AgentMeshClient`.
 *
 * - capabilities are declared at construction and exposed via `getCapabilities`;
 * - `onAborted` fires on `task.cancelled`, on reassignment away from this agent,
 *   and when an execution RPC returns `ForbiddenError` with `not_assignee`;
 * - review decisions are forwarded via `onReviewDecided`.
 */
export class BaseAgentAdapter implements AgentAdapter {
  readonly provider: string;
  readonly #client: AgentMeshClient;
  readonly #config: AgentAdapterConfig;
  readonly #capabilities: AgentCapabilities;
  readonly #events: AgentAdapterEvents[] = [];
  readonly #assigned = new Set<string>();
  readonly #unsubscribers: Array<() => void> = [];
  #agentId?: string;

  constructor(
    provider: string,
    deps: AdapterDependencies,
    config: AgentAdapterConfig,
  ) {
    this.provider = requireNonEmpty(provider, 'provider');
    this.#client = deps.client;
    validateConfig(config);
    this.#config = config;
    this.#agentId = config.agentId;
    this.#capabilities = Object.freeze({
      skills: [...(config.skills ?? [])],
      availability: config.availability ?? 1,
      maxConcurrentTasks: config.maxConcurrentTasks ?? 1,
      supportsReview: config.role === 'admin',
    });
    if (deps.events !== undefined) this.#events.push(deps.events);

    this.#unsubscribers.push(
      deps.client.on('task.awarded', (payload) => {
        if (payload.awardeeId !== this.#agentId) return;
        this.#assigned.add(payload.taskId);
        this.#emit('onTaskAssigned', {
          taskId: payload.taskId,
          awardeeId: payload.awardeeId,
          ...(payload.version === undefined ? {} : { version: payload.version }),
        });
      }),
      deps.client.on('task.cancelled', (payload) => {
        if (!this.#assigned.delete(payload.taskId)) return;
        this.#abort(payload.taskId, 'cancelled', payload);
      }),
      deps.client.on('task.reassigned', (payload) => {
        if (payload.toAgentId === this.#agentId) {
          this.#assigned.add(payload.taskId);
          this.#emit('onTaskAssigned', {
            taskId: payload.taskId,
            awardeeId: payload.toAgentId,
            ...(payload.version === undefined ? {} : { version: payload.version }),
          });
          return;
        }
        if (payload.fromAgentId === this.#agentId) {
          this.#assigned.delete(payload.taskId);
          this.#abort(payload.taskId, 'reassigned', payload);
        }
      }),
      deps.client.on('task.review.decided', (payload) => {
        this.#emit('onReviewDecided', {
          taskId: payload.taskId,
          reviewerId: payload.reviewerId,
          decision: payload.decision as TaskReviewDecision,
          ...(payload.comment === undefined ? {} : { comment: payload.comment }),
          ...(payload.version === undefined ? {} : { version: payload.version }),
        });
      }),
      deps.client.onConnection((event) => {
        this.#emit('onConnection', event);
      }),
    );
  }

  get agentId(): string | undefined {
    return this.#agentId;
  }

  getCapabilities(): AgentCapabilities {
    return {
      ...this.#capabilities,
      skills: [...this.#capabilities.skills],
    };
  }

  async register(params: Partial<RegisterParams> = {}): Promise<AuthResult> {
    const owner = params.owner ?? this.#config.owner;
    const skills = params.skills ?? this.#config.skills;
    const role = params.role ?? this.#config.role;
    const result = await this.#client.register({
      name: params.name ?? this.#config.name,
      ...(owner === undefined ? {} : { owner }),
      ...(skills === undefined ? {} : { skills: [...skills] }),
      ...(role === undefined ? {} : { role }),
    });
    this.#agentId = result.agentId;
    return result;
  }

  async authenticate(
    params: { agentId?: string; name?: string; secret?: string } = {},
  ): Promise<AuthResult> {
    const secret = params.secret ?? this.#config.secret;
    if (secret === undefined || secret.length === 0) {
      throw new TypeError('authenticate requires a secret');
    }
    const agentId = params.agentId ?? this.#agentId ?? this.#config.agentId;
    const name = params.name ?? (agentId === undefined ? this.#config.name : undefined);
    const result = await this.#client.authenticate({
      ...(agentId === undefined ? {} : { agentId }),
      ...(name === undefined ? {} : { name }),
      secret,
    });
    this.#agentId = result.agentId;
    return result;
  }

  join(channelId: string): Promise<unknown> {
    return this.#client.joinChannel({ channelId: requireNonEmpty(channelId, 'channelId') });
  }

  bid(taskId: string, bid: PlaceBidInput): Promise<unknown> {
    return this.#client.bid({
      taskId: requireNonEmpty(taskId, 'taskId'),
      price: bid.price,
      ...(bid.eta === undefined ? {} : { eta: bid.eta }),
      ...(bid.approach === undefined ? {} : { approach: bid.approach }),
      ...(bid.confidence === undefined ? {} : { confidence: bid.confidence }),
    });
  }

  async progress(
    taskId: string,
    progress: number,
    options: CompleteOptions = {},
  ): Promise<unknown> {
    return this.#guardExecution(taskId, () =>
      this.#client.progress({
        taskId,
        progress,
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.artifacts === undefined ? {} : { artifacts: [...options.artifacts] }),
      }),
    );
  }

  async complete(
    taskId: string,
    expectedVersion: number,
    options: CompleteOptions = {},
  ): Promise<unknown> {
    return this.#guardExecution(taskId, () =>
      this.#client.complete({
        taskId,
        expectedVersion,
        ...(options.note === undefined ? {} : { note: options.note }),
        ...(options.artifacts === undefined ? {} : { artifacts: [...options.artifacts] }),
      }),
    );
  }

  async fail(taskId: string, expectedVersion: number, reason?: string): Promise<unknown> {
    return this.#guardExecution(taskId, () =>
      this.#client.fail({
        taskId,
        expectedVersion,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }

  async review(
    taskId: string,
    expectedVersion: number,
    decision: TaskReviewDecision,
    comment?: string,
  ): Promise<unknown> {
    return this.#client.review({
      taskId,
      expectedVersion,
      decision,
      ...(comment === undefined ? {} : { comment }),
    });
  }

  subscribe(events: AgentAdapterEvents): () => void {
    this.#events.push(events);
    return () => {
      const index = this.#events.indexOf(events);
      if (index !== -1) this.#events.splice(index, 1);
    };
  }

  close(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    this.#events.length = 0;
    this.#assigned.clear();
  }

  async #guardExecution(
    taskId: string,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof ForbiddenError &&
        (error.data as { reason?: unknown } | undefined)?.reason === 'not_assignee'
      ) {
        this.#assigned.delete(taskId);
        this.#abort(taskId, 'not_assignee', error.data);
      }
      this.#emit('onError', error);
      throw error;
    }
  }

  #abort(taskId: string, reason: AdapterAbortReason, detail?: unknown): void {
    const event: AdapterAbortEvent = {
      taskId,
      reason,
      ...(detail === undefined ? {} : { detail }),
    };
    this.#emit('onAborted', event);
  }

  #emit(key: keyof AgentAdapterEvents, value: unknown): void {
    for (const events of [...this.#events]) {
      const handler = events[key] as ((payload: unknown) => void) | undefined;
      if (handler === undefined) continue;
      try {
        handler(value);
      } catch {
        // Adapter subscribers must not break the transport.
      }
    }
  }
}
