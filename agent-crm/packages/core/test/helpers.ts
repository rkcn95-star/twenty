import {
  addRowPredicate, connect, createField, createObject, createPrincipal, createRole, migrate, provisionWorkspace,
  setFieldPermission, setObjectPermission, type Databases,
} from '../src/index.js';

export const databaseUrls = () => ({
  adminUrl: process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/agentcrm',
  runtimeUrl: process.env.RUNTIME_DATABASE_URL ?? 'postgres://app_runtime:app_runtime@localhost:5432/agentcrm',
});

export const resetDatabase = async (): Promise<Databases> => {
  const databases = connect(databaseUrls());
  const schemas = await databases.admin.query("SELECT nspname FROM pg_namespace WHERE nspname = 'core' OR nspname LIKE 'ws\\_%'");
  for (const { nspname } of schemas.rows) await databases.admin.query(`DROP SCHEMA "${nspname}" CASCADE`);
  await databases.admin.query('DROP TABLE IF EXISTS public.schema_migrations');
  await migrate(databases.admin);
  return databases;
};

export const seedWorkspace = async (databases: Databases, name: string) => {
  const workspace = await provisionWorkspace(databases.admin, name);
  const adminRole = await createRole(databases.admin, workspace.id, { name: 'admin', canManageSchema: true, allObjectsAccess: true });
  const admin = await createPrincipal(databases.admin, workspace.id, { kind: 'api_key', name: 'admin key', roleIds: [adminRole] });
  const deals = await createObject(databases.admin, workspace.id, { nameSingular: 'deal', namePlural: 'deals', label: 'Deal' });
  const title = await createField(databases.admin, workspace.id, deals.id, { name: 'title', label: 'Title', type: 'text' });
  const secret = await createField(databases.admin, workspace.id, deals.id, { name: 'secret', label: 'Secret', type: 'text' });
  const stage = await createField(databases.admin, workspace.id, deals.id, {
    name: 'stage', label: 'Stage', type: 'select', options: ['new', 'won', 'lost'],
  });
  return { workspace, adminRole, admin, deals, fields: { title, secret, stage } };
};

export { addRowPredicate, createPrincipal, createRole, setFieldPermission, setObjectPermission };
