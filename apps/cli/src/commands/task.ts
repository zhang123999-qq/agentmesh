import type { AgentMeshClient, TaskStatus } from '@agentmesh/sdk';

import {
  optionalInt,
  optionalList,
  optionalNumber,
  optionalRepeated,
  optionalString,
  parseWhen,
  requireInt,
  requireNumber,
  requireString,
  UsageError,
} from '../args.js';
import { emit, type CommandContext } from '../context.js';
import { formatBids, formatTask, formatTasks } from '../format.js';
import { decodeTokenClaims } from '../token.js';

const TASK_STATUSES: readonly TaskStatus[] = [
  'draft',
  'open',
  'bidding',
  'awarded',
  'in_progress',
  'review',
  'done',
  'failed',
  'cancelled',
];

const REVIEW_DECISIONS = ['approve', 'reject', 'request-revision'] as const;
type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function isReviewDecision(value: string): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly string[]).includes(value);
}

function taskId(ctx: CommandContext): string {
  return requireString(ctx.args, 'task');
}

function cas(ctx: CommandContext): { taskId: string; expectedVersion: number } {
  return {
    taskId: taskId(ctx),
    expectedVersion: requireInt(ctx.args, 'expected-version'),
  };
}

function callerId(ctx: CommandContext): string | undefined {
  if (ctx.config.agentId !== undefined) return ctx.config.agentId;
  return ctx.config.token === undefined
    ? undefined
    : decodeTokenClaims(ctx.config.token)?.sub;
}

export async function runTaskPublish(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const title = requireString(ctx.args, 'title');
  const description = optionalString(ctx.args, 'description');
  const skills = optionalList(ctx.args, 'skills');
  const budget = optionalNumber(ctx.args, 'budget');
  const deadlineRaw = optionalString(ctx.args, 'deadline');
  const biddingRaw = optionalString(ctx.args, 'bidding-deadline');
  const parentId = optionalString(ctx.args, 'parent');

  const result = await client.publishTask({
    title,
    ...(description === undefined ? {} : { description }),
    ...(skills === undefined ? {} : { requiredSkills: skills }),
    ...(budget === undefined ? {} : { budget }),
    ...(deadlineRaw === undefined ? {} : { deadline: parseWhen(deadlineRaw, 'deadline') }),
    ...(biddingRaw === undefined
      ? {}
      : { biddingDeadline: parseWhen(biddingRaw, 'bidding-deadline') }),
    ...(parentId === undefined ? {} : { parentId }),
  });
  emit(
    ctx,
    result,
    `published task ${result.task.id} [${result.task.status}] version ${result.task.version}`,
  );
}

export async function runTaskList(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const status = optionalString(ctx.args, 'status');
  if (status !== undefined && !isTaskStatus(status)) {
    throw new UsageError(`--status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  const limit = optionalInt(ctx.args, 'limit');
  const offset = optionalInt(ctx.args, 'offset');
  const result = await client.listTasks({
    ...(status === undefined ? {} : { status }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  });
  emit(
    ctx,
    result,
    `${formatTasks(result.tasks)}\n${result.total} task(s) total`,
  );
}

export async function runTaskGet(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const task = await client.getTask({ taskId: taskId(ctx) });
  emit(ctx, task, formatTask(task));
}

export async function runTaskBid(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const id = taskId(ctx);
  const price = requireNumber(ctx.args, 'price');
  const eta = optionalNumber(ctx.args, 'eta');
  const approach = optionalString(ctx.args, 'approach');
  const confidence = optionalNumber(ctx.args, 'confidence');
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    throw new UsageError('--confidence must be between 0 and 1');
  }
  const result = await client.bid({
    taskId: id,
    price,
    ...(eta === undefined ? {} : { eta }),
    ...(approach === undefined ? {} : { approach }),
    ...(confidence === undefined ? {} : { confidence }),
  });
  emit(ctx, result, `placed bid on task ${id} (price ${price})`);
}

export async function runTaskBids(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const id = taskId(ctx);
  const result = await client.bids({ taskId: id });
  emit(
    ctx,
    result,
    `${formatBids(result.bids)}\n${result.total} bid(s) for ${id}`,
  );
}

export async function runTaskAward(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const { taskId: id, expectedVersion } = cas(ctx);
  const awardeeId = optionalString(ctx.args, 'awardee');
  const strategy = optionalString(ctx.args, 'strategy');
  if (strategy !== undefined && strategy !== 'manual' && strategy !== 'auto') {
    throw new UsageError('--strategy must be manual or auto');
  }
  const result = await client.award({
    taskId: id,
    expectedVersion,
    ...(awardeeId === undefined ? {} : { awardeeId }),
    ...(strategy === undefined ? {} : { strategy }),
  });
  emit(
    ctx,
    result,
    `awarded task ${id} to ${result.awardeeId} ` +
      `(strategy ${result.strategy}, exploration ${result.exploration}, version ${result.version})`,
  );
}

export async function runTaskProgress(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const id = taskId(ctx);
  const progress = requireNumber(ctx.args, 'progress');
  if (progress < 0 || progress > 100) {
    throw new UsageError('--progress must be between 0 and 100');
  }
  const note = optionalString(ctx.args, 'note');
  const artifacts = optionalRepeated(ctx.args, 'artifact');
  const result = await client.progress({
    taskId: id,
    progress,
    ...(note === undefined ? {} : { note }),
    ...(artifacts === undefined ? {} : { artifacts }),
  });
  emit(
    ctx,
    result,
    `task ${id} progress ${Math.round(result.task.progress)}% ` +
      `[${result.task.status}] version ${result.version}`,
  );
}

export async function runTaskComplete(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const { taskId: id, expectedVersion } = cas(ctx);
  const note = optionalString(ctx.args, 'note');
  const artifacts = optionalRepeated(ctx.args, 'artifact');
  const result = await client.complete({
    taskId: id,
    expectedVersion,
    ...(note === undefined ? {} : { note }),
    ...(artifacts === undefined ? {} : { artifacts }),
  });
  emit(
    ctx,
    result,
    `task ${id} submitted for review [${result.task.status}] version ${result.version}`,
  );
}

export async function runTaskFail(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const { taskId: id, expectedVersion } = cas(ctx);
  const reason = optionalString(ctx.args, 'reason');
  const result = await client.fail({
    taskId: id,
    expectedVersion,
    ...(reason === undefined ? {} : { reason }),
  });
  emit(ctx, result, `task ${id} failed [${result.task.status}] version ${result.version}`);
}

export async function runTaskReview(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const { taskId: id, expectedVersion } = cas(ctx);
  const decision = requireString(ctx.args, 'decision');
  if (!isReviewDecision(decision)) {
    throw new UsageError('--decision must be approve, reject or request-revision');
  }
  const comment = optionalString(ctx.args, 'comment');
  const result = await client.review({
    taskId: id,
    expectedVersion,
    decision,
    ...(comment === undefined ? {} : { comment }),
  });
  emit(
    ctx,
    result,
    `task ${id} review ${decision} → [${result.task.status}] version ${result.version}`,
  );
}

export async function runTaskReassign(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const { taskId: id, expectedVersion } = cas(ctx);
  const toAgentId = requireString(ctx.args, 'to');
  const reason = optionalString(ctx.args, 'reason');
  const result = await client.reassign({
    taskId: id,
    expectedVersion,
    toAgentId,
    ...(reason === undefined ? {} : { reason }),
  });
  // The wire response carries no `humanTakeover` flag; derive it the same way
  // the server does: the admin assigned the task to itself.
  const humanTakeover = result.task.assignee === callerId(ctx);
  emit(
    ctx,
    { ...result, humanTakeover },
    `task ${id} reassigned to ${result.task.assignee} [${result.task.status}] ` +
      `version ${result.version}${humanTakeover ? ' (humanTakeover)' : ''}`,
  );
}

export async function runTaskCancel(
  client: AgentMeshClient,
  ctx: CommandContext,
): Promise<void> {
  const { taskId: id, expectedVersion } = cas(ctx);
  const reason = optionalString(ctx.args, 'reason');
  const result = await client.cancel({
    taskId: id,
    expectedVersion,
    ...(reason === undefined ? {} : { reason }),
  });
  emit(
    ctx,
    result,
    `task ${id} cancelled [${result.task.status}] version ${result.version}`,
  );
}
