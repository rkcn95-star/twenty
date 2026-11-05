import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Session, createField, createObject, createPrincipal, createRole, provisionWorkspace, setFieldPermission, setObjectPermission,
  addRowPredicate, type Databases, type FieldType, type Principal,
} from '../src/index.js';
import { resetDatabase } from './helpers.js';

let databases: Databases;
let workspaceId: string;
let dataModelId: string;
let admin: Session;
let ids: Record<string, string> = {};
let fieldIds: Record<string, string> = {};

type Rows = { rows: Record<string, unknown>[]; sql: string };

const exec = <TResult = any>(session: Session, tool: string, args: unknown) => session.execute(tool, args) as Promise<TResult>;

const addObject = async (singular: string, plural: string, fields: [string, FieldType, object?][]) => {
  const object = await createObject(databases.admin, dataModelId, { nameSingular: singular, namePlural: plural, label: singular });
  ids[plural] = object.id;
  for (const [name, type, extra] of fields) {
    const field = await createField(databases.admin, dataModelId, object.id, { name, label: name, type, ...(extra ?? {}) });
    fieldIds[`${plural}.${name}`] = field.id;
  }
};

const makeUser = async (roleName: string, setup: (roleId: string) => Promise<void>): Promise<Session> => {
  const roleId = await createRole(databases.admin, workspaceId, { name: roleName });
  await setup(roleId);
  const { principal } = await createPrincipal(databases.admin, workspaceId, { kind: 'user', name: roleName, roleIds: [roleId] });
  return Session.open(databases, principal as Principal);
};

beforeAll(async () => {
  databases = await resetDatabase();
  const workspace = await provisionWorkspace(databases.admin, 'builders');
  workspaceId = workspace.id;
  dataModelId = workspace.dataModelId;
  const adminRole = await createRole(databases.admin, workspaceId, { name: 'admin', canManageSchema: true, allObjectsAccess: true });
  const { principal } = await createPrincipal(databases.admin, workspaceId, { kind: 'api_key', name: 'admin', roleIds: [adminRole] });

  await addObject('company', 'companies', [['name', 'text'], ['industry', 'select', { options: ['tech', 'retail'] }]]);
  await addObject('deal', 'deals', [
    ['title', 'text'], ['amount', 'number'], ['stage', 'select', { options: ['new', 'won', 'lost'] }], ['closed_on', 'date'],
    ['company', 'relation', { relationObjectId: ids.companies }],
  ]);
  await addObject('sales_order', 'sales_orders', [['customer', 'text']]);
  await addObject('order_line', 'order_lines', [
    ['sales_order', 'relation', { relationObjectId: ids.sales_orders }], ['sku', 'text'], ['qty', 'number'],
  ]);

  admin = await Session.open(databases, principal);
  const acme = await exec(admin, 'create_one_company', { data: { name: 'Acme', industry: 'tech' } });
  const beta = await exec(admin, 'create_one_company', { data: { name: 'Beta', industry: 'retail' } });
  const deals = [
    { title: 'A1', amount: 100, stage: 'won', closed_on: '2026-01-10', company: acme.id },
    { title: 'A2', amount: 50, stage: 'won', closed_on: '2026-01-25', company: acme.id },
    { title: 'A3', amount: 70, stage: 'lost', closed_on: '2026-02-03', company: acme.id },
    { title: 'B1', amount: 30, stage: 'won', closed_on: '2026-02-14', company: beta.id },
  ];
  for (const data of deals) await exec(admin, 'create_one_deal', { data });
});

afterAll(async () => {
  await databases.close();
});

const revenueByCompany = {
  source: 'deals',
  joins: [{ alias: 'c', field: 'company' }],
  columns: [
    { key: 'company_name', ref: { alias: 'c', field: 'name' } },
    { key: 'stage', ref: { field: 'stage' } },
    { key: 'total', ref: { field: 'amount' }, aggregate: 'sum' },
    { key: 'deals', aggregate: 'count' },
  ],
  orderBy: [{ key: 'total', direction: 'desc' }],
};

describe('report builder', () => {
  it('compiles joins, aggregates and implicit grouping', async () => {
    const result = await exec<Rows>(admin, 'run_report', { definition: revenueByCompany });
    expect(result.rows).toEqual([
      { company_name: 'Acme', stage: 'won', total: 150, deals: 2 },
      { company_name: 'Acme', stage: 'lost', total: 70, deals: 1 },
      { company_name: 'Beta', stage: 'won', total: 30, deals: 1 },
    ]);
    expect(result.sql).toContain('GROUP BY 1, 2');
  });

  it('buckets dates and filters with nested groups', async () => {
    const result = await exec<Rows>(admin, 'run_report', {
      definition: {
        source: 'deals',
        columns: [{ key: 'month', ref: { field: 'closed_on' }, bucket: 'month' }, { key: 'total', ref: { field: 'amount' }, aggregate: 'sum' }],
        filter: { op: 'and', items: [{ ref: { field: 'stage' }, operator: 'eq', value: 'won' }, { op: 'or', items: [
          { ref: { field: 'amount' }, operator: 'gte', value: 30 }, { ref: { field: 'title' }, operator: 'contains', value: 'zzz' },
        ] }] },
        orderBy: [{ key: 'month' }],
      },
    });
    expect(result.rows.map((row) => row.total)).toEqual([150, 30]);
  });

  it('reads back and deletes saved definitions', async () => {
    await exec(admin, 'save_report', { name: 'temp_report', definition: { source: 'deals', columns: [{ key: 'n', aggregate: 'count' }] } });
    const stored = await exec(admin, 'get_definition', { kind: 'report', name: 'temp_report' });
    expect(stored.definition.source).toBe('deals');
    await exec(admin, 'delete_definition', { kind: 'report', name: 'temp_report' });
    await expect(exec(admin, 'get_definition', { kind: 'report', name: 'temp_report' })).rejects.toThrow(/No report named/);
    await expect(exec(admin, 'delete_definition', { kind: 'report', name: 'temp_report' })).rejects.toThrow(/No report named/);
    const viewer = await makeUser('definition_viewer', async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true });
    });
    expect(viewer.toolNames()).toContain('get_definition');
    expect(viewer.toolNames()).not.toContain('delete_definition');
  });

  it('saves a report, runs it by name and shows parameterised SQL', async () => {
    await exec(admin, 'save_report', { name: 'revenue_by_company', definition: revenueByCompany });
    expect((await exec<Rows>(admin, 'run_report', { name: 'revenue_by_company' })).rows).toHaveLength(3);
    const preview = await exec(admin, 'preview_report_sql', {
      definition: { source: 'deals', columns: [{ key: 'title', ref: { field: 'title' } }], filter: { op: 'and', items: [{ ref: { field: 'title' }, operator: 'eq', value: 'secret-value' }] } },
    });
    expect(preview.sql).not.toContain('secret-value');
    expect(preview.params).toContain('secret-value');
  });

  it('rejects unknown fields, bad aggregates, injection attempts and mistyped values', async () => {
    const run = (definition: object) => exec(admin, 'run_report', { definition });
    await expect(run({ source: 'deals', columns: [{ key: 'x', ref: { field: 'title"; DROP TABLE x;--' } }] })).rejects.toThrow(/Unknown field/);
    await expect(run({ source: 'deals', columns: [{ key: 'x', ref: { field: 'title' }, aggregate: 'sum' }] })).rejects.toThrow(/numeric/);
    await expect(run({ source: 'deals; DROP', columns: [{ key: 'x', aggregate: 'count' }] })).rejects.toThrow(/Unknown source/);
    await expect(run({ source: 'deals', columns: [{ key: 'bad key', aggregate: 'count' }] })).rejects.toThrow();
    const injected = await run({
      source: 'deals', columns: [{ key: 'n', aggregate: 'count' }],
      filter: { op: 'and', items: [{ ref: { field: 'title' }, operator: 'contains', value: "'; DROP TABLE deals; --" }] },
    });
    expect(injected.rows[0].n).toBe(0);
    await expect(run({
      source: 'deals', columns: [{ key: 'n', aggregate: 'count' }],
      filter: { op: 'and', items: [{ ref: { field: 'amount' }, operator: 'gt', value: 'abc' }] },
    })).rejects.toThrow(/does not match/);
  });

  it('applies field masks, row rules and object access to reports', async () => {
    const analyst = await makeUser('analyst', async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true });
      await setFieldPermission(databases.admin, roleId, fieldIds['deals.amount']!, { read: false, write: false });
    });
    const hidden = { source: 'deals', columns: [{ key: 'total', ref: { field: 'amount' }, aggregate: 'sum' }] };
    await expect(exec(analyst, 'run_report', { definition: hidden })).rejects.toThrow(/Unknown field/);
    await expect(exec(analyst, 'run_report', { definition: revenueByCompany })).rejects.toThrow();
    expect(analyst.toolNames()).not.toContain('save_report');
    await expect(exec(analyst, 'save_report', { name: 'x', definition: hidden })).rejects.toThrow(/not available/);

    const rowLimited = await makeUser('acme_only', async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true });
      await setObjectPermission(databases.admin, roleId, ids.companies!, { read: true });
      await addRowPredicate(databases.admin, roleId, ids.companies!, { fieldName: 'name', operator: 'eq', value: 'Acme' });
    });
    const joined = await exec<Rows>(rowLimited, 'run_report', { definition: revenueByCompany });
    expect(joined.rows.map((row) => row.company_name)).toEqual(['Acme', 'Acme', null]);
    const direct = await exec<Rows>(rowLimited, 'run_report', { definition: { source: 'companies', columns: [{ key: 'name', ref: { field: 'name' } }] } });
    expect(direct.rows).toEqual([{ name: 'Acme' }]);
  });
});

describe('form builder', () => {
  const countOf = async (source: string) =>
    (await exec<Rows>(admin, 'run_report', { definition: { source, columns: [{ key: 'n', aggregate: 'count' }] } })).rows[0]!.n;

  it('submits a single form with required and default handling', async () => {
    await exec(admin, 'save_form', {
      name: 'new_company',
      definition: { kind: 'single', object: 'companies', fields: [{ name: 'name', required: true }, { name: 'industry', defaultValue: 'tech' }] },
    });
    await expect(exec(admin, 'submit_form', { name: 'new_company', values: {} })).rejects.toThrow(/required/);
    await expect(exec(admin, 'submit_form', { name: 'new_company', values: { name: 'X', nope: 1 } })).rejects.toThrow(/not part of this form/);
    const created = await exec(admin, 'submit_form', { name: 'new_company', values: { name: 'Gamma' } });
    const row = await exec(admin, 'find_one_company', { id: created.ids.id });
    expect(row.industry).toBe('tech');
    const described = await exec(admin, 'describe_form', { name: 'new_company' });
    expect(described.fields[1]).toMatchObject({ name: 'industry', type: 'select', options: ['tech', 'retail'], writable: true });
  });

  it('saves linked records from a multi form', async () => {
    await exec(admin, 'save_form', {
      name: 'company_and_deal',
      definition: {
        kind: 'multi',
        sections: [
          { key: 'company', object: 'companies', fields: [{ name: 'name', required: true }] },
          { key: 'deal', object: 'deals', fields: [{ name: 'title' }, { name: 'amount' }], link: { parent: 'company', field: 'company' } },
        ],
      },
    });
    const before = await countOf('deals');
    const result = await exec(admin, 'submit_form', { name: 'company_and_deal', sections: { company: { name: 'Delta' }, deal: { title: 'D1', amount: 5 } } });
    const deal = await exec(admin, 'find_one_deal', { id: result.ids.deal });
    expect(deal.company).toBe(result.ids.company);
    expect(await countOf('deals')).toBe((before as number) + 1);

    await expect(exec(admin, 'submit_form', { name: 'company_and_deal', sections: { company: { name: 'Eps' }, deal: { title: 'bad', amount: 'x' } } })).rejects.toThrow();
    const names = await exec<Rows>(admin, 'find_many_companies', { filter: { name: 'Eps' } });
    expect((names as unknown as { total: number }).total).toBe(0);
  });

  it('creates and edits parent-child forms atomically', async () => {
    await expect(exec(admin, 'save_form', {
      name: 'bad_order',
      definition: { kind: 'parent_child', parent: { object: 'sales_orders', fields: [{ name: 'customer' }] }, children: [{ key: 'lines', object: 'order_lines', relationField: 'sku', fields: [{ name: 'qty' }] }] },
    })).rejects.toThrow(/must be a relation/);

    await exec(admin, 'save_form', {
      name: 'order',
      definition: {
        kind: 'parent_child',
        parent: { object: 'sales_orders', fields: [{ name: 'customer', required: true }] },
        children: [{ key: 'lines', object: 'order_lines', relationField: 'sales_order', fields: [{ name: 'sku', required: true }, { name: 'qty' }], minRows: 1, maxRows: 5 }],
      },
    });
    await expect(exec(admin, 'submit_form', { name: 'order', parent: { customer: 'Z' }, children: { lines: [] } })).rejects.toThrow(/at least 1/);

    const ordersBefore = await countOf('sales_orders');
    await expect(exec(admin, 'submit_form', {
      name: 'order', parent: { customer: 'Rollback' }, children: { lines: [{ values: { sku: 'ok', qty: 1 } }, { values: { sku: 'bad', qty: 'x' } }] },
    })).rejects.toThrow();
    expect(await countOf('sales_orders')).toBe(ordersBefore);

    const created = await exec(admin, 'submit_form', {
      name: 'order', parent: { customer: 'Zed' }, children: { lines: [{ values: { sku: 'A', qty: 1 } }, { values: { sku: 'B', qty: 2 } }] },
    });
    const [lineA, lineB] = created.ids.children.lines as string[];
    const edited = await exec(admin, 'submit_form', {
      name: 'order', recordId: created.ids.id, parent: { customer: 'Zed Inc' },
      children: { lines: [{ id: lineA, values: { qty: 10 } }, { values: { sku: 'C', qty: 3 } }] },
    });
    expect(edited.ids.children.lines).toHaveLength(2);
    const lines = await exec<{ records: { sku: string; qty: number }[] }>(admin, 'find_many_order_lines', { filter: { sales_order: created.ids.id } });
    expect(lines.records.map((line) => [line.sku, line.qty]).sort()).toEqual([['A', 10], ['C', 3]]);
    await expect(exec(admin, 'find_one_order_line', { id: lineB })).rejects.toThrow(/not found/);
  });
});

describe('data grid', () => {
  it('queries, filters, shows related columns and runs actions', async () => {
    await exec(admin, 'save_grid', {
      name: 'deal_list',
      definition: {
        object: 'deals',
        columns: [{ field: 'title' }, { field: 'amount' }, { field: 'stage' }, { via: 'company', field: 'name' }],
        sort: [{ field: 'amount', direction: 'desc' }],
        rowActions: [{ key: 'mark_lost', label: 'Mark lost', kind: 'set_fields', set: { stage: 'lost' }, confirm: 'Mark as lost?' }],
        bulkActions: [{ key: 'remove', label: 'Delete', kind: 'delete' }, { key: 'edit', label: 'Edit', kind: 'open_form', form: 'new_company' }],
      },
    });
    const page = await exec(admin, 'run_grid', { name: 'deal_list', filter: { stage: 'won' }, limit: 2 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({ title: 'A1', company_name: 'Acme' });
    expect(page.rowActions[0]).toMatchObject({ key: 'mark_lost', enabled: true });

    const target = page.rows.map((row: { id: string }) => row.id);
    expect(await exec(admin, 'run_grid_action', { grid: 'deal_list', action: 'mark_lost', recordIds: target })).toEqual({ affected: 2 });
    expect((await exec(admin, 'run_grid', { name: 'deal_list', filter: { stage: 'lost' } })).total).toBe(3);
    await expect(exec(admin, 'run_grid_action', { grid: 'deal_list', action: 'edit', recordIds: target })).rejects.toThrow(/client-side/);
    await expect(exec(admin, 'run_grid_action', { grid: 'deal_list', action: 'remove', recordIds: [] })).rejects.toThrow(/between 1 and/);
  });

  it('disables actions the principal cannot perform', async () => {
    const reader = await makeUser('grid_reader', async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true });
      await setObjectPermission(databases.admin, roleId, ids.companies!, { read: true });
    });
    const page = await exec(reader, 'run_grid', { name: 'deal_list' });
    expect(page.rowActions[0].enabled).toBe(false);
    expect(page.bulkActions.find((action: { key: string }) => action.key === 'remove').enabled).toBe(false);
    const id = page.rows[0].id;
    await expect(exec(reader, 'run_grid_action', { grid: 'deal_list', action: 'mark_lost', recordIds: [id] })).rejects.toThrow(/No update access/);
    const removed = await exec(admin, 'run_grid_action', { grid: 'deal_list', action: 'remove', recordIds: [id] });
    expect(removed.affected).toBe(1);
  });
});
