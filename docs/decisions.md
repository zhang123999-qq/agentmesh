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
