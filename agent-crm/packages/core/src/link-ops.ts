import { AppError } from './errors.js';
import { junctionTableName, quoteIdent } from './identifiers.js';
import { compilePredicates } from './predicates.js';
import * as records from './records.js';
import { requireAccess, rowCondition, selectList, tableOf, type RecordContext } from './records.js';
import { columnNameOf, type FieldDefinition, type ObjectDefinition } from './types.js';

export const MAX_LINK_IDS = 200;

export type ContextFor = (objectPlural: string) => RecordContext;
export type LinkMode = 'add' | 'remove' | 'set';

// The caller's own context decides everything: metadata, permissions and the transaction all come from it.
const resolveLink = (sourceContext: RecordContext, fieldName: string) => {
  const { metadata, permissions, object } = sourceContext;
  const field = object.fields.find((candidate) => candidate.name === fieldName && candidate.active && candidate.type === 'many_to_many');
  if (!field || permissions.hiddenFieldIds.has(field.id)) throw new AppError('not_found', `"${object.namePlural}.${fieldName}" is not a many-to-many field`);
  const target = metadata.objects.find((candidate) => candidate.id === field.relationObjectId);
  if (!target) throw new AppError('not_found', 'Link target object not found');
  const junction = `${quoteIdent(metadata.schemaName)}.${quoteIdent(junctionTableName(field.id))}`;
  return { field, target, junction };
};

// What a person reads instead of an id: a name, title or label, else the first text field.
export const displayFieldOf = (object: ObjectDefinition): FieldDefinition | undefined => {
  const text = object.fields.filter((field) => field.active && field.type === 'text');
  return ['name', 'title', 'label'].map((name) => text.find((field) => field.name === name)).find(Boolean) ?? text[0];
};

export const listLinksWithin = async (contextFor: ContextFor, args: { object: string; id: string; field: string; limit?: number }) => {
  const sourceContext = contextFor(args.object);
  const { target, junction } = resolveLink(sourceContext, args.field);
  const targetContext = contextFor(target.namePlural);
  await records.findOne(sourceContext, args.id);
  requireAccess(targetContext, 'read');
  const rule = rowCondition(targetContext, 2);
  const limit = Math.min(args.limit ?? 50, 200);
  const result = await targetContext.client!.query(
    `SELECT ${selectList(targetContext)} FROM ${tableOf(targetContext)}
     WHERE deleted_at IS NULL AND ${rule.sql} AND id IN (SELECT target_id FROM ${junction} WHERE source_id = $1)
     ORDER BY created_at DESC, id LIMIT ${limit}`,
    [args.id, ...rule.params],
  );
  return { records: result.rows };
};

// Links of many records in one query, as {id, label} pairs, for tables and forms.
export const listLinksBatchWithin = async (contextFor: ContextFor, args: { object: string; field: string; ids: string[] }) => {
  const sourceContext = contextFor(args.object);
  const { target, junction } = resolveLink(sourceContext, args.field);
  const targetContext = contextFor(target.namePlural);
  requireAccess(sourceContext, 'read');
  requireAccess(targetContext, 'read');
  const hidden = targetContext.permissions.hiddenFieldIds;
  const display = displayFieldOf(target);
  const labelColumn = display && !hidden.has(display.id) ? `t.${quoteIdent(columnNameOf(display))}` : 't.id::text';

  const targetRule = compilePredicates(targetContext.permissions.predicates.get(target.id) ?? null, target, targetContext.principal.id, 2, 't');
  const sourceRule = compilePredicates(
    sourceContext.permissions.predicates.get(sourceContext.object.id) ?? null, sourceContext.object, sourceContext.principal.id, 2 + targetRule.params.length, 's',
  );
  const result = await targetContext.client!.query(
    `SELECT j.source_id, t.id, ${labelColumn} AS label
     FROM ${junction} j
     JOIN ${tableOf(targetContext)} t ON t.id = j.target_id AND t.deleted_at IS NULL AND ${targetRule.sql}
     JOIN ${tableOf(sourceContext)} s ON s.id = j.source_id AND s.deleted_at IS NULL AND ${sourceRule.sql}
     WHERE j.source_id = ANY($1::uuid[]) ORDER BY t.created_at, t.id`,
    [args.ids.slice(0, MAX_LINK_IDS), ...targetRule.params, ...sourceRule.params],
  );
  const links: Record<string, { id: string; label: string }[]> = Object.fromEntries(args.ids.map((id) => [id, []]));
  for (const row of result.rows) links[row.source_id]!.push({ id: row.id, label: String(row.label ?? row.id) });
  return { links };
};

export const editLinksWithin = async (contextFor: ContextFor, mode: LinkMode, args: { object: string; id: string; field: string; targetIds: string[] }) => {
  const sourceContext = contextFor(args.object);
  const { target, junction } = resolveLink(sourceContext, args.field);
  const targetContext = contextFor(target.namePlural);
  const targetIds = [...new Set(args.targetIds)];
  if (targetIds.length > MAX_LINK_IDS) throw new AppError('validation', `At most ${MAX_LINK_IDS} links at once`);
  const client = sourceContext.client!;
  requireAccess(sourceContext, 'update');
  await records.findOne(sourceContext, args.id);

  if (mode !== 'remove' && targetIds.length > 0) {
    requireAccess(targetContext, 'read');
    const rule = rowCondition(targetContext, 2);
    const found = await client.query(
      `SELECT id FROM ${tableOf(targetContext)} WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL AND ${rule.sql}`,
      [targetIds, ...rule.params],
    );
    if (found.rowCount !== targetIds.length) throw new AppError('validation', 'Some target records do not exist');
  }

  if (mode === 'remove') {
    await client.query(`DELETE FROM ${junction} WHERE source_id = $1 AND target_id = ANY($2::uuid[])`, [args.id, targetIds]);
  } else {
    if (mode === 'set') await client.query(`DELETE FROM ${junction} WHERE source_id = $1 AND target_id <> ALL($2::uuid[])`, [args.id, targetIds]);
    if (targetIds.length > 0) {
      const shared = sourceContext.metadata.tenancy === 'shared';
      await client.query(
        shared
          ? `INSERT INTO ${junction} (workspace_id, source_id, target_id) SELECT $3::uuid, $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`
          : `INSERT INTO ${junction} (source_id, target_id) SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        shared ? [args.id, targetIds, sourceContext.metadata.workspaceId] : [args.id, targetIds],
      );
    }
  }
  const count = await client.query(`SELECT count(*)::int AS links FROM ${junction} WHERE source_id = $1`, [args.id]);
  return { links: count.rows[0].links as number };
};
