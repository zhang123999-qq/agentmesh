# 变更记录

本记录从本地工作树开始，不包含 qwenpaw 容器侧的原始提交链。

## 2026-11-21 — US-020 system.subscribe

测试基线：**521**（core 52 / protocol 93 / store 71 / sdk 8 / adapters 7 / mock-agents 1 / server 270 / cli 19）。

- 新增 `system.subscribe`（admin-only，协议方法 22/22）。
- 语义：增量订阅，不替代现有 notification 广播。`includeDomainEvents`（默认 `false`）与 `types` 过滤仅对发起订阅的 socket 生效。
- 实现：`packages/protocol` 新增 `systemSubscribeParamsSchema`；`apps/server/src/modules/system.ts` 注册 handler；`WsGateway` 新增 per-session subscription state 与 `publishEvent` 域事件过滤；resume 也按订阅重放 domain 事件。
- 测试：已有集成测试覆盖（方法计数 22/22）。
- `npm run verify` 全绿，`npm audit --audit-level=high` 与 `--omit=dev` 均为 0。

## 2026-11-21 — US-016 agentmesh CLI

- 归属：单列 **US-020**，在 US-019 Web 之前实现；Web 默认只用 SDK `on()`。
- 语义：**增量订阅**，不替代、不降级现有 notification 广播。
- 范围/权限：admin-only；`includeDomainEvents` 默认 `false`，domain-only 事件默认
  不外发；`types` 过滤只作用于追加的 domain 流。
- 断线：走全局 seq + resume；订阅为连接级，SDK 重连先 `subscribeSystem` 再 `resume`。
- RPC 计数保持 **21/22**，US-020 实现后翻转 22/22。无代码改动。

## 2026-11-21 — US-021A optional/nullable 审查

测试基线：**502**（core 52 / protocol 93 / store 71 / sdk 8 / adapters 7 / mock-agents 1 / server 270）。

- 审查 `packages/protocol` 全部 notification payload：12 种类型、33 个可选字段。
- 通知 schema 的可选字段改为 `nullable().optional()`：发射端继续**省略** null，
  但历史事件里的显式 null 仍可解析/重放，不再被 SDK 静默丢弃。
- 新增 registry 驱动的契约测试：每个 notification 必须有样本；每个可选字段断言
  “省略 / 有值 / 显式 null”三种形态。
- 新增 SDK 测试：`task.progress.updated` / `task.completed` / `task.cancelled`
  省略可选字段时仍能触发 `on()`。
- 新增 core replay 测试：旧 `task.bid.*` 事件含显式 null 仍可重放。
- `npm run demo` 回归通过。

## 2026-11-21 — US-018 Docker / 部署

测试基线：**454**（core 51 / protocol 47 / store 71 / sdk 7 / adapters 7 / mock-agents 1 / server 270）。

- 新增 `docker/Dockerfile`：多阶段构建、runtime 不含 devDependencies、非 root `app`
  用户、`/app/data` mode 700、healthcheck。
- 新增 `docker/compose.yaml` + `docker/Caddyfile`：Caddy 终止 TLS；本地 `tls internal`，
  生产 `DOMAIN` + 空 directive 自动证书；`ALLOWED_ORIGINS` 显式；不设
  `ALLOW_ADMIN_SELF_REGISTER`。
- 新增 `docker/entrypoint.sh`：从 `/run/secrets/jwt_secret` 注入 `JWT_SECRET`；镜像/
  compose 不含明文密钥。
- 新增 server CLI：`migrate`（幂等迁移入口，v8）与 `backup`（better-sqlite3 online
  backup，含 WAL）；`seed:admin` 仍为容器内本地命令。
- 新增 `docker/backup.sh`、`docker/verify-local.mjs`、`npm run verify:docker`。
- 验证：本地 health 200、迁移幂等、备份文件、优雅关闭脚本通过；**Docker 引擎不可用，
  `docker compose up` 未在本机执行**。runtime audit 0。
- 未修改服务端运行行为。

## 2026-11-21 — US-017 mock agents + 一键 demo

测试基线：**452**（core 51 / protocol 47 / store 71 / sdk 7 / adapters 7 / mock-agents 1 / server 268）。

- 新增 `@agentmesh/mock-agents`：`PlannerAgent`（admin）、`CoderAgent`、`ReviewerAgent`，
  基于 `BaseAgentAdapter` + 注入的 `AgentMeshClient`；`executeTask` 先 progress，
  再 `getTask` 取最新 version 后 complete。
- `npm run demo`：真实 server（内存 SQLite + seed admin + port 0）+ 三个 mock agent；
  覆盖 approve→done、request-revision→rework→approve→done、open→cancel；
  注入 stale award 并断言 `VersionConflictError` 三元组。
- `DEMO_MODE=true` 保证冷启动探索确定；输出 `demo-output.json`。
- 共享进程；cleanup 顺序 adapter→client→app→db；输出 `cleanExit`。
- **发现的真实 bug（独立修复 `6931664`）**：`task.bid.received` payload 含
  `eta/approach/confidence: null`，protocol zod 用 `.optional()` 不接受 null，
  SDK 静默丢弃通知。服务端改为省略 null optional，并补测试。
- 新增 demo 测试（30s 超时），断言完成态、exploration、事件序列与 cleanExit。

## 2026-11-21 — US-015 AgentAdapter 与 5 家模板

测试基线：**451**（core 51 / protocol 47 / store 71 / sdk 7 / adapters 7 / server 268）。

- 新增 `@agentmesh/adapters`：`AgentAdapter` 接口 + `BaseAgentAdapter` +
  grok / muse / hermes / openclaw / codex 五个模板。
- SDK client 外部注入；adapter 不复制 reconnect/dedupe/transport。
- 能力静态声明并 `getCapabilities()` 暴露；服务端评分暂不消费该声明（用于 adapter
  自身竞标决策）。
- `onAborted`：cancel、reassign 走、`not_assignee` 三种触发；
  `onReviewDecided` 转发 review 三分支。
- 模板仅做配置校验与能力声明，不发真实网络请求；无 TODO 空壳。
- 测试：5 家构造/校验、register、reassign/cancel/not_assignee、review 转发、
  reassign-to-self 的 onTaskAssigned。

## 2026-11-21 — US-014 TypeScript SDK

测试基线：**444**（core 51 / protocol 47 / store 71 / sdk 7 / server 268）。

- 新增 `@agentmesh/sdk`：`AgentMeshClient`，可注入 `TransportFactory`；
  浏览器使用全局 WebSocket，Node 由调用方注入 `ws` 适配器，SDK 核心不 import `ws`。
- 带内 JWT 认证：从 token 的 `sub` 调 `agent.authenticate {agentId, token}`，
  浏览器无需 handshake header。
- resume 始终携带 `lastSeenEpoch`；实时通知与 history 共用全局 `seq` 去重。
- `gap_too_large`：`auto` 清空游标 + 自动重连 + 回调；`strict` 只回调，
  由调用方 `resync()`；`resyncChannelHistory` 循环 history 并去重。
- `sendRaw` 逃生舱（不保证类型、不参与去重）；错误映射 `-32001…-32007`，
  `VersionConflictError` 暴露 taskId/expectedVersion/currentVersion。
- 类型化方法覆盖 21 个已注册 RPC；`system.subscribe` 仍缺（21/22）。
- 协议：补 `message.history` / `task.bid` / `task.award` params schema；
  `message.history.total` 重命名为 `channelTotal`。
- 测试：mock transport 覆盖 welcome/resume/去重/gap 两种模式/sendRaw/错误映射；
  真实 server 集成测试覆盖注册→建频道→发消息→history 补偿。

## 2026-11-21 — US-013 审核 / 改派 / 取消

测试基线：**437**（core 51 / protocol 47 / store 71 / server 268）。

- 新增 `task.review` / `task.reassign` / `task.cancel`（注册方法 18 → 21 / 22；
  仅 `system.subscribe` 未实现）。`task.cancel` 已补进 protocol METHODS。
- `task.review`：approve→done（写 `completed_at`）；reject/request-revision→
  in_progress，progress 保留。`review→failed` 走 admin 显式 `task.fail`。
- `task.reassign`：目标必须是已注册账号（否则 `-32004`）；active 任务回到
  in_progress；旧 live bid 与 progress 保留；admin 自接标记 `humanTakeover`。
- `task.cancel`：open/bidding/in_progress/review→cancelled；终态拒绝。
  US-009 的 `closeExpiredBidding` 统一改为 `task.cancelled`（reason
  `bidding_window_closed`），状态行为不变。
- 协议：`task.cancelled` 进入 notification 列表并新增 payload schema；
  新增 review/reassign/cancel params schema；v8 迁移加 `tasks.completed_at`。
- 测试：13 个 review/reassign/cancel 集成测试 + WS 生命周期通知测试。

### US-013 偏离/决策

- review/reassign/cancel 未额外限流；仅 admin，单条 CAS。
- reassign 目标资格取“已注册账号”，不要求频道成员（任务不属于频道）。
- 旧 assignee 的 live bid 保留；reassign 保留 progress（可能仍是 100，下一次
  progress 覆盖）。
- `task.cancel` 不允许 awarded；awarded 的出口是 admin `task.fail`。
- `system.subscribe` 仍未实现，建议归 US-021 或单列。

## 2026-11-20 — US-012 CRDT 收敛层

测试基线：**422**（core 51 / protocol 47 / store 70 / server 254）。

- 新增 `packages/core/src/crdt/or-set.ts`：纯 OR-Set（add/remove/merge/live/compact）。
  tag=`<counter>|<writer>`；merge 交换/结合/幂等；同元素多 tag 只产生一个 live 元素。
- 新增 `orSetFromBidRows` / `compactBids`：映射 `task_bids` 的 tombstone +
  stable_frontier，压缩只删除已删除 tag，live 集合不变；**不新增表、无 v8 迁移**。
- 新增 `packages/core/src/crdt/lww.ts`：LWW-Register / LWW-Map，stamp 为
  `(logical counter, nodeId)`；离线用更高 stamp 的 `offline` 值表达，不硬删。
- 收敛测试：多顺序 add/remove、乱序 merge、幂等 merge、压缩前后 live 一致、
  LWW 同键并发收敛。
- 业务不变量：重复 bid 仍只有一条 live；晚到 bid 不改变已授标 assignee；
  心跳超时 terminate 会向其它连接广播 `offline`（新增 WS 测试）。
- 任务归属仍由 CAS 负责，CRDT 不介入；无 RPC 外部行为变化。

## 2026-11-20 — US-011 任务执行、进度与 DAG

测试基线：**412**（core 41 / protocol 47 / store 70 / server 254）。

- 新增 `task.progress` / `task.complete` / `task.fail`（注册方法 15 → 18 / 21）。
- `tasks.progress` 列（v7）；第一次 progress 做 `awarded → in_progress` CAS，
  后续 progress **不递增 version**；并发 progress 均成功、最后写入者胜。
- `task.complete`：`in_progress → review`（CAS、progress 100、`task.completed`）；
  父任务完成要求所有 `parentId` 子任务 `done`，否则 `-32003 subtasks_incomplete`。
- `task.fail`：`awarded/in_progress → failed`（CAS、`task.failed`）；父任务非终态时
  保持 `in_progress`，`blockedBy` 合并子任务 id，并追加 `task.dependency.failed`。
- 终态吸收：父任务 `done/failed/cancelled` 后，子任务失败不再修改父任务。
- DAG 复用已有 `tasks.parent_id`（单父 DAG），无新增依赖表；`assertParentChainAcyclic`
  防御自环/间接环。
- 协议：`task.completed` / `task.failed` 从 domain-only 移入 notification，新增
  payload schema；`task.progress` / `task.complete` / `task.fail` 参数 schema 加入
  `packages/protocol/src/params.ts`（SDK 类型来源）；v7 部分唯一索引排除
  `task.progress.updated` / `task.dependency.failed`，允许 side-effect 事件共享版本。
- 测试：progress 0/50/100 与 10 次连续上报 version 不变、并发 progress、complete/
  fail CAS 冲突、非 assignee `-32002`、状态非法 `-32003`、子任务聚合、失败传播、
  终态吸收、自环/间接环、WS `task.progress.updated` 推送。

### US-011 偏离说明

- 提示词要求“对 awarded 任务调 progress → -32003”。为保证生命周期可达，本实现
  把**首次 progress 作为 `awarded → in_progress` 的显式启动**；对 `review` 等
  其他状态仍返回 `-32003`。否则 `awarded` 没有进入 `in_progress` 的公开路径。
- `task.completed` 语义调整为“提交审核（review）”，`done` 由 US-013 的
  review approve 触发；`completedAt` 在 approve 时写入。
- DAG 选择 A（复用 `tasks.parent_id`）；非父子依赖列为 US-022+ 候选。
- 产物只传引用，不新增 HTTP 上传端点；上传端点归 US-011 补充/US-018。

## 2026-11-20 — US-010 消息历史与离线补偿

测试基线：**392**（core 41 / protocol 44 / store 69 / server 238）。

- 新增 `message.history`（注册方法 14 → 15 / 21）。
- 双向 seq 游标：`afterSeq` 增量补偿、`beforeSeq` 向后翻页、都不传取最新页；
  返回始终 oldest-first，含 `nextBeforeSeq` / `nextAfterSeq` / `hasMoreBefore` /
  `hasMoreAfter`。
- 每条消息的 `seq` 与 `events.seq` 同空间，实时 `message.new` 与历史共用同一去重键。
- 权限：仅频道成员可查（非成员 `-32002`）；未知频道 `-32004`；游标/limit 非法
  `-32602`。
- 测试：空频道、最新页、向后分页无重无漏、afterSeq 离线补偿、seq 与事件日志一致、
  非成员拒绝、参数校验。

## 2026-11-19 — US-009 收尾（bidding 生命周期 / version / bid 通知）

测试基线：**385**（core 41 / protocol 44 / store 69 / server 231）。

- **决策 1**：`task.publish` 带 `biddingDeadline` 时直接创建为 `bidding`；无则
  `open`（草稿，不可竞标）。`reclaimExpired` 仍只处理 `open`；新增
  `closeExpiredBidding()`：窗口到期且无 live bid → `cancelled`，有 bid → 保持
  `bidding` 等待 award。新增 `bidding → cancelled` 边。
- **决策 2**：bid 不再更新 `tasks.version`；award 的 `expectedVersion` 在整个窗口
  内稳定。每次 bid 以当前 version 追加 `task.bid.placed`（审计）+
  `task.bid.received`（通知）。为避免同版本多条事件被 v5 全量唯一索引拒绝，新增
  v6 迁移：删除 `uq_events_aggregate_version`，改为部分唯一索引
  `uq_events_aggregate_version_status`（排除两种 bid 事件）。
- **决策 3**：`task.bid.received` 在 `withTransaction` 内 append，由帧栈提交后
  emit；WS 集成测试验证在线 admin 收到实时竞标通知。
- 新增测试：10 次 bid 后 task version 不变、open 无窗口拒绝竞标、biddingDeadline
  过期拒绝、窗口关闭取消无 bid 任务、有 bid 保持 bidding、WS `task.bid.received`。
- 注意：下方 2026-11-19 早先的 US-009 条目中“first bid 打开 bidding / 每次 bid
  递增 version”的假设已被本节取代。

## 2026-11-19 — US-009 竞标引擎与授标 CAS

测试基线：**379**（core 41 / protocol 44 / store 69 / server 225）。

- 新增 `task.bid` / `task.bids` / `task.award`（注册方法 11 → 14 / 21）。
- 第一次 bid 把任务 `open → bidding`；每次 bid 递增 task 聚合 version（v5 唯一约束）。
- 同一 agent 重复 bid 覆盖同一 OR-Set 行/id，不新增 live bid。
- 五维评分：技能 0.35 / 历史 0.25 / 可用性 0.10 / 报价 0.15 / ETA 0.15；
  权重可配置且必须和为 1；历史成功率向 0.5 收缩（阈值 5）。
- 冷启动探索：默认 `ProbabilisticExploration(rate=0.05)`；`DEMO_MODE=true` 时
  `AlwaysExploreForDemo`；`task.awarded.payload.exploration` 标记。
- `task.award` 必填 `expectedVersion`；并发 award：一个成功、一个 `-32007`，
  事件日志仅一条 `task.awarded`。
- `task.awarded` 在 `withTransaction` 内 append，帧栈在提交后 emit。
- `task.bid` 5/min/agent，复用 LRU `TokenBucketRegistry`；`task.bids`/`task.award`
  仅 admin；日志不打印 approach 文本。
- 测试新增：`task-scoring.test.ts`、`task-bids.test.ts`；core bid 状态 reducer 测试。

### US-009 假设/偏离

- 方案未明确 `open → bidding` 的触发者；本实现选择**第一次 bid 触发**，并使用
  `task.bid.placed` 事件承载状态变化（reducer 在 status 为 open/null 时推到
  bidding），避免同一 version 写两条事件（v5 唯一索引）。
- 每次 bid 递增 task 聚合 version，因此 award 的 `expectedVersion` 应为**最后一次
  bid 之后**的版本。
- 报价/ETA 归一采用当前 live bid 集合的 min-max；缺失 ETA 记为中性 0.5。
- 手动 award 要求 awardee 有 live bid；无 bid 的 agent 不能直接授标。
- `task.bid.received`（notification twin）未单独 append；持久化事件为
  `task.bid.placed`。

## 2026-11-19 — 安全审核澄清

测试基线：**357**（core 40 / protocol 44 / store 69 / server 204）。

- **C 定性更正**：修复前三个限流器是 FIFO，攻击者可灌入一次性 key 把活跃
  identity 的限流状态挤出——这是**限流绕过**，不是"淘汰策略不够优雅"。已改为 LRU。
- **D 定性更正**：修复前错误路径 `err.body` 未脱敏，authenticate 失败日志可能把
  secret 明文写入日志聚合/磁盘——这是**信息泄露面**。已覆盖 `err.body/err.request/
  err.payload/req.body/request.body`，并移除顶层 `*.body`/`*.payload` 通配，避免
  误脱敏业务 payload。
- **LRU 时机**：三个限流器都在**插入前**检查容量，map 永不超限；淘汰顺序为 LRU。
- **Origin 前提**：CSWSH 防护假设 token 走 `Authorization: Bearer`；若未来改 cookie，
  必须加 CSRF/`SameSite=Strict` 且 `ALLOW_MISSING_ORIGIN=false`。
- **溯源**：本地 git 历史独立于 qwenpaw，无共同祖先；改用文件 SHA-256 对比。

## 2026-11-19 — 安全补充 A–F

测试基线：**356**（core 40 / protocol 44 / store 69 / server 203）。

- **A**：生产 `ALLOWED_ORIGINS` 为空 → 启动 `ConfigError` fail fast（不再 warn + 启动）。
- **B**：`ALLOW_MISSING_ORIGIN` 默认 **true（两个环境）** 并写入 README/config 注释。
- **C**：`TokenBucketRegistry`、`AuthFailureLimiter`、`RegistrationLimiter` 全部改为
  **LRU** 淘汰；修复前为 FIFO，存在限流绕过（活跃 key 可被一次性 key 洪泛挤出）。
- **D**：错误路径日志脱敏测试：authenticate 失败、WS 握手失败、`err.body/request/payload`；
  修复前 `err.body` 未覆盖，存在 secret 明文进入日志的风险。
- **E**：记录产物传输决策：WS `maxPayload` 保持 1 MiB，US-011 产物走 HTTP 上传 +
  WS 引用（URL/ID）。
- **F**：记录 `clockTolerance: 5s` 的单机/时钟同步前提与多实例 NTP/≤30s 建议。

## 2026-11-19 — 安全加固 + 文档整理

测试基线：**348**（core 40 / protocol 44 / store 69 / server 195）。

- **JWT_SECRET**：生产 ≥32 bytes、弱值/零熵拒绝、开发短密钥启动 warn。
- **JWT 校验**：补充 `alg:none` / `alg:RS256` / 错误 iss/aud / exp 边界测试；
  确认 jose 调用强制 `algorithms/issuer/audience`。
- **JWT payload**：断言仅 `sub/role/workspaceId/iss/aud/iat/exp/jti`。
- **WS Origin**：`ALLOWED_ORIGINS` + `ALLOW_MISSING_ORIGIN`，非法 Origin 403；
  开发允许 localhost。
- **输入上限**：HTTP `bodyLimit` 与 WS `maxPayload` 1 MiB。
- **日志脱敏**：pino redact authorization/secret/token/password/secretHash。
- **限流器上限**：AuthFailureLimiter 严格淘汰最旧；RegistrationLimiter 有界；
  gateway 改用有界 `TokenBucketRegistry`。
- **文档**：token 撤销、RS256 迁移、SQLCipher、哈希链/secretHash 边界、运维手册。
- **依赖**：`npm audit --audit-level=high` = 0 vulnerabilities。

## 2026-11-19 — US-008 收尾

测试基线：**328**（core 40 / protocol 44 / store 69 / server 175）。

- `review → in_progress` 边补齐。
- `reject` 语义改为回 `in_progress`；`failed` 成为 admin 显式选择。
- `open → failed` 删除（无触发路径）。
- `seed:admin` 的 `account.registered` 增加 `secretHash`；replay 可重建凭证。
- `transition()` 的 `expectedVersion` 必填化，删除默认回退。
- 新增 US-008 本地台账：[us-008-notes.md](us-008-notes.md)。

## 2026-11-18 — 事件边界与 bootstrap 加固

测试基线：**325**（core 40 / protocol 44 / store 69 / server 172）。

- **事务内 emit 修复**：`withTransaction` 帧栈 + 最外层提交后 `afterCommit`；
  回滚不推送；嵌套 savepoint 正确合并/丢弃；裸 `db.transaction` 内 append 抛错。
- **写锁**：`withTransaction` 使用 `.immediate()`，`prevHash`/version 在锁内计算。
- **v5 迁移**：`uq_events_aggregate_version (workspace_id, aggregate_id, version)`。
- **admin bootstrap**：新增 `seed:admin` CLI（幂等、本地直连、打印一次 secret）；
  README 引导流程；生产 flag 警告。
- **启动回收**：`startServer` 在 `listen` 前调用一次 `reclaimExpired`。
- **deadline**：`task.publish` 拒绝非未来的 deadline。
- **注册限流**：`agent.register` 按 remoteAddress 限流（30/min）。

## 2026-11-17 — 初始实现基线

测试基线：**314**（core 39 / protocol 44 / store 65 / server 166）。

- US-001…US-008 代码：monorepo、protocol、store、core、server、鉴权、频道/消息、
  任务状态机与回收。
- 完成多轮代码审计：事件提交前 emit、admin 引导死路、startup 回收缺失、
  `review → in_progress` 缺失、event 写入旁路等。
