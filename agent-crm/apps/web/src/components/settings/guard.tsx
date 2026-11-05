'use client';

import { EmptyState } from '@/components/shell/page-header';
import { useWorkspace } from '@/components/workspace-context';

export function RequireAccessAdmin({ children }: { children: React.ReactNode }) {
  const { metadata } = useWorkspace();
  if (!metadata.canManageAccess) return <EmptyState title="Admins only" description="You need the access management permission to open this page." />;
  return <>{children}</>;
}
