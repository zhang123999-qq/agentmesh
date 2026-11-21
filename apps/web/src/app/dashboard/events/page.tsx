'use client';

import { useEffect, useState, useRef } from 'react';
import { useSdk } from '@/lib/sdk-provider';
import { useToast } from '@/lib/toast';
import { markSeqSeen } from '@/lib/seq-registry';

interface EventNotification {
  seq: number;
  aggregateId: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  ts: number;
  prevHash?: string;
}

const NOTIFICATION_TYPES: string[] = [
  'presence.update',
  'message.new',
  'task.bid.received',
  'task.awarded',
  'task.progress.updated',
  'task.completed',
  'task.failed',
  'task.review.decided',
  'task.reassigned',
  'task.cancelled',
  'task.dependency.failed',
  'system.error',
];

const DOMAIN_ONLY_TYPES: string[] = [
  'account.registered',
  'account.authenticated',
  'channel.created',
  'channel.member.joined',
  'channel.member.left',
  'message.created',
  'task.published',
  'task.status.changed',
  'task.bid.placed',
  'task.progress.reported',
];

const formatTime = (ts: number) => new Date(ts).toLocaleString();

const formatPayload = (type: string, payload: Record<string, unknown>): string => {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'approach' && typeof value === 'string' && value.length > 100) {
      lines.push(`${key}: ${value.slice(0, 100)}...`);
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
};

export default function EventsPage() {
  const { client, connect } = useSdk();
  const { showToast } = useToast();

  const [events, setEvents] = useState<EventNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [auditMode, setAuditMode] = useState(false);
  const [filterType, setFilterType] = useState<string>('');
  const [pause, setPause] = useState(false);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const unsubRef = useRef<(() => void)[]>([]);

  useEffect(() => {
    if (!client) return;
    const init = async () => {
      try {
        if (client.state === 'closed') {
          const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8787/ws';
          await connect(wsUrl);
        }
        // Fetch available event types from a quick history call or just use constants
        setEventTypes([...NOTIFICATION_TYPES, ...DOMAIN_ONLY_TYPES]);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '连接失败', 'error');
      }
    };
    init();
  }, [client, connect]);

  const cleanupSubscriptions = () => {
    for (const unsub of unsubRef.current) unsub();
    unsubRef.current = [];
  };

  const subscribeToEvents = (types: string[]) => {
    cleanupSubscriptions();
    if (!client) return;

    for (const type of types) {
      const unsub = client.on(type as 'message.new', (payload: Record<string, unknown>, envelope?: { seq: number }) => {
        if (pause) return;
        if (filterType && type !== filterType) return;
        const seq = envelope?.seq ?? 0;
        if (seq > 0 && !markSeqSeen(seq)) return; // dedupe

        const event: EventNotification = {
          seq,
          aggregateId: '', // not in notification
          type,
          version: 0, // not in notification
          payload,
          ts: Date.now(),
        };
        setEvents((prev) => [event, ...prev].slice(0, 500)); // keep last 500
      });
      unsubRef.current.push(unsub);
    }
  };

  const handleSubscribe = async () => {
    if (!client) return;
    try {
      if (auditMode) {
        // Call system.subscribe with includeDomainEvents: true
        await client.sendRaw({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'system.subscribe',
          params: {
            includeDomainEvents: true,
            types: filterType ? [filterType] : undefined,
          },
        });
      }
      // Subscribe to notification events
      const typesToWatch = auditMode
        ? [...NOTIFICATION_TYPES, ...DOMAIN_ONLY_TYPES]
        : NOTIFICATION_TYPES;
      subscribeToEvents(filterType ? [filterType] : typesToWatch);
      setSubscribed(true);
      showToast(auditMode ? '审计视图已启用（含 domain 事件）' : '实时事件流已启用', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '订阅失败', 'error');
    }
  };

  const handleUnsubscribe = () => {
    cleanupSubscriptions();
    setSubscribed(false);
    showToast('已取消订阅', 'info');
  };

  const handleClear = () => {
    setEvents([]);
    showToast('已清空', 'info');
  };

  const handleResync = async () => {
    if (!client) return;
    try {
      // For events, we'd need a different approach; here we just reconnect
      if (client.state !== 'closed') client.close();
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8787/ws';
      await connect(wsUrl);
      showToast('重新同步请求已发送', 'info');
    } catch (err) {
      showToast(err instanceof Error ? err.message : '重新同步失败', 'error');
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>事件流</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={auditMode}
              onChange={(e) => setAuditMode(e.target.checked)}
              disabled={subscribed}
            />
            <span>审计视图</span>
            <span className="badge badge-open" style={{ fontSize: 10 }}>Admin Only</span>
          </label>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{ padding: '6px 10px', fontSize: 12, background: 'var(--input-bg)', border: '1px solid var(--input-border)', borderRadius: 'var(--radius-sm)', color: 'var(--fg)' }}
          >
            <option value="">全部事件类型</option>
            {eventTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={pause}
              onChange={(e) => setPause(e.target.checked)}
            />
            暂停
          </label>

          {!subscribed ? (
            <button className="btn btn-primary" onClick={handleSubscribe}>
              {auditMode ? '启用审计视图' : '启用实时流'}
            </button>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={handleClear}>
                清空
              </button>
              <button className="btn btn-danger" onClick={handleUnsubscribe}>
                停止
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ height: 'calc(100vh - 200px)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)', marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>
              {subscribed ? (auditMode ? '审计视图' : '实时事件流') : '未订阅'}
              <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--fg-muted)' }}>
                事件数: {events.length}
              </span>
            </h2>
            <button className="btn btn-ghost" onClick={handleResync} style={{ fontSize: 12 }}>
              重新同步
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }} className="scrollbar-thin">
          {events.length === 0 ? (
            <div className="empty-state" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12 }}>
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                style={{ opacity: 0.5 }}
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
              {subscribed ? (
                <>
                  <p>等待事件...</p>
                  <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                    {auditMode ? '审计视图包含 domain-only 事件' : '仅显示 notification 事件'}
                  </p>
                </>
              ) : (
                <>
                  <p>点击上方按钮开始接收实时事件</p>
                  <p style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                    审计视图需要 admin 权限，会调用 system.subscribe
                  </p>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {events.map((event) => (
                <div
                  key={event.seq}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    background: event.seq % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)',
                    transition: 'background var(--transition)',
                  }}
                >
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 8 }}>
                    <span className="badge badge-open" style={{ fontSize: 10, minWidth: 160, flexShrink: 0 }}>
                      {event.type}
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--accent)' }}>
                      seq: {event.seq}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                      {formatTime(event.ts)}
                    </span>
                    {(event.payload.taskId as string | undefined) && (
                      <span style={{ fontSize: 11, color: 'var(--warning)' }}>
                        task: {String(event.payload.taskId).slice(0, 20)}...
                      </span>
                    )}
                    {(event.payload.channelId as string | undefined) && (
                      <span style={{ fontSize: 11, color: 'var(--warning)' }}>
                        channel: {String(event.payload.channelId).slice(0, 20)}...
                      </span>
                    )}
                  </div>
                  <pre
                    style={{
                      fontSize: 11,
                      color: 'var(--fg-muted)',
                      background: 'var(--input-bg)',
                      padding: '8px',
                      borderRadius: 'var(--radius-sm)',
                      overflow: 'auto',
                      maxHeight: 200,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {formatPayload(event.type, event.payload)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}