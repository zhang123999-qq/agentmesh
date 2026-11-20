import { z } from 'zod';

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
