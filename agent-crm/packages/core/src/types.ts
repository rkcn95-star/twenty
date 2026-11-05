export const FIELD_TYPES = [
  'text', 'number', 'numeric', 'boolean', 'date', 'datetime', 'select', 'multi_select', 'json', 'relation', 'many_to_many',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type FieldDefinition = {
  id: string;
  objectId: string;
  name: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  relationObjectId: string | null;
  active: boolean;
};

export type ObjectDefinition = {
  id: string;
  nameSingular: string;
  namePlural: string;
  label: string;
  fields: FieldDefinition[];
};

export type Tenancy = 'isolated' | 'shared';

export type Metadata = {
  workspaceId: string;
  dataModelId: string;
  tenancy: Tenancy;
  schemaName: string;
  version: number;
  objects: ObjectDefinition[];
};

export type Principal = {
  id: string;
  workspaceId: string;
  kind: 'user' | 'api_key' | 'agent';
  name: string;
};

export const columnNameOf = (field: Pick<FieldDefinition, 'name' | 'type'>): string =>
  field.type === 'relation' ? `${field.name}_id` : field.name;

export const hasColumn = (field: Pick<FieldDefinition, 'type'>): boolean => field.type !== 'many_to_many';
