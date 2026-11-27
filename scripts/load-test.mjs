#!/usr/bin/env node
/**
 * AgentMesh Load Test Script - Simplified Version
 */

import { spawn, execSync } from 'child_process';
import { WebSocket } from 'ws';
import http from 'http';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';

const SERVER_PORT = 18888;
const BASE_URL = `http://localhost:${SERVER_PORT}`;
const WS_URL = `ws://localhost:${SERVER_PORT}/ws`;
const DB_PATH = `/tmp/agentmesh-load-test-${Date.now()}.db`;
const JWT_SECRET = 'test-secret-for-load-testing-only-32bytes!!';

const CONFIG = {
  warmupMs: 2000,
  testMs: 10000,
  cooldownMs: 1000,
  concurrencyLevels: [5, 10, 20],
  messageRate: 50,
  channelCount: 5,
};

let serverProcess = null;
let adminToken = '';
let adminAgentId = '';
const channelIds = [];
const clientTokens = [];
const clientAgentIds = [];

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}

function runCmd(cmd) {
  log(`$ ${cmd}`);
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    log('Command failed:', e.message);
    throw e;
  }
}

function httpPost(path, body, token = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port: SERVER_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(path, token = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port: SERVER_PORT,
      path,
      method: 'GET',
      headers: {},
    };
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;

    const req = http.request(opts, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(chunks) });
        } catch {
          resolve({ status: res.statusCode, body: chunks });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function rpcRequest(method, params, token = null, id = Date.now()) {
  return httpPost('/rpc', { jsonrpc: '2.0', method, params, id }, token);
}

async function startServer() {
  log('Starting server...');
  const dbDir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'));
  mkdirSync(dbDir, { recursive: true });

  serverProcess = spawn('node', ['apps/server/dist/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      DB_PATH,
      JWT_SECRET,
      ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:8787',
      LOG_LEVEL: 'debug',
      METRICS_ENABLED: 'true',
      HASH_CHAIN_VERIFY_INTERVAL_SECONDS: '0',
      TASK_BID_COMPACTION_INTERVAL_SECONDS: '0',
      REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => {
    const msg = d.toString().trim();
    if (msg) log('[server]', msg);
  });
  serverProcess.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg) log('[server:err]', msg);
  });

  for (let i = 0; i < 30; i++) {
    try {
      const res = await httpGet('/health');
      if (res.status === 200) { log('Server ready'); return; }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Server failed to start');
}

async function stopServer() {
  if (serverProcess) {
    log('Stopping server...');
    serverProcess.kill('SIGTERM');
    await new Promise(r => serverProcess.on('exit', r));
    log('Server stopped');
  }
}

async function setupTestData() {
  log('Setting up test data...');

  // Register admin
  const adminName = `admin_${randomUUID().slice(0, 8)}`;
  const regRes = await rpcRequest('agent.register', { name: adminName });
  if (regRes.status !== 200 || regRes.body.error || !regRes.body.result) {
    throw new Error(`Admin register failed: ${JSON.stringify(regRes.body)}`);
  }
  const adminSecret = regRes.body.result.secret;
  const authRes = await rpcRequest('agent.authenticate', { name: adminName, secret: adminSecret });
  if (authRes.status !== 200 || authRes.body.error || !authRes.body.result) {
    throw new Error(`Admin authenticate failed: ${JSON.stringify(authRes.body)}`);
  }
  adminToken = authRes.body.result.token;
  adminAgentId = authRes.body.result.agentId;
  log(`Admin: ${adminAgentId}`);

  // Create channels
  for (let i = 0; i < CONFIG.channelCount; i++) {
    const chRes = await rpcRequest('channel.create', { name: `load-test-ch-${i}` }, adminToken);
    if (chRes.status !== 200 || chRes.body.error || !chRes.body.result) {
      throw new Error(`Channel create failed: ${JSON.stringify(chRes.body)}`);
    }
    channelIds.push(chRes.body.result.channelId);
  }
  log(`Created ${channelIds.length} channels`);

  // Create test agents
  for (let i = 0; i < Math.max(...CONFIG.concurrencyLevels); i++) {
    const name = `agent_${i}_${randomUUID().slice(0, 6)}`;
    const regRes = await rpcRequest('agent.register', { name });
    if (regRes.status !== 200 || regRes.body.error || !regRes.body.result) {
      throw new Error(`Agent register failed: ${JSON.stringify(regRes.body)}`);
    }
    const secret = regRes.body.result.secret;
    const authRes = await rpcRequest('agent.authenticate', { name, secret });
    if (authRes.status !== 200 || authRes.body.error || !authRes.body.result) {
      throw new Error(`Agent authenticate failed: ${JSON.stringify(authRes.body)}`);
    }
    clientTokens.push(authRes.body.result.token);
    clientAgentIds.push(authRes.body.result.agentId);
    await new Promise(r => setTimeout(r, 2500));
  }
  log(`Created ${clientTokens.length} test agents`);

  // Join all agents to all channels
  for (let i = 0; i < clientTokens.length; i++) {
    for (const chId of channelIds) {
      const joinRes = await rpcRequest('channel.join', { channelId: chId }, clientTokens[i]);
      if (joinRes.status !== 200 && joinRes.body.error) {
        // ignore already joined errors
      }
    }
  }
  log('All agents joined all channels');
}

function connectWS(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });
    let settled = false;
    ws.on('open', () => { if (!settled) { settled = true; resolve(ws); } });
    ws.on('error', err => { if (!settled) { settled = true; reject(err); } });
    ws.on('close', () => {});
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('WS connect timeout')); } }, 5000);
  });
}

async function collectMetrics() {
  const res = await httpGet('/metrics');
  if (res.status !== 200) return null;
  const text = res.body;
  const metrics = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const match = line.match(/^(\w+)(?:\{([^}]*)\})?\s+(.+)$/);
    if (match) {
      const [, name, labels, value] = match;
      metrics[name] = metrics[name] || [];
      metrics[name].push({ labels, value: parseFloat(value) });
    }
  }
  return metrics;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function runMessageSendTest(concurrency) {
  log(`\n=== Message Send Test: concurrency=${concurrency} ===`);
  const agents = clientTokens.slice(0, concurrency);
  const results = { sent: 0, failed: 0, latencies: [], errors: [] };
  let channelIdx = 0;

  const sendOne = async (token) => {
    const chId = channelIds[channelIdx % channelIds.length];
    channelIdx++;
    const start = Date.now();
    try {
      const res = await rpcRequest('message.send', { channelId: chId, content: `load test ${Date.now()}` }, token);
      const latency = Date.now() - start;
      if (res.status === 200 && res.body.result) {
        results.sent++; results.latencies.push(latency);
      } else {
        results.failed++; results.errors.push(res.body?.error?.message || 'unknown');
        log(`  Send failed: ${res.body?.error?.message || JSON.stringify(res.body)}`);
      }
    } catch (e) { results.failed++; results.errors.push(e.message); }
  };

  const workers = agents.map(token => async () => {
    const interval = 1000 / CONFIG.messageRate;
    const endTime = Date.now() + CONFIG.testMs;
    while (Date.now() < endTime) { await sendOne(token); await new Promise(r => setTimeout(r, interval)); }
  });

  await Promise.all(workers.map(fn => fn()));

  return {
    concurrency, sent: results.sent, failed: results.failed,
    errorRate: results.failed / (results.sent + results.failed) || 0,
    latencyP50: percentile(results.latencies, 50), latencyP95: percentile(results.latencies, 95),
    latencyP99: percentile(results.latencies, 99), throughput: results.sent / (CONFIG.testMs / 1000),
  };
}

async function runWSBroadcastTest(concurrency) {
  log(`\n=== WS Broadcast Test: concurrency=${concurrency} ===`);
  const agents = clientTokens.slice(0, concurrency);
  const connections = [];
  const receivedCounts = new Map();

  for (const token of agents) {
    try {
      const ws = await connectWS(token);
      connections.push(ws);
      receivedCounts.set(ws, 0);
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'message.new') receivedCounts.set(ws, (receivedCounts.get(ws) || 0) + 1);
        } catch {}
      });
      ws.on('close', () => log('  WS closed'));
      ws.on('error', e => log('  WS error:', e.message));
    } catch (e) { log(`WS connect failed: ${e.message}`); }
  }

  log(`Connected ${connections.length} WS`);

  const endTime = Date.now() + CONFIG.testMs;
  let sent = 0;
  while (Date.now() < endTime) {
    const chId = channelIds[sent % channelIds.length];
    const res = await rpcRequest('message.send', { channelId: chId, content: `broadcast ${sent}` }, adminToken);
    if (res.status !== 200) log(`  Admin send failed: ${res.body?.error?.message}`);
    sent++;
    await new Promise(r => setTimeout(r, 10));
  }

  await new Promise(r => setTimeout(r, 2000));

  let totalReceived = 0;
  for (const [ws, count] of receivedCounts) { totalReceived += count; ws.close(); }

  return { concurrency, connections: connections.length, messagesSent: sent, messagesReceived: totalReceived, deliveryRate: totalReceived / (sent * concurrency) || 0 };
}

async function runTaskBiddingTest(concurrency) {
  log(`\n=== Task Bidding Test: concurrency=${concurrency} ===`);
  const agents = clientTokens.slice(0, concurrency);
  const results = { published: 0, bids: 0, awarded: 0, failed: 0, latencies: [] };

  const publishTask = async () => {
    const start = Date.now();
    try {
      const res = await rpcRequest('task.publish', { title: `Load test ${Date.now()}`, requiredSkills: ['load-test'], biddingDeadline: Date.now() + 5000 }, adminToken);
      const latency = Date.now() - start;
      if (res.status === 200 && res.body.result) { results.published++; results.latencies.push(latency); return res.body.result.taskId; }
      else { results.failed++; log(`  Publish failed: ${res.body?.error?.message}`); }
    } catch (e) { results.failed++; }
    return null;
  };

  const bidOnTask = async (taskId, token) => {
    try {
      const res = await rpcRequest('task.bid', { taskId, approach: 'load test approach' }, token);
      if (res.status === 200) results.bids++; else log(`  Bid failed: ${res.body?.error?.message}`);
    } catch {}
  };

  const awardTask = async (taskId) => {
    try {
      const res = await rpcRequest('task.award', { taskId, expectedVersion: 1 }, adminToken);
      if (res.status === 200) results.awarded++; else log(`  Award failed: ${res.body?.error?.message}`);
    } catch {}
  };

  const endTime = Date.now() + CONFIG.testMs;
  while (Date.now() < endTime) {
    const taskId = await publishTask();
    if (taskId) { await new Promise(r => setTimeout(r, 100)); await Promise.all(agents.map(t => bidOnTask(taskId, t))); await new Promise(r => setTimeout(r, 50)); await awardTask(taskId); }
    await new Promise(r => setTimeout(r, 50));
  }

  return { concurrency, published: results.published, bids: results.bids, awarded: results.awarded, latencyP50: percentile(results.latencies, 50), latencyP95: percentile(results.latencies, 95), throughput: results.published / (CONFIG.testMs / 1000) };
}

async function runLoadTest() {
  log('\n========== LOAD TEST START ==========\n');
  await startServer();
  await setupTestData();
  await new Promise(r => setTimeout(r, CONFIG.warmupMs));

  const allResults = { messageSend: [], wsBroadcast: [], taskBidding: [], metricsSnapshots: [] };

  for (const concurrency of CONFIG.concurrencyLevels) {
    log(`\n--- Testing concurrency: ${concurrency} ---`);
    const metricsBefore = await collectMetrics();

    const msgResult = await runMessageSendTest(concurrency);
    allResults.messageSend.push(msgResult);
    log(`Message Send: ${msgResult.sent} sent, ${msgResult.failed} failed, ${msgResult.throughput.toFixed(1)}/s, P95=${msgResult.latencyP95}ms`);

    const wsResult = await runWSBroadcastTest(concurrency);
    allResults.wsBroadcast.push(wsResult);
    log(`WS Broadcast: ${wsResult.messagesSent} sent, ${wsResult.messagesReceived} received, delivery=${(wsResult.deliveryRate*100).toFixed(1)}%`);

    const taskResult = await runTaskBiddingTest(concurrency);
    allResults.taskBidding.push(taskResult);
    log(`Task Bidding: ${taskResult.published} published, ${taskResult.bids} bids, ${taskResult.awarded} awarded, ${taskResult.throughput.toFixed(1)}/s`);

    const metricsAfter = await collectMetrics();
    allResults.metricsSnapshots.push({ concurrency, before: metricsBefore, after: metricsAfter });
    await new Promise(r => setTimeout(r, CONFIG.cooldownMs));
  }

  await stopServer();
  log('\n========== LOAD TEST COMPLETE ==========\n');
  return allResults;
}

function generateReport(results) {
  let md = '# Load Test Report\n\n';
  md += `**Date**: ${new Date().toISOString()}\n`;
  md += `**DB**: ${DB_PATH}\n`;
  md += `**Test Duration**: ${CONFIG.testMs}ms per concurrency level\n\n`;

  md += '## Message Send Results\n\n';
  md += '| Concurrency | Sent | Failed | Error Rate | Throughput (/s) | P50 (ms) | P95 (ms) | P99 (ms) |\n';
  md += '|-------------|------|--------|------------|-----------------|----------|----------|----------|\n';
  for (const r of results.messageSend) {
    md += `| ${r.concurrency} | ${r.sent} | ${r.failed} | ${(r.errorRate*100).toFixed(2)}% | ${r.throughput.toFixed(1)} | ${r.latencyP50} | ${r.latencyP95} | ${r.latencyP99} |\n`;
  }

  md += '\n## WS Broadcast Results\n\n';
  md += '| Concurrency | Connections | Sent | Received | Delivery Rate |\n';
  md += '|-------------|-------------|------|----------|---------------|\n';
  for (const r of results.wsBroadcast) {
    md += `| ${r.concurrency} | ${r.connections} | ${r.messagesSent} | ${r.messagesReceived} | ${(r.deliveryRate*100).toFixed(1)}% |\n`;
  }

  md += '\n## Task Bidding Results\n\n';
  md += '| Concurrency | Published | Bids | Awarded | Throughput (/s) | P50 (ms) | P95 (ms) |\n';
  md += '|-------------|-----------|------|---------|-----------------|----------|----------|\n';
  for (const r of results.taskBidding) {
    md += `| ${r.concurrency} | ${r.published} | ${r.bids} | ${r.awarded} | ${r.throughput.toFixed(1)} | ${r.latencyP50} | ${r.latencyP95} |\n`;
  }

  md += '\n## Key Metrics (/metrics)\n\n';
  const lastSnap = results.metricsSnapshots[results.metricsSnapshots.length - 1];
  if (lastSnap?.after) {
    const m = lastSnap.after;
    md += '| Metric | Value |\n|--------|-------|\n';
    if (m.agentmesh_rpc_requests_total) for (const v of m.agentmesh_rpc_requests_total) md += `| rpc_requests_total{${v.labels}} | ${v.value} |\n`;
    if (m.agentmesh_ws_sessions) for (const v of m.agentmesh_ws_sessions) md += `| ws_sessions{${v.labels}} | ${v.value} |\n`;
    if (m.agentmesh_hashchain_status) for (const v of m.agentmesh_hashchain_status) md += `| hashchain_status{${v.labels}} | ${v.value} |\n`;
  }

  md += '\n## Updated Capacity Estimates\n\n';
  const maxMsg = results.messageSend[results.messageSend.length - 1];
  const maxWS = results.wsBroadcast[results.wsBroadcast.length - 1];
  const maxTask = results.taskBidding[results.taskBidding.length - 1];

  md += '| Dimension | Measured Value | Previous Estimate |\n';
  md += '|-----------|----------------|-------------------|\n';
  md += `| Max WS Connections | ${maxWS?.connections || 'N/A'} | 1,000–2,000 |\n`;
  md += `| Max Message Throughput | ${maxMsg?.throughput?.toFixed(0) || 'N/A'}/s | 100–500 events/s |\n`;
  md += `| Max Task Throughput | ${maxTask?.throughput?.toFixed(1) || 'N/A'}/s | — |\n`;
  md += `| P95 Latency (msg send) | ${maxMsg?.latencyP95 || 'N/A'}ms | — |\n`;
  md += `| WS Delivery Rate | ${maxWS?.deliveryRate ? (maxWS.deliveryRate*100).toFixed(1)+'%' : 'N/A'} | — |\n`;

  return md;
}

function updateOperationsMd(report) {
  const fs = require('fs');
  const opsPath = 'docs/operations.md';
  let content = fs.readFileSync(opsPath, 'utf8');
  const tableStart = content.indexOf('| 维度 | 单实例合理上限');
  if (tableStart === -1) return;
  const tableEnd = content.indexOf('\n###', tableStart);
  const before = content.substring(0, tableStart);
  const after = tableEnd === -1 ? '' : content.substring(tableEnd);
  const tableLines = report.split('\n').filter(l => l.startsWith('|')).slice(-6); // last 6 table rows
  const newTable = '| 维度 | 单实例合理上限(实测) | 备注 |\n|-----------|----------------|------|\n' + tableLines.join('\n');
  fs.writeFileSync(opsPath, before + newTable + '\n' + after);
  log('Updated docs/operations.md with measured capacity');
}

async function main() {
  try {
    log('Building project...');
    runCmd('npm run build');
    const results = await runLoadTest();
    const report = generateReport(results);
    const reportPath = `load-test-report-${Date.now()}.md`;
    const fs = await import('fs');
    fs.writeFileSync(reportPath, report);
    log(`Report written to ${reportPath}`);
    console.log('\n' + report);
    updateOperationsMd(report);
  } catch (e) {
    log('Load test failed:', e);
    if (serverProcess) serverProcess.kill('SIGKILL');
    process.exit(1);
  }
}

main();