import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, migrate, type Databases } from '@agent-crm/core';
import { createApp } from '../src/app.js';

const ADMIN_TOKEN = 'test-admin-token';
const run = Date.now();

let databases: Databases;
let app: ReturnType<typeof createApp>;
let adminKey: string;
let workspaceId: string;
let otherWorkspaceId: string;
let dealsObjectId: string;
let titleFieldId: string;

const call = (path: string, init: { method?: string; key?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(init.key ? { authorization: `Bearer ${init.key}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

const json = async <TBody = any>(response: Response) => (await response.json()) as TBody;
const tool = async (key: string, name: string, args: object) => json((await call(`/v1/tools/${name}`, { key, body: args })));

beforeAll(async () => {
  databases = connect({
    adminUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/agentcrm',
    runtimeUrl: process.env.RUNTIME_DATABASE_URL ?? 'postgres://app_runtime:app_runtime@localhost:5432/agentcrm',
  });
  await migrate(databases.admin);
  app = createApp(databases, ADMIN_TOKEN);
  const boot = async (name: string) =>
    json<{ workspaceId: string; apiKey: string }>(
      await app.request('/v1/bootstrap', { method: 'POST', headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceName: `${name}-${run}` }) }),
    );
  const first = await boot('mgmt');
  workspaceId = first.workspaceId;
  adminKey = first.apiKey;
  otherWorkspaceId = (await boot('mgmt-other')).workspaceId;

  const object = (await tool(adminKey, 'create_object', { nameSingular: 'deal', namePlural: 'deals', label: 'Deal' })).result;
  dealsObjectId = object.id;
  titleFieldId = (await tool(adminKey, 'create_field', { objectId: object.id, name: 'title', label: 'Title', type: 'text' })).result.id;
});

afterAll(async () => {
  await databases.close();
});

const path = (suffix: string, id = workspaceId) => `/v1/workspaces/${id}${suffix}`;

describe('access control of the management API', () => {
  it('needs a valid key, the manage-access right and the matching workspace', async () => {
    expect((await call(path('/roles'))).status).toBe(403);
    expect((await call(path('/roles'), { key: 'ak_wrong' })).status).toBe(403);
    expect((await call(path('/roles', otherWorkspaceId), { key: adminKey })).status).toBe(403);

    const viewer = await json((await call(path('/roles'), { key: adminKey, body: { name: 'viewer', allObjectsAccess: true } })));
    const key = await json<{ apiKey: string }>(await call(path('/api-keys'), { key: adminKey, body: { name: 'viewer key', roleIds: [viewer.id] } }));
    expect((await call(path('/roles'), { key: key.apiKey })).status).toBe(403);
    expect((await call(path('/api-keys'), { key: key.apiKey, body: { name: 'x', roleIds: [viewer.id] } })).status).toBe(403);
  });

  it('validates request bodies', async () => {
    expect((await call(path('/roles'), { key: adminKey, body: { name: 5 } })).status).toBe(400);
    expect((await call(path('/api-keys'), { key: adminKey, body: { name: 'k', roleIds: ['not-a-uuid'] } })).status).toBe(400);
    expect((await call(path('/audit-log?limit=9999'), { key: adminKey })).status).toBe(400);
  });
});

describe('managing roles over HTTP', () => {
  it('runs the full permission flow and the new role takes effect', async () => {
    const role = await json<{ id: string }>(await call(path('/roles'), { key: adminKey, body: { name: 'sales' } }));
    expect((await call(path('/roles'), { key: adminKey, body: { name: 'sales' } })).status).toBe(409);

    expect((await call(path(`/roles/${role.id}/objects/${dealsObjectId}`), { method: 'PUT', key: adminKey, body: { read: true, create: true } })).status).toBe(200);
    expect((await call(path(`/roles/${role.id}/fields/${titleFieldId}`), { method: 'PUT', key: adminKey, body: { read: true, write: false } })).status).toBe(200);
    const predicate = await call(path(`/roles/${role.id}/predicates`), { key: adminKey, body: { objectId: dealsObjectId, fieldName: 'title', operator: 'neq', value: 'hidden' } });
    expect(predicate.status).toBe(201);
    expect((await call(path(`/roles/${role.id}/predicates`), { key: adminKey, body: { objectId: dealsObjectId, fieldName: 'nope', operator: 'eq', value: 1 } })).status).toBe(400);

    const listed = await json<{ roles: { id: string; objects: unknown[]; fields: unknown[]; predicates: unknown[] }[] }>(await call(path('/roles'), { key: adminKey }));
    const stored = listed.roles.find((candidate) => candidate.id === role.id)!;
    expect([stored.objects.length, stored.fields.length, stored.predicates.length]).toEqual([1, 1, 1]);

    const key = await json<{ apiKey: string }>(await call(path('/api-keys'), { key: adminKey, body: { name: 'sales key', roleIds: [role.id] } }));
    const tools = await json<{ tools: { name: string }[] }>(await call('/v1/tools', { key: key.apiKey }));
    expect(tools.tools.map((entry) => entry.name)).toContain('find_many_deals');
    expect(tools.tools.map((entry) => entry.name)).toContain('create_one_deal');
    expect(tools.tools.map((entry) => entry.name)).not.toContain('update_one_deal');
    expect((await call('/v1/tools/create_one_deal', { key: key.apiKey, body: { data: { title: 'x' } } })).status).toBe(400);
    expect((await call('/v1/tools/create_one_deal', { key: key.apiKey, body: { data: {} } })).status).toBe(200);
    expect((await call('/v1/tools/update_one_deal', { key: key.apiKey, body: { id: '00000000-0000-4000-8000-000000000000', data: {} } })).status).toBe(403);

    expect((await call(path(`/roles/${role.id}`), { method: 'DELETE', key: adminKey })).status).toBe(200);
    expect((await call(path(`/roles/${role.id}`), { method: 'DELETE', key: adminKey })).status).toBe(404);
  });

  it("refuses another workspace's path with this workspace's key", async () => {
    const otherAdminRole = (await json<{ roles: { id: string }[] }>(await call(path('/roles', otherWorkspaceId), { key: adminKey }))).roles;
    expect(otherAdminRole).toBeUndefined();
    const roles = await json<{ roles: { id: string }[] }>(await call(path('/roles'), { key: adminKey }));
    expect(roles.roles.length).toBeGreaterThan(0);
  });
});

describe('API keys over HTTP', () => {
  it('creates, uses, rotates and revokes a key, and lists members without secrets', async () => {
    const roles = (await json<{ roles: { id: string; name: string }[] }>(await call(path('/roles'), { key: adminKey }))).roles;
    const adminRole = roles.find((role) => role.name === 'admin')!;
    const created = await json<{ principalId: string; apiKey: string }>(
      await call(path('/api-keys'), { key: adminKey, body: { name: 'ci', kind: 'agent', roleIds: [adminRole.id], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }),
    );
    expect(created.apiKey).toMatch(/^ak_/);
    expect((await call('/v1/tools/list_definitions', { key: created.apiKey, body: {} })).status).toBe(200);

    const members = await json<{ members: { id: string; kind: string; lastUsedAt: string | null }[] }>(await call(path('/members'), { key: adminKey }));
    expect(JSON.stringify(members)).not.toContain(created.apiKey);
    expect(members.members.find((member) => member.id === created.principalId)?.kind).toBe('agent');

    const rotated = await json<{ apiKey: string }>(await call(path(`/api-keys/${created.principalId}/rotate`), { key: adminKey, body: {} }));
    expect((await call('/v1/tools/list_definitions', { key: created.apiKey, body: {} })).status).toBe(403);
    expect((await call('/v1/tools/list_definitions', { key: rotated.apiKey, body: {} })).status).toBe(200);

    expect((await call(path(`/api-keys/${created.principalId}/revoke`), { key: adminKey, body: {} })).status).toBe(200);
    expect((await call('/v1/tools/list_definitions', { key: rotated.apiKey, body: {} })).status).toBe(403);
    expect((await call(path(`/api-keys/${created.principalId}/rotate`, otherWorkspaceId), { key: adminKey, body: {} })).status).toBe(403);
  });

  it('protects the last admin over HTTP', async () => {
    const members = (await json<{ members: { id: string; name: string }[] }>(await call(path('/members'), { key: adminKey }))).members;
    const bootstrapKey = members.find((member) => member.name === 'bootstrap key')!;
    const response = await call(path(`/members/${bootstrapKey.id}`), { method: 'DELETE', key: adminKey });
    expect(response.status).toBe(409);
    expect((await call(path(`/api-keys/${bootstrapKey.id}/revoke`), { key: adminKey, body: {} })).status).toBe(409);
    expect((await call(path('/roles'), { key: adminKey })).status).toBe(200);
  });
});

describe('audit log over HTTP', () => {
  it('pages through entries newest first and filters by outcome', async () => {
    for (let index = 0; index < 3; index += 1) await tool(adminKey, 'find_many_deals', {});
    await tool(adminKey, 'find_one_deal', { id: 'not-a-uuid' });
    const page = await json<{ entries: { id: number; tool: string; outcome: string }[]; nextBefore: number | null }>(await call(path('/audit-log?limit=2'), { key: adminKey }));
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]!.id).toBeGreaterThan(page.entries[1]!.id);
    expect(page.nextBefore).not.toBeNull();
    const errors = await json<{ entries: { outcome: string; tool: string }[] }>(await call(path('/audit-log?outcome=error'), { key: adminKey }));
    expect(errors.entries.length).toBeGreaterThan(0);
    expect(errors.entries.every((entry) => entry.outcome === 'error')).toBe(true);
  });
});
