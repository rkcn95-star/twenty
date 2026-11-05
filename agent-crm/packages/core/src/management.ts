import type pg from 'pg';
import { createPrincipal } from './access.js';
import { keepingAnAdmin } from './admin-guard.js';
import { inTransaction } from './db.js';
import { AppError } from './errors.js';
import { loadMetadata } from './metadata.js';
import { hasColumn } from './types.js';

const SYSTEM_COLUMNS = new Set(['id', 'created_by', 'created_at', 'updated_at']);
const PREDICATE_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null']);
const MAX_IN_VALUES = 200;
const MAX_AUDIT_PAGE = 200;

export type RoleFlags = { canManageSchema: boolean; canManageAccess: boolean; allObjectsAccess: boolean; canBypassAuth: boolean };

const uniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505';

const requireRole = async (client: pg.Pool | pg.PoolClient, workspaceId: string, roleId: string) => {
  const row = (await client.query('SELECT id FROM core.roles WHERE id = $1 AND workspace_id = $2', [roleId, workspaceId])).rows[0];
  if (!row) throw new AppError('not_found', 'Role not found');
};

const requirePrincipal = async (client: pg.Pool | pg.PoolClient, workspaceId: string, principalId: string) => {
  const row = (await client.query('SELECT kind FROM core.principals WHERE id = $1 AND workspace_id = $2', [principalId, workspaceId])).rows[0];
  if (!row) throw new AppError('not_found', 'Member not found');
  return row.kind as 'user' | 'api_key' | 'agent';
};

// Objects and fields belong to the workspace's data model, which a shared model hands to many workspaces.
const requireObject = async (client: pg.Pool | pg.PoolClient, workspaceId: string, objectId: string) => {
  const row = (
    await client.query(
      `SELECT o.id FROM core.object_definitions o JOIN core.workspaces w ON w.data_model_id = o.data_model_id
       WHERE o.id = $1 AND w.id = $2`,
      [objectId, workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError('not_found', 'Object not found');
};

const requireField = async (client: pg.Pool | pg.PoolClient, workspaceId: string, fieldId: string) => {
  const row = (
    await client.query(
      `SELECT f.id FROM core.field_definitions f JOIN core.workspaces w ON w.data_model_id = f.data_model_id
       WHERE f.id = $1 AND w.id = $2`,
      [fieldId, workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError('not_found', 'Field not found');
};

const requireRoles = async (client: pg.Pool | pg.PoolClient, workspaceId: string, roleIds: string[]) => {
  const found = await client.query('SELECT id FROM core.roles WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, roleIds]);
  if (found.rowCount !== new Set(roleIds).size) throw new AppError('validation', 'Some roles do not exist in this workspace');
};

export const listRoles = async (admin: pg.Pool, workspaceId: string) => {
  const [roles, objects, fields, predicates] = await Promise.all([
    admin.query('SELECT * FROM core.roles WHERE workspace_id = $1 ORDER BY name', [workspaceId]),
    admin.query('SELECT op.* FROM core.object_permissions op JOIN core.roles r ON r.id = op.role_id WHERE r.workspace_id = $1', [workspaceId]),
    admin.query('SELECT fp.* FROM core.field_permissions fp JOIN core.roles r ON r.id = fp.role_id WHERE r.workspace_id = $1', [workspaceId]),
    admin.query('SELECT rp.* FROM core.row_predicates rp JOIN core.roles r ON r.id = rp.role_id WHERE r.workspace_id = $1', [workspaceId]),
  ]);
  return roles.rows.map((role) => ({
    id: role.id as string,
    name: role.name as string,
    canManageSchema: role.can_manage_schema as boolean,
    canManageAccess: role.can_manage_access as boolean,
    allObjectsAccess: role.all_objects_access as boolean,
    canBypassAuth: role.can_bypass_auth as boolean,
    objects: objects.rows.filter((row) => row.role_id === role.id).map((row) => ({
      objectId: row.object_id, read: row.can_read, create: row.can_create, update: row.can_update, delete: row.can_delete,
    })),
    fields: fields.rows.filter((row) => row.role_id === role.id).map((row) => ({ fieldId: row.field_id, read: row.can_read, write: row.can_write })),
    predicates: predicates.rows.filter((row) => row.role_id === role.id).map((row) => ({
      id: row.id, objectId: row.object_id, fieldName: row.field_name, operator: row.operator, value: row.value,
    })),
  }));
};

export const createManagedRole = async (admin: pg.Pool, workspaceId: string, input: { name: string } & Partial<RoleFlags>): Promise<{ id: string }> => {
  if (!input.name.trim()) throw new AppError('validation', 'Role name is required');
  try {
    const result = await admin.query(
      `INSERT INTO core.roles (workspace_id, name, can_manage_schema, can_manage_access, all_objects_access, can_bypass_auth)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [workspaceId, input.name.trim(), input.canManageSchema ?? false, input.canManageAccess ?? false, input.allObjectsAccess ?? false, input.canBypassAuth ?? false],
    );
    return { id: result.rows[0].id };
  } catch (error) {
    if (uniqueViolation(error)) throw new AppError('conflict', `A role named "${input.name}" already exists`);
    throw error;
  }
};

export const updateRole = (admin: pg.Pool, workspaceId: string, roleId: string, patch: { name?: string } & Partial<RoleFlags>) =>
  inTransaction(admin, async (client) => {
    await requireRole(client, workspaceId, roleId);
    await keepingAnAdmin(client, workspaceId, async () => {
      try {
        await client.query(
          `UPDATE core.roles SET name = COALESCE($3, name), can_manage_schema = COALESCE($4, can_manage_schema),
             can_manage_access = COALESCE($5, can_manage_access), all_objects_access = COALESCE($6, all_objects_access),
             can_bypass_auth = COALESCE($7, can_bypass_auth) WHERE id = $1 AND workspace_id = $2`,
          [roleId, workspaceId, patch.name?.trim() ?? null, patch.canManageSchema ?? null, patch.canManageAccess ?? null, patch.allObjectsAccess ?? null, patch.canBypassAuth ?? null],
        );
      } catch (error) {
        if (uniqueViolation(error)) throw new AppError('conflict', `A role named "${patch.name}" already exists`);
        throw error;
      }
    });
  });

export const deleteRole = (admin: pg.Pool, workspaceId: string, roleId: string) =>
  inTransaction(admin, async (client) => {
    await requireRole(client, workspaceId, roleId);
    await keepingAnAdmin(client, workspaceId, () => client.query('DELETE FROM core.roles WHERE id = $1', [roleId]));
  });

export const setObjectAccess = async (
  admin: pg.Pool,
  workspaceId: string,
  roleId: string,
  objectId: string,
  grants: { read?: boolean; create?: boolean; update?: boolean; delete?: boolean },
) => {
  await requireRole(admin, workspaceId, roleId);
  await requireObject(admin, workspaceId, objectId);
  await admin.query(
    `INSERT INTO core.object_permissions (role_id, object_id, can_read, can_create, can_update, can_delete) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (role_id, object_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_create = EXCLUDED.can_create,
       can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete`,
    [roleId, objectId, grants.read ?? false, grants.create ?? false, grants.update ?? false, grants.delete ?? false],
  );
};

export const setFieldAccess = async (admin: pg.Pool, workspaceId: string, roleId: string, fieldId: string, grants: { read: boolean; write: boolean }) => {
  await requireRole(admin, workspaceId, roleId);
  await requireField(admin, workspaceId, fieldId);
  await admin.query(
    `INSERT INTO core.field_permissions (role_id, field_id, can_read, can_write) VALUES ($1, $2, $3, $4)
     ON CONFLICT (role_id, field_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write`,
    [roleId, fieldId, grants.read, grants.read && grants.write],
  );
};

export const clearFieldAccess = async (admin: pg.Pool, workspaceId: string, roleId: string, fieldId: string) => {
  await requireRole(admin, workspaceId, roleId);
  await admin.query('DELETE FROM core.field_permissions WHERE role_id = $1 AND field_id = $2', [roleId, fieldId]);
};

export const addPredicate = async (
  admin: pg.Pool,
  workspaceId: string,
  roleId: string,
  input: { objectId: string; fieldName: string; operator: string; value?: unknown },
): Promise<{ id: string }> => {
  await requireRole(admin, workspaceId, roleId);
  await requireObject(admin, workspaceId, input.objectId);
  const metadata = await loadMetadata(admin, workspaceId);
  const object = metadata.objects.find((candidate) => candidate.id === input.objectId);
  const knownField = SYSTEM_COLUMNS.has(input.fieldName) || object?.fields.some((field) => field.name === input.fieldName && field.active && hasColumn(field));
  if (!knownField) throw new AppError('validation', `Unknown field "${input.fieldName}"`);
  if (!PREDICATE_OPERATORS.has(input.operator)) throw new AppError('validation', `Unknown operator "${input.operator}"`);

  const { operator, value } = input;
  if (operator === 'in') {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_VALUES) throw new AppError('validation', `"in" needs 1 to ${MAX_IN_VALUES} values`);
  } else if (operator === 'is_null') {
    if (value !== undefined && typeof value !== 'boolean') throw new AppError('validation', '"is_null" takes true or false');
  } else if (value === undefined || value === null || typeof value === 'object') {
    throw new AppError('validation', `Operator "${operator}" needs a single value`);
  }

  const result = await admin.query(
    'INSERT INTO core.row_predicates (role_id, object_id, field_name, operator, value) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [roleId, input.objectId, input.fieldName, operator, JSON.stringify(value ?? null)],
  );
  return { id: result.rows[0].id };
};

export const removePredicate = async (admin: pg.Pool, workspaceId: string, roleId: string, predicateId: string) => {
  await requireRole(admin, workspaceId, roleId);
  const result = await admin.query('DELETE FROM core.row_predicates WHERE id = $1 AND role_id = $2', [predicateId, roleId]);
  if (result.rowCount === 0) throw new AppError('not_found', 'Predicate not found');
};

export const listMembers = async (admin: pg.Pool, workspaceId: string) =>
  (
    await admin.query(
      `SELECT p.id, p.kind, p.name, p.email, p.expires_at, p.revoked_at, p.last_used_at, p.created_at,
              COALESCE(array_agg(ra.role_id) FILTER (WHERE ra.role_id IS NOT NULL), '{}') AS role_ids
       FROM core.principals p LEFT JOIN core.role_assignments ra ON ra.principal_id = p.id
       WHERE p.workspace_id = $1 GROUP BY p.id ORDER BY p.created_at`,
      [workspaceId],
    )
  ).rows.map((row) => ({
    id: row.id as string, kind: row.kind as string, name: row.name as string, email: row.email as string | null,
    roleIds: row.role_ids as string[], expiresAt: row.expires_at as Date | null, revokedAt: row.revoked_at as Date | null,
    lastUsedAt: row.last_used_at as Date | null, createdAt: row.created_at as Date,
  }));

export const setPrincipalRoles = (admin: pg.Pool, workspaceId: string, principalId: string, roleIds: string[]) =>
  inTransaction(admin, async (client) => {
    await requirePrincipal(client, workspaceId, principalId);
    await requireRoles(client, workspaceId, roleIds);
    await keepingAnAdmin(client, workspaceId, async () => {
      await client.query('DELETE FROM core.role_assignments WHERE principal_id = $1', [principalId]);
      for (const roleId of new Set(roleIds)) {
        await client.query('INSERT INTO core.role_assignments (principal_id, role_id) VALUES ($1, $2)', [principalId, roleId]);
      }
    });
  });

export const removeMember = (admin: pg.Pool, workspaceId: string, principalId: string) =>
  inTransaction(admin, async (client) => {
    await requirePrincipal(client, workspaceId, principalId);
    await keepingAnAdmin(client, workspaceId, () => client.query('DELETE FROM core.principals WHERE id = $1', [principalId]));
  });

// The secret is returned once and only its hash is kept.
export const createKey = async (
  admin: pg.Pool,
  workspaceId: string,
  input: { kind: 'api_key' | 'agent'; name: string; roleIds: string[]; expiresAt?: Date },
): Promise<{ principalId: string; apiKey: string }> => {
  if (input.roleIds.length === 0) throw new AppError('validation', 'A key needs at least one role');
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new AppError('validation', 'Expiry must be in the future');
  await requireRoles(admin, workspaceId, input.roleIds);
  const created = await createPrincipal(admin, workspaceId, input);
  return { principalId: created.principal.id, apiKey: created.apiKey as string };
};

export const listAuditLog = async (
  admin: pg.Pool,
  workspaceId: string,
  filter: { principalId?: string; tool?: string; outcome?: 'ok' | 'error'; before?: number; limit?: number } = {},
) => {
  const limit = Math.min(filter.limit ?? 50, MAX_AUDIT_PAGE);
  const rows = (
    await admin.query(
      `SELECT id, principal_id, tool, args, outcome, detail, row_count, created_at FROM core.audit_log
       WHERE workspace_id = $1 AND ($2::uuid IS NULL OR principal_id = $2) AND ($3::text IS NULL OR tool = $3)
         AND ($4::text IS NULL OR outcome = $4) AND ($5::bigint IS NULL OR id < $5)
       ORDER BY id DESC LIMIT ${limit}`,
      [workspaceId, filter.principalId ?? null, filter.tool ?? null, filter.outcome ?? null, filter.before ?? null],
    )
  ).rows;
  return {
    entries: rows.map((row) => ({
      id: Number(row.id), principalId: row.principal_id as string, tool: row.tool as string, args: row.args, outcome: row.outcome as string,
      detail: row.detail as string | null, rowCount: row.row_count as number | null, createdAt: row.created_at as Date,
    })),
    nextBefore: rows.length === limit ? Number(rows[rows.length - 1].id) : null,
  };
};
