# AgentMesh 文档索引

本目录是项目级文档入口；包级细节仍以各包 `README.md` 为准。

| 文档 | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 分层架构、事件溯源、数据模型、传输层 |
| [status.md](status.md) | 当前完成度、已实现 RPC、未闭环项与下一步 |
| [security.md](security.md) | 安全模型、算法边界、已加固项与未来决策 |
| [operations.md](operations.md) | 部署前检查、admin 引导、密钥轮换、备份与关闭 |
| [decisions.md](decisions.md) | 已锁死架构/安全决策与明确不做的范围 |
| [changelog.md](changelog.md) | 审计与修复批次、测试基线变化 |
| [us-008-notes.md](us-008-notes.md) | US-008 验证记录与可直接合并的 prd notes |

包级文档：

- [packages/protocol/README.md](../packages/protocol/README.md)
- [packages/store/README.md](../packages/store/README.md)
- [packages/core/README.md](../packages/core/README.md)
- [apps/server/README.md](../apps/server/README.md)

当前基线：**356 个测试全绿**（core 40 / protocol 44 / store 69 / server 203），
`npm audit --audit-level=high` 为 **0 vulnerabilities**。

> 权威 `prd.json` 与提交链位于 qwenpaw 容器工作区；本地副本此前没有 git，
> 本仓库是本地初始化的记录，提交历史从当前工作树开始。
