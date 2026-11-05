import { z } from 'zod';
import { builderTools } from './builder-tools.js';
import { accessTools } from './access-tools.js';
import { linkTools } from './links.js';
import { createField, createObject } from './schema-runner.js';
import { FIELD_TYPES } from './types.js';
import * as records from './records.js';
import { filterSchemaFor, inputSchemaFor, type RecordContext } from './records.js';
import type { Databases } from './db.js';
import type { Metadata, ObjectDefinition, Principal } from './types.js';
import type { PermissionSet } from './permissions.js';
import type { Session } from './session.js';

export type ToolAnnotations = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };

export type ToolDefinition = {
  name: string;
  description: string;
  category: 'data' | 'schema' | 'builder' | 'access';
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
  run: (args: any) => Promise<unknown>;
};

export type ToolEnvironment = {
  databases: Databases;
  principal: Principal;
  metadata: Metadata;
  permissions: PermissionSet;
  session: Session;
};

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

const idSchema = z.object({ id: z.uuid() });

const objectTools = (env: ToolEnvironment, object: ObjectDefinition): ToolDefinition[] => {
  const access = env.permissions.objects.get(object.id);
  if (!access?.read && !access?.create && !access?.update && !access?.delete) return [];
  const ctx: RecordContext = {
    runtime: env.databases.runtime,
    metadata: env.metadata,
    object,
    permissions: env.permissions,
    principal: env.principal,
  };
  const tools: ToolDefinition[] = [];

  if (access.read) {
    tools.push({
      name: `find_many_${object.namePlural}`,
      description: `List ${object.label} records. Optional equality filter on fields, limit (max 100) and offset.`,
      category: 'data',
      annotations: READ,
      inputSchema: z.object({
        filter: filterSchemaFor(ctx).partial().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      run: (args) => records.findMany(ctx, args),
    });
    tools.push({
      name: `find_one_${object.nameSingular}`,
      description: `Get one ${object.label} record by id.`,
      category: 'data',
      annotations: READ,
      inputSchema: idSchema,
      run: (args) => records.findOne(ctx, args.id),
    });
  }
  if (access.create) {
    tools.push({
      name: `create_one_${object.nameSingular}`,
      description: `Create a ${object.label} record.`,
      category: 'data',
      annotations: WRITE,
      inputSchema: z.object({ data: inputSchemaFor(ctx) }),
      run: (args) => records.createOne(ctx, args.data),
    });
  }
  if (access.update) {
    tools.push({
      name: `update_one_${object.nameSingular}`,
      description: `Update fields of a ${object.label} record.`,
      category: 'data',
      annotations: { ...WRITE, idempotentHint: true },
      inputSchema: z.object({ id: z.uuid(), data: inputSchemaFor(ctx) }),
      run: (args) => records.updateOne(ctx, args.id, args.data),
    });
  }
  if (access.delete) {
    tools.push({
      name: `delete_one_${object.nameSingular}`,
      description: `Soft-delete a ${object.label} record.`,
      category: 'data',
      annotations: DESTRUCTIVE,
      inputSchema: idSchema,
      run: (args) => records.deleteOne(ctx, args.id),
    });
  }
  return tools;
};

const schemaTools = (env: ToolEnvironment): ToolDefinition[] => {
  // A shared model serves many tenants, so only the platform operator changes it, never a tenant admin.
  if (!env.permissions.canManageSchema || env.metadata.tenancy !== 'isolated') return [];
  const admin = env.databases.admin;
  const dataModelId = env.metadata.dataModelId;
  return [
    {
      name: 'create_object',
      description: 'Create a customer-defined object. Names are lowercase snake_case; plural and singular must differ.',
      category: 'schema',
      annotations: WRITE,
      inputSchema: z.object({ nameSingular: z.string(), namePlural: z.string(), label: z.string() }),
      run: (args) => createObject(admin, dataModelId, args),
    },
    {
      name: 'create_field',
      description: 'Add a field to an object. select and multi_select need options; relation needs relationObjectId.',
      category: 'schema',
      annotations: WRITE,
      inputSchema: z.object({
        objectId: z.uuid(),
        name: z.string(),
        label: z.string(),
        type: z.enum(FIELD_TYPES),
        options: z.array(z.string()).optional(),
        relationObjectId: z.uuid().optional(),
      }),
      run: ({ objectId, ...input }) => createField(admin, dataModelId, objectId, input),
    },
  ];
};

export const buildTools = (env: ToolEnvironment): ToolDefinition[] => [
  ...env.metadata.objects.flatMap((object) => objectTools(env, object)),
  ...linkTools(env),
  ...schemaTools(env),
  ...builderTools(env),
  ...accessTools(env),
];
