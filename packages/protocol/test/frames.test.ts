import { describe, expect, it } from 'vitest';

import {
  ackFrameSchema,
  controlFrameSchema,
  gapTooLargeFrameSchema,
  isControlFrame,
  resumeFrameSchema,
  serverControlFrameSchema,
  welcomeFrameSchema,
} from '../src/index.js';

describe('welcome frame', () => {
  it('carries epoch, global seq watermark and negotiated protocol version', () => {
    const frame = welcomeFrameSchema.parse({
      type: 'welcome',
      epoch: 'epoch-1',
      seq: 128,
      protocolVersion: '1.0.0',
      replayWindow: 1000,
    });
    expect(frame.epoch).toBe('epoch-1');
    expect(frame.seq).toBe(128);
  });

  it('rejects a welcome without epoch', () => {
    const result = welcomeFrameSchema.safeParse({
      type: 'welcome',
      seq: 0,
      protocolVersion: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('accepts seq 0 for a fresh workspace', () => {
    const result = welcomeFrameSchema.safeParse({
      type: 'welcome',
      epoch: 'epoch-1',
      seq: 0,
      protocolVersion: '1.0.0',
    });
    expect(result.success).toBe(true);
  });
});

describe('resume frame', () => {
  it('requires lastSeenSeq and keeps lastSeenEpoch optional for third parties', () => {
    expect(resumeFrameSchema.safeParse({ type: 'resume', lastSeenSeq: 0 }).success).toBe(
      true,
    );
    const withEpoch = resumeFrameSchema.parse({
      type: 'resume',
      lastSeenSeq: 42,
      lastSeenEpoch: 'epoch-1',
    });
    expect(withEpoch.lastSeenSeq).toBe(42);
    expect(withEpoch.lastSeenEpoch).toBe('epoch-1');
  });

  it('rejects a missing lastSeenSeq', () => {
    expect(
      resumeFrameSchema.safeParse({ type: 'resume', lastSeenEpoch: 'epoch-1' }).success,
    ).toBe(false);
  });
});

describe('ack frame', () => {
  it('always carries epoch', () => {
    const frame = ackFrameSchema.parse({ type: 'ack', epoch: 'epoch-1', seq: 50 });
    expect(frame.epoch).toBe('epoch-1');
    expect(ackFrameSchema.safeParse({ type: 'ack', seq: 50 }).success).toBe(false);
  });
});

describe('gap_too_large degradation signal', () => {
  it('is valid as both a frame and an error data payload shape', () => {
    const frame = gapTooLargeFrameSchema.parse({
      type: 'gap_too_large',
      signal: 'gap_too_large',
      epoch: 'epoch-1',
      fromSeq: 1,
      currentSeq: 100_000,
      window: 1000,
    });
    expect(frame.signal).toBe('gap_too_large');
    expect(isControlFrame(frame)).toBe(true);
  });
});

describe('control frame discrimination', () => {
  it('parses every server frame by its type', () => {
    expect(
      serverControlFrameSchema.safeParse({
        type: 'welcome',
        epoch: 'e',
        seq: 0,
        protocolVersion: '1.0.0',
      }).success,
    ).toBe(true);
    expect(
      serverControlFrameSchema.safeParse({ type: 'resume', lastSeenSeq: 1 }).success,
    ).toBe(false);
  });

  it('rejects frames with an unknown type', () => {
    expect(controlFrameSchema.safeParse({ type: 'bye' }).success).toBe(false);
    expect(isControlFrame({ type: 'bye' })).toBe(false);
    expect(isControlFrame({ method: 'agent.list' })).toBe(false);
  });
});
