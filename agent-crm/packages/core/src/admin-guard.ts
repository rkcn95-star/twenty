import type pg from 'pg';
import { AppError } from './errors.js';

const countAdmins = async (client: pg.PoolClient, workspaceId: string): Promise<number> =>
  (
    await client.query(
      `SELECT count(DISTINCT p.id)::int AS admins FROM core.principals p
       JOIN core.role_assignments ra ON ra.principal_id = p.id JOIN core.roles r ON r.id = ra.role_id
       WHERE p.workspace_id = $1 AND r.can_manage_access AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > now())`,
      [workspaceId],
    )
  ).rows[0].admins;

// Runs a change inside the caller's transaction and fails it if it took the workspace from having an admin to having none.
export const keepingAnAdmin = async <TResult>(client: pg.PoolClient, workspaceId: string, change: () => Promise<TResult>): Promise<TResult> => {
  const before = await countAdmins(client, workspaceId);
  const result = await change();
  if (before > 0 && (await countAdmins(client, workspaceId)) === 0) throw new AppError('conflict', 'The workspace must keep at least one admin');
  return result;
};
