import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AppError, addPredicate, clearFieldAccess, createKey, createManagedRole, deleteRole, listAuditLog, listMembers, listRoles, removeMember,
  removePredicate, revokeKey, rotateKey, setFieldAccess, setObjectAccess, setPrincipalRoles, updateRole, type Databases, type Session,
} from '@agent-crm/core';

type RequestContext = { req: { header: (name: string) => string | undefined; raw: Request } };

const roleFlags = {
  canManageSchema: z.boolean().optional(),
  canManageAccess: z.boolean().optional(),
  allObjectsAccess: z.boolean().optional(),
  canBypassAuth: z.boolean().optional(),
};
const body = {
  createRole: z.object({ name: z.string(), ...roleFlags }),
  updateRole: z.object({ name: z.string().optional(), ...roleFlags }),
  objectAccess: z.object({ read: z.boolean().optional(), create: z.boolean().optional(), update: z.boolean().optional(), delete: z.boolean().optional() }),
  fieldAccess: z.object({ read: z.boolean(), write: z.boolean() }),
  predicate: z.object({
    objectId: z.uuid(), fieldName: z.string(), operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is_null']), value: z.unknown().optional(),
  }),
  memberRoles: z.object({ roleIds: z.array(z.uuid()) }),
  createKey: z.object({ name: z.string(), kind: z.enum(['api_key', 'agent']).default('api_key'), roleIds: z.array(z.uuid()), expiresAt: z.iso.datetime().optional() }),
  rotate: z.object({ expiresAt: z.iso.datetime().optional() }),
};

const parse = async <TSchema extends z.ZodType>(c: RequestContext, schema: TSchema): Promise<z.infer<TSchema>> => {
  const parsed = schema.safeParse(await c.req.raw.json().catch(() => ({})));
  if (!parsed.success) throw new AppError('validation', z.prettifyError(parsed.error));
  return parsed.data;
};

// Every route needs the manage-access right in the workspace named in the path, via API key or browser session.
export const mountManagementRoutes = (
  app: Hono<any>,
  databases: Databases,
  requireSession: (c: RequestContext) => Promise<Session>,
) => {
  const admin = databases.admin;
  const manager = async (c: RequestContext & { req: { param: (name: string) => string } }) => {
    const session = await requireSession(c);
    const workspaceId = c.req.param('id');
    if (session.principal.workspaceId !== workspaceId || !session.permissions.canManageAccess) {
      throw new AppError('forbidden', 'Access management rights are required');
    }
    return { session, workspaceId };
  };
  const base = '/v1/workspaces/:id';

  app.get(`${base}/roles`, async (c) => c.json({ roles: await listRoles(admin, (await manager(c)).workspaceId) }));
  app.post(`${base}/roles`, async (c) => {
    const { workspaceId } = await manager(c);
    return c.json(await createManagedRole(admin, workspaceId, await parse(c, body.createRole)), 201);
  });
  app.patch(`${base}/roles/:roleId`, async (c) => {
    const { workspaceId } = await manager(c);
    await updateRole(admin, workspaceId, c.req.param('roleId'), await parse(c, body.updateRole));
    return c.json({ ok: true });
  });
  app.delete(`${base}/roles/:roleId`, async (c) => {
    const { workspaceId } = await manager(c);
    await deleteRole(admin, workspaceId, c.req.param('roleId'));
    return c.json({ ok: true });
  });

  app.put(`${base}/roles/:roleId/objects/:objectId`, async (c) => {
    const { workspaceId } = await manager(c);
    await setObjectAccess(admin, workspaceId, c.req.param('roleId'), c.req.param('objectId'), await parse(c, body.objectAccess));
    return c.json({ ok: true });
  });
  app.put(`${base}/roles/:roleId/fields/:fieldId`, async (c) => {
    const { workspaceId } = await manager(c);
    await setFieldAccess(admin, workspaceId, c.req.param('roleId'), c.req.param('fieldId'), await parse(c, body.fieldAccess));
    return c.json({ ok: true });
  });
  app.delete(`${base}/roles/:roleId/fields/:fieldId`, async (c) => {
    const { workspaceId } = await manager(c);
    await clearFieldAccess(admin, workspaceId, c.req.param('roleId'), c.req.param('fieldId'));
    return c.json({ ok: true });
  });
  app.post(`${base}/roles/:roleId/predicates`, async (c) => {
    const { workspaceId } = await manager(c);
    return c.json(await addPredicate(admin, workspaceId, c.req.param('roleId'), await parse(c, body.predicate)), 201);
  });
  app.delete(`${base}/roles/:roleId/predicates/:predicateId`, async (c) => {
    const { workspaceId } = await manager(c);
    await removePredicate(admin, workspaceId, c.req.param('roleId'), c.req.param('predicateId'));
    return c.json({ ok: true });
  });

  app.get(`${base}/members`, async (c) => c.json({ members: await listMembers(admin, (await manager(c)).workspaceId) }));
  app.put(`${base}/members/:principalId/roles`, async (c) => {
    const { workspaceId } = await manager(c);
    await setPrincipalRoles(admin, workspaceId, c.req.param('principalId'), (await parse(c, body.memberRoles)).roleIds);
    return c.json({ ok: true });
  });
  app.delete(`${base}/members/:principalId`, async (c) => {
    const { workspaceId } = await manager(c);
    await removeMember(admin, workspaceId, c.req.param('principalId'));
    return c.json({ ok: true });
  });

  app.post(`${base}/api-keys`, async (c) => {
    const { workspaceId } = await manager(c);
    const input = await parse(c, body.createKey);
    return c.json(await createKey(admin, workspaceId, { ...input, expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined }), 201);
  });
  app.post(`${base}/api-keys/:principalId/rotate`, async (c) => {
    const { workspaceId } = await manager(c);
    const { expiresAt } = await parse(c, body.rotate);
    return c.json({ apiKey: await rotateKey(admin, workspaceId, c.req.param('principalId'), expiresAt ? new Date(expiresAt) : undefined) });
  });
  app.post(`${base}/api-keys/:principalId/revoke`, async (c) => {
    const { workspaceId } = await manager(c);
    await revokeKey(admin, workspaceId, c.req.param('principalId'));
    return c.json({ ok: true });
  });

  app.get(`${base}/audit-log`, async (c) => {
    const { workspaceId } = await manager(c);
    const query = z.object({
      principalId: z.uuid().optional(), tool: z.string().optional(), outcome: z.enum(['ok', 'error']).optional(),
      before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).optional(),
    }).safeParse(Object.fromEntries(new URL(c.req.raw.url).searchParams));
    if (!query.success) throw new AppError('validation', z.prettifyError(query.error));
    return c.json(await listAuditLog(admin, workspaceId, query.data));
  });
};
