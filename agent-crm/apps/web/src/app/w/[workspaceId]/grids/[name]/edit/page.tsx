'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { GridDesigner } from '@/components/grids/grid-designer';
import { EmptyState } from '@/components/shell/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import type { GridDefinition } from '@/lib/grid';

export default function EditGridPage() {
  const { name } = useParams<{ name: string }>();
  const { workspaceId } = useWorkspace();
  const stored = useQuery({ queryKey: ['definition', workspaceId, 'grid', name], queryFn: () => callTool<{ definition: GridDefinition }>(workspaceId, 'get_definition', { kind: 'grid', name }) });
  if (stored.isPending) return <Skeleton className="m-3 h-40" />;
  if (stored.error) return <EmptyState title="Grid not found" description={stored.error.message} />;
  return <GridDesigner key={`${name}-${stored.dataUpdatedAt}`} initialName={name} initialDefinition={stored.data.definition} />;
}
