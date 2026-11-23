import { EventStore } from '@agentmesh/core';
import { createLogger, loadConfig, startServer } from '@agentmesh/server';
import { openStore, type AgentMeshDatabase } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

const JWT_SECRET = 'test-secret-value-1234567890';

async function makeApp(overrides: Record<string, string> = {}) {
  const store = openStore(':memory:');
  const app = await startServer({
    config: loadConfig({
      NODE_ENV: 'test',
      PORT: '0',
      HOST: '127.0.0.1',
      DB_PATH: ':memory:',
      JWT_SECRET,
      LOG_LEVEL: 'silent',
      ALLOW_ADMIN_SELF_REGISTER: 'true',
      ...overrides,
    }),
    logger: createLogger({ level: 'silent' }),
    store: { db: store.db, repos: store.repos },
  });
  const events = new EventStore(store.db, { workspaceId: 'default' }, store.repos.events);
  return { store, app, events };
}

function appendSome(events: EventStore, count: number): void {
  for (let i = 0; i < count; i += 1) {
    events.append({ aggregateId: `task:tsk_${i}`, type: 'task.published', payload: { i } });
  }
}

function tamper(db: AgentMeshDatabase, seq: number): void {
  db.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify({ tampered: true }), seq);
}

describe('hash-chain monitor (US-021C)', () => {
  it('reports ok for an intact chain and exposes it on /health', async () => {
    const { store, app, events } = await makeApp();
    try {
      appendSome(events, 3);
      // Startup check already ran (default on) before these appends; re-check.
      const state = app.hashChain!.runCheck();
      expect(state.status).toBe('ok');
      expect(state.checked).toBe(3);

      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { hashChain?: string };
      expect(body.hashChain).toBe('ok');
    } finally {
      await app.close();
      store.db.close();
    }
  });

  it('detects a tampered event: state + /health become "mismatch" with seq + aggregateId', async () => {
    const { store, app, events } = await makeApp();
    try {
      appendSome(events, 3);
      expect(app.hashChain!.runCheck().status).toBe('ok');

      tamper(store.db, 1);
      const state = app.hashChain!.runCheck();
      expect(state.status).toBe('mismatch');
      expect(state.mismatch?.seq).toBe(2);
      expect(state.mismatch?.aggregateId).toBe('task:tsk_1');

      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json() as { hashChain?: string };
      expect(body.hashChain).toBe('mismatch');
      // Must not leak payloads or secrets.
      expect(JSON.stringify(body)).not.toContain('payload');
    } finally {
      await app.close();
      store.db.close();
    }
  });

  it('the periodic timer actually re-verifies (integration, not just the function)', async () => {
    const { store, app, events } = await makeApp({ HASH_CHAIN_VERIFY_INTERVAL_SECONDS: '1' });
    try {
      appendSome(events, 2);
      expect(app.hashChain!.isRunning()).toBe(true);

      // Tamper after the timer started; only a real timer tick will observe it.
      tamper(store.db, 1);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(app.hashChain!.state.status).toBe('mismatch');
    } finally {
      await app.close();
      store.db.close();
    }
  });

  it('disables the timer when the interval is 0 (startup check still runs)', async () => {
    const { store, app } = await makeApp({ HASH_CHAIN_VERIFY_INTERVAL_SECONDS: '0' });
    try {
      expect(app.hashChain!.isRunning()).toBe(false);
      expect(app.hashChain!.state.status).toBe('ok');
    } finally {
      await app.close();
      store.db.close();
    }
  });
});
