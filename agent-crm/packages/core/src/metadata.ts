import type pg from 'pg';
import { AppError } from './errors.js';
import type { FieldDefinition, FieldType, Metadata, ObjectDefinition } from './types.js';

const cache = new Map<string, Metadata>();

export const loadMetadata = async (admin: pg.Pool, workspaceId: string): Promise<Metadata> => {
  const versionResult = await admin.query(
    `SELECT m.id AS data_model_id, m.tenancy, m.schema_name, v.version FROM core.workspaces w
     JOIN core.data_models m ON m.id = w.data_model_id
     JOIN core.metadata_version v ON v.data_model_id = m.id WHERE w.id = $1`,
    [workspaceId],
  );
  const header = versionResult.rows[0];
  if (!header) throw new AppError('not_found', 'Workspace not found');
  const version = Number(header.version);
  const cached = cache.get(workspaceId);
  if (cached && cached.version === version) return cached;

  const [objectRows, fieldRows] = await Promise.all([
    admin.query('SELECT * FROM core.object_definitions WHERE data_model_id = $1 ORDER BY created_at', [header.data_model_id]),
    admin.query('SELECT * FROM core.field_definitions WHERE data_model_id = $1 ORDER BY name', [header.data_model_id]),
  ]);
  const fieldsByObject = new Map<string, FieldDefinition[]>();
  for (const row of fieldRows.rows) {
    const field: FieldDefinition = {
      id: row.id,
      objectId: row.object_id,
      name: row.name,
      label: row.label,
      type: row.type as FieldType,
      options: row.options,
      relationObjectId: row.relation_object_id,
      active: row.active,
    };
    fieldsByObject.set(field.objectId, [...(fieldsByObject.get(field.objectId) ?? []), field]);
  }
  const objects: ObjectDefinition[] = objectRows.rows.map((row) => ({
    id: row.id,
    nameSingular: row.name_singular,
    namePlural: row.name_plural,
    label: row.label,
    fields: fieldsByObject.get(row.id) ?? [],
  }));
  const metadata: Metadata = {
    workspaceId,
    dataModelId: header.data_model_id,
    tenancy: header.tenancy,
    schemaName: header.schema_name,
    version,
    objects,
  };
  cache.set(workspaceId, metadata);
  return metadata;
};
