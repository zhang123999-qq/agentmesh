import { Writable } from 'node:stream';

import type { Logger } from 'pino';

import { createLogger } from '../src/logging.js';
import { loadConfig, type LogLevel, type ServerConfig } from '../src/config.js';

export interface CapturedLogLine {
  level: string;
  ts: string;
  msg?: string;
  [key: string]: unknown;
}

/** Logger that records every JSON line for assertions. */
export function makeCapturingLogger(level: LogLevel = 'info'): {
  logger: Logger;
  lines: CapturedLogLine[];
} {
  const lines: CapturedLogLine[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk);
      for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        lines.push(JSON.parse(trimmed) as CapturedLogLine);
      }
      callback();
    },
  });

  return { logger: createLogger({ level, destination }), lines };
}

export function silentLogger(): Logger {
  return createLogger({ level: 'silent' });
}

/** Validated config for tests (never reads the real process env). */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JWT_SECRET: 'test-secret-value-1234567890',
    DB_PATH: ':memory:',
  });
  return Object.freeze({ ...base, ...overrides });
}
