import { hasColumn, type Condition, type FilterGroup, type ReportDefinition } from './report';
import type { FieldType, MetaField, MetaObject, Metadata } from './types';

export type GridActionKind = 'set_fields' | 'delete' | 'open_form' | 'run_tool';
export type GridAction = {
  key: string;
  label: string;
  kind: GridActionKind;
  set?: Record<string, unknown>;
  form?: string;
  tool?: { name: string; arguments: Record<string, unknown> };
  confirm?: string;
};
export type GridColumnDef = { field: string; via?: string; label?: string; width?: number };
export type GridDefinition = {
  object: string;
  columns: GridColumnDef[];
  filter?: FilterGroup;
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  pageSize?: number;
  rowActions?: GridAction[];
  bulkActions?: GridAction[];
};

export const ACTION_KIND_LABELS: Record<GridActionKind, string> = {
  set_fields: 'Set field values', delete: 'Delete records', open_form: 'Open a form', run_tool: 'Run a tool',
};

// Same key the server gives a column, so rows from run_grid line up with the definition.
export const columnKey = (column: GridColumnDef): string => (column.via ? `${column.via}_${column.field}` : column.field).slice(0, 40);

export const resolveColumn = (metadata: Metadata, object: MetaObject, column: GridColumnDef): { field?: MetaField; label: string } => {
  if (column.via) {
    const relation = object.fields.find((candidate) => candidate.name === column.via);
    const target = metadata.objects.find((candidate) => candidate.id === relation?.relationObjectId);
    const field = target?.fields.find((candidate) => candidate.name === column.field);
    return { field, label: column.label ?? `${relation?.label ?? column.via} · ${field?.label ?? column.field}` };
  }
  const field = object.fields.find((candidate) => candidate.name === column.field);
  return { field, label: column.label ?? field?.label ?? column.field };
};

export const columnType = (field: MetaField | undefined): FieldType => (field?.type === 'relation' ? 'text' : (field?.type ?? 'text'));

// The report behind a grid preview, mirroring what the server compiles for run_grid.
export const gridToReport = (definition: GridDefinition, limit: number): ReportDefinition => {
  const joins: ReportDefinition['joins'] = [];
  const columns: ReportDefinition['columns'] = [{ key: 'id', ref: { field: 'id' } }];
  for (const column of definition.columns) {
    const alias = column.via ? `j_${column.via}`.slice(0, 40) : undefined;
    if (alias && !joins!.some((join) => join.alias === alias)) joins!.push({ alias, field: column.via! });
    columns.push({ key: columnKey(column), ref: alias ? { alias, field: column.field } : { field: column.field } });
  }
  const sort = definition.sort?.[0];
  const sortColumn = sort ? definition.columns.find((candidate) => !candidate.via && candidate.field === sort.field) : undefined;
  return {
    source: definition.object, joins, columns, ...(definition.filter?.items.length ? { filter: definition.filter } : {}),
    orderBy: sort && sortColumn ? [{ key: columnKey(sortColumn), direction: sort.direction }] : [{ key: 'id', direction: 'asc' }], limit,
  };
};

export const isFlatFilter = (filter: FilterGroup | undefined): filter is FilterGroup & { items: Condition[] } => !filter || filter.items.every((item) => !('items' in item));

export const sortableFields = (object: MetaObject): MetaField[] => object.fields.filter((field) => hasColumn(field) && field.type !== 'json' && field.type !== 'multi_select' && field.type !== 'relation');
