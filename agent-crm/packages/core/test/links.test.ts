import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Session, addRowPredicate, authenticate, createDataModel, createField, createObject, createPrincipal, createRole, provisionWorkspace,
  revokeKey, rotateKey, setObjectPermission, type Databases, type Principal,
} from '../src/index.js';
import { resetDatabase } from './helpers.js';

let databases: Databases;

const exec = <TResult = any>(session: Session, tool: string, args: unknown) => session.execute(tool, args) as Promise<TResult>;

type Setup = { dataModelId: string; workspaceId: string; admin: Session; ids: Record<string, string>; schemaName: string; otherAdmin?: Session };

const buildModel = async (dataModelId: string) => {
  const tags = await createObject(databases.admin, dataModelId, { nameSingular: 'tag', namePlural: 'tags', label: 'Tag' });
  const deals = await createObject(databases.admin, dataModelId, { nameSingular: 'deal', namePlural: 'deals', label: 'Deal' });
  await createField(databases.admin, dataModelId, tags.id, { name: 'name', label: 'Name', type: 'text' });
  await createField(databases.admin, dataModelId, deals.id, { name: 'title', label: 'Title', type: 'text' });
  await createField(databases.admin, dataModelId, deals.id, { name: 'tags', label: 'Tags', type: 'many_to_many', relationObjectId: tags.id });
  return { tags: tags.id, deals: deals.id };
};

const adminFor = async (workspaceId: string) => {
  const role = await createRole(databases.admin, workspaceId, { name: 'admin', allObjectsAccess: true, canManageSchema: true });
  const { principal } = await createPrincipal(databases.admin, workspaceId, { kind: 'api_key', name: 'admin', roleIds: [role] });
  return Session.open(databases, principal);
};

const makeUser = async (workspaceId: string, name: string, setup: (roleId: string) => Promise<void>) => {
  const role = await createRole(databases.admin, workspaceId, { name });
  await setup(role);
  const { principal } = await createPrincipal(databases.admin, workspaceId, { kind: 'user', name, roleIds: [role] });
  return Session.open(databases, principal as Principal);
};

const setups: Record<'isolated' | 'shared', Setup> = {} as never;

beforeAll(async () => {
  databases = await resetDatabase();
  const isolated = await provisionWorkspace(databases.admin, 'isolated');
  setups.isolated = {
    dataModelId: isolated.dataModelId, workspaceId: isolated.id, schemaName: isolated.schemaName,
    ids: await buildModel(isolated.dataModelId), admin: await adminFor(isolated.id),
  };
  const model = await createDataModel(databases.admin, 'shared', 'shared');
  const first = await provisionWorkspace(databases.admin, 'first', { dataModelId: model.id });
  const second = await provisionWorkspace(databases.admin, 'second', { dataModelId: model.id });
  setups.shared = {
    dataModelId: model.id, workspaceId: first.id, schemaName: model.schemaName,
    ids: await buildModel(model.id), admin: await adminFor(first.id), otherAdmin: await adminFor(second.id),
  };
});

afterAll(async () => {
  await databases.close();
});

describe.each(['isolated', 'shared'] as const)('many-to-many in %s mode', (mode) => {
  const setup = () => setups[mode];
  const link = (args: object) => ({ object: 'deals', field: 'tags', ...args });
  const names = (result: { records: { name: string }[] }) => result.records.map((record) => record.name).sort();

  it('adds, lists, removes and replaces links idempotently', async () => {
    const { admin } = setup();
    const deal = await exec(admin, 'create_one_deal', { data: { title: 'D' } });
    const [red, green, blue] = await Promise.all(['red', 'green', 'blue'].map((name) => exec(admin, 'create_one_tag', { data: { name } })));

    await exec(admin, 'add_links', link({ id: deal.id, targetIds: [red.id, green.id] }));
    expect((await exec(admin, 'add_links', link({ id: deal.id, targetIds: [red.id] }))).links).toBe(2);
    expect(names(await exec(admin, 'list_links', link({ id: deal.id })))).toEqual(['green', 'red']);

    await exec(admin, 'remove_links', link({ id: deal.id, targetIds: [red.id] }));
    expect(names(await exec(admin, 'list_links', link({ id: deal.id })))).toEqual(['green']);

    await exec(admin, 'set_links', link({ id: deal.id, targetIds: [blue.id] }));
    expect(names(await exec(admin, 'list_links', link({ id: deal.id })))).toEqual(['blue']);

    await exec(admin, 'delete_one_tag', { id: blue.id });
    expect(names(await exec(admin, 'list_links', link({ id: deal.id })))).toEqual([]);
  });

  it('rejects unknown targets, wrong fields and many-to-many values on records', async () => {
    const { admin } = setup();
    const deal = await exec(admin, 'create_one_deal', { data: { title: 'E' } });
    await expect(exec(admin, 'add_links', link({ id: deal.id, targetIds: ['00000000-0000-4000-8000-000000000000'] }))).rejects.toThrow(/do not exist/);
    await expect(exec(admin, 'list_links', { object: 'deals', field: 'title', id: deal.id })).rejects.toThrow(/not a many-to-many/);
    await expect(exec(admin, 'create_one_deal', { data: { title: 'x', tags: [] } })).rejects.toThrow();
  });

  it('joins across the link in reports', async () => {
    const { admin } = setup();
    const tag = await exec(admin, 'create_one_tag', { data: { name: 'reported' } });
    for (const title of ['R1', 'R2']) {
      const deal = await exec(admin, 'create_one_deal', { data: { title } });
      await exec(admin, 'add_links', link({ id: deal.id, targetIds: [tag.id] }));
    }
    const result = await exec(admin, 'run_report', {
      definition: {
        source: 'deals',
        joins: [{ alias: 't', field: 'tags' }],
        columns: [{ key: 'tag', ref: { alias: 't', field: 'name' } }, { key: 'deals', aggregate: 'count_distinct', ref: { field: 'id' } }],
        orderBy: [{ key: 'tag' }],
      },
    });
    const byTag = Object.fromEntries(result.rows.map((row: { tag: string | null; deals: number }) => [row.tag, row.deals]));
    expect(byTag.reported).toBe(2);
    await expect(
      exec(admin, 'run_report', { definition: { source: 'deals', columns: [{ key: 'x', ref: { field: 'tags' } }] } }),
    ).rejects.toThrow(/many-to-many/);
  });

  it('enforces update rights, target read rights and target row rules', async () => {
    const { admin, workspaceId, ids } = setup();
    const deal = await exec(admin, 'create_one_deal', { data: { title: 'P' } });
    const visible = await exec(admin, 'create_one_tag', { data: { name: 'visible' } });
    const hidden = await exec(admin, 'create_one_tag', { data: { name: 'secret' } });
    await exec(admin, 'add_links', link({ id: deal.id, targetIds: [visible.id, hidden.id] }));

    const reader = await makeUser(workspaceId, `reader_${mode}`, async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true });
      await setObjectPermission(databases.admin, roleId, ids.tags!, { read: true });
      await addRowPredicate(databases.admin, roleId, ids.tags!, { fieldName: 'name', operator: 'eq', value: 'visible' });
    });
    expect(names(await exec(reader, 'list_links', link({ id: deal.id })))).toEqual(['visible']);
    expect(reader.toolNames()).not.toContain('add_links');
    await expect(exec(reader, 'add_links', link({ id: deal.id, targetIds: [visible.id] }))).rejects.toThrow(/not available/);

    const writer = await makeUser(workspaceId, `writer_${mode}`, async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true, update: true });
      await setObjectPermission(databases.admin, roleId, ids.tags!, { read: true });
      await addRowPredicate(databases.admin, roleId, ids.tags!, { fieldName: 'name', operator: 'eq', value: 'visible' });
    });
    await expect(exec(writer, 'add_links', link({ id: deal.id, targetIds: [hidden.id] }))).rejects.toThrow(/do not exist/);

    const noTags = await makeUser(workspaceId, `notags_${mode}`, async (roleId) => {
      await setObjectPermission(databases.admin, roleId, ids.deals!, { read: true });
    });
    await expect(exec(noTags, 'list_links', link({ id: deal.id }))).rejects.toThrow(/No read access/);
  });
});

describe('tenant separation of links in shared mode', () => {
  it("cannot link to or read another tenant's records", async () => {
    const { admin, otherAdmin } = setups.shared;
    const mine = await exec(admin, 'create_one_deal', { data: { title: 'Mine' } });
    const theirTag = await exec(otherAdmin!, 'create_one_tag', { data: { name: 'theirs' } });
    await expect(exec(admin, 'add_links', { object: 'deals', field: 'tags', id: mine.id, targetIds: [theirTag.id] })).rejects.toThrow(/do not exist/);

    const theirDeal = await exec(otherAdmin!, 'create_one_deal', { data: { title: 'Theirs' } });
    await exec(otherAdmin!, 'add_links', { object: 'deals', field: 'tags', id: theirDeal.id, targetIds: [theirTag.id] });
    await expect(exec(admin, 'list_links', { object: 'deals', field: 'tags', id: theirDeal.id })).rejects.toThrow(/not found/);

    const field = admin.metadata.objects.find((object) => object.namePlural === 'deals')!.fields.find((candidate) => candidate.name === 'tags')!;
    const junction = `"${setups.shared.schemaName}"."jn_${field.id.replaceAll('-', '')}"`;
    const client = await databases.runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true), set_config('app.read_objects', $2, true)", [
        setups.shared.workspaceId, `${setups.shared.ids.deals},${setups.shared.ids.tags}`,
      ]);
      const rows = await client.query(`SELECT source_id FROM ${junction}`);
      expect(rows.rows.some((row) => row.source_id === theirDeal.id)).toBe(false);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('API key lifecycle for machine clients', () => {
  it('honours expiry, revocation and rotation', async () => {
    const { workspaceId } = setups.isolated;
    const role = await createRole(databases.admin, workspaceId, { name: 'm2m', allObjectsAccess: true });

    const expired = await createPrincipal(databases.admin, workspaceId, { kind: 'api_key', name: 'old', roleIds: [role], expiresAt: new Date(Date.now() - 1000) });
    await expect(authenticate(databases.admin, expired.apiKey!)).rejects.toThrow(/Invalid API key/);

    const live = await createPrincipal(databases.admin, workspaceId, { kind: 'api_key', name: 'live', roleIds: [role], expiresAt: new Date(Date.now() + 60_000) });
    expect((await authenticate(databases.admin, live.apiKey!)).id).toBe(live.principal.id);

    await revokeKey(databases.admin, workspaceId, live.principal.id);
    await expect(authenticate(databases.admin, live.apiKey!)).rejects.toThrow(/Invalid API key/);

    const rotated = await rotateKey(databases.admin, workspaceId, live.principal.id);
    await expect(authenticate(databases.admin, live.apiKey!)).rejects.toThrow(/Invalid API key/);
    expect((await authenticate(databases.admin, rotated)).id).toBe(live.principal.id);
    await expect(revokeKey(databases.admin, setups.shared.workspaceId, live.principal.id)).rejects.toThrow(/not found/);
  });
});
