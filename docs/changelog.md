# 变更记录

本记录从本地工作树开始，不包含 qwenpaw 容器侧的原始提交链。

## 2026-11-23 — US-021C 事件哈希链定期校验 + 告警

测试基线：**564**（core 55 / protocol 109 / store 71 / sdk 9 / adapters 7 / mock-agents 1 / server 282 / cli 19 / web 11）。

- core：`verifyEventChainBatched(loadBatch, {batchSize})` + `EventStore.verifyChain()`：分批读，
  返回第一个不一致的 `seq`+`aggregateId`（大库不 OOM）。新增 3 条测试（正常 / 篡改 / 跨批边界）。
- server：新增 `HashChainMonitor`：启动时一次 + 定时（`HASH_CHAIN_VERIFY_INTERVAL_SECONDS` 默认 3600，
  0 关闭；`HASH_CHAIN_VERIFY_ON_STARTUP` 默认 true）。`/health` 增加 `hashChain: ok|mismatch|unchecked`，
  不暴露 payload/secret。定时器 `unref()` + `onClose` 清理，输出 `hashchain.timer.started/cleared`。
- 集成测试（4）：正常 ok + `/health`；篡改后 state 与 `/health` 变 `mismatch`（seq+aggregateId）；
  **定时器真的重校验**（tamper 后周期内 `/health` 变 mismatch）；interval=0 不启定时（启动校验仍跑）。
- `verify:docker` 新增 `hashChainTimerStarted` / `hashChainTimerCleared` 结构化日志断言（Windows n/a）。
- 故障注入自检：把定时器 tick 改成不调用 `runCheck` → “periodic timer actually re-verifies” 变红，恢复后全绿。
- 回归：`npm run verify` / `audit`×2 / `demo` / `verify:docker` 全过。

## 2026-11-23 — US-021G Web 测试基线

测试基线：**557**（core 52 / protocol 109 / store 71 / sdk 9 / adapters 7 / mock-agents 1 / server 278 / cli 19 / **web 11**）。

- Web `test` 脚本由占位 `echo` 改为 `vitest run`（node env），被根 `npm test --workspaces`
  自动包含，因此进入 `npm run verify` 门槛（US-021G 决策 2）。
- 单元（7）：`seq-registry`（US-019 决策 3 跨列表 seq 去重）、`admin-errors`（登录
  -32001/-32002 映射；-32007 展示 expected+current）。
- 集成（4，真实 SDK + mock transport）：live `message.new` 与 history 共享 seq 去重；
  断线重连后 resume 帧携带 `lastSeenEpoch`。
- 抽取纯函数 `apps/web/src/lib/admin-errors.ts`；登录/任务页改为调用（-32007 现在会展示
  `currentVersion`）。
- e2e：`apps/web/e2e/`（playwright config + smoke spec），`BASE_URL` +
  `ADMIN_AGENT_ID`/`ADMIN_SECRET` 参数化，供 M9 复用；不纳入 verify。
  **未在本机执行**：npm 11.20.0 arborist 缺陷导致 `@playwright/test` 安装失败，且无浏览器/运行栈；
  脚本与配置已就绪，M9 具备环境后按 README 执行。
- 故障注入自检：破坏 `markSeqSeen` 恒返回 true → 3 条测试变红，恢复后全绿。
- 回归：`npm run verify` / `audit`×2 / `demo` / `verify:docker` 全过。

## 2026-11-23 — US-021B P1 覆盖率核实 + 定时 compaction 修复

测试基线：**546**（core 52 / protocol 109 / store 71 / sdk 9 / adapters 7 / mock-agents 1 / server 278 / cli 19）。

这是 US-021B P1 测试补齐的**核实故事**（不改运行语义；发现的真实缺陷另起 `fix:`）。

### 6 点核实结论

1. **计数（最高优先级）**：报告“528（protocol +8, server +7）”为**误计**。实际（本故事开工前）为
   **541** = core 52 / protocol **105** / store 71 / sdk **9** / adapters 7 / mock-agents 1 / server
   **277** / cli 19。`domain-event-payload.test.ts` **确实被 vitest 收集并执行**（12 条全绿，可定位到
   用例名），因此不属于“文件未被收集”；偏差来源：protocol 实为 **+12**（非 +8），且 sdk 自 US-020
   起就是 **9**（旧基线“8”系历史误计）。回归后本故事再 +4（四态断言）+1（compaction 测试）= **546**。
2. **domain 事件清单**：`account.registered` / `account.authenticated` **确为 domain-only**
   （在 `DOMAIN_ONLY_EVENT_TYPES` 且不在 `NOTIFICATION_EVENT_TYPES`，且在 `domainEventPayloadSchemas`
   中）。报告无误划，**未改 schema**。发布点：register/seed→`accounts.ts:535/613`，authenticate→
   `accounts.ts:719`；`task.compaction.completed`→`tasks.ts` 定时回调。这些事件默认不广播，
   仅 admin `system.subscribe{includeDomainEvents}` 追加接收（US-020）。
3. **四态断言**：原测试仅覆盖“base 合法 + 可选字段 省略/有值/null 拒绝”，**缺**必填数值字段的
   缺失/null/负数/浮点/错类型拒绝。已补：`compactedTasks` / `totalRemoved` 五态拒绝、
   `errors` 非数组拒绝、`account.registered.name` 必填断言（`domain-event-payload.test.ts` 12→16）。
4. **`compactionTimerCleared` 断言方式**：核实发现原 `verify-local.mjs` 是
   `win32 ? true : exit.code===0 && !timeout`——纯**退出码推断（隐性验证）**，Windows 上硬编码 true。
   已重写为**日志显式断言**：server 以 `LOG_LEVEL=info` 启动、捕获 stdout/stderr、断言
   `task.compaction.timer.started` 与 `task.compaction.timer.cleared` 两条结构化日志；Windows 无 SIGTERM
   则如实记 **`"n/a"`**（operations.md 补了 Linux 手工步骤）。实测：
   `{"compactionTimerStarted":true,"compactionTimerCleared":"n/a","platform":"win32"}`。
5. **P2 语义锁定**：`errors` 与所有 domain 可选字段的“显式 null 被拒绝”已有**显式断言**；
   并在 `decisions.md` 新增「P2 — domain 事件可选字段风格」判定依据段落（`.optional()` vs
   `.nullable().optional()` 及被否决方案），可被引用。
6. **P3 默认关闭测试**：原 “interval=0 不启动 timer” 是**假测试**（`eventsReceived` 数组从未被填充，
   `expect([].length).toBe(0)` 恒真）。已替换为真实断言：`app.tasks.isCompactionTimerRunning()`
   在 interval=0 时为 `false`、>0 时为 `true`、关闭后为 `false`。

### 发现并修复的真实缺陷（`fix:` 提交）

两个缺陷叠加使**定时 compaction 完全空转**（`task.compaction.completed` 永不发出）：

- `runCompaction()` 用 `listByTask('', ...)` 试图取全部 bid —— SQL 是 `WHERE task_id = ''`，恒返回 0 行，
  即**永远没有待压缩任务**。改为新增 `TaskBidsDao.listTaskIds(workspaceId)` 枚举真实 task id。
- `compactTaskBids()` 用 `bidStableFrontier(rows)` 当“新 frontier”，但该函数只**读取**现有
  `stable_frontier` 列 → 新旧恒相等 → 恒 early-return 不压缩。改为把 frontier 推进到 tombstone 行的
  最大 counter（单写者 SQLite 下 tombstone 即稳定），只回收 `counter <= frontier` 的 tombstone，live 保留。

### 新增/强化测试与可观测性

- `tasks.compaction.test.ts` 重写为真实集成断言：tombstone 物理回收、live 保留、frontier 前进、
  幂等、空仓 no-op、定时 tick 真实写出 `task.compaction.completed`、config 关闭/开启接线、
  `startCompactionTimer/stopCompactionTimer` 生命周期。
- `TasksService` 新增 `isCompactionTimerRunning()`；`startCompactionTimer`/`stopCompactionTimer`
  输出 `task.compaction.timer.started` / `task.compaction.timer.cleared` 结构化日志。
- `app.ts` 把真实 logger 注入 tasks 模块（此前为空实现），使上述日志可用。

### 回归（四项全过 + verify:docker）

- `npm run verify` 全绿；`npm audit --audit-level=high` = 0；`npm audit --omit=dev --audit-level=high` = 0；
  `npm run demo` 退出码 0（cleanExit、-32007 冲突）；`npm run build -w @agentmesh/web` 通过；
  `npm run verify:docker` = `{"health":true,"gracefulShutdown":true,"migrate":true,"backup":true,
  "compactionTimerStarted":true,"compactionTimerCleared":"n/a","platform":"win32"}`。

## 2026-11-22 — US-021B 定时 compaction

测试基线：**521**（core 52 / protocol 93 / store 71 / sdk 8 / adapters 7 / mock-agents 1 / server 270 / cli 19）。

- 复用 US-012 的 `compactOrSet` / `compactBids` 纯函数。
- `apps/server/src/modules/tasks.ts` 新增：
  - `compactTaskBids(taskId)`：单任务 compaction，推进 `stableFrontier`，物理删除已过 frontier 的 tombstone。
  - `runCompaction()`：遍历所有有 bid 数据的任务，逐个 compaction。
  - `startCompactionTimer(intervalMs)` / `stopCompactionTimer()`：定时器管理。
  - compaction 完成后写 `task.compaction.completed` domain 事件（含 `compactedTasks` / `totalRemoved` / `errors`）。
- 配置：`TASK_BID_COMPACTION_INTERVAL_SECONDS` (默认 0 = 关闭)；`app.ts` 启动时按开关注册定时器，优雅关闭时清理（与 reclaim 定时器一致，纳入 verify:docker SIGTERM 验证）。
- 默认关闭，避免无谓开销；按需开启（如 `TASK_BID_COMPACTION_INTERVAL_SECONDS=3600`）。
- 测试：US-012 的 OR-Set compaction 测试已覆盖纯函数逻辑；server 层新增集成测试（见 tasks.test.ts）。
- `npm run verify` 全绿；`npm run demo` 退出码 0；`npm audit --omit=dev` 为 0；`npm run verify:docker` 通过。

## 2026-11-21 — US-019 Next.js 管理后台

测试基线：**521**（core 52 / protocol 93 / store 71 / sdk 8 / adapters 7 / mock-agents 1 / server 270 / cli 19 / web 0 —— Next.js 页面构建成功，无单元测试框架）。

- 新增 `apps/web`：Next.js 15 + React 19，复用 `@agentmesh/sdk` 传输层（SSR 跳过 WS，CSR `useEffect` 建立连接）。
- 页面：
  - `/login`：admin-only，带内认证 (`agent.authenticate`)。
  - `/dashboard`：概览统计卡片（频道/任务/智能体总数）。
  - `/dashboard/channels`：频道列表、创建/加入/离开、消息历史（双向 seq 游标）+ 实时 `message.new`，全局 seq 去重。
  - `/dashboard/tasks`：任务列表筛选/分页、发布、竞标、授标、进度、提交审核、审核决策、改派、取消；全部 CAS 操作要求 `expectedVersion`，-32007 显示 expected/current + 重试提示。
  - `/dashboard/events`：实时事件流（SDK `on()` 拼装 11 种 notification）、审计视图（`system.subscribe` + `includeDomainEvents`，admin-only），auto/strick gap 策略。
- `SeqRegistry`：同一 seq 跨列表只渲染一次（US-019 决策 3）。
- `gap_too_large`：默认 auto（toast 提示已重新同步），strict 可切换。
- 产物 >1 MiB 仅展示引用链接，不实现上传端点。
- 验证：Next.js 15 生产构建通过；`npm run verify` 全绿（typecheck + lint + test + demo + audit）。
- 已知：`npm audit --omit=dev` 发现 Next.js 15 依赖的 postcss 2 个漏洞（待 Next.js 16 修复），不阻塞 MVP。

## 2026-11-21 — Audit 基线破口修复（US-019 引入的 postcss 漏洞）

- **背景**：US-019 引入 Next.js 15 后，`npm audit --omit=dev --audit-level=high` 出现 2 个漏洞
  （来自 Next.js 传递依赖的 postcss <=8.5.22，GHSA-qx2v-qp2m-jg93 等 4 个 CVE，
  1 high + 1 moderate）。之前基线是 --omit=dev 为 0，这是"可交付 MVP"的新阻断项。

- **可达性分析**：PostCSS 在 Next.js **构建时**运行（CSS 处理、source map 生成），
  不在运行时容器/浏览器代码路径上。攻击面仅限 CI 构建机器或本地构建时。
  容器运行时不包含 postcss。结论：不可达生产运行时，但构建环境需修复。

- **4 个决策**：
  1. 修复路径：使用 npm overrides 强制 postcss >=8.5.33（当前最新修复版）。
     被否决：升级 Next.js 16（破坏性变更未知）；接受并记录（破坏基线原则不可接受）。
  2. Web 纳入 verify 门槛：是。`verify` 脚本扩展为 `build -w @agentmesh/web && audit --omit=dev -w @agentmesh/web`。
  3. 不接受"记录风险"方案：必须修复恢复 0 漏洞。
  4. devDependencies audit 门槛：暂不收口。

- **实现**：
  - 根 `package.json` + `apps/web/package.json` 添加 `overrides: { postcss: "8.5.33" }`。
  - 根 `verify` 脚本扩展：`npm run build -w @agentmesh/web && npm run audit --omit=dev -w @agentmesh/web`。
  - Web `package.json` 新增 `audit` 脚本：`npm audit --omit=dev --audit-level=high`。
  - `overrides` 处加注释说明原因与移除条件（Next.js 16 发布后移除）。

- **验证**：`npm audit --omit=dev --audit-level=high` 恢复为 **0 vulnerabilities**；
  `npm run verify` 全绿（含 Web 构建 + audit）；`npm run demo` 退出码 0。

## 2026-11-21 — US-020 system.subscribe

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
