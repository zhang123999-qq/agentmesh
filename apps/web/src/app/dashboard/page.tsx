'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSdk } from '@/lib/sdk-provider';

interface Stats {
  totalAgents: number;
  totalChannels: number;
  totalTasks: number;
  tasksByStatus: Record<string, number>;
}

export default function DashboardPage() {
  const { client } = useSdk();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;

    const fetchStats = async () => {
      try {
        setLoading(true);
        const [agents, channels, tasks] = await Promise.all([
          client.listAccounts({ limit: 1000 }),
          client.listChannels({ limit: 1000 }),
          client.listTasks({ limit: 1000 }),
        ]);

        const tasksByStatus: Record<string, number> = {};
        for (const task of tasks.tasks) {
          tasksByStatus[task.status] = (tasksByStatus[task.status] || 0) + 1;
        }

        setStats({
          totalAgents: agents.total,
          totalChannels: channels.total,
          totalTasks: tasks.total,
          tasksByStatus,
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : '获取统计失败');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [client]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 48 }}>
        <div className="spinner" style={{ width: 32, height: 32 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ maxWidth: 600, margin: '0 auto', marginTop: 48 }}>
        <p style={{ color: 'var(--danger)' }}>加载失败：{error}</p>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 24 }}>概览</h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
          marginBottom: 32,
        }}
      >
        <Link href="/dashboard/channels" className="card" style={{ textDecoration: 'none', transition: 'transform var(--transition), box-shadow var(--transition)' }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>频道总数</div>
          <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--accent)' }}>{stats?.totalChannels ?? 0}</div>
        </Link>

        <Link href="/dashboard/tasks" className="card" style={{ textDecoration: 'none', transition: 'transform var(--transition), box-shadow var(--transition)' }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>任务总数</div>
          <div style={{ fontSize: 36, fontWeight: 700 }}>{stats?.totalTasks ?? 0}</div>
        </Link>

        <Link href="/dashboard" className="card" style={{ textDecoration: 'none', transition: 'transform var(--transition), box-shadow var(--transition)' }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>智能体总数</div>
          <div style={{ fontSize: 36, fontWeight: 700 }}>{stats?.totalAgents ?? 0}</div>
        </Link>

        <Link href="/dashboard/events" className="card" style={{ textDecoration: 'none', transition: 'transform var(--transition), box-shadow var(--transition)' }}>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>事件流</div>
          <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--warning)' }}>实时监控</div>
        </Link>
      </div>

      <div className="card">
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>任务状态分布</h2>
        {stats && Object.keys(stats.tasksByStatus).length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {Object.entries(stats.tasksByStatus).map(([status, count]) => (
              <Link
                key={status}
                href={`/dashboard/tasks?status=${status}`}
                className="btn btn-ghost"
                style={{ textDecoration: 'none' }}
              >
                <span className={`badge badge-${status}`} style={{ marginRight: 8 }}>{status}</span>
                {count}
              </Link>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--fg-muted)' }}>暂无任务</p>
        )}
      </div>
    </div>
  );
}