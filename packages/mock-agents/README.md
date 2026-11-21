# @agentmesh/mock-agents + demo

Three deterministic mock agents (`planner` / `coder` / `reviewer`) over
`@agentmesh/adapters` + `@agentmesh/sdk`, plus a one-command end-to-end demo.

## Run

```bash
npm run demo
```

This builds the workspace, starts a real server on an ephemeral port with an
in-memory SQLite store, seeds an admin, starts three WebSocket clients, and
prints/writes `demo-output.json`. Exit code is 0 only when `code` and `rework`
tasks are `done` and the cancelled task is `cancelled`.

## What the demo covers

1. `publish` (with `biddingDeadline`) → bids → `award` → `progress` →
   `complete` → `review approve` → `done`.
2. `publish` → bids → `award` → `progress` → `complete` → `review
   request-revision` → rework (`progress` + `complete`) → `review approve` →
   `done`.
3. `publish` (no window) → `task.cancel` → `cancelled`.
4. A deliberate stale `award` after the first award, asserting
   `VersionConflictError` exposes `taskId`, `expectedVersion=1`,
   `currentVersion=2`.

## Decisions locked for the demo

- **`DEMO_MODE=true`** is used to force the deterministic cold-start exploration
  branch. Both awards carry `exploration: true`; the output has `demoMode: true`.
- **Shared process**: the three agents and the admin run in one process with
  four `AgentMeshClient` instances. Each adapter owns only its subscriptions;
  the demo owns client lifecycle.
- **Cleanup order**: adapter `close()` → client `close()` → Fastify `close()` →
  SQLite `close()`. `cleanExit: true` means all clients reached `closed`.
- **Failure injection**: `-32007` only. `gap_too_large` recovery is covered by
  the SDK unit tests, not repeated here.
- **No server bypass**: the demo uses the public RPC/SDK surface only.

## Output

`demo-output.json` (also printed to stdout) contains:

```json
{
  "demoMode": true,
  "channelId": "chn_...",
  "tasks": {
    "code": { "status": "done", "progress": 100, "completedAt": 169... },
    "rework": { "status": "done", "progress": 100, "completedAt": 169... },
    "cancelled": { "status": "cancelled" }
  },
  "awards": [
    { "taskId": "tsk_...", "awardeeId": "agt_...", "exploration": true, "strategy": "auto" }
  ],
  "eventTypes": ["task.bid.received", "task.awarded", "..."],
  "eventSeqs": [14, 15, 16],
  "versionConflict": { "taskId": "tsk_...", "expectedVersion": 1, "currentVersion": 2 },
  "cleanExit": true
}
```

The event sequence is the SDK's live notification stream (global `seq` order);
domain-only events such as `task.published` are not pushed and therefore do not
appear.

## Agents

| Class | Role | Default skills | Execution |
|---|---|---|---|
| `PlannerAgent` | admin | `planning` | publishes, awards, reviews, cancels |
| `CoderAgent` | agent | `typescript` | bids, reports progress, completes |
| `ReviewerAgent` | agent | `review` | bids, rework progress/complete |

`MockAgent` wraps `BaseAgentAdapter`; capabilities come from US-015
`getCapabilities()`. `executeTask` reports progress, fetches the latest task via
`getTask` (US-015 deviation 4), then completes with the fresh version.

## Lifecycle

Adapters do not close injected clients (US-015 decision 4). The demo owns all
clients and closes them explicitly; the test asserts `cleanExit`.
