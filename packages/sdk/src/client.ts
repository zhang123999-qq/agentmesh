import {
  METHODS,
  PROTOCOL_VERSION,
  createJsonRpcRequest,
  isNotificationEventType,
  isProtocolVersionCompatible,
  nextJsonRpcId,
  presenceUpdatePayloadSchema,
  safeParseEventNotification,
  type AgentRevokeTokenParams,
  type AgentRevokeTokenResult,
  type EventNotification,
  type JsonRpcParams,
  type MessageHistoryParams,
  type PresenceUpdatePayload,
  type TaskAwardParams,
  type TaskBidParams,
  type TaskCancelParams,
  type TaskCompleteParams,
  type TaskFailParams,
  type TaskProgressParams,
  type TaskReassignParams,
  type TaskReviewParams,
} from '@agentmesh/protocol';
import type { SystemSubscribeParams } from './types.js';

import { AgentMeshError, errorFromResponse } from './errors.js';
import {
  browserTransportFactory,
  type ClientTransport,
  type TransportFactory,
} from './transport.js';
import type {
  AccountListResult,
  AuthResult,
  AuthenticateParams,
  AwardResult,
  BidListResult,
  ChannelListResult,
  ChannelView,
  CreateChannelParams,
  GetTaskParams,
  JoinChannelParams,
  ListAccountsParams,
  ListBidsParams,
  ListChannelsParams,
  ListTasksParams,
  MessageHistoryResult,
  MessageView,
  PublishTaskParams,
  RegisterParams,
  SendMessageParams,
  SendMessageResult,
  TaskListResult,
  TaskMutationResult,
  TaskView,
} from './types.js';

export type GapPolicy = 'auto' | 'strict';
export type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'gapTooLarge'
  | 'closed';

export interface ConnectionEvent {
  readonly status: ConnectionStatus;
  readonly epoch?: string;
  readonly seq?: number;
  readonly detail?: string;
  readonly error?: unknown;
}

export interface AgentMeshClientOptions {
  readonly url: string;
  /** Defaults to the browser global WebSocket. Inject a `ws` adapter for Node. */
  readonly transportFactory?: TransportFactory;
  /** Existing JWT; the SDK authenticates in-band (works in browsers). */
  readonly token?: string;
  /** Reconnect on unexpected close (default true). */
  readonly autoReconnect?: boolean;
  /** Base reconnect delay in ms (default 1000). */
  readonly reconnectDelayMs?: number;
  /** `auto` cold-starts on gap_too_large; `strict` surfaces it only. */
  readonly gapPolicy?: GapPolicy;
  /** JSON-RPC request timeout (default 30s). */
  readonly requestTimeoutMs?: number;
  /** Build protocol version (default PROTOCOL_VERSION). */
  readonly protocolVersion?: string;
}

export interface EventPayloadMap {
  'presence.update': PresenceUpdatePayload;
  'message.new': {
    messageId: string;
    channelId: string;
    senderId: string;
    content: string;
    body?: string;
    createdAt: number;
    seq?: number;
    replyToMessageId?: string;
  };
  'task.bid.received': {
    taskId: string;
    bidId: string;
    agentId: string;
    price: number;
    eta?: number;
    approach?: string;
    confidence?: number;
    createdAt?: number;
  };
  'task.awarded': {
    taskId: string;
    awardeeId: string;
    awardedBy: string;
    exploration: boolean;
    strategy?: 'manual' | 'auto';
    version?: number;
  };
  'task.progress.updated': {
    taskId: string;
    agentId: string;
    progress: number;
    note?: string;
    artifacts?: string[];
    at?: number;
  };
  'task.completed': {
    taskId: string;
    artifacts?: string[];
    note?: string;
    at?: number;
  };
  'task.failed': {
    taskId: string;
    reason?: string;
    at?: number;
  };
  'task.review.decided': {
    taskId: string;
    reviewerId: string;
    decision: 'approve' | 'reject' | 'request-revision';
    comment?: string;
    version?: number;
  };
  'task.reassigned': {
    taskId: string;
    fromAgentId?: string;
    toAgentId: string;
    reassignedBy: string;
    humanTakeover?: boolean;
    reason?: string;
    version?: number;
  };
  'task.cancelled': {
    taskId: string;
    cancelledBy?: string;
    reason?: string;
    at?: number;
  };
  'task.dependency.failed': {
    parentTaskId: string;
    subtaskId: string;
    blockedBy: string[];
    reason?: string;
  };
  'system.error': {
    message: string;
    code?: number;
    reqId?: string;
    method?: string;
    agentId?: string;
    detail?: unknown;
  };
}

export type EventName = keyof EventPayloadMap;
type EventHandler = (payload: unknown, envelope?: EventNotification) => void;
type ConnectionHandler = (event: ConnectionEvent) => void;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WelcomeWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ControlFrame {
  readonly type?: unknown;
  readonly epoch?: unknown;
  readonly seq?: unknown;
  readonly currentSeq?: unknown;
  readonly fromSeq?: unknown;
  readonly protocolVersion?: unknown;
  readonly detail?: unknown;
  readonly window?: unknown;
}

function decodeJwtSubject(token: string): string | undefined {
  const parts = token.split('.');
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded =
      typeof globalThis.atob === 'function'
        ? globalThis.atob(padded)
        : '';
    if (decoded.length === 0) return undefined;
    const claims = JSON.parse(decoded) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub.length > 0
      ? claims.sub
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Transport-agnostic AgentMesh client.
 *
 * Responsibilities are intentionally limited: framing, auth handshake,
 * resume/dedupe, gap policy, typed RPC helpers and event dispatch. It does not
 * implement any task state machine.
 */
export class AgentMeshClient {
  readonly #url: string;
  readonly #factory: TransportFactory;
  readonly #autoReconnect: boolean;
  readonly #reconnectDelayMs: number;
  readonly #gapPolicy: GapPolicy;
  readonly #requestTimeoutMs: number;
  readonly #supportedVersion: string;

  #transport?: ClientTransport;
  #transportOpen = false;
  #manualClose = false;
  #state: ConnectionStatus = 'closed';
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #token?: string;
  #epoch?: string;
  #resumeEpoch?: string;
  #lastSeenSeq = 0;

  readonly #pending = new Map<number, PendingRequest>();
  readonly #eventHandlers = new Map<string, Set<EventHandler>>();
  readonly #connectionHandlers = new Set<ConnectionHandler>();
  readonly #welcomeWaiters: WelcomeWaiter[] = [];

  constructor(options: AgentMeshClientOptions) {
    this.#url = options.url;
    this.#factory = options.transportFactory ?? browserTransportFactory();
    this.#autoReconnect = options.autoReconnect ?? true;
    this.#reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 1000);
    this.#gapPolicy = options.gapPolicy ?? 'auto';
    this.#requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 30_000);
    this.#supportedVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    if (options.token !== undefined) this.#token = options.token;
  }

  get state(): ConnectionStatus {
    return this.#state;
  }

  get lastSeenSeq(): number {
    return this.#lastSeenSeq;
  }

  get epoch(): string | undefined {
    return this.#epoch;
  }

  get token(): string | undefined {
    return this.#token;
  }

  /** Open the transport; with a token also perform the in-band auth handshake. */
  async connect(): Promise<void> {
    if (this.#transportOpen) return;
    this.#manualClose = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#setState('connecting');

    const welcome =
      this.#token === undefined
        ? undefined
        : this.#waitForWelcome();
    const transport = this.#factory(
      this.#url,
      {},
      {
        onOpen: () => {
          this.#transportOpen = true;
          if (this.#token !== undefined) {
            void this.#authenticateWithToken(this.#token).catch((error: unknown) => {
              this.#failConnection(error);
            });
          }
        },
        onMessage: (text) => {
          this.#handleMessage(text);
        },
        onClose: (code, reason) => {
          this.#handleClose(code, reason);
        },
        onError: (error) => {
          this.#emitConnection({ status: this.#state, error });
        },
      },
    );
    this.#transport = transport;

    await this.#waitForOpen(transport);
    if (welcome !== undefined) await welcome;
  }

  /** Reset the cursor and reconnect (used by strict gap handling). */
  async resync(): Promise<void> {
    this.#lastSeenSeq = 0;
    this.#resumeEpoch = this.#epoch;
    this.#transport?.close(1000, 'resync');
    this.#transportOpen = false;
    await this.connect();
  }

  close(): void {
    this.#manualClose = true;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    this.#rejectPending(new AgentMeshError(-32000, 'Client closed'));
    this.#rejectWelcomeWaiters(new AgentMeshError(-32000, 'Client closed'));
    this.#transport?.close(1000, 'client close');
    this.#transportOpen = false;
    this.#setState('closed');
  }

  on<T extends EventName>(
    type: T,
    handler: (payload: EventPayloadMap[T], envelope?: EventNotification) => void,
  ): () => void {
    let handlers = this.#eventHandlers.get(type);
    if (handlers === undefined) {
      handlers = new Set();
      this.#eventHandlers.set(type, handlers);
    }
    const wrapped = handler as EventHandler;
    handlers.add(wrapped);
    return () => {
      handlers?.delete(wrapped);
    };
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.#connectionHandlers.add(handler);
    return () => {
      this.#connectionHandlers.delete(handler);
    };
  }

  /** Escape hatch: sends the frame verbatim, without types or dedupe. */
  sendRaw(frame: unknown): void {
    this.#send(frame);
  }

  // ------------------------------------------------------------------ RPC

  async register(params: RegisterParams): Promise<AuthResult> {
    const result = await this.#request<AuthResult>(METHODS.agent.register, params);
    if (result.token !== undefined) this.#token = result.token;
    await this.#waitForWelcomeIfNeeded();
    return result;
  }

  async authenticate(params: AuthenticateParams): Promise<AuthResult> {
    const result = await this.#request<AuthResult>(METHODS.agent.authenticate, params);
    this.#token = result.token;
    await this.#waitForWelcomeIfNeeded();
    return result;
  }

  listAccounts(params: ListAccountsParams = {}): Promise<AccountListResult> {
    return this.#request(METHODS.agent.list, params);
  }

  /**
   * Revoke an issued token by `jti` (admin-only, US-021D). Pass the token to be
   * revoked; the server derives `jti`/`exp`. A revoked token then fails auth
   * with `UnauthorizedError` (-32001) until it expires.
   */
  revokeToken(params: AgentRevokeTokenParams): Promise<AgentRevokeTokenResult> {
    return this.#request(METHODS.agent.revokeToken, params);
  }

  createChannel(params: CreateChannelParams): Promise<{ channel: ChannelView; seq: number }> {
    return this.#request(METHODS.channel.create, params);
  }

  joinChannel(params: JoinChannelParams): Promise<unknown> {
    return this.#request(METHODS.channel.join, params);
  }

  leaveChannel(params: JoinChannelParams): Promise<unknown> {
    return this.#request(METHODS.channel.leave, params);
  }

  listChannels(params: ListChannelsParams = {}): Promise<ChannelListResult> {
    return this.#request(METHODS.channel.list, params);
  }

  sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    return this.#request(METHODS.message.send, params);
  }

  history(params: MessageHistoryParams): Promise<MessageHistoryResult> {
    return this.#request(METHODS.message.history, params);
  }

  /**
   * Pull every message after `afterSeq` via `message.history`, deduped by the
   * global seq. This is the SDK-side gap fallback primitive.
   */
  async resyncChannelHistory(
    channelId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<MessageView[]> {
    const limit = options.limit ?? 200;
    let cursor = options.afterSeq ?? this.#lastSeenSeq;
    const seen = new Set<number>();
    const messages: MessageView[] = [];
    for (let guard = 0; guard < 10_000; guard += 1) {
      const page = await this.history({ channelId, afterSeq: cursor, limit });
      for (const message of page.messages) {
        const seq = message.seq ?? 0;
        if (!seen.has(seq)) {
          seen.add(seq);
          messages.push(message);
        }
      }
      if (!page.hasMoreAfter || page.nextAfterSeq === null) break;
      cursor = page.nextAfterSeq;
    }
    return messages;
  }

  publishTask(params: PublishTaskParams): Promise<{ task: TaskView; seq: number }> {
    return this.#request(METHODS.task.publish, params);
  }

  listTasks(params: ListTasksParams = {}): Promise<TaskListResult> {
    return this.#request(METHODS.task.list, params);
  }

  getTask(params: GetTaskParams): Promise<TaskView> {
    return this.#request(METHODS.task.get, params);
  }

  bid(params: TaskBidParams): Promise<unknown> {
    return this.#request(METHODS.task.bid, params);
  }

  bids(params: ListBidsParams): Promise<BidListResult> {
    return this.#request(METHODS.task.bids, params);
  }

  award(params: TaskAwardParams): Promise<AwardResult> {
    return this.#request(METHODS.task.award, params);
  }

  progress(params: TaskProgressParams): Promise<TaskMutationResult> {
    return this.#request(METHODS.task.progress, params);
  }

  complete(params: TaskCompleteParams): Promise<TaskMutationResult> {
    return this.#request(METHODS.task.complete, params);
  }

  fail(params: TaskFailParams): Promise<TaskMutationResult> {
    return this.#request(METHODS.task.fail, params);
  }

  review(params: TaskReviewParams): Promise<TaskMutationResult> {
    return this.#request(METHODS.task.review, params);
  }

  reassign(params: TaskReassignParams): Promise<TaskMutationResult> {
    return this.#request(METHODS.task.reassign, params);
  }

  cancel(params: TaskCancelParams): Promise<TaskMutationResult> {
    return this.#request(METHODS.task.cancel, params);
  }

  /**
   * Admin-only: subscribe to domain-only events on this socket.
   * Adds to existing notification broadcast (does not replace it).
   */
  async subscribeSystem(params: SystemSubscribeParams = {}): Promise<{
    subscribed: boolean;
    includeDomainEvents: boolean;
    types: readonly string[] | undefined;
  }> {
    return this.#request(METHODS.system.subscribe, params);
  }

  // ------------------------------------------------------------- internals

  async #request<T>(method: string, params: object | unknown[] = {}): Promise<T> {
    if (!this.#transportOpen) {
      throw new AgentMeshError(-32000, 'Client is not connected', undefined, method);
    }
    const merged =
      Array.isArray(params) || this.#token === undefined
        ? params
        : { ...(params as Record<string, unknown>), token: this.#token };
    const id = nextJsonRpcId();
    const request = createJsonRpcRequest(method, merged as JsonRpcParams, id);
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new AgentMeshError(
            -32000,
            `Request timed out after ${this.#requestTimeoutMs}ms`,
            { timeoutMs: this.#requestTimeoutMs },
            method,
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.#send(request);
    return promise;
  }

  #send(frame: unknown): void {
    if (!this.#transportOpen || this.#transport === undefined) {
      throw new AgentMeshError(-32000, 'Client is not connected');
    }
    this.#transport.send(JSON.stringify(frame));
  }

  #handleMessage(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const frame = value as Record<string, unknown>;

    // Control frames (welcome / ack / gap_too_large / pong).
    if (typeof frame.type === 'string') {
      this.#handleControlFrame(frame as ControlFrame);
      return;
    }

    // Server -> client notifications.
    if (typeof frame.method === 'string' && !('id' in frame)) {
      const method = frame.method;
      if (method === 'presence.update') {
        const parsed = presenceUpdatePayloadSchema.safeParse(frame.params);
        if (parsed.success) this.#dispatch(method, parsed.data);
        return;
      }
      if (isNotificationEventType(method)) {
        const parsed = safeParseEventNotification(frame.params);
        if (!parsed.success) return;
        if (this.#lastSeenSeq >= parsed.data.seq) return;
        this.#lastSeenSeq = parsed.data.seq;
        this.#dispatch(method, parsed.data.payload, parsed.data);
      }
      return;
    }

    // JSON-RPC responses.
    if (typeof frame.id === 'number' || typeof frame.id === 'string') {
      const pending = this.#pending.get(frame.id as number);
      if (pending === undefined) return;
      this.#pending.delete(frame.id as number);
      clearTimeout(pending.timer);
      if (frame.error !== undefined && frame.error !== null) {
        const error = frame.error as { code?: unknown; message?: unknown; data?: unknown };
        pending.reject(
          errorFromResponse(
            typeof error.code === 'number' ? error.code : -32603,
            typeof error.message === 'string' ? error.message : 'JSON-RPC error',
            error.data,
            pending.method,
          ),
        );
        return;
      }
      pending.resolve(frame.result ?? null);
    }
  }

  #handleControlFrame(frame: ControlFrame): void {
    switch (frame.type) {
      case 'welcome':
        this.#handleWelcome(frame);
        return;
      case 'ack':
        if (typeof frame.epoch === 'string') this.#resumeEpoch = frame.epoch;
        return;
      case 'gap_too_large':
        this.#handleGap(frame);
        return;
      case 'pong':
        return;
      default:
        return;
    }
  }

  #handleWelcome(frame: ControlFrame): void {
    const version =
      typeof frame.protocolVersion === 'string'
        ? frame.protocolVersion
        : this.#supportedVersion;
    if (!isProtocolVersionCompatible(version, this.#supportedVersion)) {
      this.#failConnection(
        new AgentMeshError(
          -32006,
          `Incompatible protocol version: ${version}`,
          { requested: version, supported: this.#supportedVersion },
        ),
      );
      return;
    }
    if (typeof frame.epoch !== 'string') return;
    this.#epoch = frame.epoch;
    this.#setState('connected', frame.epoch, typeof frame.seq === 'number' ? frame.seq : undefined);
    this.#resolveWelcomeWaiters();

    if (this.#lastSeenSeq > 0) {
      const resume: Record<string, unknown> = {
        type: 'resume',
        lastSeenSeq: this.#lastSeenSeq,
        // Official SDK always sends the epoch (never relies on compatibility).
        lastSeenEpoch: this.#resumeEpoch ?? frame.epoch,
        protocolVersion: this.#supportedVersion,
      };
      this.#send(resume);
    } else {
      this.#resumeEpoch = frame.epoch;
    }
  }

  #handleGap(frame: ControlFrame): void {
    const detail = typeof frame.detail === 'string' ? frame.detail : undefined;
    this.#setState(
      'gapTooLarge',
      typeof frame.epoch === 'string' ? frame.epoch : this.#epoch,
      typeof frame.currentSeq === 'number' ? frame.currentSeq : undefined,
      detail,
    );
    if (this.#gapPolicy === 'strict') return;
    this.#lastSeenSeq = 0;
    this.#resumeEpoch = typeof frame.epoch === 'string' ? frame.epoch : this.#epoch;
    this.#transport?.close(1000, 'gap_too_large');
    this.#transportOpen = false;
    this.#scheduleReconnect();
  }

  #handleClose(code: number, reason: string): void {
    this.#transportOpen = false;
    this.#rejectPending(
      new AgentMeshError(-32000, `Connection closed (${code}${reason ? `: ${reason}` : ''})`),
    );
    this.#rejectWelcomeWaiters(
      new AgentMeshError(-32000, `Connection closed before welcome (${code})`),
    );
    if (this.#manualClose || !this.#autoReconnect) {
      this.#setState('closed');
      return;
    }
    this.#setState('reconnecting', this.#epoch);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#manualClose || !this.#autoReconnect) return;
    if (this.#reconnectTimer !== undefined) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.connect().catch((error: unknown) => {
        this.#emitConnection({ status: 'reconnecting', error });
      });
    }, this.#reconnectDelayMs);
  }

  #failConnection(error: unknown): void {
    this.#rejectWelcomeWaiters(error);
    this.#emitConnection({ status: this.#state, error });
    this.#transport?.close(1000, 'failed');
    this.#transportOpen = false;
  }

  async #authenticateWithToken(token: string): Promise<void> {
    const agentId = decodeJwtSubject(token);
    if (agentId === undefined) {
      throw new AgentMeshError(
        -32001,
        'Cannot determine the agentId from the token; use register/authenticate instead',
      );
    }
    this.#token = token;
    const result = await this.#request<AuthResult>(METHODS.agent.authenticate, {
      agentId,
      secret: '',
      token,
    });
    if (result.token !== undefined) this.#token = result.token;
  }

  async #waitForWelcomeIfNeeded(): Promise<void> {
    if (this.#state === 'connected') return;
    await this.#waitForWelcome();
  }

  #waitForWelcome(): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#welcomeWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index !== -1) this.#welcomeWaiters.splice(index, 1);
        reject(new AgentMeshError(-32000, 'Timed out waiting for welcome'));
      }, this.#requestTimeoutMs);
      this.#welcomeWaiters.push({ resolve, reject, timer });
    });
  }

  #resolveWelcomeWaiters(): void {
    for (const waiter of this.#welcomeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  #rejectWelcomeWaiters(error: unknown): void {
    for (const waiter of this.#welcomeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #dispatch(type: string, payload: unknown, envelope?: EventNotification): void {
    const handlers = this.#eventHandlers.get(type);
    if (handlers === undefined) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload, envelope);
      } catch {
        // A subscriber bug must not break the transport.
      }
    }
  }

  #setState(
    status: ConnectionStatus,
    epoch?: string,
    seq?: number,
    detail?: string,
  ): void {
    this.#state = status;
    this.#emitConnection({ status, epoch, seq, detail });
  }

  #emitConnection(event: ConnectionEvent): void {
    for (const handler of [...this.#connectionHandlers]) {
      try {
        handler(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  #waitForOpen(transport: ClientTransport): Promise<void> {
    if (this.#transportOpen) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = (): void => {
        if (this.#transportOpen) {
          resolve();
          return;
        }
        if (Date.now() - started > this.#requestTimeoutMs) {
          reject(new AgentMeshError(-32000, 'Timed out opening the transport'));
          return;
        }
        setTimeout(poll, 5);
      };
      setTimeout(poll, 0);
      void transport;
    });
  }
}
