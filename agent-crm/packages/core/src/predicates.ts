import { AppError } from './errors.js';
import type { PredicateGroups } from './permissions.js';
import { columnNameOf, type ObjectDefinition } from './types.js';
import { quoteIdent } from './identifiers.js';

const SYSTEM_COLUMNS = new Set(['id', 'created_by', 'created_at', 'updated_at']);
const COMPARATORS: Record<string, string> = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const PRINCIPAL_PLACEHOLDER = '$principal';

export type CompiledCondition = { sql: string; params: unknown[] };

export const compilePredicates = (
  groups: PredicateGroups,
  object: ObjectDefinition,
  principalId: string,
  firstParamIndex: number,
  tableAlias?: string,
): CompiledCondition => {
  if (groups === null) return { sql: 'TRUE', params: [] };
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value === PRINCIPAL_PLACEHOLDER ? principalId : value);
    return `$${firstParamIndex + params.length - 1}`;
  };

  const prefix = tableAlias ? `${tableAlias}.` : '';
  const columnFor = (fieldName: string): string => {
    if (SYSTEM_COLUMNS.has(fieldName)) return `${prefix}${quoteIdent(fieldName)}`;
    const field = object.fields.find((candidate) => candidate.name === fieldName && candidate.active);
    if (!field) throw new AppError('validation', `Row predicate references unknown field "${fieldName}"`);
    return `${prefix}${quoteIdent(columnNameOf(field))}`;
  };

  const groupSql = groups.map((group) => {
    const parts = group.map(({ fieldName, operator, value }) => {
      const column = columnFor(fieldName);
      if (operator === 'is_null') return value === false ? `${column} IS NOT NULL` : `${column} IS NULL`;
      if (operator === 'neq') return `${column} IS DISTINCT FROM ${addParam(value)}`;
      if (operator === 'in') {
        const values = Array.isArray(value) ? value : [value];
        return `${column} = ANY (${addParam(values.map((item) => (item === PRINCIPAL_PLACEHOLDER ? principalId : item)))})`;
      }
      const comparator = COMPARATORS[operator];
      if (!comparator) throw new AppError('validation', `Unknown operator "${operator}"`);
      return `${column} ${comparator} ${addParam(value)}`;
    });
    return `(${parts.length ? parts.join(' AND ') : 'TRUE'})`;
  });
  return { sql: groupSql.length ? `(${groupSql.join(' OR ')})` : 'FALSE', params };
};
