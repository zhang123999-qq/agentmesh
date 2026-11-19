import { describe, expect, it } from 'vitest';

import { makeStore } from './helpers.js';

describe('ChannelsDao', () => {
  it('creates, reads, lists, updates and deletes channels', () => {
    const { repos } = makeStore();
    const created = repos.channels.create({
      id: 'chn_1',
      name: 'general',
      createdBy: 'admin_1',
      createdAt: 10,
    });
    expect(created.name).toBe('general');
    expect(created.createdBy).toBe('admin_1');
    expect(created.workspaceId).toBe('default');
    expect(repos.channels.get('chn_1')).toEqual(created);

    repos.channels.create({ id: 'chn_2', name: 'dev', createdBy: 'admin_2', createdAt: 20 });
    expect(repos.channels.list().map((c) => c.id)).toEqual(['chn_1', 'chn_2']);
    expect(repos.channels.list({ createdBy: 'admin_2' }).map((c) => c.id)).toEqual(['chn_2']);
    expect(repos.channels.count()).toBe(2);

    const renamed = repos.channels.update('chn_1', { name: 'lobby' });
    expect(renamed?.name).toBe('lobby');
    expect(repos.channels.update('missing', { name: 'x' })).toBeUndefined();

    expect(repos.channels.delete('chn_2')).toBe(true);
    expect(repos.channels.delete('chn_2')).toBe(false);
    expect(repos.channels.count()).toBe(1);
  });
});

describe('ChannelMembersDao', () => {
  it('adds members idempotently on the composite primary key', () => {
    const { repos } = makeStore();
    repos.channels.create({ id: 'chn_1', name: 'general', createdBy: 'admin_1' });

    const first = repos.channelMembers.add({
      channelId: 'chn_1',
      agentId: 'agt_1',
      joinedAt: 100,
    });
    const second = repos.channelMembers.add({ channelId: 'chn_1', agentId: 'agt_1', joinedAt: 999 });

    expect(second.joinedAt).toBe(100);
    expect(second).toEqual(first);
    expect(repos.channelMembers.count('chn_1')).toBe(1);
    expect(repos.channelMembers.isMember('chn_1', 'agt_1')).toBe(true);
    expect(repos.channelMembers.isMember('chn_1', 'agt_9')).toBe(false);
  });

  it('lists members by channel and by agent', () => {
    const { repos } = makeStore();
    repos.channelMembers.add({ channelId: 'chn_1', agentId: 'agt_a', joinedAt: 2 });
    repos.channelMembers.add({ channelId: 'chn_1', agentId: 'agt_b', joinedAt: 1 });
    repos.channelMembers.add({ channelId: 'chn_2', agentId: 'agt_a', joinedAt: 3 });

    expect(repos.channelMembers.listByChannel('chn_1').map((m) => m.agentId)).toEqual([
      'agt_b',
      'agt_a',
    ]);
    expect(repos.channelMembers.listByAgent('agt_a').map((m) => m.channelId)).toEqual([
      'chn_1',
      'chn_2',
    ]);
  });

  it('removes members and scopes lookups by workspace', () => {
    const { repos } = makeStore();
    repos.channelMembers.add({ channelId: 'chn_1', agentId: 'agt_a' });
    expect(repos.channelMembers.get('chn_1', 'agt_a')?.channelId).toBe('chn_1');
    expect(repos.channelMembers.get('chn_1', 'agt_a', 'other-ws')).toBeUndefined();

    expect(repos.channelMembers.remove('chn_1', 'agt_a')).toBe(true);
    expect(repos.channelMembers.remove('chn_1', 'agt_a')).toBe(false);
    expect(repos.channelMembers.isMember('chn_1', 'agt_a')).toBe(false);
  });
});
