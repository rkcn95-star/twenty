import { z } from 'zod';
import {
  addPredicate, createManagedRole, deleteRole, listAuditLog, listMembers, listRoles, removePredicate, setFieldAccess, setObjectAccess,
  setPrincipalRoles, updateRole,
} from './management.js';
import { DESTRUCTIVE, READ, WRITE, type ToolDefinition, type ToolEnvironment } from './registry.js';

const flags = {
  canManageSchema: z.boolean().optional(),
  canManageAccess: z.boolean().optional(),
  allObjectsAccess: z.boolean().optional(),
  canBypassAuth: z.boolean().optional(),
};
const operatorSchema = z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null']);

// API keys are deliberately not tools: their secret would end up in the model's context.
export const accessTools = (env: ToolEnvironment): ToolDefinition[] => {
  if (!env.permissions.canManageAccess) return [];
  const admin = env.databases.admin;
  const workspaceId = env.principal.workspaceId;
  const idempotentWrite = { ...WRITE, idempotentHint: true };

  return [
    { name: 'list_roles', description: 'List roles with their object permissions, field permissions and row predicates.', category: 'access', annotations: READ, inputSchema: z.object({}), run: () => listRoles(admin, workspaceId) },
    {
      name: 'create_role', description: 'Create a role. It grants nothing until you set object permissions or allObjectsAccess.', category: 'access', annotations: WRITE,
      inputSchema: z.object({ name: z.string(), ...flags }), run: (args) => createManagedRole(admin, workspaceId, args),
    },
    {
      name: 'update_role', description: 'Rename a role or change its flags. The workspace must keep at least one admin.', category: 'access', annotations: idempotentWrite,
      inputSchema: z.object({ roleId: z.uuid(), name: z.string().optional(), ...flags }),
      run: async ({ roleId, ...patch }) => updateRole(admin, workspaceId, roleId, patch),
    },
    {
      name: 'delete_role', description: 'Delete a role and remove it from everyone who holds it.', category: 'access', annotations: DESTRUCTIVE,
      inputSchema: z.object({ roleId: z.uuid() }), run: (args) => deleteRole(admin, workspaceId, args.roleId),
    },
    {
      name: 'set_object_access', description: 'Set read, create, update and delete rights of a role on an object. Omitted rights are revoked.', category: 'access', annotations: idempotentWrite,
      inputSchema: z.object({ roleId: z.uuid(), objectId: z.uuid(), read: z.boolean().optional(), create: z.boolean().optional(), update: z.boolean().optional(), delete: z.boolean().optional() }),
      run: ({ roleId, objectId, ...grants }) => setObjectAccess(admin, workspaceId, roleId, objectId, grants),
    },
    {
      name: 'set_field_access', description: 'Hide a field from a role or make it read-only. Writing requires reading.', category: 'access', annotations: idempotentWrite,
      inputSchema: z.object({ roleId: z.uuid(), fieldId: z.uuid(), read: z.boolean(), write: z.boolean() }),
      run: ({ roleId, fieldId, ...grants }) => setFieldAccess(admin, workspaceId, roleId, fieldId, grants),
    },
    {
      name: 'add_row_predicate', description: 'Restrict which rows a role sees on an object. Use "$principal" as the value to mean the caller. Several predicates on one role and object are ANDed.', category: 'access', annotations: WRITE,
      inputSchema: z.object({ roleId: z.uuid(), objectId: z.uuid(), fieldName: z.string(), operator: operatorSchema, value: z.unknown().optional() }),
      run: ({ roleId, ...input }) => addPredicate(admin, workspaceId, roleId, input),
    },
    {
      name: 'remove_row_predicate', description: 'Remove a row predicate from a role.', category: 'access', annotations: DESTRUCTIVE,
      inputSchema: z.object({ roleId: z.uuid(), predicateId: z.uuid() }), run: (args) => removePredicate(admin, workspaceId, args.roleId, args.predicateId),
    },
    { name: 'list_members', description: 'List users, API keys and agents with their roles. Secrets are never shown.', category: 'access', annotations: READ, inputSchema: z.object({}), run: () => listMembers(admin, workspaceId) },
    {
      name: 'set_member_roles', description: 'Replace the roles of a user, API key or agent. The workspace must keep at least one admin.', category: 'access', annotations: DESTRUCTIVE,
      inputSchema: z.object({ principalId: z.uuid(), roleIds: z.array(z.uuid()) }), run: (args) => setPrincipalRoles(admin, workspaceId, args.principalId, args.roleIds),
    },
    {
      name: 'list_audit_log', description: 'Read the audit log, newest first. Pass nextBefore from the previous page as before.', category: 'access', annotations: READ,
      inputSchema: z.object({ principalId: z.uuid().optional(), tool: z.string().optional(), outcome: z.enum(['ok', 'error']).optional(), before: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() }),
      run: (args) => listAuditLog(admin, workspaceId, args),
    },
  ];
};
