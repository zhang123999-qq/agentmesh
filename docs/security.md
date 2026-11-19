# 安全模型（MVP）

## 算法边界

| 用途 | 机制 | 性质 |
| --- | --- | --- |
| 访问令牌 | HS256（HMAC-SHA256，jose） | **签名**，不是加密 |
| 账号 secret | `crypto.randomBytes(32)` → Base64URL（256 bit） | CSPRNG |
| 账号 secret 存储 | SHA-256 十六进制摘要 + `timingSafeEqual` | 单向哈希 |
| 事件哈希链 | SHA-256 over canonical JSON | 审计预留，未强制验证 |
| ID / epoch / reqId | `crypto.randomUUID()` | UUID v4 |

**没有**：AES/RSA、密码 KDF（bcrypt/scrypt/argon2）、SQLCipher、Node 层 HTTPS。
这些是 MVP 的明确取舍，不是遗漏。

## JWT

- **JWT_SECRET**：生产必须 ≥32 bytes；弱值（`secret`/`changeme`/`test` 等）与
  零熵重复字符在启动时拒绝；开发 ≥16 字符并输出 `security.warning`。
- **校验**：强制 `algorithms: ['HS256']`、`iss`、`aud`、`exp`；clock tolerance 5s。
  `alg:none`、`alg:RS256`、错误 iss/aud、错误签名、过期 token 全部 `-32001`。
- **payload**：仅 `sub` / `role` / `workspaceId` / `iss` / `aud` / `iat` / `exp` /
  `jti`。HS256 payload 是 Base64URL，持有 token 即可解码；不要放敏感数据。
- **撤销**：未实现。泄露 token 在 `exp`（默认 3600s）前有效；轮换
  `JWT_SECRET` 会让所有 token 立即失效，需要维护窗口。
- **未来 RS256**：仅当第三方需独立验签或需要零停机轮换时迁移；步骤为生成密钥对、
  加 `kid`、发布 JWKS、双算法过渡、移除 HS256。当前故意没有 `kid`/JWKS 代码。

## 账号凭证

- `agent.register` / `seed:admin` 生成 256-bit CSPRNG secret，明文只返回一次；
  数据库与事件只存 SHA-256 摘要。
- secret 是人不可猜测的随机值，因此裸 SHA-256 足够，不需要 KDF。
- `agent.register` 匿名，按远程地址限流（默认 30 次/分钟）；超限 `-32005`。
- `seed:admin` 仅本地 CLI，不暴露 RPC；幂等，第二次打印 `admin already exists`。

## 传输与 WS

- TLS 在反向代理终止；Node 只监听 HTTP/ws。
- **Origin allow-list**：`ALLOWED_ORIGINS` 精确匹配，拒绝 `*`；**生产为空时启动
  fail fast（`ConfigError`）**，不能 warn + 启动。`ALLOW_MISSING_ORIGIN` 默认
  **true（两个环境）**：Origin 是浏览器自动加的，SDK/CLI/demo 不带属正常，拒绝它们
  没有 CSWSH 防护收益；带 Origin 的请求才校验。开发默认允许
  localhost/127.0.0.1/[::1]。
  **前提**：token 走 `Authorization: Bearer` header，浏览器不会自动携带；若未来改
  为 cookie，必须同时启用 CSRF token 或 `SameSite=Strict`，并把
  `ALLOW_MISSING_ORIGIN` 设为 false。
- **输入上限**：HTTP `bodyLimit` 与 WS `maxPayload` 均为 1 MiB。
- **产物传输（架构决策）**：WS `maxPayload` 为 1 MiB，**不得为产物传输调大**（会
  扩大 DoS 面）。US-011 的产物超过 1 MiB 时走 **HTTP 上传 + WS 只传引用
  （URL/ID）**。US-011 实现必须遵守。
- **clockTolerance 5s**：适用于单机/时钟同步环境。多实例部署（US-022+）需要 NTP
  同步，或将 tolerance 调到 ≤30s；当前值不改。
- **软限流**：连接级 / agent 级超限返回 `-32005`，socket 保持打开。

## 日志与数据

- pino `redact` 覆盖顶层与嵌套的 `authorization` / `secret` / `token` / `password` /
  `secretHash` / `secret_hash`，以及精确错误/请求路径 `err.body`、`err.request`、
  `err.payload`、`req.body`、`request.body`。**不使用顶层 `*.body` / `*.payload`
  通配**，避免把正常业务 payload 日志误脱敏；仍要求代码不主动记录凭证。
- 三个有界限流器（auth failure / registration / agent bucket）都在**插入前**检查
  容量，因此 map 永不超限；淘汰策略是 **LRU**，活跃 identity 不会被一次性 key
  洪泛挤掉。
- SQLite 明文；部署必须保证数据目录 `mode 700`，并依赖 OS/卷加密。需要数据库级
  加密时使用 `better-sqlite3-multiple-ciphers`（SQLCipher 兼容），列为 US-022+。
- `account.registered` 事件含 `secretHash`（不可逆摘要）。事件日志的访问控制必须
  至少与 `accounts` 表同级；未来公开事件 API 必须过滤该字段。
- `prevHash` 只写不验，不能当成运行时防篡改保证；生产需要定期 `verifyEventChain`
  + 外部锚定。

## 依赖

- `package-lock.json` 必须提交。
- CI 建议：`npm audit --audit-level=high`，high/critical 阻塞合并。
- 当前（2026-11-19）：`npm audit` 为 **0 vulnerabilities**。

## 安全测试清单

> **历史事实（2026-11-19 修复）**：安全补充批次 C 修复前，三个限流器是 FIFO，
> 攻击者可灌入一次性 key 把活跃 identity 的限流状态挤出 → **限流可被绕过**；D 修复前
> 错误路径 `err.body` 未脱敏，authenticate 失败日志可能泄露 secret 明文。两者均已
> 修复并补负向测试，不能简单记作"补测试"。

- `alg:none` / `alg:RS256` / 错误签名 / 错误 iss/aud / 过期 token → `-32001`
- JWT payload 不含 secret/secretHash/password/owner/email
- 生产短密钥/弱密钥 → 启动失败；开发短密钥 → warn
- 非白名单 Origin → 403；allow-list Origin 通过；无 Origin 按配置
- HTTP/WS 超 1 MiB → 拒绝（413 / close 1009）
- 日志无明文 secret/token/authorization
- 三个限流器灌入超上限 key → map 不超限
- 旧版 `account.registered` 无 `secretHash` → replay 不崩、authenticate `-32001`
