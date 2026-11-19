/**
 * Account aggregate reducer.
 *
 * Events: `account.registered` (creates the account) and
 * `account.authenticated` (updates the last-seen watermark).
 */

import { ACCOUNT_ROLES } from '@agentmesh/protocol';
import type { AccountRole } from '@agentmesh/protocol';

import type { CoreEvent } from '../envelope.js';
import { asRecord, readNumber, readOneOf, readString, readStringArray } from '../payload.js';
import type { Reducer } from '../reducer.js';


export interface AccountState {
  aggregateId: string;
  /** Bare account id (`agt_1` for `account:agt_1`). */
  id: string;
  exists: boolean;
  name: string | null;
  owner: string | null;
  skills: string[];
  role: AccountRole;
  createdAt: number | null;
  /** SHA-256 of the account secret, when the registration event carried it. */
  secretHash: string | null;
  lastAuthenticatedAt: number | null;
  authenticationCount: number;
  /** Aggregate version of the last applied event. */
  version: number;
  lastSeq: number;
}

export function initialAccountState(aggregateId: string): AccountState {
  return {
    aggregateId,
    id: aggregateId.slice(aggregateId.indexOf(':') + 1),
    exists: false,
    name: null,
    owner: null,
    skills: [],
    role: 'agent',
    createdAt: null,
    secretHash: null,
    lastAuthenticatedAt: null,
    authenticationCount: 0,
    version: 0,
    lastSeq: 0,
  };
}

export const accountReducer: Reducer<AccountState> = (state, event: CoreEvent) => {
  const next: AccountState = { ...state, version: event.version, lastSeq: event.seq };
  const payload = asRecord(event.payload);

  switch (event.type) {
    case 'account.registered': {
      const role = readOneOf(payload, 'role', ACCOUNT_ROLES) ?? 'agent';
      return {
        ...next,
        exists: true,
        name: readString(payload, 'name') ?? next.name,
        owner: readString(payload, 'owner') ?? next.owner,
        skills: readStringArray(payload, 'skills') ?? next.skills,
        role,
        createdAt: readNumber(payload, 'createdAt') ?? event.ts,
        secretHash: readString(payload, 'secretHash') ?? next.secretHash,
      };
    }
    case 'account.authenticated': {
      return {
        ...next,
        lastAuthenticatedAt: readNumber(payload, 'at') ?? event.ts,
        authenticationCount: next.authenticationCount + 1,
      };
    }
    default:
      return next;
  }
};

/** Fold helper bound to the account initial state. */
export function reduceAccount(aggregateId: string, events: readonly CoreEvent[]): AccountState {
  return events.reduce<AccountState>(accountReducer, initialAccountState(aggregateId));
}
