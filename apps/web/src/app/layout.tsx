import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { Providers } from './page';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'AgentMesh Admin Console',
  description: 'AgentMesh 管理后台 — 任务、频道、智能体协作平台',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className={inter.className}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}