# @agentmesh/core

AgentMesh 的事件溯源核心：只追加事件存储、聚合 reducer、replay 与快照。

> 项目级文档：[../../docs/README.md](../../docs/README.md)（架构 / 安全 / 状态）。

持久化完全复用 `@agentmesh/store`（`events` 表 + `EventsDao` + `snapshots` 表），
协议信封复用 `@agentmesh/protocol`。本包只补事件溯源语义，不另建类型真源。

```ts
import { openDatabase, runMigrations } from '@agentmesh/store';
import {
  EventStore,
  SnapshotStore,
  Snapshotter,
  replayAggregate,
  taskReducer,
  initialTaskState,
} from '@agentmesh/core';

const db = openDatabase(':memory:');
runMigrations(db);

const store = new EventStore(db);
store.append({
  aggregateId: 'task:tsk_1',
  type: 'task.published',
  payload: { title: 'ship it', budget: 100 },
}); // → { seq: 1, version: 1, ts, prevHash? }

const { state } = replayAggregate(store, 'task:tsk_1', taskReducer, initialTaskState('task:tsk_1'));

// 定期快照 + 快照增量重放
const snapshots = new SnapshotStore(db);
const snapshotter = new Snapshotter(snapshots, { everyNEvents: 50 });
const snapshot = snapshotter.maybeTake({
  aggregateId: 'task:tsk_1',
  state,
  version: state.version,
  seq: store.head(),
});
const fast = replayAggregate(store, 'task:tsk_1', taskReducer, initialTaskState('task:tsk_1'), {
  snapshot: snapshots.latest('task:tsk_1'),
});
```

## 能力

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 事件信封 | `CoreEvent` / `AppendEventRequest` / `toCoreEvent` | 复用 protocol 的 `{seq, aggregateId, type, version, payload, ts, prevHash?}` |
| 只追加写入 | `EventStore.append` / `appendMany` | `seq` 由 SQLite AUTOINCREMENT 分配（全局单调、唯一、不复用）；`version` 默认 `latest+1`；批量原子 |
| 读取 | `loadAggregate` / `readFrom` / `readAfter` / `head` | 按聚合读、按 seq 窗口读、水位 |
| 哈希链 | `hashEvent` / `verifyEventChain` | append 默认写入 `prevHash = hash(上一条全局事件)`；MVP 只写不强制校验（审计可用） || Reducer | `accountReducer` / `channelReducer` / `messageReducer` / `taskReducer` | 纯函数 `(state, event) => state`，`reduceByKind` 按 kind 分发 |
| Replay | `replayAggregate` / `replayFromSnapshot` | 全量重放；或快照 + `seq > snapshot.seq` 增量重放 |
| 快照 | `SnapshotStore` / `Snapshotter` | `snapshots(aggregate_id, version)` 主键 upsert，`everyNEvents` 周期策略，`prune` 保留最新 N 条 |
| CRDT | `crdt/or-set.ts` / `crdt/lww.ts` | OR-Set（竞标集合，stableFrontier 压缩）+ LWW-Register/Map（presence，逻辑时钟 + nodeId） |

## 聚合 ID 约定

`account:<id>`、`channel:<id>`、`message:<id>`、`task:<id>`，用
`aggregateIdOf(kind, id)` / `parseAggregateId(id)` 处理。

## 设计约束

- **事件是事实，状态是推导**：快照是派生数据，可随时删掉从日志重建。
- **reducer 必须纯**：不读库、不改原对象；同一批事件永远得到同一状态。
- **payload 容错读取**：领域事件（如 `task.published`）没有 zod schema，
  reducer 用 `payload.ts` 的宽容读取器，旧数据缺字段不会让 replay 崩。
- **`prevHash`**：为后续哈希链防篡改审计预留；`verifyEventChain` 只校验**全局
  连续**的相邻事件（`readFrom` 窗口），`loadAggregate` 之类按聚合切出的日志天然
  有空洞，链接视为不可校验而非篡改。未写 `prevHash` 的历史行视为锚点。
  **这目前只是“写了但没强制验证”**：拥有数据库写权限的人仍可改写历史，
  不能把它当成运行时防篡改保证；生产需要定期验证 + 外部锚定。

## 测试

```bash
npm test -w @agentmesh/core
```

覆盖：seq 全局递增、append→load→replay 一致、哈希链写入/篡改检测、
四个聚合 reducer、快照 + 增量 == 全量重放、快照周期策略。
