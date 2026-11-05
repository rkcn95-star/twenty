'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Save, Table2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ValueInput } from '@/components/records/filter-popover';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import { columnKey, columnType, gridToReport, isFlatFilter, resolveColumn, sortableFields, type GridAction, type GridColumnDef, type GridDefinition } from '@/lib/grid';
import { OPERATORS_BY_TYPE, OPERATOR_LABELS, coerceFilterValue, hasColumn, isFilterable, type Condition, type Operator } from '@/lib/report';
import type { ReportResult } from '@/lib/types';
import { toSnakeCase } from '@/lib/utils';
import { ActionEditor } from './action-editor';
import { GridTable } from './grid-table';

const NONE = '__none__';
const PAGE_SIZES = [25, 50, 100, 200];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-1.5"><h3 className="text-xs font-medium text-muted-foreground">{title}</h3>{children}</section>;
}

type FilterRow = { field: string; operator: Operator; raw: string };

const rowsFromFilter = (definition: GridDefinition): { op: 'and' | 'or'; rows: FilterRow[] } => ({
  op: definition.filter?.op ?? 'and',
  rows: ((definition.filter?.items ?? []) as Condition[]).map((item) => ({ field: item.ref.field, operator: item.operator, raw: item.operator === 'is_null' ? '' : String(item.value ?? '') })),
});

export function GridDesigner({ initialName, initialDefinition }: { initialName: string; initialDefinition?: GridDefinition }) {
  const { workspaceId, metadata } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const readable = metadata.objects.filter((object) => object.access.read);

  const [name, setName] = useState(initialName);
  const [definition, setDefinition] = useState<GridDefinition>(initialDefinition ?? { object: readable[0]?.namePlural ?? '', columns: [], pageSize: 50, sort: [], rowActions: [], bulkActions: [] });
  const advancedFilter = !isFlatFilter(definition.filter);
  const [filter, setFilter] = useState(() => rowsFromFilter(definition));
  const object = metadata.objects.find((candidate) => candidate.namePlural === definition.object);

  const patch = (changes: Partial<GridDefinition>) => setDefinition((state) => ({ ...state, ...changes }));
  const saved: GridDefinition = useMemo(() => {
    const items: Condition[] = filter.rows.flatMap((row) => {
      const field = object?.fields.find((candidate) => candidate.name === row.field);
      if (!field || (row.operator !== 'is_null' && row.raw === '')) return [];
      return [{ ref: { field: row.field }, operator: row.operator, value: coerceFilterValue(field, row.operator, row.raw) }];
    });
    return { ...definition, ...(advancedFilter ? {} : { filter: items.length ? { op: filter.op, items } : undefined }) };
  }, [definition, filter, object, advancedFilter]);

  const actionsComplete = [...(definition.rowActions ?? []), ...(definition.bulkActions ?? [])].every(
    (action) => action.label.trim() !== '' && (action.kind !== 'set_fields' || Object.keys(action.set ?? {}).length > 0) && (action.kind !== 'open_form' || Boolean(action.form)) && (action.kind !== 'run_tool' || Boolean(action.tool?.name)),
  );
  const complete = Boolean(object) && definition.columns.length > 0 && actionsComplete;

  const previewKey = JSON.stringify(saved);
  const preview = useQuery({
    queryKey: ['grid-preview', workspaceId, previewKey],
    enabled: complete,
    retry: false,
    queryFn: () => callTool<ReportResult>(workspaceId, 'run_report', { definition: gridToReport(saved, 10) }),
  });

  const save = useMutation({
    mutationFn: () => callTool(workspaceId, 'save_grid', { name, definition: { ...saved, rowActions: saved.rowActions ?? [], bulkActions: saved.bulkActions ?? [], sort: saved.sort ?? [], pageSize: saved.pageSize ?? 50 } }),
    onSuccess: async () => {
      toast.success('Grid saved');
      await queryClient.invalidateQueries({ queryKey: ['definitions', workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ['definition', workspaceId, 'grid', name] });
      if (name !== initialName) router.replace(`/w/${workspaceId}/grids/${name}/edit`);
    },
    onError: (error) => toast.error(error.message),
  });

  // ---- columns -----
  const choices = useMemo(() => {
    if (!object) return [];
    const own = object.fields.filter((field) => hasColumn(field) && field.type !== 'relation').map((field) => ({ value: field.name, column: { field: field.name } as GridColumnDef, label: field.label }));
    const related = object.fields.filter((field) => field.type === 'relation').flatMap((relation) => {
      const target = metadata.objects.find((candidate) => candidate.id === relation.relationObjectId);
      return (target?.fields.filter((field) => hasColumn(field) && field.type !== 'relation') ?? []).map((field) => ({ value: `${relation.name}::${field.name}`, column: { field: field.name, via: relation.name } as GridColumnDef, label: `${relation.label} · ${field.label}` }));
    });
    return [...own, ...related];
  }, [object, metadata]);
  const used = new Set(definition.columns.map((column) => (column.via ? `${column.via}::${column.field}` : column.field)));
  const move = (index: number, delta: number) => {
    const next = [...definition.columns];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved!);
    patch({ columns: next });
  };

  const filterable = object?.fields.filter(isFilterable) ?? [];
  const sortable = object ? sortableFields(object) : [];
  const sort = definition.sort?.[0];
  const previewColumns = definition.columns.map((column) => {
    const resolved = object ? resolveColumn(metadata, object, column) : { label: column.field, field: undefined };
    return { key: columnKey(column), label: resolved.label, type: columnType(resolved.field), width: column.width };
  });

  const setActions = (kind: 'rowActions' | 'bulkActions') => (actions: GridAction[]) => patch({ [kind]: actions });

  return (
    <>
      <PageHeader
        icon={<Table2 />}
        title={<Input aria-label="Grid name" value={name} placeholder="grid_name" onChange={(event) => setName(toSnakeCase(event.target.value))} className="h-6 w-[220px] border-transparent bg-transparent px-1 text-[13px] font-medium hover:border-input focus:border-input" />}
        actions={metadata.canBuild ? <Button size="sm" disabled={!name || !complete || save.isPending} onClick={() => save.mutate()}><Save /> Save</Button> : <span className="text-muted-foreground">You cannot save grids.</span>}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[400px] shrink-0 flex-col gap-4 overflow-y-auto border-r p-3">
          <Section title="Object">
            <Select value={definition.object || undefined} onValueChange={(plural) => { patch({ object: plural, columns: [], sort: [], filter: undefined, rowActions: [], bulkActions: [] }); setFilter({ op: 'and', rows: [] }); }}>
              <SelectTrigger className="w-full" aria-label="Grid object"><SelectValue placeholder="Choose an object" /></SelectTrigger>
              <SelectContent>{readable.map((candidate) => <SelectItem key={candidate.id} value={candidate.namePlural}>{candidate.label}</SelectItem>)}</SelectContent>
            </Select>
          </Section>

          <Section title="Columns">
            {definition.columns.map((column, index) => {
              const resolved = object ? resolveColumn(metadata, object, column) : { label: column.field };
              return (
                <div key={columnKey(column)} className="flex items-center gap-1.5 rounded-[4px] border p-1.5">
                  <Input aria-label={`Label for ${resolved.label}`} value={column.label ?? ''} placeholder={resolved.label} onChange={(event) => patch({ columns: definition.columns.map((entry, position) => (position === index ? { ...entry, label: event.target.value || undefined } : entry)) })} />
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${resolved.label} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${resolved.label} down`} disabled={index === definition.columns.length - 1} onClick={() => move(index, 1)}><ArrowDown /></Button>
                  <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove ${resolved.label}`} onClick={() => patch({ columns: definition.columns.filter((_, position) => position !== index) })}><X /></Button>
                </div>
              );
            })}
            <Select value="" onValueChange={(value) => { const choice = choices.find((entry) => entry.value === value); if (choice) patch({ columns: [...definition.columns, choice.column] }); }}>
              <SelectTrigger className="w-full" aria-label="Add a column"><span className="flex items-center gap-1.5 text-muted-foreground"><Plus className="size-3.5" /><SelectValue placeholder="Add a column" /></span></SelectTrigger>
              <SelectContent>{choices.filter((choice) => !used.has(choice.value)).map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectContent>
            </Select>
          </Section>

          <Section title="Built-in filter">
            {advancedFilter ? <p className="text-muted-foreground">This grid has a nested filter, kept as is.</p> : (
              <>
                {filter.rows.map((row, index) => {
                  const field = filterable.find((candidate) => candidate.name === row.field);
                  const update = (change: Partial<FilterRow>) => setFilter((state) => ({ ...state, rows: state.rows.map((entry, position) => (position === index ? { ...entry, ...change } : entry)) }));
                  return (
                    <div key={index} className="flex flex-col gap-1.5 rounded-[4px] border p-1.5">
                      <div className="grid grid-cols-[1fr_24px] gap-1.5">
                        <Select value={row.field} onValueChange={(next) => { const meta = filterable.find((candidate) => candidate.name === next)!; update({ field: next, operator: OPERATORS_BY_TYPE[meta.type]![0]!, raw: '' }); }}>
                          <SelectTrigger className="w-full" aria-label="Filter field"><SelectValue /></SelectTrigger>
                          <SelectContent>{filterable.map((candidate) => <SelectItem key={candidate.id} value={candidate.name}>{candidate.label}</SelectItem>)}</SelectContent>
                        </Select>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove filter" onClick={() => setFilter((state) => ({ ...state, rows: state.rows.filter((_, position) => position !== index) }))}><X /></Button>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-1.5">
                        <Select value={row.operator} onValueChange={(operator) => update({ operator: operator as Operator, raw: '' })}>
                          <SelectTrigger className="w-full" aria-label="Operator"><SelectValue /></SelectTrigger>
                          <SelectContent>{(field ? OPERATORS_BY_TYPE[field.type]! : []).map((operator) => <SelectItem key={operator} value={operator}>{OPERATOR_LABELS[operator]}</SelectItem>)}</SelectContent>
                        </Select>
                        <ValueInput field={field} operator={row.operator} value={row.raw} onChange={(raw) => update({ raw })} />
                      </div>
                    </div>
                  );
                })}
                <Button type="button" size="sm" variant="outline" disabled={filterable.length === 0} onClick={() => setFilter((state) => ({ ...state, rows: [...state.rows, { field: filterable[0]!.name, operator: OPERATORS_BY_TYPE[filterable[0]!.type]![0]!, raw: '' }] }))}><Plus /> Add filter</Button>
              </>
            )}
          </Section>

          <Section title="Sort and page size">
            <div className="grid grid-cols-[1fr_84px_84px] gap-1.5">
              <Select value={sort?.field ?? NONE} onValueChange={(field) => patch({ sort: field === NONE ? [] : [{ field, direction: sort?.direction ?? 'asc' }] })}>
                <SelectTrigger className="w-full" aria-label="Sort by"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>No sorting</SelectItem>{sortable.map((field) => <SelectItem key={field.id} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={sort?.direction ?? 'asc'} onValueChange={(direction) => sort && patch({ sort: [{ field: sort.field, direction: direction as 'asc' | 'desc' }] })} disabled={!sort}>
                <SelectTrigger className="w-full" aria-label="Direction"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="asc">Asc</SelectItem><SelectItem value="desc">Desc</SelectItem></SelectContent>
              </Select>
              <Select value={String(definition.pageSize ?? 50)} onValueChange={(size) => patch({ pageSize: Number(size) })}>
                <SelectTrigger className="w-full" aria-label="Page size"><SelectValue /></SelectTrigger>
                <SelectContent>{PAGE_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size} rows</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </Section>

          {object ? (
            <>
              <Section title="Row actions"><ActionEditor object={object} actions={definition.rowActions ?? []} onChange={setActions('rowActions')} /></Section>
              <Section title="Bulk actions"><ActionEditor object={object} actions={definition.bulkActions ?? []} onChange={setActions('bulkActions')} /></Section>
            </>
          ) : null}
        </div>

        <Tabs defaultValue="preview" className="min-w-0 flex-1 gap-0">
          <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
            <TabsList className="h-7"><TabsTrigger value="preview">Preview</TabsTrigger><TabsTrigger value="definition">Definition</TabsTrigger></TabsList>
            <span className="text-muted-foreground">First 10 rows</span>
          </div>
          <PageBody>
            <TabsContent value="preview" className="m-0">
              {!complete ? <p className="p-6 text-center text-muted-foreground">Add a column to see the grid. Each action needs a label and its settings.</p>
                : preview.error ? <p role="alert" className="p-4 text-destructive">{preview.error.message}</p>
                : preview.data ? <GridTable columns={previewColumns} rows={preview.data.rows} rowActions={(definition.rowActions ?? []).map((action) => ({ key: action.key, label: action.label || '…', enabled: true }))} />
                : <p className="p-6 text-center text-muted-foreground">Running…</p>}
            </TabsContent>
            <TabsContent value="definition" className="m-0 p-3"><pre className="overflow-auto rounded-[4px] border bg-muted p-3 font-mono text-xs leading-5">{JSON.stringify(saved, null, 2)}</pre></TabsContent>
          </PageBody>
        </Tabs>
      </div>
    </>
  );
}
