# @agentmesh/store

AgentMesh 的 SQLite 持久化层：迁移、表结构，以及每张表的类型化 DAO。
服务端（`apps/server`）与迁移入口（US-018）都通过它读写数据。

> 项目级文档：[../../docs/README.md](../../docs/README.md)（架构 / 安全 / 状态）。

```ts
import { openDatabase, runMigrations, createRepositories } from '@agentmesh/store';

const db = openDatabase('data/agentmesh.db'); // ':memory:' 用于测试
runMigrations(db); // 幂等，可每次启动都调用
const repos = createRepositories(db);

const task = repos.tasks.create({ id: 'tsk_1', title: 'build', status: 'open' });
repos.tasks.updateWithVersion(task.id, task.version, { status: 'awarded', assignee: 'agt_1' });
```

## 表结构

| 表 | 说明 |
| --- | --- |
| `accounts` | 账号：`skills` 为 JSON 数组，`role` 为 admin/agent/observer |
| `channels` | 频道 |
| `channel_members` | 频道成员（`(channel_id, agent_id)` 复合主键，`add` 幂等）；**主键不含 `workspace_id`**，多工作区共存需 US-022+ 重建表 |
| `messages` | 消息；`seq` 与 `events.seq` 属同一全局序列空间，用于历史分页与流式去重；v3 起 `uq_messages_seq` 强制**全局唯一** |
| `tasks` | 任务；`version` 用于乐观并发 CAS |
| `task_bids` | 竞标；OR-Set 元素级删除元数据 + 压缩游标 |
| `events` | 只追加事件日志；`seq INTEGER PRIMARY KEY AUTOINCREMENT`（全局单调递增、全局唯一、不复用） |
| `snapshots` | 聚合快照（迁移 v2）；`(aggregate_id, version)` 主键，`seq` 记录覆盖到的全局水位 |
| `schema_version` | 迁移台账 |

所有业务表都带 `workspace_id TEXT NOT NULL DEFAULT 'default'` 与索引；MVP 默认单工作区，
不做隔离逻辑，但 schema/索引已就绪。

### 多租户债务（M3 前置加固，明确记录）

`channel_members` 的主键仍是 `(channel_id, agent_id)`，**不含 `workspace_id`**，因此两个
工作区无法在同一表里共存相同的 `(channel_id, agent_id)`。迁移 v3 只补了增量唯一索引
`uq_channel_members_ws (workspace_id, channel_id, agent_id)` 作为过渡；真正支持多工作区
共存需要重建该表并把主键改为 `(workspace_id, channel_id, agent_id)`，该重建推迟到
**US-022+**。MVP 单工作区下行为不变（`add`/`get` 仍按 workspace 作用域读写）。

## 迁移

`runMigrations(db)` 双重保证幂等：

1. `schema_version` 台账记录已应用版本；
2. 所有语句都是 `CREATE TABLE / INDEX IF NOT EXISTS`（台账被清掉也能自愈）。

返回 `{ applied: number[], version }`；`CURRENT_SCHEMA_VERSION` 为当前构建的最高版本。

版本历史：

| 版本 | 名称 | 内容 |
| --- | --- | --- |
| v1 | `initial_schema` | 7 张业务表 + 索引 |
| v2 | `snapshots_schema` | 聚合快照表 `snapshots` |
| v3 | `store_hardening` | `uq_messages_seq`（`messages.seq` 全局唯一）+ `uq_channel_members_ws` |
| v4 | `account_credentials` | `accounts.secret_hash`（nullable，仅存 SHA-256 摘要） |
| v5 | `event_log_integrity` | `uq_events_aggregate_version`：`(workspace_id, aggregate_id, version)` 唯一，防止多写者产生重复聚合版本 |
| v6 | `bid_events_per_version` | 删除 v5 全量唯一索引，改为**部分唯一索引** `uq_events_aggregate_version_status`（排除 `task.bid.placed` / `task.bid.received`），允许同一 task version 上有多条竞标事件，同时仍保证状态事件每版本唯一 |
| v7 | `task_progress_and_side_effect_events` | `tasks.progress` 列（原地更新，不递增 version）；部分唯一索引扩展到排除 `task.progress.updated` / `task.dependency.failed` |
| v8 | `task_completed_at` | `tasks.completed_at` 列（review approve 进入 done 时写入） |

v5 的索引是**强制约束**：如果已有数据库里存在重复的
`(workspace_id, aggregate_id, version)`，迁移会明确失败而不是静默跳过；先修复重复行再启动。
v6 起因是竞标设计要求 `tasks.version` 在竞标窗口内保持不变；bid 事件的版本与当前
task version 相同，因此必须从唯一索引中排除。

v3 只追加索引、不重建表，因此已存在的 v2 库再次 `runMigrations` 只会应用 v3 并保留原有数据；
空库则 v1→v2→v3 一次到位。

## 两个关键语义

### CAS（乐观并发）

```ts
const changes = repos.tasks.updateWithVersion(id, expectedVersion, patch);
if (changes === 0) throw new ProtocolError(JsonRpcErrorCode.VersionConflict); // -32007
```

SQL 为 `UPDATE ... SET ..., version = version + 1 WHERE id = ? AND version = ?`，
受影响行数为 0 即版本冲突，调用方不得静默覆盖（US-009 / US-013 复用）。
`tasks.update()` 是不带版本校验的普通更新，**不会**递增 `version`。

### OR-Set（竞标集合）

- `task_bids.markDeleted(id)` 只写 `tombstone = 1` + `deleted_at`，**不物理删除**；
- 默认查询隐藏 tombstone，`includeTombstones: true` 可看全量；
- `stableFrontier` 是该聚合 tombstone 已安全压缩到的逻辑游标（按行冗余，聚合值取
  `MAX(stable_frontier)`）：`getStableFrontier(taskId)` / `setStableFrontier(taskId, n)`
  （只增不减）。压缩任务本身在 US-012 增补。

## DAO 一览

`AccountsDao` / `ChannelsDao` / `ChannelMembersDao` / `MessagesDao` / `TasksDao` /
`TaskBidsDao` / `EventsDao`，由 `createRepositories(db)` 一次性装好。
`EventsDao` 只提供 `append`，没有 update/delete —— 日志不可变。
