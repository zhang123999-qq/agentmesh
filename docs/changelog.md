# 变更记录

本记录从本地工作树开始，不包含 qwenpaw 容器侧的原始提交链。

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
