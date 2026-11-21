'use client';

import { useEffect, useState } from 'react';
import { useSdk } from '@/lib/sdk-provider';
import { useToast } from '@/lib/toast';
import { markSeqSeen } from '@/lib/seq-registry';
import type { ChannelView, MessageView, MessageHistoryResult } from '@agentmesh/sdk';

type HistoryResult = MessageHistoryResult;

export default function ChannelsPage() {
  const { client } = useSdk();
  const { showToast } = useToast();

  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<ChannelView | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [createName, setCreateName] = useState('');
  const [creating, setCreating] = useState(false);
  const [cursorBefore, setCursorBefore] = useState<number | null>(null);
  const [cursorAfter, setCursorAfter] = useState<number | null>(null);

  // Load channels on mount
  useEffect(() => {
    if (!client) return;
    loadChannels();
  }, [client]);

  // Real-time message subscription
  useEffect(() => {
    if (!client || !selectedChannel) return;

    const unsub = client.on('message.new', (payload: MessageView) => {
      if (payload.channelId !== selectedChannel.channelId) return;
      const seq = payload.seq ?? 0;
      if (markSeqSeen(seq)) {
        setMessages((prev) => {
          if (prev.some((m) => (m.seq ?? 0) === seq)) return prev;
          return [...prev, payload].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        });
      }
    });

    return unsub;
  }, [client, selectedChannel]);

  const loadChannels = async () => {
    if (!client) return;
    try {
      const result = await client.listChannels({ limit: 100 });
      setChannels(result.channels);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载频道失败', 'error');
    }
  };

  const handleCreateChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || !createName.trim()) return;
    setCreating(true);
    try {
      const result = await client.createChannel({ name: createName.trim() });
      showToast(`创建频道成功: ${result.channel.name}`, 'success');
      setCreateName('');
      loadChannels();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '创建失败', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleJoinChannel = async (channelId: string) => {
    if (!client) return;
    try {
      await client.joinChannel({ channelId });
      showToast('已加入频道', 'success');
      loadChannels();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加入失败', 'error');
    }
  };

  const handleLeaveChannel = async (channelId: string) => {
    if (!client) return;
    try {
      await client.leaveChannel({ channelId });
      showToast('已离开频道', 'info');
      if (selectedChannel?.channelId === channelId) {
        setSelectedChannel(null);
        setMessages([]);
        setHistory(null);
      }
      loadChannels();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '离开失败', 'error');
    }
  };

  const selectChannel = async (channel: ChannelView) => {
    if (!client) return;
    setSelectedChannel(channel);
    setMessages([]);
    setHistory(null);
    setCursorBefore(null);
    setCursorAfter(null);
    await loadHistory(channel.channelId);
  };

  const loadHistory = async (channelId: string, options: { beforeSeq?: number; afterSeq?: number } = {}) => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.history({
        channelId,
        ...(options.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
        ...(options.afterSeq !== undefined ? { afterSeq: options.afterSeq } : {}),
        limit: 50,
      });
      setHistory(result);
      const filtered = result.messages.filter((m) => markSeqSeen(m.seq ?? 0));
      setMessages((prev) => {
        const combined = [...prev, ...filtered];
        const unique = new Map(combined.map((m) => [(m.seq ?? 0), m]));
        return Array.from(unique.values()).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      });
      setCursorBefore(result.nextBeforeSeq);
      setCursorAfter(result.nextAfterSeq);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '加载历史失败', 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadMoreBefore = () => {
    if (cursorBefore !== null && selectedChannel) {
      loadHistory(selectedChannel.channelId, { beforeSeq: cursorBefore });
    }
  };

  const loadMoreAfter = () => {
    if (cursorAfter !== null && selectedChannel) {
      loadHistory(selectedChannel.channelId, { afterSeq: cursorAfter });
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!client || !selectedChannel || !newMessage.trim() || sending) return;
    setSending(true);
    try {
      const result = await client.sendMessage({
        channelId: selectedChannel.channelId,
        body: newMessage.trim(),
      });
      setNewMessage('');
      showToast('发送成功', 'success');
      // Message will appear via real-time subscription
    } catch (err) {
      showToast(err instanceof Error ? err.message : '发送失败', 'error');
    } finally {
      setSending(false);
    }
  };

  const formatTime = (ts: number) => new Date(ts).toLocaleString();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 600 }}>频道</h1>
        <form onSubmit={handleCreateChannel} style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="新频道名称"
            style={{ width: 200 }}
            disabled={creating}
          />
          <button type="submit" className="btn btn-primary" disabled={creating || !createName.trim()}>
            {creating ? '创建中...' : '创建频道'}
          </button>
        </form>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 24 }}>
        {/* Channel List */}
        <div className="card" style={{ height: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column' }}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
            频道列表 ({channels.length})
          </h2>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {channels.length === 0 ? (
              <div className="empty-state" style={{ padding: 32 }}>
                <p>暂无频道</p>
                <p style={{ fontSize: 12 }}>点击上方创建第一个频道</p>
              </div>
            ) : (
              <ul style={{ listStyle: 'none' }}>
                {channels.map((channel) => (
                  <li
                    key={channel.channelId}
                    style={{
                      padding: '12px',
                      margin: '4px 0',
                      borderRadius: 'var(--radius-sm)',
                      background: selectedChannel?.channelId === channel.channelId
                        ? 'rgba(79, 209, 197, 0.1)'
                        : 'transparent',
                      border: selectedChannel?.channelId === channel.channelId
                        ? '1px solid var(--accent)'
                        : '1px solid transparent',
                      cursor: 'pointer',
                      transition: 'background var(--transition)',
                    }}
                    onClick={() => selectChannel(channel)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                      <strong>{channel.name}</strong>
                      <span className="badge badge-done" style={{ fontSize: 10 }}>{channel.memberCount}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                      ID: {channel.channelId.slice(0, 16)}...
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
                      {channel.joined ? '✓ 已加入' : '未加入'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="card" style={{ height: 'calc(100vh - 160px)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)', marginBottom: 16 }}>
            {selectedChannel ? (
              <>
                <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{selectedChannel.name}</h2>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  {selectedChannel.channelId} · 成员 {selectedChannel.memberCount} ·
                  {history ? `共 ${history.channelTotal} 条` : '加载中...'}
                </div>
              </>
            ) : (
              <p style={{ color: 'var(--fg-muted)' }}>选择一个频道查看消息</p>
            )}
          </div>

          {selectedChannel ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {/* Load more before */}
              {cursorBefore !== null && history?.hasMoreBefore && (
                <button
                  className="btn btn-ghost"
                  onClick={loadMoreBefore}
                  disabled={loading}
                  style={{ alignSelf: 'center', marginBottom: 8, fontSize: 12 }}
                >
                  {loading ? '加载中...' : '加载更早消息'}
                </button>
              )}

              {/* Messages list */}
              <div
                style={{ flex: 1, overflow: 'auto', padding: '0 8px 8px' }}
                className="scrollbar-thin"
              >
                {messages.length === 0 ? (
                  <div className="empty-state" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <p>暂无消息</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {messages.map((msg) => (
                      <div
                        key={msg.messageId}
                        style={{
                          padding: '10px 12px',
                          background: 'var(--bg-elevated)',
                          borderRadius: 'var(--radius-sm)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                          <strong style={{ color: 'var(--accent)' }}>{msg.senderId}</strong>
                          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                            {formatTime(msg.createdAt)}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--fg-muted)', marginLeft: 'auto' }}>
                            seq: {msg.seq}
                          </span>
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {msg.content ?? msg.body ?? ''}
                        </div>
                        {msg.replyToMessageId && (
                          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
                            回复: {msg.replyToMessageId}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Load more after / Send */}
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
                {cursorAfter !== null && history?.hasMoreAfter && (
                  <button
                    className="btn btn-ghost"
                    onClick={loadMoreAfter}
                    disabled={loading}
                    style={{ marginBottom: 12, fontSize: 12 }}
                  >
                    {loading ? '加载中...' : '加载最新消息'}
                  </button>
                )}
                <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    placeholder="输入消息..."
                    style={{ flex: 1 }}
                    disabled={sending}
                  />
                  <button type="submit" className="btn btn-primary" disabled={sending || !newMessage.trim()}>
                    {sending ? '发送中...' : '发送'}
                  </button>
                </form>
              </div>
            </div>
          ) : (
            <div className="empty-state" style={{ flex: 1 }}>
              <p>选择左侧频道开始聊天</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}