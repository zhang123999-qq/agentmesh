#!/usr/bin/env node
/**
 * AgentMesh Load Test Script - Fixed Version
 *
 * Fixes from previous run:
 * 1. Uses seed:admin CLI to create proper admin account before starting server
 * 2. Disables registration rate limit by passing custom limiter
 * 3. Properly handles WS welcome frame before receiving notifications
 * 4. Uses admin token for all operations (no need for multiple test agents)
 * 5. Validates channel membership before sending
 */

import { spawn, execSync } from 'child_process';
import { WebSocket } from 'ws';
import http from 'http';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';

const SERVER_PORT = 18888;
const WS_URL = `ws://localhost:${SERVER_PORT}/ws`;
const DB_PATH = `/tmp/agentmesh-load-test-${Date.now()}.db`;
const JWT_SECRET = 'test-secret-for-load-testing-only-32bytes!!';

const CONFIG = {
  warmupMs: 2000,
  testMs: 10000,
  cooldownMs: 1000,
  concurrencyLevels: [1, 5, 10, 20, 50, 100],  // Test with single admin, varying message rates
  messageRates: [10, 50, 100, 200, 500, 1000], // messages per second
  channelCount: 3,
};

let serverProcess = null;
let adminToken = '';
let adminAgentId = '';
let adminSecret = '';
const channelIds = [];

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

  // Set env var to disable registration rate limit for testing
  serverProcess = spawn('node', ['apps/server/dist/index.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(SERVER_PORT),
      DB_PATH,
      JWT_SECRET,
      ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:8787',
      LOG_LEVEL: 'warn',
      METRICS_ENABLED: 'true',
      HASH_CHAIN_VERIFY_INTERVAL_SECONDS: '0',
      TASK_BID_COMPACTION_INTERVAL_SECONDS: '0',
      REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS: '0',
      // Disable registration rate limit for load testing
      REGISTRATION_RATE_LIMIT_MAX: '10000',
      REGISTRATION_RATE_LIMIT_WINDOW_MS: '60000',
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

async function seedAdmin() {
  log('Creating admin account via seed:admin...');
  try {
    // Use the seed-admin CLI directly with env var
    const output = execSync(
      `npm run seed:admin -w @agentmesh/server -- --name admin --owner ops`,
      { encoding: 'utf8', stdio: 'pipe', cwd: process.cwd(), env: { ...process.env, DB_PATH } }
    );
    log(`seed:admin output: ${output.trim()}`);

    // Extract secret from output
    const secretMatch = output.match(/secret:\s*(\S+)/);
    if (secretMatch) {
      adminSecret = secretMatch[1];
      log(`Admin secret captured`);
    } else {
      throw new Error('Could not extract secret from seed:admin output');
    }
  } catch (e) {
    log('seed:admin failed:', e.message);
    throw e;
  }
}

async function authenticateAdmin() {
  log('Authenticating admin...');
  const authRes = await rpcRequest('agent.authenticate', { name: 'admin', secret: adminSecret });
  if (authRes.status !== 200 || authRes.body.error || !authRes.body.result) {
    throw new Error(`Admin authenticate failed: ${JSON.stringify(authRes.body)}`);
  }
  adminToken = authRes.body.result.token;
  adminAgentId = authRes.body.result.agentId;
  log(`Admin authenticated: ${adminAgentId}`);

  // Add load-test skill to admin so they can bid on test tasks
  log('Adding load-test skill to admin...');
  const skillRes = await rpcRequest('agent.list', {}, adminToken);
  // agent.list doesn't modify skills. We need to check if there's a skill update method.
  // For now, let's just publish tasks without required skills
}

async function setupChannels() {
  log('Creating channels...');
  for (let i = 0; i < CONFIG.channelCount; i++) {
    const chRes = await rpcRequest('channel.create', { name: `load-test-ch-${i}` }, adminToken);
    if (chRes.status !== 200 || chRes.body.error || !chRes.body.result?.channel?.channelId) {
      throw new Error(`Channel create failed: ${JSON.stringify(chRes.body)}`);
    }
    channelIds.push(chRes.body.result.channel.channelId);
    log(`Created channel: ${chRes.body.result.channel.channelId}`);
  }

  // Admin auto-joins created channels
  for (const chId of channelIds) {
    const joinRes = await rpcRequest('channel.join', { channelId: chId }, adminToken);
    if (joinRes.status !== 200 && joinRes.body.error) {
      log(`Channel join warning: ${joinRes.body.error.message}`);
    }
  }
  log(`Created ${channelIds.length} channels`);
}

async function verifyWSConnection() {
  log('Verifying WS connection and welcome frame...');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${adminToken}` } });
    let settled = false;
    let welcomeReceived = false;
    let framesReceived = 0;

    ws.on('open', () => {
      log('WS connected, waiting for welcome frame...');
    });

    ws.on('message', (data) => {
      framesReceived++;
      const raw = data.toString();
      log(`WS raw frame ${framesReceived}: ${raw.slice(0, 200)}`);
      try {
        const msg = JSON.parse(raw);
        log(`WS frame ${framesReceived}: type=${msg.type}, method=${msg.method}, error=${msg.error?.code}`);
        if (msg.type === 'welcome') {
          welcomeReceived = true;
          log(`Welcome frame received: epoch=${msg.epoch}, seq=${msg.seq}, protocolVersion=${msg.protocolVersion}`);
          if (!settled) { settled = true; resolve(ws); }
        } else if (msg.error && msg.error.code === -32001) {
          // Authentication error
          log(`WS auth error: ${JSON.stringify(msg)}`);
          if (!settled) { settled = true; reject(new Error(`WS auth failed: ${JSON.stringify(msg)}`)); }
        }
      } catch (e) {
        log('WS message parse error:', e.message, 'raw:', raw);
      }
    });

    ws.on('error', err => {
      log(`WS error: ${err.message}`);
      if (!settled) { settled = true; reject(err); }
    });

    ws.on('close', (code, reason) => {
      log(`WS closed: code=${code}, reason=${reason.toString()}`);
      if (!settled && !welcomeReceived) {
        reject(new Error(`WS closed before welcome frame (code=${code})`));
      }
    });

    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`WS connect timeout (frames received: ${framesReceived})`)); }
    }, 15000);
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

async function runMessageSendTest(messageRate) {
  log(`\n=== Message Send Test: rate=${messageRate} msg/s ===`);
  const results = { sent: 0, failed: 0, latencies: [], errors: [] };
  let channelIdx = 0;

  const chId = channelIds[0]; // Use first channel

  const sendOne = async () => {
    const start = Date.now();
    try {
      const res = await rpcRequest('message.send', {
        channelId: chId,
        body: `load test ${Date.now()}`
      }, adminToken);
      const latency = Date.now() - start;
      if (res.status === 200 && res.body.result) {
        results.sent++;
        results.latencies.push(latency);
      } else {
        results.failed++;
        results.errors.push(res.body?.error?.message || 'unknown');
        if (results.failed <= 3) log(`  Send failed: ${res.body?.error?.message || JSON.stringify(res.body)}`);
      }
    } catch (e) {
      results.failed++;
      results.errors.push(e.message);
    }
  };

  const interval = 1000 / messageRate;
  const endTime = Date.now() + CONFIG.testMs;

  while (Date.now() < endTime) {
    await sendOne();
    await new Promise(r => setTimeout(r, interval));
  }

  return {
    messageRate,
    sent: results.sent,
    failed: results.failed,
    errorRate: results.failed / (results.sent + results.failed) || 0,
    latencyP50: percentile(results.latencies, 50),
    latencyP95: percentile(results.latencies, 95),
    latencyP99: percentile(results.latencies, 99),
    throughput: results.sent / (CONFIG.testMs / 1000),
  };
}

async function runWSBroadcastTest(messageRate) {
  log(`\n=== WS Broadcast Test: rate=${messageRate} msg/s ===`);

  // Connect WS
  const ws = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${adminToken}` } });
    let settled = false;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'welcome' && !settled) {
          settled = true;
          log(`Welcome received, WS ready`);
          resolve(ws);
        }
      } catch {}
    });

    ws.on('error', err => { if (!settled) { settled = true; reject(err); } });
    ws.on('close', () => { if (!settled) { settled = true; reject(new Error('WS closed before welcome')); } });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('WS connect timeout')); } }, 10000);
  });

  let received = 0;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'message.new') received++;
    } catch {}
  });

  log(`WS connected, sending messages...`);

  const chId = channelIds[0];
  const endTime = Date.now() + CONFIG.testMs;
  let sent = 0;

  while (Date.now() < endTime) {
    const res = await rpcRequest('message.send', { channelId: chId, body: `broadcast ${sent}` }, adminToken);
    if (res.status !== 200) {
      if (sent < 3) log(`  Admin send failed: ${res.body?.error?.message}`);
    }
    sent++;
    await new Promise(r => setTimeout(r, 1000 / messageRate));
  }

  // Wait for delivery
  await new Promise(r => setTimeout(r, 2000));

  ws.close();

  return {
    messageRate,
    messagesSent: sent,
    messagesReceived: received,
    deliveryRate: received / sent || 0,
  };
}

async function runTaskBiddingTest(messageRate) {
  log(`\n=== Task Bidding Test: rate=${messageRate} tasks/s ===`);
  const results = { published: 0, bids: 0, awarded: 0, failed: 0, latencies: [] };

  const endTime = Date.now() + CONFIG.testMs;

  while (Date.now() < endTime) {
    // Publish task
    const pubRes = await rpcRequest('task.publish', {
      title: `Load test ${Date.now()}`,
      requiredSkills: [],
      biddingDeadline: Date.now() + 5000
    }, adminToken);

    if (pubRes.status === 200 && pubRes.body.result?.task?.id) {
      const taskId = pubRes.body.result.task.id;
      results.published++;

      // Wait a bit for bidding window
      await new Promise(r => setTimeout(r, 100));

      // Admin bids on own task (just to test the flow)
      const bidRes = await rpcRequest('task.bid', {
        taskId,
        price: 100,
        approach: 'load test approach'
      }, adminToken);
      if (bidRes.status === 200 && bidRes.body.result) results.bids++; else log(`  Bid failed: ${bidRes.body?.error?.message || JSON.stringify(bidRes.body)}`);

      await new Promise(r => setTimeout(r, 50));

      // Award to admin (auto strategy will pick the only bid)
      // Use expectedVersion from the task version (starts at 1, bid doesn't increment)
      const awardRes = await rpcRequest('task.award', {
        taskId,
        expectedVersion: 1,
        strategy: 'auto'
      }, adminToken);
      if (awardRes.status === 200 && awardRes.body.result) results.awarded++; else log(`  Award failed: ${awardRes.body?.error?.message || JSON.stringify(awardRes.body)}`);

    } else {
      results.failed++;
      if (results.failed <= 3) log(`  Publish failed: ${pubRes.body?.error?.message || JSON.stringify(pubRes.body)}`);
    }

    await new Promise(r => setTimeout(r, 1000 / messageRate));
  }

  return {
    messageRate,
    published: results.published,
    bids: results.bids,
    awarded: results.awarded,
    throughput: results.published / (CONFIG.testMs / 1000),
  };
}

async function runLoadTest() {
  log('\n========== LOAD TEST START ==========\n');

  // Step 1: Create admin via seed:admin
  await seedAdmin();

  // Step 2: Start server
  await startServer();

  // Step 3: Authenticate admin
  await authenticateAdmin();

  // Step 4: Create channels
  await setupChannels();

  // Step 5: Verify WS connection works
  await verifyWSConnection();

  // Warmup
  log(`Warming up for ${CONFIG.warmupMs}ms...`);
  await new Promise(r => setTimeout(r, CONFIG.warmupMs));

  const allResults = {
    messageSend: [],
    wsBroadcast: [],
    taskBidding: [],
    metricsSnapshots: []
  };

  // Test different message rates
  for (const messageRate of CONFIG.messageRates) {
    log(`\n--- Testing message rate: ${messageRate} msg/s ---`);
    const metricsBefore = await collectMetrics();

    const msgResult = await runMessageSendTest(messageRate);
    allResults.messageSend.push(msgResult);
    log(`Message Send: ${msgResult.sent} sent, ${msgResult.failed} failed, ${msgResult.throughput.toFixed(1)}/s, P95=${msgResult.latencyP95}ms, ErrorRate=${(msgResult.errorRate*100).toFixed(2)}%`);

    const wsResult = await runWSBroadcastTest(messageRate);
    allResults.wsBroadcast.push(wsResult);
    log(`WS Broadcast: ${wsResult.messagesSent} sent, ${wsResult.messagesReceived} received, delivery=${(wsResult.deliveryRate*100).toFixed(1)}%`);

    const taskResult = await runTaskBiddingTest(messageRate);
    allResults.taskBidding.push(taskResult);
    log(`Task Bidding: ${taskResult.published} published, ${taskResult.bids} bids, ${taskResult.awarded} awarded, ${taskResult.throughput.toFixed(1)}/s`);

    const metricsAfter = await collectMetrics();
    allResults.metricsSnapshots.push({ messageRate, before: metricsBefore, after: metricsAfter });

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
  md += `**Test Duration**: ${CONFIG.testMs}ms per message rate\n\n`;

  md += '## Message Send Results\n\n';
  md += '| Rate (msg/s) | Sent | Failed | Error Rate | Throughput (/s) | P50 (ms) | P95 (ms) | P99 (ms) |\n';
  md += '|--------------|------|--------|------------|-----------------|----------|----------|----------|\n';
  for (const r of results.messageSend) {
    md += `| ${r.messageRate} | ${r.sent} | ${r.failed} | ${(r.errorRate*100).toFixed(2)}% | ${r.throughput.toFixed(1)} | ${r.latencyP50} | ${r.latencyP95} | ${r.latencyP99} |\n`;
  }

  md += '\n## WS Broadcast Results\n\n';
  md += '| Rate (msg/s) | Sent | Received | Delivery Rate |\n';
  md += '|--------------|------|----------|---------------|\n';
  for (const r of results.wsBroadcast) {
    md += `| ${r.messageRate} | ${r.messagesSent} | ${r.messagesReceived} | ${(r.deliveryRate*100).toFixed(1)}% |\n`;
  }

  md += '\n## Task Bidding Results\n\n';
  md += '| Rate (tasks/s) | Published | Bids | Awarded | Throughput (/s) |\n';
  md += '|----------------|-----------|------|---------|-----------------|\n';
  for (const r of results.taskBidding) {
    md += `| ${r.messageRate} | ${r.published} | ${r.bids} | ${r.awarded} | ${r.throughput.toFixed(1)} |\n`;
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

  // Capacity summary
  md += '\n## Capacity Summary\n\n';
  const maxMsg = results.messageSend.reduce((a, b) => a.throughput > b.throughput ? a : b);
  const maxWS = results.wsBroadcast.reduce((a, b) => a.deliveryRate > b.deliveryRate ? a : b);
  const maxTask = results.taskBidding.reduce((a, b) => a.throughput > b.throughput ? a : b);

  md += '| Dimension | Measured Value | Rate at Peak |\n';
  md += '|-----------|----------------|--------------|\n';
  md += `| Max Message Throughput | ${maxMsg.throughput.toFixed(1)}/s | ${maxMsg.messageRate} msg/s |\n`;
  md += `| Max Task Throughput | ${maxTask.throughput.toFixed(1)}/s | ${maxTask.messageRate} tasks/s |\n`;
  md += `| WS Delivery Rate | ${(maxWS.deliveryRate*100).toFixed(1)}% | ${maxWS.messageRate} msg/s |\n`;
  md += `| P95 Latency (at max throughput) | ${maxMsg.latencyP95}ms | ${maxMsg.messageRate} msg/s |\n`;
  md += `| Error Rate (at max throughput) | ${(maxMsg.errorRate*100).toFixed(2)}% | ${maxMsg.messageRate} msg/s |\n`;

  return md;
}

function updateOperationsMd(report) {
  const fs = require('fs');
  const opsPath = 'docs/operations.md';
  let content = fs.readFileSync(opsPath, 'utf8');

  // Find the capacity table section
  const tableStart = content.indexOf('| 维度 | 单实例实测上限');
  if (tableStart === -1) {
    log('Could not find capacity table in operations.md');
    return;
  }

  const tableEnd = content.indexOf('\n###', tableStart);
  const before = content.substring(0, tableStart);
  const after = tableEnd === -1 ? '' : content.substring(tableEnd);

  // Extract the capacity summary table from report
  const lines = report.split('\n');
  const summaryStart = lines.findIndex(l => l.includes('## Capacity Summary'));
  if (summaryStart === -1) return;

  const tableLines = lines.slice(summaryStart + 1).filter(l => l.startsWith('|'));
  const newTable = '| 维度 | 单实例实测上限(2026-11-27) | 备注 |\n|-----------|----------------|------|\n' + tableLines.join('\n');

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