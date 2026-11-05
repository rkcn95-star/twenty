'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { FormDesigner } from '@/components/forms/form-designer';
import { EmptyState } from '@/components/shell/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import type { FormDefinition } from '@/lib/form';

export default function EditFormPage() {
  const { name } = useParams<{ name: string }>();
  const { workspaceId } = useWorkspace();
  const stored = useQuery({ queryKey: ['definition', workspaceId, 'form', name], queryFn: () => callTool<{ definition: FormDefinition }>(workspaceId, 'get_definition', { kind: 'form', name }) });
  if (stored.isPending) return <Skeleton className="m-3 h-40" />;
  if (stored.error) return <EmptyState title="Form not found" description={stored.error.message} />;
  return <FormDesigner key={`${name}-${stored.dataUpdatedAt}`} initialName={name} initialDefinition={stored.data.definition} />;
}
