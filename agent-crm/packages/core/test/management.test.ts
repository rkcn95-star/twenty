import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Session, addPredicate, authenticate, clearFieldAccess, createDataModel, createField, createKey, createManagedRole, createObject, createPrincipal,
  createRole, deleteRole, listAuditLog, listMembers, listRoles, provisionWorkspace, removeMember, removePredicate, revokeKey, rotateKey,
  setFieldAccess, setObjectAccess, setPrincipalRoles, updateRole, type Databases,
} from '../src/index.js';
import { resetDatabase } from './helpers.js';

let databases: Databases;
const exec = <TResult = any>(session: Session, tool: string, args: unknown) => session.execute(tool, args) as Promise<TResult>;

type Tenant = { workspaceId: string; dataModelId: string; adminRole: string; adminPrincipal: string; admin: Session; deals?: string; title?: string; secret?: string };

const newTenant = async (name: string, dataModelId?: string): Promise<Tenant> => {
  const workspace = await provisionWorkspace(databases.admin, name, dataModelId ? { dataModelId } : {});
  const adminRole = await createRole(databases.admin, workspace.id, { name: 'admin', canManageSchema: !dataModelId, canManageAccess: true, allObjectsAccess: true });
  const { principal } = await createPrincipal(databases.admin, workspace.id, { kind: 'api_key', name: `${name} admin`, roleIds: [adminRole] });
  return { workspaceId: workspace.id, dataModelId: workspace.dataModelId, adminRole, adminPrincipal: principal.id, admin: await Session.open(databases, principal) };
};

const addDeals = async (tenant: Tenant) => {
  const deals = await createObject(databases.admin, tenant.dataModelId, { nameSingular: 'deal', namePlural: 'deals', label: 'Deal' });
  tenant.title = (await createField(databases.admin, tenant.dataModelId, deals.id, { name: 'title', label: 'Title', type: 'text' })).id;
  tenant.secret = (await createField(databases.admin, tenant.dataModelId, deals.id, { name: 'secret', label: 'Secret', type: 'text' })).id;
  tenant.deals = deals.id;
  tenant.admin = await Session.open(databases, tenant.admin.principal);
};

let a: Tenant;
let b: Tenant;

beforeAll(async () => {
  databases = await resetDatabase();
  a = await newTenant('A');
  b = await newTenant('B');
  await addDeals(a);
  await addDeals(b);
});

afterAll(async () => {
  await databases.close();
});

describe('roles and permissions', () => {
  it('creates, updates, lists and deletes roles', async () => {
    const { id } = await createManagedRole(databases.admin, a.workspaceId, { name: 'sales' });
    await expect(createManagedRole(databases.admin, a.workspaceId, { name: 'sales' })).rejects.toThrow(/already exists/);
    await updateRole(databases.admin, a.workspaceId, id, { name: 'sales team', canBypassAuth: true });
    const role = (await listRoles(databases.admin, a.workspaceId)).find((candidate) => candidate.id === id);
    expect(role).toMatchObject({ name: 'sales team', canBypassAuth: true, canManageAccess: false });
    await deleteRole(databases.admin, a.workspaceId, id);
    expect((await listRoles(databases.admin, a.workspaceId)).some((candidate) => candidate.id === id)).toBe(false);
  });

  it('never touches another workspace, even with a valid id', async () => {
    const aRole = (await createManagedRole(databases.admin, a.workspaceId, { name: 'a-only' })).id;
    const bRole = (await createManagedRole(databases.admin, b.workspaceId, { name: 'b-only' })).id;
    await expect(updateRole(databases.admin, a.workspaceId, bRole, { name: 'hijack' })).rejects.toThrow(/Role not found/);
    await expect(deleteRole(databases.admin, a.workspaceId, bRole)).rejects.toThrow(/Role not found/);
    await expect(setObjectAccess(databases.admin, a.workspaceId, aRole, b.deals!, { read: true })).rejects.toThrow(/Object not found/);
    await expect(setFieldAccess(databases.admin, a.workspaceId, aRole, b.title!, { read: true, write: true })).rejects.toThrow(/Field not found/);
    await expect(setObjectAccess(databases.admin, a.workspaceId, bRole, a.deals!, { read: true })).rejects.toThrow(/Role not found/);
    const principal = (await listMembers(databases.admin, b.workspaceId))[0]!.id;
    await expect(setPrincipalRoles(databases.admin, a.workspaceId, principal, [aRole])).rejects.toThrow(/Member not found/);
    await expect(setPrincipalRoles(databases.admin, a.workspaceId, a.adminPrincipal, [aRole, bRole])).rejects.toThrow(/do not exist/);
  });

  it('applies object, field and row rules from the management calls', async () => {
    const role = (await createManagedRole(databases.admin, a.workspaceId, { name: 'rep' })).id;
    await setObjectAccess(databases.admin, a.workspaceId, role, a.deals!, { read: true, create: true });
    await setFieldAccess(databases.admin, a.workspaceId, role, a.secret!, { read: false, write: true });
    const rep = await createKey(databases.admin, a.workspaceId, { kind: 'api_key', name: 'rep key', roleIds: [role] });
    const session = await Session.open(databases, await authenticate(databases.admin, rep.apiKey));

    const created = await exec(session, 'create_one_deal', { data: { title: 'mine' } });
    await exec(a.admin, 'create_one_deal', { data: { title: 'theirs', secret: 's3cret' } });
    expect((await exec(session, 'find_many_deals', {})).total).toBe(2);
    expect(created).not.toHaveProperty('secret');
    await expect(exec(session, 'create_one_deal', { data: { title: 'x', secret: 'y' } })).rejects.toThrow();

    const predicate = await addPredicate(databases.admin, a.workspaceId, role, { objectId: a.deals!, fieldName: 'created_by', operator: 'eq', value: '$principal' });
    const restricted = await Session.open(databases, session.principal);
    expect((await exec(restricted, 'find_many_deals', {})).total).toBe(1);
    await removePredicate(databases.admin, a.workspaceId, role, predicate.id);
    await expect(removePredicate(databases.admin, a.workspaceId, role, predicate.id)).rejects.toThrow(/not found/);
    expect((await exec(await Session.open(databases, session.principal), 'find_many_deals', {})).total).toBe(2);

    await clearFieldAccess(databases.admin, a.workspaceId, role, a.secret!);
    const stored = (await listRoles(databases.admin, a.workspaceId)).find((candidate) => candidate.id === role)!;
    expect(stored.fields).toEqual([]);
  });

  it('validates predicates', async () => {
    const role = (await createManagedRole(databases.admin, a.workspaceId, { name: 'strict' })).id;
    const add = (input: object) => addPredicate(databases.admin, a.workspaceId, role, { objectId: a.deals!, fieldName: 'title', operator: 'eq', value: 'x', ...input });
    await expect(add({ fieldName: 'nope' })).rejects.toThrow(/Unknown field/);
    await expect(add({ operator: 'contains' })).rejects.toThrow(/Unknown operator/);
    await expect(add({ value: { a: 1 } })).rejects.toThrow(/single value/);
    await expect(add({ operator: 'in', value: [] })).rejects.toThrow(/needs 1 to/);
    await expect(add({ operator: 'is_null', value: 'yes' })).rejects.toThrow(/true or false/);
    await expect(add({ objectId: b.deals })).rejects.toThrow(/Object not found/);
    expect((await add({ operator: 'is_null', value: true })).id).toBeTruthy();
  });

  it('shares objects but not roles across tenants of a shared model', async () => {
    const model = await createDataModel(databases.admin, 'shared', 'shared');
    const one = await newTenant('one', model.id);
    const two = await newTenant('two', model.id);
    const invoices = await createObject(databases.admin, model.id, { nameSingular: 'invoice', namePlural: 'invoices', label: 'Invoice' });
    const roleOne = (await createManagedRole(databases.admin, one.workspaceId, { name: 'billing' })).id;
    await setObjectAccess(databases.admin, one.workspaceId, roleOne, invoices.id, { read: true });
    await expect(setObjectAccess(databases.admin, two.workspaceId, roleOne, invoices.id, { read: true })).rejects.toThrow(/Role not found/);
  });
});

describe('last admin protection', () => {
  it('refuses any change that would leave a workspace without an admin', async () => {
    const t = await newTenant('guarded');
    await expect(deleteRole(databases.admin, t.workspaceId, t.adminRole)).rejects.toThrow(/at least one admin/);
    await expect(updateRole(databases.admin, t.workspaceId, t.adminRole, { canManageAccess: false })).rejects.toThrow(/at least one admin/);
    await expect(setPrincipalRoles(databases.admin, t.workspaceId, t.adminPrincipal, [])).rejects.toThrow(/at least one admin/);
    await expect(removeMember(databases.admin, t.workspaceId, t.adminPrincipal)).rejects.toThrow(/at least one admin/);
    expect((await listRoles(databases.admin, t.workspaceId)).some((role) => role.id === t.adminRole)).toBe(true);

    const second = await createKey(databases.admin, t.workspaceId, { kind: 'api_key', name: 'second', roleIds: [t.adminRole] });
    await removeMember(databases.admin, t.workspaceId, t.adminPrincipal);
    await expect(revokeKey(databases.admin, t.workspaceId, second.principalId)).rejects.toThrow(/at least one admin/);
    await expect(rotateKey(databases.admin, t.workspaceId, second.principalId, new Date(Date.now() - 1000))).rejects.toThrow(/at least one admin/);
    await expect(removeMember(databases.admin, t.workspaceId, second.principalId)).rejects.toThrow(/at least one admin/);
    expect((await authenticate(databases.admin, second.apiKey)).id).toBe(second.principalId);
  });

  it('does not count revoked keys as admins', async () => {
    const t = await newTenant('revoked');
    const other = await createKey(databases.admin, t.workspaceId, { kind: 'api_key', name: 'other', roleIds: [t.adminRole] });
    await revokeKey(databases.admin, t.workspaceId, other.principalId);
    await expect(removeMember(databases.admin, t.workspaceId, t.adminPrincipal)).rejects.toThrow(/at least one admin/);
  });
});

describe('keys, members and audit', () => {
  it('returns a key secret once and never lists it', async () => {
    const role = (await createManagedRole(databases.admin, a.workspaceId, { name: 'keyed', allObjectsAccess: true })).id;
    await expect(createKey(databases.admin, a.workspaceId, { kind: 'api_key', name: 'k', roleIds: [] })).rejects.toThrow(/at least one role/);
    await expect(createKey(databases.admin, a.workspaceId, { kind: 'api_key', name: 'k', roleIds: [role], expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/future/);
    const key = await createKey(databases.admin, a.workspaceId, { kind: 'agent', name: 'bot', roleIds: [role], expiresAt: new Date(Date.now() + 60_000) });
    expect(key.apiKey).toMatch(/^ak_/);
    const members = await listMembers(databases.admin, a.workspaceId);
    expect(JSON.stringify(members)).not.toContain(key.apiKey);
    expect(members.find((member) => member.id === key.principalId)).toMatchObject({ kind: 'agent', roleIds: [role] });

    const rotated = await rotateKey(databases.admin, a.workspaceId, key.principalId);
    await expect(authenticate(databases.admin, key.apiKey)).rejects.toThrow();
    expect((await authenticate(databases.admin, rotated)).id).toBe(key.principalId);
    await expect(rotateKey(databases.admin, b.workspaceId, key.principalId)).rejects.toThrow(/not found/);
  });

  it('lists the audit log newest first with filters and paging', async () => {
    const t = await newTenant('audited');
    await addDeals(t);
    for (let index = 0; index < 5; index += 1) await exec(t.admin, 'create_one_deal', { data: { title: `d${index}` } });
    await exec(t.admin, 'create_one_deal', { data: { nope: 1 } }).catch(() => undefined);

    const firstPage = await listAuditLog(databases.admin, t.workspaceId, { limit: 3 });
    expect(firstPage.entries).toHaveLength(3);
    expect(firstPage.entries[0]!.id).toBeGreaterThan(firstPage.entries[1]!.id);
    const secondPage = await listAuditLog(databases.admin, t.workspaceId, { limit: 3, before: firstPage.nextBefore! });
    expect(secondPage.entries[0]!.id).toBeLessThan(firstPage.entries[2]!.id);

    const failures = await listAuditLog(databases.admin, t.workspaceId, { outcome: 'error' });
    expect(failures.entries.every((entry) => entry.outcome === 'error')).toBe(true);
    expect(failures.entries.length).toBe(1);
    expect((await listAuditLog(databases.admin, a.workspaceId, { tool: 'create_one_deal', outcome: 'ok' })).entries.every((entry) => entry.principalId !== t.adminPrincipal)).toBe(true);
  });
});

describe('access tools for agents', () => {
  it('are offered only with manage-access rights and never include key secrets', async () => {
    const t = await newTenant('tools');
    await addDeals(t);
    const names = t.admin.toolNames();
    for (const tool of ['list_roles', 'create_role', 'set_object_access', 'add_row_predicate', 'set_member_roles', 'list_audit_log']) expect(names).toContain(tool);
    expect(names.filter((name) => /key/.test(name))).toEqual([]);

    const plain = await createManagedRole(databases.admin, t.workspaceId, { name: 'plain', allObjectsAccess: true });
    const key = await createKey(databases.admin, t.workspaceId, { kind: 'api_key', name: 'plain key', roleIds: [plain.id] });
    const plainSession = await Session.open(databases, await authenticate(databases.admin, key.apiKey));
    expect(plainSession.toolNames().filter((name) => ['list_roles', 'create_role', 'list_members'].includes(name))).toEqual([]);

    const role = await exec(t.admin, 'create_role', { name: 'via agent' });
    await exec(t.admin, 'set_object_access', { roleId: role.id, objectId: t.deals, read: true });
    const member = await createKey(databases.admin, t.workspaceId, { kind: 'api_key', name: 'granted', roleIds: [role.id] });
    const granted = await Session.open(databases, await authenticate(databases.admin, member.apiKey));
    expect(granted.toolNames().filter((name) => name.endsWith('deals') || name.endsWith('deal')).sort()).toEqual(['find_many_deals', 'find_one_deal']);
    expect(JSON.stringify(await exec(t.admin, 'list_members', {}))).not.toContain(member.apiKey);
  });

  it('narrows an agent to the intersection, so it cannot manage access for a user who cannot', async () => {
    const t = await newTenant('delegated');
    const reader = (await createManagedRole(databases.admin, t.workspaceId, { name: 'reader' })).id;
    const user = (await createPrincipal(databases.admin, t.workspaceId, { kind: 'user', name: 'Ula', roleIds: [reader] })).principal;
    const delegated = await Session.open(databases, t.admin.principal, user.id);
    expect(delegated.toolNames()).not.toContain('create_role');
  });
});
