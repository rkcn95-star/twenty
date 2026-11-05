import { serve } from '@hono/node-server';
import { connect, migrate } from '@agent-crm/core';
import { createApp } from './app.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
};

const databases = connect({ adminUrl: required('ADMIN_DATABASE_URL'), runtimeUrl: required('RUNTIME_DATABASE_URL') });
await migrate(databases.admin);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: createApp(databases, required('ADMIN_TOKEN')).fetch, port });
console.log(`agent-crm listening on :${port}`);
