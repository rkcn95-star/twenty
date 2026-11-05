import { z } from 'zod';
import { DEFINITION_KINDS, fetchDefinition, listDefinitions, upsertDefinition, type DefinitionKind } from './definitions.js';
import { AppError } from './errors.js';
import { IDENTIFIER_KEY } from './filters.js';
import {
  formDefinitionSchema, formSubmissionSchema, submitForm, validateFormDefinition, type FormDefinition,
} from './form.js';
import {
  assertRecordIds, findAction, gridDefinitionSchema, gridToReports, runTransactionalAction, toolCallsForAction, validateGridDefinition,
  type GridDefinition,
} from './grid.js';
import { DESTRUCTIVE, READ, WRITE, type ToolDefinition, type ToolEnvironment } from './registry.js';
import { compileReport, reportDefinitionSchema, runCompiledReport, type ReportDefinition } from './report.js';

const nameSchema = IDENTIFIER_KEY.describe('Lowercase snake_case name');

const describeFormFields = (env: ToolEnvironment, objectPlural: string, fields: { name: string; label?: string; required?: boolean; readOnly?: boolean }[]) => {
  const object = env.metadata.objects.find((candidate) => candidate.namePlural === objectPlural);
  return fields.flatMap((formField) => {
    const field = object?.fields.find((candidate) => candidate.name === formField.name && candidate.active);
    if (!field || env.permissions.hiddenFieldIds.has(field.id)) return [];
    return [{
      ...formField,
      label: formField.label ?? field.label,
      type: field.type,
      options: field.options,
      relationObject: field.relationObjectId
        ? env.metadata.objects.find((candidate) => candidate.id === field.relationObjectId)?.namePlural
        : undefined,
      writable: !formField.readOnly && !env.permissions.readOnlyFieldIds.has(field.id),
    }];
  });
};

const describeForm = (env: ToolEnvironment, definition: FormDefinition) => {
  if (definition.kind === 'single') return { ...definition, fields: describeFormFields(env, definition.object, definition.fields) };
  if (definition.kind === 'multi') {
    return { ...definition, sections: definition.sections.map((section) => ({ ...section, fields: describeFormFields(env, section.object, section.fields) })) };
  }
  return {
    ...definition,
    parent: { ...definition.parent, fields: describeFormFields(env, definition.parent.object, definition.parent.fields) },
    children: definition.children.map((child) => ({ ...child, fields: describeFormFields(env, child.object, child.fields) })),
  };
};

const reportInput = z.object({
  name: nameSchema.optional().describe('A saved report'),
  definition: reportDefinitionSchema.optional().describe('An unsaved report definition'),
});

export const builderTools = (env: ToolEnvironment): ToolDefinition[] => {
  const { session, databases, principal, metadata } = env;
  const admin = databases.admin;
  const workspaceId = principal.workspaceId;
  const load = <TDefinition>(kind: DefinitionKind, name: string) => fetchDefinition<TDefinition>(admin, workspaceId, kind, name);

  const resolveReport = async (input: z.infer<typeof reportInput>): Promise<ReportDefinition> => {
    if (!input.name === !input.definition) throw new AppError('validation', 'Provide exactly one of "name" or "definition"');
    return input.definition ? reportDefinitionSchema.parse(input.definition) : load<ReportDefinition>('report', input.name as string);
  };

  const runReport = async (definition: ReportDefinition) => runCompiledReport(session.runtime, session.reportView, compileReport(definition, session.reportView));

  const tools: ToolDefinition[] = [
    {
      name: 'list_definitions',
      description: 'List saved forms, grids and reports.',
      category: 'builder',
      annotations: READ,
      inputSchema: z.object({ kind: z.enum(DEFINITION_KINDS).optional() }),
      run: (args) => listDefinitions(admin, workspaceId, args.kind),
    },
    {
      name: 'describe_form',
      description: 'Get a saved form with the type, options and writability of each field, for rendering.',
      category: 'builder',
      annotations: READ,
      inputSchema: z.object({ name: nameSchema }),
      run: async (args) => describeForm(env, await load<FormDefinition>('form', args.name)),
    },
    {
      name: 'submit_form',
      description:
        'Submit a saved form. single: {values}. multi: {sections:{key:values}}. parent_child: {parent, children:{key:[{id?, values}]}}. ' +
        'Pass recordId to edit (single and parent_child). Everything is saved in one transaction.',
      category: 'builder',
      annotations: WRITE,
      inputSchema: formSubmissionSchema.extend({ name: nameSchema }),
      run: async ({ name, ...submission }) => {
        const definition = await load<FormDefinition>('form', name);
        validateFormDefinition(definition, metadata);
        return session.withTransaction((contextFor) => submitForm(definition, submission, contextFor));
      },
    },
    {
      name: 'run_grid',
      description: 'Query a saved data grid. Optional equality filter, sort, offset and limit. Returns rows, total and the available actions.',
      category: 'builder',
      annotations: READ,
      inputSchema: z.object({
        name: nameSchema,
        filter: z.record(z.string(), z.unknown()).optional(),
        sort: z.array(z.object({ field: z.string(), direction: z.enum(['asc', 'desc']).default('asc') })).max(3).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      run: async ({ name, ...query }) => {
        const definition = await load<GridDefinition>('grid', name);
        validateGridDefinition(definition, metadata);
        const reports = gridToReports(definition, query);
        const [rows, total] = await Promise.all([
          runReport(reportDefinitionSchema.parse(reports.rows)),
          runReport(reportDefinitionSchema.parse(reports.total)),
        ]);
        const access = env.permissions.objects.get(metadata.objects.find((object) => object.namePlural === definition.object)?.id ?? '');
        const allowed = (kind: string) => kind === 'delete' ? access?.delete : kind === 'set_fields' ? access?.update : true;
        const describeActions = (actions: GridDefinition['rowActions']) =>
          actions.map((action) => ({ key: action.key, label: action.label, kind: action.kind, confirm: action.confirm, enabled: Boolean(allowed(action.kind)) }));
        return {
          columns: definition.columns.map((column) => ({ ...column, key: (column.via ? `${column.via}_${column.field}` : column.field).slice(0, 40) })),
          rows: rows.rows,
          total: total.rows[0]?.total ?? 0,
          rowActions: describeActions(definition.rowActions),
          bulkActions: describeActions(definition.bulkActions),
        };
      },
    },
    {
      name: 'run_grid_action',
      description: 'Run a grid row or bulk action on up to 200 records. set_fields and delete are atomic; run_tool calls the tool once per record.',
      category: 'builder',
      annotations: DESTRUCTIVE,
      inputSchema: z.object({ grid: nameSchema, action: nameSchema, recordIds: z.array(z.uuid()) }),
      run: async (args) => {
        const definition = await load<GridDefinition>('grid', args.grid);
        const action = findAction(definition, args.action);
        assertRecordIds(args.recordIds);
        if (action.kind === 'open_form') throw new AppError('validation', 'open_form is a client-side action');
        if (action.kind === 'run_tool') {
          const results = [];
          for (const call of toolCallsForAction(action, args.recordIds)) results.push(await session.execute(call.name, call.arguments));
          return { affected: results.length, results };
        }
        const affected = await session.withTransaction((contextFor) => runTransactionalAction(action, args.recordIds, contextFor(definition.object)));
        return { affected };
      },
    },
    {
      name: 'run_report',
      description: 'Run a saved report (name) or an unsaved report definition. Runs read-only with your own permissions.',
      category: 'builder',
      annotations: READ,
      inputSchema: reportInput,
      run: async (args) => runReport(await resolveReport(args)),
    },
    {
      name: 'preview_report_sql',
      description: 'Compile a report definition to SQL without running it.',
      category: 'builder',
      annotations: READ,
      inputSchema: reportInput,
      run: async (args) => compileReport(await resolveReport(args), session.reportView),
    },
  ];

  if (env.permissions.canManageSchema) {
    tools.push(
      {
        name: 'save_form',
        description: 'Create or replace a form definition: single, multi (several linked objects) or parent_child (header plus repeating rows).',
        category: 'builder',
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ name: nameSchema, definition: formDefinitionSchema }),
        run: async (args) => {
          validateFormDefinition(args.definition, metadata);
          return upsertDefinition(admin, workspaceId, principal.id, 'form', args.name, args.definition);
        },
      },
      {
        name: 'save_grid',
        description: 'Create or replace a data grid definition with columns, filter, sort and row or bulk actions.',
        category: 'builder',
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ name: nameSchema, definition: gridDefinitionSchema }),
        run: async (args) => {
          validateGridDefinition(args.definition, metadata);
          const reports = gridToReports(args.definition, {});
          compileReport(reportDefinitionSchema.parse(reports.rows), session.reportView);
          return upsertDefinition(admin, workspaceId, principal.id, 'grid', args.name, args.definition);
        },
      },
      {
        name: 'save_report',
        description: 'Create or replace a report definition. It is compiled once to check that every reference is valid.',
        category: 'builder',
        annotations: { ...WRITE, idempotentHint: true },
        inputSchema: z.object({ name: nameSchema, definition: reportDefinitionSchema }),
        run: async (args) => {
          compileReport(args.definition, session.reportView);
          return upsertDefinition(admin, workspaceId, principal.id, 'report', args.name, args.definition);
        },
      },
    );
  }
  return tools;
};
