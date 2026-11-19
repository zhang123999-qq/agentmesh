import type { EventType } from '@agentmesh/protocol';
import {
  createRepositories,
  openDatabase,
  runMigrations,
  type AgentMeshDatabase,
  type Repositories,
} from '@agentmesh/store';

import { EventStore, type CoreEvent } from '../src/index.js';

export const FIXED_TS = 1_700_000_000_000;

export interface TestCore {
  db: AgentMeshDatabase;
  repos: Repositories;
  store: EventStore;
}

/** Fresh in-memory database + event store, with a deterministic clock. */
export function makeCore(options: { hashChain?: boolean; workspaceId?: string } = {}): TestCore {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const repos = createRepositories(db);
  let tick = 0;
  const store = new EventStore(
    db,
    {
      clock: () => FIXED_TS + tick++,
      hashChain: options.hashChain,
      workspaceId: options.workspaceId,
    },
    // Share the repository DAO so onAppend observers see store writes — the
    // same wiring production uses (the orphan-DAO gap the audit flagged).
    repos.events,
  );
  return { db, repos, store };
}

/** Build an envelope directly (pure reducer tests, no database). */
export function makeEvent<T = unknown>(args: {
  seq: number;
  version: number;
  type: EventType;
  payload: T;
  aggregateId: string;
  ts?: number;
  prevHash?: string;
}): CoreEvent<T> {
  const event: CoreEvent<T> = {
    seq: args.seq,
    aggregateId: args.aggregateId,
    type: args.type,
    version: args.version,
    payload: args.payload,
    ts: args.ts ?? FIXED_TS,
  };
  if (args.prevHash !== undefined) {
    event.prevHash = args.prevHash;
  }
  return event;
}

/** A numeric base that increments, to script versions/seqs in tests. */
export function counter(start = 1): () => number {
  let value = start;
  return () => value++;
}
