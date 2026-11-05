'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ReportBuilder } from '@/components/report/builder';
import { EmptyState } from '@/components/shell/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import type { ReportDefinition } from '@/lib/report';

export default function EditReportPage() {
  const { name } = useParams<{ name: string }>();
  const { workspaceId } = useWorkspace();
  const stored = useQuery({
    queryKey: ['definition', workspaceId, 'report', name],
    queryFn: () => callTool<{ definition: ReportDefinition }>(workspaceId, 'get_definition', { kind: 'report', name }),
  });

  if (stored.isPending) return <Skeleton className="m-3 h-40" />;
  if (stored.error) return <EmptyState title="Report not found" description={stored.error.message} />;
  return <ReportBuilder key={`${name}-${stored.dataUpdatedAt}`} initialName={name} initialDefinition={stored.data.definition} />;
}
