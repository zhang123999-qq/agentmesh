import { describe, expect, it } from 'vitest';

import { accountReducer, initialAccountState, reduceAccount } from '../src/index.js';
import { makeEvent } from './helpers.js';

const AGG = 'account:agt_1';

describe('accountReducer', () => {
  it('starts empty', () => {
    const state = initialAccountState(AGG);
    expect(state).toMatchObject({
      id: 'agt_1',
      exists: false,
      name: null,
      role: 'agent',
      skills: [],
      authenticationCount: 0,
      version: 0,
      lastSeq: 0,
    });
  });

  it('creates an account from account.registered', () => {
    const state = accountReducer(
      initialAccountState(AGG),
      makeEvent({
        seq: 1,
        version: 1,
        type: 'account.registered',
        aggregateId: AGG,
        ts: 1000,
        payload: {
          accountId: 'agt_1',
          name: 'planner',
          owner: 'team-a',
          skills: ['planning', 'review'],
          role: 'admin',
          secretHash: 'a'.repeat(64),
        },
      }),
    );
    expect(state).toMatchObject({
      exists: true,
      name: 'planner',
      owner: 'team-a',
      skills: ['planning', 'review'],
      role: 'admin',
      secretHash: 'a'.repeat(64),
      createdAt: 1000,
      version: 1,
      lastSeq: 1,
    });
  });

  it('falls back to role=agent and drops unknown roles', () => {
    const event = makeEvent({
      seq: 1,
      version: 1,
      type: 'account.registered',
      aggregateId: AGG,
      payload: { name: 'coder', role: 'superuser' },
    });
    expect(accountReducer(initialAccountState(AGG), event).role).toBe('agent');
  });

  it('counts authentications and records the latest one', () => {
    const events = [
      makeEvent({
        seq: 1,
        version: 1,
        type: 'account.registered',
        aggregateId: AGG,
        payload: { name: 'planner' },
      }),
      makeEvent({
        seq: 2,
        version: 2,
        type: 'account.authenticated',
        aggregateId: AGG,
        ts: 2000,
        payload: { accountId: 'agt_1' },
      }),
      makeEvent({
        seq: 3,
        version: 3,
        type: 'account.authenticated',
        aggregateId: AGG,
        ts: 3000,
        payload: { accountId: 'agt_1', at: 2500 },
      }),
    ];
    const state = reduceAccount(AGG, events);
    expect(state.authenticationCount).toBe(2);
    expect(state.lastAuthenticatedAt).toBe(2500);
    expect(state.version).toBe(3);
    expect(state.lastSeq).toBe(3);
  });

  it('only advances bookkeeping for unrelated events', () => {
    const state = accountReducer(
      initialAccountState(AGG),
      makeEvent({
        seq: 9,
        version: 4,
        type: 'presence.update',
        aggregateId: AGG,
        payload: { agentId: 'agt_1', status: 'online' },
      }),
    );
    expect(state.version).toBe(4);
    expect(state.lastSeq).toBe(9);
    expect(state.exists).toBe(false);
  });
});
