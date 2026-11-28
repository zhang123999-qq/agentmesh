'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSdk } from '@/lib/sdk-provider';
import { saveSession } from '@/lib/session';
import { useToast } from '@/lib/toast';
import { mapLoginError } from '@/lib/admin-errors';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { client, connect, markAuthenticated } = useSdk();
  const { showToast } = useToast();
  const redirectTo = searchParams.get('redirect') || '/dashboard';

  const [agentId, setAgentId] = useState('');
  const [secret, setSecret] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (!client) {
      showToast('SDK 未初始化', 'error');
      setLoading(false);
      return;
    }

    try {
      // 先断开现有连接
      if (client.state !== 'closed') {
        client.close();
      }

      // 获取 WebSocket URL
      const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8787/ws';

      // connect() returns the NEW client; authenticate on it (the context's
      // `client` is the pre-reconnect reference and would be closed).
      const active = await connect(wsUrl);

      const result = await active.authenticate({
        agentId: agentId.trim(),
        secret: secret.trim(),
      });

      if (result.role !== 'admin') {
        showToast('需要 admin 角色才能进入管理后台', 'error');
        active.close();
        return;
      }

      // Record the authenticated session so the dashboard layout stops showing
      // "please log in" and renders the admin navigation.
      markAuthenticated(result.agentId, result.role);
      // Persist the issued JWT so a refresh restores the login instead of
      // dropping it (the secret itself is never stored).
      if (result.token !== undefined) {
        saveSession({ token: result.token, agentId: result.agentId, role: result.role });
      }
      showToast(`登录成功：${result.agentId}`, 'success');
      router.push(redirectTo);
      router.refresh();
    } catch (err: unknown) {
      showToast(mapLoginError(err).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 400 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>AgentMesh Admin</h1>
        <p style={{ color: 'var(--fg-muted)', marginBottom: 24 }}>
          使用 admin 账号登录管理后台
        </p>

        {error && (
          <div
            className="toast error"
            style={{ marginBottom: 16 }}
            role="alert"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="agentId">Agent ID</label>
            <input
              id="agentId"
              type="text"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agt_..."
              required
              autoComplete="username"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="secret">Secret</label>
            <input
              id="secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="注册时获得的 secret"
              required
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', marginTop: 8 }}
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="spinner" style={{ width: 18, height: 18 }} />
                登录中...
              </>
            ) : (
              '登录'
            )}
          </button>
        </form>

        <p style={{ marginTop: 16, fontSize: 12, color: 'var(--fg-muted)' }}>
          只有 admin 角色可登录管理后台。Agent 请使用 CLI 或 SDK。
        </p>
      </div>
    </div>
  );
}