import { describe, expect, it } from 'vitest';

import { channelReducer, initialChannelState, reduceChannel } from '../src/index.js';
import { makeEvent } from './helpers.js';

const AGG = 'channel:chn_1';

describe('channelReducer', () => {
  it('creates the channel and tracks membership', () => {
    const events = [
      makeEvent({
        seq: 1,
        version: 1,
        type: 'channel.created',
        aggregateId: AGG,
        ts: 500,
        payload: { channelId: 'chn_1', name: 'builds', createdBy: 'agt_admin' },
      }),
      makeEvent({
        seq: 2,
        version: 2,
        type: 'channel.member.joined',
        aggregateId: AGG,
        ts: 600,
        payload: { agentId: 'agt_1' },
      }),
      makeEvent({
        seq: 3,
        version: 3,
        type: 'channel.member.joined',
        aggregateId: AGG,
        ts: 700,
        payload: { agentId: 'agt_2', joinedAt: 650 },
      }),
    ];
    const state = reduceChannel(AGG, events);
    expect(state).toMatchObject({
      exists: true,
      name: 'builds',
      createdBy: 'agt_admin',
      createdAt: 500,
      version: 3,
      lastSeq: 3,
    });
    expect(Object.keys(state.members).sort()).toEqual(['agt_1', 'agt_2']);
    expect(state.members['agt_1']).toEqual({ agentId: 'agt_1', joinedAt: 600 });
    expect(state.members['agt_2']).toEqual({ agentId: 'agt_2', joinedAt: 650 });
  });

  it('join is idempotent and leave removes the member', () => {
    let state = initialChannelState(AGG);
    state = channelReducer(
      state,
      makeEvent({
        seq: 1,
        version: 1,
        type: 'channel.member.joined',
        aggregateId: AGG,
        ts: 10,
        payload: { agentId: 'agt_1' },
      }),
    );
    state = channelReducer(
      state,
      makeEvent({
        seq: 2,
        version: 2,
        type: 'channel.member.joined',
        aggregateId: AGG,
        ts: 20,
        payload: { agentId: 'agt_1' },
      }),
    );
    expect(Object.keys(state.members)).toEqual(['agt_1']);
    expect(state.members['agt_1']?.joinedAt).toBe(20);

    state = channelReducer(
      state,
      makeEvent({
        seq: 3,
        version: 3,
        type: 'channel.member.left',
        aggregateId: AGG,
        payload: { agentId: 'agt_1' },
      }),
    );
    expect(state.members).toEqual({});
    expect(state.version).toBe(3);
  });

  it('ignores joins without an agent id', () => {
    const state = channelReducer(
      initialChannelState(AGG),
      makeEvent({
        seq: 1,
        version: 1,
        type: 'channel.member.joined',
        aggregateId: AGG,
        payload: {},
      }),
    );
    expect(state.members).toEqual({});
  });
});
