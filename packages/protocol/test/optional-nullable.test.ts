import { describe, expect, it } from 'vitest';

import {
  eventPayloadSchemas,
  type NotificationEventType,
} from '../src/index.js';

interface Sample {
  readonly base: Record<string, unknown>;
  readonly optional: Record<string, unknown>;
}

/**
 * Registry-driven contract: every notification type must have a sample, and
 * every optional field must accept both "omitted" and an explicit `null`
 * (backward compatibility for historical rows). New notification types fail
 * this test until a sample is added.
 */
const SAMPLES: Record<NotificationEventType, Sample> = {
  'presence.update': {
    base: { agentId: 'agt_1', status: 'online' },
    optional: { channelId: 'chn_1', at: 1 },
  },
  'message.new': {
    base: {
      messageId: 'msg_1',
      channelId: 'chn_1',
      senderId: 'agt_1',
      content: 'hi',
      createdAt: 1,
    },
    optional: { seq: 1, replyToMessageId: 'msg_0' },
  },
  'task.bid.received': {
    base: { taskId: 'tsk_1', bidId: 'bid_1', agentId: 'agt_1', price: 10 },
    optional: { eta: 10, approach: 'plan', confidence: 0.5, createdAt: 1 },
  },
  'task.awarded': {
    base: { taskId: 'tsk_1', awardeeId: 'agt_1', awardedBy: 'admin' },
    optional: { strategy: 'auto', version: 1 },
  },
  'task.progress.updated': {
    base: { taskId: 'tsk_1', agentId: 'agt_1', progress: 50 },
    optional: { note: 'half', artifacts: ['ref://a'], at: 1 },
  },
  'task.completed': {
    base: { taskId: 'tsk_1' },
    optional: { artifacts: ['ref://a'], note: 'done', at: 1 },
  },
  'task.failed': {
    base: { taskId: 'tsk_1' },
    optional: { reason: 'boom', at: 1 },
  },
  'task.review.decided': {
    base: { taskId: 'tsk_1', reviewerId: 'admin', decision: 'approve' },
    optional: { comment: 'ok', version: 1 },
  },
  'task.reassigned': {
    base: { taskId: 'tsk_1', toAgentId: 'agt_2', reassignedBy: 'admin' },
    optional: { fromAgentId: 'agt_1', humanTakeover: true, reason: 'handoff', version: 1 },
  },
  'task.cancelled': {
    base: { taskId: 'tsk_1' },
    optional: { cancelledBy: 'admin', reason: 'obsolete', at: 1 },
  },
  'task.dependency.failed': {
    base: { parentTaskId: 'tsk_p', subtaskId: 'tsk_s', blockedBy: ['tsk_s'] },
    optional: { reason: 'failed' },
  },
  'system.error': {
    base: { message: 'boom' },
    optional: { code: -32603, reqId: 'r1', method: 'task.get', agentId: 'agt_1', detail: { x: 1 } },
  },
};

describe('optional vs nullable notification contract', () => {
  it('covers every registered notification type', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(eventPayloadSchemas).sort());
  });

  for (const [type, sample] of Object.entries(SAMPLES) as Array<
    [NotificationEventType, Sample]
  >) {
    it(`${type}: omits optional fields by default`, () => {
      expect(eventPayloadSchemas[type].safeParse(sample.base).success).toBe(true);
    });

    for (const [field, value] of Object.entries(sample.optional)) {
      it(`${type}.${field}: accepts omitted, value and explicit null`, () => {
        const schema = eventPayloadSchemas[type];
        expect(schema.safeParse(sample.base).success).toBe(true);
        expect(schema.safeParse({ ...sample.base, [field]: value }).success).toBe(true);
        expect(schema.safeParse({ ...sample.base, [field]: null }).success).toBe(true);
      });
    }
  }
});
