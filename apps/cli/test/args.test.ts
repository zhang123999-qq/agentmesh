import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('accepts a flag value that starts with "-" (base64url secrets may)', () => {
    // Regression: a generated account secret is base64url and can start with
    // "-", which previously triggered a spurious UsageError (exit 2).
    const parsed = parseArgs([
      'login',
      '--agent-id',
      'agt_1',
      '--secret',
      '-abc_DEF-123',
    ]);
    expect(parsed.flags.secret).toBe('-abc_DEF-123');
    expect(parsed.flags['agent-id']).toBe('agt_1');
    expect(parsed.positionals).toEqual(['login']);
  });

  it('supports the --flag=value form for flag-like values', () => {
    const parsed = parseArgs(['login', '--secret=--looks-like-a-flag']);
    expect(parsed.flags.secret).toBe('--looks-like-a-flag');
  });

  it('still errors when a value-taking flag is the last token', () => {
    expect(() => parseArgs(['login', '--secret'])).toThrowError(/requires a value/);
  });
});
