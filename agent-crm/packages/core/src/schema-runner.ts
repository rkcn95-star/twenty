import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inTransaction } from './db.js';
import { AppError } from './errors.js';
import { assertIdentifier, assertUuid, quoteIdent, workspaceSchemaName } from './identifiers.js';
import { FIELD_TYPES, columnNameOf, type FieldType } from './types.js';

const OPTION_PATTERN = /^[A-Za-z0-9_ -]{1,60}$/;

const COLUMN_TYPES: Record<Exclude<FieldType, 'select' | 'multi_select' | 'relation'>, string> = {
  text: 'text',
  number: 'double precision',
  numeric: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  json: 'jsonb',
};

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const bumpVersion = (client: pg.PoolClient, workspaceId: string) =>
  client.query('UPDATE core.metadata_version SET version = version + 1 WHERE workspace_id = $1', [workspaceId]);

export const provisionWorkspace = async (admin: pg.Pool, name: string): Promise<{ id: string; schemaName: string }> => {
  const id = randomUUID();
  const schemaName = workspaceSchemaName(id);
  await inTransaction(admin, async (client) => {
    await client.query('INSERT INTO core.workspaces (id, name, schema_name) VALUES ($1, $2, $3)', [id, name, schemaName]);
    await client.query('INSERT INTO core.metadata_version (workspace_id) VALUES ($1)', [id]);
    await client.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO app_runtime`);
  });
  return { id, schemaName };
};

export type CreateObjectInput = { nameSingular: string; namePlural: string; label: string };

export const createObject = async (admin: pg.Pool, workspaceId: string, input: CreateObjectInput) => {
  const singular = assertIdentifier(input.nameSingular, 'object');
  const plural = assertIdentifier(input.namePlural, 'object');
  if (singular === plural) throw new AppError('validation', 'Singular and plural names must differ');
  const schema = quoteIdent(workspaceSchemaName(workspaceId));
  const table = `${schema}.${quoteIdent(plural)}`;

  return inTransaction(admin, async (client) => {
    const inserted = await client.query(
      `INSERT INTO core.object_definitions (workspace_id, name_singular, name_plural, label)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [workspaceId, singular, plural, input.label],
    );
    const objectId = assertUuid(inserted.rows[0].id);
    const ws = literal(assertUuid(workspaceId));
    const obj = literal(objectId);

    await client.query(
      `CREATE TABLE ${table} (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now(),
         deleted_at timestamptz,
         created_by uuid
       )`,
    );
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_runtime`);
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

    const inList = (setting: string) =>
      `(current_setting('app.workspace_id', true) = ${ws} AND ${obj} = ANY (string_to_array(current_setting('${setting}', true), ',')))`;
    await client.query(`CREATE POLICY rls_select ON ${table} FOR SELECT TO app_runtime USING ${inList('app.read_objects')}`);
    await client.query(`CREATE POLICY rls_insert ON ${table} FOR INSERT TO app_runtime WITH CHECK ${inList('app.write_objects')}`);
    await client.query(
      `CREATE POLICY rls_update ON ${table} FOR UPDATE TO app_runtime USING ${inList('app.write_objects')} WITH CHECK ${inList('app.write_objects')}`,
    );
    await client.query(`CREATE POLICY rls_delete ON ${table} FOR DELETE TO app_runtime USING ${inList('app.write_objects')}`);

    await bumpVersion(client, workspaceId);
    return { id: objectId };
  });
};

export type CreateFieldInput = {
  name: string;
  label: string;
  type: FieldType;
  options?: string[];
  relationObjectId?: string;
};

export const createField = async (admin: pg.Pool, workspaceId: string, objectId: string, input: CreateFieldInput) => {
  const name = assertIdentifier(input.name, 'field');
  if (!FIELD_TYPES.includes(input.type)) throw new AppError('validation', `Unknown field type "${input.type}"`);
  const schema = quoteIdent(workspaceSchemaName(workspaceId));

  return inTransaction(admin, async (client) => {
    const objectRow = (
      await client.query('SELECT name_plural FROM core.object_definitions WHERE id = $1 AND workspace_id = $2', [objectId, workspaceId])
    ).rows[0];
    if (!objectRow) throw new AppError('not_found', 'Object not found');
    const table = `${schema}.${quoteIdent(objectRow.name_plural)}`;
    const column = quoteIdent(columnNameOf({ name, type: input.type }));

    let definition: string;
    let options: string[] | null = null;
    if (input.type === 'select' || input.type === 'multi_select') {
      options = input.options ?? [];
      if (options.length === 0 || !options.every((option) => OPTION_PATTERN.test(option))) {
        throw new AppError('validation', 'Select fields need options matching [A-Za-z0-9_ -]{1,60}');
      }
      const list = options.map(literal).join(', ');
      definition =
        input.type === 'select'
          ? `text CHECK (${column} IN (${list}))`
          : `text[] CHECK (${column} <@ ARRAY[${list}]::text[])`;
    } else if (input.type === 'relation') {
      const target = (
        await client.query('SELECT name_plural FROM core.object_definitions WHERE id = $1 AND workspace_id = $2', [
          input.relationObjectId ?? null,
          workspaceId,
        ])
      ).rows[0];
      if (!target) throw new AppError('validation', 'relationObjectId must be an object in this workspace');
      definition = `uuid REFERENCES ${schema}.${quoteIdent(target.name_plural)}(id)`;
    } else {
      definition = COLUMN_TYPES[input.type];
    }

    const inserted = await client.query(
      `INSERT INTO core.field_definitions (workspace_id, object_id, name, label, type, options, relation_object_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [workspaceId, objectId, name, input.label, input.type, options ? JSON.stringify(options) : null, input.relationObjectId ?? null],
    );
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    await bumpVersion(client, workspaceId);
    return { id: inserted.rows[0].id as string };
  });
};

export const deactivateField = async (admin: pg.Pool, workspaceId: string, fieldId: string) =>
  inTransaction(admin, async (client) => {
    const result = await client.query('UPDATE core.field_definitions SET active = false WHERE id = $1 AND workspace_id = $2', [
      fieldId,
      workspaceId,
    ]);
    if (result.rowCount === 0) throw new AppError('not_found', 'Field not found');
    await bumpVersion(client, workspaceId);
  });
