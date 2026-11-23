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
