#!/usr/bin/env node
/**
 * Per-workspace coverage measurement (advisory; no thresholds yet).
 *
 * Decisions (docs/decisions.md「覆盖率度量」):
 *  - provider: vitest built-in + @vitest/coverage-v8 (pinned with vitest)
 *  - reporters: text-summary + lcov + json-summary, one report per workspace
 *  - no thresholds until a stable baseline exists (CI job stays advisory)
 *  - excluded: build output, tests, configs, generated Next.js output only.
 *    Every `src` file (including entry points) stays in scope: excluding
 *    wiring is exactly how the US-021B blind spot stayed hidden.
 *  - server suites that import the built package run through
 *    `vitest.coverage.config.ts`, which maps `@agentmesh/server` to `src` so
 *    v8 attributes execution to source instead of dist.
 *
 * Usage: npm run coverage
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportsRoot = join(root, 'coverage');

const EXCLUDES = [
  '**/dist/**',
  '**/node_modules/**',
  '**/test/**',
  '**/*.test.ts',
  '**/*.config.*',
  '**/next-env.d.ts',
  '**/.next/**',
  'apps/web/e2e/**',
];

/** Workspace dirs that ship a test suite. */
function workspaceDirs() {
  const dirs = [];
  for (const group of ['packages', 'apps']) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (!existsSync(join(dir, 'package.json'))) continue;
      if (!existsSync(join(dir, 'test'))) continue;
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (typeof pkg.scripts?.test !== 'string') continue;
      dirs.push({ dir, name: name, pkgName: pkg.name });
    }
  }
  return dirs;
}

function runNpm(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args,
      { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
    );
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

function pct(summaryPath, key) {
  try {
    const json = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const value = json.total?.[key]?.pct;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

const workspaces = workspaceDirs();
const results = [];

for (const ws of workspaces) {
  const reportsDirectory = join(reportsRoot, ws.name);
  const args = [
    'run',
    'test',
    '-w',
    ws.pkgName,
    '--',
    ...(ws.name === 'server' ? ['--config', 'vitest.coverage.config.ts'] : []),
    '--coverage',
    '--coverage.provider=v8',
    '--coverage.reporter=text-summary',
    '--coverage.reporter=lcov',
    '--coverage.reporter=json-summary',
    `--coverage.reportsDirectory=${reportsDirectory}`,
    ...EXCLUDES.map((pattern) => `--coverage.exclude=${pattern}`),
  ];
  console.log(`\n=== coverage: ${ws.pkgName} (${ws.name}) ===`);
  const code = await runNpm(args);
  results.push({
    name: ws.name,
    pkgName: ws.pkgName,
    code,
    lines: pct(join(reportsDirectory, 'coverage-summary.json'), 'lines'),
    functions: pct(join(reportsDirectory, 'coverage-summary.json'), 'functions'),
  });
}

console.log('\n=== coverage summary (lines / functions) ===');
for (const r of results) {
  const status = r.code === 0 ? 'ok' : `FAILED(${r.code})`;
  console.log(
    `${r.name.padEnd(14)} lines=${String(r.lines ?? 'n/a').padStart(6)}%` +
      `  functions=${String(r.functions ?? 'n/a').padStart(6)}%  ${status}`,
  );
}

const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  console.error(
    `\ncoverage: ${failed.length} workspace(s) failed: ${failed.map((f) => f.name).join(', ')}`,
  );
  process.exit(1);
}
