import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  AppError, Session, acceptInvitation, authenticate, createInvitation, createWorkspaceForUser, getAuthSettings, listMemberships,
  resolveUserPrincipal, updateAuthSettings, createDataModel, createField, createObject, createPrincipal, createRole, provisionWorkspace,
  type CreateFieldInput, type CreateObjectInput, type Databases, type ErrorCode,
} from '@agent-crm/core';
import type { Auth, AuthMethod, Mail } from './auth.js';
import { mountManagementRoutes } from './management-routes.js';
import { buildMcpServer, type McpMode } from './mcp.js';

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409> = { validation: 400, forbidden: 403, not_found: 404, conflict: 409 };

type AppEnv = { Variables: { session: Session } };

export type AppOptions = {
  auth?: Auth;
  sendMail?: (mail: Mail) => Promise<void>;
  appUrl?: string;
};

export const createApp = (databases: Databases, adminToken: string, options: AppOptions = {}) => {
  const app = new Hono<AppEnv>();

  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ error: error.message }, STATUS[error.code]);
    console.error(error);
    return c.json({ error: 'Internal error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  const requireOperator = (c: { req: { header: (name: string) => string | undefined } }) => {
    if (c.req.header('x-admin-token') !== adminToken) throw new AppError('forbidden', 'Invalid admin token');
  };

  // Shared data models are changed by the platform operator only; tenants never get schema tools on them.
  app.post('/v1/data-models', async (c) => {
    requireOperator(c);
    const { name } = await c.req.json<{ name: string }>();
    return c.json(await createDataModel(databases.admin, name, 'shared'), 201);
  });

  app.post('/v1/data-models/:id/objects', async (c) => {
    requireOperator(c);
    return c.json(await createObject(databases.admin, c.req.param('id'), await c.req.json<CreateObjectInput>()), 201);
  });

  app.post('/v1/data-models/:id/objects/:objectId/fields', async (c) => {
    requireOperator(c);
    return c.json(await createField(databases.admin, c.req.param('id'), c.req.param('objectId'), await c.req.json<CreateFieldInput>()), 201);
  });

  app.post('/v1/bootstrap', async (c) => {
    requireOperator(c);
    const { workspaceName, dataModelId } = await c.req.json<{ workspaceName: string; dataModelId?: string }>();
    const workspace = await provisionWorkspace(databases.admin, workspaceName, { dataModelId });
    const roleId = await createRole(databases.admin, workspace.id, { name: 'admin', canManageSchema: true, canManageAccess: true, allObjectsAccess: true });
    const { apiKey } = await createPrincipal(databases.admin, workspace.id, { kind: 'api_key', name: 'bootstrap key', roleIds: [roleId] });
    return c.json({ workspaceId: workspace.id, dataModelId: workspace.dataModelId, tenancy: workspace.tenancy, apiKey }, 201);
  });

  const requireUser = async (c: { req: { raw: Request } }) => {
    if (!options.auth) throw new AppError('forbidden', 'User sign-in is not configured');
    const result = await options.auth.api.getSession({ headers: c.req.raw.headers });
    if (!result) throw new AppError('forbidden', 'Not signed in');
    const method: AuthMethod = (result.session as { authMethod?: string }).authMethod === 'google' ? 'google' : 'password';
    return { user: result.user, method };
  };

  type HeaderContext = { req: { header: (name: string) => string | undefined; raw: Request } };

  // API keys come first and are the machine path; a browser session needs an explicit workspace.
  const requireSession = async (c: HeaderContext) => {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    let principal;
    if (bearer?.startsWith('ak_')) {
      principal = await authenticate(databases.admin, bearer);
    } else {
      const { user, method } = await requireUser(c);
      const workspaceId = c.req.header('x-workspace-id');
      if (!workspaceId) throw new AppError('validation', 'Send x-workspace-id with a browser session');
      principal = await resolveUserPrincipal(databases.admin, { authUserId: user.id, workspaceId, method });
    }
    return Session.open(databases, principal, c.req.header('x-on-behalf-of'));
  };

  const requireWorkspaceAdmin = async (c: HeaderContext, workspaceId: string) => {
    const session = await requireSession(c);
    if (session.principal.workspaceId !== workspaceId || !session.permissions.canManageAccess) {
      throw new AppError('forbidden', 'Workspace admin access is required');
    }
    return session;
  };

  mountManagementRoutes(app, databases, requireSession);

  if (options.auth) {
    const auth = options.auth;
    app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

    app.get('/v1/me', async (c) => {
      const { user } = await requireUser(c);
      return c.json({ user: { id: user.id, email: user.email, name: user.name }, workspaces: await listMemberships(databases.admin, user.id) });
    });

    app.post('/v1/workspaces', async (c) => {
      const { user } = await requireUser(c);
      if (!user.emailVerified) throw new AppError('forbidden', 'Verify your email address first');
      const { name } = await c.req.json<{ name: string }>();
      const created = await createWorkspaceForUser(databases.admin, { name, authUserId: user.id, userName: user.name, email: user.email });
      return c.json({ workspaceId: created.workspaceId, tenancy: created.tenancy }, 201);
    });

    app.get('/v1/workspaces/:id/auth-settings', async (c) => {
      await requireWorkspaceAdmin(c, c.req.param('id'));
      return c.json(await getAuthSettings(databases.admin, c.req.param('id')));
    });

    app.patch('/v1/workspaces/:id/auth-settings', async (c) => {
      await requireWorkspaceAdmin(c, c.req.param('id'));
      return c.json(await updateAuthSettings(databases.admin, c.req.param('id'), await c.req.json()));
    });

    app.post('/v1/workspaces/:id/invitations', async (c) => {
      const session = await requireWorkspaceAdmin(c, c.req.param('id'));
      const { email, roleIds } = await c.req.json<{ email: string; roleIds: string[] }>();
      const invitation = await createInvitation(databases.admin, session.principal.workspaceId, { email, roleIds, invitedBy: session.principal.id });
      const link = `${options.appUrl ?? ''}/accept-invitation?token=${invitation.token}`;
      await options.sendMail?.({ to: email, subject: 'You have been invited', text: `Accept your invitation: ${link}` });
      return c.json({ id: invitation.id }, 201);
    });

    app.post('/v1/invitations/accept', async (c) => {
      const { user } = await requireUser(c);
      const { token } = await c.req.json<{ token: string }>();
      const principal = await acceptInvitation(databases.admin, { token, authUserId: user.id });
      return c.json({ workspaceId: principal.workspaceId }, 201);
    });
  }

  app.post('/v1/tools/:name', async (c) => {
    const session = await requireSession(c);
    const body = await c.req.json().catch(() => ({}));
    return c.json({ result: await session.execute(c.req.param('name'), body) });
  });

  app.get('/v1/tools', async (c) => c.json({ tools: (await requireSession(c)).listTools() }));

  app.all('/mcp', async (c) => {
    const session = await requireSession(c);
    const mode: McpMode = c.req.query('mode') === 'direct' ? 'direct' : 'lazy';
    const server = buildMcpServer(session, mode);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
};
