import type pg from 'pg';
import { z } from 'zod';
import { loadPrincipal } from './access.js';
import { inTransaction, type Databases } from './db.js';
import { AppError } from './errors.js';
import { loadMetadata } from './metadata.js';
import { resolvePermissions, type PermissionSet } from './permissions.js';
import { applySessionSettings, type RecordContext } from './records.js';
import type { ReportView } from './report.js';
import { buildTools, type ToolDefinition, type ToolEnvironment } from './registry.js';
import type { Metadata, Principal } from './types.js';

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolDefinition['annotations'];
};

const toJsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;

const describeTool = (tool: ToolDefinition): McpTool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: toJsonSchema(tool.inputSchema),
  annotations: tool.annotations,
});

export class Session {
  private readonly tools: Map<string, ToolDefinition>;

  private constructor(
    private readonly databases: Databases,
    readonly principal: Principal,
    readonly metadata: Metadata,
    readonly permissions: PermissionSet,
  ) {
    const env: ToolEnvironment = { databases, principal, metadata, permissions, session: this };
    this.tools = new Map(buildTools(env).map((tool) => [tool.name, tool]));
  }

  static async open(databases: Databases, principal: Principal, onBehalfOfId?: string): Promise<Session> {
    const metadata = await loadMetadata(databases.admin, principal.workspaceId);
    const onBehalfOf = onBehalfOfId ? await loadPrincipal(databases.admin, onBehalfOfId) : undefined;
    if (onBehalfOf && onBehalfOf.workspaceId !== principal.workspaceId) throw new AppError('forbidden', 'Cross-workspace delegation');
    const permissions = await resolvePermissions(databases.admin, principal, metadata, onBehalfOf);
    return new Session(databases, principal, metadata, permissions);
  }

  get reportView(): ReportView {
    return { metadata: this.metadata, permissions: this.permissions, principal: this.principal };
  }

  get runtime(): pg.Pool {
    return this.databases.runtime;
  }

  recordContext(objectPlural: string, client?: pg.PoolClient): RecordContext {
    const object = this.metadata.objects.find((candidate) => candidate.namePlural === objectPlural);
    if (!object) throw new AppError('not_found', `Unknown object "${objectPlural}"`);
    return {
      runtime: this.databases.runtime,
      metadata: this.metadata,
      object,
      permissions: this.permissions,
      principal: this.principal,
      client,
    };
  }

  // One RLS transaction shared by every record operation inside `work`; any error rolls all of them back.
  withTransaction<TResult>(work: (contextFor: (objectPlural: string) => RecordContext) => Promise<TResult>): Promise<TResult> {
    return inTransaction(
      this.databases.runtime,
      (client) => work((objectPlural) => this.recordContext(objectPlural, client)),
      (client) => applySessionSettings(client, this.metadata.workspaceId, this.permissions),
    );
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  listTools(): McpTool[] {
    return [...this.tools.values()].map(describeTool);
  }

  catalog() {
    return [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, category: tool.category }));
  }

  learn(toolNames: string[]) {
    return toolNames.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new AppError('not_found', `Unknown tool "${name}"`);
      return describeTool(tool);
    });
  }

  objectMetadata() {
    return this.metadata.objects
      .filter((object) => this.permissions.objects.get(object.id)?.read)
      .map((object) => ({
        id: object.id,
        nameSingular: object.nameSingular,
        namePlural: object.namePlural,
        label: object.label,
        fields: object.fields
          .filter((field) => field.active && !this.permissions.hiddenFieldIds.has(field.id))
          .map((field) => ({
            id: field.id,
            name: field.name,
            label: field.label,
            type: field.type,
            options: field.options,
            readOnly: this.permissions.readOnlyFieldIds.has(field.id),
          })),
      }));
  }

  async loadSkill(name: string) {
    const result = await this.databases.admin.query(
      'SELECT name, description, content FROM core.skills WHERE workspace_id = $1 AND name = $2',
      [this.principal.workspaceId, name],
    );
    if (!result.rows[0]) throw new AppError('not_found', `Unknown skill "${name}"`);
    return result.rows[0];
  }

  async listSkills() {
    const result = await this.databases.admin.query('SELECT name, description FROM core.skills WHERE workspace_id = $1', [
      this.principal.workspaceId,
    ]);
    return result.rows;
  }

  // Single enforcement path: schema validation, permission-filtered tool set, audit row.
  async execute(toolName: string, rawArgs: unknown): Promise<unknown> {
    const tool = this.tools.get(toolName);
    let outcome: 'ok' | 'error' = 'ok';
    let detail: string | null = null;
    let rowCount: number | null = null;
    try {
      if (!tool) throw new AppError('forbidden', `Tool "${toolName}" is not available to this principal`);
      const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) throw new AppError('validation', z.prettifyError(parsed.error));
      const result = await tool.run(parsed.data);
      if (result && typeof result === 'object' && 'records' in result && Array.isArray(result.records)) rowCount = result.records.length;
      else if (result) rowCount = 1;
      return result;
    } catch (error) {
      outcome = 'error';
      detail = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await this.databases.admin
        .query(
          `INSERT INTO core.audit_log (workspace_id, principal_id, tool, args, outcome, detail, row_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [this.principal.workspaceId, this.principal.id, toolName, JSON.stringify(rawArgs ?? null), outcome, detail, rowCount],
        )
        .catch(() => undefined);
    }
  }
}
