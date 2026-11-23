'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AgentMeshClient, type ConnectionStatus, type EventName } from '@agentmesh/sdk';

interface SdkContextValue {
  client: AgentMeshClient | null;
  status: ConnectionStatus;
  connect: (url: string, token?: string) => Promise<AgentMeshClient>;
  disconnect: () => void;
  isAdmin: boolean;
  agentId: string | null;
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

  useEffect(() => {
    const client = new AgentMeshClient({
      url: initialUrl || '',
      autoReconnect: true,
      gapPolicy: 'auto',
      ...(initialToken ? { token: initialToken } : {}),
    });
    clientRef.current = client;

    const unsubStatus = client.onConnection((evt) => {
      setStatus(evt.status);
    });

    if (initialUrl) {
      client.connect().catch(console.error);
    }

    return () => {
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

    newClient.onConnection((evt) => setStatus(evt.status));

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
    clientRef.current?.close();
    setStatus('closed');
    setIsAdmin(false);
    setAgentId(null);
  };

  return (
    <SdkContext.Provider
      value={{
        client: clientRef.current,
        status,
        connect,
        disconnect,
        isAdmin,
        agentId,
      }}
    >
      {children}
    </SdkContext.Provider>
  );
}