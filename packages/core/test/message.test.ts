import { describe, expect, it } from 'vitest';

import { initialMessageState, messageReducer, reduceMessage } from '../src/index.js';
import { makeEvent } from './helpers.js';

const AGG = 'message:msg_1';

describe('messageReducer', () => {
  it('builds a message from message.created (body field)', () => {
    const state = messageReducer(
      initialMessageState(AGG),
      makeEvent({
        seq: 7,
        version: 1,
        type: 'message.created',
        aggregateId: AGG,
        ts: 1234,
        payload: {
          channelId: 'chn_1',
          senderId: 'agt_1',
          body: 'hello world',
          createdAt: 1200,
          replyToMessageId: 'msg_0',
        },
      }),
    );
    expect(state).toMatchObject({
      exists: true,
      channelId: 'chn_1',
      senderId: 'agt_1',
      content: 'hello world',
      seq: 7,
      createdAt: 1200,
      replyToMessageId: 'msg_0',
      version: 1,
      lastSeq: 7,
    });
  });

  it('accepts the message.new notification twin (content field)', () => {
    const state = reduceMessage(AGG, [
      makeEvent({
        seq: 3,
        version: 1,
        type: 'message.new',
        aggregateId: AGG,
        ts: 900,
        payload: {
          messageId: 'msg_1',
          channelId: 'chn_1',
          senderId: 'agt_2',
          content: 'via notification',
          createdAt: 850,
          seq: 3,
        },
      }),
    ]);
    expect(state.content).toBe('via notification');
    expect(state.seq).toBe(3);
    expect(state.createdAt).toBe(850);
  });

  it('defaults seq to the envelope seq and ignores unrelated events', () => {
    const state = messageReducer(
      initialMessageState(AGG),
      makeEvent({
        seq: 11,
        version: 1,
        type: 'message.created',
        aggregateId: AGG,
        payload: { channelId: 'chn_1', senderId: 'agt_1', body: 'x' },
      }),
    );
    expect(state.seq).toBe(11);
    expect(state.createdAt).toBe(1_700_000_000_000);

    const untouched = messageReducer(
      state,
      makeEvent({
        seq: 12,
        version: 2,
        type: 'presence.update',
        aggregateId: AGG,
        payload: {},
      }),
    );
    expect(untouched.content).toBe('x');
    expect(untouched.version).toBe(2);
  });
});
