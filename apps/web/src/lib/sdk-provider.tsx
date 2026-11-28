'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AgentMeshClient, type ConnectionStatus, type EventName } from '@agentmesh/sdk';
import { clearSession, isAuthError, loadSession } from './session';

interface SdkContextValue {
  client: AgentMeshClient | null;
  status: ConnectionStatus;
  connect: (url: string, token?: string) => Promise<AgentMeshClient>;
  disconnect: () => void;
  /** Record a successful authentication (sets isAdmin/agentId for the UI). */
  markAuthenticated: (agentId: string, role: string) => void;
  isAdmin: boolean;
  agentId: string | null;
  /** True while a stored session is being restored on mount. */
  authRestoring: boolean;
}

const SdkContext = createContext<SdkContextValue | null>(null);

export function useSdk() {
  const ctx = useContext(SdkContext);
  if (!ctx) throw new Error('useSdk must be used within SdkProvider');
  return ctx;
}

interface SdkProviderProps {
  children: ReactNode;
  initialUrl?: string;
  initialToken?: string;
}

export function SdkProvider({ children, initialUrl, initialToken }: SdkProviderProps) {
  const clientRef = useRef<AgentMeshClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('closed');
  const [isAdmin, setIsAdmin] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [authRestoring, setAuthRestoring] = useState(true);

  /**
   * Shared connection handler (mount client and login-created clients alike):
   * track status, and when the server ends the session for a revoked token
   * (4401 → -32001), drop the stored session so the next visit does not
   * retry a dead token, and fall back to the login page. Transient drops
   * (no -32001 error) keep the stored session for the auto-reconnect.
   */
  const attachConnectionHandler = (client: AgentMeshClient): (() => void) =>
    client.onConnection((evt) => {
      setStatus(evt.status);
      if (evt.status === 'closed' && isAuthError(evt.error)) {
        clearSession();
        setIsAdmin(false);
        setAgentId(null);
      }
    });

  useEffect(() => {
    // Restore a stored login (localStorage JWT) so a refresh keeps the
    // session. A stored token that the server rejects (-32001: expired or
    // revoked) is discarded instead of retried.
    const stored = loadSession();
    const token = initialToken ?? stored?.token;
    const client = new AgentMeshClient({
      url: initialUrl || '',
      autoReconnect: true,
      gapPolicy: 'auto',
      ...(token ? { token } : {}),
    });
    clientRef.current = client;

    const unsubStatus = attachConnectionHandler(client);

    let cancelled = false;
    if (initialUrl) {
      client
        .connect()
        .then(() => {
          if (cancelled) return;
          if (stored !== null) {
            setAgentId(stored.agentId);
            setIsAdmin(stored.role === 'admin');
          }
          setAuthRestoring(false);
        })
        .catch((err: unknown) => {
          console.error('connect failed', err);
          if (stored !== null && isAuthError(err)) clearSession();
          if (!cancelled) setAuthRestoring(false);
        });
    } else {
      setAuthRestoring(false);
    }

    return () => {
      cancelled = true;
      unsubStatus();
      client.close();
    };
  }, [initialUrl, initialToken]);

  const connect = async (url: string, token?: string): Promise<AgentMeshClient> => {
    const existing = clientRef.current;
    if (existing && existing.state !== 'closed') existing.close();
    // Recreate with new URL/token.
    const newClient = new AgentMeshClient({
      url,
      autoReconnect: true,
      gapPolicy: 'auto',
      ...(token ? { token } : {}),
    });
    clientRef.current = newClient;

    attachConnectionHandler(newClient);

    try {
      await newClient.connect();
    } catch (err) {
      console.error('connect failed', err);
      throw err;
    }
    // Return the live client so callers authenticate against the NEW socket,
    // not a stale reference captured before this reconnect.
    return newClient;
  };

  const disconnect = () => {
    clearSession();
    clientRef.current?.close();
    setStatus('closed');
    setIsAdmin(false);
    setAgentId(null);
  };

  const markAuthenticated = (id: string, role: string) => {
    setAgentId(id);
    setIsAdmin(role === 'admin');
  };

  return (
    <SdkContext.Provider
      value={{
        client: clientRef.current,
        status,
        connect,
        disconnect,
        markAuthenticated,
        isAdmin,
        agentId,
        authRestoring,
      }}
    >
      {children}
    </SdkContext.Provider>
  );
}