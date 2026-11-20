import { describe, expect, it } from 'vitest';

import {
  MAX_ARTIFACT_REF_LENGTH,
  MAX_ARTIFACTS,
  MAX_PROGRESS_NOTE_LENGTH,
  taskCompleteParamsSchema,
  taskFailParamsSchema,
  taskProgressParamsSchema,
} from '../src/index.js';

describe('US-011 task execution params', () => {
  it('accepts valid progress / complete / fail params', () => {
    expect(
      taskProgressParamsSchema.parse({
        taskId: 'tsk_1',
        progress: 50,
        note: 'halfway',
        artifacts: ['https://artifacts.example/a.zip'],
      }),
    ).toMatchObject({ taskId: 'tsk_1', progress: 50 });

    expect(
      taskCompleteParamsSchema.parse({
        taskId: 'tsk_1',
        expectedVersion: 3,
        artifacts: ['s3://bucket/out.zip'],
      }),
    ).toMatchObject({ expectedVersion: 3 });

    expect(
      taskFailParamsSchema.parse({
        taskId: 'tsk_1',
        expectedVersion: 3,
        reason: 'dependency unavailable',
      }),
    ).toMatchObject({ reason: 'dependency unavailable' });
  });

  it('rejects out-of-range progress and oversized artifacts', () => {
    expect(() =>
      taskProgressParamsSchema.parse({ taskId: 'tsk_1', progress: -1 }),
    ).toThrow();
    expect(() =>
      taskProgressParamsSchema.parse({ taskId: 'tsk_1', progress: 101 }),
    ).toThrow();
    expect(() =>
      taskProgressParamsSchema.parse({
        taskId: 'tsk_1',
        progress: 50,
        note: 'x'.repeat(MAX_PROGRESS_NOTE_LENGTH + 1),
      }),
    ).toThrow();
    expect(() =>
      taskCompleteParamsSchema.parse({
        taskId: 'tsk_1',
        expectedVersion: 3,
        artifacts: Array.from({ length: MAX_ARTIFACTS + 1 }, (_, i) => `a-${i}`),
      }),
    ).toThrow();
    expect(() =>
      taskCompleteParamsSchema.parse({
        taskId: 'tsk_1',
        expectedVersion: 3,
        artifacts: ['x'.repeat(MAX_ARTIFACT_REF_LENGTH + 1)],
      }),
    ).toThrow();
  });

  it('requires a non-negative integer expectedVersion', () => {
    for (const expectedVersion of [-1, 1.5, '3']) {
      expect(() =>
        taskFailParamsSchema.parse({ taskId: 'tsk_1', expectedVersion }),
      ).toThrow();
    }
  });
});
