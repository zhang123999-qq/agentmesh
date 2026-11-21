# @agentmesh/adapters

`AgentAdapter` interface and five provider templates (grok / muse / hermes /
openclaw / codex) over an **injected** `@agentmesh/sdk` client.

The adapter owns provider-specific configuration and capability declaration; it
does **not** own transport, reconnect or dedupe. Those stay in the SDK.

## Quick start

```ts
import { AgentMeshClient } from '@agentmesh/sdk';
import { GrokAdapter } from '@agentmesh/adapters';

const client = new AgentMeshClient({ url, transportFactory });
const adapter = new GrokAdapter(
  {
    client,
    events: {
      onTaskAssigned: ({ taskId }) => console.log('assigned', taskId),
      onReviewDecided: ({ taskId, decision }) => console.log(taskId, decision),
      onAborted: ({ taskId, reason }) => console.log('stop', taskId, reason),
    },
  },
  {
    name: 'planner',
    provider: 'mock',
    skills: ['planning'],
    availability: 0.8,
    maxConcurrentTasks: 2,
  },
);

await client.connect();
await adapter.register();
await adapter.join('chn_general');
```

## Contract

```ts
interface AgentAdapter {
  readonly provider: string;
  readonly agentId: string | undefined;
  getCapabilities(): AgentCapabilities;
  register(params?): Promise<AuthResult>;
  authenticate(params?): Promise<AuthResult>;
  join(channelId): Promise<unknown>;
  bid(taskId, bid): Promise<unknown>;
  progress(taskId, progress, options?): Promise<unknown>;
  complete(taskId, expectedVersion, options?): Promise<unknown>;
  fail(taskId, expectedVersion, reason?): Promise<unknown>;
  review?(taskId, expectedVersion, decision, comment?): Promise<unknown>;
  subscribe(events): () => void;
  close(): void;
}
```

### Capabilities

Declared at construction and exposed by `getCapabilities()`:

```ts
{ skills, availability, maxConcurrentTasks, supportsReview }
```

The server's US-009 scoring currently derives skills/history/availability from
the accounts and tasks tables; the adapter declaration is used by the adapter to
decide whether to bid. If the server later consumes adapter capabilities, it
should become an explicit query rather than an implicit assumption.

### Abort semantics

`onAborted` fires when:

- `task.cancelled` arrives for a task assigned to this agent;
- `task.reassigned` moves a task away from this agent;
- `progress` / `complete` / `fail` returns `ForbiddenError` with
  `data.reason = "not_assignee"`.

`reason` is `cancelled | reassigned | not_assignee`. The adapter does not kill
the work itself; the host must use this callback to stop its own execution loop.

### Review awareness

`onReviewDecided` forwards `{ taskId, reviewerId, decision, comment?, version? }`
for `approve | reject | request-revision`. The host decides whether to rework,
re-bid or stop.

## Templates

| Class | Provider | Required config | Notes |
|---|---|---|---|
| `GrokAdapter` | `grok` | `provider: 'xai' \| 'mock'` | optional `baseUrl` / `model`; no real network calls |
| `MuseAdapter` | `muse` | `workspaceId` | optional `model` |
| `HermesAdapter` | `hermes` | `endpoint` | optional `model` |
| `OpenclawAdapter` | `openclaw` | `gatewayUrl` | optional `sandboxId` |
| `CodexAdapter` | `codex` | `sandboxId` | optional `model` |

All templates share `BaseAgentAdapter` and differ only by configuration and
validation. They are intentionally stubs: construction, capability declaration,
event wiring and error propagation are complete; no provider API is called.

## Non-goals

- No transport / reconnect / dedupe implementation (SDK only).
- No task state machine (server is authoritative).
- No real credentials or network calls in templates.
