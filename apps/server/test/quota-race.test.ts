/**
 * Quota enforcement must be atomic with the INSERT it guards.
 *
 * The pre-fix code checked `accounts.count(workspaceId) >= maxAgents` *before*
 * opening the write transaction, so two writers (another connection or another
 * instance) could both pass the check and both insert, exceeding the quota.
 * These tests pin the invariant and simulate the race deterministically:
 * while writer A has counted inside its IMMEDIATE transaction, writer B gets
 * one chance to interleave. With the fix B cannot take the write lock; with
 * the pre-fix ordering B commits first and A then pushes the tenant over quota.
 */

import { EventStore } from '@agentmesh/core';
import { JsonRpcErrorCode, ProtocolError } from '@agentmesh/protocol';
import { openStore } from '@agentmesh/store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTokenService } from '../src/auth/token.js';
import { AccountsService } from '../src/modules/accounts.js';

const SECRET = 'test-secret-value-1234567890';
const CLOCK = 1_700_000_000_000;
const WS = 'ws_quota';

function makeService(store: ReturnType<typeof openStore>, prefix: string): AccountsService {
  const events = new EventStore(store.db, { clock: () => CLOCK });
  const tokens = createTokenService({ secret: SECRET, clock: () => CLOCK });
  let counter = 0;
  return new AccountsService({
    db: store.db,
    accounts: store.repos.accounts,
    events,
    tokens,
    workspaces: store.repos.workspaces,
    idFactory: () => `${prefix}${(counter += 1)}`,
    clock: () => CLOCK,
  });
}

function seedWorkspace(store: ReturnType<typeof openStore>, maxAgents: number): void {
  store.repos.workspaces.create({
    id: WS,
    name: 'Quota tenant',
    createdAt: CLOCK,
    inviteCode: 'invite-quota',
    inviteExpiresAt: CLOCK + 1_000_000,
    maxAgents,
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function memoryStore() {
  const store = openStore(':memory:');
  cleanups.push(() => store.db.close());
  return store;
}

function fileStore(dir: string, file: string) {
  const store = openStore(join(dir, file));
  cleanups.push(() => store.db.close());
  return store;
}

function isQuotaError(err: unknown): boolean {
  return err instanceof ProtocolError && err.code === JsonRpcErrorCode.QuotaExceeded;
}

describe('workspace agent quota (atomic with insert)', () => {
  it('rejects the registration that exceeds maxAgents (-32008)', async () => {
    const store = memoryStore();
    seedWorkspace(store, 2);
    const service = makeService(store, 'agt_');

    await service.register({ name: 'a' }, { workspaceId: WS, viaInvite: true });
    await service.register({ name: 'b' }, { workspaceId: WS, viaInvite: true });
    await expect(
      service.register({ name: 'c' }, { workspaceId: WS, viaInvite: true }),
    ).rejects.toSatisfy(isQuotaError);
    expect(store.repos.accounts.count(WS)).toBe(2);
  });

  it('concurrent registrations never exceed maxAgents (Promise.all)', async () => {
    const store = memoryStore();
    seedWorkspace(store, 2);
    const service = makeService(store, 'agt_');

    const settled = await Promise.allSettled(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((name) =>
        service.register({ name }, { workspaceId: WS, viaInvite: true }),
      ),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => isQuotaError(r.reason))).toBe(true);
    expect(store.repos.accounts.count(WS)).toBe(2);
  });

  it('a second writer cannot interleave between the quota check and INSERT', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-quota-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const storeA = fileStore(dir, 'quota.db');
    const storeB = fileStore(dir, 'quota.db');
    // Fail fast instead of blocking 5s on the writer lock while the test
    // thread is inside A's transaction.
    storeB.db.pragma('busy_timeout = 25');
    seedWorkspace(storeA, 2);

    const serviceA = makeService(storeA, 'a_');
    const serviceB = makeService(storeB, 'b_');
    await serviceA.register({ name: 'seed' }, { workspaceId: WS, viaInvite: true });

    // Simulate instance B racing exactly in the window between A's quota read
    // and A's INSERT. With the check inside A's IMMEDIATE transaction, B
    // cannot take the write lock, so the tenant stays at maxAgents.
    const daoA = storeA.repos.accounts;
    const originalCount = daoA.count.bind(daoA);
    let fired = false;
    daoA.count = (workspaceId: string) => {
      const n = originalCount(workspaceId);
      if (!fired && n === 1) {
        fired = true;
        void serviceB
          .register({ name: 'racer' }, { workspaceId: WS, viaInvite: true })
          .catch(() => {
            /* SQLITE_BUSY is the expected outcome under the fix */
          });
      }
      return n;
    };

    await serviceA.register({ name: 'racer-a' }, { workspaceId: WS, viaInvite: true });

    expect(fired).toBe(true);
    expect(daoA.count(WS)).toBe(2);
    expect(storeB.repos.accounts.count(WS)).toBeLessThanOrEqual(2);
  });
});
