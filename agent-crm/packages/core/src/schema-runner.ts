import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inTransaction } from './db.js';
import { AppError } from './errors.js';
import { assertIdentifier, assertUuid, dataModelSchemaName, quoteIdent } from './identifiers.js';
import { FIELD_TYPES, columnNameOf, type FieldType, type Tenancy } from './types.js';

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

const bumpVersion = (client: pg.PoolClient, dataModelId: string) =>
  client.query('UPDATE core.metadata_version SET version = version + 1 WHERE data_model_id = $1', [dataModelId]);

type DataModelRow = { tenancy: Tenancy; schemaName: string };

// Locks the model row so concurrent schema changes on the same model run one at a time.
const lockDataModel = async (client: pg.PoolClient, dataModelId: string): Promise<DataModelRow> => {
  const row = (await client.query('SELECT tenancy, schema_name FROM core.data_models WHERE id = $1 FOR UPDATE', [dataModelId])).rows[0];
  if (!row) throw new AppError('not_found', 'Data model not found');
  return { tenancy: row.tenancy, schemaName: row.schema_name };
};

const insertDataModel = async (client: pg.PoolClient, name: string, tenancy: Tenancy) => {
  const id = randomUUID();
  const schemaName = dataModelSchemaName(id, tenancy);
  await client.query('INSERT INTO core.data_models (id, name, tenancy, schema_name) VALUES ($1, $2, $3, $4)', [id, name, tenancy, schemaName]);
  await client.query('INSERT INTO core.metadata_version (data_model_id) VALUES ($1)', [id]);
  await client.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);
  await client.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schemaName)} TO app_runtime`);
  return { id, schemaName, tenancy };
};

export const createDataModel = (admin: pg.Pool, name: string, tenancy: Tenancy) =>
  inTransaction(admin, (client) => insertDataModel(client, name, tenancy));

export type ProvisionedWorkspace = { id: string; dataModelId: string; schemaName: string; tenancy: Tenancy };

// Without dataModelId the workspace gets its own schema. With one, it joins a shared model.
export const provisionWorkspace = async (
  admin: pg.Pool,
  name: string,
  options: { dataModelId?: string } = {},
): Promise<ProvisionedWorkspace> => {
  const id = randomUUID();
  return inTransaction(admin, async (client) => {
    let model: { id: string; schemaName: string; tenancy: Tenancy };
    if (options.dataModelId) {
      const row = (await client.query('SELECT id, tenancy, schema_name FROM core.data_models WHERE id = $1', [options.dataModelId])).rows[0];
      if (!row) throw new AppError('not_found', 'Data model not found');
      if (row.tenancy !== 'shared') throw new AppError('conflict', 'An isolated data model belongs to one workspace');
      model = { id: row.id, schemaName: row.schema_name, tenancy: row.tenancy };
    } else {
      model = await insertDataModel(client, name, 'isolated');
    }
    await client.query('INSERT INTO core.workspaces (id, name, data_model_id) VALUES ($1, $2, $3)', [id, name, model.id]);
    return { id, dataModelId: model.id, schemaName: model.schemaName, tenancy: model.tenancy };
  });
};

export type CreateObjectInput = { nameSingular: string; namePlural: string; label: string };

export const createObject = async (admin: pg.Pool, dataModelId: string, input: CreateObjectInput) => {
  const singular = assertIdentifier(input.nameSingular, 'object');
  const plural = assertIdentifier(input.namePlural, 'object');
  if (singular === plural) throw new AppError('validation', 'Singular and plural names must differ');

  return inTransaction(admin, async (client) => {
    const model = await lockDataModel(client, dataModelId);
    const table = `${quoteIdent(model.schemaName)}.${quoteIdent(plural)}`;
    const inserted = await client.query(
      `INSERT INTO core.object_definitions (data_model_id, name_singular, name_plural, label) VALUES ($1, $2, $3, $4) RETURNING id`,
      [dataModelId, singular, plural, input.label],
    );
    const objectId = assertUuid(inserted.rows[0].id);
    const obj = literal(objectId);

    // An isolated model has exactly one workspace; a shared model filters on the workspace_id column.
    let tenantCheck: string;
    if (model.tenancy === 'shared') {
      tenantCheck = "workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid";
      await client.query(
        `CREATE TABLE ${table} (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           workspace_id uuid NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now(),
           deleted_at timestamptz,
           created_by uuid,
           UNIQUE (workspace_id, id)
         )`,
      );
    } else {
      const owner = (await client.query('SELECT id FROM core.workspaces WHERE data_model_id = $1', [dataModelId])).rows[0];
      if (!owner) throw new AppError('conflict', 'Isolated data model has no workspace');
      tenantCheck = `current_setting('app.workspace_id', true) = ${literal(assertUuid(owner.id))}`;
      await client.query(
        `CREATE TABLE ${table} (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           created_at timestamptz NOT NULL DEFAULT now(),
           updated_at timestamptz NOT NULL DEFAULT now(),
           deleted_at timestamptz,
           created_by uuid
         )`,
      );
    }
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_runtime`);
    await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);

    const allowed = (setting: string) =>
      `(${tenantCheck} AND ${obj} = ANY (string_to_array(current_setting('${setting}', true), ',')))`;
    await client.query(`CREATE POLICY rls_select ON ${table} FOR SELECT TO app_runtime USING ${allowed('app.read_objects')}`);
    await client.query(`CREATE POLICY rls_insert ON ${table} FOR INSERT TO app_runtime WITH CHECK ${allowed('app.write_objects')}`);
    await client.query(
      `CREATE POLICY rls_update ON ${table} FOR UPDATE TO app_runtime USING ${allowed('app.write_objects')} WITH CHECK ${allowed('app.write_objects')}`,
    );
    await client.query(`CREATE POLICY rls_delete ON ${table} FOR DELETE TO app_runtime USING ${allowed('app.write_objects')}`);

    await bumpVersion(client, dataModelId);
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

export const createField = async (admin: pg.Pool, dataModelId: string, objectId: string, input: CreateFieldInput) => {
  const name = assertIdentifier(input.name, 'field');
  if (!FIELD_TYPES.includes(input.type)) throw new AppError('validation', `Unknown field type "${input.type}"`);

  return inTransaction(admin, async (client) => {
    const model = await lockDataModel(client, dataModelId);
    const schema = quoteIdent(model.schemaName);
    const objectRow = (
      await client.query('SELECT name_plural FROM core.object_definitions WHERE id = $1 AND data_model_id = $2', [objectId, dataModelId])
    ).rows[0];
    if (!objectRow) throw new AppError('not_found', 'Object not found');
    const table = `${schema}.${quoteIdent(objectRow.name_plural)}`;
    const column = quoteIdent(columnNameOf({ name, type: input.type }));

    let definition: string;
    let extraClause = '';
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
        await client.query('SELECT name_plural FROM core.object_definitions WHERE id = $1 AND data_model_id = $2', [
          input.relationObjectId ?? null,
          dataModelId,
        ])
      ).rows[0];
      if (!target) throw new AppError('validation', 'relationObjectId must be an object in this data model');
      const targetTable = `${schema}.${quoteIdent(target.name_plural)}`;
      if (model.tenancy === 'shared') {
        // Foreign keys skip RLS, so the key includes workspace_id to stop a tenant referencing another tenant's row.
        definition = 'uuid';
        extraClause = `, ADD FOREIGN KEY (workspace_id, ${column}) REFERENCES ${targetTable} (workspace_id, id)`;
      } else {
        definition = `uuid REFERENCES ${targetTable}(id)`;
      }
    } else {
      definition = COLUMN_TYPES[input.type];
    }

    const inserted = await client.query(
      `INSERT INTO core.field_definitions (data_model_id, object_id, name, label, type, options, relation_object_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [dataModelId, objectId, name, input.label, input.type, options ? JSON.stringify(options) : null, input.relationObjectId ?? null],
    );
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}${extraClause}`);
    await bumpVersion(client, dataModelId);
    return { id: inserted.rows[0].id as string };
  });
};

export const deactivateField = async (admin: pg.Pool, dataModelId: string, fieldId: string) =>
  inTransaction(admin, async (client) => {
    const result = await client.query('UPDATE core.field_definitions SET active = false WHERE id = $1 AND data_model_id = $2', [
      fieldId,
      dataModelId,
    ]);
    if (result.rowCount === 0) throw new AppError('not_found', 'Field not found');
    await bumpVersion(client, dataModelId);
  });
