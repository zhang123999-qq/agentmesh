import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfig, saveConfig } from '../src/config.js';

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agentmesh-cli-home-'));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('CLI config', () => {
  it('applies flags > env > profile > default precedence', () => {
    const home = tempHome();
    const defaultPath = join(home, 'config.json');
    const profilePath = join(home, 'profiles', 'staging.json');
    saveConfig(defaultPath, { url: 'ws://default', token: 'token-default' });
    saveConfig(profilePath, { url: 'ws://profile', agentId: 'agt_profile' });

    const fromEnv = resolveConfig({
      homeDir: home,
      env: { AGENTMESH_PROFILE: 'staging', AGENTMESH_URL: 'ws://env' },
    });
    expect(fromEnv.url).toBe('ws://env');
    expect(fromEnv.agentId).toBe('agt_profile');
    // profile did not define a token, the default file still applies.
    expect(fromEnv.token).toBe('token-default');
    expect(fromEnv.profile).toBe('staging');
    expect(fromEnv.path).toBe(profilePath);

    const fromFlags = resolveConfig({
      homeDir: home,
      env: { AGENTMESH_PROFILE: 'staging', AGENTMESH_URL: 'ws://env' },
      flags: { url: 'ws://flag', token: 'token-flag' },
    });
    expect(fromFlags.url).toBe('ws://flag');
    expect(fromFlags.token).toBe('token-flag');
  });

  it('honours an explicit --config path', () => {
    const home = tempHome();
    const explicit = join(home, 'custom.json');
    saveConfig(explicit, { url: 'ws://explicit' });
    const config = resolveConfig({ homeDir: home, env: {}, flags: { config: explicit } });
    expect(config.url).toBe('ws://explicit');
    expect(config.path).toBe(explicit);
  });

  it('never writes the account secret and can remove the token', () => {
    const home = tempHome();
    const path = join(home, 'config.json');
    saveConfig(path, { url: 'ws://x', agentId: 'agt_1', token: 'jwt-token' });
    expect(readFileSync(path, 'utf8')).not.toContain('secret');

    saveConfig(path, { token: null });
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('jwt-token');
    expect(raw).toContain('ws://x');
    expect(raw).toContain('agt_1');

    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects a malformed config file', () => {
    const home = tempHome();
    const path = join(home, 'config.json');
    saveConfig(path, { url: 'ws://x' });
    // Corrupt it on purpose.
    writeFileSync(path, '{not json');
    expect(() => resolveConfig({ homeDir: home, env: {} })).toThrow(/not valid JSON/);
  });
});
