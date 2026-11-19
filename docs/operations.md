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

## 健康检查

`GET /health` 返回 `status/version/protocolVersion/uptime/nodeEnv/timestamp`。
WS 有心跳：一个 interval 未回 pong 的 socket 会被 `terminate()`。
