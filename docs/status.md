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
| US-017 | **完成（本地验证）** | `npm run demo`：三智能体完整链路、rework、cancel、-32007 |
| US-018 | **完成（本地等价验证）** | Docker/Caddy、migrate/backup CLI、health/关闭脚本 |
| US-016 | **完成（本地验证）** | `agentmesh` CLI：register/login/whoami、channel、message、task 全生命周期、watch、doctor；复用 SDK |
| US-019 | **完成（本地验证）** | Next.js 管理后台：admin-only，SSR 跳过 WS，全局 seq 去重，auto gap 策略，audit view，Playwright smoke 策略 |
| US-020 | **完成（本地验证）** | `system.subscribe`：admin opt-in domain events，per-session 订阅，RPC 22/22 |
| US-021B | **完成（本地验证，P1 已核实并修复空转 bug）** | 定时 compaction：OR-Set tombstone 清理，默认关闭，可配置间隔，优雅关闭清理；`verify:docker` 显式断言定时器 start/clear |
| US-021G | **完成（本地验证，e2e 未执行）** | Web 测试基线：单元 7 + 集成 4 纳入 verify；e2e 脚本就绪（供 M9 复用），因 npm arborist 缺陷 + 无浏览器未在本机执行 |
| US-021C | **完成（本地验证）** | 事件哈希链定期校验：分批 verify、启动一次 + 定时（默认 1h）、`/health.hashChain`、verify:docker 定时器断言 |
| US-021D | **完成（本地验证）** | token 撤销：`agent.revokeToken`（admin，23/23）、进程内 LRU + verify 校验、重启不保留（文档） |
| US-021E | **已锁死（2026-11-23）** | 多租户设计：workspace 一等公民、23 RPC 归属表、presence 隔离、拆 US-022…025 |
| US-021F | **评估完成：仍不做** | SQLCipher：现状/触发/成本/风险/复审条件已记 decisions.md |
| US-022 | **完成（本地验证）** | v9 多租户 schema：`workspaces` 表 + seed default；`channel_members` PK 加 workspace 维度；无回填；前向不可逆（先备份） |

测试基线：**575**
（core 55 / protocol 109 / store **74** / sdk 9 / adapters 7 / mock-agents 1 / server 287 / cli 22 / **web 11**）。
schema 版本：**v9**（US-022 多租户 schema）。

> CI（2026-11-23）：GitHub Actions `verify` + `web-e2e`（真实登录→频道→发消息）+ `docker`
> （Linux SIGTERM 定时器清理）全绿；`audit-cron` 定时跑。CI 暴露并修复了 4 个真实缺陷
> （构建顺序、CLI `-` 开头参数、Web 登录 stale client、isAdmin 未置位），详见 changelog。

> US-021D token 撤销（2026-11-23）：`agent.revokeToken`（admin-only，23/23）；进程内 LRU
> 撤销表 + `TokenService.verify` 校验（-32001，不泄露）；重启后撤销不保留（文档说明）。
> SDK 新增 `revokeToken({targetToken})` 类型化方法（字段名避开 SDK 保留的 `params.token`）。

> US-021C 事件哈希链校验（2026-11-23）：`verifyEventChainBatched` + `EventStore.verifyChain()`（分批、
> 返回 seq+aggregateId）；server 启动一次 + 定时（默认 1h）；`/health.hashChain`；`verify:docker`
> 断言 `hashChainTimerStarted/Cleared`。

> US-021G Web 测试基线（2026-11-23）：web `test` 改为 `vitest run` 纳入根 verify（单元 7 + 集成 4）；
> e2e 脚本已就绪（BASE_URL 参数化，供 M9 复用）但未在本机执行（npm arborist 缺陷 + 无浏览器/栈）。

> US-021B P1 覆盖率核实（2026-11-23）：`domain-event-payload.test.ts` **12→16**、`tasks.compaction.test.ts`
> **7→8**（含真实压缩/定时器断言）。sdk 的“8”是历史误计（自 US-020 起为 9）。核实中发现并修复两个
> 使定时 compaction 完全空转的缺陷（`runCompaction` 用哨兵 task id、`compactTaskBids` 的 frontier
> 恒不变），见 changelog 2026-11-23。

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

## 已实现的 RPC（23 / 23）

| 分组 | 方法 |
| --- | --- |
| agent | `agent.register` / `agent.authenticate` / `agent.list` / `agent.revokeToken`（US-021D，admin） |
| channel | `channel.create` / `channel.join` / `channel.leave` / `channel.list` |
| message | `message.send` / `message.history` |
| task | `task.publish` / `task.list` / `task.get` / `task.bid` / `task.bids` / `task.award` / `task.progress` / `task.complete` / `task.fail` / `task.review` / `task.reassign` / `task.cancel` |
| system | `system.subscribe`（US-020，admin） |

全部 23 个协议方法均已注册（无 `-32601`）。

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
- 类型化方法覆盖当前 **23** 个已注册 RPC（含 US-021D `agent.revokeToken`）；无未实现项。
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

US-017 的关键语义：

- `npm run demo` 起真实 server（内存 SQLite、seed admin、ephemeral port）+ 4 个 SDK client
  （planner/admin + coder + reviewer）。
- 覆盖：approve→done、request-revision→rework→approve→done、open→cancelled；
  含一次 stale award 的 `-32007`（断言 taskId/expectedVersion/currentVersion）。
- **DEMO_MODE=true** 强制冷启动探索；两次 award 均 `exploration: true`。
- 共享进程；cleanup 顺序 adapter.close → client.close → app.close → db.close；
  输出 `cleanExit`。
- demo 发现并修复了一个服务端 bug：`task.bid.received` 的 null optional 字段会让
  SDK 的 zod 解析失败并静默丢通知；已改为省略 null optional（`6931664`）。
- `demo-output.json` 含 tasks / awards / eventTypes / eventSeqs / versionConflict。

US-018 的关键语义：

- Dockerfile 多阶段、非 root `app` 用户、`/app/data` mode 700；runtime 不含 devDependencies。
- 迁移：启动自动迁移 + 独立 `npm run migrate --workspace @agentmesh/server`；
  v8 幂等。
- 密钥：Docker secret `/run/secrets/jwt_secret` → entrypoint 注入 `JWT_SECRET`；
  镜像/compose 不含明文。
- TLS：Caddy 终止；本地 `tls internal`，生产 `DOMAIN` + 空 `CADDY_TLS_DIRECTIVE`
  自动证书；`ALLOWED_ORIGINS` 显式。
- 备份：`agentmesh-backup`（better-sqlite3 online backup，含 WAL）；恢复需停服替换 DB。
- admin：`docker compose exec server node .../seed-admin.js`。
- 本地等价验证 `npm run verify:docker` 通过 health/migrate/backup；**Docker 引擎不可用，
  `docker compose up` 未在本机执行**。M9 的 compose 运行时验证待具备 Docker 的环境。

## 已知缺口 / 技术债

| 项 | 归属 | 影响 |
| --- | --- | --- |
| `system.subscribe` | **US-020 完成** | admin opt-in domain-only 事件；现有 notification 广播不变；Web 默认只用 SDK `on()` |
| 多租户：schema 已 v9（US-022）；RPC 鉴权/登记/presence 仍固定 default | US-023…025 | 需 US-023 让 RPC 从 token 取 workspace、US-024 presence 分片；迁移前向不可逆须先备份 |
| 哈希链无外部锚定（US-021C 已可定期校验） | US-022+ | 链尾篡改不可检测；运行时已能告警 mismatch |
| token 撤销无持久化（US-021D 完成，仅进程内） | **已决策：保持进程内（2026-11-23）** | 重启后已撤销 token 在 `exp` 前复活；复审条件（多实例/合规/多租户）见 decisions.md |
| SQLite 明文（US-021F 复核：仍不做，复审条件已记） | US-022+ | 依赖 OS/卷加密；触发条件见 decisions.md |
| CLI/Web 为空 | US-016/019 | 客户端工具与 Web 后台未落地 |

## 下一步

1. **US-016 CLI**：复用 SDK；配置/profile、history 游标、-32007/-32005 UX。
2. **US-020 `system.subscribe`**（归属与语义已定，见 decisions.md），完成后 RPC 22/22。
3. **US-019…US-021 Web**（必须复用 SDK；默认只用 `on()`）。
4. **M9 compose 验证**：在具备 Docker 的环境执行 `docker compose up`，确认 `/health` 200
   与 SIGTERM 优雅关闭后，再把 M9 标记为完全达成。

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

