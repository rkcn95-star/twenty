'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, request } from '@/lib/api';
import type { Me, Metadata } from '@/lib/types';
import { WorkspaceContext } from '@/components/workspace-context';
import { Sidebar } from './sidebar';

export function WorkspaceShell({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const me = useQuery({ queryKey: ['me'], queryFn: () => request<Me>('/v1/me') });
  const metadata = useQuery({
    queryKey: ['metadata', workspaceId],
    queryFn: () => request<Metadata>('/v1/metadata', { workspaceId }),
    enabled: Boolean(me.data),
  });

  const notSignedIn = me.error instanceof ApiError && me.error.status === 403;
  useEffect(() => {
    if (notSignedIn) router.replace('/sign-in');
  }, [notSignedIn, router]);

  if (metadata.error) {
    return (
      <div className="flex h-screen items-center justify-center p-4">
        <div className="max-w-sm rounded-lg border bg-background p-5">
          <p className="font-medium">You cannot open this workspace</p>
          <p className="mt-1 text-muted-foreground">{metadata.error.message}</p>
          <Link className="mt-3 inline-block text-blue hover:underline" href="/w">Choose another workspace</Link>
        </div>
      </div>
    );
  }

  if (!me.data || !metadata.data) {
    return (
      <div className="flex h-screen gap-2 p-2">
        <Skeleton className="w-[212px]" />
        <Skeleton className="flex-1" />
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={{ workspaceId, me: me.data, metadata: metadata.data, refreshMetadata: () => metadata.refetch() }}>
      <div className="flex h-screen">
        <Sidebar />
        <main className="m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border bg-background">{children}</main>
      </div>
    </WorkspaceContext.Provider>
  );
}
