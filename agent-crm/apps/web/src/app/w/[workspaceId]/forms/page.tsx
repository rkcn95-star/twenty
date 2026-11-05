'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';

type DefinitionRow = { kind: string; name: string; updated_at: string };

export default function FormsPage() {
  const { workspaceId, metadata } = useWorkspace();
  const queryClient = useQueryClient();
  const base = `/w/${workspaceId}/forms`;
  const forms = useQuery({ queryKey: ['definitions', workspaceId, 'form'], queryFn: () => callTool<DefinitionRow[]>(workspaceId, 'list_definitions', { kind: 'form' }) });
  const remove = useMutation({
    mutationFn: (name: string) => callTool(workspaceId, 'delete_definition', { kind: 'form', name }),
    onSuccess: () => { toast.success('Form deleted'); void queryClient.invalidateQueries({ queryKey: ['definitions', workspaceId] }); },
    onError: (error) => toast.error(error.message),
  });
  const create = metadata.canBuild ? <Button size="sm" asChild><Link href={`${base}/new`}><Plus /> New form</Link></Button> : null;

  return (
    <>
      <PageHeader title="Forms" icon={<FileText />} actions={create} />
      <PageBody>
        {forms.data?.length === 0 ? (
          <EmptyState title="No forms yet" description="Design a form for one record, several linked records, or a header with repeating rows. Anyone with access can fill it in." action={create ?? undefined} />
        ) : (
          <Table>
            <TableHeader><TableRow className="h-8 hover:bg-transparent"><TableHead className="h-8">Name</TableHead><TableHead className="h-8">Updated</TableHead><TableHead className="h-8 w-16" /></TableRow></TableHeader>
            <TableBody>
              {forms.data?.map((form) => (
                <TableRow key={form.name} className="h-8">
                  <TableCell className="py-1"><Link className="font-medium hover:underline" href={`${base}/${form.name}`}>{form.name}</Link></TableCell>
                  <TableCell className="py-1 text-muted-foreground">{new Date(form.updated_at).toLocaleString()}</TableCell>
                  <TableCell className="py-1">
                    {metadata.canBuild ? (
                      <div className="flex">
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${form.name}`} asChild><Link href={`${base}/${form.name}/edit`}><Pencil /></Link></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${form.name}`} onClick={() => remove.mutate(form.name)}><Trash2 /></Button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </PageBody>
    </>
  );
}
