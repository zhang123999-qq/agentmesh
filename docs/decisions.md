# 已锁死决策

这些决策经过多轮审计，不再重新打开；变更需要单独的设计评审。

## 架构

| 决策 | 理由 |
| --- | --- |
| `seq` 全局单调递增、全局唯一（events AUTOINCREMENT） | 单机 SQLite 下 per-aggregate 无收益；resume 只需一个数字 |
| 任务归属 = 乐观并发 CAS（`expectedVersion` + `-32007`） | 不静默覆盖并发授标 |
| CRDT 只用于 presence（LWW-Register）与竞标集合（OR-Set） | 归属已移出，收窄复杂度 |
| Web 端复用 `packages/sdk` 传输层 | 避免两套 epoch/去重语义分叉 |
| 自动授标由 admin 触发（`strategy:'auto'`），非定时任务 | 定时任务的 expectedVersion 语义空白 |
| MVP 不引入 `blocked` 状态 | 子任务失败走 `blockedBy` + 人工兜底 |
| 事件推送只在 `withTransaction` 最外层提交后 emit | 防幽灵推送 + seq 复用导致真事件被去重丢掉 |
| WS `maxPayload` 保持 1 MiB | 产物走 HTTP 上传 + WS 引用，不靠调大帧上限 |
| 限流器上限采用 LRU | 活跃 agent/identity 的限流状态不会被一次性 key 洪泛挤掉 |
| progress 不递增 `tasks.version` | 第一次 progress 启动 `awarded → in_progress`，之后原地更新，避免 complete/fail 的 CAS 被高频进度挤掉 |
| `task.complete` 进入 `review` | `done` 由审核 approve 触发；`completedAt` 在 approve 时写入 |
| 子任务 DAG 使用 `tasks.parent_id` | MVP 单父 DAG；非父子依赖是 US-022+ 候选 |
| OR-Set 用 tag + stableFrontier 压缩 | 压缩只清理已删除 tag，live add tag 永不删除，保证压缩前后 live 集合一致 |
| LWW 使用 (logical counter, nodeId) | 物理时钟不能跨节点做唯一 tie-break；离线用更高 stamp 的 offline 值，不硬删 |

## US-016 agentmesh CLI（5 个决策）

1. **binary 组织**：单个 `agentmesh` binary + 多子命令（register/login/channel/
   message/task/doctor/watch）。`migrate` / `backup` / `seed:admin` **保留**在
   `@agentmesh/server`，不并入 `agentmesh admin ...`。理由：它们直连 SQLite
   （`better-sqlite3` 原生依赖），而 CLI 会装在各 agent 机器上，只应依赖
   SDK + `ws`；合并会把原生模块和部署版本耦合进客户端。
2. **watch**：支持 `agentmesh task watch <taskId>`，用 SDK `on()` 打印该任务的
   通知事件；Ctrl+C 退出，不自动判定终态（状态语义只属于服务端）。用可注入
   watch client 的单元测试断言打印内容。
3. **配置优先级**：`--flag` > 环境变量（`AGENTMESH_URL` / `AGENTMESH_PROFILE` /
   `AGENTMESH_HOME`）> profile 文件 > 默认文件。位置：默认
   `$AGENTMESH_HOME/config.json`，profile 为 `$AGENTMESH_HOME/profiles/<name>.json`，
   `AGENTMESH_HOME` 默认 `~/.agentmesh`；目录 0700、文件 0600（Windows 尽力而为）。
   **account secret 不写配置、不读环境变量**：`login` 用它换 token 后立即丢弃。
   token 可存 profile 文件（0600）或由 `--token` 显式传入。
4. **-32007 UX**：CAS 命令（award/complete/fail/review/reassign/cancel）**必须**
   显式传 `--expected-version`；不自动重试、不读后写。冲突时打印
   `taskId / expected / current` 与建议命令（先 `task get` 再用 current 重试），
   退出码 1。
5. **doctor**：提供 `agentmesh doctor`：解析配置、检查 token 存在与 `exp`、
   连接并等待 welcome（协议版本由 SDK 校验）、发一次只读 RPC（`channel.list`）。
   任一失败退出码 1，全部通过打印 PASS；测试覆盖成功、过期 token、不可达 URL。

## system.subscribe 归属与语义（US-019 前置决策）

**结论：单列 US-020，在 US-019 Web 之前实现；Web 默认只用 SDK `on()`，
只有审计视图才用 `subscribeSystem`。**

1. **归属**：单列 **US-020**。Web 不被协议变更拖住，22/22 的翻转有独立里程碑与
   独立提交，决策与实现分离，失败可单独回滚。
   被否决：并入 US-019（协议 + UI 同一提交，无法单独验证 22/22）；
   不实现（22/22 永远缺一项，SDK 类型面不完整）。
2. **语义**：**增量订阅，不是替代**。现有 notification 继续广播给 workspace 内所有
   已认证 socket；`system.subscribe` 只**追加**当前 socket 的订阅：可选
   `includeDomainEvents`（默认 `false`）与 `types` 过滤。`on(type)` 仍是 SDK 一等
   入口；`subscribeSystem(opts)` 只是薄封装（发 RPC + 复用同一本地分发）。
   被否决：替代式订阅（会把现有广播降级为“订阅者才收”，破坏 US-017 demo 与
   Web 实时性）；另造一套通知信封（与 `eventPayloadSchemas` 重复）。
3. **范围**：默认**不含** domain-only 事件。`includeDomainEvents: true` 需 admin；
   理由：`task.bid.placed`、`message.created` 等是投影输入，含内部字段（如
   approach 文本），默认外发会扩大泄露面。`types` 过滤只作用于追加的 domain 流，
   notification 广播不受它影响。
4. **权限**：admin-only。矩阵：

   | 调用者 | `system.subscribe` | `includeDomainEvents` |
   | --- | --- | --- |
   | 未认证 | `-32001` | — |
   | agent | `-32002` | — |
   | admin | 允许 | 允许（显式 true/false） |

   与现有 workspace 广播的关系：广播不变；订阅只增不减，且仅影响发起订阅的 socket。
5. **断线与补偿**：**走全局 seq + resume**，不新增游标。订阅状态是连接级；
   SDK 重连时先发 `system.subscribe` 再发 `resume`，服务端对已订阅 socket 的 replay
   也包含 domain 事件（按其 `types` 过滤）；去重键与 `on()` 共用 `seq` 与
   `WsSession.markSent`，live push 与 replay 不会重复。未重新订阅的新连接不会收到
   domain 事件，也不做“半程补偿”。
6. **不改变现有通知行为**：`publishEvent` 的 workspace 广播与
   `publishEventToAgents` 的频道扇出保持原样；`system.subscribe` 不引入“取消订阅”
   状态，不修改 `isNotificationEventType` 的默认判定。US-017 demo 与 US-019 Web 的
   实时路径因此不受影响。

实现约束留给 US-020（不在本决策内开工）：协议参数 schema、dispatcher handler、
gateway 的 per-session 订阅标记、resume 的 domain replay、SDK `subscribeSystem`；
若新增 notification 类型，按 US-021A 基准补 registry 样本与契约测试。

## Protocol optional vs nullable 基准（US-021A）

1. **通知 payload**：可选字段由发射端**省略**；schema 使用
   `.nullable().optional()`，因此“省略 / 有值 / 显式 null”三种历史形态都能解析。
2. **请求 params**：保持各自语义；只有确实需要 null 的字段才允许显式 null。
3. **历史兼容**：不迁移旧事件；reducer 继续宽容读取；SDK 不再因 null optional
   丢弃通知。
4. **契约测试**：registry 驱动，覆盖 `eventPayloadSchemas` 的每个 notification；
   新增 notification 未加样本会直接测试失败。



## US-018 Docker 部署（5 个决策）

1. **迁移入口**：双通道——服务启动自动迁移（现状，`openStore`）+ 独立
   `migrate` CLI；两者都幂等，v8 在已有库上安全执行。
2. **密钥注入**：Docker secret 文件 `/run/secrets/jwt_secret`，entrypoint 读入
   `JWT_SECRET`；不写入镜像、compose 或日志。
3. **TLS 反代**：Caddy。本地默认 `tls internal`；生产设置 `DOMAIN` 并清空
   `CADDY_TLS_DIRECTIVE` 以自动签发证书。`ALLOWED_ORIGINS` 必须显式且匹配。
4. **数据/备份**：命名卷 `/app/data` mode 700；`backup` CLI 用 better-sqlite3
   online backup（含 WAL）；恢复需停服替换 DB。
5. **admin 引导**：`docker compose exec server node .../seed-admin.js`；不暴露 RPC，
   不启用 `ALLOW_ADMIN_SELF_REGISTER`。



## US-017 demo（6 个决策）

1. **终态路径**：覆盖 (a) approve→done、(b) request-revision→rework→approve→done、
   (c) open→cancel。reassign 已在 US-013 测试覆盖，demo 不重复。
2. **断言形式**：输出 JSON（最终 TaskView + awards/exploration + 事件类型序列 +
   全局 seq 序列 + versionConflict），由测试机器断言，不靠人工看日志。
3. **award 可复现**：`DEMO_MODE=true` 强制冷启动探索；受控 bids 让唯一技能合格的
   agent 进入探索候选。输出标注 `demoMode: true`。
4. **编排**：共享进程，三个 mock agent 各一个 `AgentMeshClient`（planner 为 admin，
   另加 coder/reviewer）；启动快、断言直接。
5. **client 生命周期**：demo 创建并拥有全部 client；cleanup 顺序
   adapter.close → client.close → app.close → db.close；输出 `cleanExit`。
6. **失败注入**：包含一次 stale award 的 `-32007`，断言
   taskId/expectedVersion/currentVersion；不注入 gap_too_large（SDK 单测覆盖）。



## US-015 AgentAdapter（5 个决策）

1. **能力声明**：构造时静态声明，`getCapabilities()` 暴露
   `{skills, availability, maxConcurrentTasks, supportsReview}`。服务端评分当前仍使用
   accounts/tasks 数据；adapter 声明用于自身竞标决策，未来若服务端消费需新增查询。
2. **中止语义**：使用 `onAborted({taskId, reason})` 回调；reason =
   `cancelled | reassigned | not_assignee`。不使用 AbortSignal（跨 WS 事件更直观）。
3. **review 感知**：adapter 感知，`onReviewDecided` 转发 approve/reject/request-revision。
4. **SDK 所有权**：外部注入 `AgentMeshClient`；adapter 不持有/复制传输逻辑。
5. **模板完整度**：构造参数校验 + 能力声明 + 事件注册 + 错误透传；
   五家模板仅配置/校验不同，不发真实网络请求，无 TODO 空壳。



## US-014 SDK（5 个决策）

1. **`message.history.total` → `channelTotal`**：保留字段并改名，明确它是
   “查询时频道消息总数”，不是本页条数；分页仍靠 `hasMoreBefore/After` 与
   `nextBefore/AfterSeq`。
2. **`gap_too_large`**：默认 `auto` = 清空游标、自动重连并回调 `gapTooLarge`；
   `strict` = 只回调，由调用方 `resync()`。两种模式都有测试。
3. **`sendRaw`**：提供原样发送逃生舱，标注为不保证类型、不参与去重。
4. **`system.subscribe` 归属**：本故事不实现，保持 21/22；建议随 US-021 或单列。
5. **Transport**：可注入 `TransportFactory`；SDK 核心不 import `ws`，浏览器使用
   全局 WebSocket，Node 由调用方注入 `ws` 适配器。浏览器 JWT 通过带内
   `agent.authenticate { agentId: <sub>, token }` 完成，避免依赖 handshake header。



## US-013 审核 / 改派 / 取消（6 个决策）

1. **review decision 映射**：`approve → done`、`reject → in_progress`、
   `request-revision → in_progress`。不扩 decision 枚举；`review → failed` 由
   admin 显式调用 `task.fail`。
2. **reject / request-revision**：保留 progress；artifacts 以事件追加，不覆盖。
3. **reassign 目标资格**：必须是已注册账号（不要求频道成员）；不存在 → `-32004`。
4. **旧 assignee 的 live bid**：保留，不转 tombstone（审计与 OR-Set 收敛不变）。
5. **cancel 入边**：`open` / `bidding` / `in_progress` / `review` → `cancelled`；
   `cancelled` 是终态，不可重新打开。
6. **窗口关闭统一事件**：`closeExpiredBidding` 使用 `task.cancelled`
   （reason `bidding_window_closed`），不再写 `task.status.changed`；状态行为不变。

新增状态机边（已落在 `TASK_TRANSITIONS` 或专用 CAS 路径）：

```
review → done            (task.review approve)
review → in_progress     (task.review reject / request-revision)
awarded|in_progress|review → in_progress   (task.reassign)
open|bidding|in_progress|review → cancelled (task.cancel / closeExpiredBidding)
review → failed          (admin task.fail)
```



## US-011 progress 启动语义（选 A）

**决定**：首次 `task.progress` 在 `awarded` 状态下执行 `awarded → in_progress` 的
CAS（version +1）；后续 progress 只原地更新 `tasks.progress`，不碰 version。

**理由**：当前没有 `task.start` RPC，若严格要求 progress 只接受 `in_progress`，
`awarded` 任务没有任何公开路径进入执行态，生命周期会卡死。

**被否决的替代方案**：
- B：新增 `task.start` RPC，progress 完全不碰 version。语义更纯，但增加协议方法
  与 SDK 入口；MVP 不采用。
- C：`task.award` 直接进入 `in_progress`。会把授标与执行启动混在一起，CAS 语义
  需要重审；MVP 不采用。

## 安全

| 决策 | 理由 |
| --- | --- |
| 保持 HS256，不换 RS256 | 单信任边界；RS256 迁移条件未满足 |
| TLS 在反向代理终止 | 不在 Node 代码里加 HTTPS |
| 账号 secret 用 256-bit CSPRNG + 裸 SHA-256 | 不是人选密码，不需要 bcrypt/argon2 |
| JWT payload 不放敏感信息 | HS256 payload 可解码，不是加密 |
| 不做 SQLCipher 迁移 | 只写决策记录，依赖 OS/卷加密 |
| 不加 `kid`/JWKS 代码 | 现在加是死代码，会诱导过度设计 |

## US-008 语义

| 决策 | 说明 |
| --- | --- |
| `reject → in_progress` | 允许重做/改派；`failed` 是 admin 显式终态 |
| `review → in_progress` 边存在 | 支撑 request-revision / reject 重做 |
| `open → failed` 删除 | 无触发路径；US-011 需要时显式加回 |
| `expectedVersion` 必填 | 所有 transition 都是 CAS，不允许读后写回退 |
| `task.fail` 归 US-011，`task.cancel` 归 US-013 | 避免在 US-008 中悬空 |

## 明确不做（MVP）

- 不做 per-aggregate `seq`。
- 不做 LWW 任务归属。
- 不做定时自动授标。
- 不做多租户隔离（reclaim/register/presence 的单租户债务已记录）。
- 不做 token 撤销黑名单（记录为 US-022+ 候选）。
- 不做数据库静态加密。



## Audit 基线破口修复（US-019 引入的 postcss 漏洞）

**背景**：US-019 引入 Next.js 15 后，`npm audit --omit=dev --audit-level=high` 出现 2 个漏洞
（来自 Next.js 传递依赖的 postcss <=8.5.22）。之前基线是 --omit=dev 为 0，
这是"可交付 MVP"的新阻断项。

**漏洞详情**：
- 包：postcss（Next.js 的传递依赖）
- 版本：<=8.5.22（Next.js 15.5.29 依赖 postcss 8.5.22）
- CVE：GHSA-qx2v-qp2m-jg93 / GHSA-6g55-p6wh-862q / GHSA-fxqj-rqcc-2cmp / GHSA-r28c-9q8g-f849
- 严重度：1 high + 1 moderate
- 修复版本：postcss >=8.5.23（已发布）

**可达性分析**：
- PostCSS 在 Next.js **构建时**运行（CSS 处理、source map 生成），
  不在运行时容器/浏览器代码路径上。
- 攻击面：CI 构建机器或开发者本地构建时处理恶意 CSS/source map。
- 容器运行时不包含 postcss（已在 node_modules 中但仅构建时用）。
- 结论：不可达生产运行时，但构建环境有风险，CI/CD 需修复。

**4 个决策**：

1. **修复路径**：**使用 npm overrides 强制 postcss >=8.5.23**。
   理由：最小改动、不升级 Next.js 主版本、不破坏构建、移除条件明确（Next.js 16 发布后移除）。
   被否决：升级 Next.js 16（破坏性变更未知，需完整回归）；
   接受并记录（破坏基线原则，不可接受）。

2. **Web 纳入 verify 门槛**：**是**。
   `npm run verify` 扩展为覆盖 Web 的构建 + audit（omit=dev）。
   现有 `verify` 脚本：`typecheck && lint && test`；
   新增：Web 的 `build` + `audit --omit=dev`。
   这能在 CI 阶段捕获后续 Web 依赖引入的漏洞。

3. **不接受"记录风险"方案**：必须修复恢复 0 漏洞。
   不得把 --audit-level=high 的门槛放宽；不得把漏洞写入"已知风险"清单而不修。

4. **devDependencies audit 门槛**：**暂不收口**。
   当前只要求 `--omit=dev` 为 0；devDependencies 允许已知漏洞（构建工具链常见）。
   未来若 CI 构建环境要求全 0，再单独列故事收口。

**实现**：
- 根 `package.json` 添加 `overrides: { postcss: "8.5.33" }`（当前最新修复版）。
- 根 `package.json` 的 `verify` 脚本扩展 Web 构建 + audit。
- `overrides` 处加注释说明原因与移除条件（Next.js 16 发布后移除）。

## US-019 Next.js 管理后台（7 个决策）

1. **登录角色**：**admin-only 进入后台**；agent 走 CLI/SDK，不提供 Web 只读视图。
   理由：MVP 面向运维/管理员；agent 的只读需求（看任务进度、收消息）用 CLI/SDK 覆盖，
   避免 Web 权限矩阵与 RBAC 爆炸。若未来需要 agent Web 视图，单独列故事 + 完整 RBAC 设计。

   权限矩阵（后台）：

   | 页面/操作 | admin | agent |
   | --- | --- | --- |
   | 登录/进入后台 | ✅ | ❌（返回 403） |
   | 频道列表/消息/历史 | ✅ | — |
   | 任务看板（publish/bid/award/progress/review/reassign/cancel） | ✅ | — |
   | 事件流（SDK on()） | ✅ | — |
   | 审计视图（`system.subscribe` includeDomainEvents） | ✅ | — |

2. **SSR 边界**：**SSR 跳过 WS 连接**；仅在 CSR（客户端水合后）建立连接。
   实现：`next/dynamic` 引入 `AgentMeshClientProvider`（client-only），`useEffect` 内
   `connect()` + `authenticate`。SSR 只渲染静态骨架/首屏数据（如有），不创建 SDK client。

3. **去重键**：**同一 seq 跨列表只渲染一次**。
   实现：全局 `SeqRegistry`（Map<seq, boolean>）在 `onMessage`/`onHistoryPage` 中校验；
   `message.history` 返回的 `channelTotal` 仅作统计，UI 不以它判断去重。
   与 US-010（历史补偿用同一 seq 空间）+ US-014（SDK `lastSeenSeq`）保持一致。

4. **gap_too_large UX**：默认 **auto**；banner 提示"已重新同步"；
   可在设置里切换到 strict（显示"连接中断，点击重新同步"按钮，调用
   `client.resyncChannelHistory(channelId)`）。auto 模式下 SDK 自动重连 + 清空游标，
   Web 只做 toast 提示。

5. **产物展示**：>1 MiB 仅展示引用（URL/ID），**不实现上传端点**。
   上传端点单列 US-022+，需先改安全边界决策（调大 maxPayload 或新增 HTTP endpoint）。
   本故事只渲染 `artifacts` 数组中的字符串为链接/复制按钮。

6. **事件流范围**：
   - 默认视图：**仅非 domain-only 事件**（SDK `on(type)` 拼装 11 种 notification）。
   - **审计视图（admin-only）**：提供 `system.subscribe` 面板，
     `includeDomainEvents: true` + 可选 `types` 过滤，展示 domain-only 事件。
     UI 入口：右上角 "审计视图" 开关，仅 admin 可见；切换时先 `subscribeSystem`
     再 `resyncChannelHistory`（domain 事件走 resume，非 history）。

7. **浏览器 transport 验证**：**Playwright smoke + 手工清单**。
   - Playwright：登录 → 进频道 → 发消息 → history 补偿 → 实时收到 message.new
     → 创建任务 → award → progress → complete → review approve → done；
     覆盖 gap_too_large（手动断网触发）与 -32007 重试入口。
   - 手工清单：Chrome/Firefox/Safari 各一轮（带内认证、重连、SSR 无 WS）。
   - 若发现 SDK 浏览器 transport 缺陷：**独立 fix: 提交 SDK**，Web 故事引用该提交。

## US-019 偏离说明

- 被否决：**agent 只读 Web 视图**（决策 1）；理由：MVP 避免 RBAC 复杂度，
  agent 需求用 CLI/SDK 覆盖。
- 被否决：**SSR 建立 WS**（决策 2）；理由：首屏不需要实时数据，SSR + WS 会导致
  服务端每请求一个连接，无益且难以管理生命周期。
- 被否决：**按列表独立去重**（决策 3）；理由：同一 seq 在消息列表与事件流
  同时出现会导致重复渲染，用户体验差；US-010/014 保证 seq 全局唯一.


## US-021B 定时 compaction（4 个决策）

1. **触发方式**：**独立定时器** (`setInterval`)，默认关闭。
   理由：单机 SQLite 下单一写者，轮询比请求触发更可控；默认关闭避免无谓开销。
   被否决：请求触发（不确定延迟）、外部 cron（需额外部署、运维复杂度）。

2. **推进逻辑**：在 `withTransaction` 内推进 `stableFrontier`，仅删除
   `counter <= frontier` 的 tombstone；live add tag 永不删除。
   与 US-012 `compactOrSet` 不变量对齐：live 集合不变、幂等、可重入。

3. **开关与配置**：env `TASK_BID_COMPACTION_INTERVAL_SECONDS`，默认 0 = 关闭；
   不新增 RPC（保持 22/22）。可运行时调整：`stopCompactionTimer()` + 新 `startCompactionTimer()`。

4. **失败处理**：单次失败记录日志 + 下周期重试，不自动终止进程；
   compaction 事件记录 `errors` 字段，`/health` 暴露状态（US-021C 扩展）。

**实现**：
- 复用 US-012 `compactOrSet` / `compactBids` 纯函数。
- `TasksService` 新增：`compactTaskBids`、`runCompaction`、`startCompactionTimer` / `stopCompactionTimer`。
- `app.ts` 启动时按开关注册定时器，`onClose` 清理（与 reclaim 定时器一致）。
- compaction 完成后写 `task.compaction.completed` domain 事件（含 `compactedTasks` / `totalRemoved` / `errors`）。
- 默认关闭，避免无谓开销；按需开启（如 `TASK_BID_COMPACTION_INTERVAL_SECONDS=3600`）。
- `npm run verify` 全绿；`npm run demo` 退出码 0；`npm audit --omit=dev` 为 0；`npm run verify:docker` 通过。

### P2 — domain 事件可选字段风格（US-021B P1 核实锁定）

domain-only 事件的 payload 可选字段使用 **`.optional()`**，**不用** `.nullable().optional()`：

- 发射端**省略**缺省字段，从不写 `null`（与 US-021A 通知一致）；
- 事件日志里"字段缺失"与"字段为 `null`"语义不同：显式 `null` 视为契约违规 → 被 schema 拒绝；
- 契约由 `packages/protocol/test/domain-event-payload.test.ts` 锁定：每个可选字段断言
  "省略通过 / 有值通过 / 显式 `null` 被拒绝"；`task.compaction.completed` 的必填数值字段
  （`compactedTasks` / `totalRemoved`）另断言 **缺失 / `null` / 负数 / 浮点 / 错类型** 全部被拒绝，
  `errors` 另断言 **非数组被拒绝**。

被否决的替代方案：与 notification 统一用 `.nullable().optional()`——那会把 `null` 当成 domain
流的合法值，reducer 需要额外分支，且会掩盖 producer 误写 `null` 的 bug。US-021A 的 notification
基准不受影响（notification 仍为 `.nullable().optional()`）。

domain 事件边界核实结论：`account.registered` / `account.authenticated` **确为 domain-only 事件**
（在 `DOMAIN_ONLY_EVENT_TYPES` 且不在 `NOTIFICATION_EVENT_TYPES`），报告无误划；不改 schema。


## 故障注入回归（US-021B compaction，2026-11-23）

目的：核实 P0 的测试"函数级正确、集成路径断裂"这一盲区——定时 compaction 曾完全空转却全绿。
对三条关键集成路径做"故意破坏 → 期望测试红 → 恢复"的验证（验证后工作树干净）。

| # | 注入 | 结果 | 命中用例 |
| --- | --- | --- | --- |
| 1 | `TaskBidsDao.listTaskIds()` 改为 `return []`（模拟原 `listByTask('')` 恒 0 行） | **红（3 条失败）** | `physically reclaims a tombstone…` / `is idempotent…` / `a scheduled tick writes task.compaction.completed…` |
| 2 | `compactTaskBids` 的 frontier 计算改回 `bidStableFrontier()`（新旧恒等） | **红（3 条失败）** | 同上三条 |
| 3 | 移除 `app.ts` onClose 里的 `tasks.stopCompactionTimer()`（定时器未清理） | **红（`cleared=false`，退出码 1）** | 进程内关闭 harness 的 `task.compaction.timer.cleared` 日志断言（与 `verify-local.mjs` 在 Linux 上的断言同源） |

结论：三条路径的现有测试都会变红，**无需补测试**。已修复的集成断言（`tasks.compaction.test.ts`
的真实回收/幂等/定时 tick 用例 + `verify-local.mjs` 的结构化日志断言）足以捕获同类断裂。

断言边界（诚实记录）：注入 3 若仅注释 `stopCompactionTimer` 内部的 `clearInterval` 而保留其后的
`.cleared` 日志，则日志断言不会变红——该断言证明"清理路径被执行"，而非"`clearInterval` 本身执行"。
真实失败模式（onClose 接线被移除 / `stopCompactionTimer` 从未被调用）会被捕获。如需更强保证，
可再加"定时器对象已置空"的进程内可观测断言（`isCompactionTimerRunning()` 关闭后必须为 false，已有测试覆盖）。

## US-021G Web 测试基线（4 个决策）

1. **测试范围**：三层。
   - 单元（node env + vitest）：`seq-registry`（US-019 决策 3 跨列表去重）、`admin-errors`
     （-32001/-32002 登录映射；-32007 展示 expected+current）。
   - 集成（真实 SDK + mock transport）：真实 `AgentMeshClient` 驱动，`message.new` 与 history
     共享 seq 经 registry 去重；断线重连后 resume 帧携带 `lastSeenEpoch`。
   - e2e（Playwright）：`apps/web/e2e`，`BASE_URL` 参数化，供 M9 复用；不纳入根 verify。
   被否决：只做单元（覆盖不到 SDK↔UI 去重）；只做 e2e（慢、脆、CI 成本高）。
2. **是否纳入根 verify**：单元 + 集成**纳入**（web `test` 脚本改为 `vitest run`，被根
   `npm test --workspaces` 自动包含）；e2e **单独**（`npm run test:e2e`），README 写明何时跑、
   失败处置，避免变成"永远不跑的装饰"。被否决：e2e 纳入 verify（每次起浏览器太慢且需真实栈）。
3. **mock 策略**：集成测试用**真实 SDK + mock transport**（不 mock 客户端），与 sdk 包测试一致，
   避免 mock 与真实语义漂移。被否决：mock SDK 客户端（会与真实去重/resume 语义脱节）。
4. **e2e 复用边界**：**M9 引用本故事脚本**（`BASE_URL` + `ADMIN_AGENT_ID`/`ADMIN_SECRET` 参数化），
   不另写第二套 Playwright。被否决：M9 内联手写（重复且易漂移）。

**已知限制（诚实记录）**：本环境 npm 11.20.0 的 arborist `diffTrees` 缺陷使 `npm i -D @playwright/test`
失败，且本机无浏览器/无运行栈，故 e2e **已编写但未在本机执行**（脚本+配置齐全，M9 具备环境后按
README 执行）。故障注入自检：破坏 `markSeqSeen` 恒返回 true → seq-registry 单测 2 条 + 集成去重 1 条
变红，恢复后全绿。

## US-021C 事件哈希链定期校验（4 个决策）

1. **校验时机**：**启动时一次 + 定时**（默认 1h）。理由：启动即暴露明显篡改，定时发现运行期
   篡改。被否决：仅启动（长时间运行后无人复查）；仅定时（首检延迟 1h）。
2. **失败行为**：**仅告警 + `/health` 标记不健康（mismatch）**，不阻断写入/启动。理由：本地
   单机库可能被手动修改，阻断会让运维无法修复。被否决：阻断写入/阻断启动（会把运维锁死）。
3. **告警通道**：**pino 结构化字段 + `/health`**（`hashChain: ok | mismatch | unchecked`），
   只暴露 `status/checked/lastCheckedAt/mismatch{seq,aggregateId}`，**不含 payload/secret**。
   被否决：仅日志（健康探针看不到）。
4. **外部锚定**：本故事**不做**（US-022 候选），只做“能校验 + 能告警”。被否决：链尾外部锚定
   （需额外可信存储，超出 MVP）。

**实现**：
- core 新增 `verifyEventChainBatched(loadBatch, {batchSize})` 与 `EventStore.verifyChain()`（分批读，
  返回第一个不一致的 `seq` + `aggregateId`，大库不 OOM）。
- server 新增 `HashChainMonitor`：启动一次 + 定时；env `HASH_CHAIN_VERIFY_ON_STARTUP`（默认 true）、
  `HASH_CHAIN_VERIFY_INTERVAL_SECONDS`（默认 3600，0 关闭）。
- 定时器 `unref()` + `onClose` 清理，输出 `hashchain.timer.started` / `hashchain.timer.cleared`；
  `verify:docker` 的 JSON 报告新增 `hashChainTimerStarted` / `hashChainTimerCleared`（Windows n/a）。
- `/health` 增加 `hashChain` 字段，不暴露 payload/secret。
- 故障注入自检：把定时器 tick 改成不调用 `runCheck` → “periodic timer actually re-verifies”
  集成用例变红，恢复后全绿（避开 US-021B 的空转陷阱）。

## US-021D token 撤销（5 个决策）

1. **存储**：**进程内 LRU**（`Map< jti, exp >`，上限 1 万，过期懒清理）。**重启后已撤销 token 复活**
   （在 `exp` 前再次有效），已在 security.md/operations.md 写明。被否决：SQLite 表（需 v9 迁移与
   跨进程缓存一致性，超出 MVP）；两者并存（复杂度不值）。
2. **入口**：**新增 RPC `agent.revokeToken`**（admin-only）→ 22/22 变 **23/23**。全仓同步了
   status.md/architecture.md 的方法表与计数、protocol `METHOD_NAMES` 长度测试。
   被否决：仅 CLI（跨进程写内存不可行；写库又需迁移）。
3. **jti 回收/容量**：按 `exp` 自动过期清理；LRU 上限 1 万；满时**淘汰最旧**（绝不拒绝撤销——
   安全相关应以最新撤销为准），与现有 LRU 限流器策略一致。
4. **与 JWT_SECRET 轮换**：轮换仍是全量失效；撤销是细粒度补充，两者一致（撤销后再轮换不恢复，
   因为 token 已因密钥变更失效）。
5. **可观测性**：撤销成功记 `token.revoked`（含 agentId + jti + expiresAt；jti 为随机不透明 id，
   可记录；**不记录 token 明文**）。

**实现**：
- `TokenRevocationRegistry`（auth/revocation.ts）；`TokenService.verify` 验签后检查撤销，命中抛
  `-32001`（与无效 token 同码，不泄露"已撤销"）。
- `agent.revokeToken`（modules/revocation.ts）：校验目标 token 取 jti/exp，写入注册表。
- 协议：`agentRevokeTokenParamsSchema { targetToken }` + result；SDK 新增 `revokeToken()` 类型化方法
  （字段名 `targetToken` 以避开 SDK 自动注入的 `params.token`）。
- 测试：registry 过期清理/容量淘汰；TokenService 拒绝/其他 token 有效/重启复活；真实 server 上
  revoke 后 token 服务拒绝、admin 自助 token 仍有效；故障注入（verify 不查撤销表 → 集成红）。

**SDK 公开 API 变更（点名）**：新增 `AgentMeshClient.revokeToken({ targetToken })`，为保持
“类型化方法覆盖全部 RPC（23/23）”的既有约束。若不需要可回退为 `sendRaw`，但需同步下调覆盖声明。

## US-021E 多租户隔离设计（草案；**2026-11-23 评审：已锁死，见文末「US-021E 评审结论」**）

> 状态：草案。任何 schema/RPC 变更必须走下列拆分的独立故事，本草案不开代码。

### 1. 租户模型
- `workspace` 升为一等公民：每张业务表带 `workspace_id`；JWT `workspaceId` claim 已存在，作为
  唯一的租户来源（请求头不可覆盖）。
- `default` workspace 迁移：保留为“遗留租户”，v9 迁移把所有既有行归入 `default`；新租户由
  `workspace.create`（admin）创建。
- 角色矩阵草案：`admin`（workspace 内全权）/ `agent`（业务操作）/ `observer`（只读）；
  是否需要 **workspace-admin**（可管理本租户但非平台超管）：建议引入，避免平台单点。
- 不这样做：所有租户共用 `default`，任意越权可见。

### 2. 数据模型影响（v9）
- `channels` / `channel_members` 复合主键加 `workspace_id`（现主键缺该维度 → 跨租户 id 冲突）。
- 迁移：v9 加列 + 回填 `default` + 重建主键/唯一索引；回滚策略：备份替换（不写 down 迁移）。
- 已有数据归入 `default` 的规则：按现有 `workspace_id` 列（若已有）或统一 `default`。

### 3. RPC 影响（当前 23 个）
- 归属表（草案）：所有 `task.*` / `channel.*` / `message.*` 从 **token 的 workspaceId 推断**，
  不新增参数（防伪造）；`agent.list` 限定本租户；`system.subscribe` 仅本租户事件。
- `agent.revokeToken` 仅能撤销本租户 token（校验 target token 的 workspaceId 与调用者一致）。

### 4. presence
- 内存 presence 结构按 `workspaceId` 分桶；广播按租户过滤。
- 测试点：跨租户 presence 不可见；断线 offline 仅广播本租户。

### 5. 安全边界（负向测试清单）
- 伪造 `workspaceId` 请求头 → 被 token claim 覆盖，无法越权。
- 用 A 租户 token 访问 B 租户 `task.get`/`channel.list`/`message.history` → `-32004/-32002`。
- `resume` 只重放本租户事件；跨租户 seq 不串。

### 6. 拆分策略（每 PR 独立可回滚）
- US-022：schema + v9 迁移（加 workspace 维度、回填 default）。
- US-023：RPC + 鉴权（全部 RPC 的租户归属与负向测试）。
- US-024：presence + Web（租户切换 UI、隔离）。
- US-025：运维（租户创建、迁移、备份按租户）。

### 7. 明确不做
- MVP **不支持**跨 workspace 共享任务/频道；跨租户协作列为 US-026+。

## US-021F SQLCipher 迁移评估（结论：仍不做）

1. **现状**：SQLite 明文存储，依赖 OS/卷加密（security.md）。备份/恢复为明文文件复制；事件哈希链
   提供完整性而非机密性。
2. **触发条件复核**：合规审计（当前不满足要求时再评估）/ 多租户托管（US-021E 落地后再评）/
   上云托管共享存储 / 客户明确要求静态加密。**当前均不满足**（单机自托管 MVP）。
3. **迁移成本**：`better-sqlite3-multiple-ciphers` 兼容性、启动注入密钥、v9+ 重加密脚本、
   性能开销（页级加密）、密钥管理与 `JWT_SECRET` **分离**、备份/恢复流程改造。
4. **风险**：丢失密钥 = 全量不可恢复；密钥轮换 = 全量重加密（停写窗口）；与 hash chain 无冲突
   （链是对明文 canonical JSON 的 SHA-256，加密在存储层）。
5. **结论**：**仍不做**。复审条件：上云托管 / 客户合规要求静态加密 / US-021E 多租户落地 /
   安全审计提出。届时按 US-022+ 单列，不夹带进其他故事。

## CI（GitHub Actions）5 个决策

1. **触发**：`push` to main + `pull_request` + 每日 `schedule`（06:17 UTC，捕捉新 CVE）+
   `workflow_dispatch` 全开。
2. **Job 拆分**：
   - `verify`（**required**）：`npm ci` → `npm run verify` → 两条 audit（all / omit=dev）→
     `npm run demo`（与本地四项门槛逐项一致，不精简）。
   - `web-e2e`（**required**）：装 Playwright + chromium，起本地栈（build + seed-admin +
     server + `next start`）跑 e2e。
   - `docker`（**required**）：`verify:docker`（Linux runner 天然支持 SIGTERM，断言两个
     `*Cleared` 为 true）。
   - `audit-cron`（**advisory**）：仅定时触发，额外跑全量 audit（含 dev），失败通知不阻塞 PR。
3. **Node 版本**：单一 `22`（LTS，满足 engines>=22 与 vite 8/vitest 5 要求）；不做矩阵。
4. **缓存**：`actions/setup-node` 的 `cache: npm`；Playwright 浏览器缓存 `~/.cache/ms-playwright`，
   key 含 `@playwright/test` 版本；不缓存 `node_modules`（`npm ci` 更干净）。
5. **e2e 环境**：方案 A（轻量）：同一 job 内 build → `seed-admin`（解析 agentId/secret）→
   后台起 server(8787) 与 `next start`(3000) → 轮询 `/health` 与 `/login` → `playwright test`。
   DB 用 `$RUNNER_TEMP` 临时 SQLite，job 结束即清理。方案 B（compose 全栈 + BASE_URL）留给 M9 签字。

**Playwright 依赖策略**：`package.json` 不新增 `@playwright/test`（本地 npm arborist 缺陷无法生成
lockfile）；CI e2e job 用 `npm ci` 后 `npm install --no-save @playwright/test -w @agentmesh/web`
+ `npx playwright install --with-deps chromium`，从而**不改动已提交的 lockfile**。

**CI 自检**：首次运行全绿后，故意破坏一条测试断言 → 断言 `verify` job 变红 → 恢复（见 changelog）。

## US-021D 撤销持久化决策（复核，2026-11-23）

**结论：保持现状（进程内 LRU），不改 schema。** 撤销是“尽力而为的细粒度补充”，持久性失效靠
`JWT_SECRET` 轮换。

### 1. 威胁模型与影响
场景：攻击者窃取 token T（jti=J）→ 管理员 `agent.revokeToken` 撤销 J → 运维重启服务 →
进程内撤销表清空 → T 在 `exp` 前再次可用。
- 窗口：`exp`（默认 3600s）内，任意一次重启后直到 T 过期。
- 风险：**中**（需“已撤销 + 紧接重启 + exp 前攻击”三条件叠加；单机自托管重启频率低）。
- 缓解：**轮换 `JWT_SECRET` = 全量且持久**失效（重启后仍失效）；缩短 exp 缩小窗口。
- 判断：怀疑泄露时，轮换 secret 是更持久更强的手段；“撤销”本就不是持久机制。
  故“重启复活”是**已知边界**，不是遗漏。

### 2. 持久化代价（若未来要做）
- 表 `revoked_tokens(jti PK, workspace_id, expires_at, revoked_at)`；建议 **v10 独立迁移**
  （不与 US-022 的 v9 合并以免耦合；若多租户先落地则带 `workspace_id`）。
- 鉴权路径：`TokenService.verify` 每请求命中撤销表 → 每次鉴权一次 DB 读；需内存缓存（短 TTL/LRU）。
- 事件：本实现**不写 domain 事件**（安全动作，结构化日志足矣）；若审计需要 `token.revoked` domain
  事件 → registry 样本 + 契约测试 + handler 集成测试 + 故障注入。
- 备份/恢复：撤销表随库备份、恢复后仍生效（这正是持久化目的）。

### 3. 替代方案（含被否决理由）
| 方案 | 结论 | 理由 |
| --- | --- | --- |
| 保持现状 + 缩短 exp（可选） | **采纳** | MVP 单实例、重启少；缩短 exp 零成本缩窗 |
| 持久化到 SQLite（v10） | 否决（本周期） | 增迁移 + 每请求 DB 读；当前无驱动；易与 US-022 耦合 |
| 外部存储（Redis） | 否决 | 单机不引外部依赖；多实例时重评 |
| 只存“撤销时间戳 + 游标” | 否决 | 语义不等价逐 token 撤销，恢复粒度粗 |
| 缩短 exp + refresh 重鉴权 | 否决 | 仍需凭据；不能替代“管理员主动撤销某 token” |

### 4. 复审条件
多实例部署 / 客户或合规要求“撤销跨重启生效” / US-021E 多租户落地。届时独立 v10 迁移 +
内存缓存，不改 JWT payload 字段（jti 已存在）。

### 与 US-021E 的交互
当前撤销**不按 workspace 隔离**（jti 全局）。多租户落地后：撤销记录带 `workspace_id`，只能撤销
**本 workspace** 的 token（跨租户 -32002/-32004）；多租户 + 多实例会同时触发“持久化 + 隔离”。

## US-021E 评审结论（2026-11-23，**已锁死**）

**结论：草案可接受，锁死。** 附 23 RPC 归属表、冲突检查、拆分独立性、与 US-021D 交互。

### 与已锁死决策的冲突检查
| 已锁死项 | 结论 | 说明 |
| --- | --- | --- |
| seq 全局唯一 | 兼容 | seq 仍全局（单 events 表）；resume/history 读取按 workspace 过滤，seq 空间不变 |
| 任务归属 CAS | 兼容 | workspace 取自 token；他租户任务表现为 -32004（不泄露存在性） |
| system.subscribe | 兼容 | per-session 不变；workspace 取自 token；跨租户订阅不可达 |
| presence LWW | 需调整（US-024） | 内存 presence 按 workspace 分片；广播按租户过滤 |
| US-021D 撤销 | 需调整（US-023/未来） | 撤销记录加 workspace_id，撤销限本租户 |

### 23 个 RPC 归属表（统一从 token 推断，不新增 workspaceId 参数）
| 方法 | workspace 来源 | 跨租户错误码 |
| --- | --- | --- |
| agent.register | 无 token → `default`（多租户注册延后） | n/a |
| agent.authenticate | 账号所属 workspace | -32004 |
| agent.list | token claim | -32004 |
| agent.revokeToken | token claim（目标 token 须同租户） | -32002 |
| channel.create/join/leave/list | token claim | -32004 |
| message.send/history | token claim | -32004 |
| task.publish/list/get/bid/bids/award/progress/complete/fail/review/reassign/cancel | token claim | -32004 |
| system.subscribe | token claim | -32002 |

越权错误码：读/资源类 **-32004**（避免探测），动作/角色类 **-32002**，一致。

### 拆分独立性
- **US-022（schema+backfill）单独安全**：加 `workspace_id` 列 + `workspaces` 表 + 回填 `default`；
  代码仍用常量 `default`，行为不变 → 可独立上线。
- **US-023（RPC 鉴权）** 依赖 US-022 列；US-022 后、US-023 前系统仍“全 default”，安全。
- **US-024（presence+Web）** 依赖 US-023；**US-025（运维）** 依赖前三者。
- 回滚：v9/v10 迁移**前向不可逆**，“回滚”= 从备份恢复（记入 operations.md）。
- 结论：**拆分成立**；唯一限制是迁移前向不可逆，须先备份。

### 与 US-021D 交互
撤销在多租户下按 workspace 隔离；持久化 + 隔离在 US-022/023 一起评估，本评审不夹带实现。
