import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseBackupArgs, runBackup } from '../src/cli/backup.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-backup-errors-'));
  dirs.push(dir);
  return dir;
}

describe('parseBackupArgs', () => {
  it('accepts --db/--out in both forms and defaults the database path', () => {
    expect(parseBackupArgs(['--db=a.db', '--out=b.db'])).toEqual({
      dbPath: 'a.db',
      outPath: 'b.db',
    });
    expect(parseBackupArgs(['--db', 'a.db', '--out', 'b.db'])).toEqual({
      dbPath: 'a.db',
      outPath: 'b.db',
    });

    const previous = process.env.DB_PATH;
    delete process.env.DB_PATH;
    try {
      expect(parseBackupArgs(['--out', 'b.db']).dbPath).toBe('data/agentmesh.db');
    } finally {
      if (previous !== undefined) process.env.DB_PATH = previous;
    }
  });

  it('rejects unknown flags, missing values and a missing --out', () => {
    expect(() => parseBackupArgs(['--wat'])).toThrowError(/unknown argument/);
    expect(() => parseBackupArgs(['--db'])).toThrowError(/--db requires a path/);
    expect(() => parseBackupArgs(['--out'])).toThrowError(/--out requires a path/);
    expect(() => parseBackupArgs(['--out='])).toThrowError(/--out is required/);
    expect(() => parseBackupArgs([])).toThrowError(/--out is required/);
  });
});

describe('runBackup error paths', () => {
  it('returns 1 and reports parse errors instead of throwing', async () => {
    const lines: string[] = [];
    const code = await runBackup(['--nope'], { stderr: (line) => lines.push(line) });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/unknown argument/);
  });

  it('refuses to overwrite the source database', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'agentmesh.db');
    const lines: string[] = [];
    const code = await runBackup(['--db', dbPath, '--out', dbPath], {
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines[0]).toMatch(/must differ from the source/);
  });

  it('fails cleanly when the source database does not exist', async () => {
    const dir = tempDir();
    const lines: string[] = [];
    const code = await runBackup(
      ['--db', join(dir, 'missing.db'), '--out', join(dir, 'out.db')],
      { stderr: (line) => lines.push(line) },
    );
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
  });

  it('fails cleanly when the source is not a SQLite database', async () => {
    const dir = tempDir();
    const bogus = join(dir, 'bogus.db');
    writeFileSync(bogus, 'not a database', 'utf8');
    const lines: string[] = [];
    const code = await runBackup(['--db', bogus, '--out', join(dir, 'out.db')], {
      stderr: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
  });
});
