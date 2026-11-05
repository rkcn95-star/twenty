'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { EmptyState, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';

type DefinitionRow = { kind: string; name: string; updated_at: string };

export default function ReportsPage() {
  const { workspaceId, metadata } = useWorkspace();
  const queryClient = useQueryClient();
  const base = `/w/${workspaceId}/reports`;
  const reports = useQuery({
    queryKey: ['definitions', workspaceId, 'report'],
    queryFn: () => callTool<DefinitionRow[]>(workspaceId, 'list_definitions', { kind: 'report' }),
  });
  const remove = useMutation({
    mutationFn: (name: string) => callTool(workspaceId, 'delete_definition', { kind: 'report', name }),
    onSuccess: () => { toast.success('Report deleted'); void queryClient.invalidateQueries({ queryKey: ['definitions', workspaceId] }); },
    onError: (error) => toast.error(error.message),
  });
  const create = <Button size="sm" asChild><Link href={`${base}/new`}><Plus /> New report</Link></Button>;

  return (
    <>
      <PageHeader title="Reports" icon={<BarChart3 />} actions={create} />
      <PageBody>
        {reports.data?.length === 0 ? (
          <EmptyState title="No reports yet" description="Pick an object, choose columns, group and filter, and see the result and the SQL as you go." action={create} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="h-8 hover:bg-transparent"><TableHead className="h-8">Name</TableHead><TableHead className="h-8">Updated</TableHead><TableHead className="h-8 w-8" /></TableRow>
            </TableHeader>
            <TableBody>
              {reports.data?.map((report) => (
                <TableRow key={report.name} className="h-8">
                  <TableCell className="py-1"><Link className="font-medium hover:underline" href={`${base}/${report.name}`}>{report.name}</Link></TableCell>
                  <TableCell className="py-1 text-muted-foreground">{new Date(report.updated_at).toLocaleString()}</TableCell>
                  <TableCell className="py-1">
                    {metadata.canBuild ? <Button size="icon-sm" variant="ghost" aria-label={`Delete ${report.name}`} onClick={() => remove.mutate(report.name)}><Trash2 /></Button> : null}
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
