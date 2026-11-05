import { z } from 'zod';
import { MAX_LINK_IDS, editLinksWithin, listLinksBatchWithin, listLinksWithin, type LinkMode } from './link-ops.js';
import { DESTRUCTIVE, READ, WRITE, type ToolDefinition, type ToolEnvironment } from './registry.js';
import type { Session } from './session.js';

const linkTarget = z.object({
  object: z.string().describe('Plural name of the object that owns the many-to-many field'),
  id: z.uuid().describe('Record id on that object'),
  field: z.string().describe('Name of the many-to-many field'),
});
const linkEdit = linkTarget.extend({ targetIds: z.array(z.uuid()).max(MAX_LINK_IDS) });

export const listLinks = (session: Session, args: z.infer<typeof linkTarget> & { limit?: number }) =>
  session.withTransaction((contextFor) => listLinksWithin(contextFor, args));

export const editLinks = (session: Session, mode: LinkMode, args: z.infer<typeof linkEdit>) =>
  session.withTransaction((contextFor) => editLinksWithin(contextFor, mode, args));

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
  tools.push({
    name: 'list_links_batch',
    description: 'Links of many records through a many-to-many field in one call, as {id, label} pairs keyed by record id. For tables and forms.',
    category: 'data',
    annotations: READ,
    inputSchema: z.object({ object: z.string(), field: z.string(), ids: z.array(z.uuid()).max(MAX_LINK_IDS) }),
    run: (args) => env.session.withTransaction((contextFor) => listLinksBatchWithin(contextFor, args)),
  });
  if (access.some((entry) => entry.update)) {
    tools.push(
      { name: 'add_links', description: 'Link records through a many-to-many field. Existing links are kept.', category: 'data', annotations: { ...WRITE, idempotentHint: true }, inputSchema: linkEdit, run: (args) => editLinks(env.session, 'add', args) },
      { name: 'remove_links', description: 'Remove links through a many-to-many field.', category: 'data', annotations: DESTRUCTIVE, inputSchema: linkEdit, run: (args) => editLinks(env.session, 'remove', args) },
      { name: 'set_links', description: 'Replace all links of a record on a many-to-many field with exactly these records.', category: 'data', annotations: DESTRUCTIVE, inputSchema: linkEdit, run: (args) => editLinks(env.session, 'set', args) },
    );
  }
  return tools;
};
