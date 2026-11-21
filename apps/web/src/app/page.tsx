'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { SdkProvider } from '@/lib/sdk-provider';
import { ToastProvider } from '@/lib/toast';

export default function HomePage() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Redirect to login if not on login page and not on dashboard (which handles auth)
    if (pathname !== '/login' && !pathname.startsWith('/dashboard')) {
      router.push('/login');
    }
  }, [pathname, router]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SdkProvider
      initialUrl={process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8787/ws'}
    >
      <ToastProvider>
        {children}
      </ToastProvider>
    </SdkProvider>
  );
}