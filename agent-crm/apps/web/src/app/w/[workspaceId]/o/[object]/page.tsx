'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, MoreHorizontal, Plus, Table2, Trash2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CellValue } from '@/components/records/cell-value';
import { FilterPopover } from '@/components/records/filter-popover';
import { RecordDialog, type RecordRow } from '@/components/records/record-dialog';
import { EmptyState, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useObjectByPlural, useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { singularLabel } from '@/lib/labels';
import { buildTableReport, hasColumn, type TableFilter } from '@/lib/report';
import type { ReportResult } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZES = [25, 50, 100];

export default function RecordsPage() {
  const { object: plural } = useParams<{ object: string }>();
  const { workspaceId, metadata } = useWorkspace();
  const object = useObjectByPlural(plural);
  const queryClient = useQueryClient();

  const [filters, setFilters] = useState<TableFilter[]>([]);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<RecordRow | null>(null);
  const [creating, setCreating] = useState(false);

  const sort = sorting[0] ? { key: sorting[0].id, direction: sorting[0].desc ? ('desc' as const) : ('asc' as const) } : null;
  const reports = useMemo(
    () => (object ? buildTableReport(object, metadata, { filters, sort, limit: pageSize, offset: page * pageSize }) : null),
    [object, metadata, filters, sort?.key, sort?.direction, pageSize, page], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const data = useQuery({
    queryKey: ['records', workspaceId, plural, reports],
    enabled: Boolean(reports),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [rows, total] = await Promise.all([
        callTool<ReportResult>(workspaceId, 'run_report', { definition: reports!.rows }),
        callTool<ReportResult>(workspaceId, 'run_report', { definition: reports!.total }),
      ]);
      return { rows: rows.rows, total: Number(total.rows[0]?.total ?? 0) };
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['records', workspaceId, plural] });
  const remove = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) await callTool(workspaceId, `delete_one_${object!.nameSingular}`, { id });
    },
    onSuccess: (_, ids) => {
      toast.success(`Deleted ${ids.length} record${ids.length === 1 ? '' : 's'}`);
      setSelection({});
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const columns = useMemo<ColumnDef<RecordRow>[]>(() => {
    if (!object) return [];
    return [
      {
        id: 'select',
        enableSorting: false,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all"
            checked={table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false}
            onCheckedChange={(checked) => table.toggleAllRowsSelected(checked === true)}
          />
        ),
        cell: ({ row }) => (
          <div onClick={(event) => event.stopPropagation()}>
            <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(checked) => row.toggleSelected(checked === true)} />
          </div>
        ),
      },
      ...object.fields.filter(hasColumn).map<ColumnDef<RecordRow>>((field) => ({
        id: field.name,
        header: field.label,
        enableSorting: field.type !== 'json' && field.type !== 'multi_select',
        accessorFn: (row) => row[field.name],
        cell: ({ getValue }) => <CellValue type={field.type === 'relation' ? 'text' : field.type} value={getValue()} />,
      })),
      {
        id: 'created_at',
        header: 'Created',
        accessorFn: (row) => row.created_at,
        cell: ({ getValue }) => <CellValue type="datetime" value={getValue()} />,
      },
      {
        id: 'actions',
        enableSorting: false,
        header: () => null,
        cell: ({ row }) => (
          <div onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Row actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditing(row.original)}>{object.access.update ? 'Edit' : 'View'}</DropdownMenuItem>
                {object.access.delete ? (
                  <DropdownMenuItem className="text-destructive" onSelect={() => remove.mutate([String(row.original.id)])}><Trash2 className="size-3.5" /> Delete</DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      },
    ];
  }, [object]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data.data?.rows ?? [];
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, rowSelection: selection },
    onSortingChange: (updater) => { setSorting(updater); setPage(0); },
    onRowSelectionChange: setSelection,
    getRowId: (row) => String(row.id),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableMultiSort: false,
    sortDescFirst: false,
  });

  if (!object) return <EmptyState title="Object not found" description="It may have been removed, or you may not have access to it." />;

  const total = data.data?.total ?? 0;
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  const selected = Object.keys(selection);

  return (
    <>
      <PageHeader
        title={object.label}
        icon={<Table2 />}
        actions={
          <>
            {selected.length ? (
              <Button size="sm" variant="outline" className="text-destructive" disabled={!object.access.delete} onClick={() => remove.mutate(selected)}>
                <Trash2 /> Delete {selected.length}
              </Button>
            ) : null}
            <FilterPopover object={object} filters={filters} onApply={(next) => { setFilters(next); setPage(0); }} />
            {object.access.create ? <Button size="sm" onClick={() => setCreating(true)}><Plus /> New {singularLabel(object).toLowerCase()}</Button> : null}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {data.isPending ? (
          <div className="flex flex-col gap-1 p-3">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-7" />)}</div>
        ) : data.error ? (
          <EmptyState title="Could not load records" description={data.error.message} />
        ) : (
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead className="sticky top-0 z-10 bg-background">
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header, index) => (
                    <th
                      key={header.id}
                      className={cn('h-8 border-b border-r px-2 text-left text-xs font-normal text-muted-foreground last:border-r-0', index === 0 && 'w-8 px-2.5')}
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button className="flex items-center gap-1 hover:text-foreground" onClick={header.column.getToggleSortingHandler()}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getIsSorted() === 'asc' ? <ArrowUp className="size-3" /> : header.column.getIsSorted() === 'desc' ? <ArrowDown className="size-3" /> : null}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="group cursor-pointer hover:bg-muted/70 data-[selected=true]:bg-blue-soft" data-selected={row.getIsSelected()} onClick={() => setEditing(row.original)}>
                  {row.getVisibleCells().map((cell, index) => (
                    <td key={cell.id} className={cn('h-8 max-w-[260px] truncate border-b border-r px-2 last:border-r-0', index === 0 && 'px-2.5')}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!data.isPending && !data.error && rows.length === 0 ? (
          <EmptyState
            title={filters.length ? 'No records match these filters' : `No ${object.label.toLowerCase()} yet`}
            description={filters.length ? undefined : object.fields.length === 0 ? 'Add fields to this object in the data model first.' : undefined}
            action={!filters.length && object.access.create ? <Button size="sm" onClick={() => setCreating(true)}><Plus /> New {singularLabel(object).toLowerCase()}</Button> : undefined}
          />
        ) : null}
      </div>
      <footer className="flex h-9 shrink-0 items-center justify-between border-t px-3 text-muted-foreground">
        <span>{total === 0 ? '0 records' : `${from}–${to} of ${total}`}</span>
        <div className="flex items-center gap-1.5">
          <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(0); }}>
            <SelectTrigger size="sm" className="w-[84px]"><SelectValue /></SelectTrigger>
            <SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} rows</SelectItem>)}</SelectContent>
          </Select>
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={to >= total} onClick={() => setPage((value) => value + 1)}><ChevronRight /></Button>
        </div>
      </footer>
      <RecordDialog object={object} open={creating} onOpenChange={setCreating} onSaved={() => void refresh()} />
      <RecordDialog object={object} record={editing ?? undefined} open={Boolean(editing)} onOpenChange={(open) => !open && setEditing(null)} onSaved={() => void refresh()} />
    </>
  );
}
