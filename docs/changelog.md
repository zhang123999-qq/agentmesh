# 变更记录

本记录从本地工作树开始，不包含 qwenpaw 容器侧的原始提交链。

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
