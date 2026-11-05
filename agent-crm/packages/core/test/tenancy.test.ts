import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Session, createDataModel, createField, createObject, createPrincipal, createRole, provisionWorkspace, setObjectPermission,
  type Databases,
} from '../src/index.js';
import { resetDatabase } from './helpers.js';

let databases: Databases;
let model: { id: string; schemaName: string };
let objectIds: Record<string, string> = {};

type Tenant = { workspaceId: string; session: Session };
let acme: Tenant;
let globex: Tenant;

const exec = <TResult = any>(session: Session, tool: string, args: unknown) => session.execute(tool, args) as Promise<TResult>;

const joinTenant = async (name: string): Promise<Tenant> => {
  const workspace = await provisionWorkspace(databases.admin, name, { dataModelId: model.id });
  const role = await createRole(databases.admin, workspace.id, { name: 'admin', allObjectsAccess: true, canManageSchema: true });
  const { principal } = await createPrincipal(databases.admin, workspace.id, { kind: 'api_key', name, roleIds: [role] });
  return { workspaceId: workspace.id, session: await Session.open(databases, principal) };
};

const asRuntime = async (settings: Record<string, string>, sql: string, params: unknown[] = []) => {
  const client = await databases.runtime.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) await client.query('SELECT set_config($1, $2, true)', [key, value]);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

beforeAll(async () => {
  databases = await resetDatabase();
  model = await createDataModel(databases.admin, 'payroll-lite', 'shared');
  const customers = await createObject(databases.admin, model.id, { nameSingular: 'customer', namePlural: 'customers', label: 'Customer' });
  const invoices = await createObject(databases.admin, model.id, { nameSingular: 'invoice', namePlural: 'invoices', label: 'Invoice' });
  objectIds = { customers: customers.id, invoices: invoices.id };
  await createField(databases.admin, model.id, customers.id, { name: 'name', label: 'Name', type: 'text' });
  await createField(databases.admin, model.id, invoices.id, { name: 'amount', label: 'Amount', type: 'number' });
  await createField(databases.admin, model.id, invoices.id, { name: 'customer', label: 'Customer', type: 'relation', relationObjectId: customers.id });
  acme = await joinTenant('Acme');
  globex = await joinTenant('Globex');
});

afterAll(async () => {
  await databases.close();
});

describe('shared schema with RLS', () => {
  it('puts both tenants in one schema with a workspace_id column', async () => {
    const tables = await databases.admin.query(
      "SELECT table_schema FROM information_schema.columns WHERE column_name = 'workspace_id' AND table_name = 'invoices'",
    );
    expect(tables.rows).toEqual([{ table_schema: model.schemaName }]);
    expect(acme.session.metadata.schemaName).toBe(globex.session.metadata.schemaName);
    expect(acme.session.metadata.tenancy).toBe('shared');
  });

  it('keeps each tenant to its own rows through tools and reports', async () => {
    const acmeCustomer = await exec(acme.session, 'create_one_customer', { data: { name: 'Acme customer' } });
    const globexCustomer = await exec(globex.session, 'create_one_customer', { data: { name: 'Globex customer' } });
    await exec(acme.session, 'create_one_invoice', { data: { amount: 10, customer: acmeCustomer.id } });
    await exec(acme.session, 'create_one_invoice', { data: { amount: 20, customer: acmeCustomer.id } });
    await exec(globex.session, 'create_one_invoice', { data: { amount: 500, customer: globexCustomer.id } });

    expect((await exec(acme.session, 'find_many_invoices', {})).total).toBe(2);
    expect((await exec(globex.session, 'find_many_invoices', {})).total).toBe(1);
    await expect(exec(globex.session, 'find_one_customer', { id: acmeCustomer.id })).rejects.toThrow(/not found/);

    const report = (session: Session) =>
      exec(session, 'run_report', {
        definition: {
          source: 'invoices',
          joins: [{ alias: 'c', field: 'customer' }],
          columns: [{ key: 'customer_name', ref: { alias: 'c', field: 'name' } }, { key: 'total', ref: { field: 'amount' }, aggregate: 'sum' }],
        },
      });
    expect((await report(acme.session)).rows).toEqual([{ customer_name: 'Acme customer', total: 30 }]);
    expect((await report(globex.session)).rows).toEqual([{ customer_name: 'Globex customer', total: 500 }]);
  });

  it('blocks cross-tenant reads and writes in the database itself', async () => {
    const table = `"${model.schemaName}"."invoices"`;
    const read = { 'app.read_objects': objectIds.invoices! };
    expect((await asRuntime({ ...read, 'app.workspace_id': acme.workspaceId }, `SELECT * FROM ${table}`)).rowCount).toBe(2);
    expect((await asRuntime({ ...read, 'app.workspace_id': globex.workspaceId }, `SELECT * FROM ${table}`)).rowCount).toBe(1);
    expect((await asRuntime({ ...read, 'app.workspace_id': '00000000-0000-0000-0000-000000000000' }, `SELECT * FROM ${table}`)).rowCount).toBe(0);
    expect((await asRuntime({ 'app.workspace_id': acme.workspaceId }, `SELECT * FROM ${table}`)).rowCount).toBe(0);
    expect((await asRuntime({}, `SELECT * FROM ${table}`)).rowCount).toBe(0);

    const write = { 'app.workspace_id': acme.workspaceId, 'app.write_objects': objectIds.invoices!, 'app.read_objects': objectIds.invoices! };
    await expect(asRuntime(write, `INSERT INTO ${table} (workspace_id) VALUES ($1)`, [globex.workspaceId])).rejects.toThrow(/row-level security/);
    const hijack = await asRuntime(write, `UPDATE ${table} SET amount = 1 WHERE workspace_id = $1`, [globex.workspaceId]);
    expect(hijack.rowCount).toBe(0);
    await expect(asRuntime(write, `UPDATE ${table} SET workspace_id = $1 WHERE workspace_id = $2`, [globex.workspaceId, acme.workspaceId])).rejects.toThrow(/row-level security/);
  });

  it('refuses a relation to another tenant even with a valid id', async () => {
    const foreign = await exec(globex.session, 'create_one_customer', { data: { name: 'Foreign' } });
    await expect(exec(acme.session, 'create_one_invoice', { data: { amount: 1, customer: foreign.id } })).rejects.toThrow(/referenced record does not exist/);
  });

  it('does not give tenant admins schema tools on a shared model', async () => {
    expect(acme.session.toolNames()).not.toContain('create_object');
    expect(acme.session.toolNames()).toContain('create_one_invoice');
  });

  it('applies model changes to every tenant', async () => {
    await createField(databases.admin, model.id, objectIds.invoices!, { name: 'status', label: 'Status', type: 'select', options: ['open', 'paid'] });
    const refreshed = await Session.open(databases, globex.session.principal);
    const created = await exec(refreshed, 'create_one_invoice', { data: { amount: 5, status: 'paid' } });
    expect(created.status).toBe('paid');
  });

  it('keeps per-tenant roles and builders separate on the shared model', async () => {
    const role = await createRole(databases.admin, acme.workspaceId, { name: 'reader' });
    await setObjectPermission(databases.admin, role, objectIds.invoices!, { read: true });
    const { principal } = await createPrincipal(databases.admin, acme.workspaceId, { kind: 'user', name: 'Reader', roleIds: [role] });
    const reader = await Session.open(databases, principal);
    expect(reader.toolNames().filter((name) => name.endsWith('invoices') || name.endsWith('invoice')).sort()).toEqual(['find_many_invoices', 'find_one_invoice']);

    await exec(acme.session, 'save_report', { name: 'totals', definition: { source: 'invoices', columns: [{ key: 'n', aggregate: 'count' }] } });
    await expect(exec(globex.session, 'run_report', { name: 'totals' })).rejects.toThrow(/No report named/);
    expect((await exec(reader, 'run_report', { name: 'totals' })).rows[0].n).toBe(2);
  });
});

describe('both modes side by side', () => {
  it('lets an isolated workspace use its own schema while others share', async () => {
    const isolated = await provisionWorkspace(databases.admin, 'Payroll Corp');
    expect(isolated.tenancy).toBe('isolated');
    expect(isolated.schemaName).toMatch(/^ws_/);
    expect(isolated.schemaName).not.toBe(model.schemaName);

    const role = await createRole(databases.admin, isolated.id, { name: 'admin', allObjectsAccess: true, canManageSchema: true });
    const { principal } = await createPrincipal(databases.admin, isolated.id, { kind: 'api_key', name: 'payroll', roleIds: [role] });
    const session = await Session.open(databases, principal);
    expect(session.toolNames()).toContain('create_object');

    const employee = await exec(session, 'create_object', { nameSingular: 'employee', namePlural: 'employees', label: 'Employee' });
    await exec(session, 'create_field', { objectId: employee.id, name: 'salary', label: 'Salary', type: 'number' });
    await exec(await Session.open(databases, principal), 'create_one_employee', { data: { salary: 1000 } });

    const columns = await databases.admin.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'employees'",
      [isolated.schemaName],
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('workspace_id');
  });

  it('refuses to share an isolated model', async () => {
    const isolated = await provisionWorkspace(databases.admin, 'Solo');
    await expect(provisionWorkspace(databases.admin, 'Intruder', { dataModelId: isolated.dataModelId })).rejects.toThrow(/belongs to one workspace/);
  });
});
