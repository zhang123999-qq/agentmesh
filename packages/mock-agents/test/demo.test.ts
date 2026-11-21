import { describe, expect, it } from 'vitest';

import { runDemo } from '../src/demo.js';

describe('AgentMesh end-to-end demo', () => {
  it('runs both review paths, cancel, and asserts a clean exit', async () => {
    const result = await runDemo();

    expect(result.demoMode).toBe(true);
    expect(result.tasks.code).toMatchObject({ status: 'done', progress: 100 });
    expect(result.tasks.rework).toMatchObject({ status: 'done', progress: 100 });
    expect(result.tasks.cancelled.status).toBe('cancelled');
    expect(result.tasks.code.completedAt).toBeTypeOf('number');
    expect(result.tasks.rework.completedAt).toBeTypeOf('number');

    expect(result.awards).toHaveLength(2);
    expect(result.awards.every((award) => award.exploration)).toBe(true);
    expect(result.awards.every((award) => award.strategy === 'auto')).toBe(true);

    expect(result.versionConflict).toMatchObject({
      expectedVersion: 1,
      currentVersion: 2,
    });

    for (const type of [
      'task.bid.received',
      'task.awarded',
      'task.progress.updated',
      'task.completed',
      'task.review.decided',
      'task.cancelled',
    ]) {
      expect(result.eventTypes).toContain(type);
    }
    expect(result.eventSeqs.length).toBe(result.eventTypes.length);
    for (let i = 1; i < result.eventSeqs.length; i += 1) {
      expect(result.eventSeqs[i]).toBeGreaterThan(result.eventSeqs[i - 1] as number);
    }
    expect(result.cleanExit).toBe(true);
  }, 30_000);
});
