'use client';

import { ArrowDown, ArrowUp, MoreHorizontal } from 'lucide-react';
import { CellValue } from '@/components/records/cell-value';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { FieldType } from '@/lib/types';
import { cn } from '@/lib/utils';

export type GridColumnView = { key: string; label: string; type: FieldType; sortField?: string; width?: number };
export type RowActionView = { key: string; label: string; enabled: boolean };

export function GridTable({
  columns, rows, sort, onSort, selection, onSelect, rowActions, onRowAction,
}: {
  columns: GridColumnView[];
  rows: Record<string, unknown>[];
  sort?: { field: string; direction: 'asc' | 'desc' } | null;
  onSort?: (field: string) => void;
  selection?: string[];
  onSelect?: (ids: string[]) => void;
  rowActions?: RowActionView[];
  onRowAction?: (actionKey: string, id: string) => void;
}) {
  const selectable = Boolean(onSelect);
  const allSelected = rows.length > 0 && rows.every((row) => selection?.includes(String(row.id)));
  return (
    <table className="w-full border-separate border-spacing-0 text-[13px]">
      <thead className="sticky top-0 z-10 bg-background">
        <tr>
          {selectable ? (
            <th className="h-8 w-8 border-b border-r px-2.5">
              <Checkbox aria-label="Select all" checked={allSelected ? true : (selection?.length ?? 0) > 0 ? 'indeterminate' : false} onCheckedChange={(checked) => onSelect!(checked === true ? rows.map((row) => String(row.id)) : [])} />
            </th>
          ) : null}
          {columns.map((column) => (
            <th key={column.key} style={column.width ? { width: column.width } : undefined} className="h-8 border-b border-r px-2 text-left text-xs font-normal text-muted-foreground last:border-r-0">
              {column.sortField && onSort ? (
                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => onSort(column.sortField!)}>
                  {column.label}
                  {sort?.field === column.sortField ? (sort.direction === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : null}
                </button>
              ) : column.label}
            </th>
          ))}
          {rowActions?.length ? <th className="h-8 w-8 border-b" /> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = String(row.id);
          const selected = selection?.includes(id);
          return (
            <tr key={id} className={cn('hover:bg-muted/70', selected && 'bg-blue-soft')}>
              {selectable ? (
                <td className="h-8 border-b border-r px-2.5">
                  <Checkbox aria-label="Select row" checked={Boolean(selected)} onCheckedChange={(checked) => onSelect!(checked === true ? [...(selection ?? []), id] : (selection ?? []).filter((item) => item !== id))} />
                </td>
              ) : null}
              {columns.map((column) => <td key={column.key} className="h-8 max-w-[260px] truncate border-b border-r px-2 last:border-r-0"><CellValue type={column.type} value={row[column.key]} /></td>)}
              {rowActions?.length ? (
                <td className="h-8 border-b px-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Row actions"><MoreHorizontal /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {rowActions.map((action) => <DropdownMenuItem key={action.key} disabled={!action.enabled} onSelect={() => onRowAction?.(action.key, id)}>{action.label}</DropdownMenuItem>)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
