import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CURRENT_SCHEMA_VERSION, getSchemaVersion, openDatabase, openStore } from '@agentmesh/store';
import { describe, expect, it } from 'vitest';

import { runBackup } from '../src/cli/backup.js';
import { runMigrate } from '../src/cli/migrate.js';

describe('maintenance CLIs', () => {
  it('migrates a database idempotently and reports v10', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-migrate-'));
    const dbPath = join(dir, 'agentmesh.db');
    try {
      const firstOut: string[] = [];
      expect(
        runMigrate(['--db', dbPath], {
          stdout: (line) => firstOut.push(line),
          stderr: () => undefined,
        }),
      ).toBe(0);
      const first = JSON.parse(firstOut.join('\n')) as {
        applied: number[];
        version: number;
        targetVersion: number;
      };
      expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(first.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(first.targetVersion).toBe(CURRENT_SCHEMA_VERSION);

      const secondOut: string[] = [];
      expect(
        runMigrate(['--db', dbPath], {
          stdout: (line) => secondOut.push(line),
          stderr: () => undefined,
        }),
      ).toBe(0);
      const second = JSON.parse(secondOut.join('\n')) as {
        applied: number[];
        version: number;
      };
      expect(second.applied).toEqual([]);
      expect(second.version).toBe(CURRENT_SCHEMA_VERSION);
      const check = openDatabase(dbPath);
      try {
        expect(getSchemaVersion(check)).toBe(CURRENT_SCHEMA_VERSION);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backs up a live database including committed rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmesh-backup-'));
    const dbPath = join(dir, 'agentmesh.db');
    const outPath = join(dir, 'agentmesh-backup.db');
    try {
      const { db, repos } = openStore(dbPath);
      repos.events.append({
        aggregateId: 'task:tsk_backup',
        type: 'task.published',
        version: 1,
        payload: { taskId: 'tsk_backup' },
        ts: 1,
      });
      db.close();

      const out: string[] = [];
      expect(
        await runBackup(['--db', dbPath, '--out', outPath], {
          stdout: (line) => out.push(line),
          stderr: () => undefined,
        }),
      ).toBe(0);
      expect(JSON.parse(out.join('\n'))).toMatchObject({ ok: true });

      const copy = openDatabase(outPath, { readonly: true, fileMustExist: true });
      try {
        const row = copy
          .prepare('SELECT COUNT(*) AS count FROM events')
          .get() as { count: number };
        expect(row.count).toBe(1);
        const version = getSchemaVersion(copy);
        expect(version).toBe(CURRENT_SCHEMA_VERSION);
      } finally {
        copy.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
