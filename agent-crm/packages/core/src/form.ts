import { z } from 'zod';
import { AppError } from './errors.js';
import { IDENTIFIER_KEY } from './filters.js';
import * as records from './records.js';
import type { RecordContext } from './records.js';
import type { Metadata, ObjectDefinition } from './types.js';

const MAX_CHILD_ROWS = 100;

const formFieldSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  required: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
});
type FormField = z.infer<typeof formFieldSchema>;

const fieldList = z.array(formFieldSchema).min(1).max(100);

export const formDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), object: z.string(), fields: fieldList }),
  z.object({
    kind: z.literal('multi'),
    sections: z
      .array(
        z.object({
          key: IDENTIFIER_KEY,
          object: z.string(),
          fields: fieldList,
          link: z.object({ parent: IDENTIFIER_KEY, field: z.string() }).optional(),
        }),
      )
      .min(2)
      .max(10),
  }),
  z.object({
    kind: z.literal('parent_child'),
    parent: z.object({ object: z.string(), fields: fieldList }),
    children: z
      .array(
        z.object({
          key: IDENTIFIER_KEY,
          object: z.string(),
          relationField: z.string(),
          fields: fieldList,
          minRows: z.number().int().min(0).max(MAX_CHILD_ROWS).optional(),
          maxRows: z.number().int().min(1).max(MAX_CHILD_ROWS).optional(),
        }),
      )
      .min(1)
      .max(5),
  }),
]);

export type FormDefinition = z.infer<typeof formDefinitionSchema>;

export const formSubmissionSchema = z.object({
  recordId: z.uuid().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  sections: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  parent: z.record(z.string(), z.unknown()).optional(),
  children: z
    .record(z.string(), z.array(z.object({ id: z.uuid().optional(), values: z.record(z.string(), z.unknown()) })).max(MAX_CHILD_ROWS))
    .optional(),
});
export type FormSubmission = z.infer<typeof formSubmissionSchema>;

const objectByName = (metadata: Metadata, plural: string): ObjectDefinition => {
  const object = metadata.objects.find((candidate) => candidate.namePlural === plural);
  if (!object) throw new AppError('validation', `Unknown object "${plural}"`);
  return object;
};

const assertFieldsExist = (object: ObjectDefinition, fields: FormField[]) => {
  for (const field of fields) {
    if (!object.fields.some((candidate) => candidate.name === field.name && candidate.active && candidate.type !== 'many_to_many')) {
      throw new AppError('validation', `Object "${object.namePlural}" has no field "${field.name}"`);
    }
  }
};

const assertRelation = (child: ObjectDefinition, fieldName: string, parent: ObjectDefinition) => {
  const field = child.fields.find((candidate) => candidate.name === fieldName && candidate.active);
  if (field?.type !== 'relation' || field.relationObjectId !== parent.id) {
    throw new AppError('validation', `"${child.namePlural}.${fieldName}" must be a relation to ${parent.namePlural}`);
  }
};

export const validateFormDefinition = (definition: FormDefinition, metadata: Metadata) => {
  if (definition.kind === 'single') {
    assertFieldsExist(objectByName(metadata, definition.object), definition.fields);
  } else if (definition.kind === 'multi') {
    const seen = new Map<string, ObjectDefinition>();
    for (const section of definition.sections) {
      if (seen.has(section.key)) throw new AppError('validation', `Duplicate section "${section.key}"`);
      const object = objectByName(metadata, section.object);
      assertFieldsExist(object, section.fields);
      if (section.link) {
        const parent = seen.get(section.link.parent);
        if (!parent) throw new AppError('validation', `Section "${section.key}" links to "${section.link.parent}", which must come earlier`);
        assertRelation(object, section.link.field, parent);
        if (section.fields.some((field) => field.name === section.link?.field)) {
          throw new AppError('validation', `Link field "${section.link.field}" is set automatically; remove it from the form`);
        }
      }
      seen.set(section.key, object);
    }
  } else {
    const parent = objectByName(metadata, definition.parent.object);
    assertFieldsExist(parent, definition.parent.fields);
    const keys = new Set<string>();
    for (const child of definition.children) {
      if (keys.has(child.key)) throw new AppError('validation', `Duplicate child "${child.key}"`);
      keys.add(child.key);
      const object = objectByName(metadata, child.object);
      assertFieldsExist(object, child.fields);
      assertRelation(object, child.relationField, parent);
      if (child.fields.some((field) => field.name === child.relationField)) {
        throw new AppError('validation', `Relation field "${child.relationField}" is set automatically; remove it from the form`);
      }
      if (child.minRows !== undefined && child.maxRows !== undefined && child.minRows > child.maxRows) {
        throw new AppError('validation', `Child "${child.key}" has minRows above maxRows`);
      }
    }
  }
};

const prepareValues = (fields: FormField[], values: Record<string, unknown> | undefined, isCreate: boolean): Record<string, unknown> => {
  const input = { ...(values ?? {}) };
  const allowed = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new AppError('validation', `Field "${key}" is not part of this form`);
  }
  for (const field of fields) {
    if (field.readOnly && input[field.name] !== undefined) throw new AppError('validation', `Field "${field.name}" is read-only`);
    if (input[field.name] === undefined && isCreate && field.defaultValue !== undefined) input[field.name] = field.defaultValue;
    const value = input[field.name];
    if (field.required && isCreate && (value === undefined || value === null || value === '')) {
      throw new AppError('validation', `Field "${field.name}" is required`);
    }
  }
  return input;
};

type ContextFor = (objectName: string) => RecordContext;

export const submitForm = async (
  definition: FormDefinition,
  submission: FormSubmission,
  contextFor: ContextFor,
): Promise<{ ids: Record<string, unknown> }> => {
  if (definition.kind === 'single') {
    const ctx = contextFor(definition.object);
    const values = prepareValues(definition.fields, submission.values, !submission.recordId);
    const row = submission.recordId ? await records.updateOne(ctx, submission.recordId, values) : await records.createOne(ctx, values);
    return { ids: { id: row.id } };
  }

  if (definition.kind === 'multi') {
    if (submission.recordId) throw new AppError('validation', 'Editing is not supported for multi-record forms');
    const ids: Record<string, unknown> = {};
    for (const section of definition.sections) {
      const values = prepareValues(section.fields, submission.sections?.[section.key], true);
      if (section.link) values[section.link.field] = ids[section.link.parent];
      const row = await records.createOne(contextFor(section.object), values);
      ids[section.key] = row.id;
    }
    return { ids };
  }

  const parentCtx = contextFor(definition.parent.object);
  const isCreate = !submission.recordId;
  const parentValues = prepareValues(definition.parent.fields, submission.parent, isCreate);
  const parent = submission.recordId
    ? await records.updateOne(parentCtx, submission.recordId, parentValues)
    : await records.createOne(parentCtx, parentValues);
  const parentId = parent.id as string;

  const childIds: Record<string, string[]> = {};
  for (const child of definition.children) {
    const rows = submission.children?.[child.key] ?? [];
    if (rows.length < (child.minRows ?? 0)) throw new AppError('validation', `"${child.key}" needs at least ${child.minRows} rows`);
    if (child.maxRows !== undefined && rows.length > child.maxRows) throw new AppError('validation', `"${child.key}" allows at most ${child.maxRows} rows`);

    const childCtx = contextFor(child.object);
    const existing = isCreate
      ? []
      : (await records.findMany(childCtx, { filter: { [child.relationField]: parentId }, limit: MAX_CHILD_ROWS })).records.map((row) => row.id as string);
    const keep = new Set<string>();
    const createdIds: string[] = [];
    childIds[child.key] = createdIds;

    for (const row of rows) {
      const values = prepareValues(child.fields, row.values, !row.id);
      if (row.id) {
        if (!existing.includes(row.id)) throw new AppError('validation', `Row ${row.id} does not belong to this record`);
        keep.add(row.id);
        await records.updateOne(childCtx, row.id, values);
        createdIds.push(row.id);
      } else {
        const created = await records.createOne(childCtx, { ...values, [child.relationField]: parentId });
        createdIds.push(created.id as string);
      }
    }
    for (const id of existing) if (!keep.has(id)) await records.deleteOne(childCtx, id);
  }
  return { ids: { id: parentId, children: childIds } };
};
