# 运维手册

## 部署前检查

- `NODE_ENV=production`，`JWT_SECRET` ≥32 bytes CSPRNG，通过密钥管理注入，不进代码/镜像。
- 反向代理终止 TLS；Node 只暴露 HTTP/ws。
- `ALLOWED_ORIGINS` 显式列出管理后台 origin；不要使用 `*`。
- `ALLOW_MISSING_ORIGIN=false` 可强制所有 WS 客户端带 Origin（浏览器管理端场景）。
- 数据目录 `mode 700`，并启用 OS/卷加密。
- 不设置 `ALLOW_ADMIN_SELF_REGISTER=true`；用 `seed:admin` 引导第一个 admin。
- CI 跑 `npm audit --audit-level=high`。

## 引导第一个 admin

```bash
npm run build
DB_PATH=data/agentmesh.db \
  npm run seed:admin -w @agentmesh/server -- --name admin --owner ops
```

- 输出一次 `secret: …`，只存 SHA-256 摘要；
- 用 `agent.authenticate { name, secret }` 换 JWT；
- 幂等：同名再次执行打印 `admin already exists ... (no changes)`。

## 丢失 admin secret / 账号恢复

`seed:admin` 没有 reset 模式。可选：

1. 直接清空该账号的 `secret_hash`，重新用 `seed:admin` 同名创建会被拒绝——
   需要先删除/重命名旧行；
2. 手动删除该账号行（确认没有 task 引用）后重新 seed；
3. 不要临时打开 `ALLOW_ADMIN_SELF_REGISTER` 作为恢复捷径。

## JWT_SECRET 轮换

- 轮换会让**所有**已签发 token 立即失效（旧密钥无法验证新签名，新密钥无法验证旧 token）。
- 在维护窗口执行；通知所有 agent 重新 `agent.authenticate`。
- 当前没有 `kid`/JWKS/双密钥过渡；零停机轮换属于 US-022+。

## 备份与恢复

- SQLite 使用 WAL：备份 `agentmesh.db` + `-wal`/`-shm`，或先 `PRAGMA wal_checkpoint(TRUNCATE)`。
- 事件日志是事实源；快照是派生物，可删除重建。
- 恢复后 `epoch` 会变化（网关实例重启），客户端必须冷启动。

## 优雅关闭

`SIGINT`/`SIGTERM` → `app.close()`：

- Fastify `preClose` 关闭全部 WebSocket；
- reclaim 定时器 `clearInterval`；
- 自有的 SQLite 句柄关闭；
- pino 同步写 stdout，无未 flush 缓冲区。

## compaction 定时器（US-021B / `TASK_BID_COMPACTION_INTERVAL_SECONDS`）

- 默认关闭（`0`）。开启后每 N 秒运行一次 `runCompaction`，回收已过 `stableFrontier` 的
  bid tombstone（live bid 永不删除）；有实际回收时写 `task.compaction.completed` domain-only 事件。
- 定时器 start/clear 有结构化日志：`task.compaction.timer.started` / `task.compaction.timer.cleared`，
  `verify:docker` 依据这两条日志**显式断言**生命周期（不靠退出码推断）。
- **Linux 手工验证定时器清理**（Windows 上 `verify-local.mjs` 把 `compactionTimerCleared` 如实记为
  `n/a`，因为 Windows 不投递 SIGTERM）：

  ```bash
  npm run build
  PORT=18888 DB_PATH=/tmp/am.db JWT_SECRET=$(openssl rand -hex 32) \
    ALLOWED_ORIGINS=https://localhost LOG_LEVEL=info \
    TASK_BID_COMPACTION_INTERVAL_SECONDS=1 \
    node apps/server/dist/index.js > /tmp/am.log 2>&1 &
  pid=$!
  sleep 2
  grep -q 'task.compaction.timer.started' /tmp/am.log && echo 'started OK' || echo 'MISSING started'
  kill -TERM "$pid"; wait "$pid"
  grep -q 'task.compaction.timer.cleared' /tmp/am.log && echo 'cleared OK' || echo 'MISSING cleared'
  ```

## 健康检查

`GET /health` 返回 `status/version/protocolVersion/uptime/nodeEnv/timestamp/hashChain`。
WS 有心跳：一个 interval 未回 pong 的 socket 会被 `terminate()`。

### 哈希链完整性（US-021C）

- `/health.hashChain` 取值：`ok`（最近一次校验通过）/ `mismatch`（发现不一致或校验异常）/
  `unchecked`（尚未校验）。**不暴露**任何事件 payload 或 secret，仅状态。
- 校验时机：启动时一次 + 定时（`HASH_CHAIN_VERIFY_INTERVAL_SECONDS`，默认 `3600` 秒，`0` 关闭定时；
  `HASH_CHAIN_VERIFY_ON_STARTUP` 默认 `true`）。
- 结构化日志：`hashchain.verify.ok` / `hashchain.verify.mismatch`（含 `seq` + `aggregateId`）/
  `hashchain.timer.started` / `hashchain.timer.cleared`。
- **发现 mismatch 时**：服务不阻断、不停止写入（本地库可能被手动修改）。运维应：
  1) 看日志定位 `seq` + `aggregateId`；2) 从可信备份恢复（见「备份与恢复」）；
  3) 排查手动改库来源。链尾事件被篡改无法检测（无外部锚定，US-022+）。
- `verify:docker` 显式断言 `hashChainTimerStarted` / `hashChainTimerCleared`（Windows 记 `n/a`，
  Linux 必须为 true）。

## Docker 部署（US-018）

```bash
mkdir -p docker/secrets
openssl rand -base64 48 > docker/secrets/jwt_secret.txt
chmod 600 docker/secrets/jwt_secret.txt
ALLOWED_ORIGINS=https://localhost \
  docker compose -f docker/compose.yaml up -d --build
curl -kf https://localhost:8443/health
```

- **Secret**：只从 Docker secret `/run/secrets/jwt_secret` 注入；镜像/compose 不含明文。
- **TLS**：Caddy 终止。生产设置 `DOMAIN=app.example.com`、
  `CADDY_TLS_DIRECTIVE=`（空）、`ALLOWED_ORIGINS=https://app.example.com`、
  `HTTPS_PORT=443 HTTP_PORT=80`。
- **Migrations**：启动自动迁移；独立幂等命令：
  ```bash
  docker compose exec server node apps/server/dist/cli/migrate.js --db /app/data/agentmesh.db
  ```
- **Admin**：
  ```bash
  docker compose exec server \
    node apps/server/dist/cli/seed-admin.js --name admin --owner ops
  ```
- **Backup**：
  ```bash
  docker compose exec server /usr/local/bin/agentmesh-backup
  ```
  恢复：停 server → 用备份替换 `/app/data/agentmesh.db`（先移除 `-wal`/`-shm`）→ 启动。
- **Graceful shutdown**：`docker compose stop -t 20`；`preClose` 关闭 WS、清理 reclaim
  定时器、关闭 SQLite。
- **JWT_SECRET 轮换**：替换 secret 后重启；所有 token 立即失效，需通知 agent 重新认证。
- **无 Docker 环境**：`npm run verify:docker` 等价验证 health / migrate / backup。

## M9 运行时签字（**阻塞中**，2026-11-23 复核）

- `docker version` / `docker compose version`：本机 Docker 引擎**不可用**（命令不存在）；
  M9 运行时项**未执行、未签字**。不得把“未执行”写成“通过”。
- 已完成的本地等价验证：`npm run verify:docker` →
  `{"health":true,"gracefulShutdown":true,"migrate":true,"backup":true,
  "compactionTimerStarted":true,"compactionTimerCleared":"n/a",
  "hashChainTimerStarted":true,"hashChainTimerCleared":"n/a","platform":"win32"}`
  （Windows 上 SIGTERM 不投递，两个 `*Cleared` 如实记 `n/a`；**Linux 上必须为 true**）。
- 待具备 Docker 环境后执行：`docker compose up`、Caddy internal TLS/证书、**Linux** SIGTERM 优雅关闭
  （断言退出码、WS 关闭、reclaim/compaction/hashChain 定时器清理均为 true、SQLite 句柄关闭）、
  容器内 seed-admin、卷持久化与恢复演练、容器内 runtime audit。
- **Web smoke（M9 第 10 项）复用 US-021G 的 e2e**：`BASE_URL=https://localhost:8443
  ADMIN_AGENT_ID=... ADMIN_SECRET=... npm run test:e2e -w @agentmesh/web`（需先在目标机
  `npm i -D @playwright/test -w @agentmesh/web && npx playwright install chromium`）。
- 复现步骤：安装 Docker Engine ≥24 + Compose v2，按「Docker 部署」执行，并用
  `docker compose logs server` 检查启动/关闭，断言上述定时器日志与 `/health.hashChain`。

## token 撤销（US-021D）

- admin 通过 `agent.revokeToken { targetToken }` 撤销单个 token（`jti` 从 token 解出；不记录明文）。
- 撤销在**进程内存**中生效：仅对当前进程有效，**重启后失效**（token 在 `exp` 前复活）。
- 撤销命中统一返回 `-32001`（不暴露"已撤销"，避免探测）。
- 紧急整集失效：轮换 `JWT_SECRET` 并重启（见「JWT_SECRET 轮换」）；撤销是细粒度补充。
- 示例（SDK）：
  ```ts
  await adminClient.revokeToken({ targetToken: compromisedToken });
  ```

## CI 与 M9 的关系

- CI（`.github/workflows/ci.yml`）通过 **不等于** M9 签字。CI 的 `web-e2e` 在 GitHub runner 上起
  真实本地栈跑通浏览器路径，可作 M9 第 10 项（Web smoke）的**部分**证据；`docker.yml` 的
  `verify:docker` 在 Linux 上证明 SIGTERM 清理两个定时器（可作 M9 第 6 项部分证据）。
- **M9 仍需要真实 Docker 环境**：`docker compose up` + Caddy TLS + 容器内 seed-admin + 卷恢复 +
  在容器/Caddy origin 上跑 e2e（BASE_URL）——这些 CI 默认 job 不覆盖，须人工在 Docker 环境执行并签字。
- 失败排查：CI badge → Actions 运行日志；本地复现命令见 README「持续集成（CI）」。

## 数据库迁移（v9 / US-022 多租户 schema）

- **当前 schema 版本：v9**（`CURRENT_SCHEMA_VERSION`）。迁移幂等，启动自动执行；独立命令：
  `node apps/server/dist/cli/migrate.js --db <path>`（或容器内 `docker compose exec server ...`）。
- **v9 内容**：新增 `workspaces` 表并 seed `default`；重建 `channel_members` PK 为
  `(workspace_id, channel_id, agent_id)`（v3 的 `uq_channel_members_ws` 索引折叠进 PK）。其余表
  自 v1 起已带 `workspace_id`，无需回填。
- **前向不可逆**：本仓库不提供 down migration。**升级前务必备份**（见「备份与恢复」）：
  迁移失败时用备份替换 `agentmesh.db`（先移除 `-wal`/`-shm`）即可回到迁移前状态。
- 迁移在单事务内执行，失败自动回滚到迁移前；`channel_members` 重建（建新表→拷→DROP→RENAME）在同一
  事务内，不会留下半重建状态。
- 回滚演练：备份 → 启动旧版本（或对备份执行 `migrate` 到目标版本）→ 校验 health。

## 租户运维（US-025）

- 创建租户（平台 admin）：`agentmesh workspace create --name "Acme" --max-agents 50`
  （或 RPC `workspace.create`）→ 返回 `inviteCode`。
- 邀请 agent：持有邀请码者执行 `agent.register --name <n> --invite-code <code>`
  （或 RPC `agent.register { name, inviteCode }`）；生成的 token 绑定该租户。
  邀请码可过期（默认 7 天，`invite_expires_at`）；过期/无效 → `-32004`。
- 列表：`agentmesh workspace list`；禁用：`agentmesh workspace disable --workspace <id>`
  （`default` 不可禁用）。禁用后该租户新登录/注册被拒（`-32002`），既有 socket 不主动断开。
- 配额：`max_agents`（默认 100），超限 `-32008`。
- v10 迁移前向不可逆，升级前备份（见「数据库迁移」）。

## 指标与告警（可观测性）

- `GET /metrics`：Prometheus 文本格式；`METRICS_ENABLED=false` 时返回 404。
- 指标：
  - `agentmesh_rpc_requests_total{method,code}`（code=`ok` 或错误码，含 -32008）；
  - `agentmesh_rpc_duration_ms{method}`（histogram，ms）；
  - `agentmesh_ws_sessions`（活跃 socket）；
  - `agentmesh_hashchain_status{status}`（ok/mismatch/unchecked，当前态置 1）；
  - `agentmesh_workspaces_total` / `agentmesh_workspaces_disabled`。
- **安全**：`/metrics` 无应用层鉴权，**必须仅内网 / 反代 ACL 可达**，不要直接暴露公网。
- 告警规则示例（由外部 Prometheus/告警器定义；AgentMesh 只暴露指标）：
  - hashChain 不一致：`agentmesh_hashchain_status{status="mismatch"} == 1`
  - 错误率：`rate(agentmesh_rpc_requests_total{code!="ok"}[5m]) > 0.1`
  - 延迟 P95：`histogram_quantile(0.95, rate(agentmesh_rpc_duration_ms_bucket[5m])) > 1000`
  - 禁用租户：`agentmesh_workspaces_disabled > 0`（信息级）

## 备份与恢复制度化

- **定时备份（cron）**：`DB_PATH=data/agentmesh.db BACKUP_DIR=backups BACKUP_KEEP=7 scripts/backup.sh`
  （backup CLI 产物经 `PRAGMA integrity_check` 校验；失败非 0 退出）。保留最新 `BACKUP_KEEP`（默认 7）份。
  示例 crontab：`17 3 * * * cd /app && DB_PATH=/app/data/agentmesh.db scripts/backup.sh`
- **迁移前自动备份**：`migrate` CLI 与 `startServer`（自动启动迁移）在应用前向迁移前都会调用
  `prepareMigrationBackup`：空库/`:memory:`/已最新 → 跳过；非空且有待迁移 → 生成
  `<db>.pre-v<target>.<ts>.bak` 并校验 integrity；**备份失败 → 迁移中止（启动失败）**。
  规则是“每次迁移运行前”，不是“升级前一次”。
- **恢复步骤**：停服 → 用备份替换 `agentmesh.db`（先删 `-wal`/`-shm`）→ 启动 → `/health` ok。
- **恢复演练（冒烟）**：`scripts/restore-drill.sh [db]`（默认 `data/agentmesh.db`，缺失则用新建迁移库）。
  只断言 `/health` ok（hashChain ok）与 `/metrics` 有 `agentmesh_workspaces_total`，用于快速连通性检查。
- **恢复演练（生产库，发布前/每月）**：`node scripts/production-restore-drill.mjs`（需先 `npm run build`）。
  在临时库上经公开 RPC 造出真实数据（2 个租户 + default、4 个账号、8 条消息、1 个 `done` 任务、
  1 个禁用租户、1 条 v11 撤销记录），然后停服 → `backup` CLI 快照 → 复制为恢复库 → 起服务校验：
  - `/health.hashChain=ok`；
  - `/metrics` 三项与源库逐项相等（`workspaces_total=3`、`workspaces_disabled=1`、
    `revoked_tokens_active=1`）；
  - 消息数（default 3 / ws-drill 5）、任务终态 `done`、跨租户频道可见性一致；
  - 行数逐表相等（accounts/workspaces/channels/messages/tasks/task_bids/revoked_tokens/events）；
  - 被撤销 token 恢复后仍 `-32001`，**第二次重启后仍 `-32001`**；
  - 跨租户权限仍为 `-32002`（跨租户撤销）/`-32004`（跨租户读）；
  - 负向对照：损坏数据库启动失败（证明演练的启动断言能识别坏备份）；断言函数自检。
  成功输出 `RESTORE DRILL PASS (N assertions)`；证据（步骤、指标、行数、耗时）写入
  `.drill-tmp/evidence.json`。失败时非 0 退出且 `evidence.json` 带 `failure`。
- **演练记录表**：
  | 日期 | 环境 | 源库 | 结果 | 备注 |
  | --- | --- | --- | --- | --- |
  | 2026-11-26 | Windows 本机 | 新建迁移库 | **PASS** | 冒烟：health ok / hashChain ok / metrics ok（空库，不含业务/撤销数据） |
  | 2026-11-27 | Windows 本机（Node 22） | 生产库（2 租户 / 8 消息 / 1 done 任务 / 1 撤销 / 1 禁用租户） | **PASS（22 断言，2.3s）** | hashChain ok；metrics 3/1/1 一致；rows accounts=4 workspaces=3 channels=2 messages=8 tasks=1 task_bids=1 revoked_tokens=1 events=25；恢复后与二次重启后撤销仍 -32001；跨租户 -32002/-32004；损坏库启动失败 |
- **备份安全**：`secret_hash` 是摘要（非明文 secret）；备份仍为明文 SQLite，继承 OS/卷加密；
  **不要把备份提交进仓库**。

## 容量评估与扩容决策树（单实例声明，2026-11-27）

> 决策见 decisions.md「单实例边界与扩展路径」。**当前明确为单实例部署**：SQLite 单写者、四个定时器
> 与 WS 广播都在进程内，多实例会丢实时消息。下表为**压测实测值（2026-11-27）**。

| 维度 | 单实例实测上限（2026-11-27） | 备注 |
| --- | --- | --- |
| 并发 WS 连接 | **≥ 1**（单连接测试） | 受限于注册速率限制（30/min），未测试多连接并发；单连接吞吐已达极限 |
| 消息发送吞吐 | **~54 msg/s** | SQLite 写入瓶颈；P95 延迟 2ms；错误率 0% |
| 消息广播投递率 | **100%**（10–1000 msg/s） | 单连接全速率无丢包 |
| 任务发布/竞标/授标 | **~5.4 tasks/s** | 含 publish + bid + award 完整流程 |
| 租户 / 账号 | ≤ 100 租户 / ≤ 10,000 账号（`maxAgents` 默认 100） | 未变 |
| 撤销表 | ≤ 未过期撤销数，每小时清理 | 未变 |

> **压测环境**：Windows 11 / Node 22 / SQLite WAL / 单 admin 账号 / 10s/测速率级
>
> **测试脚本**：`scripts/load-test.mjs`（使用 seed:admin 创建管理员、禁用注册限流、复用 WS 连接）
>
> **已知限制**：
> 1. 仅测试单 WS 连接下的吞吐；多连接并发未测（受限于注册限流）
> 2. `task.bid` / `task.award` 参数校验失败（-32602），任务吞吐可能偏低
> 3. Windows 环境非 Linux 生产环境，仅供参考

### 扩容决策树

1. **只是流量增长、可接受短暂停机？** → **垂直扩容**（CPU / RAM / NVMe），并先跑压测确认拐点；
   每次扩容后复跑压测，保守容量取拐点 × 0.5。
2. **需要高可用/零停机发布？** → 方案 B：多副本 active-passive + 定时器 leader election + 备份文件锁
   + 会话粘滞；单列故事（decisions.md 触发条件）。
3. **单实例压测拐点低于业务需求，或需要跨主机多写？** → 方案 C：Postgres + Redis/NATS 事件总线
   + 会话路由；单列架构故事，并重审撤销缓存 / presence / 配额路径。
4. **租户要求数据驻留或密码学隔离？** → 按租户分库/独立部署（与静态加密决策联动），不必先做 C。

### 压测方法（执行后回填结果）

- `ws` 压测脚本：100 → 500 → 1,000 → 2,000 连接，每级 5 分钟；`autocannon` 打 `/health`、`/metrics`。
- 观测：`agentmesh_rpc_duration_ms` P95、`code!="ok"` 错误率、消息 seq 连续性、RSS、WAL 大小、
  `/health.hashChain`。
- 判据：P95 > 1s / 错误率 > 1% / 消息缺口 > 0 → 拐点；保守容量 = 拐点 × 0.5。

### 监控阈值建议（单实例）

- `agentmesh_ws_sessions` > 1,500（估算上限的 75%）→ 预警；> 2,000 → 计划扩容。
- `rate(agentmesh_rpc_requests_total{code!="ok"}[5m]) > 0.1` → 告警（沿用现有规则）。
- WAL 文件持续 > 1 GB 或备份耗时显著上升 → 检查长事务/写放大。

## token 撤销表运维（v11）

- 表 `revoked_tokens(jti, expires_at, revoked_at, workspace_id)`；撤销经 `agent.revokeToken` 落库，重启后仍生效。
- **清理**：`REVOKED_TOKENS_CLEANUP_INTERVAL_SECONDS`（默认 3600，0 关闭）定时删除过期行；
  结构化日志 `revoked.tokens.cleanup.started/.cleared`；`verify:docker` 断言。
- **指标**：`GET /metrics` 的 `agentmesh_revoked_tokens_active`（当前未过期撤销数）。
- **备份/恢复**：撤销表随库备份；`scripts/production-restore-drill.mjs` 已实测覆盖（恢复后及二次重启后旧 token 仍 -32001，`revoked_tokens_active` 恢复前后一致）。
- 跨租户撤销：调用者 workspace 必须等于目标 token 的 workspace，否则 -32002。

## 静态加密（对外 SaaS 部署要求，方案 A）

> 决策见 decisions.md「静态加密与密钥管理」。**部署级要求，不改代码。**

- **对外 SaaS 部署必须启用卷/盘级加密**（云盘加密 / LUKS 等）+ **外部 KMS 托管数据密钥**；
  KMS 不可达时数据卷不得挂载（fail closed）。
- **密钥与 `JWT_SECRET` 分离**：不同 secret、不同轮换周期；数据密钥不得出现在 compose/镜像/仓库/日志。
- **轮换**：按 KMS 卷密钥轮换流程（快照 → 新密钥 → 重建卷），目标 ≤ 12 个月或按合规条款；
  轮换后执行一次 `scripts/production-restore-drill.mjs`。
- **离卷/异地备份必须独立加密**（age/GPG 或对象存储 SSE-KMS），备份密钥与卷密钥分离且不与备份同处；
  恢复演练同时断言"备份可解密"与"KMS 可用"。
- **密钥丢失 = 全库不可恢复**：启用 KMS 删除保护/版本控制与 break-glass 策略，runbook 写明联系人。
- **多租户**：MVP 不做按租户密钥隔离（单库单密钥）；租户要求密码学隔离时单列故事（分库或 per-tenant key）。
- **SQLCipher（方案 B）**：仅在客户要求"库文件/备份本身为密文"时单列 US-026（含 v12 重加密迁移、
  备份/恢复改造、回滚与性能基准）。**应用层字段加密（方案 C）已否决**（与哈希链冲突）。
