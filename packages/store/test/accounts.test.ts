import { describe, expect, it } from 'vitest';

import { AccountsDao, DEFAULT_WORKSPACE_ID } from '../src/index.js';
import { makeStore } from './helpers.js';

describe('AccountsDao', () => {
  it('creates and reads an account with JSON skills round-tripping', () => {
    const { repos } = makeStore();
    const created = repos.accounts.create({
      id: 'agt_1',
      name: 'planner',
      owner: 'alice',
      skills: ['planning', 'research'],
      role: 'agent',
      createdAt: 1_000,
    });

    expect(created).toEqual({
      id: 'agt_1',
      name: 'planner',
      owner: 'alice',
      skills: ['planning', 'research'],
      role: 'agent',
      createdAt: 1_000,
      workspaceId: DEFAULT_WORKSPACE_ID,
    });

    expect(repos.accounts.get('agt_1')).toEqual(created);
    expect(repos.accounts.getByName('planner')?.id).toBe('agt_1');
    expect(repos.accounts.get('missing')).toBeUndefined();
  });

  it('defaults role to agent and skills to [] and is scoped by workspace', () => {
    const { repos } = makeStore();
    const created = repos.accounts.create({ id: 'agt_2', name: 'coder' });
    expect(created.role).toBe('agent');
    expect(created.skills).toEqual([]);
    expect(created.owner).toBeNull();
    expect(repos.accounts.get('agt_2', 'other-ws')).toBeUndefined();
  });

  it('rejects duplicate names through the UNIQUE constraint', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'agt_1', name: 'planner' });
    expect(() => repos.accounts.create({ id: 'agt_2', name: 'planner' })).toThrow(/UNIQUE/i);
  });

  it('lists accounts filtered by role with limit/offset', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'a1', name: 'admin', role: 'admin', createdAt: 1 });
    repos.accounts.create({ id: 'a2', name: 'worker', role: 'agent', createdAt: 2 });
    repos.accounts.create({ id: 'a3', name: 'watcher', role: 'observer', createdAt: 3 });

    expect(repos.accounts.list()).toHaveLength(3);
    expect(repos.accounts.list({ role: 'admin' }).map((a) => a.id)).toEqual(['a1']);
    expect(repos.accounts.list({ limit: 1, offset: 1 }).map((a) => a.id)).toEqual(['a2']);
    expect(repos.accounts.count()).toBe(3);
  });

  it('updates fields, including owner nulling and skill replacement', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'a1', name: 'worker', owner: 'alice', skills: ['x'] });

    const updated = repos.accounts.update('a1', {
      name: 'worker-2',
      owner: null,
      skills: ['y', 'z'],
      role: 'observer',
    });
    expect(updated?.name).toBe('worker-2');
    expect(updated?.owner).toBeNull();
    expect(updated?.skills).toEqual(['y', 'z']);
    expect(updated?.role).toBe('observer');
    expect(repos.accounts.getByName('worker-2')?.id).toBe('a1');

    // Empty patch is a no-op that still returns the row.
    expect(repos.accounts.update('a1', {})?.name).toBe('worker-2');
    expect(repos.accounts.update('nope', { name: 'x' })).toBeUndefined();
  });

  it('deletes accounts and reports whether a row was removed', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'a1', name: 'worker' });
    expect(repos.accounts.delete('a1')).toBe(true);
    expect(repos.accounts.delete('a1')).toBe(false);
    expect(repos.accounts.get('a1')).toBeUndefined();
  });

  it('stores and reads secret_hash without ever exposing it on the account model', () => {
    const { repos } = makeStore();
    const created = repos.accounts.create({ id: 'a1', name: 'worker' });

    // Rows without a credential read as null, and the model has no secret field.
    expect(repos.accounts.getSecretHash('a1')).toBeNull();
    expect(created).not.toHaveProperty('secretHash');
    expect(created).not.toHaveProperty('secret_hash');

    const digest = 'a'.repeat(64);
    expect(repos.accounts.setSecretHash('a1', digest)).toBe(true);
    expect(repos.accounts.getSecretHash('a1')).toBe(digest);
    // The digest never leaks back through the normal account projection.
    expect(repos.accounts.get('a1')).toEqual(created);

    // Clearing is supported (e.g. credential rotation/revocation).
    expect(repos.accounts.setSecretHash('a1', null)).toBe(true);
    expect(repos.accounts.getSecretHash('a1')).toBeNull();

    // Missing rows are reported, not silently created.
    expect(repos.accounts.setSecretHash('ghost', digest)).toBe(false);
    expect(repos.accounts.getSecretHash('ghost')).toBeNull();
  });

  it('scopes secret_hash reads/writes by workspace', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'a1', name: 'worker' });

    const digest = 'b'.repeat(64);
    expect(repos.accounts.setSecretHash('a1', digest, DEFAULT_WORKSPACE_ID)).toBe(true);
    expect(repos.accounts.getSecretHash('a1', DEFAULT_WORKSPACE_ID)).toBe(digest);

    // A different tenant does not see or overwrite the credential.
    expect(repos.accounts.getSecretHash('a1', 'other-ws')).toBeNull();
    expect(repos.accounts.setSecretHash('a1', 'c'.repeat(64), 'other-ws')).toBe(false);
    expect(repos.accounts.getSecretHash('a1', DEFAULT_WORKSPACE_ID)).toBe(digest);
  });

  it('finds names across every workspace (matching the global UNIQUE constraint)', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'a1', name: 'shared', workspaceId: 'other-ws' });

    expect(repos.accounts.getByName('shared')).toBeUndefined();
    expect(repos.accounts.getByName('shared', 'other-ws')?.id).toBe('a1');
    expect(repos.accounts.getByNameAnyWorkspace('shared')?.id).toBe('a1');
    expect(repos.accounts.getByName('shared', 'other-ws')?.workspaceId).toBe('other-ws');

    // The table-wide UNIQUE makes the second tenant's claim impossible too.
    expect(() => repos.accounts.create({ id: 'a2', name: 'shared' })).toThrow(/UNIQUE/i);
    expect(repos.accounts.getByNameAnyWorkspace('missing')).toBeUndefined();
  });

  it('honours offset without a limit (SQLite needs LIMIT -1)', () => {
    const { repos } = makeStore();
    repos.accounts.create({ id: 'a1', name: 'one', createdAt: 1 });
    repos.accounts.create({ id: 'a2', name: 'two', createdAt: 2 });
    repos.accounts.create({ id: 'a3', name: 'three', createdAt: 3 });

    expect(repos.accounts.list({ offset: 0 }).map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    expect(repos.accounts.list({ offset: 1 }).map((a) => a.id)).toEqual(['a2', 'a3']);
    expect(repos.accounts.list({ offset: 2 }).map((a) => a.id)).toEqual(['a3']);
    expect(repos.accounts.list({ offset: 99 })).toEqual([]);
    // Offset still composes with a limit and a role filter.
    expect(repos.accounts.list({ limit: 1, offset: 1 }).map((a) => a.id)).toEqual(['a2']);
    expect(repos.accounts.list({ offset: 2, role: 'agent' }).map((a) => a.id)).toEqual(['a3']);
  });

  it('can be constructed directly from a database handle', () => {
    const { db } = makeStore();
    const dao = new AccountsDao(db);
    dao.create({ id: 'direct', name: 'direct' });
    expect(dao.count()).toBe(1);
  });
});
