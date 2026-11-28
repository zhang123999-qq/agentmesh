import { describe, expect, it } from 'vitest';

import {
  DOMAIN_ONLY_EVENT_TYPES,
  NOTIFICATION_EVENT_TYPES,
  eventEnvelopeSchema,
  eventNotificationSchema,
  eventPayloadSchemas,
  getDomainEventPayloadSchema,
  getEventPayloadSchema,
  isDomainOnlyEventType,
  isNotificationEventType,
  parseDomainEventNotification,
  parseEventNotification,
  safeParseDomainEventNotification,
  type EventNotification,
} from '../src/index.js';

const baseEnvelope = {
  seq: 42,
  aggregateId: 'task:tsk_1',
  type: 'task.awarded',
  version: 3,
  ts: 1_700_000_000_000,
  payload: {
    taskId: 'tsk_1',
    awardeeId: 'agent_coder',
    awardedBy: 'admin_1',
  },
};

describe('event envelope', () => {
  it('accepts a valid envelope', () => {
    const result = eventEnvelopeSchema.safeParse(baseEnvelope);
    expect(result.success).toBe(true);
  });

  it('accepts an optional prevHash (reserved hash-chain slot)', () => {
    const result = eventEnvelopeSchema.safeParse({
      ...baseEnvelope,
      prevHash: 'sha256:deadbeef',
    });
    expect(result.success).toBe(true);
  });

  it('rejects seq 0 because seq is a positive global autoincrement', () => {
    const result = eventEnvelopeSchema.safeParse({ ...baseEnvelope, seq: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer seq', () => {
    const result = eventEnvelopeSchema.safeParse({ ...baseEnvelope, seq: 4.2 });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown event type', () => {
    const result = eventEnvelopeSchema.safeParse({ ...baseEnvelope, type: 'task.nope' });
    expect(result.success).toBe(false);
  });
});

describe('task.awarded payload', () => {
  it('defaults exploration to false and keeps it false when omitted', () => {
    const event = parseEventNotification(baseEnvelope);
    expect(event.type).toBe('task.awarded');
    if (event.type !== 'task.awarded') throw new Error('unreachable');
    expect(event.payload.exploration).toBe(false);
  });

  it('preserves exploration: true (cold-start exploration award)', () => {
    const event = parseEventNotification({
      ...baseEnvelope,
      payload: { ...baseEnvelope.payload, exploration: true },
    });
    if (event.type !== 'task.awarded') throw new Error('unreachable');
    expect(event.payload.exploration).toBe(true);
  });
});

describe('task.review.decided payload', () => {
  it.each(['approve', 'reject', 'request-revision'] as const)(
    'accepts decision %s',
    (decision) => {
      const event = parseEventNotification({
        ...baseEnvelope,
        type: 'task.review.decided',
        payload: { taskId: 'tsk_1', reviewerId: 'admin_1', decision },
      });
      if (event.type !== 'task.review.decided') throw new Error('unreachable');
      expect(event.payload.decision).toBe(decision);
    },
  );

  it('rejects an unsupported decision', () => {
    const result = eventNotificationSchema.safeParse({
      ...baseEnvelope,
      type: 'task.review.decided',
      payload: { taskId: 'tsk_1', reviewerId: 'admin_1', decision: 'maybe' },
    });
    expect(result.success).toBe(false);
  });
});

describe('event notification payload registry', () => {
  it('covers every notification event type', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(getEventPayloadSchema(type)).toBeDefined();
      expect(eventPayloadSchemas[type]).toBeDefined();
    }
  });

  it('returns undefined for domain-only event types', () => {
    expect(getEventPayloadSchema('account.registered')).toBeUndefined();
  });

  it('validates message.new payloads and narrows the union by type', () => {
    const event: EventNotification = parseEventNotification({
      seq: 7,
      aggregateId: 'channel:chn_1',
      type: 'message.new',
      version: 7,
      ts: 1_700_000_000_000,
      payload: {
        messageId: 'msg_1',
        channelId: 'chn_1',
        senderId: 'agent_grok',
        content: 'hello mesh',
        createdAt: 1_700_000_000_000,
        seq: 7,
      },
    });
    if (event.type !== 'message.new') throw new Error('unreachable');
    expect(event.payload.content).toBe('hello mesh');
    expect(event.payload.seq).toBe(7);
  });

  it('rejects a payload that does not match its declared type', () => {
    const result = eventNotificationSchema.safeParse({
      ...baseEnvelope,
      type: 'presence.update',
      payload: { agentId: 'agent_grok', status: 'sleeping' },
    });
    expect(result.success).toBe(false);
  });
});

describe('domain event notification', () => {
  it('parses task.published with its typed payload', () => {
    const event = parseDomainEventNotification({
      seq: 51,
      aggregateId: 'task:tsk_9',
      type: 'task.published',
      version: 1,
      ts: 1_700_000_000_000,
      payload: {
        taskId: 'tsk_9',
        title: 'Deep test',
        requiredSkills: ['go'],
        status: 'open',
        publishedBy: 'agt_admin',
        createdAt: 1_700_000_000_000,
      },
    });
    if (event.type !== 'task.published') throw new Error('unreachable');
    expect(event.payload.title).toBe('Deep test');
    expect(event.payload.status).toBe('open');
  });

  it('parses every domain-only type through its schema', () => {
    for (const type of DOMAIN_ONLY_EVENT_TYPES) {
      const schema = getDomainEventPayloadSchema(type);
      expect(schema, type).toBeDefined();
    }
    expect(DOMAIN_ONLY_EVENT_TYPES).toHaveLength(11);
  });

  it('classifies notification vs domain-only types without overlap', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(isDomainOnlyEventType(type)).toBe(false);
    }
    for (const type of DOMAIN_ONLY_EVENT_TYPES) {
      expect(isNotificationEventType(type)).toBe(false);
      expect(isDomainOnlyEventType(type)).toBe(true);
    }
  });

  it('rejects a domain payload that does not match its declared type', () => {
    const result = safeParseDomainEventNotification({
      seq: 52,
      aggregateId: 'task:tsk_9',
      type: 'task.status.changed',
      version: 2,
      ts: 1_700_000_000_000,
      payload: { taskId: 'tsk_9', from: 'open', to: 'not-a-status' },
    });
    expect(result.success).toBe(false);
  });
});
