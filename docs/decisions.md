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
