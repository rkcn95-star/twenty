import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPrincipal, createRole } from './access.js';
import { inTransaction } from './db.js';
import { AppError } from './errors.js';
import { provisionWorkspace } from './schema-runner.js';
import type { Principal, Tenancy } from './types.js';

export type AuthMethod = 'password' | 'google';

export type WorkspaceAuthSettings = {
  passwordAuthEnabled: boolean;
  googleAuthEnabled: boolean;
  passwordAuthBypassEnabled: boolean;
  googleAuthBypassEnabled: boolean;
};

const INVITATION_TTL_DAYS = 7;
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const getAuthSettings = async (admin: pg.Pool, workspaceId: string): Promise<WorkspaceAuthSettings> => {
  const row = (
    await admin.query(
      `SELECT password_auth_enabled, google_auth_enabled, password_auth_bypass_enabled, google_auth_bypass_enabled
       FROM core.workspaces WHERE id = $1`,
      [workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError('not_found', 'Workspace not found');
  return {
    passwordAuthEnabled: row.password_auth_enabled,
    googleAuthEnabled: row.google_auth_enabled,
    passwordAuthBypassEnabled: row.password_auth_bypass_enabled,
    googleAuthBypassEnabled: row.google_auth_bypass_enabled,
  };
};

export const updateAuthSettings = async (admin: pg.Pool, workspaceId: string, patch: Partial<WorkspaceAuthSettings>) => {
  const next = { ...(await getAuthSettings(admin, workspaceId)), ...patch };
  if (!next.passwordAuthEnabled && !next.googleAuthEnabled) {
    throw new AppError('validation', 'At least one sign-in method must stay enabled');
  }
  await admin.query(
    `UPDATE core.workspaces SET password_auth_enabled = $2, google_auth_enabled = $3,
       password_auth_bypass_enabled = $4, google_auth_bypass_enabled = $5 WHERE id = $1`,
    [workspaceId, next.passwordAuthEnabled, next.googleAuthEnabled, next.passwordAuthBypassEnabled, next.googleAuthBypassEnabled],
  );
  return next;
};

export const createUserPrincipal = async (
  admin: pg.Pool,
  workspaceId: string,
  input: { authUserId: string; name: string; email: string; roleIds: string[] },
): Promise<Principal> => {
  const created = await createPrincipal(admin, workspaceId, { kind: 'user', name: input.name, email: input.email, roleIds: [] });
  try {
    await admin.query('UPDATE core.principals SET auth_user_id = $2 WHERE id = $1', [created.principal.id, input.authUserId]);
    for (const roleId of input.roleIds) {
      await admin.query('INSERT INTO core.role_assignments (principal_id, role_id) VALUES ($1, $2)', [created.principal.id, roleId]);
    }
  } catch (error) {
    await admin.query('DELETE FROM core.principals WHERE id = $1', [created.principal.id]);
    if ((error as { code?: string }).code === '23505') throw new AppError('conflict', 'Already a member of this workspace');
    throw error;
  }
  return created.principal;
};

export const createWorkspaceForUser = async (
  admin: pg.Pool,
  input: { name: string; authUserId: string; userName: string; email: string },
): Promise<{ workspaceId: string; principal: Principal; tenancy: Tenancy }> => {
  const workspace = await provisionWorkspace(admin, input.name);
  const roleId = await createRole(admin, workspace.id, { name: 'admin', canManageSchema: true, allObjectsAccess: true, canBypassAuth: true });
  const principal = await createUserPrincipal(admin, workspace.id, {
    authUserId: input.authUserId, name: input.userName, email: input.email, roleIds: [roleId],
  });
  return { workspaceId: workspace.id, principal, tenancy: workspace.tenancy };
};

export const listMemberships = async (admin: pg.Pool, authUserId: string) =>
  (
    await admin.query(
      `SELECT p.id AS principal_id, w.id AS workspace_id, w.name, m.tenancy
       FROM core.principals p JOIN core.workspaces w ON w.id = p.workspace_id JOIN core.data_models m ON m.id = w.data_model_id
       WHERE p.auth_user_id = $1 ORDER BY w.name`,
      [authUserId],
    )
  ).rows.map((row) => ({ principalId: row.principal_id as string, workspaceId: row.workspace_id as string, name: row.name as string, tenancy: row.tenancy as Tenancy }));

// Mirrors Twenty: the workspace decides which methods are accepted, and an admin role can bypass a disabled one.
export const resolveUserPrincipal = async (
  admin: pg.Pool,
  input: { authUserId: string; workspaceId: string; method: AuthMethod },
): Promise<Principal> => {
  const row = (
    await admin.query(
      `SELECT p.id, p.workspace_id, p.name, u."emailVerified" AS verified,
              EXISTS (SELECT 1 FROM core.role_assignments ra JOIN core.roles r ON r.id = ra.role_id
                      WHERE ra.principal_id = p.id AND r.can_bypass_auth) AS can_bypass
       FROM core.principals p JOIN core."user" u ON u.id = p.auth_user_id
       WHERE p.auth_user_id = $1 AND p.workspace_id = $2`,
      [input.authUserId, input.workspaceId],
    )
  ).rows[0];
  if (!row) throw new AppError('forbidden', 'You are not a member of this workspace');
  if (!row.verified) throw new AppError('forbidden', 'Verify your email address first');

  const settings = await getAuthSettings(admin, input.workspaceId);
  const enabled = input.method === 'google' ? settings.googleAuthEnabled : settings.passwordAuthEnabled;
  const bypass = input.method === 'google' ? settings.googleAuthBypassEnabled : settings.passwordAuthBypassEnabled;
  if (!enabled && !(bypass && row.can_bypass)) {
    throw new AppError('forbidden', `${input.method === 'google' ? 'Google' : 'Email and password'} sign-in is not enabled for this workspace`);
  }
  return { id: row.id, workspaceId: row.workspace_id, kind: 'user', name: row.name };
};

export const createInvitation = async (
  admin: pg.Pool,
  workspaceId: string,
  input: { email: string; roleIds: string[]; invitedBy: string },
): Promise<{ id: string; token: string }> => {
  const roles = await admin.query('SELECT id FROM core.roles WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, input.roleIds]);
  if (input.roleIds.length === 0 || roles.rowCount !== input.roleIds.length) throw new AppError('validation', 'Invitation needs roles from this workspace');
  const token = randomBytes(32).toString('base64url');
  const result = await admin.query(
    `INSERT INTO core.invitations (workspace_id, email, role_ids, token_hash, invited_by, expires_at)
     VALUES ($1, lower($2), $3, $4, $5, now() + make_interval(days => $6)) RETURNING id`,
    [workspaceId, input.email, input.roleIds, hashToken(token), input.invitedBy, INVITATION_TTL_DAYS],
  );
  return { id: result.rows[0].id, token };
};

export const acceptInvitation = (admin: pg.Pool, input: { token: string; authUserId: string }): Promise<Principal> =>
  inTransaction(admin, async (client) => {
    const invitation = (
      await client.query(
        'SELECT * FROM core.invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE',
        [hashToken(input.token)],
      )
    ).rows[0];
    if (!invitation) throw new AppError('not_found', 'Invitation is invalid or expired');
    const user = (await client.query('SELECT name, email, "emailVerified" AS verified FROM core."user" WHERE id = $1', [input.authUserId])).rows[0];
    if (!user?.verified || user.email.toLowerCase() !== invitation.email) {
      throw new AppError('forbidden', 'Sign in with the verified email address that was invited');
    }
    await client.query('UPDATE core.invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);
    return { invitation, user };
  }).then(async ({ invitation, user }) => {
    try {
      return await createUserPrincipal(admin, invitation.workspace_id, {
        authUserId: input.authUserId, name: user.name, email: user.email, roleIds: invitation.role_ids,
      });
    } catch (error) {
      await admin.query('UPDATE core.invitations SET accepted_at = NULL WHERE id = $1', [invitation.id]);
      throw error;
    }
  });
