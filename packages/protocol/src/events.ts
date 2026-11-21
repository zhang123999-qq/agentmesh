import { z } from 'zod';

/**
 * Event envelopes + event notification payloads.
 *
 * This module is the single source of truth for:
 *  - the event envelope written to the append-only `events` table,
 *  - the `event` notifications pushed over WebSocket,
 * so the server, the SDK and the web app cannot drift apart.
 *
 * ## `seq` scope (locked)
 *
 * `seq` is a **global, monotonically increasing, globally unique** sequence:
 * it comes from `events.seq` (SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`), so
 * *every* event in the workspace shares one space. There is no per-aggregate
 * sequence in the MVP — with a single SQLite writer it buys nothing and it
 * would break the "dedupe by seq" contract used for resume/downgrade.
 * Clients therefore dedupe purely by `seq`, and gaps are detectable by
 * comparing `seq` against the welcome/ack watermark.
 */

export const seqSchema = z.number().int().positive();
/** Watermark / cursor form of `seq`, where 0 means "nothing seen yet". */
export const watermarkSeqSchema = z.number().int().nonnegative();
/** Generation of the whole `seq` space; changes when the server restarts with a fresh DB. */
export const epochSchema = z.string().min(1);

export type Seq = z.infer<typeof seqSchema>;
export type Epoch = z.infer<typeof epochSchema>;

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * Event types that are broadcast to subscribed clients as `event`
 * notifications (JSON-RPC notification with method = the type below).
 */
export const NOTIFICATION_EVENT_TYPES = [
  'presence.update',
  'message.new',
  'task.bid.received',
  'task.awarded',
  'task.progress.updated',
  'task.completed',
  'task.failed',
  'task.review.decided',
  'task.reassigned',
  'task.cancelled',
  'task.dependency.failed',
  'system.error',
] as const;

/**
 * Event types that only live in the server-side event log (they are
 * projections/reducers input, not push payloads). `task.awarded`,
 * `task.review.decided`, `task.reassigned` are shared with the notification
 * list above because they are both logged and pushed.
 */
export const DOMAIN_ONLY_EVENT_TYPES = [
  'account.registered',
  'account.authenticated',
  'channel.created',
  'channel.member.joined',
  'channel.member.left',
  'message.created',
  'task.published',
  /**
   * Lifecycle transition (`from` → `to`), written by the US-008 state machine.
   * Domain-only: clients learn about it through `task.list`/`task.get`; the
   * richer, per-milestone events (`task.awarded`, `task.progress.updated`, …)
   * remain notification types owned by US-009/US-013.
   */
  'task.status.changed',
  'task.bid.placed',
  'task.progress.reported',
  // `task.completed` / `task.failed` are notifications (added in US-011).
] as const;

export const EVENT_TYPES = [
  ...NOTIFICATION_EVENT_TYPES,
  ...DOMAIN_ONLY_EVENT_TYPES,
] as const;

export const eventTypeSchema = z.enum(EVENT_TYPES);
export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);

export type EventType = (typeof EVENT_TYPES)[number];
export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isNotificationEventType(type: string): type is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/**
 * Optional notification fields are omitted by producers; `null` is accepted
 * for backward compatibility with historical rows (US-021A). Request params
 * keep their own nullability semantics.
 */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullable().optional();

/** Per-agent presence change (LWW-Register in the CRDT layer, US-012). */
export const presenceUpdatePayloadSchema = z.object({
  agentId: z.string().min(1),
  status: z.enum(['online', 'offline', 'away']),
  /** Set when presence is scoped to one channel. */
  channelId: optional(z.string().min(1)),
  at: optional(z.number().int().nonnegative()),
});
export type PresenceUpdatePayload = z.infer<typeof presenceUpdatePayloadSchema>;

export const messageNewPayloadSchema = z.object({
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  senderId: z.string().min(1),
  content: z.string(),
  createdAt: z.number().int().nonnegative(),
  /** Mirrors the envelope `seq` so history pages and live stream share one cursor. */
  seq: optional(seqSchema),
  replyToMessageId: optional(z.string().min(1)),
});
export type MessageNewPayload = z.infer<typeof messageNewPayloadSchema>;

export const taskBidReceivedPayloadSchema = z.object({
  taskId: z.string().min(1),
  bidId: z.string().min(1),
  agentId: z.string().min(1),
  price: z.number().nonnegative(),
  /** Estimated duration, in minutes. */
  eta: optional(z.number().nonnegative()),
  approach: optional(z.string()),
  confidence: optional(z.number().min(0).max(1)),
  createdAt: optional(z.number().int().nonnegative()),
});
export type TaskBidReceivedPayload = z.infer<typeof taskBidReceivedPayloadSchema>;

export const taskAwardedPayloadSchema = z.object({
  taskId: z.string().min(1),
  awardeeId: z.string().min(1),
  awardedBy: z.string().min(1),
  /**
   * True when the award came from the cold-start exploration branch
   * (skill-qualified but history-less agent). Defaults to `false` so ordinary
   * awards never carry the flag.
   */
  exploration: z.boolean().default(false),
  /** How the awardee was chosen. */
  strategy: optional(z.enum(['manual', 'auto'])),
  /** Task version after the CAS update (see -32007 version conflicts). */
  version: optional(z.number().int().nonnegative()),
});
export type TaskAwardedPayload = z.infer<typeof taskAwardedPayloadSchema>;

export const taskProgressUpdatedPayloadSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  /** Completion percentage, 0-100. */
  progress: z.number().min(0).max(100),
  note: optional(z.string()),
  artifacts: optional(z.array(z.string())),
  at: optional(z.number().int().nonnegative()),
});
export type TaskProgressUpdatedPayload = z.infer<typeof taskProgressUpdatedPayloadSchema>;

/** Deliverable submitted for review (`in_progress → review`). */
export const taskCompletedPayloadSchema = z.object({
  taskId: z.string().min(1),
  /** Artifact references (URLs/IDs); large content goes through HTTP upload. */
  artifacts: optional(z.array(z.string())),
  note: optional(z.string()),
  at: optional(z.number().int().nonnegative()),
});
export type TaskCompletedPayload = z.infer<typeof taskCompletedPayloadSchema>;

export const taskFailedPayloadSchema = z.object({
  taskId: z.string().min(1),
  reason: optional(z.string()),
  at: optional(z.number().int().nonnegative()),
});
export type TaskFailedPayload = z.infer<typeof taskFailedPayloadSchema>;

export const TASK_REVIEW_DECISIONS = ['approve', 'reject', 'request-revision'] as const;
export const taskReviewDecisionSchema = z.enum(TASK_REVIEW_DECISIONS);
export type TaskReviewDecision = z.infer<typeof taskReviewDecisionSchema>;

export const taskReviewDecidedPayloadSchema = z.object({
  taskId: z.string().min(1),
  reviewerId: z.string().min(1),
  decision: taskReviewDecisionSchema,
  comment: optional(z.string()),
  version: optional(z.number().int().nonnegative()),
});
export type TaskReviewDecidedPayload = z.infer<typeof taskReviewDecidedPayloadSchema>;

export const taskReassignedPayloadSchema = z.object({
  taskId: z.string().min(1),
  /** Previous assignee, absent when the task had none. */
  fromAgentId: optional(z.string().min(1)),
  toAgentId: z.string().min(1),
  reassignedBy: z.string().min(1),
  /** True when the admin took the task over manually. */
  humanTakeover: optional(z.boolean()),
  reason: optional(z.string()),
  version: optional(z.number().int().nonnegative()),
});
export type TaskReassignedPayload = z.infer<typeof taskReassignedPayloadSchema>;

export const taskCancelledPayloadSchema = z.object({
  taskId: z.string().min(1),
  cancelledBy: optional(z.string().min(1)),
  reason: optional(z.string()),
  at: optional(z.number().int().nonnegative()),
});
export type TaskCancelledPayload = z.infer<typeof taskCancelledPayloadSchema>;

export const taskDependencyFailedPayloadSchema = z.object({
  parentTaskId: z.string().min(1),
  subtaskId: z.string().min(1),
  /** IDs of subtasks that are blocking the parent (writes `task.blockedBy`). */
  blockedBy: z.array(z.string().min(1)).min(1),
  reason: optional(z.string()),
});
export type TaskDependencyFailedPayload = z.infer<typeof taskDependencyFailedPayloadSchema>;

export const systemErrorPayloadSchema = z.object({
  message: z.string().min(1),
  code: optional(z.number().int()),
  /** Correlates the notification with the dispatcher log line. */
  reqId: optional(z.string()),
  method: optional(z.string()),
  agentId: optional(z.string()),
  detail: optional(z.unknown()),
});
export type SystemErrorPayload = z.infer<typeof systemErrorPayloadSchema>;

// ---------------------------------------------------------------------------
// Account (domain-only) event payloads
// ---------------------------------------------------------------------------

/** Account roles; the single source of truth for `role` everywhere. */
export const ACCOUNT_ROLES = ['admin', 'agent', 'observer'] as const;
export const accountRoleSchema = z.enum(ACCOUNT_ROLES);
export type AccountRole = z.infer<typeof accountRoleSchema>;

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === 'string' && (ACCOUNT_ROLES as readonly string[]).includes(value);
}

/**
 * Written by `agent.register`. `role` defaults to `agent`; `createdAt` lets
 * the reducer keep the wall-clock time of registration (falls back to the
 * envelope `ts` when absent, e.g. for legacy rows).
 */
export const accountRegisteredPayloadSchema = z.object({
  name: z.string().min(1),
  owner: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
  role: accountRoleSchema.optional(),
  createdAt: z.number().int().nonnegative().optional(),
  /**
   * SHA-256 of the issued account secret (never the plaintext). Persisted in
   * the event so replay can rebuild the credential; the digest is not
   * reversible and is never exposed by the roster or any response.
   */
  secretHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type AccountRegisteredPayload = z.infer<typeof accountRegisteredPayloadSchema>;

/** Written by `agent.authenticate` (last-seen watermark for the account). */
export const accountAuthenticatedPayloadSchema = z.object({
  agentId: z.string().min(1).optional(),
  at: z.number().int().nonnegative().optional(),
});
export type AccountAuthenticatedPayload = z.infer<
  typeof accountAuthenticatedPayloadSchema
>;

/**
 * Payload schema per domain-only event type.
 *
 * Only events consumed by a feature module that exists today are listed; the
 * map grows as modules land. Reducers still read payloads defensively, so an
 * unlisted (legacy) type never breaks replay.
 */
export const domainEventPayloadSchemas = {
  'account.registered': accountRegisteredPayloadSchema,
  'account.authenticated': accountAuthenticatedPayloadSchema,
} satisfies Partial<Record<EventType, z.ZodTypeAny>>;

export function getDomainEventPayloadSchema(type: string): z.ZodTypeAny | undefined {
  return (domainEventPayloadSchemas as Record<string, z.ZodTypeAny | undefined>)[type];
}

/** Payload schema per notification event type. */
export const eventPayloadSchemas = {
  'presence.update': presenceUpdatePayloadSchema,
  'message.new': messageNewPayloadSchema,
  'task.bid.received': taskBidReceivedPayloadSchema,
  'task.awarded': taskAwardedPayloadSchema,
  'task.progress.updated': taskProgressUpdatedPayloadSchema,
  'task.completed': taskCompletedPayloadSchema,
  'task.failed': taskFailedPayloadSchema,
  'task.review.decided': taskReviewDecidedPayloadSchema,
  'task.reassigned': taskReassignedPayloadSchema,
  'task.cancelled': taskCancelledPayloadSchema,
  'task.dependency.failed': taskDependencyFailedPayloadSchema,
  'system.error': systemErrorPayloadSchema,
} satisfies Record<NotificationEventType, z.ZodTypeAny>;

export function getEventPayloadSchema(type: string): z.ZodTypeAny | undefined {
  return isNotificationEventType(type) ? eventPayloadSchemas[type] : undefined;
}

/** Validate a payload for a known notification type. */
export function parseEventPayload(type: NotificationEventType, payload: unknown): unknown {
  return eventPayloadSchemas[type].parse(payload);
}

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

const envelopeIdentityShape = {
  /**
   * Global, monotonically increasing, globally unique sequence
   * (`events.seq` AUTOINCREMENT). This is the only resume/dedupe cursor.
   */
  seq: seqSchema,
  /** Aggregate the event belongs to, e.g. `task:tsk_123`, `channel:chn_1`. */
  aggregateId: z.string().min(1),
  /** Monotonic version of the aggregate after this event (CAS / optimistic concurrency). */
  version: z.number().int().nonnegative(),
  /** Milliseconds since epoch. */
  ts: z.number().int().nonnegative(),
  /** Optional hash-chain link for tamper-evident auditing (reserved, not verified in MVP). */
  prevHash: z.string().min(1).optional(),
};

export const eventEnvelopeSchema = z.object({
  ...envelopeIdentityShape,
  type: eventTypeSchema,
  payload: z.unknown(),
});
export type EventEnvelope<T = unknown> = z.infer<typeof eventEnvelopeSchema> & {
  payload: T;
};

/** Build an envelope schema that also validates the concrete payload. */
export function createEventEnvelopeSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    ...envelopeIdentityShape,
    type: eventTypeSchema,
    payload,
  });
}

export function parseEventEnvelope(input: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(input) as EventEnvelope;
}

export function safeParseEventEnvelope(
  input: unknown,
): z.ZodSafeParseResult<EventEnvelope> {
  return eventEnvelopeSchema.safeParse(input) as z.ZodSafeParseResult<EventEnvelope>;
}

// ---------------------------------------------------------------------------
// Event notification (envelope + typed payload, discriminated by `type`)
// ---------------------------------------------------------------------------

function eventNotificationOf<K extends NotificationEventType, T extends z.ZodTypeAny>(
  type: K,
  payload: T,
) {
  return z.object({
    ...envelopeIdentityShape,
    type: z.literal(type),
    payload,
  });
}

/**
 * The exact shape of an `event` notification pushed to subscribers.
 * Discriminated on `type`, so `payload` is narrowed automatically.
 */
export const eventNotificationSchema = z.discriminatedUnion('type', [
  eventNotificationOf('presence.update', presenceUpdatePayloadSchema),
  eventNotificationOf('message.new', messageNewPayloadSchema),
  eventNotificationOf('task.bid.received', taskBidReceivedPayloadSchema),
  eventNotificationOf('task.awarded', taskAwardedPayloadSchema),
  eventNotificationOf('task.progress.updated', taskProgressUpdatedPayloadSchema),
  eventNotificationOf('task.completed', taskCompletedPayloadSchema),
  eventNotificationOf('task.failed', taskFailedPayloadSchema),
  eventNotificationOf('task.review.decided', taskReviewDecidedPayloadSchema),
  eventNotificationOf('task.reassigned', taskReassignedPayloadSchema),
  eventNotificationOf('task.cancelled', taskCancelledPayloadSchema),
  eventNotificationOf('task.dependency.failed', taskDependencyFailedPayloadSchema),
  eventNotificationOf('system.error', systemErrorPayloadSchema),
]);

export type EventNotification = z.infer<typeof eventNotificationSchema>;

export function parseEventNotification(input: unknown): EventNotification {
  return eventNotificationSchema.parse(input);
}

export function safeParseEventNotification(
  input: unknown,
): z.ZodSafeParseResult<EventNotification> {
  return eventNotificationSchema.safeParse(input);
}
