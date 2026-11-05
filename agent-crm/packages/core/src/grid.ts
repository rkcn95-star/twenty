import { z } from 'zod';
import { AppError } from './errors.js';
import { IDENTIFIER_KEY, filterGroupSchema, type FilterCondition, type FilterGroup } from './filters.js';
import * as records from './records.js';
import type { RecordContext } from './records.js';
import type { ReportDefinition } from './report.js';
import type { Metadata } from './types.js';

const MAX_ACTION_RECORDS = 200;

const actionSchema = z.object({
  key: IDENTIFIER_KEY,
  label: z.string(),
  kind: z.enum(['set_fields', 'delete', 'open_form', 'run_tool']),
  set: z.record(z.string(), z.json()).optional().describe('set_fields: field values to write'),
  form: z.string().optional().describe('open_form: name of a saved form'),
  tool: z.object({ name: z.string(), arguments: z.record(z.string(), z.json()).default({}) }).optional().describe('run_tool: "{{id}}" in a string is replaced by the record id'),
  confirm: z.string().optional(),
});
export type GridAction = z.infer<typeof actionSchema>;

export const gridDefinitionSchema = z.object({
  object: z.string(),
  columns: z
    .array(
      z.object({
        field: z.string(),
        via: z.string().optional().describe('Relation field to show a field of the related record'),
        label: z.string().optional(),
        width: z.number().int().optional(),
      }),
    )
    .min(1)
    .max(30),
  filter: filterGroupSchema.optional(),
  sort: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']).default('asc') })).max(3).default([]),
  pageSize: z.number().int().min(1).max(200).default(50),
  rowActions: z.array(actionSchema).max(10).default([]),
  bulkActions: z.array(actionSchema).max(10).default([]),
});
export type GridDefinition = z.infer<typeof gridDefinitionSchema>;

const columnKey = (column: GridDefinition['columns'][number]): string =>
  (column.via ? `${column.via}_${column.field}` : column.field).slice(0, 40);

export const validateGridDefinition = (definition: GridDefinition, metadata: Metadata) => {
  const object = metadata.objects.find((candidate) => candidate.namePlural === definition.object);
  if (!object) throw new AppError('validation', `Unknown object "${definition.object}"`);
  for (const column of definition.columns) {
    if (column.via) {
      const relation = object.fields.find((field) => field.name === column.via && field.active && field.type === 'relation');
      const target = metadata.objects.find((candidate) => candidate.id === relation?.relationObjectId);
      if (!relation || !target?.fields.some((field) => field.name === column.field && field.active)) {
        throw new AppError('validation', `Column "${column.via}.${column.field}" does not exist`);
      }
    } else if (!object.fields.some((field) => field.name === column.field && field.active)) {
      throw new AppError('validation', `Column "${column.field}" does not exist`);
    }
  }
  const keys = new Set<string>();
  for (const action of [...definition.rowActions, ...definition.bulkActions]) {
    if (keys.has(action.key)) throw new AppError('validation', `Duplicate action key "${action.key}"`);
    keys.add(action.key);
    if (action.kind === 'set_fields' && !Object.keys(action.set ?? {}).length) throw new AppError('validation', `Action "${action.key}" needs "set"`);
    if (action.kind === 'run_tool' && !action.tool) throw new AppError('validation', `Action "${action.key}" needs "tool"`);
    if (action.kind === 'open_form' && !action.form) throw new AppError('validation', `Action "${action.key}" needs "form"`);
  }
};

export type GridQuery = { filter?: Record<string, unknown>; sort?: { field: string; direction: 'asc' | 'desc' }[]; offset?: number; limit?: number };

const equalsCondition = (field: string, value: unknown): FilterCondition => ({ ref: { field }, operator: 'eq', value });

// A grid is a report without aggregates, so row rules and field masks come from the report compiler.
export const gridToReports = (definition: GridDefinition, query: GridQuery): { rows: ReportDefinition; total: ReportDefinition } => {
  const joins: ReportDefinition['joins'] = [];
  const columns: ReportDefinition['columns'] = [{ key: 'id', ref: { field: 'id' } }];
  for (const column of definition.columns) {
    if (column.via && !joins.some((join) => join.alias === `j_${column.via}`)) joins.push({ alias: `j_${column.via}`.slice(0, 40), field: column.via });
    columns.push({ key: columnKey(column), ref: column.via ? { alias: `j_${column.via}`.slice(0, 40), field: column.field } : { field: column.field } });
  }

  const items: (FilterCondition | FilterGroup)[] = Object.entries(query.filter ?? {}).map(([field, value]) => equalsCondition(field, value));
  if (definition.filter) items.push(definition.filter);
  const filter: FilterGroup = { op: 'and', items };

  const sort = query.sort?.length ? query.sort : definition.sort;
  const orderBy = sort.map((entry) => {
    const column = definition.columns.find((candidate) => !candidate.via && candidate.field === entry.field);
    if (!column) throw new AppError('validation', `Cannot sort by "${entry.field}"`);
    return { key: columnKey(column), direction: entry.direction };
  });

  return {
    rows: { source: definition.object, joins, columns, filter, orderBy, limit: query.limit ?? definition.pageSize, offset: query.offset ?? 0 },
    total: { source: definition.object, joins: [], columns: [{ key: 'total', aggregate: 'count' }], filter, orderBy: [], limit: 1, offset: 0 },
  };
};

const substitute = (value: unknown, id: string): unknown => {
  if (typeof value === 'string') return value.replaceAll('{{id}}', id);
  if (Array.isArray(value)) return value.map((item) => substitute(item, id));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, id)]));
  return value;
};

export const findAction = (definition: GridDefinition, key: string): GridAction => {
  const action = [...definition.rowActions, ...definition.bulkActions].find((candidate) => candidate.key === key);
  if (!action) throw new AppError('not_found', `Unknown action "${key}"`);
  return action;
};

export const assertRecordIds = (recordIds: string[]) => {
  if (recordIds.length === 0 || recordIds.length > MAX_ACTION_RECORDS) {
    throw new AppError('validation', `Select between 1 and ${MAX_ACTION_RECORDS} records`);
  }
};

export const runTransactionalAction = async (action: GridAction, recordIds: string[], ctx: RecordContext): Promise<number> => {
  for (const id of recordIds) {
    if (action.kind === 'set_fields') await records.updateOne(ctx, id, action.set ?? {});
    else await records.deleteOne(ctx, id);
  }
  return recordIds.length;
};

export const toolCallsForAction = (action: GridAction, recordIds: string[]) =>
  recordIds.map((id) => ({ name: action.tool?.name ?? '', arguments: substitute(action.tool?.arguments ?? {}, id) }));
