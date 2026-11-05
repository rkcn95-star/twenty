import type pg from 'pg';
import type { ZodType } from 'zod';
import { AppError } from './errors.js';
import { formDefinitionSchema } from './form.js';
import { gridDefinitionSchema } from './grid.js';
import { reportDefinitionSchema } from './report.js';

export const DEFINITION_KINDS = ['form', 'grid', 'report'] as const;
export type DefinitionKind = (typeof DEFINITION_KINDS)[number];

export const DEFINITION_SCHEMAS: Record<DefinitionKind, ZodType> = {
  form: formDefinitionSchema,
  grid: gridDefinitionSchema,
  report: reportDefinitionSchema,
};

export const upsertDefinition = async (
  admin: pg.Pool,
  workspaceId: string,
  principalId: string,
  kind: DefinitionKind,
  name: string,
  definition: unknown,
) => {
  const result = await admin.query(
    `INSERT INTO core.definitions (workspace_id, kind, name, definition, created_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, kind, name) DO UPDATE SET definition = EXCLUDED.definition, updated_at = now()
     RETURNING id`,
    [workspaceId, kind, name, JSON.stringify(definition), principalId],
  );
  return { id: result.rows[0].id as string };
};

export const fetchDefinition = async <TDefinition>(admin: pg.Pool, workspaceId: string, kind: DefinitionKind, name: string): Promise<TDefinition> => {
  const result = await admin.query('SELECT definition FROM core.definitions WHERE workspace_id = $1 AND kind = $2 AND name = $3', [
    workspaceId,
    kind,
    name,
  ]);
  if (!result.rows[0]) throw new AppError('not_found', `No ${kind} named "${name}"`);
  return DEFINITION_SCHEMAS[kind].parse(result.rows[0].definition) as TDefinition;
};

export const listDefinitions = async (admin: pg.Pool, workspaceId: string, kind?: DefinitionKind) => {
  const result = await admin.query(
    'SELECT kind, name, updated_at FROM core.definitions WHERE workspace_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY kind, name',
    [workspaceId, kind ?? null],
  );
  return result.rows;
};
