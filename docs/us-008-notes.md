# US-008 notes (local mirror)

> This file is a local mirror of the US-008 ledger entry. The authoritative
> `prd.json` lives in the qwenpaw container workspace
> (`/app/working/workspaces/default`); this copy has no git/prd artifacts.
> Merge the block below into that `prd.json` before marking the story final.

```json
{
  "id": "US-008",
  "passes": true,
  "notes": "已通过对抗验证（348 用例）。状态机五条边完整；review → in_progress 已补。\n- reject 语义：选 A —— reject 回 in_progress，允许重做/改派；failed 是 admin 显式选择的终态出口（US-013）。\n- open → failed：已删除（无触发路径，US-011 需要时显式加回）。\n- task.fail handler 归 US-011；task.cancel RPC 归 US-013。\n- seed-admin 走 account.registered 事件，payload 含 secretHash（SHA-256，不含明文），replay 可重建凭证（有测试）。\n- expectedVersion 已必填化，删除默认回退。\n- 启动时在 listen 前执行一次 reclaimExpired；task.publish 拒绝非未来的 deadline。\n提交：本地副本非 git 仓库，未提交；以 qwenpaw 侧 commit 为准。"
}
```

## Evidence

| Item | Evidence |
| --- | --- |
| `review → in_progress` edge | `apps/server/src/modules/tasks.ts` `TASK_TRANSITIONS.review` |
| reject → in_progress | `packages/core/src/reducers/task.ts` `REVIEW_STATUS.reject`; `packages/core/test/task.test.ts` |
| open → failed removed | `TASK_TRANSITIONS.open`；`apps/server/test/tasks.test.ts` asserts `canTransition('open','failed') === false` |
| seed replay credential | `apps/server/test/accounts.test.ts` replay tests; `AccountState.secretHash` |
| expectedVersion required | `TransitionOptions.expectedVersion: number`; all call sites pass it |
| startup reclaim | `apps/server/src/index.ts`; `apps/server/test/tasks.test.ts` |
| event emission frames | `packages/store/src/db.ts`; tests in `packages/store/test/events.test.ts` and `packages/core/test/event-store.test.ts` |

Test baseline: **348** (core 40 / protocol 44 / store 69 / server 195).
