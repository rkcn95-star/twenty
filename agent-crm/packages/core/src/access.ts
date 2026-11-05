import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { AppError } from './errors.js';
import type { Principal } from './types.js';

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export const createRole = async (
  admin: pg.Pool,
  workspaceId: string,
  input: { name: string; canManageSchema?: boolean; allObjectsAccess?: boolean },
): Promise<string> => {
  const result = await admin.query(
    'INSERT INTO core.roles (workspace_id, name, can_manage_schema, all_objects_access) VALUES ($1, $2, $3, $4) RETURNING id',
    [workspaceId, input.name, input.canManageSchema ?? false, input.allObjectsAccess ?? false],
  );
  return result.rows[0].id;
};

export const createPrincipal = async (
  admin: pg.Pool,
  workspaceId: string,
  input: { kind: Principal['kind']; name: string; email?: string; roleIds: string[]; expiresAt?: Date },
): Promise<{ principal: Principal; apiKey?: string }> => {
  const apiKey = input.kind === 'user' ? undefined : `ak_${randomBytes(24).toString('base64url')}`;
  const result = await admin.query(
    'INSERT INTO core.principals (workspace_id, kind, name, email, key_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [workspaceId, input.kind, input.name, input.email ?? null, apiKey ? hashKey(apiKey) : null, input.expiresAt ?? null],
  );
  const id = result.rows[0].id as string;
  for (const roleId of input.roleIds) {
    await admin.query('INSERT INTO core.role_assignments (principal_id, role_id) VALUES ($1, $2)', [id, roleId]);
  }
  return { principal: { id, workspaceId, kind: input.kind, name: input.name }, apiKey };
};

export const authenticate = async (admin: pg.Pool, apiKey: string): Promise<Principal> => {
  const result = await admin.query(
    `SELECT id, workspace_id, kind, name FROM core.principals
     WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    [hashKey(apiKey)],
  );
  const row = result.rows[0];
  if (!row) throw new AppError('forbidden', 'Invalid API key');
  // Throttled so authentication is not a write on every request.
  void admin
    .query("UPDATE core.principals SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.id])
    .catch(() => undefined);
  return { id: row.id, workspaceId: row.workspace_id, kind: row.kind, name: row.name };
};

export const loadPrincipal = async (admin: pg.Pool, principalId: string): Promise<Principal> => {
  const row = (await admin.query('SELECT id, workspace_id, kind, name FROM core.principals WHERE id = $1', [principalId])).rows[0];
  if (!row) throw new AppError('not_found', 'Principal not found');
  return { id: row.id, workspaceId: row.workspace_id, kind: row.kind, name: row.name };
};

export const setObjectPermission = (
  admin: pg.Pool,
  roleId: string,
  objectId: string,
  grants: { read?: boolean; create?: boolean; update?: boolean; delete?: boolean },
) =>
  admin.query(
    `INSERT INTO core.object_permissions (role_id, object_id, can_read, can_create, can_update, can_delete)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (role_id, object_id) DO UPDATE SET
       can_read = EXCLUDED.can_read, can_create = EXCLUDED.can_create,
       can_update = EXCLUDED.can_update, can_delete = EXCLUDED.can_delete`,
    [roleId, objectId, grants.read ?? false, grants.create ?? false, grants.update ?? false, grants.delete ?? false],
  );

export const setFieldPermission = (admin: pg.Pool, roleId: string, fieldId: string, grants: { read: boolean; write: boolean }) =>
  admin.query(
    `INSERT INTO core.field_permissions (role_id, field_id, can_read, can_write) VALUES ($1, $2, $3, $4)
     ON CONFLICT (role_id, field_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write`,
    [roleId, fieldId, grants.read, grants.write],
  );

export const addRowPredicate = (
  admin: pg.Pool,
  roleId: string,
  objectId: string,
  predicate: { fieldName: string; operator: string; value?: unknown },
) =>
  admin.query('INSERT INTO core.row_predicates (role_id, object_id, field_name, operator, value) VALUES ($1, $2, $3, $4, $5)', [
    roleId,
    objectId,
    predicate.fieldName,
    predicate.operator,
    JSON.stringify(predicate.value ?? null),
  ]);

export const revokeKey = async (admin: pg.Pool, workspaceId: string, principalId: string) => {
  const result = await admin.query('UPDATE core.principals SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND key_hash IS NOT NULL', [
    principalId,
    workspaceId,
  ]);
  if (result.rowCount === 0) throw new AppError('not_found', 'Key not found');
};

// Replaces the key and clears any revocation; the old key stops working immediately.
export const rotateKey = async (admin: pg.Pool, workspaceId: string, principalId: string, expiresAt?: Date): Promise<string> => {
  const apiKey = `ak_${randomBytes(24).toString('base64url')}`;
  const result = await admin.query(
    'UPDATE core.principals SET key_hash = $3, revoked_at = NULL, expires_at = $4 WHERE id = $1 AND workspace_id = $2 AND key_hash IS NOT NULL',
    [principalId, workspaceId, hashKey(apiKey), expiresAt ?? null],
  );
  if (result.rowCount === 0) throw new AppError('not_found', 'Key not found');
  return apiKey;
};
