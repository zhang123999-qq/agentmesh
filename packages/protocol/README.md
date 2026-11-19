# @agentmesh/protocol

AgentMesh 的线上契约：JSON-RPC 2.0 信封、事件信封与 payload、连接控制帧、方法名、
错误码、协议版本协商。服务端 / SDK / Web 共用这一份 zod schema（`z.infer` 推导类型）。

> 项目级文档：[../../docs/README.md](../../docs/README.md)（架构 / 安全 / 状态）。

## 用法

```ts
import {
  eventNotificationSchema,
  jsonRpcRequestSchema,
  createJsonRpcRequest,
  METHODS,
  JsonRpcErrorCode,
  ProtocolError,
  PROTOCOL_VERSION,
} from '@agentmesh/protocol';

// 校验一条请求
const req = jsonRpcRequestSchema.parse({
  jsonrpc: '2.0',
  id: 1,
  method: METHODS.task.award,
  params: { taskId: 'tsk_1', expectedVersion: 3 },
});

// 解析一条事件推送（payload 按 type 自动收窄）
const event = eventNotificationSchema.parse(rawFrame);
if (event.type === 'task.awarded') {
  console.log(event.payload.awardeeId, event.payload.exploration); // false 默认
}

// 抛错让 dispatcher 统一转成 JSON-RPC error
throw new ProtocolError(JsonRpcErrorCode.VersionConflict, undefined, {
  expectedVersion: 3,
});

// 构造请求
const frame = createJsonRpcRequest(METHODS.channel.list, { channelId: 'chn_1' });
console.log(frame.jsonrpc, PROTOCOL_VERSION); // '2.0' '1.0.0'
```

## 关键约定

| 概念 | 约定 |
| --- | --- |
| `seq` | 全局单调递增、全局唯一（`events.seq` AUTOINCREMENT），唯一去重/续传游标 |
| `epoch` | `seq` 空间世代；服务重启/换库后变化，客户端 epoch 不一致则冷启动全量拉取 |
| `welcome` | 下发 `epoch` + `seq` 水位 + 协商后的 `protocolVersion` |
| `resume` | `lastSeenSeq:number` + `lastSeenEpoch?:string`（第三方可省略；官方 SDK 始终携带） |
| `ack` | 恢复回放确认，**始终**带 `epoch` |
| `gap_too_large` | 回放超出窗口的降级信号，客户端转全量拉取 |
| `-32007` | 版本冲突（CAS `WHERE version=?` 受影响行数 0），不得静默覆盖 |
| 事件通知 | `method` = 事件类型，`params` = 事件信封 |

## 脚本

```bash
npm run build      # tsc -> dist
npm run typecheck  # tsc --noEmit
npm run lint       # eslint src test
npm test           # vitest run
```
