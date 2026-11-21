/**
 * 全局 seq 去重注册表（US-019 决策 3）。
 * 同一 seq 跨列表（消息、任务、事件流）只渲染一次。
 * 这是一个简单的内存集合；页面刷新会重置（符合预期）。
 */

const seenSeqs = new Set<number>();

export function markSeqSeen(seq: number): boolean {
  if (seenSeqs.has(seq)) return false;
  seenSeqs.add(seq);
  return true;
}

export function hasSeqBeenSeen(seq: number): boolean {
  return seenSeqs.has(seq);
}

export function clearSeqRegistry(): void {
  seenSeqs.clear();
}

/**
 * Hook 版本，供组件在 SSR 安全的方式下使用。
 * 注意：这是客户端单例，只能在 'use client' 组件中使用。
 */
export function useSeqRegistry() {
  // 仅在客户端使用
  return {
    markSeqSeen,
    hasSeqBeenSeen,
    clearSeqRegistry,
  };
}