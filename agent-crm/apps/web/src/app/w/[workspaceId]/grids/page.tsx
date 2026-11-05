'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Table2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';

type DefinitionRow = { kind: string; name: string; updated_at: string };

export default function GridsPage() {
  const { workspaceId, metadata } = useWorkspace();
  const queryClient = useQueryClient();
  const base = `/w/${workspaceId}/grids`;
  const grids = useQuery({ queryKey: ['definitions', workspaceId, 'grid'], queryFn: () => callTool<DefinitionRow[]>(workspaceId, 'list_definitions', { kind: 'grid' }) });
  const remove = useMutation({
    mutationFn: (name: string) => callTool(workspaceId, 'delete_definition', { kind: 'grid', name }),
    onSuccess: () => { toast.success('Grid deleted'); void queryClient.invalidateQueries({ queryKey: ['definitions', workspaceId] }); },
    onError: (error) => toast.error(error.message),
  });
  const create = metadata.canBuild ? <Button size="sm" asChild><Link href={`${base}/new`}><Plus /> New grid</Link></Button> : null;

  return (
    <>
      <PageHeader title="Data grids" icon={<Table2 />} actions={create} />
      <PageBody>
        {grids.data?.length === 0 ? (
          <EmptyState title="No grids yet" description="A grid is a table of records with the columns, filter and one-click actions you choose, like marking deals as won." action={create ?? undefined} />
        ) : (
          <Table>
            <TableHeader><TableRow className="h-8 hover:bg-transparent"><TableHead className="h-8">Name</TableHead><TableHead className="h-8">Updated</TableHead><TableHead className="h-8 w-16" /></TableRow></TableHeader>
            <TableBody>
              {grids.data?.map((grid) => (
                <TableRow key={grid.name} className="h-8">
                  <TableCell className="py-1"><Link className="font-medium hover:underline" href={`${base}/${grid.name}`}>{grid.name}</Link></TableCell>
                  <TableCell className="py-1 text-muted-foreground">{new Date(grid.updated_at).toLocaleString()}</TableCell>
                  <TableCell className="py-1">
                    {metadata.canBuild ? (
                      <div className="flex">
                        <Button size="icon-sm" variant="ghost" aria-label={`Edit ${grid.name}`} asChild><Link href={`${base}/${grid.name}/edit`}><Pencil /></Link></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`Delete ${grid.name}`} onClick={() => remove.mutate(grid.name)}><Trash2 /></Button>
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
