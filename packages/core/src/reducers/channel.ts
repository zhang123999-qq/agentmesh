/**
 * Channel aggregate reducer (channel metadata + membership set).
 *
 * Membership is keyed by agent id: join is idempotent, leave removes the
 * entry. The underlying `channel_members` table stays the relational
 * projection; this state is what replay rebuilds.
 */

import type { CoreEvent } from '../envelope.js';
import { asRecord, readNumber, readString } from '../payload.js';
import type { Reducer } from '../reducer.js';

export interface ChannelMemberState {
  agentId: string;
  joinedAt: number;
}

export interface ChannelState {
  aggregateId: string;
  id: string;
  exists: boolean;
  name: string | null;
  createdBy: string | null;
  createdAt: number | null;
  members: Record<string, ChannelMemberState>;
  version: number;
  lastSeq: number;
}

export function initialChannelState(aggregateId: string): ChannelState {
  return {
    aggregateId,
    id: aggregateId.slice(aggregateId.indexOf(':') + 1),
    exists: false,
    name: null,
    createdBy: null,
    createdAt: null,
    members: {},
    version: 0,
    lastSeq: 0,
  };
}

export const channelReducer: Reducer<ChannelState> = (state, event: CoreEvent) => {
  const next: ChannelState = { ...state, version: event.version, lastSeq: event.seq };
  const payload = asRecord(event.payload);

  switch (event.type) {
    case 'channel.created': {
      return {
        ...next,
        exists: true,
        name: readString(payload, 'name') ?? next.name,
        createdBy: readString(payload, 'createdBy') ?? next.createdBy,
        createdAt: readNumber(payload, 'createdAt') ?? event.ts,
      };
    }
    case 'channel.member.joined': {
      const agentId = readString(payload, 'agentId');
      if (!agentId) {
        return next;
      }
      return {
        ...next,
        members: {
          ...next.members,
          [agentId]: { agentId, joinedAt: readNumber(payload, 'joinedAt') ?? event.ts },
        },
      };
    }
    case 'channel.member.left': {
      const agentId = readString(payload, 'agentId');
      if (!agentId || next.members[agentId] === undefined) {
        return next;
      }
      const members = { ...next.members };
      delete members[agentId];
      return { ...next, members };
    }
    default:
      return next;
  }
};

export function reduceChannel(aggregateId: string, events: readonly CoreEvent[]): ChannelState {
  return events.reduce<ChannelState>(channelReducer, initialChannelState(aggregateId));
}
