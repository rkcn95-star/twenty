'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Code2, Copy, Plus, Save, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ValueInput } from '@/components/records/filter-popover';
import { PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspace } from '@/components/workspace-context';
import { callTool } from '@/lib/api';
import {
  OPERATORS_BY_TYPE, OPERATOR_LABELS, coerceFilterValue, isGroup, type Aggregate, type Bucket, type Condition, type FilterGroup, type Operator,
  type ReportColumn, type ReportDefinition, type ReportJoin, type Visualization,
} from '@/lib/report';
import type { ReportResult } from '@/lib/types';
import { toSnakeCase } from '@/lib/utils';
import { ResultView } from './result-view';
import {
  AGGREGATE_LABELS, ROOT, aggregatesFor, decodeField, encodeField, isTemporal, relationFieldsOf, resolveScopes, scopeFields,
} from './scopes';

type FilterRow = { field: string; operator: Operator; raw: string };
type Draft = {
  source: string;
  joins: ReportJoin[];
  columns: ReportColumn[];
  filterOp: 'and' | 'or';
  filterRows: FilterRow[];
  advancedFilter: FilterGroup | null;
  orderKey: string;
  orderDirection: 'asc' | 'desc';
  limit: number;
  visualization: Visualization;
};

const RECORDS = '__records__';
const NONE = '__none__';
const BUCKETS: Bucket[] = ['day', 'week', 'month', 'quarter', 'year'];
const VIZ_LABELS: Record<Visualization['type'], string> = { table: 'Table', bar: 'Bar chart', line: 'Line chart', pie: 'Pie chart', kpi: 'Single number' };

const draftFromDefinition = (definition: ReportDefinition): Draft => {
  const items = definition.filter?.items ?? [];
  const simple = items.every((item) => !isGroup(item));
  return {
    source: definition.source,
    joins: definition.joins ?? [],
    columns: definition.columns,
    filterOp: definition.filter?.op ?? 'and',
    filterRows: simple
      ? (items as Condition[]).map((item) => ({ field: encodeField(item.ref.alias ?? ROOT, item.ref.field), operator: item.operator, raw: item.value === true && item.operator === 'is_null' ? '' : String(item.value ?? '') }))
      : [],
    advancedFilter: simple ? null : (definition.filter ?? null),
    orderKey: definition.orderBy?.[0]?.key ?? '',
    orderDirection: definition.orderBy?.[0]?.direction ?? 'asc',
    limit: definition.limit ?? 100,
    visualization: definition.visualization ?? { type: 'table' },
  };
};

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ReportBuilder({ initialName, initialDefinition }: { initialName: string; initialDefinition?: ReportDefinition }) {
  const { workspaceId, metadata } = useWorkspace();
  const router = useRouter();
  const queryClient = useQueryClient();
  const readable = metadata.objects.filter((object) => object.access.read);

  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState<Draft>(() =>
    initialDefinition
      ? draftFromDefinition(initialDefinition)
      : { source: readable[0]?.namePlural ?? '', joins: [], columns: [], filterOp: 'and', filterRows: [], advancedFilter: null, orderKey: '', orderDirection: 'asc', limit: 100, visualization: { type: 'table' } },
  );
  const patch = (changes: Partial<Draft>) => setDraft((state) => ({ ...state, ...changes }));

  const base: ReportDefinition = useMemo(() => ({ source: draft.source, joins: draft.joins, columns: draft.columns, limit: draft.limit }), [draft.source, draft.joins, draft.columns, draft.limit]);
  const scopes = useMemo(() => resolveScopes(base, metadata), [base, metadata]);
  const fields = useMemo(() => scopeFields(scopes), [scopes]);
  const fieldByValue = (value: string) => fields.find((field) => field.value === value);

  // The definition the server runs: only complete filters, and an order that still points at a column.
  const definition: ReportDefinition = useMemo(() => {
    const conditions: Condition[] = draft.filterRows.flatMap((row) => {
      const field = fieldByValue(row.field);
      if (!field || (row.operator !== 'is_null' && row.raw === '')) return [];
      return [{ ref: decodeField(row.field), operator: row.operator, value: coerceFilterValue(field.meta, row.operator, row.raw) }];
    });
    const filter = draft.advancedFilter ?? (conditions.length ? { op: draft.filterOp, items: conditions } : undefined);
    const orderBy = draft.orderKey && draft.columns.some((column) => column.key === draft.orderKey) ? [{ key: draft.orderKey, direction: draft.orderDirection }] : [];
    return {
      source: draft.source, joins: draft.joins, columns: draft.columns, ...(filter ? { filter } : {}), orderBy, limit: draft.limit,
      ...(draft.visualization.type !== 'table' ? { visualization: draft.visualization } : {}),
    };
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const isComplete = (candidate: ReportDefinition) =>
    candidate.source !== '' && candidate.columns.length > 0 && candidate.columns.every((column) => column.ref || column.aggregate === 'count');
  const complete = isComplete(definition);
  const [debounced, setDebounced] = useState(definition);
  const debouncedComplete = isComplete(debounced);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(definition), 350);
    return () => clearTimeout(timer);
  }, [definition]);
  const definitionKey = JSON.stringify(debounced);

  const result = useQuery({
    queryKey: ['report-run', workspaceId, definitionKey],
    enabled: debouncedComplete,
    retry: false,
    queryFn: () => callTool<ReportResult>(workspaceId, 'run_report', { definition: debounced }),
  });
  const [tab, setTab] = useState('result');
  const sql = useQuery({
    queryKey: ['report-sql', workspaceId, definitionKey],
    enabled: debouncedComplete && tab === 'sql',
    retry: false,
    queryFn: () => callTool<{ sql: string; params: unknown[] }>(workspaceId, 'preview_report_sql', { definition: debounced }),
  });

  const save = useMutation({
    mutationFn: () => callTool(workspaceId, 'save_report', { name, definition }),
    onSuccess: async () => {
      toast.success('Report saved');
      await queryClient.invalidateQueries({ queryKey: ['definitions', workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ['definition', workspaceId, 'report', name] });
      if (name !== initialName) router.replace(`/w/${workspaceId}/reports/${name}`);
    },
    onError: (error) => toast.error(error.message),
  });

  // ---- columns -----
  const autoKey = (column: ReportColumn): string =>
    toSnakeCase([column.aggregate ?? column.bucket ?? '', column.ref && column.ref.alias ? column.ref.alias : '', column.ref?.field ?? (column.aggregate === 'count' ? '' : '')].filter(Boolean).join('_')) || 'count';
  const uniqueKey = (key: string, others: ReportColumn[]) => {
    let candidate = key;
    for (let index = 2; others.some((column) => column.key === candidate); index += 1) candidate = `${key}_${index}`.slice(0, 40);
    return candidate;
  };
  const updateColumn = (index: number, change: Partial<ReportColumn>) =>
    setDraft((state) => {
      const old = state.columns[index]!;
      const next: ReportColumn = { ...old, ...change };
      if (!next.ref && next.aggregate !== 'count') delete next.aggregate;
      if (next.aggregate) delete next.bucket;
      if (next.key === autoKey(old)) next.key = uniqueKey(autoKey(next), state.columns.filter((_, position) => position !== index));
      const columns = state.columns.map((column, position) => (position === index ? next : column));
      return { ...state, columns, orderKey: state.orderKey === old.key ? next.key : state.orderKey };
    });
  const addColumn = () => {
    const first = fields[0];
    if (!first) return;
    const column: ReportColumn = { key: '', ref: decodeField(first.value) };
    patch({ columns: [...draft.columns, { ...column, key: uniqueKey(autoKey(column), draft.columns) }] });
  };

  // ---- joins -----
  const addJoin = () => {
    for (const scope of scopes) {
      const candidate = relationFieldsOf(scope.object).find((field) => !draft.joins.some((join) => (join.from ?? ROOT) === scope.alias && join.field === field.name));
      if (candidate) {
        let alias = candidate.name;
        for (let index = 2; alias === ROOT || scopes.some((existing) => existing.alias === alias); index += 1) alias = `${candidate.name}_${index}`;
        patch({ joins: [...draft.joins, { alias, ...(scope.alias === ROOT ? {} : { from: scope.alias }), field: candidate.name }] });
        return;
      }
    }
    toast.info('This object has no relations to follow. Add a relation field in the data model.');
  };
  const removeJoin = (alias: string) =>
    setDraft((state) => {
      const gone = new Set([alias]);
      for (let changed = true; changed; ) {
        changed = false;
        for (const join of state.joins) if (!gone.has(join.alias) && join.from && gone.has(join.from)) { gone.add(join.alias); changed = true; }
      }
      const columns = state.columns.filter((column) => !gone.has(column.ref?.alias ?? ROOT));
      return { ...state, joins: state.joins.filter((join) => !gone.has(join.alias)), columns, filterRows: state.filterRows.filter((row) => !gone.has(decodeField(row.field).alias ?? ROOT)) };
    });

  const filterable = fields.filter((field) => OPERATORS_BY_TYPE[field.type] && field.field !== 'id' && field.type !== 'relation');
  const columnKeys = draft.columns.map((column) => column.key);
  const viz = draft.visualization;
  const setViz = (change: Partial<Visualization>) => {
    const next = { ...viz, ...change };
    if (change.type && change.type !== 'table') {
      const outputs = draft.columns;
      next.x = next.x && columnKeys.includes(next.x) ? next.x : outputs.find((column) => !column.aggregate)?.key ?? outputs[0]?.key;
      const wanted = outputs.filter((column) => column.aggregate).map((column) => column.key);
      next.y = next.y?.length ? next.y : wanted;
    }
    patch({ visualization: next });
  };

  const selectedField = (column: ReportColumn) => (column.ref ? encodeField(column.ref.alias ?? ROOT, column.ref.field) : RECORDS);

  return (
    <>
      <PageHeader
        icon={<BarChart3 />}
        title={
          <Input
            aria-label="Report name"
            value={name}
            placeholder="report_name"
            onChange={(event) => setName(toSnakeCase(event.target.value))}
            className="h-6 w-[220px] border-transparent bg-transparent px-1 text-[13px] font-medium hover:border-input focus:border-input"
          />
        }
        actions={
          metadata.canBuild ? (
            <Button size="sm" disabled={!name || !complete || save.isPending} onClick={() => save.mutate()}>
              <Save /> Save
            </Button>
          ) : (
            <span className="text-muted-foreground">You can run reports but not save them.</span>
          )
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[380px] shrink-0 flex-col gap-4 overflow-y-auto border-r p-3">
          <Section title="Source">
            <Select
              value={draft.source}
              onValueChange={(source) => patch({ source, joins: [], columns: [], filterRows: [], advancedFilter: null, orderKey: '' })}
            >
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose an object" /></SelectTrigger>
              <SelectContent>{readable.map((object) => <SelectItem key={object.id} value={object.namePlural}>{object.label}</SelectItem>)}</SelectContent>
            </Select>
          </Section>

          <Section title="Follow relations" action={<Button size="icon-sm" variant="ghost" aria-label="Add join" onClick={addJoin} disabled={!draft.source}><Plus /></Button>}>
            {draft.joins.length === 0 ? <p className="text-muted-foreground">Add a relation to use fields of related records.</p> : null}
            {draft.joins.map((join) => {
              const from = scopes.find((scope) => scope.alias === (join.from ?? ROOT));
              return (
                <div key={join.alias} className="grid grid-cols-[1fr_1fr_24px] gap-1.5">
                  <Select value={join.from ?? ROOT} onValueChange={(value) => patch({ joins: draft.joins.map((item) => (item.alias === join.alias ? { ...item, from: value === ROOT ? undefined : value } : item)) })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {scopes.filter((scope) => scope.alias === ROOT || draft.joins.findIndex((item) => item.alias === scope.alias) < draft.joins.findIndex((item) => item.alias === join.alias)).map((scope) => <SelectItem key={scope.alias} value={scope.alias}>{scope.object.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Select value={join.field} onValueChange={(value) => patch({ joins: draft.joins.map((item) => (item.alias === join.alias ? { ...item, field: value } : item)) })}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{(from ? relationFieldsOf(from.object) : []).map((field) => <SelectItem key={field.id} value={field.name}>{field.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${join.alias}`} onClick={() => removeJoin(join.alias)}><X /></Button>
                </div>
              );
            })}
          </Section>

          <Section title="Columns" action={<Button size="icon-sm" variant="ghost" aria-label="Add column" onClick={addColumn} disabled={!draft.source}><Plus /></Button>}>
            {draft.columns.length === 0 ? <p className="text-muted-foreground">Pick the fields to show, and optionally sum, count or group them.</p> : null}
            {draft.columns.map((column, index) => {
              const field = column.ref ? fieldByValue(selectedField(column)) : undefined;
              return (
                <div key={index} className="flex flex-col gap-1.5 rounded-[4px] border p-1.5">
                  <div className="grid grid-cols-[1fr_24px] gap-1.5">
                    <Select
                      value={selectedField(column)}
                      onValueChange={(value) => {
                        if (value === RECORDS) return updateColumn(index, { ref: undefined, aggregate: 'count', bucket: undefined });
                        const next = fieldByValue(value)!;
                        const allowed = aggregatesFor(next.type);
                        updateColumn(index, { ref: decodeField(value), aggregate: column.aggregate && allowed.includes(column.aggregate) ? column.aggregate : undefined, bucket: isTemporal(next.type) ? column.bucket : undefined });
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="Column field"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={RECORDS}>Number of records</SelectItem>
                        {fields.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button size="icon-sm" variant="ghost" aria-label="Remove column" onClick={() => patch({ columns: draft.columns.filter((_, position) => position !== index) })}><X /></Button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Select value={column.aggregate ?? NONE} disabled={!column.ref} onValueChange={(value) => updateColumn(index, { aggregate: value === NONE ? undefined : (value as Aggregate) })}>
                      <SelectTrigger className="w-full" aria-label="Aggregate"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>{column.ref ? 'Value' : 'Count'}</SelectItem>
                        {aggregatesFor(field?.type).map((aggregate) => <SelectItem key={aggregate} value={aggregate}>{AGGREGATE_LABELS[aggregate]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {isTemporal(field?.type) && !column.aggregate ? (
                      <Select value={column.bucket ?? NONE} onValueChange={(value) => updateColumn(index, { bucket: value === NONE ? undefined : (value as Bucket) })}>
                        <SelectTrigger className="w-full" aria-label="Group by period"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Exact time</SelectItem>
                          {BUCKETS.map((bucket) => <SelectItem key={bucket} value={bucket}>By {bucket}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input aria-label="Column name" value={column.key} onChange={(event) => updateColumn(index, { key: toSnakeCase(event.target.value) })} />
                    )}
                  </div>
                </div>
              );
            })}
          </Section>

          <Section title="Filters" action={<Button size="icon-sm" variant="ghost" aria-label="Add filter" disabled={filterable.length === 0 || Boolean(draft.advancedFilter)} onClick={() => patch({ filterRows: [...draft.filterRows, { field: filterable[0]!.value, operator: OPERATORS_BY_TYPE[filterable[0]!.type]![0]!, raw: '' }] })}><Plus /></Button>}>
            {draft.advancedFilter ? (
              <p className="text-muted-foreground">This report has a nested filter. It is kept as is; edit it in the Definition tab.</p>
            ) : (
              <>
                {draft.filterRows.length > 1 ? (
                  <Select value={draft.filterOp} onValueChange={(value) => patch({ filterOp: value as 'and' | 'or' })}>
                    <SelectTrigger className="w-[160px]" size="sm"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="and">Match all</SelectItem><SelectItem value="or">Match any</SelectItem></SelectContent>
                  </Select>
                ) : null}
                {draft.filterRows.map((row, index) => {
                  const field = fieldByValue(row.field);
                  const update = (change: Partial<FilterRow>) => patch({ filterRows: draft.filterRows.map((item, position) => (position === index ? { ...item, ...change } : item)) });
                  return (
                    <div key={index} className="flex flex-col gap-1.5 rounded-[4px] border p-1.5">
                      <div className="grid grid-cols-[1fr_24px] gap-1.5">
                        <Select value={row.field} onValueChange={(value) => { const next = fieldByValue(value)!; update({ field: value, operator: OPERATORS_BY_TYPE[next.type]![0]!, raw: '' }); }}>
                          <SelectTrigger className="w-full" aria-label="Filter field"><SelectValue /></SelectTrigger>
                          <SelectContent>{filterable.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
                        </Select>
                        <Button size="icon-sm" variant="ghost" aria-label="Remove filter" onClick={() => patch({ filterRows: draft.filterRows.filter((_, position) => position !== index) })}><X /></Button>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-1.5">
                        <Select value={row.operator} onValueChange={(operator) => update({ operator: operator as Operator, raw: '' })}>
                          <SelectTrigger className="w-full" aria-label="Operator"><SelectValue /></SelectTrigger>
                          <SelectContent>{(field ? OPERATORS_BY_TYPE[field.type]! : []).map((operator) => <SelectItem key={operator} value={operator}>{OPERATOR_LABELS[operator]}</SelectItem>)}</SelectContent>
                        </Select>
                        <ValueInput field={field?.meta ?? (field ? { id: field.field, name: field.field, label: field.label, type: field.type, options: null, relationObjectId: null, readOnly: false } : undefined)} operator={row.operator} value={row.raw} onChange={(raw) => update({ raw })} />
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </Section>

          <Section title="Sort and limit">
            <div className="grid grid-cols-[1fr_84px_70px] gap-1.5">
              <Select value={draft.orderKey || NONE} onValueChange={(value) => patch({ orderKey: value === NONE ? '' : value })}>
                <SelectTrigger className="w-full" aria-label="Sort by"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value={NONE}>No sorting</SelectItem>{columnKeys.map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={draft.orderDirection} onValueChange={(value) => patch({ orderDirection: value as 'asc' | 'desc' })}>
                <SelectTrigger className="w-full" aria-label="Direction"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="asc">Asc</SelectItem><SelectItem value="desc">Desc</SelectItem></SelectContent>
              </Select>
              <Input aria-label="Row limit" type="number" min={1} max={1000} value={draft.limit} onChange={(event) => patch({ limit: Math.min(1000, Math.max(1, Number(event.target.value) || 1)) })} />
            </div>
          </Section>

          <Section title="Display">
            <Select value={viz.type} onValueChange={(value) => setViz({ type: value as Visualization['type'] })}>
              <SelectTrigger className="w-full" aria-label="Visualization"><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(VIZ_LABELS) as Visualization['type'][]).map((type) => <SelectItem key={type} value={type}>{VIZ_LABELS[type]}</SelectItem>)}</SelectContent>
            </Select>
            {viz.type !== 'table' && viz.type !== 'kpi' ? (
              <Select value={viz.x ?? NONE} onValueChange={(value) => setViz({ x: value })}>
                <SelectTrigger className="w-full" aria-label="Horizontal axis"><SelectValue placeholder="Horizontal axis" /></SelectTrigger>
                <SelectContent>{columnKeys.map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}</SelectContent>
              </Select>
            ) : null}
            {viz.type !== 'table' ? (
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {columnKeys.filter((key) => key !== viz.x).map((key) => (
                  <label key={key} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={viz.y?.includes(key) ?? false} onChange={(event) => setViz({ y: event.target.checked ? [...(viz.y ?? []), key] : (viz.y ?? []).filter((item) => item !== key) })} />
                    {key}
                  </label>
                ))}
              </div>
            ) : null}
          </Section>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="min-w-0 flex-1 gap-0">
          <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
            <TabsList className="h-7">
              <TabsTrigger value="result">Result</TabsTrigger>
              <TabsTrigger value="sql"><Code2 className="size-3.5" /> SQL</TabsTrigger>
              <TabsTrigger value="definition">Definition</TabsTrigger>
            </TabsList>
            <span className="text-muted-foreground">{result.data ? `${result.data.rows.length} rows` : ''}</span>
          </div>
          <PageBody>
            <TabsContent value="result" className="m-0">
              {!complete ? <p className="p-6 text-center text-muted-foreground">Add a column to see results.</p> : result.error ? <p role="alert" className="p-4 text-destructive">{result.error.message}</p> : result.data ? <ResultView result={result.data} visualization={definition.visualization} /> : <p className="p-6 text-center text-muted-foreground">Running…</p>}
            </TabsContent>
            <TabsContent value="sql" className="m-0 p-3">
              {sql.error ? <p role="alert" className="text-destructive">{sql.error.message}</p> : sql.data ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between"><span className="text-muted-foreground">Generated, read-only, with every value passed as a parameter.</span><Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(sql.data!.sql); toast.success('SQL copied'); }}><Copy /> Copy</Button></div>
                  <pre data-testid="sql" className="overflow-auto rounded-[4px] border bg-muted p-3 font-mono text-xs leading-5">{sql.data.sql}</pre>
                  {sql.data.params.length ? <p className="font-mono text-xs text-muted-foreground">Parameters: {JSON.stringify(sql.data.params)}</p> : null}
                </div>
              ) : <p className="text-muted-foreground">{complete ? 'Compiling…' : 'Add a column first.'}</p>}
            </TabsContent>
            <TabsContent value="definition" className="m-0 p-3">
              <pre className="overflow-auto rounded-[4px] border bg-muted p-3 font-mono text-xs leading-5">{JSON.stringify(definition, null, 2)}</pre>
            </TabsContent>
          </PageBody>
        </Tabs>
      </div>
    </>
  );
}
