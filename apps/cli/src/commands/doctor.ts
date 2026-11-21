/**
 * `agentmesh doctor` — configuration / token / connectivity smoke test.
 *
 * It never mutates anything: the only RPC is a read-only `channel.list`.
 */

import type { CommandContext, ClientFactory } from '../context.js';
import { decodeTokenClaims, isTokenExpired, maskToken } from '../token.js';

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectDoctorChecks(
  ctx: CommandContext,
  createClient: ClientFactory,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const url = ctx.config.url;
  const token = ctx.config.token;

  checks.push({
    name: 'config',
    ok: url !== undefined,
    detail: url ?? 'no URL (pass --url or set AGENTMESH_URL)',
  });

  let tokenOk = token !== undefined;
  let tokenDetail: string = token === undefined ? 'no token (run `agentmesh login`)' : maskToken(token);
  if (token !== undefined) {
    const claims = decodeTokenClaims(token);
    if (claims === undefined) {
      tokenOk = false;
      tokenDetail = 'token is not a readable JWT';
    } else if (isTokenExpired(claims)) {
      tokenOk = false;
      tokenDetail = `expired at ${new Date((claims.exp ?? 0) * 1000).toISOString()}`;
    } else {
      tokenDetail =
        `agent ${claims.sub ?? '-'}` +
        (claims.exp === undefined
          ? ''
          : `, expires ${new Date(claims.exp * 1000).toISOString()}`);
    }
  }
  checks.push({ name: 'token', ok: tokenOk, detail: tokenDetail });

  if (!url || !token || !tokenOk) {
    checks.push({ name: 'connection', ok: false, detail: 'skipped (config/token failed)' });
    checks.push({ name: 'read rpc', ok: false, detail: 'skipped (config/token failed)' });
    return checks;
  }

  const client = createClient(ctx.config, { autoReconnect: false });
  try {
    await client.connect();
    checks.push({
      name: 'connection',
      ok: true,
      detail: `welcome accepted (epoch ${client.epoch ?? '-'})`,
    });
    await client.listChannels({ limit: 1 });
    checks.push({ name: 'read rpc', ok: true, detail: 'channel.list succeeded' });
  } catch (error) {
    checks.push({ name: 'connection', ok: false, detail: errorMessage(error) });
    checks.push({ name: 'read rpc', ok: false, detail: 'skipped (connection failed)' });
  } finally {
    client.close();
  }
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`)
    .join('\n');
}
