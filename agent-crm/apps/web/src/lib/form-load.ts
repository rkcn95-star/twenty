import { callTool } from './api';
import { fieldOf, objectByPlural, type FormDefinition, type FormFieldDef, type FormState, type RowValues } from './form';
import { initialFieldValue } from './record-values';
import type { MetaObject, Metadata, ReportResult } from './types';

type Links = { links: Record<string, { id: string; label: string }[]> };

const loadRows = async (
  workspaceId: string, object: MetaObject, fields: FormFieldDef[], filter: { field: string; value: string }, limit: number,
): Promise<{ id: string; values: RowValues }[]> => {
  const plain = fields.map((definition) => fieldOf(object, definition.name)).filter((field) => field && field.type !== 'many_to_many');
  const linkFields = fields.map((definition) => fieldOf(object, definition.name)).filter((field) => field?.type === 'many_to_many');
  const report = await callTool<ReportResult>(workspaceId, 'run_report', {
    definition: {
      source: object.namePlural,
      columns: [{ key: 'id', ref: { field: 'id' } }, ...plain.map((field) => ({ key: field!.name, ref: { field: field!.name } }))],
      filter: { op: 'and', items: [{ ref: { field: filter.field }, operator: 'eq', value: filter.value }] },
      orderBy: [{ key: 'id', direction: 'asc' }],
      limit,
    },
  });
  const ids = report.rows.map((row) => String(row.id));
  const links: Record<string, Links['links']> = {};
  if (ids.length) {
    for (const field of linkFields) {
      links[field!.name] = (await callTool<Links>(workspaceId, 'list_links_batch', { object: object.namePlural, field: field!.name, ids })).links;
    }
  }
  return report.rows.map((row) => ({
    id: String(row.id),
    values: Object.fromEntries([
      ...plain.map((field) => [field!.name, initialFieldValue(field!, row)] as const),
      ...linkFields.map((field) => [field!.name, (links[field!.name]?.[String(row.id)] ?? []).map((entry) => entry.id)] as const),
    ]),
  }));
};

// Loads an existing record, and for parent and child forms its rows, in the shape the renderer starts from.
export const loadFormState = async (workspaceId: string, definition: FormDefinition, metadata: Metadata, recordId: string): Promise<Partial<FormState>> => {
  if (definition.kind === 'single') {
    const object = objectByPlural(metadata, definition.object)!;
    const [row] = await loadRows(workspaceId, object, definition.fields, { field: 'id', value: recordId }, 1);
    return { single: row?.values ?? {} };
  }
  if (definition.kind === 'parent_child') {
    const parentObject = objectByPlural(metadata, definition.parent.object)!;
    const [parent] = await loadRows(workspaceId, parentObject, definition.parent.fields, { field: 'id', value: recordId }, 1);
    const children: FormState['children'] = {};
    for (const child of definition.children) {
      children[child.key] = await loadRows(workspaceId, objectByPlural(metadata, child.object)!, child.fields, { field: child.relationField, value: recordId }, 100);
    }
    return { parent: parent?.values ?? {}, children };
  }
  return {};
};
