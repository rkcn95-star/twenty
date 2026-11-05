import { AppError } from './errors.js';

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const RESERVED_NAMES = new Set([
  'id', 'created_at', 'updated_at', 'deleted_at', 'created_by', 'core',
  'select', 'insert', 'update', 'delete', 'table', 'user', 'order', 'group', 'where',
]);

export const assertIdentifier = (name: string, kind: string): string => {
  if (!IDENTIFIER_PATTERN.test(name) || RESERVED_NAMES.has(name) || name.endsWith('_id')) {
    throw new AppError('validation', `Invalid ${kind} name "${name}"`);
  }
  return name;
};

export const assertUuid = (value: string): string => {
  if (!UUID_PATTERN.test(value)) throw new AppError('validation', `Invalid uuid "${value}"`);
  return value;
};

export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const dataModelSchemaName = (dataModelId: string, tenancy: 'isolated' | 'shared'): string =>
  `${tenancy === 'shared' ? 'shared' : 'ws'}_${assertUuid(dataModelId).replaceAll('-', '')}`;
