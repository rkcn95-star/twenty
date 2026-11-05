import { hasColumn, type Aggregate, type ReportDefinition } from '@/lib/report';
import { SYSTEM_FIELDS, type FieldType, type MetaField, type MetaObject, type Metadata } from '@/lib/types';

export type Scope = { alias: string; label: string; object: MetaObject };
export type ScopeField = { value: string; label: string; alias: string; field: string; type: FieldType; meta?: MetaField };

export const ROOT = 'root';

export const resolveScopes = (definition: ReportDefinition, metadata: Metadata): Scope[] => {
  const source = metadata.objects.find((object) => object.namePlural === definition.source);
  if (!source) return [];
  const scopes: Scope[] = [{ alias: ROOT, label: source.label, object: source }];
  for (const join of definition.joins ?? []) {
    const from = scopes.find((scope) => scope.alias === (join.from ?? ROOT));
    const field = from?.object.fields.find((candidate) => candidate.name === join.field);
    const target = metadata.objects.find((object) => object.id === field?.relationObjectId);
    if (target) scopes.push({ alias: join.alias, label: `${field!.label} → ${target.label}`, object: target });
  }
  return scopes;
};

export const encodeField = (alias: string, field: string) => `${alias}::${field}`;
export const decodeField = (value: string): { alias?: string; field: string } => {
  const [alias, field] = value.split('::');
  return { alias: alias === ROOT ? undefined : alias, field: field! };
};

export const scopeFields = (scopes: Scope[]): ScopeField[] =>
  scopes.flatMap((scope) => [
    ...scope.object.fields.filter(hasColumn).map<ScopeField>((field) => ({
      value: encodeField(scope.alias, field.name), label: scopes.length > 1 ? `${scope.label} · ${field.label}` : field.label,
      alias: scope.alias, field: field.name, type: field.type, meta: field,
    })),
    ...SYSTEM_FIELDS.map<ScopeField>((field) => ({
      value: encodeField(scope.alias, field.name), label: scopes.length > 1 ? `${scope.label} · ${field.label}` : field.label,
      alias: scope.alias, field: field.name, type: field.type,
    })),
  ]);

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  count: 'Count', count_distinct: 'Count distinct', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum',
};

export const aggregatesFor = (type: FieldType | undefined): Aggregate[] => {
  if (!type) return ['count'];
  if (type === 'number' || type === 'numeric') return ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'];
  if (type === 'date' || type === 'datetime') return ['count', 'count_distinct', 'min', 'max'];
  return ['count', 'count_distinct'];
};

export const isTemporal = (type: FieldType | undefined) => type === 'date' || type === 'datetime';

export const relationFieldsOf = (object: MetaObject): MetaField[] => object.fields.filter((field) => field.type === 'relation' || field.type === 'many_to_many');
