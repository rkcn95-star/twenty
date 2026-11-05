export type FieldType =
  | 'text' | 'number' | 'numeric' | 'boolean' | 'date' | 'datetime' | 'select' | 'multi_select' | 'json' | 'relation' | 'many_to_many';

export type MetaField = {
  id: string;
  name: string;
  label: string;
  type: FieldType;
  options: string[] | null;
  relationObjectId: string | null;
  readOnly: boolean;
};

export type MetaObject = {
  id: string;
  nameSingular: string;
  namePlural: string;
  label: string;
  fields: MetaField[];
  access: { read: boolean; create: boolean; update: boolean; delete: boolean };
};

export type Metadata = {
  workspaceId: string;
  tenancy: 'isolated' | 'shared';
  canManageSchema: boolean;
  canBuild: boolean;
  canManageAccess: boolean;
  objects: MetaObject[];
};

export type Me = {
  user: { id: string; email: string; name: string };
  workspaces: { principalId: string; workspaceId: string; name: string; tenancy: 'isolated' | 'shared' }[];
};

export type ReportResult = { columns: { key: string; type: string }[]; rows: Record<string, unknown>[]; sql: string };

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text', number: 'Number', numeric: 'Decimal', boolean: 'Boolean', date: 'Date', datetime: 'Date and time',
  select: 'Select', multi_select: 'Multi-select', json: 'JSON', relation: 'Relation', many_to_many: 'Many-to-many',
};

export const SYSTEM_FIELDS: Pick<MetaField, 'name' | 'label' | 'type'>[] = [
  { name: 'id', label: 'ID', type: 'text' },
  { name: 'created_at', label: 'Created at', type: 'datetime' },
  { name: 'updated_at', label: 'Updated at', type: 'datetime' },
];
