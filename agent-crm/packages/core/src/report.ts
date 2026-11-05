import type pg from 'pg';
import { z } from 'zod';
import { inTransaction } from './db.js';
import { AppError } from './errors.js';
import { IDENTIFIER_KEY, fieldRefSchema, filterGroupSchema, isGroup, type FieldRef, type FilterCondition, type FilterGroup } from './filters.js';
import { junctionTableName, quoteIdent } from './identifiers.js';
import type { PermissionSet } from './permissions.js';
import { compilePredicates } from './predicates.js';
import { applySessionSettings } from './records.js';
import { columnNameOf, type FieldType, type Metadata, type ObjectDefinition, type Principal } from './types.js';

export const AGGREGATES = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const MAX_FILTER_DEPTH = 5;
const MAX_IN_VALUES = 200;
const STATEMENT_TIMEOUT_MS = 5000;

export const reportDefinitionSchema = z.object({
  source: z.string().describe('Plural name of the root object'),
  joins: z
    .array(z.object({ alias: IDENTIFIER_KEY, from: z.string().optional(), field: z.string().describe('Relation field to follow') }))
    .max(5)
    .default([]),
  columns: z
    .array(
      z.object({
        key: IDENTIFIER_KEY,
        ref: fieldRefSchema.optional(),
        aggregate: z.enum(AGGREGATES).optional(),
        bucket: z.enum(BUCKETS).optional(),
      }),
    )
    .min(1)
    .max(30),
  filter: filterGroupSchema.optional(),
  orderBy: z.array(z.object({ key: IDENTIFIER_KEY, direction: z.enum(['asc', 'desc']).default('asc') })).max(5).default([]),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).max(100000).default(0),
  visualization: z
    .object({ type: z.enum(['table', 'bar', 'line', 'pie', 'kpi']), x: z.string().optional(), y: z.array(z.string()).optional() })
    .optional(),
});

export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportDefinitionInput = z.input<typeof reportDefinitionSchema>;

export type ReportView = { metadata: Metadata; permissions: PermissionSet; principal: Principal };
export type CompiledReport = { sql: string; params: unknown[]; columns: { key: string; type: string }[] };

type Scope = { sqlAlias: string; object: ObjectDefinition };
type ResolvedRef = { expr: string; type: FieldType | 'uuid' | 'datetime' };

const SYSTEM_TYPES: Record<string, ResolvedRef['type']> = { id: 'uuid', created_by: 'uuid', created_at: 'datetime', updated_at: 'datetime' };
const NUMERIC_TYPES = new Set(['number', 'numeric']);
const ORDERED_TYPES = new Set(['number', 'numeric', 'date', 'datetime']);
const TEMPORAL_TYPES = new Set(['date', 'datetime']);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (character) => `\\${character}`);

export const compileReport = (definition: ReportDefinition, view: ReportView): CompiledReport => {
  const { metadata, permissions, principal } = view;
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  const requireRead = (object: ObjectDefinition) => {
    if (!permissions.objects.get(object.id)?.read) throw new AppError('forbidden', `No read access to ${object.namePlural}`);
  };

  const root = metadata.objects.find((object) => object.namePlural === definition.source);
  if (!root) throw new AppError('not_found', `Unknown source object "${definition.source}"`);
  requireRead(root);

  const schema = quoteIdent(metadata.schemaName);
  const scopes = new Map<string, Scope>([['root', { sqlAlias: 't0', object: root }]]);
  const joinSql: string[] = [];

  for (const join of definition.joins) {
    if (scopes.has(join.alias)) throw new AppError('validation', `Duplicate join alias "${join.alias}"`);
    const from = scopes.get(join.from ?? 'root');
    if (!from) throw new AppError('validation', `Unknown join source "${join.from}"`);
    const field = from.object.fields.find((candidate) => candidate.name === join.field && candidate.active && (candidate.type === 'relation' || candidate.type === 'many_to_many'));
    if (!field || permissions.hiddenFieldIds.has(field.id)) throw new AppError('validation', `"${join.field}" is not a relation you can follow`);
    const target = metadata.objects.find((object) => object.id === field.relationObjectId);
    if (!target) throw new AppError('validation', `Relation "${join.field}" has no target`);
    requireRead(target);
    const sqlAlias = `t${scopes.size}`;
    const rowRule = compilePredicates(permissions.predicates.get(target.id) ?? null, target, principal.id, params.length + 1, sqlAlias);
    params.push(...rowRule.params);
    const targetJoin = `${schema}.${quoteIdent(target.namePlural)} ${sqlAlias}`;
    if (field.type === 'many_to_many') {
      const linkAlias = `l${scopes.size}`;
      joinSql.push(
        `LEFT JOIN ${schema}.${quoteIdent(junctionTableName(field.id))} ${linkAlias} ON ${linkAlias}.source_id = ${from.sqlAlias}.id`,
        `LEFT JOIN ${targetJoin} ON ${sqlAlias}.id = ${linkAlias}.target_id AND ${sqlAlias}.deleted_at IS NULL AND ${rowRule.sql}`,
      );
    } else {
      joinSql.push(
        `LEFT JOIN ${targetJoin} ON ${from.sqlAlias}.${quoteIdent(columnNameOf(field))} = ${sqlAlias}.id` +
          ` AND ${sqlAlias}.deleted_at IS NULL AND ${rowRule.sql}`,
      );
    }
    scopes.set(join.alias, { sqlAlias, object: target });
  }

  const resolveRef = (ref: FieldRef): ResolvedRef => {
    const scope = scopes.get(ref.alias ?? 'root');
    if (!scope) throw new AppError('validation', `Unknown alias "${ref.alias}"`);
    const systemType = SYSTEM_TYPES[ref.field];
    if (systemType) return { expr: `${scope.sqlAlias}.${quoteIdent(ref.field)}`, type: systemType };
    const field = scope.object.fields.find((candidate) => candidate.name === ref.field && candidate.active);
    if (!field || permissions.hiddenFieldIds.has(field.id)) throw new AppError('validation', `Unknown field "${ref.field}"`);
    if (field.type === 'many_to_many') throw new AppError('validation', `"${ref.field}" is many-to-many; follow it with a join`);
    return { expr: `${scope.sqlAlias}.${quoteIdent(columnNameOf(field))}`, type: field.type };
  };

  const selects: string[] = [];
  const groupExpressions: number[] = [];
  const outputColumns: CompiledReport['columns'] = [];
  const seenKeys = new Set<string>();
  const hasAggregate = definition.columns.some((column) => column.aggregate);

  definition.columns.forEach((column, index) => {
    if (seenKeys.has(column.key)) throw new AppError('validation', `Duplicate column key "${column.key}"`);
    seenKeys.add(column.key);
    const ref = column.ref ? resolveRef(column.ref) : undefined;
    let expression: string;
    let type: string = ref?.type ?? 'number';

    if (column.aggregate) {
      if (column.bucket) throw new AppError('validation', `Column "${column.key}" cannot be both bucketed and aggregated`);
      if (!ref) {
        if (column.aggregate !== 'count') throw new AppError('validation', `Aggregate "${column.aggregate}" needs a field`);
        expression = 'count(*)::int';
        type = 'number';
      } else if (column.aggregate === 'count') {
        expression = `count(${ref.expr})::int`;
        type = 'number';
      } else if (column.aggregate === 'count_distinct') {
        expression = `count(DISTINCT ${ref.expr})::int`;
        type = 'number';
      } else if (column.aggregate === 'sum' || column.aggregate === 'avg') {
        if (!NUMERIC_TYPES.has(ref.type)) throw new AppError('validation', `${column.aggregate} needs a numeric field`);
        expression = `${column.aggregate}(${ref.expr})::float8`;
        type = 'number';
      } else {
        if (!ORDERED_TYPES.has(ref.type)) throw new AppError('validation', `${column.aggregate} needs a number or date field`);
        expression = `${column.aggregate}(${ref.expr})`;
      }
    } else {
      if (!ref) throw new AppError('validation', `Column "${column.key}" needs a field or an aggregate`);
      if (column.bucket) {
        if (!TEMPORAL_TYPES.has(ref.type)) throw new AppError('validation', `Bucket needs a date field on "${column.key}"`);
        expression = `date_trunc('${column.bucket}', ${ref.expr})`;
        type = 'datetime';
      } else {
        expression = ref.expr;
      }
      if (hasAggregate) groupExpressions.push(index + 1);
    }
    selects.push(`${expression} AS ${quoteIdent(column.key)}`);
    outputColumns.push({ key: column.key, type });
  });

  const rootRule = compilePredicates(permissions.predicates.get(root.id) ?? null, root, principal.id, params.length + 1, 't0');
  params.push(...rootRule.params);
  const whereParts = ['t0.deleted_at IS NULL', rootRule.sql];

  const compileCondition = (condition: FilterCondition): string => {
    const ref = resolveRef(condition.ref);
    if (ref.type === 'json') throw new AppError('validation', 'Cannot filter on a json field');
    const { operator, value } = condition;
    if (operator === 'is_null') return value === false ? `${ref.expr} IS NOT NULL` : `${ref.expr} IS NULL`;
    if (operator === 'eq' && value === null) return `${ref.expr} IS NULL`;
    if (operator === 'neq' && value === null) return `${ref.expr} IS NOT NULL`;
    if (operator === 'in') {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) {
        throw new AppError('validation', `"in" needs a list of 1 to ${MAX_IN_VALUES} values`);
      }
      return `${ref.expr} = ANY (${addParam(value)})`;
    }
    if (operator === 'contains') {
      if (ref.type !== 'text' || typeof value !== 'string') throw new AppError('validation', '"contains" needs a text field and a string');
      return `${ref.expr} ILIKE ${addParam(`%${escapeLike(value)}%`)}`;
    }
    if (value === undefined || value === null || typeof value === 'object') {
      throw new AppError('validation', `Operator "${operator}" needs a scalar value`);
    }
    const sqlOperator = { eq: '=', neq: 'IS DISTINCT FROM', gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator];
    return `${ref.expr} ${sqlOperator} ${addParam(value)}`;
  };

  const compileGroup = (group: FilterGroup, depth: number): string => {
    if (depth > MAX_FILTER_DEPTH) throw new AppError('validation', 'Filter is nested too deeply');
    if (group.items.length === 0) return 'TRUE';
    const parts = group.items.map((item) => (isGroup(item) ? compileGroup(item, depth + 1) : compileCondition(item)));
    return `(${parts.join(group.op === 'and' ? ' AND ' : ' OR ')})`;
  };
  if (definition.filter) whereParts.push(compileGroup(definition.filter, 1));

  const orderParts = definition.orderBy.map((order) => {
    if (!seenKeys.has(order.key)) throw new AppError('validation', `orderBy references unknown column "${order.key}"`);
    return `${quoteIdent(order.key)} ${order.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`;
  });

  const sql = [
    `SELECT ${selects.join(', ')}`,
    `FROM ${schema}.${quoteIdent(root.namePlural)} t0`,
    ...joinSql,
    `WHERE ${whereParts.join(' AND ')}`,
    groupExpressions.length ? `GROUP BY ${groupExpressions.join(', ')}` : '',
    orderParts.length ? `ORDER BY ${orderParts.join(', ')}` : '',
    `LIMIT ${definition.limit} OFFSET ${definition.offset}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { sql, params, columns: outputColumns };
};

export const runCompiledReport = async (runtime: pg.Pool, view: ReportView, compiled: CompiledReport) => {
  try {
    const result = await inTransaction(
      runtime,
      (client) => client.query(compiled.sql, compiled.params),
      async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        await applySessionSettings(client, view.metadata.workspaceId, view.permissions);
      },
    );
    return { columns: compiled.columns, rows: result.rows, sql: compiled.sql };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '57014') throw new AppError('validation', 'Report took too long; add filters or reduce the range');
    if (code?.startsWith('22') || code === '42883') throw new AppError('validation', 'A filter value does not match its field type');
    throw error;
  }
};
