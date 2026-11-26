import { createLogger, loadConfig, MetricsRegistry, startServer } from '@agentmesh/server';
import { openStore } from '@agentmesh/store';
import { afterEach, describe, expect, it } from 'vitest';

describe('MetricsRegistry (unit)', () => {
  it('renders counters, gauges and histogram buckets', () => {
    const r = new MetricsRegistry();
    r.incCounter('c_total', { method: 'x' }, 'a counter');
    r.incCounter('c_total', { method: 'x' });
    r.setGauge('g', 3, {}, 'a gauge');
    r.observe('h_ms', 12, { method: 'x' }, 'a histogram', [5, 10, 25]);
    const text = r.render();
    expect(text).toContain('# TYPE c_total counter');
    expect(text).toContain('c_total{method="x"} 2');
    expect(text).toContain('g 3');
    expect(text).toContain('h_ms_bucket{method="x",le="5"} 0');
    expect(text).toContain('h_ms_bucket{method="x",le="10"} 0');
    expect(text).toContain('h_ms_bucket{method="x",le="25"} 1');
    expect(text).toContain('h_ms_bucket{method="x",le="+Inf"} 1');
    expect(text).toContain('h_ms_count{method="x"} 1');
  });
});

const JWT_SECRET = 'test-secret-value-1234567890';

async function makeApp() {
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
    }),
    logger: createLogger({ level: 'silent' }),
    store: { db: store.db, repos: store.repos },
  });
  return { app, store };
}

const closers: Array<{ close: () => Promise<void>; dbClose: () => void }> = [];
afterEach(async () => {
  while (closers.length > 0) {
    const c = closers.pop();
    await c?.close();
    c?.dbClose();
  }
});

describe('/metrics (integration)', () => {
  it('exposes live gauges, workspace totals and per-method rpc counters', async () => {
    const { app, store } = await makeApp();
    closers.push({ close: () => app.close(), dbClose: () => store.db.close() });

    // Drive one RPC so a counter series exists.
    await app.dispatcher.dispatch(
      { jsonrpc: '2.0', id: 1, method: 'agent.register', params: { name: 'metrics-agent' } },
      {},
    );

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    // gauges computed at render time
    expect(body).toContain('agentmesh_ws_sessions 0');
    expect(body).toMatch(/agentmesh_hashchain_status\{status="ok"\} 1/);
    expect(body).toMatch(/agentmesh_workspaces_total 1/);
    expect(body).toMatch(/agentmesh_workspaces_disabled 0/);
    // rpc counter for the dispatched method (labels render alphabetically)
    expect(body).toMatch(/agentmesh_rpc_requests_total\{code="ok",method="agent\.register"\} 1/);
    expect(body).toContain('agentmesh_rpc_duration_ms_bucket');
  });

  it('404s when METRICS_ENABLED=false', async () => {
    const store = openStore(':memory:');
    const app = await startServer({
      config: loadConfig({
        NODE_ENV: 'test',
        PORT: '0',
        HOST: '127.0.0.1',
        DB_PATH: ':memory:',
        JWT_SECRET,
        LOG_LEVEL: 'silent',
        METRICS_ENABLED: 'false',
      }),
      logger: createLogger({ level: 'silent' }),
      store: { db: store.db, repos: store.repos },
    });
    closers.push({ close: () => app.close(), dbClose: () => store.db.close() });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });
});
