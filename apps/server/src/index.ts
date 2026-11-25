/**
 * `@agentmesh/server` entrypoint and public surface.
 *
 * Run the built server with:
 *
 * ```bash
 * PORT=8787 DB_PATH=data/agentmesh.db JWT_SECRET=... node dist/index.js
 * ```
 *
 * Feature modules get the registry via `startServer({ register })` or by
 * calling `app.registry.registerHandler(...)` before `listen`.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROTOCOL_VERSION } from '@agentmesh/protocol';
import { openStore } from '@agentmesh/store';
import type { FastifyInstance } from 'fastify';

import { buildServer, type BuildServerOptions, type ServerStore } from './app.js';
import { describeConfig, describeSecurityWarnings, loadConfig, type ServerConfig } from './config.js';
import { serializeError } from './logging.js';
import type { HandlerRegistry } from './registry.js';

export * from './config.js';
export * from './logging.js';
export * from './registry.js';
export * from './dispatcher.js';
export * from './auth/roles.js';
export * from './auth/token.js';
export * from './auth/revocation.js';
export * from './auth/rate-limit.js';
export * from './modules/accounts.js';
export * from './modules/channels.js';
export * from './modules/tasks.js';
export * from './modules/system.js';
export * from './modules/hash-chain.js';
export * from './modules/revocation.js';
export * from './modules/workspace.js';
export * from './ws/framing.js';
export * from './ws/session.js';
export * from './ws/gateway.js';
export * from './app.js';

export interface StartServerOptions extends BuildServerOptions {
  /** Called after build, before listen — feature modules register here. */
  readonly register?: (registry: HandlerRegistry, app: FastifyInstance) => void;
}

/**
 * Build, decorate and listen. Returns the running Fastify instance so tests
 * or embedded deployments can close it themselves.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<FastifyInstance> {
  const config: ServerConfig = options.config ?? loadConfig();
  // Production path owns the SQLite handle: open + migrate before buildServer
  // so the account module (and future modules) are registered at construction.
  const store: ServerStore = options.store ?? openStore(config.dbPath);
  const ownsStore = options.store === undefined;
  const app = buildServer({ ...options, config, store });

  if (ownsStore) {
    app.addHook('onClose', async () => {
      store.db.close();
    });
  }

  options.register?.(app.registry, app);

  // The reclaim timer alone leaves already-expired `open` tasks visible until
  // its first tick (default 60s). Sweep once before accepting traffic so a
  // restart cannot serve an expired task as bid-able.
  if (app.tasks !== undefined) {
    try {
      const { reclaimed } = app.tasks.reclaimExpired();
      if (reclaimed.length > 0) {
        app.log.info({ count: reclaimed.length, msg: 'task.reclaim.startup' });
      }
      const { closed } = app.tasks.closeExpiredBidding();
      if (closed.length > 0) {
        app.log.info({ count: closed.length, msg: 'task.bidding.closed.startup' });
      }
    } catch (err) {
      app.log.error({ err: serializeError(err), msg: 'task.reclaim.startup.failed' });
    }
  }

  for (const warning of describeSecurityWarnings(config)) {
    app.log.warn({ msg: 'security.warning', warning });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.fatal({
      ...describeConfig(config),
      err: serializeError(err),
      msg: 'server.start.failed',
    });
    throw err;
  }

  const address = app.server.address();
  app.log.info({
    ...describeConfig(config),
    protocolVersion: PROTOCOL_VERSION,
    address: typeof address === 'string' ? address : address?.port,
    msg: 'server.started',
  });

  return app;
}

function installShutdownHooks(app: FastifyInstance): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal, msg: 'server.stopping' });
    void app
      .close()
      .then(() => {
        app.log.info({ signal, msg: 'server.stopped' });
      })
      .catch((err: unknown) => {
        app.log.error({ signal, err: serializeError(err), msg: 'server.stop.failed' });
        process.exitCode = 1;
      });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  startServer()
    .then((app) => installShutdownHooks(app))
    .catch((err: unknown) => {
      // startServer already logged the fatal line; keep the process exit code.
      console.error(err);
      process.exitCode = 1;
    });
}
