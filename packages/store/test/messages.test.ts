import { describe, expect, it } from 'vitest';

import { makeStore } from './helpers.js';

function seed(repos: ReturnType<typeof makeStore>['repos'], count: number): void {
  for (let i = 1; i <= count; i += 1) {
    repos.messages.create({
      id: `msg_${i}`,
      channelId: 'chn_1',
      senderId: 'agt_1',
      seq: i * 10,
      body: `hello ${i}`,
      createdAt: i,
    });
  }
}

describe('MessagesDao', () => {
  it('creates and reads a message with its global seq', () => {
    const { repos } = makeStore();
    const created = repos.messages.create({
      id: 'msg_1',
      channelId: 'chn_1',
      senderId: 'agt_1',
      seq: 42,
      body: 'hello',
      createdAt: 7,
    });

    expect(created.seq).toBe(42);
    expect(created.createdAt).toBe(7);
    expect(created.workspaceId).toBe('default');
    expect(repos.messages.get('msg_1')).toEqual(created);
    expect(repos.messages.get('msg_1', 'other-ws')).toBeUndefined();
  });

  it('pages channel history by seq with afterSeq/beforeSeq', () => {
    const { repos } = makeStore();
    seed(repos, 5);

    const all = repos.messages.listByChannel('chn_1');
    expect(all.map((m) => m.seq)).toEqual([10, 20, 30, 40, 50]);

    const after = repos.messages.listByChannel('chn_1', { afterSeq: 20 });
    expect(after.map((m) => m.seq)).toEqual([30, 40, 50]);

    const between = repos.messages.listByChannel('chn_1', { afterSeq: 10, beforeSeq: 40 });
    expect(between.map((m) => m.seq)).toEqual([20, 30]);

    const limited = repos.messages.listByChannel('chn_1', { limit: 2 });
    expect(limited.map((m) => m.seq)).toEqual([10, 20]);

    const desc = repos.messages.listByChannel('chn_1', { order: 'desc', limit: 2 });
    expect(desc.map((m) => m.seq)).toEqual([50, 40]);
  });

  it('latest() returns the tail of a channel oldest-first', () => {
    const { repos } = makeStore();
    seed(repos, 4);
    expect(repos.messages.latest('chn_1', 2).map((m) => m.seq)).toEqual([30, 40]);
    expect(repos.messages.count('chn_1')).toBe(4);
  });

  it('isolates channels from each other', () => {
    const { repos } = makeStore();
    seed(repos, 2);
    repos.messages.create({
      id: 'msg_other',
      channelId: 'chn_2',
      senderId: 'agt_2',
      seq: 99,
      body: 'elsewhere',
    });
    expect(repos.messages.listByChannel('chn_2').map((m) => m.id)).toEqual(['msg_other']);
    expect(repos.messages.count('chn_2')).toBe(1);
  });

  it('rejects a duplicate global seq (v3 unique index)', () => {
    const { repos } = makeStore();
    seed(repos, 1); // seq = 10

    // Same channel.
    expect(() =>
      repos.messages.create({
        id: 'msg_dup',
        channelId: 'chn_1',
        senderId: 'agt_1',
        seq: 10,
        body: 'duplicate seq',
      }),
    ).toThrow(/UNIQUE constraint failed: messages\.seq/);

    // seq is global, so another workspace cannot reuse it either.
    expect(() =>
      repos.messages.create({
        id: 'msg_dup_ws',
        channelId: 'chn_2',
        senderId: 'agt_2',
        seq: 10,
        body: 'duplicate seq in another workspace',
        workspaceId: 'other-ws',
      }),
    ).toThrow(/UNIQUE constraint failed: messages\.seq/);

    expect(repos.messages.count('chn_1')).toBe(1);
    expect(repos.messages.count('chn_1', 'other-ws')).toBe(0);
  });

  it('updates the body and deletes messages', () => {
    const { repos } = makeStore();
    seed(repos, 1);
    const updated = repos.messages.update('msg_1', { body: 'edited' });
    expect(updated?.body).toBe('edited');
    expect(repos.messages.update('msg_1', {})?.body).toBe('edited');
    expect(repos.messages.update('missing', { body: 'x' })).toBeUndefined();

    expect(repos.messages.delete('msg_1')).toBe(true);
    expect(repos.messages.delete('msg_1')).toBe(false);
    expect(repos.messages.count('chn_1')).toBe(0);
  });
});
