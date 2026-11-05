'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { FormRenderer } from '@/components/forms/form-renderer';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import type { FormDefinition } from '@/lib/form';
import { loadFormState } from '@/lib/form-load';

function RunForm() {
  const { name } = useParams<{ name: string }>();
  const recordId = useSearchParams().get('record') ?? undefined;
  const { workspaceId, metadata } = useWorkspace();
  const queryClient = useQueryClient();
  const [submissions, setSubmissions] = useState(0);

  const definition = useQuery({
    queryKey: ['definition', workspaceId, 'form', name],
    queryFn: async () => (await callTool<{ definition: FormDefinition }>(workspaceId, 'get_definition', { kind: 'form', name })).definition,
  });
  const initial = useQuery({
    queryKey: ['form-record', workspaceId, name, recordId],
    enabled: Boolean(definition.data && recordId),
    queryFn: () => loadFormState(workspaceId, definition.data!, metadata, recordId!),
  });

  const loading = definition.isPending || (Boolean(recordId) && initial.isPending);
  return (
    <>
      <PageHeader
        title={name}
        icon={<FileText />}
        actions={metadata.canBuild ? <Button size="sm" variant="ghost" asChild><Link href={`/w/${workspaceId}/forms/${name}/edit`}><Pencil /> Edit form</Link></Button> : null}
      />
      <PageBody className="p-4">
        <div className="mx-auto max-w-2xl">
          {loading ? <Skeleton className="h-40" /> : null}
          {definition.error ? <EmptyState title="Form not found" description={definition.error.message} /> : null}
          {initial.error ? <EmptyState title="Could not load the record" description={initial.error.message} /> : null}
          {definition.data?.kind === 'multi' && recordId ? <EmptyState title="Multi-record forms are create-only" description="Open the records from their own tables to edit them." /> : null}
          {definition.data && !loading && !initial.error && !(definition.data.kind === 'multi' && recordId) ? (
            <>
              {recordId ? <p className="mb-3 text-muted-foreground">Editing an existing record.</p> : null}
              <FormRenderer
                key={`${recordId ?? 'new'}-${submissions}-${initial.dataUpdatedAt}`}
                definition={definition.data}
                mode="run"
                recordId={recordId}
                initial={initial.data}
                onSubmit={async (submission) => {
                  await callTool(workspaceId, 'submit_form', { name, ...submission });
                  await queryClient.invalidateQueries({ queryKey: ['records', workspaceId] });
                  toast.success(recordId ? 'Changes saved' : 'Submitted');
                  setSubmissions((count) => count + 1);
                }}
              />
            </>
          ) : null}
        </div>
      </PageBody>
    </>
  );
}

export default function RunFormPage() {
  return <Suspense><RunForm /></Suspense>;
}
