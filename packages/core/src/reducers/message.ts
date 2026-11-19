/**
 * Message aggregate reducer.
 *
 * A message is immutable once created; `message.created` is the domain event,
 * `message.new` is the notification twin emitted when the same row is pushed.
 * Both are accepted so a log that only carries pushes still replays.
 */

import type { CoreEvent } from '../envelope.js';
import { asRecord, readNumber, readString } from '../payload.js';
import type { Reducer } from '../reducer.js';

export interface MessageState {
  aggregateId: string;
  id: string;
  exists: boolean;
  channelId: string | null;
  senderId: string | null;
  content: string | null;
  /** Global seq of the creating event (shared with `messages.seq`). */
  seq: number | null;
  createdAt: number | null;
  replyToMessageId: string | null;
  version: number;
  lastSeq: number;
}

export function initialMessageState(aggregateId: string): MessageState {
  return {
    aggregateId,
    id: aggregateId.slice(aggregateId.indexOf(':') + 1),
    exists: false,
    channelId: null,
    senderId: null,
    content: null,
    seq: null,
    createdAt: null,
    replyToMessageId: null,
    version: 0,
    lastSeq: 0,
  };
}

export const messageReducer: Reducer<MessageState> = (state, event: CoreEvent) => {
  const next: MessageState = { ...state, version: event.version, lastSeq: event.seq };
  const payload = asRecord(event.payload);

  switch (event.type) {
    case 'message.created':
    case 'message.new': {
      return {
        ...next,
        exists: true,
        channelId: readString(payload, 'channelId') ?? next.channelId,
        senderId: readString(payload, 'senderId') ?? next.senderId,
        // `message.created` domain payloads use `body`; notifications use `content`.
        content: readString(payload, 'content') ?? readString(payload, 'body') ?? next.content,
        seq: readNumber(payload, 'seq') ?? event.seq,
        createdAt: readNumber(payload, 'createdAt') ?? event.ts,
        replyToMessageId: readString(payload, 'replyToMessageId') ?? next.replyToMessageId,
      };
    }
    default:
      return next;
  }
};

export function reduceMessage(aggregateId: string, events: readonly CoreEvent[]): MessageState {
  return events.reduce<MessageState>(messageReducer, initialMessageState(aggregateId));
}
