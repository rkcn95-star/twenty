import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { connect, migrate, type Databases } from '@agent-crm/core';
import { createApp } from '../src/app.js';

const ADMIN_TOKEN = 'test-admin-token';
let databases: Databases;
let app: ReturnType<typeof createApp>;
let apiKey: string;

const connectClient = async (mode: 'lazy' | 'direct') => {
  const transport = new StreamableHTTPClientTransport(new URL(`http://agent-crm.test/mcp?mode=${mode}`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
};

const callJson = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? 'null';
  return { isError: Boolean(result.isError), value: JSON.parse(text) };
};

beforeAll(async () => {
  databases = connect({
    adminUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/agentcrm',
    runtimeUrl: process.env.RUNTIME_DATABASE_URL ?? 'postgres://app_runtime:app_runtime@localhost:5432/agentcrm',
  });
  await migrate(databases.admin);
  app = createApp(databases, ADMIN_TOKEN);
  const response = await app.request('/v1/bootstrap', {
    method: 'POST',
    headers: { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceName: `mcp-test-${Date.now()}` }),
  });
  expect(response.status).toBe(201);
  apiKey = ((await response.json()) as { apiKey: string }).apiKey;
});

afterAll(async () => {
  await databases.close();
});

describe('MCP endpoint', () => {
  it('rejects requests without a valid key', async () => {
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(403);
    expect((await app.request('/v1/tools', { headers: { authorization: 'Bearer nope' } })).status).toBe(403);
  });

  it('serves lazy meta tools and drives the schema and records end to end', async () => {
    const client = await connectClient('lazy');
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['get_tool_catalog', 'learn_tools', 'execute_tool', 'list_object_metadata', 'load_skill']),
    );

    const object = await callJson(client, 'execute_tool', {
      toolName: 'create_object',
      arguments: { nameSingular: 'company', namePlural: 'companies', label: 'Company' },
    });
    expect(object.isError).toBe(false);
    await callJson(client, 'execute_tool', {
      toolName: 'create_field',
      arguments: { objectId: object.value.id, name: 'name', label: 'Name', type: 'text' },
    });

    const catalog = await callJson(client, 'get_tool_catalog', {});
    expect(catalog.value.tools.map((tool: { name: string }) => tool.name)).toContain('create_one_company');

    const learned = await callJson(client, 'learn_tools', { toolNames: ['create_one_company'] });
    expect(learned.value[0].inputSchema.properties.data.properties).toHaveProperty('name');

    const created = await callJson(client, 'execute_tool', { toolName: 'create_one_company', arguments: { data: { name: 'Acme' } } });
    expect(created.value.name).toBe('Acme');
    const found = await callJson(client, 'execute_tool', { toolName: 'find_many_companies', arguments: {} });
    expect(found.value.total).toBe(1);

    const bad = await callJson(client, 'execute_tool', { toolName: 'create_one_company', arguments: { data: { nope: 1 } } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it('lists every permitted tool directly in direct mode', async () => {
    const client = await connectClient('direct');
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['find_many_companies', 'create_one_company', 'delete_one_company']));
    const deleteTool = (await client.listTools()).tools.find((tool) => tool.name === 'delete_one_company');
    expect(deleteTool?.annotations?.destructiveHint).toBe(true);
    await client.close();
  });
});
