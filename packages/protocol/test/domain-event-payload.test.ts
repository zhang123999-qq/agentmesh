import { describe, expect, it } from 'vitest';

import {
  domainEventPayloadSchemas,
} from '../src/index.js';

/**
 * Registry-driven contract for domain-only event payloads.
 *
 * Only events that have schemas in domainEventPayloadSchemas are tested here.
 * Currently: all 11 domain-only types (account.registered,
 * account.authenticated, channel.created, channel.member.joined,
 * channel.member.left, message.created, task.published, task.status.changed,
 * task.bid.placed, task.progress.reported, task.compaction.completed).
 *
 * Domain-only events follow their own schema rules as documented in
 * decisions.md (US-021B P2). Unlike notification payloads (US-021A baseline,
 * `.nullable().optional()`), domain payload optional fields use plain
 * `.optional()`: producers omit them, and an explicit `null` is **rejected** —
 * a missing field and a null field are not interchangeable in the event log.
 * This test pins that contract so a future switch to `.nullable().optional()`
 * fails loudly. New domain event types with schemas MUST add a sample here;
 * otherwise this test fails.
 */
const DOMAIN_SAMPLES: Record<string, { base: Record<string, unknown>; optional: Record<string, unknown> }> = {
  'account.registered': {
    base: {
      name: 'test-agent',
      owner: 'owner',
      skills: ['typescript'],
      role: 'agent',
      createdAt: 1700000000000,
      secretHash: 'a'.repeat(64),
    },
    optional: {
      // .optional() fields: omitted / value accepted, null NOT accepted
      owner: 'other-owner',
      skills: ['go'],
      role: 'observer',
      createdAt: 1700000001000,
      secretHash: 'b'.repeat(64),
    },
  },
  'account.authenticated': {
    base: {},
    optional: {
      agentId: 'agt_1',
      at: 1700000000000,
    },
  },
  'task.compaction.completed': {
    base: {
      compactedTasks: 5,
      totalRemoved: 10,
    },
    optional: {
      errors: ['error1', 'error2'],
    },
  },
  'channel.created': {
    base: {
      channelId: 'chn_1',
      name: 'general',
      createdBy: 'agt_admin',
      createdAt: 1700000000000,
    },
    optional: {},
  },
  'channel.member.joined': {
    base: {
      channelId: 'chn_1',
      agentId: 'agt_1',
      joinedAt: 1700000000000,
    },
    optional: {},
  },
  'channel.member.left': {
    base: {
      channelId: 'chn_1',
      agentId: 'agt_1',
      leftAt: 1700000000000,
    },
    optional: {},
  },
  'message.created': {
    base: {
      messageId: 'msg_1',
      channelId: 'chn_1',
      senderId: 'agt_1',
      body: 'hello',
      createdAt: 1700000000000,
    },
    optional: {},
  },
  'task.published': {
    base: {
      taskId: 'tsk_1',
      title: 'Fix bug',
      requiredSkills: ['go'],
      status: 'open',
      publishedBy: 'agt_admin',
      createdAt: 1700000000000,
    },
    optional: {
      description: 'Fix the thing',
      budget: 100,
      deadline: 1700000001000,
      biddingDeadline: 1700000001000,
      parentId: 'tsk_0',
    },
  },
  'task.status.changed': {
    base: {
      taskId: 'tsk_1',
      from: 'open',
      to: 'in_progress',
      version: 2,
      at: 1700000000000,
    },
    optional: {
      actorId: 'agt_1',
    },
  },
  'task.bid.placed': {
    base: {
      taskId: 'tsk_1',
      bidId: 'bid_1',
      agentId: 'agt_1',
      price: 50,
    },
    optional: {
      eta: 60,
      approach: 'plan first',
      confidence: 0.9,
      createdAt: 1700000000000,
    },
  },
  'task.progress.reported': {
    base: {
      taskId: 'tsk_1',
      agentId: 'agt_1',
      progress: 50,
    },
    optional: {
      note: 'halfway',
      artifacts: ['artifact-1'],
      at: 1700000000000,
    },
  },
};

describe('domain event payload schema contract', () => {
  it('covers every registered domain-only event type with a schema', () => {
    const domainTypes = Object.keys(domainEventPayloadSchemas);
    const sampleTypes = Object.keys(DOMAIN_SAMPLES);
    expect(sampleTypes.sort()).toEqual(domainTypes.sort());
  });

  for (const [type, sample] of Object.entries(DOMAIN_SAMPLES) as [keyof typeof domainEventPayloadSchemas, typeof DOMAIN_SAMPLES[string]][]) {
    it(`${type}: base payload is valid`, () => {
      const schema = domainEventPayloadSchemas[type];
      expect(schema.safeParse(sample.base).success).toBe(true);
    });

    for (const [field, value] of Object.entries(sample.optional)) {
      it(`${type}.${field}: accepts omitted and value (null NOT accepted for .optional())`, () => {
        // Use type-safe access to schema
        const schema = domainEventPayloadSchemas[type];
        // omitted
        expect(schema.safeParse(sample.base).success).toBe(true);
        // value
        expect(schema.safeParse({ ...sample.base, [field]: value }).success).toBe(true);
        // explicit null - NOT accepted for .optional() fields
        expect(schema.safeParse({ ...sample.base, [field]: null }).success).toBe(false);
      });
    }
  }
});

describe('domain event required fields (four-state)', () => {
  const compaction = domainEventPayloadSchemas['task.compaction.completed'];
  const base = { compactedTasks: 5, totalRemoved: 10 };

  for (const field of ['compactedTasks', 'totalRemoved'] as const) {
    it(`task.compaction.completed.${field}: required integer >= 0 (missing/null/negative/float rejected)`, () => {
      expect(compaction.safeParse(base).success).toBe(true);
      // missing → rejected
      const without = { ...base } as Record<string, unknown>;
      delete without[field];
      expect(compaction.safeParse(without).success).toBe(false);
      // explicit null → rejected
      expect(compaction.safeParse({ ...base, [field]: null }).success).toBe(false);
      // negative → rejected (nonnegative())
      expect(compaction.safeParse({ ...base, [field]: -1 }).success).toBe(false);
      // float → rejected (int())
      expect(compaction.safeParse({ ...base, [field]: 1.5 }).success).toBe(false);
      // wrong type → rejected
      expect(compaction.safeParse({ ...base, [field]: '5' }).success).toBe(false);
    });
  }

  it('task.compaction.completed.errors: omitted/array ok, non-array and null rejected', () => {
    expect(compaction.safeParse(base).success).toBe(true);
    expect(compaction.safeParse({ ...base, errors: ['boom'] }).success).toBe(true);
    expect(compaction.safeParse({ ...base, errors: 'not-an-array' }).success).toBe(false);
    expect(compaction.safeParse({ ...base, errors: null }).success).toBe(false);
  });

  it('account.registered requires a non-empty name', () => {
    const schema = domainEventPayloadSchemas['account.registered'];
    // name is the only required field; everything else is .optional()
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: 'agent' }).success).toBe(true);
    expect(schema.safeParse({ name: '' }).success).toBe(false);
  });
});