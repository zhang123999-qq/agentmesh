# 当前状态

## 完成度

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| US-001…US-007 | 完成 | monorepo、协议、store、core、server、鉴权、频道/消息、WS |
| US-008 | **PASS**（按对抗验证判据） | 任务发布、状态机、CAS、超时回收、启动回收 |
| US-009 | **完成（本地验证）** | 竞标、五维评分、冷启动探索、CAS 授标、并发冲突 |
| US-010 | **完成（本地验证）** | `message.history` 双向 seq 游标、成员权限、离线补偿 |
| US-011 | **完成（本地验证）** | progress/complete/fail、父子 DAG、失败传播、终态吸收 |
| US-012 | **完成（本地验证）** | OR-Set 收敛/压缩、LWW presence、业务不变量 |
| US-013 | **完成（本地验证）** | review/reassign/cancel；任务可闭环到 done/failed/cancelled |
| US-014 | **完成（本地验证）** | `@agentmesh/sdk`：传输无关、resume/去重/gap 策略、21 个类型化方法 |
| US-015 | **完成（本地验证）** | `@agentmesh/adapters`：AgentAdapter + 5 家模板、中止/review 契约 |
| US-016…US-021 | 未开始 | CLI、mock agents/demo、Web、Docker |

测试基线：**451**
（core 51 / protocol 47 / store 71 / sdk 7 / adapters 7 / server 268）。

US-008 的判定依据与 notes 见 [us-008-notes.md](us-008-notes.md)。关键语义：

- `review → in_progress` 已补；
- `reject → in_progress`（允许重做/改派），`failed` 是 admin 显式终态；
- `open → failed` 已删除（无触发路径，US-011 需要时显式加回）；
- `seed-admin` 的 `account.registered` 含 `secretHash`，replay 可重建凭证；
- `expectedVersion` 已必填，所有 transition 都走 CAS。

US-009 的关键语义：

- `task.publish` 带 `biddingDeadline` → 直接创建为 `bidding`；不带 → `open`（草稿，
  不可竞标）。
- 竞标不修改 `tasks.version`；整个窗口内 award 的 `expectedVersion` 稳定等于
  publish/进入 bidding 时的版本。
- 每次 bid 追加 `task.bid.placed`（审计）与 `task.bid.received`（实时通知）两条
  事件，版本都等于当前 task version；v6 部分唯一索引允许同版本多条 bid 事件。
- 同一 agent 重复竞标按覆盖语义（复用同一 bid 行/id）。
- 五维权重默认 0.35/0.25/0.10/0.15/0.15，可配置且必须和为 1；历史成功率按
  `history_confidence_threshold=5` 向 0.5 收缩；availability = 1/(1+activeTasks)。
- `DEMO_MODE=true` 强制 `AlwaysExploreForDemo`；否则默认 5% 概率探索。
- `task.award` 必填 `expectedVersion`；并发时第二个请求 `-32007`，事件日志仅一条
  `task.awarded`；`task.awarded` 走 `withTransaction` 帧栈，提交后才 emit。
- `task.bid` 限流 5/min/agent，复用 LRU `TokenBucketRegistry`。
- `biddingDeadline` 到期且无 live bid → `closeExpiredBidding` 将任务 `cancelled`；
  已有 bid 则保持 `bidding` 等待 award。

US-010 的关键语义：

- `message.history` 仅频道成员可查（非成员 `-32002`），未知频道 `-32004`。
- `beforeSeq` 向后翻页、`afterSeq` 向前增量补偿、都不传取最新一页；返回始终按
  `seq` 升序，`nextBeforeSeq` / `nextAfterSeq` 为下一页游标。
- 每条消息的 `seq` 就是 `events.seq`（`messages.seq` 同空间），实时流与 history
  共用同一去重键。

US-011 的关键语义：

- `task.progress`：首次上报把 `awarded → in_progress`（CAS，version +1）；之后只更新
  `tasks.progress`，**不递增 version**。并发 progress 都成功，最后写入者胜。
- `task.complete`：`in_progress → review`（CAS，`expectedVersion` 必填），progress
  置 100，追加 `task.completed` notification；父任务必须所有 `parentId` 子任务为
  `done`，否则 `-32003 reason: subtasks_incomplete`。
- `task.fail`：`awarded/in_progress → failed`（CAS），追加 `task.failed` notification；
  若父任务存在且非终态，父任务保持 `in_progress`，`blockedBy` 合并子任务 id，并追加
  `task.dependency.failed`。
- **终态吸收**：父任务 `done/failed/cancelled` 后，子任务失败不再修改父任务。
- DAG 使用已有 `tasks.parent_id`（单父 DAG）；`assertParentChainAcyclic` 防御环。
- `progress/completed/failed/dependency.failed` 都是 notification，走
  `withTransaction` 帧栈，提交后 emit。
- 产物只传引用（URL/ID）；>1 MiB 走 HTTP 上传，不调大 WS `maxPayload`。

US-012 的关键语义：

- **OR-Set**（`packages/core/src/crdt/or-set.ts`）：add/remove/merge/live 全为纯函数；
  merge 满足交换/结合/幂等；同元素多 tag 只产生一个 live 元素。
- **压缩**：`compactOrSet(frontier)` 只删除 `<= frontier` 的**已删除 tag**及其死 add；
  live add tag 永不删除，压缩前后 live 集合一致。
- **task_bids 对接**：`orSetFromBidRows` 以 agentId 为元素、`createdAt|bidId` 为 tag；
  `stable_frontier` 作为压缩 frontier；不新增表、不新增 v8 迁移。
- **LWW-Register / LWW-Map**（`lww.ts`）：stamp=(counter,nodeId)，counter 为逻辑时钟，
  nodeId 做 tie-break；merge 收敛且幂等；离线用更高 stamp 的 `offline` 值表达，
  **不硬删**。
- presence 的断开清除仍由网关的“最后一个 socket 关闭 / 心跳超时 terminate”路径驱动；
  新增 WS 测试断言心跳终止会向其它连接广播 `offline`。
- 任务归属仍走 CAS，不进入 CRDT；晚到 bid 不会改变已授标任务的 assignee。

US-013 的关键语义：

- `task.review`（admin）：`approve → done`（写 `completedAt`）；
  `reject` / `request-revision → in_progress`（保留 progress，artifacts 追加）。
  `review → failed` 走 admin 显式 `task.fail`，不扩 review decision 枚举。
- `task.reassign`（admin）：目标 agent 必须是已注册账号（否则 `-32004`）；
  状态 `awarded/in_progress/review → in_progress`；旧 assignee 的 live bid 保留；
  progress 保留；改派后旧 assignee 调 progress/complete/fail → `-32002`。
  admin 把任务改派给自己时 `humanTakeover: true`。
- `task.cancel`（admin）：允许 `open/bidding/in_progress/review`；
  终态不可取消（`-32003`）；追加 `task.cancelled` notification。
- US-009 的 `closeExpiredBidding` 统一使用 `task.cancelled`（reason
  `bidding_window_closed`），状态仍为 cancelled，行为回归测试通过。
- review/reassign/cancel 未额外限流（仅 admin，且每次是单条 CAS）；已记录为决策。

## 已实现的 RPC（21 / 22）

| 分组 | 方法 |
| --- | --- |
| agent | `agent.register` / `agent.authenticate` / `agent.list` |
| channel | `channel.create` / `channel.join` / `channel.leave` / `channel.list` |
| message | `message.send` / `message.history` |
| task | `task.publish` / `task.list` / `task.get` / `task.bid` / `task.bids` / `task.award` / `task.progress` / `task.complete` / `task.fail` / `task.review` / `task.reassign` / `task.cancel` |

未注册、请求返回 `-32601`：

- `system.subscribe`（单列/US-021；本故事不实现）

US-014 的关键语义：

- `@agentmesh/sdk` 提供 `AgentMeshClient`，**不内置 `ws`**；通过可注入
  `TransportFactory` 支持浏览器与 Node（浏览器默认使用全局 WebSocket，Node 用
  `ws` 适配器）。
- 浏览器的 JWT 登录走**带内认证**：SDK 从 token 解出 `sub`，发送
  `agent.authenticate {agentId, token}`；服务端验证后绑定 socket 并下发 welcome。
- resume **始终携带 `lastSeenEpoch`**；实时通知与 history 共用全局 `seq` 去重。
- `gap_too_large`：默认 `auto` = 清空游标 + 自动重连 + `gapTooLarge` 回调；
  `strict` = 只回调、由调用方 `resync()`。`resyncChannelHistory()` 按
  `message.history` 循环拉取并按 seq 去重。
- `sendRaw` 提供原样发送逃生舱，**不保证类型、不参与去重**。
- 类型化方法覆盖当前 21 个已注册 RPC；`system.subscribe` 仍为 22 个协议方法中
  唯一未实现项。
- `message.history` 的 `total` 已重命名为 **`channelTotal`**（频道消息总数，
  不是本页条数）；`message.history` / `task.bid` / `task.award` 参数 schema 已补进
  `packages/protocol/src/params.ts`。

US-015 的关键语义：

- `AgentAdapter` 接收**注入的** `AgentMeshClient`，不持有/复制传输、reconnect、dedupe。
- 能力在构造时静态声明，`getCapabilities()` 返回
  `{skills, availability, maxConcurrentTasks, supportsReview}`；服务端评分当前仍用
  accounts/tasks 数据，adapter 声明用于自身竞标决策。
- `onAborted` 在 `task.cancelled`、被 reassign 走、以及执行 RPC 返回
  `ForbiddenError data.reason=not_assignee` 时触发；reason =
  `cancelled | reassigned | not_assignee`。
- `onReviewDecided` 转发 approve / reject / request-revision。
- 5 家模板：grok/muse/hermes/openclaw/codex，共用 `BaseAgentAdapter`，仅配置与校验不同；
  不发起真实 provider 网络调用。

## 已知缺口 / 技术债

| 项 | 归属 | 影响 |
| --- | --- | --- |
| `system.subscribe` 未实现 | 单列/US-021 | 客户端只能用现有 event 通知，不能显式订阅系统事件 |
| 单 workspace 债务：reclaim 固定 `default`、register 写默认 workspace、presence 不按 workspace 过滤 | US-022+ | 多租户不可用；已在 server README 记录 |
| 哈希链只写不验 | US-022+ | 不能作为运行时防篡改保证 |
| 无 token 撤销 | US-022+ | 泄露 token 在 `exp` 前有效 |
| SQLite 明文 | US-022+ | 依赖 OS/卷加密 |
| mock-agents/CLI/Web/Docker 为空 | US-016…US-019 | 生态与部署未落地 |

## 下一步

1. **US-016 CLI**：复用 SDK；配置/profile、history 游标、-32007/-32005 UX。
2. **US-017 demo**：planner/coder/reviewer + `npm run demo`，覆盖 approve 与 reject→重做。
3. **US-018 Docker**：数据目录 700、TLS 反代、密钥注入、迁移入口。
4. **US-019…US-021 Web**（必须复用 SDK）；`system.subscribe` 单列/随 US-021。

## 溯源说明

本地仓库是**独立初始化的 git 历史**（`a5cf1cc` 为 import 提交），与 qwenpaw 容器
仓库（提交链 `c8807d4…d508299`）**没有共同祖先**，不能通过 `git log` 直接比较。
溯源只能用文件内容 hash 对比。当前关键文件：

- `apps/server/src/modules/tasks.ts` SHA-256
  `1b5e3362e53598a99d3d858404f997be9988c8f46aa3979eaa5b33820528d777`
- `apps/server/test/tasks.test.ts` SHA-256
  `7b823e460e8f975a885a1b22215a905630063105335be133c42119e9095c6adf`
- `apps/server/test/task-execution.test.ts` SHA-256
  `c287174b494e8c62c58282af2afb4715c4a888930318892b2af856ed64970b4e`
- `apps/server/test/task-review.test.ts` SHA-256
  `6c312596d32c085108cb08d13588108db21d459792a1f6c9e512060e34701dfb`

（hash 为 US-013 后的基线。）

