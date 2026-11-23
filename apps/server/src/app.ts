/**
 * Fastify application bootstrap.
 *
 * {@link buildServer} wires config, logging, the handler registry and the
 * JSON-RPC dispatcher into a Fastify instance and exposes:
 *
 * - `GET /health` — liveness + build/protocol version
 * - `POST /rpc`   — JSON-RPC over HTTP (used by admin tooling and tests)
 *
 * Passing a `store` also registers the account module (US-005) and decorates
 * `app.store` / `app.tokens` / `app.accounts`. `startServer` opens the SQLite
 * store from `config.dbPath` and passes it in, so the production path always
 * has authentication wired; tests that only exercise transport stay store-free.
 *
 * The WebSocket transport (US-006) plugs into the same decorated `dispatcher`
 * instance, so HTTP and WS share one routing/error/logging path. It needs the
 * event log (for resume cursors), so it is created whenever a store is wired:
 * `new WebSocketServer({ server: app.server, path: config.wsPath })`.
 */

import { EventStore } from '@agentmesh/core';
import { PROTOCOL_VERSION } from '@agentmesh/protocol';
import { type AgentMeshDatabase, type Repositories } from '@agentmesh/store';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import { createTokenService, extractBearerToken, type TokenService } from './auth/token.js';
import { loadConfig, DEFAULT_MAX_PAYLOAD_BYTES, type ServerConfig } from './config.js';
import {
  RpcDispatcher,
  type RpcDispatcherOptions,
  type SystemErrorNotifier,
} from './dispatcher.js';
import { createLogger, serializeError } from './logging.js';
import {
  registerAccountsModule,
  type AccountsModuleOptions,
  type AccountsService,
} from './modules/accounts.js';
import {
  registerChannelsModule,
  type ChannelsModuleOptions,
  type ChannelsService,
} from './modules/channels.js';
import {
  registerTasksModule,
  type TasksModuleOptions,
  type TasksService,
} from './modules/tasks.js';
import { registerSystemModule } from './modules/system.js';
import { HashChainMonitor } from './modules/hash-chain.js';
import { registerRevocationModule } from './modules/revocation.js';
import { TokenRevocationRegistry } from './auth/revocation.js';
import { createHandlerRegistry, type HandlerRegistry } from './registry.js';
import { WsGateway, type WsGatewayOptions } from './ws/gateway.js';

/** An opened store: the raw handle plus every DAO. */
export interface ServerStore {
  readonly db: AgentMeshDatabase;
  readonly repos: Repositories;
}

export interface BuildServerOptions {
  /** Defaults to `loadConfig()` (validated `process.env`). */
  readonly config?: ServerConfig;
  /** Defaults to a JSON pino logger at `config.logLevel`. */
  readonly logger?: Logger;
  /** Defaults to a fresh empty registry. */
  readonly registry?: HandlerRegistry;
  /** Defaults to a dispatcher over `registry` + `logger`. */
  readonly dispatcher?: RpcDispatcher;
  /** Hook for `system.error` notifications (WS hub in US-006). */
  readonly onSystemError?: SystemErrorNotifier;
  /** Uptime source, injectable for tests. Returns seconds. */
  readonly uptime?: () => number;
  /** Register `POST /rpc`; disable in tests that only need `/health`. */
  readonly exposeHttpRpc?: boolean;
  /**
   * Open store to wire feature modules against. When present the account
   * module is registered (unless `registerAccounts: false`) and the handle is
   * decorated as `app.store`. `:memory:` keeps tests isolated.
   */
  readonly store?: ServerStore;
  /** Token service override (defaults to one built from the config). */
  readonly tokens?: TokenService;
  /** Account-module overrides (id factory / clock / admin self-register). */
  readonly accounts?: Omit<AccountsModuleOptions, 'db' | 'accounts' | 'events' | 'tokens'>;
  /** Skip account registration even with a store (e.g. focused route tests). */
  readonly registerAccounts?: boolean;
  /**
   * Register the channel/message module (US-007). Default: on whenever a store
   * is wired. Turn it off when the caller installs its own `channel.*` /
   * `message.send` stubs (the registry rejects duplicate handlers).
   */
  readonly registerChannels?: boolean;
  /** Channel-module overrides (id factory / clock) — mostly for tests. */
  readonly channels?: Omit<
    ChannelsModuleOptions,
    'db' | 'channels' | 'members' | 'messages' | 'events' | 'fanout' | 'workspaceId'
  >;
  /**
   * Register the task module (US-008). Default: on whenever a store is wired.
   * Turn it off when the caller installs its own `task.*` stubs.
   */
  readonly registerTasks?: boolean;
  /**
   * Register `agent.revokeToken` (US-021D). Default: on whenever a store is
   * wired. Turn off when the caller installs its own revocation stub.
   */
  readonly registerRevocation?: boolean;
  /** Task-module overrides (TTL / id factory / clock) — mostly for tests. */
  readonly tasks?: Omit<
    TasksModuleOptions,
    | 'db'
    | 'tasks'
    | 'taskBids'
    | 'accounts'
    | 'events'
    | 'workspaceId'
  >;
  /** Reclaim sweep interval in ms (defaults to the config value). */
  readonly taskReclaimIntervalMs?: number;
  /** Serve the WebSocket gateway (default: on whenever a store is wired). */
  readonly websocket?: boolean;
  /** Gateway overrides (epoch, limits, heartbeat) — mostly for tests. */
  readonly ws?: Omit<
    WsGatewayOptions,
    'server' | 'dispatcher' | 'tokens' | 'events' | 'logger'
  >;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: ServerConfig;
    registry: HandlerRegistry;
    dispatcher: RpcDispatcher;
    /** Epoch ms when the instance was built (health uptime base). */
    startedAt: number;
    /** Present only when `buildServer` received a store. */
    store?: ServerStore;
    /** JWT issuer/verifier (always present; WS auth in US-006 uses it). */
    tokens: TokenService;
    /** In-memory token revocation registry (US-021D). */
    revocations: TokenRevocationRegistry;
    /** Account service, present when the account module is registered. */
    accounts?: AccountsService;
    /** Channel/message service, present when the US-007 module is registered. */
    channels?: ChannelsService;
    /** Task lifecycle service, present when the US-008 module is registered. */
    tasks?: TasksService;
    /** Event hash-chain monitor, present when a store is wired (US-021C). */
    hashChain?: HashChainMonitor;
    /** WebSocket gateway, present when a store is wired. */
    ws?: WsGateway;
  }
}

const defaultUptime = (): number => process.uptime();

/**
 * Build (but do not listen on) the Fastify server.
 *
 * ```ts
 * const app = buildServer({ config: loadConfig() });
 * await app.listen({ port: app.config.port, host: app.config.host });
 * ```
 */
export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const registry = options.registry ?? createHandlerRegistry();

  // In-memory token revocation registry (US-021D); shared by the token service
  // (enforcement inside verify) and the `agent.revokeToken` handler.
  const revocations = new TokenRevocationRegistry();

  const tokens =
    options.tokens ??
    createTokenService({
      secret: config.jwtSecret,
      expiresInSeconds: config.jwtExpiresInSeconds,
      issuer: config.jwtIssuer,
      revocations,
    });

  // `system.error` notifications fan out to the caller's hook (if any) and to
  // the WS gateway, which is created after the dispatcher (it needs the store).
  const systemErrorSinks: SystemErrorNotifier[] = [];
  const dispatcherOptions: RpcDispatcherOptions = {
    registry,
    logger,
    workspaceId: 'default',
    tokenVerifier: (token) => tokens.verify(token),
    onSystemError: async (payload) => {
      await options.onSystemError?.(payload);
      for (const sink of systemErrorSinks) await sink(payload);
    },
  };
  const dispatcher =
    options.dispatcher ?? new RpcDispatcher(dispatcherOptions);

  const app = Fastify({
    // Cap request bodies so a single RPC cannot exhaust memory.
    bodyLimit: DEFAULT_MAX_PAYLOAD_BYTES,
    // Fastify defaults to `FastifyBaseLogger`; the pino Logger satisfies it
    // but would otherwise narrow the instance generic (incompatible with the
    // declared `FastifyInstance` return type).
    loggerInstance: logger as FastifyBaseLogger,
    // The dispatcher emits one structured line per message; Fastify's own
    // request/response lines would duplicate them without a `reqId`.
    logController: new LogController({ disableRequestLogging: true }),
  });

  const startedAt = Date.now();
  app.decorate('config', config);
  app.decorate('registry', registry);
  app.decorate('dispatcher', dispatcher);
  app.decorate('startedAt', startedAt);
  app.decorate('tokens', tokens);
  app.decorate('revocations', revocations);

  // ---- feature modules ---------------------------------------------------
  const store = options.store;
  if (store !== undefined) {
    app.decorate('store', store);
    // `agent.revokeToken` (US-021D): registers with a store-wired server (the
    // same invariant as the other feature modules); admin-gated in the handler.
    // Revocation is enforced inside `tokens.verify`.
    if (options.registerRevocation !== false) {
      registerRevocationModule(registry, { tokens, revocations, logger });
    }
    if (options.registerAccounts !== false) {
      // Reuse the decorated DAO so account writes travel through the same
      // `onAppend` feed the WS gateway subscribes to (single bus per process).
      const events = new EventStore(store.db, { workspaceId: 'default' }, store.repos.events);
      app.decorate(
        'accounts',
        registerAccountsModule(registry, {
          db: store.db,
          accounts: store.repos.accounts,
          events,
          tokens,
          workspaceId: 'default',
          allowAdminSelfRegister: config.allowAdminSelfRegister,
          authRateLimit: {
            maxFailedAttempts: config.authMaxFailedAttempts,
            failWindowSeconds: config.authFailWindowSeconds,
            lockoutSeconds: config.authLockoutSeconds,
          },
          ...options.accounts,
        }),
      );
    }
  }

  // ---- WebSocket gateway (US-006) ----------------------------------------
  if (store !== undefined && options.websocket !== false) {
    const gateway = new WsGateway({
      server: app.server,
      path: config.wsPath,
      dispatcher,
      tokens,
      events: store.repos.events,
      logger,
      workspaceId: 'default',
      heartbeatIntervalMs: config.wsHeartbeatIntervalMs,
      resumeMaxEvents: config.resumeMaxEvents,
      allowedOrigins: config.allowedOrigins,
      allowMissingOrigin: config.allowMissingOrigin,
      allowLocalhostOrigins: !config.isProduction,
      maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
      connectionLimit: {
        ratePerSecond: config.wsConnectionRateLimit,
        burst: config.wsConnectionBurst,
      },
      agentLimit: {
        ratePerSecond: config.wsAgentRateLimit,
        burst: config.wsAgentBurst,
      },
      ...options.ws,
    });
    app.decorate('ws', gateway);
    systemErrorSinks.push(gateway.systemErrorNotifier);
    // `preClose` (not `onClose`) is the documented Fastify hook for transports
    // that hold the raw HTTP server open: upgraded sockets are not tracked as
    // idle connections, so `server.close()` would never resolve unless they are
    // terminated *before* it starts waiting.
    app.addHook('preClose', async () => {
      await gateway.close();
    });
    // ---- system module (US-020) -------------------------------------------
    if (store !== undefined) {
      app.decorate(
        'system',
        registerSystemModule(registry, {
          gateway,
          workspaceId: 'default',
        }),
      );
    }
  }

  // ---- channel + message module (US-007) --------------------------------
  if (store !== undefined && options.registerChannels !== false) {
    // Registered after the gateway so the message fan-out can resolve channel
    // members against the live connections. Messages are private to a channel,
    // so they must not use the workspace-wide `publishEvent` feed.
    const gateway = app.ws;
    const events = new EventStore(store.db, { workspaceId: 'default' }, store.repos.events);
    app.decorate(
      'channels',
      registerChannelsModule(registry, {
        db: store.db,
        channels: store.repos.channels,
        members: store.repos.channelMembers,
        messages: store.repos.messages,
        events,
        workspaceId: 'default',
        fanout:
          gateway === undefined
            ? () => 0
            : (event, agentIds) => gateway.publishEventToAgents(event, agentIds),
        ...options.channels,
      }),
    );
  }

  // ---- task module (US-008) ---------------------------------------------
  if (store !== undefined && options.registerTasks !== false) {
    const events = new EventStore(store.db, { workspaceId: 'default' }, store.repos.events);
    const tasks = registerTasksModule(registry, {
      ...options.tasks,
      db: store.db,
      tasks: store.repos.tasks,
      taskBids: store.repos.taskBids,
      accounts: store.repos.accounts,
      events,
      workspaceId: 'default',
      demoMode: config.demoMode,
      openTtlSeconds: options.tasks?.openTtlSeconds ?? config.taskOpenTtlSeconds,
      compactionIntervalMs: options.tasks?.compactionIntervalMs ?? config.taskBidCompactionIntervalSeconds * 1000,
      // Give the module the real logger so compaction start/clear/errors are
      // observable (verify:docker asserts the timer lifecycle from these lines).
      logger: options.tasks?.logger ?? logger,
    });
    app.decorate('tasks', tasks);

    // Stale `open` tasks are cancelled by a timer, but the sweep itself is a
    // pure `reclaimExpired(now)` call — tests drive it directly with an
    // injected `now` and never wait on the interval.
    const reclaimIntervalMs =
      options.taskReclaimIntervalMs ?? config.taskReclaimIntervalSeconds * 1000;
    const reclaimTimer = setInterval(() => {
      try {
        const { reclaimed } = tasks.reclaimExpired();
        if (reclaimed.length > 0) {
          app.log.info({ count: reclaimed.length, msg: 'task.reclaimed' });
        }
        const { closed } = tasks.closeExpiredBidding();
        if (closed.length > 0) {
          app.log.info({ count: closed.length, msg: 'task.bidding.closed' });
        }
      } catch (err) {
        app.log.error({ err: serializeError(err), msg: 'task.reclaim.failed' });
      }
    }, reclaimIntervalMs);
    // Never hold the event loop open just for the sweeper.
    reclaimTimer.unref();
    app.addHook('onClose', async () => {
      clearInterval(reclaimTimer);
    });

    // Bid set compaction timer (US-021B)
    const compactionIntervalMs =
      options.tasks?.compactionIntervalMs ?? config.taskBidCompactionIntervalSeconds * 1000;
    if (compactionIntervalMs > 0) {
      tasks.startCompactionTimer(compactionIntervalMs);
      app.addHook('onClose', async () => {
        tasks.stopCompactionTimer();
      });
    }
  }

  // Event hash-chain verification (US-021C): once on startup + optional timer.
  // Never blocks startup on failure; /health exposes ok | mismatch | unchecked.
  if (store !== undefined) {
    const hashChainEvents = new EventStore(
      store.db,
      { workspaceId: 'default' },
      store.repos.events,
    );
    const hashChain = new HashChainMonitor(hashChainEvents, logger);
    if (config.hashChainVerifyOnStartup) {
      hashChain.runCheck();
    }
    if (config.hashChainVerifyIntervalSeconds > 0) {
      hashChain.startTimer(config.hashChainVerifyIntervalSeconds * 1000);
      app.addHook('onClose', async () => {
        hashChain.stopTimer();
      });
    }
    app.decorate('hashChain', hashChain);
  }

  const uptime = options.uptime ?? defaultUptime;

  app.get('/health', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      version: config.version,
      protocolVersion: PROTOCOL_VERSION,
      uptime: Math.round(uptime() * 1000) / 1000,
      nodeEnv: config.nodeEnv,
      timestamp: new Date().toISOString(),
      // US-021C: coarse integrity state; never payloads or secrets.
      hashChain: app.hashChain?.state.status ?? 'unchecked',
    };
  });

  if (options.exposeHttpRpc !== false) {
    app.post('/rpc', async (request, reply) => {
      const headerAgentId = request.headers['x-agent-id'];
      const agentId =
        typeof headerAgentId === 'string' && headerAgentId.length > 0
          ? headerAgentId
          : undefined;
      const headerWorkspaceId = request.headers['x-workspace-id'];
      const workspaceId =
        typeof headerWorkspaceId === 'string' && headerWorkspaceId.length > 0
          ? headerWorkspaceId
          : undefined;
      // `Authorization: Bearer <jwt>`; the dispatcher verifies it once and
      // hands the identity to the handler via `ctx.auth`.
      const token = extractBearerToken(request.headers.authorization);

      const outcome = await dispatcher.dispatch(request.body, {
        ...(agentId === undefined ? {} : { agentId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(token === undefined ? {} : { token }),
        remoteAddress: request.ip,
      });

      if (outcome.response === undefined) {
        // Notification (fire-and-forget): JSON-RPC over HTTP replies 204.
        return reply.code(204).send();
      }
      return reply.code(200).send(outcome.response);
    });
  }

  app.log.info({
    msg: 'server.built',
    version: config.version,
    protocolVersion: PROTOCOL_VERSION,
    nodeEnv: config.nodeEnv,
    host: config.host,
    port: config.port,
    dbPath: config.dbPath,
    methods: registry.listMethods(),
  });

  return app;
}
