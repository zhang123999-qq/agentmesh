# @agentmesh/server

Fastify bootstrap for AgentMesh: environment config, JSON-RPC dispatcher,
plugin registry and pino structured logging.

> Project docs: [../../docs/README.md](../../docs/README.md)
> (architecture / security / operations / status).

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | `0` picks an ephemeral port (tests). |
| `HOST` | `0.0.0.0` | Bind interface. |
| `DB_PATH` | `data/agentmesh.db` | SQLite path (`:memory:` allowed). |
| `JWT_SECRET` | dev placeholder | **Required** when `NODE_ENV=production`; min 16 chars. |
| `JWT_EXPIRES_IN_SECONDS` | `3600` | Access-token lifetime, 1…2592000 seconds. |
| `JWT_ISSUER` | `agentmesh` | Written as `iss` and required on every token. |
| `ALLOW_ADMIN_SELF_REGISTER` | `false` | Allow `agent.register` with `role: "admin"`. |
| `DEMO_MODE` | `false` | Force `AlwaysExploreForDemo` for deterministic US-017 demo runs (US-009). |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Failed `agent.authenticate` attempts per identity per window before a lockout (1…100). |
| `AUTH_FAIL_WINDOW_SECONDS` | `60` | Length of the failure-counting window (1…86400). |
| `AUTH_LOCKOUT_SECONDS` | `60` | Base lockout after too many failures; doubles on each repeat (1…86400). |
| `WS_PATH` | `/ws` | WebSocket upgrade path (must start with `/`). |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated exact origins allowed to open a browser WebSocket (CSWSH defence); wildcards rejected. **Required when `NODE_ENV=production`** (startup fails if empty). Development defaults to localhost/127.0.0.1/[::1]. |
| `ALLOW_MISSING_ORIGIN` | `true` | Allow upgrades with no `Origin` header (SDK/CLI/demo). Default true in both environments; set `false` only if every client is a browser. |
| `WS_HEARTBEAT_INTERVAL_MS` | `30000` | Native WS ping interval; a socket that misses one round is terminated. |
| `RESUME_MAX_EVENTS` | `1000` | Hard replay window for one `resume`; larger gaps get `gap_too_large`. |
| `WS_CONNECTION_RATE_LIMIT` | `100` | Per-connection JSON-RPC requests/second (soft `-32005`). |
| `WS_CONNECTION_BURST` | `100` | Per-connection token bucket capacity. |
| `WS_AGENT_RATE_LIMIT` | `10` | Per-agent `message.send` messages/second (shared by all sockets). |
| `WS_AGENT_BURST` | `10` | Per-agent token bucket capacity. |
| `TASK_OPEN_TTL_SECONDS` | `0` | Cancel `open` tasks older than this even without a `deadline` (`0` disables; `deadline`s are always honoured). |
| `TASK_RECLAIM_INTERVAL_SECONDS` | `60` | Sweep interval of the open-task reclaim timer (cleared on close). |
| `LOG_LEVEL` | `info` | pino level (`fatal`…`trace`, `silent`). |
| `SERVER_VERSION` | `0.1.0` | Reported by `GET /health`. |

Invalid values fail fast at startup with `ConfigError` (field name included).
`describeConfig` is safe to log (never includes the JWT secret).

## Endpoints

- `GET /health` → `200 { status: "ok", version, protocolVersion, uptime, nodeEnv, timestamp }`
- `POST /rpc` → JSON-RPC over HTTP; `x-agent-id` / `x-workspace-id` headers are
  forwarded into the handler context (a verified token always wins, see
  credential semantics §3). Notifications get `204 No Content`.
  `Authorization: Bearer <jwt>` is verified once by the dispatcher and exposed
  to handlers as `ctx.auth` / `ctx.role`; a malformed/expired token fails the
  message with `-32001` instead of falling back to anonymous.

## Channels and messages (US-007 / US-010)

| Method | Roles | Notes |
| --- | --- | --- |
| `channel.create` | `admin`, `agent` | Creator becomes the first member. |
| `channel.join` / `channel.leave` | `admin`, `agent` | Idempotent; managing another agent requires `admin`. |
| `channel.list` | `admin`, `agent`, `observer` | Workspace channels with member lists. |
| `message.send` | `admin`, `agent` | Member-only; persists the row and pushes `message.new` to online members. |
| `message.history` | `admin`, `agent`, `observer` | **Member-only**. Params: `channelId`, `beforeSeq?`, `afterSeq?`, `limit?` (1–200, default 50). |

`message.history` pages by the **global `seq`** (the same cursor as the event
stream and live `message.new` pushes): `afterSeq` catches up offline messages,
`beforeSeq` pages backwards, and neither returns the newest page. Results are
always oldest-first and include `nextBeforeSeq` / `nextAfterSeq` plus
`hasMoreBefore` / `hasMoreAfter`. Every message's `seq` is the `seq` of its
`message.created` event, so live and history data share one dedupe key.

## Tasks (US-008 / US-009)

When a store is wired the server registers six task methods:

| Method | Roles | Notes |
| --- | --- | --- |
| `task.publish` | `admin` | Creates the task in `bidding` when `biddingDeadline?` is supplied (the window is open immediately); otherwise `open` (draft, not bid-able). Params: `title` (required), `description?`, `requiredSkills?`, `budget?`, `deadline?`, `biddingDeadline?` (epoch ms). |
| `task.list` | `admin`, `agent` | Workspace tasks, optional `status` filter and `limit`/`offset` paging. |
| `task.get` | `admin`, `agent` | One task by `taskId`, **including `version`** for CAS. |
| `task.bid` | `admin`, `agent` | Params: `taskId`, `price`, `eta?` (minutes), `approach?`, `confidence?` (0–1). Only while status is `bidding` and before `biddingDeadline`; re-bidding overwrites the same live bid. Limit: 5 bids/min per agent (`-32005`). |
| `task.bids` | `admin` | Live bid set for a task, newest last. |
| `task.award` | `admin` | Params: `taskId`, `expectedVersion`, `awardeeId?`, `strategy?` (`manual`/`auto`). Manual requires the awardee to have a live bid; auto scores all live bids. CAS conflict is `-32007`; success appends exactly one `task.awarded`. |

The lifecycle is one transition table (`modules/tasks.ts → TASK_TRANSITIONS`):
`open → bidding → awarded → in_progress → review → done`, with `→ failed`
available from `bidding`/`awarded`/`in_progress`/`review`. `review → in_progress`
is the rework/reassign path. Illegal edges are `-32003` (`data: {taskId,
from, to, allowed}`). Per the MVP cancel policy **only `open` may be
`cancelled`**; `open → failed` is intentionally absent (no trigger path; US-011
adds `task.fail` explicitly if needed). Review decisions map as
`approve → done`, `reject → in_progress`, `request-revision → in_progress`;
a terminal `failed` is an explicit admin choice, not the default reject
outcome (US-013).

Each transition runs `UPDATE ... WHERE id = ? AND version = ?` (CAS, version
bumps atomically) and appends `task.status.changed` at the new version; a stale
`expectedVersion` is `-32007` with `{taskId, expectedVersion, currentVersion,
from, to}`. `TasksService.reclaimExpired(now)` cancels overdue `open` tasks
(`deadline`, or `createdAt + TASK_OPEN_TTL_SECONDS` when configured) and writes
the same event with `reason: "deadline_expired" | "open_ttl_expired"`; the app
runs it on a timer that is cleared on close. `startServer` also sweeps once
**before** listening, so a restart cannot serve an already-expired task as
`open` until the first tick. `task.publish` rejects a `deadline` that is not in
the future.

### Bidding and scoring (US-009)

- **Bid window.** `task.bid` is accepted only while the task is `bidding` and
  before `biddingDeadline`. The window is opened at publish time by supplying
  `biddingDeadline`; `open` is a draft state and is not bid-able. Bids do
  **not** change `tasks.version`, so `expectedVersion` for `task.award` is
  stable for the whole window. Each bid appends `task.bid.placed` (audit) and
  `task.bid.received` (live notification) at the current version; v6's partial
  unique index allows several bid events per version while keeping status
  events unique. When `biddingDeadline` passes with no live bids, the window
  sweeper cancels the task; with bids it stays `bidding` for `task.award`.
- **Scoring.** Skill 0.35 + history 0.25 + availability 0.10 + price 0.15 +
  ETA 0.15. Weights are configurable and must sum to 1. History shrinks toward
  0.5 with `historyConfidenceThreshold=5`; availability is
  `1/(1+activeTasks)` (assigned `awarded`/`in_progress` tasks). Price and ETA
  are min-max normalised across the live bid set; a missing ETA is neutral.
- **Exploration.** Default `ProbabilisticExploration(rate=0.05)`; eligible
  bidders are skill-qualified with fewer than 5 finished tasks.
  `DEMO_MODE=true` forces `AlwaysExploreForDemo` for deterministic US-017
  demos. The selected `task.awarded` payload carries
  `exploration: true|false`.
- **Award CAS.** `task.award` requires `expectedVersion`; two concurrent awards
  with the same version yield one success and one `-32007`, and exactly one
  `task.awarded` event. The event is appended inside the transaction and emitted
  by the frame stack only after commit.
- **Rate limit.** Bid buckets use the shared LRU `TokenBucketRegistry`
  (5/min, burst 5) — no unbounded per-agent map.

There is no `task.cancel` RPC: `open → cancelled` is reached only by the
internal reclaim sweeper. Manual cancellation is deferred to US-013, so an
`open` task with neither a deadline nor `TASK_OPEN_TTL_SECONDS` configured
stays `open` until an operator changes it out of band.

## MVP tenancy limits (documented debt)

The store schema is workspace-ready, but the server is wired for a single
workspace (`default`):

- `agent.register` always writes the deployment default workspace; a request
  header cannot place an identity in another tenant.
- `TasksService.reclaimExpired()` is constructed with `workspaceId: 'default'`,
  so tasks published in a non-default workspace are not swept.
- `presence.update` is broadcast to every authenticated socket in the process,
  without the workspace filter applied to log-driven pushes.

These are accepted for the single-workspace MVP and must be fixed before
hosting more than one workspace per process (US-022+).

## WebSocket transport (US-006)

The gateway is attached to the same HTTP server as `/rpc` (upgrade path
`WS_PATH`) whenever a store is wired, so both transports share one dispatcher,
registry and log stream.

- **Handshake.** `Authorization: Bearer <jwt>` on the upgrade request binds the
  identity before the first frame; otherwise the socket starts anonymous and
  may only call `agent.register` / `agent.authenticate` (their reply carries a
  token that also binds the live socket) plus protocol `ping`/`pong`. Anything
  else — including control `resume` — gets `-32001`. A bad token is answered
  with `-32001` and the socket is closed with code `4401`.
- **Framing.** Control frames (`welcome` / `ack` / `gap_too_large` / `resume` /
  `ping` / `pong`) are top-level JSON objects discriminated by `type`; every
  other text frame goes through `RpcDispatcher`, so request/notification
  classification is exactly the HTTP one (id present ⇒ answered, absent ⇒
  silent).
- **Epoch / resume.** Each gateway instance mints a fresh `epoch`
  (`randomUUID()`), and `welcome` always carries `{epoch, seq, protocolVersion}`.
  `resume {lastSeenSeq, lastSeenEpoch?}` replays `events.listSince` in ascending
  `seq` after an `ack {epoch, seq}`; a missing `lastSeenEpoch` counts as a
  match, an explicit mismatch answers `gap_too_large {detail:
  "epoch_mismatch"}` without replaying, and a gap above `RESUME_MAX_EVENTS`
  answers `gap_too_large {detail: "buffer_exceeded"}`. Every replayed `seq` is
  recorded per socket, so a repeated resume never re-delivers one.
- **Live push.** The gateway subscribes to `EventsDao.onAppend`, so every
  committed event is delivered to the authenticated sockets of its workspace as
  a JSON-RPC notification (`method = event.type`, `params = {seq, …}`). Only
  pushable event types are broadcast (domain-only rows such as
  `message.created` stay in the log, exactly like `resume`). The same per-socket
  `seq` dedupe set backs both paths, so a live push can never repeat a `seq`
  that socket already received, and clients dedupe the live/replay overlap on
  the global `seq`.
- **Presence.** First socket of an agent broadcasts `presence.update
  {status: "online"}` to other authenticated sockets; the last one to close
  broadcasts `"offline"`.
- **Rate limiting.** Token buckets are soft: over-limit messages receive
  `-32005` with `data.scope = "connection" | "agent"`, `retryAfterMs` and the
  socket stays open (it recovers as the bucket refills).
- **Shutdown.** Sockets are terminated from Fastify's `preClose` hook; without
  it, upgraded connections keep `http.Server.close()` waiting forever.

## Accounts, tokens and roles

`US-005` plugs the account module in whenever `buildServer` receives a store
(`startServer` opens `DB_PATH` + runs migrations automatically):

| Method | Purpose | Who |
| --- | --- | --- |
| `agent.register` | `{name, owner?, skills?, role?}` → `{agentId, token, role, expiresAt, secret}` | anyone (role defaults to `agent`; `admin` needs `ALLOW_ADMIN_SELF_REGISTER`) |
| `agent.authenticate` | `{agentId?, name?, secret}` → fresh token, appends `account.authenticated` | existing accounts (or a valid token refreshing itself) |
| `agent.list` | `{limit?, offset?, role?}` → `{accounts, total, limit, offset}` | `admin`, `agent` |

- Tokens are HS256 JWTs (`sub` = agentId, `role`, `workspaceId`, `iss`, `aud`,
  `iat`, `exp`, `jti`).
- Handlers enforce authorisation with `requireRole(ctx, allowed)`:
  `-32001 Unauthorized` when there is no identity, `-32002 Forbidden` when the
  role is not allowed, `-32602 Invalid params` for malformed input and for a
  duplicate account name (`data.field = "name"`), unknown accounts on
  `agent.authenticate` are `-32001`, a throttled identity is
  `-32005 RateLimited`.
- Every account write appends a domain event (`account.registered` /
  `account.authenticated`, payload schemas in `@agentmesh/protocol`) inside the
  same transaction as the `accounts` row, so replay sees exactly what the
  table holds.
- `agent.register` is unauthenticated, so it is throttled per remote address
  (default 30 attempts/minute; `-32005` with `data.reason =
  "too_many_registrations"` and `retryAfterMs`).

### Bootstrap the first admin

`agent.register` refuses `role: "admin"` unless
`ALLOW_ADMIN_SELF_REGISTER=true`, and while that flag is on **any anonymous
client** can mint an admin. Use the local-only seed CLI instead:

```bash
npm run build
DB_PATH=data/agentmesh.db \
  npm run seed:admin -w @agentmesh/server -- --name admin --owner ops
```

The command opens the SQLite file directly (it is never exposed over HTTP/WS),
creates the admin if the name is free, and prints the generated secret **once**.
Running it again with the same name is a no-op and prints
`admin already exists ... (no changes)`. Trade the secret for a JWT with
`agent.authenticate { name, secret }`. If you must use
`ALLOW_ADMIN_SELF_REGISTER=true`, turn it back off immediately after creating
the first admin; the server logs a warning when it is enabled in production.

### Credential semantics (contract for later stories)

1. **Secret lifecycle.** `agent.register` mints a secret and returns the
   plaintext **exactly once**; the database stores only `sha256(secret)`
   (`accounts.secret_hash`). The secret is a **long-lived reusable
   credential**, not a one-time token: it may be replayed on every subsequent
   `agent.authenticate` (that is why authenticate is throttled, see §5). An
   already valid token may also refresh itself (`params.token` / `Authorization:
   Bearer`) without repeating the secret. Secrets and digests never appear in
   any other response, event, roster entry or log line.
2. **Storage strength.** The secret is 32 bytes of CSPRNG output (256 bits of
   entropy, base64url-encoded). A bare SHA-256 digest compared with
   `timingSafeEqual` is therefore sufficient — no salt and no key stretching
   (unlike human-chosen passwords, which need bcrypt/argon2-style iteration):
   there is nothing to guess cheaply and no low-entropy input to stretch.
3. **Workspace authority.** For an authenticated request the workspace is
   **always** the token's `workspaceId` claim. The `X-Workspace-Id` header is
   ignored for authenticated reads/writes (it only seeds the context of
   anonymous transport calls, e.g. `register`, which writes to the deployment
   default). *(Recorded stricter option for later: reject a request whose
   `X-Workspace-Id` disagrees with the token with `-32002` — candidate for
   US-022+; current behaviour per (a) is "ignore the header".)*
4. **Name uniqueness.** `register` judges duplicates exactly like the table's
   global `UNIQUE` constraint (across workspaces) and answers a neutral
   `-32602 name unavailable` with only `data.field = "name"` — the submitted
   name is not echoed, so the error is not an account-existence oracle. An
   existing account is **never** silently reused or re-issued a secret.
5. **Throttling.** Failed `agent.authenticate` attempts are counted **per
   identity** (resolved account id; the normalized submitted identifier for
   unknown accounts) in process memory. After `AUTH_MAX_FAILED_ATTEMPTS`
   failures inside `AUTH_FAIL_WINDOW_SECONDS`, the identity is locked out for
   `AUTH_LOCKOUT_SECONDS`, doubling on each consecutive lockout (capped at one
   hour). While locked, **every** attempt is rejected with `-32005` and
   `data = { reason: "too_many_attempts", retryAfterMs }` — including one
   carrying the correct secret. A successful verification (or a valid token
   refresh) clears the counter; different identities never share a bucket.
   The lockout is a soft rejection (a normal JSON-RPC error, never a crash),
   it writes no event, and it resets when the process restarts because the
   counters are process-local.

## Plugging a feature module in

```ts
import { buildServer } from '@agentmesh/server';
import { ProtocolError, JsonRpcErrorCode } from '@agentmesh/protocol';

const app = buildServer();
app.registry.registerHandler('task.get', async (ctx, params) => {
  if (!params || typeof params !== 'object') {
    throw new ProtocolError(JsonRpcErrorCode.InvalidParams);
  }
  ctx.logger.info({ msg: 'task.get', params }); // already bound to reqId/method/agentId
  return { id: 'tsk_1' };
});
await app.listen({ port: app.config.port, host: app.config.host });
```

- Handlers throw `ProtocolError` for expected failures (`code`/`data` preserved
  on the wire). Any other throw becomes `-32603 Internal error` plus a
  `system.error` notification whose `reqId` matches the log line.
- Duplicate registration throws `DuplicateHandlerError`; pass
  `{ override: true }` to replace an existing handler deliberately.
- Authenticated handlers start with
  `const auth = requireRole(ctx, ADMIN_ROLES)` (`@agentmesh/server` re-exports
  the role helpers); `ctx.auth`/`ctx.role` are populated by the dispatcher.

## Log shape

One JSON line per message:

```json
{"level":"info","ts":"...","service":"agentmesh-server","reqId":"...",
 "method":"task.get","agentId":"agt_1","durationMs":1.23,
 "msg":"rpc.request.completed"}
```

Failures add `err` (name/message/stack, plus `code`/`data` for
`ProtocolError`) and use `warn` for protocol errors, `error` for unexpected
ones.

## Security model (MVP)

**Algorithms.** HS256 JWT (signature only — the payload is Base64URL and is
*not* encrypted), SHA-256 for account-secret digests and the event hash chain,
CSPRNG (`randomBytes`/`randomUUID`) for secrets and ids. There is no AES/RSA,
no password KDF and no SQLCipher in this build.

- **JWT_SECRET.** In production it must be at least **32 bytes**; known weak
  values (`secret`, `changeme`, `test`, …) and zero-entropy repeats (`aaaa…`)
  are rejected at startup. Development keeps the ≥16-character floor and logs
  a `security.warning` when the key is shorter than 32 bytes. The key is the
  entire signing authority: leaking it means forging any identity.
- **Verification.** `jose.jwtVerify` is called with `algorithms: ['HS256']`,
  `issuer`, `audience`, a 5-second clock tolerance and the injected clock.
  Tokens with `alg: none`, `alg: RS256`, a wrong `iss`/`aud`, a bad signature
  or an expired `exp` are rejected with `-32001`.
- **Payload.** Only `sub`, `role`, `workspaceId`, `iss`, `aud`, `iat`, `exp`,
  `jti`. No secret, digest, owner/email or internal note belongs in a JWT.
- **Token revocation (not implemented).** A leaked token remains valid until
  `exp` (default **3600 s**). Mitigations: short TTL, per-identity auth
  throttling, and rotating `JWT_SECRET` (which invalidates every token and
  requires a maintenance window + re-authentication). A `jti` blacklist or
  short-lived access + refresh tokens is a US-022+ candidate.
- **Transport.** TLS terminates at the reverse proxy; Node listens on HTTP/ws.
  Browser WebSocket upgrades are checked against `ALLOWED_ORIGINS`
  (CSWSH defence). Non-browser clients without an `Origin` are governed by
  `ALLOW_MISSING_ORIGIN` (default true). Development also accepts
  `localhost`/`127.0.0.1`/`[::1]`. **CSWSH assumes the token travels in the
  `Authorization: Bearer` header, which browsers do not attach automatically.
  If authentication ever moves the token into a cookie, you must also add a
  CSRF token or `SameSite=Strict` and set `ALLOW_MISSING_ORIGIN=false`.**
- **Input limits.** HTTP bodies and WS frames are capped at **1 MiB**
  (`bodyLimit` / `maxPayload`). The auth-failure, registration and per-agent
  bucket maps are bounded (capacity checked **before insert**, so they never
  exceed the limit) and use **LRU** eviction, so an active identity's
  rate-limit state is never displaced by a flood of one-shot keys.
- **Artifact transport (architecture decision).** Do **not** raise
  `maxPayload` for US-011 artifacts. Payloads above 1 MiB go through an HTTP
  upload and WS carries only a reference (URL/ID). Raising the frame limit
  would widen the DoS surface.
- **Clock tolerance.** `clockTolerance: 5s` is for a single host or a
  clock-synchronised fleet. Multi-instance deployments (US-022+) need NTP or a
  tolerance of at most 30s.
- **`ALLOW_MISSING_ORIGIN` defaults to true in both environments.** Origin is
  a browser-added header; SDK/CLI/demo clients legitimately omit it. Origin
  checks provide no CSWSH protection for non-browser clients, so rejecting
  them is deployment friction with no security gain. Set it to false only when
  every client is a browser.
- **Logs.** pino redacts `authorization`, `secret`, `token`, `password` and
  `secretHash` (top-level and nested), plus precise error/request paths:
  `err.body`, `err.request`, `err.payload`, `req.body`, `request.body`. It does
  **not** use top-level `*.body`/`*.payload` wildcards, so normal business
  `payload` logs remain intact.
- **At rest.** SQLite is plaintext; rely on OS/volume encryption. The deployment
  must create the database parent directory with mode `700` (this repository has
  no Docker/部署 script yet — US-018 owns it). Database-level encryption via
  `better-sqlite3-multiple-ciphers` (SQLCipher-compatible) is a drop-in candidate
  for US-022+, deliberately not in the MVP.
- **Hash chain.** `prevHash` is written and `verifyEventChain` exists, but
  neither is enforced automatically: DB write access can rewrite history.
  A real tamper-evidence guarantee needs periodic verification + external
  anchoring.
- **`secretHash` in events.** `account.registered` carries the SHA-256 digest
  (never the plaintext). Event-log access must be at least as restricted as
  the `accounts` table; a future public event API must filter `secretHash`.
- **Future RS256.** Only needed when a third party must verify tokens without
  the HMAC key, or for zero-downtime key rotation. Migration: generate an
  RS256 key pair, add `kid`, publish `/.well-known/jwks.json`, accept HS256 and
  RS256 during a transition, then remove HS256. No `kid`/JWKS code exists yet
  on purpose.
- **Dependency baseline.** `package-lock.json` must be committed; CI should run
  `npm audit --audit-level=high`. As of 2026-11-19: **0 vulnerabilities**.

## Operations runbook

- **Lost admin secret.** `seed:admin` is create-only and has no reset mode.
  Recover by clearing `accounts.secret_hash` for that row and re-seeding, or
  delete the row (after confirming no tasks reference it) and run `seed:admin`
  again. Do not enable `ALLOW_ADMIN_SELF_REGISTER` as a recovery shortcut.
- **JWT_SECRET rotation.** Rotating the key immediately invalidates every
  issued token (the old key can no longer verify new signatures). Perform it in
  a maintenance window and tell every agent to `agent.authenticate` again.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` call `app.close()`: the Fastify
  `preClose` hook terminates WebSocket sessions, the reclaim timer is cleared,
  and the owned SQLite handle is closed. No unflushed log buffer is held
  (pino writes synchronously to stdout).
