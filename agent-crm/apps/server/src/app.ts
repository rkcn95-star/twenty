import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  AppError, Session, authenticate, createDataModel, createField, createObject, createPrincipal, createRole, provisionWorkspace,
  type CreateFieldInput, type CreateObjectInput, type Databases, type ErrorCode,
} from '@agent-crm/core';
import { buildMcpServer, type McpMode } from './mcp.js';

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409> = { validation: 400, forbidden: 403, not_found: 404, conflict: 409 };

type AppEnv = { Variables: { session: Session } };

export const createApp = (databases: Databases, adminToken: string) => {
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
    const roleId = await createRole(databases.admin, workspace.id, { name: 'admin', canManageSchema: true, allObjectsAccess: true });
    const { apiKey } = await createPrincipal(databases.admin, workspace.id, { kind: 'api_key', name: 'bootstrap key', roleIds: [roleId] });
    return c.json({ workspaceId: workspace.id, dataModelId: workspace.dataModelId, tenancy: workspace.tenancy, apiKey }, 201);
  });

  const requireSession = async (c: { req: { header: (name: string) => string | undefined } }) => {
    const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (!key) throw new AppError('forbidden', 'Missing bearer token');
    const principal = await authenticate(databases.admin, key);
    return Session.open(databases, principal, c.req.header('x-on-behalf-of'));
  };

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
