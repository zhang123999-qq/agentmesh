'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSdk } from '@/lib/sdk-provider';
import { useToast } from '@/lib/toast';

const navigation = [
  { href: '/dashboard', label: '概览', icon: '📊' },
  { href: '/dashboard/channels', label: '频道', icon: '💬' },
  { href: '/dashboard/tasks', label: '任务', icon: '📋' },
  { href: '/dashboard/events', label: '事件流', icon: '📡' },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { status, client, isAdmin, disconnect, authRestoring } = useSdk();
  const { showToast } = useToast();

  useEffect(() => {
    // Only reconnect while the user is still authenticated: after a logout
    // or a revoked-token close (4401) isAdmin is false, and reconnecting
    // would loop against a dead token.
    if (status === 'closed' && client && isAdmin) {
      // 尝试恢复连接
      client.connect().catch(console.error);
    }
  }, [status, client, isAdmin]);

  const handleLogout = () => {
    disconnect();
    showToast('已登出', 'info');
  };

  // While a stored session is being restored, do not flash the login prompt.
  if (authRestoring) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <p>正在恢复登录…</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <p>请先以 admin 身份登录</p>
        <Link href="/login" className="btn btn-primary" style={{ marginTop: 16 }}>
          登录
        </Link>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 'var(--sidebar-w)',
          background: 'var(--bg-elevated)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🕸️</span> AgentMesh
          </h1>
        </div>

        <nav style={{ flex: 1, padding: 12, overflow: 'auto' }}>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {navigation.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    color: pathname === item.href ? 'var(--accent)' : 'var(--fg)',
                    background: pathname === item.href ? 'rgba(79, 209, 197, 0.1)' : 'transparent',
                    fontWeight: pathname === item.href ? 600 : 400,
                    textDecoration: 'none',
                    transition: 'background var(--transition), color var(--transition)',
                  }}
                >
                  <span style={{ fontSize: 18 }}>{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div style={{ padding: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span
              className={`badge ${status === 'connected' ? 'badge-done' : 'badge-failed'}`}
              style={{ fontSize: 10 }}
            >
              {status}
            </span>
          </div>
          <button
            onClick={handleLogout}
            className="btn btn-ghost"
            style={{ width: '100%', justifyContent: 'center' }}
          >
            登出
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {children}
      </main>
    </div>
  );
}