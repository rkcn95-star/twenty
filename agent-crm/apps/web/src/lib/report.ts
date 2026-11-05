import type { FieldType, MetaField, MetaObject, Metadata } from './types';

export type FieldRef = { alias?: string; field: string };
export type Operator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains' | 'is_null';
export type Aggregate = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
export type Bucket = 'day' | 'week' | 'month' | 'quarter' | 'year';

export type Condition = { ref: FieldRef; operator: Operator; value?: unknown };
export type FilterGroup = { op: 'and' | 'or'; items: (Condition | FilterGroup)[] };
export type ReportColumn = { key: string; ref?: FieldRef; aggregate?: Aggregate; bucket?: Bucket };
export type ReportJoin = { alias: string; from?: string; field: string };
export type Visualization = { type: 'table' | 'bar' | 'line' | 'pie' | 'kpi'; x?: string; y?: string[] };

export type ReportDefinition = {
  source: string;
  joins?: ReportJoin[];
  columns: ReportColumn[];
  filter?: FilterGroup;
  orderBy?: { key: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
  visualization?: Visualization;
};

export const isGroup = (node: Condition | FilterGroup): node is FilterGroup => 'items' in node;

export const hasColumn = (field: Pick<MetaField, 'type'>): boolean => field.type !== 'many_to_many';

// What a person reads in a table cell instead of a uuid: a name, title or label, else the first text field.
export const displayFieldOf = (object: MetaObject): string | null => {
  const textFields = object.fields.filter((field) => field.type === 'text');
  const preferred = ['name', 'title', 'label'].map((name) => textFields.find((field) => field.name === name)).find(Boolean);
  return (preferred ?? textFields[0])?.name ?? null;
};

export const OPERATORS_BY_TYPE: Partial<Record<FieldType, Operator[]>> = {
  text: ['contains', 'eq', 'neq', 'is_null'],
  number: ['eq', 'gt', 'gte', 'lt', 'lte', 'is_null'],
  numeric: ['eq', 'gt', 'gte', 'lt', 'lte', 'is_null'],
  date: ['eq', 'gt', 'gte', 'lt', 'lte', 'is_null'],
  datetime: ['gt', 'gte', 'lt', 'lte', 'is_null'],
  boolean: ['eq'],
  select: ['eq', 'neq', 'is_null'],
  relation: ['eq', 'is_null'],
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: 'is', neq: 'is not', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', in: 'is one of', contains: 'contains', is_null: 'is empty',
};

export const isFilterable = (field: MetaField): boolean => Boolean(OPERATORS_BY_TYPE[field.type]);

export type TableFilter = { field: string; operator: Operator; value: string };

export const coerceFilterValue = (field: MetaField | undefined, operator: Operator, raw: string): unknown => {
  if (operator === 'is_null') return true;
  if (field?.type === 'number' || field?.type === 'numeric') return Number(raw);
  if (field?.type === 'boolean') return raw === 'true';
  return raw;
};

const aliasFor = (fieldName: string) => `j_${fieldName}`.slice(0, 40);

export const buildTableReport = (
  object: MetaObject,
  metadata: Metadata,
  options: { filters: TableFilter[]; sort: { key: string; direction: 'asc' | 'desc' } | null; limit: number; offset: number },
): { rows: ReportDefinition; total: ReportDefinition } => {
  const joins: ReportJoin[] = [];
  const columns: ReportColumn[] = [{ key: 'id', ref: { field: 'id' } }];
  for (const field of object.fields.filter(hasColumn)) {
    const target = field.type === 'relation' ? metadata.objects.find((candidate) => candidate.id === field.relationObjectId) : undefined;
    const display = target ? displayFieldOf(target) : null;
    if (target && display) {
      joins.push({ alias: aliasFor(field.name), field: field.name });
      columns.push({ key: field.name, ref: { alias: aliasFor(field.name), field: display } });
      columns.push({ key: `${field.name}__id`, ref: { field: field.name } });
    } else {
      columns.push({ key: field.name, ref: { field: field.name } });
    }
  }
  columns.push({ key: 'created_at', ref: { field: 'created_at' } });

  const items: Condition[] = options.filters.map((filter) => {
    const field = object.fields.find((candidate) => candidate.name === filter.field);
    return { ref: { field: filter.field }, operator: filter.operator, value: coerceFilterValue(field, filter.operator, filter.value) };
  });
  const filter: FilterGroup = { op: 'and', items };

  return {
    rows: {
      source: object.namePlural, joins, columns, filter,
      orderBy: options.sort ? [options.sort] : [{ key: 'created_at', direction: 'desc' }],
      limit: options.limit, offset: options.offset,
    },
    total: { source: object.namePlural, columns: [{ key: 'total', aggregate: 'count' }], filter, limit: 1 },
  };
};
