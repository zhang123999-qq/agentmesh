import { z } from 'zod';

import { taskReviewDecisionSchema } from './events.js';

/**
 * JSON-RPC params for the US-011 execution methods.
 *
 * The server handlers still perform structured validation (so they can return
 * precise `-32602 data.field`); these schemas are the single source of truth
 * for SDK/client types and future generated documentation.
 */

export const MAX_PROGRESS_NOTE_LENGTH = 2000;
export const MAX_ARTIFACTS = 32;
export const MAX_ARTIFACT_REF_LENGTH = 2048;

const artifactsSchema = z
  .array(z.string().min(1).max(MAX_ARTIFACT_REF_LENGTH))
  .max(MAX_ARTIFACTS)
  .optional();

export const taskProgressParamsSchema = z.object({
  taskId: z.string().min(1),
  /** Completion percentage, 0-100. */
  progress: z.number().min(0).max(100),
  note: z.string().max(MAX_PROGRESS_NOTE_LENGTH).optional(),
  /** Artifact references (URLs/IDs); large content uses HTTP upload. */
  artifacts: artifactsSchema,
});
export type TaskProgressParams = z.infer<typeof taskProgressParamsSchema>;

export const taskCompleteParamsSchema = z.object({
  taskId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  note: z.string().max(MAX_PROGRESS_NOTE_LENGTH).optional(),
  artifacts: artifactsSchema,
});
export type TaskCompleteParams = z.infer<typeof taskCompleteParamsSchema>;

export const taskFailParamsSchema = z.object({
  taskId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().max(MAX_PROGRESS_NOTE_LENGTH).optional(),
});
export type TaskFailParams = z.infer<typeof taskFailParamsSchema>;

export const taskReviewParamsSchema = z.object({
  taskId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  decision: taskReviewDecisionSchema,
  comment: z.string().max(MAX_PROGRESS_NOTE_LENGTH).optional(),
});
export type TaskReviewParams = z.infer<typeof taskReviewParamsSchema>;

export const taskReassignParamsSchema = z.object({
  taskId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  toAgentId: z.string().min(1),
  reason: z.string().max(MAX_PROGRESS_NOTE_LENGTH).optional(),
});
export type TaskReassignParams = z.infer<typeof taskReassignParamsSchema>;

export const taskCancelParamsSchema = z.object({
  taskId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().max(MAX_PROGRESS_NOTE_LENGTH).optional(),
});
export type TaskCancelParams = z.infer<typeof taskCancelParamsSchema>;

export const messageHistoryParamsSchema = z.object({
  channelId: z.string().min(1),
  beforeSeq: z.number().int().nonnegative().optional(),
  afterSeq: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type MessageHistoryParams = z.infer<typeof messageHistoryParamsSchema>;

export const taskBidParamsSchema = z.object({
  taskId: z.string().min(1),
  price: z.number().nonnegative(),
  eta: z.number().nonnegative().optional(),
  approach: z.string().max(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type TaskBidParams = z.infer<typeof taskBidParamsSchema>;

export const taskAwardParamsSchema = z.object({
  taskId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  awardeeId: z.string().min(1).optional(),
  strategy: z.enum(['manual', 'auto']).optional(),
});
export type TaskAwardParams = z.infer<typeof taskAwardParamsSchema>;
