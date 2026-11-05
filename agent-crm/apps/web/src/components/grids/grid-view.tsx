'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Pencil, Table2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { EmptyState, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { columnType, resolveColumn, type GridColumnDef } from '@/lib/grid';
import { GridTable, type GridColumnView } from './grid-table';

type ActionView = { key: string; label: string; kind: string; confirm?: string; form?: string; enabled: boolean };
type GridResult = {
  columns: (GridColumnDef & { key: string })[];
  rows: Record<string, unknown>[];
  total: number;
  rowActions: ActionView[];
  bulkActions: ActionView[];
};

export function GridView({ name }: { name: string }) {
  const { workspaceId, metadata } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ field: string; direction: 'asc' | 'desc' } | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [pending, setPending] = useState<{ action: ActionView; ids: string[] } | null>(null);

  const definition = useQuery({ queryKey: ['definition', workspaceId, 'grid', name], queryFn: () => callTool<{ definition: { object: string; pageSize?: number } }>(workspaceId, 'get_definition', { kind: 'grid', name }) });
  const pageSize = definition.data?.definition.pageSize ?? 50;
  const grid = useQuery({
    queryKey: ['grid', workspaceId, name, page, sort, pageSize],
    enabled: Boolean(definition.data),
    placeholderData: keepPreviousData,
    queryFn: () => callTool<GridResult>(workspaceId, 'run_grid', { name, offset: page * pageSize, limit: pageSize, ...(sort ? { sort: [sort] } : {}) }),
  });

  const run = useMutation({
    mutationFn: ({ action, ids }: { action: ActionView; ids: string[] }) => callTool<{ affected: number }>(workspaceId, 'run_grid_action', { grid: name, action: action.key, recordIds: ids }),
    onSuccess: async (result, { action }) => {
      toast.success(`${action.label}: ${result.affected} record${result.affected === 1 ? '' : 's'}`);
      setSelection([]);
      await queryClient.invalidateQueries({ queryKey: ['grid', workspaceId, name] });
      await queryClient.invalidateQueries({ queryKey: ['records', workspaceId] });
    },
    onError: (error) => toast.error(error.message),
  });

  const trigger = (actionKey: string, ids: string[], source: ActionView[]) => {
    const action = source.find((entry) => entry.key === actionKey);
    if (!action || ids.length === 0) return;
    if (action.kind === 'open_form') {
      if (action.form) router.push(`/w/${workspaceId}/forms/${action.form}?record=${ids[0]}`);
      return;
    }
    if (action.confirm) setPending({ action, ids });
    else run.mutate({ action, ids });
  };

  const object = metadata.objects.find((candidate) => candidate.namePlural === definition.data?.definition.object);
  const columns: GridColumnView[] = (grid.data?.columns ?? []).map((column) => {
    const resolved = object ? resolveColumn(metadata, object, column) : { label: column.field, field: undefined };
    return { key: column.key, label: resolved.label, type: columnType(resolved.field), sortField: column.via ? undefined : column.field, width: column.width };
  });
  const total = grid.data?.total ?? 0;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <>
      <PageHeader
        title={name}
        icon={<Table2 />}
        actions={
          <>
            {selection.length ? grid.data?.bulkActions.map((action) => (
              <Button key={action.key} size="sm" variant="outline" disabled={!action.enabled || run.isPending} onClick={() => trigger(action.key, selection, grid.data!.bulkActions)}>{action.label} ({selection.length})</Button>
            )) : null}
            {metadata.canBuild ? <Button size="sm" variant="ghost" asChild><Link href={`/w/${workspaceId}/grids/${name}/edit`}><Pencil /> Edit grid</Link></Button> : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {definition.error ? <EmptyState title="Grid not found" description={definition.error.message} /> : null}
        {grid.error ? <EmptyState title="Could not load the grid" description={grid.error.message} /> : null}
        {(definition.isPending || grid.isPending) && !definition.error ? <div className="flex flex-col gap-1 p-3">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-7" />)}</div> : null}
        {grid.data ? (
          <>
            <GridTable
              columns={columns}
              rows={grid.data.rows}
              sort={sort}
              onSort={(field) => { setSort((current) => (current?.field === field ? (current.direction === 'asc' ? { field, direction: 'desc' } : null) : { field, direction: 'asc' })); setPage(0); }}
              selection={grid.data.bulkActions.length ? selection : undefined}
              onSelect={grid.data.bulkActions.length ? setSelection : undefined}
              rowActions={grid.data.rowActions}
              onRowAction={(key, id) => trigger(key, [id], grid.data!.rowActions)}
            />
            {grid.data.rows.length === 0 ? <EmptyState title="No rows" description="Nothing matches this grid's filter." /> : null}
          </>
        ) : null}
      </div>
      <footer className="flex h-9 shrink-0 items-center justify-between border-t px-3 text-muted-foreground">
        <span>{total === 0 ? '0 records' : `${page * pageSize + 1}–${to} of ${total}`}</span>
        <div className="flex gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={to >= total} onClick={() => setPage((value) => value + 1)}><ChevronRight /></Button>
        </div>
      </footer>
      <Confirm
        open={Boolean(pending)}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending?.action.label ?? ''}
        description={pending?.action.confirm ?? ''}
        actionLabel="Run"
        onConfirm={() => pending && run.mutate(pending)}
      />
    </>
  );
}
