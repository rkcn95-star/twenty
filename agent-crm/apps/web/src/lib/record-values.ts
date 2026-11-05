import type { MetaField } from './types';

export type RecordRow = Record<string, unknown>;

export const emptyValue = (field: MetaField): unknown =>
  field.type === 'boolean' ? false : field.type === 'multi_select' || field.type === 'many_to_many' ? [] : '';

// Table rows carry relation ids under `<name>__id`; forms edit the id, tables show the label.
export const initialFieldValue = (field: MetaField, record?: RecordRow, fallback?: unknown): unknown => {
  if (!record) return fallback !== undefined && fallback !== null ? fallback : emptyValue(field);
  const raw = field.type === 'relation' ? (record[`${field.name}__id`] ?? record[field.name]) : record[field.name];
  if (raw === null || raw === undefined) return emptyValue(field);
  if (field.type === 'datetime') return new Date(String(raw)).toISOString().slice(0, 16);
  if (field.type === 'date') return String(raw).slice(0, 10);
  if (field.type === 'json') return JSON.stringify(raw, null, 2);
  return raw;
};

export const isEmptyValue = (value: unknown): boolean => value === '' || value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0);

export const toPayloadValue = (field: MetaField, value: unknown): unknown => {
  if (field.type === 'many_to_many') return value ?? [];
  if (value === '' || value === undefined) return null;
  switch (field.type) {
    case 'number':
    case 'numeric': return Number(value);
    case 'datetime': return new Date(String(value)).toISOString();
    case 'json': return JSON.parse(String(value));
    default: return value;
  }
};
