import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Session } from '@agent-crm/core';

export type McpMode = 'lazy' | 'direct';

type MetaTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const emptyObject = { type: 'object', properties: {}, additionalProperties: false };

const META_TOOLS: MetaTool[] = [
  { name: 'list_object_metadata', description: 'List the objects and fields you can access.', inputSchema: emptyObject, annotations: READ_ONLY },
  { name: 'load_skill', description: 'Load a skill: step-by-step instructions for a task.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, annotations: READ_ONLY },
];

const LAZY_TOOLS: MetaTool[] = [
  { name: 'get_tool_catalog', description: 'List available tool names with one-line descriptions, plus skills.', inputSchema: emptyObject, annotations: READ_ONLY },
  {
    name: 'learn_tools',
    description: 'Get input schemas for tools. Call before execute_tool.',
    inputSchema: { type: 'object', properties: { toolNames: { type: 'array', items: { type: 'string' } } }, required: ['toolNames'] },
    annotations: READ_ONLY,
  },
  {
    name: 'execute_tool',
    description: 'Execute a tool by name. Call learn_tools first to get its input schema.',
    inputSchema: {
      type: 'object',
      properties: { toolName: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } },
      required: ['toolName', 'arguments'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  ...META_TOOLS,
];

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

export const buildMcpServer = (session: Session, mode: McpMode): Server => {
  const server = new Server({ name: 'agent-crm', version: '0.0.1' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: mode === 'lazy' ? LAZY_TOOLS : [...session.listTools(), ...META_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (params.name) {
        case 'list_object_metadata':
          return asText(session.objectMetadata());
        case 'load_skill':
          return asText(await session.loadSkill(String(args.name)));
        case 'get_tool_catalog':
          if (mode === 'lazy') return asText({ tools: session.catalog(), skills: await session.listSkills() });
          break;
        case 'learn_tools':
          if (mode === 'lazy') return asText(session.learn(args.toolNames as string[]));
          break;
        case 'execute_tool':
          if (mode === 'lazy') return asText(await session.execute(String(args.toolName), args.arguments));
          break;
        default:
          if (mode === 'direct') return asText(await session.execute(params.name, args));
      }
      return { isError: true, ...asText({ error: `Unknown tool "${params.name}"` }) };
    } catch (error) {
      return { isError: true, ...asText({ error: error instanceof Error ? error.message : String(error) }) };
    }
  });

  return server;
};
