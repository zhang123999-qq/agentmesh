# 当前状态

## 完成度

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| US-001…US-007 | 完成 | monorepo、协议、store、core、server、鉴权、频道/消息、WS |
| US-008 | **PASS**（按对抗验证判据） | 任务发布、状态机、CAS、超时回收、启动回收 |
| US-009 | 未开始 | 竞标引擎 + 授标 CAS；11 条 AC 待实现 |
| US-010…US-021 | 未开始 | `message.history`、审核/改派、SDK、CLI、mock agents、Web、Docker |

测试基线：**357**
（core 40 / protocol 44 / store 69 / server 204）。

US-008 的判定依据与 notes 见 [us-008-notes.md](us-008-notes.md)。关键语义：

- `review → in_progress` 已补；
- `reject → in_progress`（允许重做/改派），`failed` 是 admin 显式终态；
- `open → failed` 已删除（无触发路径，US-011 需要时显式加回）；
- `seed-admin` 的 `account.registered` 含 `secretHash`，replay 可重建凭证；
- `expectedVersion` 已必填，所有 transition 都走 CAS。

## 已实现的 RPC（11 / 21）

| 分组 | 方法 |
| --- | --- |
| agent | `agent.register` / `agent.authenticate` / `agent.list` |
| channel | `channel.create` / `channel.join` / `channel.leave` / `channel.list` |
| message | `message.send` |
| task | `task.publish` / `task.list` / `task.get` |

未注册、请求返回 `-32601`：

- `message.history`
- `task.bid` / `task.bids` / `task.award` / `task.progress` / `task.complete` /
  `task.fail` / `task.review` / `task.reassign`
- `system.subscribe`

## 已知缺口 / 技术债

| 项 | 归属 | 影响 |
| --- | --- | --- |
| 竞标/授标/进度/审核/改派未实现 | US-009 / US-011 / US-013 | 任务发布后无法通过公开 API 流转 |
| `message.new` 无持久化回放 | US-010 | 离线成员错过消息后无法补齐 |
| 无 `task.cancel` RPC | US-013 | 管理员只能等 sweeper 回收 |
| 单 workspace 债务：reclaim 固定 `default`、register 写默认 workspace、presence 不按 workspace 过滤 | US-022+ | 多租户不可用；已在 server README 记录 |
| 哈希链只写不验 | US-022+ | 不能作为运行时防篡改保证 |
| 无 token 撤销 | US-022+ | 泄露 token 在 `exp` 前有效 |
| SQLite 明文 | US-022+ | 依赖 OS/卷加密 |
| SDK/adapters/mock-agents/CLI/Web/Docker 为空 | US-014…US-019 | 生态与部署未落地 |

## 下一步

1. **US-009**：`task.bid/bids/award`、五维评分、冷启动探索、并发 award 冲突。
   - 硬约束：`task.awarded` 必须走 `withTransaction` 帧栈后 emit；
   - 并发测试必须断言第二个 award 收到 `-32007` 且事件日志仅一条 `task.awarded`；
   - `config.demoMode=true` 时强制 `AlwaysExploreForDemo`。
   - **US-011 派生约束**：产物 >1 MiB 时走 HTTP 上传 + WS 只传引用（URL/ID），
     不得调大 WS `maxPayload`。
2. US-010：`message.history`，补消息回放路径。
3. US-011/013：`task.fail`、`task.cancel`、审核决策与改派。
4. US-014：SDK（Web 必须复用它，不得自建第二套续传）。
5. US-018：Docker/部署脚本（数据目录 700、TLS 反代、密钥注入）。

## 溯源说明

本地仓库是**独立初始化的 git 历史**（`a5cf1cc` 为 import 提交），与 qwenpaw 容器
仓库（提交链 `c8807d4…d508299`）**没有共同祖先**，不能通过 `git log` 直接比较。
溯源只能用文件内容 hash 对比。当前关键文件：

- `apps/server/src/modules/tasks.ts` SHA-256
  `0904cd3de814d62941f35662205669043a0e2b583bd993522564e0bf28c7f94e`
- `apps/server/test/tasks.test.ts` SHA-256
  `36556148e304e827249a86ae6b9f985dcea110f725cc31fa3da5bf5fbc433982`

（hash 会随 US-009 改动变化；记录的是 US-008 + 安全批次基线。）

