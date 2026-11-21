import type {
  AgentMeshClient,
  AuthResult,
  RegisterParams,
} from '@agentmesh/sdk';
import type { TaskReviewDecision } from '@agentmesh/protocol';

/** Capability declaration used by the adapter to decide whether to bid. */
export interface AgentCapabilities {
  readonly skills: string[];
  /** Self-reported availability hint in [0,1]; task scoring uses server data. */
  readonly availability: number;
  readonly maxConcurrentTasks: number;
  readonly supportsReview: boolean;
}

export interface AgentAdapterConfig {
  readonly name: string;
  readonly owner?: string;
  readonly skills?: readonly string[];
  readonly role?: 'admin' | 'agent' | 'observer';
  readonly agentId?: string;
  readonly secret?: string;
  readonly availability?: number;
  readonly maxConcurrentTasks?: number;
}

export type AdapterAbortReason = 'cancelled' | 'reassigned' | 'not_assignee';

export interface AdapterAbortEvent {
  readonly taskId: string;
  readonly reason: AdapterAbortReason;
  readonly detail?: unknown;
}

export interface AdapterReviewEvent {
  readonly taskId: string;
  readonly reviewerId: string;
  readonly decision: TaskReviewDecision;
  readonly comment?: string;
  readonly version?: number;
}

export interface AdapterAssignedEvent {
  readonly taskId: string;
  readonly awardeeId: string;
  readonly version?: number;
}

export interface AgentAdapterEvents {
  onTaskAssigned?: (event: AdapterAssignedEvent) => void;
  onReviewDecided?: (event: AdapterReviewEvent) => void;
  /** The task is no longer yours: stop work / release resources. */
  onAborted?: (event: AdapterAbortEvent) => void;
  onError?: (error: unknown) => void;
  onConnection?: (event: unknown) => void;
}

export interface PlaceBidInput {
  readonly price: number;
  readonly eta?: number;
  readonly approach?: string;
  readonly confidence?: number;
}

export interface CompleteOptions {
  readonly note?: string;
  readonly artifacts?: readonly string[];
}

/**
 * Adapter contract. The SDK client is injected by the caller so adapters never
 * own a second transport / reconnect loop.
 */
export interface AgentAdapter {
  readonly provider: string;
  readonly agentId: string | undefined;
  getCapabilities(): AgentCapabilities;
  register(params?: Partial<RegisterParams>): Promise<AuthResult>;
  authenticate(params?: { agentId?: string; name?: string; secret?: string }): Promise<AuthResult>;
  join(channelId: string): Promise<unknown>;
  bid(taskId: string, bid: PlaceBidInput): Promise<unknown>;
  progress(taskId: string, progress: number, options?: CompleteOptions): Promise<unknown>;
  complete(taskId: string, expectedVersion: number, options?: CompleteOptions): Promise<unknown>;
  fail(taskId: string, expectedVersion: number, reason?: string): Promise<unknown>;
  review?(
    taskId: string,
    expectedVersion: number,
    decision: TaskReviewDecision,
    comment?: string,
  ): Promise<unknown>;
  subscribe(events: AgentAdapterEvents): () => void;
  close(): void;
}

export interface AdapterDependencies {
  readonly client: AgentMeshClient;
  readonly events?: AgentAdapterEvents;
}
