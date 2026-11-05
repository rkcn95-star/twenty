import { z } from 'zod';

export const IDENTIFIER_KEY = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null'] as const;
export type Operator = (typeof OPERATORS)[number];

export const fieldRefSchema = z.object({ alias: z.string().optional(), field: z.string() });
export type FieldRef = z.infer<typeof fieldRefSchema>;

export type FilterCondition = { ref: FieldRef; operator: Operator; value?: unknown };
export type FilterGroup = { op: 'and' | 'or'; items: (FilterCondition | FilterGroup)[] };

const conditionSchema = z.object({ ref: fieldRefSchema, operator: z.enum(OPERATORS), value: z.unknown().optional() });

export const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({ op: z.enum(['and', 'or']), items: z.array(z.union([conditionSchema, filterGroupSchema])).max(50) }),
);

export const isGroup = (node: FilterCondition | FilterGroup): node is FilterGroup => 'items' in node;
