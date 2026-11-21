/**
 * Human-readable renderers. Every command still supports `--json` with the
 * exact SDK response shape; these helpers are for people reading a terminal.
 */

import type {
  BidView,
  ChannelView,
  MessageHistoryResult,
  TaskView,
} from '@agentmesh/sdk';

export function formatTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  if (rows.length === 0) return '(none)';
  const widths = headers.map((header, column) => {
    const cellWidth = rows.reduce(
      (max, row) => Math.max(max, (row[column] ?? '').length),
      0,
    );
    return Math.max(header.length, cellWidth);
  });
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function formatTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return '-';
  return new Date(epochMs).toISOString();
}

export function formatPercent(progress: number): string {
  return `${Math.round(progress)}%`;
}

export function formatTask(task: TaskView): string {
  const lines = [
    `task ${task.id} [${task.status}] version ${task.version}`,
    `  title:      ${task.title}`,
    `  assignee:   ${task.assignee ?? '-'}`,
    `  progress:   ${formatPercent(task.progress)}`,
    `  budget:     ${task.budget}`,
    `  skills:     ${task.requiredSkills.length === 0 ? '-' : task.requiredSkills.join(', ')}`,
    `  parent:     ${task.parentId ?? '-'}`,
    `  blockedBy:  ${task.blockedBy.length === 0 ? '-' : task.blockedBy.join(', ')}`,
    `  deadline:   ${formatTime(task.deadline)}`,
    `  bidding:    ${formatTime(task.biddingDeadline)}`,
    `  completed:  ${formatTime(task.completedAt)}`,
    `  updated:    ${formatTime(task.updatedAt)}`,
  ];
  if (task.description.length > 0) {
    lines.push(`  description: ${task.description}`);
  }
  return lines.join('\n');
}

export function formatTasks(tasks: readonly TaskView[]): string {
  return formatTable(
    ['ID', 'STATUS', 'VERSION', 'ASSIGNEE', 'PROGRESS', 'TITLE'],
    tasks.map((task) => [
      task.id,
      task.status,
      String(task.version),
      task.assignee ?? '-',
      formatPercent(task.progress),
      task.title,
    ]),
  );
}

export function formatChannels(channels: readonly ChannelView[]): string {
  return formatTable(
    ['ID', 'NAME', 'MEMBERS', 'JOINED', 'CREATED'],
    channels.map((channel) => [
      channel.channelId,
      channel.name,
      String(channel.memberCount),
      channel.joined ? 'yes' : 'no',
      formatTime(channel.createdAt),
    ]),
  );
}

export function formatBids(bids: readonly BidView[]): string {
  return formatTable(
    ['BID', 'AGENT', 'PRICE', 'ETA', 'CONFIDENCE', 'CREATED'],
    bids.map((bid) => [
      bid.bidId,
      bid.agentId,
      String(bid.price),
      bid.eta === null ? '-' : String(bid.eta),
      bid.confidence === null ? '-' : String(bid.confidence),
      formatTime(bid.createdAt),
    ]),
  );
}

export function formatHistory(result: MessageHistoryResult): string {
  const header =
    `channel ${result.channelId} — ${result.channelTotal} message(s) total, ` +
    `${result.messages.length} shown; more before: ${result.hasMoreBefore ? 'yes' : 'no'}, ` +
    `more after: ${result.hasMoreAfter ? 'yes' : 'no'}`;
  const lines = result.messages.map(
    (message) => `[${message.seq}] ${message.senderId}: ${message.body}`,
  );
  return [header, ...lines].join('\n');
}
