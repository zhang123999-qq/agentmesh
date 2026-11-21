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
