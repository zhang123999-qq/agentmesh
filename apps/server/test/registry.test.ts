import { describe, expect, it, vi } from 'vitest';

import {
  DuplicateHandlerError,
  createHandlerRegistry,
} from '../src/registry.js';
import { silentLogger } from './helpers.js';

describe('HandlerRegistry', () => {
  it('registers and resolves handlers by method', async () => {
    const registry = createHandlerRegistry();
    const handler = vi.fn(async () => ({ ok: true }));

    registry.registerHandler('task.list', handler, { description: 'list tasks' });

    expect(registry.hasHandler('task.list')).toBe(true);
    expect(registry.getHandler('task.list')).toBe(handler);
    expect(registry.getDescription('task.list')).toBe('list tasks');
    expect(registry.listMethods()).toEqual(['task.list']);

    const ctx = {
      reqId: 'req-1',
      workspaceId: 'default',
      logger: silentLogger(),
    };
    await expect(registry.getHandler('task.list')?.(ctx, {})).resolves.toEqual({
      ok: true,
    });
  });

  it('returns undefined for unknown methods', () => {
    const registry = createHandlerRegistry();
    expect(registry.hasHandler('nope')).toBe(false);
    expect(registry.getHandler('nope')).toBeUndefined();
    expect(registry.listMethods()).toEqual([]);
  });

  it('throws on duplicate registration by default', () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('agent.list', async () => []);
    expect(() => registry.registerHandler('agent.list', async () => [])).toThrow(
      DuplicateHandlerError,
    );
  });

  it('replaces a handler when override is set', async () => {
    const registry = createHandlerRegistry();
    const first = vi.fn(async () => 'first');
    const second = vi.fn(async () => 'second');

    registry.registerHandler('agent.list', first);
    registry.registerHandler('agent.list', second, { override: true });

    expect(registry.getHandler('agent.list')).toBe(second);
    expect(registry.listMethods()).toEqual(['agent.list']);
  });

  it('lists methods sorted', () => {
    const registry = createHandlerRegistry();
    registry.registerHandler('task.list', async () => []);
    registry.registerHandler('agent.list', async () => []);
    registry.registerHandler('channel.list', async () => []);

    expect(registry.listMethods()).toEqual([
      'agent.list',
      'channel.list',
      'task.list',
    ]);
  });

  it('validates method and handler arguments', () => {
    const registry = createHandlerRegistry();
    expect(() => registry.registerHandler('', async () => null)).toThrow(TypeError);
    expect(() =>
      registry.registerHandler('x', undefined as unknown as () => null),
    ).toThrow(TypeError);
  });
});
