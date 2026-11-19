import { describe, expect, it } from 'vitest';

import { makeStore } from './helpers.js';

describe('TasksDao', () => {
  it('creates a task with sane defaults and version 0', () => {
    const { repos } = makeStore();
    const task = repos.tasks.create({
      id: 'tsk_1',
      title: 'ship the MVP',
      createdAt: 5_000,
    });

    expect(task).toMatchObject({
      id: 'tsk_1',
      title: 'ship the MVP',
      description: '',
      requiredSkills: [],
      budget: 0,
      status: 'draft',
      assignee: null,
      version: 0,
      parentId: null,
      deadline: null,
      meta: null,
      blockedBy: [],
      createdAt: 5_000,
      updatedAt: 5_000,
      workspaceId: 'default',
    });
    expect(repos.tasks.get('tsk_1')?.version).toBe(0);
  });

  it('round-trips JSON columns (skills, meta, blockedBy)', () => {
    const { repos } = makeStore();
    repos.tasks.create({
      id: 'tsk_1',
      title: 'research',
      requiredSkills: ['research', 'writing'],
      budget: 120.5,
      status: 'open',
      meta: { source: 'admin', priority: 2 },
      blockedBy: ['tsk_0'],
      deadline: 1_700_000_000_000,
    });

    const task = repos.tasks.get('tsk_1');
    expect(task?.requiredSkills).toEqual(['research', 'writing']);
    expect(task?.meta).toEqual({ source: 'admin', priority: 2 });
    expect(task?.blockedBy).toEqual(['tsk_0']);
    expect(task?.deadline).toBe(1_700_000_000_000);
    expect(task?.budget).toBe(120.5);
  });

  it('plain update does not bump version (CAS owns version)', () => {
    const { repos } = makeStore();
    repos.tasks.create({ id: 'tsk_1', title: 't' });
    const updated = repos.tasks.update('tsk_1', { status: 'open', title: 't2' });
    expect(updated?.status).toBe('open');
    expect(updated?.title).toBe('t2');
    expect(updated?.version).toBe(0);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(updated?.createdAt ?? 0);
  });

  it('CAS update succeeds once and bumps the version atomically', () => {
    const { repos } = makeStore();
    repos.tasks.create({ id: 'tsk_1', title: 't', status: 'open' });

    const changes = repos.tasks.updateWithVersion('tsk_1', 0, {
      status: 'awarded',
      assignee: 'agt_1',
    });
    expect(changes).toBe(1);

    const after = repos.tasks.get('tsk_1');
    expect(after?.version).toBe(1);
    expect(after?.status).toBe('awarded');
    expect(after?.assignee).toBe('agt_1');
  });

  it('CAS update with a stale version reports 0 changes and writes nothing', () => {
    const { repos } = makeStore();
    repos.tasks.create({ id: 'tsk_1', title: 't', status: 'open' });
    expect(repos.tasks.updateWithVersion('tsk_1', 0, { assignee: 'agt_1' })).toBe(1);

    // Second writer still holds version 0 → must lose the race.
    const loser = repos.tasks.updateWithVersion('tsk_1', 0, { assignee: 'agt_2' });
    expect(loser).toBe(0);

    const after = repos.tasks.get('tsk_1');
    expect(after?.assignee).toBe('agt_1');
    expect(after?.version).toBe(1);

    // Unknown task also reports 0.
    expect(repos.tasks.updateWithVersion('missing', 0, { assignee: 'x' })).toBe(0);
  });

  it('lists tasks by status (single or many), assignee and parent', () => {
    const { repos } = makeStore();
    repos.tasks.create({ id: 't1', title: 'a', status: 'open', createdAt: 1 });
    repos.tasks.create({ id: 't2', title: 'b', status: 'bidding', createdAt: 2 });
    repos.tasks.create({
      id: 't3',
      title: 'c',
      status: 'awarded',
      assignee: 'agt_1',
      createdAt: 3,
    });
    repos.tasks.create({ id: 't4', title: 'd', status: 'draft', parentId: 't1', createdAt: 4 });

    expect(repos.tasks.list().map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(repos.tasks.list({ status: 'awarded' }).map((t) => t.id)).toEqual(['t3']);
    expect(
      repos.tasks.list({ status: ['open', 'bidding'] }).map((t) => t.id),
    ).toEqual(['t1', 't2']);
    expect(repos.tasks.list({ assignee: 'agt_1' }).map((t) => t.id)).toEqual(['t3']);
    expect(repos.tasks.list({ assignee: null }).map((t) => t.id)).toEqual(['t1', 't2', 't4']);
    expect(repos.tasks.list({ parentId: 't1' }).map((t) => t.id)).toEqual(['t4']);
    expect(repos.tasks.list({ limit: 2, offset: 2 }).map((t) => t.id)).toEqual(['t3', 't4']);
    expect(repos.tasks.count()).toBe(4);
    expect(repos.tasks.count({ status: ['open', 'bidding'] })).toBe(2);
  });

  it('deletes tasks', () => {
    const { repos } = makeStore();
    repos.tasks.create({ id: 't1', title: 'a' });
    expect(repos.tasks.delete('t1')).toBe(true);
    expect(repos.tasks.delete('t1')).toBe(false);
    expect(repos.tasks.get('t1')).toBeUndefined();
  });
});
