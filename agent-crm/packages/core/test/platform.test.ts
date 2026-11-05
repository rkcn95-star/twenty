import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session, createField, type Databases } from '../src/index.js';
import {
  addRowPredicate, createPrincipal, createRole, resetDatabase, seedWorkspace, setFieldPermission, setObjectPermission,
} from './helpers.js';

let databases: Databases;
let a: Awaited<ReturnType<typeof seedWorkspace>>;
let b: Awaited<ReturnType<typeof seedWorkspace>>;

const adminSession = (seed: typeof a) => Session.open(databases, seed.admin.principal);

beforeAll(async () => {
  databases = await resetDatabase();
  a = await seedWorkspace(databases, 'A');
  b = await seedWorkspace(databases, 'B');
});

afterAll(async () => {
  await databases.close();
});

describe('RLS isolation (runtime role, raw SQL)', () => {
  const tableOfA = () => `"${a.workspace.schemaName}"."deals"`;

  const asRuntime = async (settings: Record<string, string>, sql: string) => {
    const client = await databases.runtime.connect();
    try {
      await client.query('BEGIN');
      for (const [name, value] of Object.entries(settings)) await client.query('SELECT set_config($1, $2, true)', [name, value]);
      const result = await client.query(sql);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  it('sees rows with the right workspace and object grant', async () => {
    const session = await adminSession(a);
    await session.execute('create_one_deal', { data: { title: 'Acme' } });
    const settings = { 'app.workspace_id': a.workspace.id, 'app.read_objects': a.deals.id };
    expect((await asRuntime(settings, `SELECT * FROM ${tableOfA()}`)).rowCount).toBe(1);
  });

  it('returns nothing when the session claims another workspace', async () => {
    const settings = { 'app.workspace_id': b.workspace.id, 'app.read_objects': a.deals.id };
    expect((await asRuntime(settings, `SELECT * FROM ${tableOfA()}`)).rowCount).toBe(0);
  });

  it('returns nothing without an object read grant, or with no settings at all', async () => {
    expect((await asRuntime({ 'app.workspace_id': a.workspace.id }, `SELECT * FROM ${tableOfA()}`)).rowCount).toBe(0);
    expect((await asRuntime({}, `SELECT * FROM ${tableOfA()}`)).rowCount).toBe(0);
  });

  it('rejects writes without a write grant', async () => {
    const settings = { 'app.workspace_id': a.workspace.id, 'app.read_objects': a.deals.id };
    await expect(asRuntime(settings, `INSERT INTO ${tableOfA()} DEFAULT VALUES`)).rejects.toThrow(/row-level security/);
  });
});

describe('RBAC through the tool layer', () => {
  it('limits tools, hides fields and refuses writes for a read-only role', async () => {
    const role = await createRole(databases.admin, a.workspace.id, { name: 'viewer' });
    await setObjectPermission(databases.admin, role, a.deals.id, { read: true });
    await setFieldPermission(databases.admin, role, a.fields.secret.id, { read: false, write: false });
    const { principal } = await createPrincipal(databases.admin, a.workspace.id, { kind: 'user', name: 'Vera', roleIds: [role] });

    const admin = await adminSession(a);
    await admin.execute('create_one_deal', { data: { title: 'Visible', secret: 'hunter2' } });

    const session = await Session.open(databases, principal);
    expect(session.toolNames().sort()).toEqual(['find_many_deals', 'find_one_deal']);
    const found = (await session.execute('find_many_deals', { filter: { title: 'Visible' } })) as { records: Record<string, unknown>[] };
    expect(found.records).toHaveLength(1);
    expect(found.records[0]).not.toHaveProperty('secret');
    await expect(session.execute('create_one_deal', { data: { title: 'x' } })).rejects.toThrow(/not available/);
    await expect(session.execute('find_many_deals', { filter: { secret: 'hunter2' } })).rejects.toThrow();
    expect(session.objectMetadata()[0]?.fields.map((field) => field.name)).not.toContain('secret');
  });

  it('applies row predicates to reads and updates', async () => {
    const role = await createRole(databases.admin, a.workspace.id, { name: 'sales' });
    await setObjectPermission(databases.admin, role, a.deals.id, { read: true, create: true, update: true });
    await addRowPredicate(databases.admin, role, a.deals.id, { fieldName: 'created_by', operator: 'eq', value: '$principal' });
    const alice = (await createPrincipal(databases.admin, a.workspace.id, { kind: 'user', name: 'Alice', roleIds: [role] })).principal;
    const bob = (await createPrincipal(databases.admin, a.workspace.id, { kind: 'user', name: 'Bob', roleIds: [role] })).principal;

    const aliceSession = await Session.open(databases, alice);
    const bobSession = await Session.open(databases, bob);
    const created = (await aliceSession.execute('create_one_deal', { data: { title: 'Alice deal', stage: 'new' } })) as { id: string };

    const bobView = (await bobSession.execute('find_many_deals', {})) as { records: { id: string }[] };
    expect(bobView.records.find((record) => record.id === created.id)).toBeUndefined();
    await expect(bobSession.execute('update_one_deal', { id: created.id, data: { stage: 'won' } })).rejects.toThrow(/not found/);
    const updated = (await aliceSession.execute('update_one_deal', { id: created.id, data: { stage: 'won' } })) as { stage: string };
    expect(updated.stage).toBe('won');
  });

  it('gives an agent the intersection of its role and the invoking user', async () => {
    const readRole = await createRole(databases.admin, a.workspace.id, { name: 'reader' });
    await setObjectPermission(databases.admin, readRole, a.deals.id, { read: true });
    const user = (await createPrincipal(databases.admin, a.workspace.id, { kind: 'user', name: 'Uma', roleIds: [readRole] })).principal;
    const fullRole = await createRole(databases.admin, a.workspace.id, { name: 'agent-full', allObjectsAccess: true, canManageSchema: true });
    const agent = (await createPrincipal(databases.admin, a.workspace.id, { kind: 'agent', name: 'Bot', roleIds: [fullRole] })).principal;

    expect((await Session.open(databases, agent)).toolNames()).toContain('create_one_deal');
    const delegated = await Session.open(databases, agent, user.id);
    expect(delegated.toolNames().sort()).toEqual(['find_many_deals', 'find_one_deal']);
  });
});

describe('schema runner and validation', () => {
  it('rejects unsafe identifiers', async () => {
    const session = await adminSession(a);
    await expect(session.execute('create_object', { nameSingular: 'x"; DROP', namePlural: 'xs', label: 'X' })).rejects.toThrow(/Invalid/);
    await expect(session.execute('create_object', { nameSingular: 'select', namePlural: 'selects', label: 'S' })).rejects.toThrow(/Invalid/);
  });

  it('enforces select options at the tool and database level', async () => {
    const session = await adminSession(a);
    await expect(session.execute('create_one_deal', { data: { stage: 'nonsense' } })).rejects.toThrow();
    const client = await databases.admin.connect();
    try {
      await expect(
        client.query(`INSERT INTO "${a.workspace.schemaName}"."deals" (stage) VALUES ('nonsense')`),
      ).rejects.toThrow(/check constraint/);
    } finally {
      client.release();
    }
  });

  it('exposes new objects and fields as tools after a metadata change, with a relation', async () => {
    const created = (await (await adminSession(a)).execute('create_object', { nameSingular: 'task', namePlural: 'tasks', label: 'Task' })) as { id: string };
    await createField(databases.admin, a.workspace.id, created.id, { name: 'deal', label: 'Deal', type: 'relation', relationObjectId: a.deals.id });
    const session = await adminSession(a);
    expect(session.toolNames()).toContain('create_one_task');
    const deal = (await session.execute('create_one_deal', { data: { title: 'Linked' } })) as { id: string };
    const task = (await session.execute('create_one_task', { data: { deal: deal.id } })) as { deal: string };
    expect(task.deal).toBe(deal.id);
  });

  it('keeps workspaces separate in metadata and tools', async () => {
    expect((await adminSession(b)).toolNames()).not.toContain('create_one_task');
  });

  it('writes an audit row for successes and failures', async () => {
    const session = await adminSession(a);
    await session.execute('find_many_deals', {}).catch(() => undefined);
    await session.execute('delete_one_nothing', {}).catch(() => undefined);
    const rows = await databases.admin.query("SELECT outcome FROM core.audit_log WHERE workspace_id = $1 AND tool = ANY($2)", [
      a.workspace.id,
      ['find_many_deals', 'delete_one_nothing'],
    ]);
    expect(rows.rows.map((row) => row.outcome)).toEqual(expect.arrayContaining(['ok', 'error']));
  });
});
