import { z } from 'zod';
import { AppError } from './errors.js';
import { junctionTableName, quoteIdent } from './identifiers.js';
import * as records from './records.js';
import { rowCondition, selectList, tableOf, requireAccess } from './records.js';
import { DESTRUCTIVE, READ, WRITE, type ToolDefinition, type ToolEnvironment } from './registry.js';
import type { Session } from './session.js';

const MAX_LINK_IDS = 200;

const linkTarget = z.object({
  object: z.string().describe('Plural name of the object that owns the many-to-many field'),
  id: z.uuid().describe('Record id on that object'),
  field: z.string().describe('Name of the many-to-many field'),
});
const linkEdit = linkTarget.extend({ targetIds: z.array(z.uuid()).max(MAX_LINK_IDS) });

const resolveLink = (session: Session, objectPlural: string, fieldName: string) => {
  const source = session.metadata.objects.find((object) => object.namePlural === objectPlural);
  const field = source?.fields.find((candidate) => candidate.name === fieldName && candidate.active && candidate.type === 'many_to_many');
  if (!source || !field || session.permissions.hiddenFieldIds.has(field.id)) {
    throw new AppError('not_found', `"${objectPlural}.${fieldName}" is not a many-to-many field`);
  }
  const target = session.metadata.objects.find((object) => object.id === field.relationObjectId);
  if (!target) throw new AppError('not_found', 'Link target object not found');
  const junction = `${quoteIdent(session.metadata.schemaName)}.${quoteIdent(junctionTableName(field.id))}`;
  return { source, target, junction };
};

export const listLinks = (session: Session, args: z.infer<typeof linkTarget> & { limit?: number }) => {
  const { source, target, junction } = resolveLink(session, args.object, args.field);
  const limit = Math.min(args.limit ?? 50, 200);
  return session.withTransaction(async (contextFor) => {
    const sourceContext = contextFor(source.namePlural);
    const targetContext = contextFor(target.namePlural);
    await records.findOne(sourceContext, args.id);
    requireAccess(targetContext, 'read');
    const rule = rowCondition(targetContext, 2);
    const result = await targetContext.client!.query(
      `SELECT ${selectList(targetContext)} FROM ${tableOf(targetContext)}
       WHERE deleted_at IS NULL AND ${rule.sql} AND id IN (SELECT target_id FROM ${junction} WHERE source_id = $1)
       ORDER BY created_at DESC, id LIMIT ${limit}`,
      [args.id, ...rule.params],
    );
    return { records: result.rows };
  });
};

export const editLinks = (session: Session, mode: 'add' | 'remove' | 'set', args: z.infer<typeof linkEdit>) => {
  const { source, target, junction } = resolveLink(session, args.object, args.field);
  const targetIds = [...new Set(args.targetIds)];
  return session.withTransaction(async (contextFor) => {
    const sourceContext = contextFor(source.namePlural);
    const targetContext = contextFor(target.namePlural);
    const client = sourceContext.client!;
    requireAccess(sourceContext, 'update');
    await records.findOne(sourceContext, args.id);

    if (mode !== 'remove') {
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
      const shared = session.metadata.tenancy === 'shared';
      await client.query(
        shared
          ? `INSERT INTO ${junction} (workspace_id, source_id, target_id) SELECT $3::uuid, $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`
          : `INSERT INTO ${junction} (source_id, target_id) SELECT $1::uuid, unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        shared ? [args.id, targetIds, session.metadata.workspaceId] : [args.id, targetIds],
      );
    }
    const count = await client.query(`SELECT count(*)::int AS links FROM ${junction} WHERE source_id = $1`, [args.id]);
    return { links: count.rows[0].links as number };
  });
};

export const linkTools = (env: ToolEnvironment): ToolDefinition[] => {
  const hasLinkField = env.metadata.objects.some((object) => object.fields.some((field) => field.active && field.type === 'many_to_many'));
  const access = [...env.permissions.objects.values()];
  if (!hasLinkField || !access.some((entry) => entry.read)) return [];

  const tools: ToolDefinition[] = [
    {
      name: 'list_links',
      description: 'List the records linked through a many-to-many field, for example the tags of a deal.',
      category: 'data',
      annotations: READ,
      inputSchema: linkTarget.extend({ limit: z.number().int().min(1).max(200).optional() }),
      run: (args) => listLinks(env.session, args),
    },
  ];
  if (access.some((entry) => entry.update)) {
    tools.push(
      { name: 'add_links', description: 'Link records through a many-to-many field. Existing links are kept.', category: 'data', annotations: { ...WRITE, idempotentHint: true }, inputSchema: linkEdit, run: (args) => editLinks(env.session, 'add', args) },
      { name: 'remove_links', description: 'Remove links through a many-to-many field.', category: 'data', annotations: DESTRUCTIVE, inputSchema: linkEdit, run: (args) => editLinks(env.session, 'remove', args) },
      { name: 'set_links', description: 'Replace all links of a record on a many-to-many field with exactly these records.', category: 'data', annotations: DESTRUCTIVE, inputSchema: linkEdit, run: (args) => editLinks(env.session, 'set', args) },
    );
  }
  return tools;
};
