import type pg from 'pg';
import { z } from 'zod';
import { inTransaction } from './db.js';
import { AppError } from './errors.js';
import { quoteIdent } from './identifiers.js';
import type { PermissionSet } from './permissions.js';
import { compilePredicates } from './predicates.js';
import { columnNameOf, type FieldDefinition, type Metadata, type ObjectDefinition, type Principal } from './types.js';

export type RecordContext = {
  runtime: pg.Pool;
  metadata: Metadata;
  object: ObjectDefinition;
  permissions: PermissionSet;
  principal: Principal;
  client?: pg.PoolClient;
};

export type RecordRow = Record<string, unknown>;

const SYSTEM_SELECT = ['id', 'created_at', 'updated_at', 'created_by'];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const idsWhere = (permissions: PermissionSet, check: (access: { read: boolean; create: boolean; update: boolean; delete: boolean }) => boolean) =>
  [...permissions.objects].filter(([, access]) => check(access)).map(([objectId]) => objectId);

export const applySessionSettings = async (client: pg.PoolClient, workspaceId: string, permissions: PermissionSet) => {
  const settings: [string, string][] = [
    ['app.workspace_id', workspaceId],
    ['app.read_objects', idsWhere(permissions, (access) => access.read).join(',')],
    ['app.write_objects', idsWhere(permissions, (access) => access.create || access.update || access.delete).join(',')],
  ];
  for (const [name, value] of settings) await client.query('SELECT set_config($1, $2, true)', [name, value]);
};

const FOREIGN_KEY_VIOLATION = '23503';

const guardForeignKeys = async <TResult>(work: Promise<TResult>): Promise<TResult> => {
  try {
    return await work;
  } catch (error) {
    if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
      throw new AppError('validation', 'A referenced record does not exist');
    }
    throw error;
  }
};

const withRls = <TResult>(ctx: RecordContext, work: (client: pg.PoolClient) => Promise<TResult>) =>
  guardForeignKeys(
    ctx.client
      ? work(ctx.client)
      : inTransaction(ctx.runtime, work, (client) => applySessionSettings(client, ctx.metadata.workspaceId, ctx.permissions)),
  );

const tableOf = (ctx: RecordContext) => `${quoteIdent(ctx.metadata.schemaName)}.${quoteIdent(ctx.object.namePlural)}`;

const activeFields = (ctx: RecordContext, filter: (field: FieldDefinition) => boolean = () => true) =>
  ctx.object.fields.filter((field) => field.active && filter(field));

const readableFields = (ctx: RecordContext) => activeFields(ctx, (field) => !ctx.permissions.hiddenFieldIds.has(field.id));
const writableFields = (ctx: RecordContext) =>
  readableFields(ctx).filter((field) => !ctx.permissions.readOnlyFieldIds.has(field.id));

const selectList = (ctx: RecordContext): string =>
  [
    ...SYSTEM_SELECT.map(quoteIdent),
    ...readableFields(ctx).map((field) => `${quoteIdent(columnNameOf(field))} AS ${quoteIdent(field.name)}`),
  ].join(', ');

const requireAccess = (ctx: RecordContext, action: 'read' | 'create' | 'update' | 'delete') => {
  if (!ctx.permissions.objects.get(ctx.object.id)?.[action]) {
    throw new AppError('forbidden', `No ${action} access to ${ctx.object.namePlural}`);
  }
};

const rowCondition = (ctx: RecordContext, firstParamIndex: number) =>
  compilePredicates(ctx.permissions.predicates.get(ctx.object.id) ?? null, ctx.object, ctx.principal.id, firstParamIndex);

const zodForField = (field: FieldDefinition): z.ZodType => {
  switch (field.type) {
    case 'text': return z.string();
    case 'number': return z.number();
    case 'numeric': return z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);
    case 'boolean': return z.boolean();
    case 'date': return z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    case 'datetime': return z.iso.datetime({ offset: true });
    case 'select': return z.enum((field.options ?? []) as [string, ...string[]]);
    case 'multi_select': return z.array(z.enum((field.options ?? []) as [string, ...string[]]));
    case 'json': return z.json();
    case 'relation': return z.uuid();
  }
};

export const buildInputSchema = (fields: FieldDefinition[]) => {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) shape[field.name] = zodForField(field).nullable().optional();
  return z.object(shape).strict();
};

export const inputSchemaFor = (ctx: RecordContext) => buildInputSchema(writableFields(ctx));
export const filterSchemaFor = (ctx: RecordContext) => buildInputSchema(readableFields(ctx));

const toJsonValue = (field: FieldDefinition, value: unknown) =>
  field.type === 'json' && value !== null && value !== undefined ? JSON.stringify(value) : value;

const assertRowStillVisible = async (ctx: RecordContext, client: pg.PoolClient, id: string) => {
  const condition = rowCondition(ctx, 2);
  const result = await client.query(`SELECT 1 FROM ${tableOf(ctx)} WHERE id = $1 AND ${condition.sql}`, [id, ...condition.params]);
  if (result.rowCount === 0) throw new AppError('forbidden', 'Row violates a row-level rule');
};

const fetchOne = async (ctx: RecordContext, client: pg.PoolClient, id: string): Promise<RecordRow> => {
  const condition = rowCondition(ctx, 2);
  const result = await client.query(
    `SELECT ${selectList(ctx)} FROM ${tableOf(ctx)} WHERE id = $1 AND deleted_at IS NULL AND ${condition.sql}`,
    [id, ...condition.params],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('not_found', `${ctx.object.nameSingular} not found`);
  return row;
};

export const findMany = async (
  ctx: RecordContext,
  args: { filter?: Record<string, unknown>; limit?: number; offset?: number },
): Promise<{ records: RecordRow[]; total: number }> => {
  requireAccess(ctx, 'read');
  const filter = filterSchemaFor(ctx).partial().parse(args.filter ?? {});
  const params: unknown[] = [];
  const clauses = ['deleted_at IS NULL'];
  for (const field of readableFields(ctx)) {
    const value = filter[field.name];
    if (value === undefined) continue;
    params.push(toJsonValue(field, value));
    clauses.push(`${quoteIdent(columnNameOf(field))} = $${params.length}`);
  }
  const condition = rowCondition(ctx, params.length + 1);
  clauses.push(condition.sql);
  params.push(...condition.params);
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const where = clauses.join(' AND ');

  return withRls(ctx, async (client) => {
    const rows = await client.query(
      `SELECT ${selectList(ctx)} FROM ${tableOf(ctx)} WHERE ${where}
       ORDER BY created_at DESC, id LIMIT ${Number(limit)} OFFSET ${Number(args.offset ?? 0)}`,
      params,
    );
    const total = await client.query(`SELECT count(*)::int AS total FROM ${tableOf(ctx)} WHERE ${where}`, params);
    return { records: rows.rows, total: total.rows[0].total };
  });
};

export const findOne = async (ctx: RecordContext, id: string): Promise<RecordRow> => {
  requireAccess(ctx, 'read');
  return withRls(ctx, (client) => fetchOne(ctx, client, id));
};

export const createOne = async (ctx: RecordContext, data: Record<string, unknown>): Promise<RecordRow> => {
  requireAccess(ctx, 'create');
  const input = inputSchemaFor(ctx).parse(data);
  const fields = writableFields(ctx).filter((field) => input[field.name] !== undefined);
  const tenantColumns = ctx.metadata.tenancy === 'shared' ? [['workspace_id', ctx.metadata.workspaceId]] : [];
  const columns = ['created_by', ...tenantColumns.map(([name]) => name), ...fields.map((field) => columnNameOf(field))].map((name) => quoteIdent(name as string));
  const values = [ctx.principal.id, ...tenantColumns.map(([, value]) => value), ...fields.map((field) => toJsonValue(field, input[field.name]))];
  const placeholders = values.map((_, index) => `$${index + 1}`);

  return withRls(ctx, async (client) => {
    const inserted = await client.query(
      `INSERT INTO ${tableOf(ctx)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      values,
    );
    const id = inserted.rows[0].id as string;
    await assertRowStillVisible(ctx, client, id);
    return fetchOne(ctx, client, id);
  });
};

export const updateOne = async (ctx: RecordContext, id: string, data: Record<string, unknown>): Promise<RecordRow> => {
  requireAccess(ctx, 'update');
  const input = inputSchemaFor(ctx).parse(data);
  const fields = writableFields(ctx).filter((field) => input[field.name] !== undefined);
  if (fields.length === 0) throw new AppError('validation', 'No writable fields provided');
  const assignments = fields.map((field, index) => `${quoteIdent(columnNameOf(field))} = $${index + 2}`);
  const values = fields.map((field) => toJsonValue(field, input[field.name]));
  const condition = rowCondition(ctx, values.length + 2);

  return withRls(ctx, async (client) => {
    const updated = await client.query(
      `UPDATE ${tableOf(ctx)} SET ${assignments.join(', ')}, updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL AND ${condition.sql} RETURNING id`,
      [id, ...values, ...condition.params],
    );
    if (updated.rowCount === 0) throw new AppError('not_found', `${ctx.object.nameSingular} not found`);
    await assertRowStillVisible(ctx, client, id);
    return fetchOne(ctx, client, id);
  });
};

export const deleteOne = async (ctx: RecordContext, id: string): Promise<{ id: string }> => {
  requireAccess(ctx, 'delete');
  const condition = rowCondition(ctx, 2);
  return withRls(ctx, async (client) => {
    const result = await client.query(
      `UPDATE ${tableOf(ctx)} SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL AND ${condition.sql}`,
      [id, ...condition.params],
    );
    if (result.rowCount === 0) throw new AppError('not_found', `${ctx.object.nameSingular} not found`);
    return { id };
  });
};
