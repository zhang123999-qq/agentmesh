import type { StoredEvent } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

import {
  buildAckFrame,
  buildGapTooLargeFrame,
  buildPingFrame,
  buildPongFrame,
  buildWelcomeFrame,
  controlFrameType,
  decodeFrame,
  encodeFrame,
  errorResponseFrame,
  eventNotification,
  presenceNotification,
  readClientControlFrame,
  readPingTs,
  readResumeFrame,
} from '../src/ws/framing.js';

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('decodeFrame', () => {
  it('accepts strings, buffers, array buffers and buffer arrays', () => {
    const text = '{"type":"ping","ts":1}';
    expect(decodeFrame(text)).toEqual({ ok: true, value: { type: 'ping', ts: 1 } });
    expect(decodeFrame(utf8(text))).toEqual({ ok: true, value: { type: 'ping', ts: 1 } });

    const arrayBuffer = new TextEncoder().encode(text).buffer;
    expect(decodeFrame(arrayBuffer)).toEqual({ ok: true, value: { type: 'ping', ts: 1 } });

    const chunks = [utf8('{"a":'), utf8('1}')];
    expect(decodeFrame(chunks)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('rejects unsupported payload types and invalid JSON', () => {
    expect(decodeFrame(42)).toEqual({ ok: false, reason: 'unsupported payload type' });
    expect(decodeFrame(undefined)).toEqual({ ok: false, reason: 'unsupported payload type' });
    expect(decodeFrame('{not json')).toEqual({ ok: false, reason: 'invalid JSON' });
  });

  it('round-trips through encodeFrame', () => {
    const frame = { type: 'pong', ts: 7 };
    expect(decodeFrame(encodeFrame(frame))).toEqual({ ok: true, value: frame });
  });
});

describe('control frame reads', () => {
  it('detects a control type only on plain objects with a string type', () => {
    expect(controlFrameType({ type: 'resume' })).toBe('resume');
    expect(controlFrameType({ type: 1 })).toBeUndefined();
    expect(controlFrameType({})).toBeUndefined();
    expect(controlFrameType(null)).toBeUndefined();
    expect(controlFrameType([])).toBeUndefined();
    expect(controlFrameType('resume')).toBeUndefined();
  });

  it('validates resume frames', () => {
    expect(readResumeFrame({ type: 'resume', lastSeenSeq: 3 })).toEqual({
      type: 'resume',
      lastSeenSeq: 3,
    });
    expect(readResumeFrame({ type: 'resume', lastSeenSeq: -1 })).toBeUndefined();
    expect(readResumeFrame({ type: 'ping' })).toBeUndefined();
    expect(readResumeFrame(null)).toBeUndefined();
  });

  it('reads a ping timestamp only when finite and numeric', () => {
    expect(readPingTs({ type: 'ping', ts: 9 })).toBe(9);
    expect(readPingTs({ type: 'ping' })).toBeUndefined();
    expect(readPingTs({ type: 'ping', ts: '9' })).toBeUndefined();
    expect(readPingTs({ type: 'ping', ts: Number.NaN })).toBeUndefined();
    expect(readPingTs(null)).toBeUndefined();
  });

  it('classifies client control frames', () => {
    expect(readClientControlFrame({ type: 'resume', lastSeenSeq: 1 })).toMatchObject({
      type: 'resume',
      lastSeenSeq: 1,
    });
    expect(readClientControlFrame({ type: 'ping', ts: 2 })).toEqual({ type: 'ping', ts: 2 });
    expect(readClientControlFrame({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(readClientControlFrame({ type: 'pong' })).toBeUndefined();
    expect(readClientControlFrame({ type: 'resume', lastSeenSeq: 'x' })).toBeUndefined();
  });
});

describe('outbound frame builders', () => {
  it('omits absent optional welcome fields and includes present ones', () => {
    const bare = buildWelcomeFrame({ epoch: 'e1', seq: 0 });
    expect(bare).toMatchObject({ type: 'welcome', epoch: 'e1', seq: 0 });
    expect('agentId' in bare).toBe(false);
    expect('replayWindow' in bare).toBe(false);
    expect('heartbeatIntervalMs' in bare).toBe(false);
    expect('serverTime' in bare).toBe(false);

    const full = buildWelcomeFrame({
      epoch: 'e1',
      seq: 5,
      agentId: 'agt_1',
      replayWindow: 1000,
      heartbeatIntervalMs: 30000,
      serverTime: 123,
    });
    expect(full).toMatchObject({
      agentId: 'agt_1',
      replayWindow: 1000,
      heartbeatIntervalMs: 30000,
      serverTime: 123,
    });
  });

  it('builds ack, gap, ping and pong frames', () => {
    expect(buildAckFrame('e1', 4)).toEqual({ type: 'ack', epoch: 'e1', seq: 4 });
    expect(buildAckFrame('e1', 4, 'req-1')).toMatchObject({ requestId: 'req-1' });

    expect(
      buildGapTooLargeFrame({
        epoch: 'e1',
        fromSeq: 2,
        currentSeq: 50,
        window: 10,
        detail: 'buffer_exceeded',
      }),
    ).toMatchObject({ detail: 'buffer_exceeded', fromSeq: 2, currentSeq: 50 });
    expect(buildGapTooLargeFrame({ epoch: 'e1', fromSeq: 2, currentSeq: 50, window: 10 })).not.toHaveProperty(
      'detail',
    );

    expect(buildPingFrame()).toEqual({ type: 'ping' });
    expect(buildPingFrame(5)).toEqual({ type: 'ping', ts: 5 });
    expect(buildPongFrame()).toEqual({ type: 'pong' });
    expect(buildPongFrame(6)).toEqual({ type: 'pong', ts: 6 });
  });

  it('builds event and presence notifications', () => {
    const event: StoredEvent = {
      seq: 12,
      aggregateId: 'channel:ch_1',
      type: 'message.new',
      version: 3,
      payload: { messageId: 'msg_1' },
      ts: 1700,
      prevHash: 'abc',
      workspaceId: 'default',
    };
    const frame = eventNotification(event);
    expect(frame.method).toBe('message.new');
    expect(frame.params).toMatchObject({ seq: 12, aggregateId: 'channel:ch_1', prevHash: 'abc' });

    const noHash = eventNotification({ ...event, prevHash: null });
    expect((noHash.params as Record<string, unknown>).prevHash).toBeUndefined();

    const presence = presenceNotification({
      agentId: 'agt_1',
      status: 'online',
      at: 1,
    });
    expect(presence.method).toBe('presence.update');
    expect(presence.params).toMatchObject({ agentId: 'agt_1', status: 'online' });
  });

  it('builds error responses with and without data', () => {
    expect(errorResponseFrame('id-1', -32001, 'no')).toEqual({
      jsonrpc: '2.0',
      id: 'id-1',
      error: { code: -32001, message: 'no' },
    });
    expect(errorResponseFrame(null, -32700, 'bad', { at: 1 })).toMatchObject({
      id: null,
      error: { data: { at: 1 } },
    });
  });
});
