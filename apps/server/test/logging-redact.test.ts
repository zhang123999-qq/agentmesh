import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/logging.js';
import { makeCapturingLogger } from './helpers.js';

describe('log redaction', () => {
  it('never emits plaintext secrets, tokens or authorization headers', () => {
    const { logger, lines } = makeCapturingLogger('info');

    logger.info(
      {
        secret: 'plaintext-secret-value',
        token: 'bearer-token-value',
        password: 'user-password-value',
        secretHash: 'a'.repeat(64),
        nested: { secret: 'nested-secret-value' },
        req: { headers: { authorization: 'Bearer header-secret-value' } },
      },
      'security.redaction.test',
    );

    const output = JSON.stringify(lines[0]);
    for (const value of [
      'plaintext-secret-value',
      'bearer-token-value',
      'user-password-value',
      'nested-secret-value',
      'header-secret-value',
      'a'.repeat(64),
    ]) {
      expect(output).not.toContain(value);
    }
    expect(output).toContain('[Redacted]');
  });

  it('keeps non-sensitive correlation fields intact', () => {
    const { logger, lines } = makeCapturingLogger('info');
    logger.info({ reqId: 'req-1', agentId: 'agt_1', method: 'task.list' }, 'ok');
    expect(lines[0]).toMatchObject({
      reqId: 'req-1',
      agentId: 'agt_1',
      method: 'task.list',
      msg: 'ok',
    });
    expect(createLogger({ level: 'silent' })).toBeDefined();
  });
});
