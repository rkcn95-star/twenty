import { initialFieldValue, isEmptyValue, toPayloadValue } from './record-values';
import type { MetaField, MetaObject, Metadata } from './types';

export type FormFieldDef = { name: string; label?: string; required?: boolean; readOnly?: boolean; defaultValue?: unknown };
export type FormSectionDef = { key: string; object: string; fields: FormFieldDef[]; link?: { parent: string; field: string } };
export type FormChildDef = { key: string; object: string; relationField: string; fields: FormFieldDef[]; minRows?: number; maxRows?: number };

export type FormDefinition =
  | { kind: 'single'; object: string; fields: FormFieldDef[] }
  | { kind: 'multi'; sections: FormSectionDef[] }
  | { kind: 'parent_child'; parent: { object: string; fields: FormFieldDef[] }; children: FormChildDef[] };

export type FormKind = FormDefinition['kind'];
export const FORM_KIND_LABELS: Record<FormKind, { title: string; text: string }> = {
  single: { title: 'Single record', text: 'One object, one record per submission.' },
  multi: { title: 'Multiple records', text: 'Several objects on one page, saved together and optionally linked.' },
  parent_child: { title: 'Parent and child rows', text: 'A header record with repeating rows, like an order and its lines.' },
};

export type RowValues = Record<string, unknown>;
export type FormState = {
  single: RowValues;
  sections: Record<string, RowValues>;
  parent: RowValues;
  children: Record<string, { id?: string; values: RowValues }[]>;
};

export const objectByPlural = (metadata: Metadata, plural: string): MetaObject | undefined => metadata.objects.find((object) => object.namePlural === plural);

export const fieldOf = (object: MetaObject | undefined, name: string): MetaField | undefined => object?.fields.find((field) => field.name === name);

export const rowDefaults = (object: MetaObject | undefined, fields: FormFieldDef[], source?: RowValues): RowValues =>
  Object.fromEntries(
    fields.map((definition) => {
      const field = fieldOf(object, definition.name);
      if (!field) return [definition.name, ''];
      return [definition.name, source && definition.name in source ? source[definition.name] : initialFieldValue(field, undefined, definition.defaultValue)];
    }),
  );

export const buildInitialState = (definition: FormDefinition, metadata: Metadata, initial?: Partial<FormState>): FormState => {
  const state: FormState = { single: {}, sections: {}, parent: {}, children: {} };
  if (definition.kind === 'single') state.single = rowDefaults(objectByPlural(metadata, definition.object), definition.fields, initial?.single);
  if (definition.kind === 'multi') {
    for (const section of definition.sections) state.sections[section.key] = rowDefaults(objectByPlural(metadata, section.object), section.fields, initial?.sections?.[section.key]);
  }
  if (definition.kind === 'parent_child') {
    state.parent = rowDefaults(objectByPlural(metadata, definition.parent.object), definition.parent.fields, initial?.parent);
    for (const child of definition.children) {
      const object = objectByPlural(metadata, child.object);
      const existing = initial?.children?.[child.key];
      state.children[child.key] = existing
        ? existing.map((row) => ({ id: row.id, values: rowDefaults(object, child.fields, row.values) }))
        : Array.from({ length: child.minRows ?? 0 }, () => ({ values: rowDefaults(object, child.fields) }));
    }
  }
  return state;
};

const payloadFor = (object: MetaObject | undefined, fields: FormFieldDef[], values: RowValues, editing: boolean): RowValues => {
  const payload: RowValues = {};
  for (const definition of fields) {
    const field = fieldOf(object, definition.name);
    if (!field || definition.readOnly || field.readOnly) continue;
    const value = values[definition.name];
    if (!editing && isEmptyValue(value)) continue;
    payload[definition.name] = toPayloadValue(field, value);
  }
  return payload;
};

// What submit_form expects for each kind of form.
export const buildSubmission = (definition: FormDefinition, metadata: Metadata, state: FormState, recordId?: string) => {
  const editing = Boolean(recordId);
  const base = recordId ? { recordId } : {};
  if (definition.kind === 'single') return { ...base, values: payloadFor(objectByPlural(metadata, definition.object), definition.fields, state.single, editing) };
  if (definition.kind === 'multi') {
    return {
      sections: Object.fromEntries(definition.sections.map((section) => [section.key, payloadFor(objectByPlural(metadata, section.object), section.fields, state.sections[section.key] ?? {}, false)])),
    };
  }
  return {
    ...base,
    parent: payloadFor(objectByPlural(metadata, definition.parent.object), definition.parent.fields, state.parent, editing),
    children: Object.fromEntries(
      definition.children.map((child) => [
        child.key,
        (state.children[child.key] ?? []).map((row) => ({ ...(row.id ? { id: row.id } : {}), values: payloadFor(objectByPlural(metadata, child.object), child.fields, row.values, Boolean(row.id)) })),
      ]),
    ),
  };
};

export const validateState = (definition: FormDefinition, metadata: Metadata, state: FormState): string | null => {
  const missing = (object: MetaObject | undefined, fields: FormFieldDef[], values: RowValues, where: string) => {
    const gap = fields.find((field) => field.required && isEmptyValue(values[field.name]));
    return gap ? `${where}: "${gap.label ?? fieldOf(object, gap.name)?.label ?? gap.name}" is required` : null;
  };
  if (definition.kind === 'single') return missing(objectByPlural(metadata, definition.object), definition.fields, state.single, 'Form');
  if (definition.kind === 'multi') {
    for (const section of definition.sections) {
      const problem = missing(objectByPlural(metadata, section.object), section.fields, state.sections[section.key] ?? {}, section.key);
      if (problem) return problem;
    }
    return null;
  }
  const parentProblem = missing(objectByPlural(metadata, definition.parent.object), definition.parent.fields, state.parent, 'Header');
  if (parentProblem) return parentProblem;
  for (const child of definition.children) {
    const rows = state.children[child.key] ?? [];
    if (rows.length < (child.minRows ?? 0)) return `${child.key}: at least ${child.minRows} row${child.minRows === 1 ? '' : 's'} needed`;
    for (const [index, row] of rows.entries()) {
      const problem = missing(objectByPlural(metadata, child.object), child.fields, row.values, `${child.key} row ${index + 1}`);
      if (problem) return problem;
    }
  }
  return null;
};

export const objectsUsedBy = (definition: FormDefinition): string[] =>
  definition.kind === 'single' ? [definition.object] : definition.kind === 'multi' ? definition.sections.map((section) => section.object) : [definition.parent.object, ...definition.children.map((child) => child.object)];
