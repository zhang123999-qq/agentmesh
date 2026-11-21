import type {
  AccountRole,
  MessageHistoryParams,
  TaskAwardParams,
  TaskBidParams,
  TaskCancelParams,
  TaskCompleteParams,
  TaskFailParams,
  TaskProgressParams,
  TaskReassignParams,
  TaskReviewParams,
} from '@agentmesh/protocol';

/**
 * Server response views.
 *
 * The protocol package owns request/notification schemas; these are the
 * server's response shapes (there is no response schema in protocol yet).
 * Keep them aligned with `apps/server/src/modules/*.ts`.
 */

export type TaskStatus =
  | 'draft'
  | 'open'
  | 'bidding'
  | 'awarded'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface AuthResult {
  readonly agentId: string;
  readonly token: string;
  readonly role: AccountRole;
  readonly expiresAt: number;
  /** Present only on registration (plaintext credential, shown once). */
  readonly secret?: string;
}

export interface AccountView {
  readonly agentId: string;
  readonly name: string;
  readonly owner: string | null;
  readonly skills: string[];
  readonly role: AccountRole;
  readonly createdAt: number;
}

export interface AccountListResult {
  readonly accounts: AccountView[];
  readonly total: number;
  readonly limit: number | null;
  readonly offset: number;
}

export interface ChannelView {
  readonly channelId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly memberCount: number;
  readonly members: string[];
  readonly joined: boolean;
}

export interface ChannelListResult {
  readonly channels: ChannelView[];
  readonly total: number;
  readonly limit: number | null;
  readonly offset: number;
}

export interface MessageView {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly body: string;
  /** Global events.seq shared with live pushes. */
  readonly seq: number;
  readonly createdAt: number;
}

export interface MessageHistoryResult {
  readonly channelId: string;
  readonly messages: MessageView[];
  /** Total messages in the channel at query time (not the page size). */
  readonly channelTotal: number;
  readonly limit: number;
  readonly nextBeforeSeq: number | null;
  readonly nextAfterSeq: number | null;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
}

export interface SendMessageResult {
  readonly message: MessageView;
  readonly delivered: number;
}

export interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly requiredSkills: string[];
  readonly budget: number;
  readonly status: TaskStatus;
  readonly assignee: string | null;
  readonly version: number;
  readonly parentId: string | null;
  readonly deadline: number | null;
  readonly progress: number;
  readonly completedAt: number | null;
  readonly biddingDeadline: number | null;
  readonly blockedBy: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TaskListResult {
  readonly tasks: TaskView[];
  readonly total: number;
  readonly limit: number | null;
  readonly offset: number;
}

export interface TaskMutationResult {
  readonly task: TaskView;
  readonly version: number;
  readonly seq: number;
}

export interface BidView {
  readonly bidId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly price: number;
  readonly eta: number | null;
  readonly approach: string | null;
  readonly confidence: number | null;
  readonly createdAt: number;
}

export interface BidListResult {
  readonly taskId: string;
  readonly bids: BidView[];
  readonly total: number;
}

export interface AwardResult extends TaskMutationResult {
  readonly awardeeId: string;
  readonly strategy: 'manual' | 'auto';
  readonly exploration: boolean;
}

export interface RegisterParams {
  readonly name: string;
  readonly owner?: string;
  readonly skills?: string[];
  readonly role?: AccountRole;
}

export interface AuthenticateParams {
  readonly agentId?: string;
  readonly name?: string;
  readonly secret?: string;
}

export interface ListAccountsParams {
  readonly limit?: number;
  readonly offset?: number;
  readonly role?: AccountRole;
}

export interface CreateChannelParams {
  readonly name: string;
}

export interface JoinChannelParams {
  readonly channelId: string;
  readonly agentId?: string;
}

export interface ListChannelsParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface SendMessageParams {
  readonly channelId: string;
  readonly body: string;
}

export interface PublishTaskParams {
  readonly title: string;
  readonly description?: string;
  readonly requiredSkills?: string[];
  readonly budget?: number;
  readonly deadline?: number;
  readonly biddingDeadline?: number;
  readonly parentId?: string;
}

export interface ListTasksParams {
  readonly status?: TaskStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface GetTaskParams {
  readonly taskId: string;
}

export interface ListBidsParams {
  readonly taskId: string;
}

export type {
  MessageHistoryParams,
  TaskAwardParams,
  TaskBidParams,
  TaskCancelParams,
  TaskCompleteParams,
  TaskFailParams,
  TaskProgressParams,
  TaskReassignParams,
  TaskReviewParams,
};
