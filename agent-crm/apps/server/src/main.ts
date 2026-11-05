import { serve } from '@hono/node-server';
import { connect, migrate } from '@agent-crm/core';
import pg from 'pg';
import { createApp } from './app.js';
import { createAuth } from './auth.js';
import { createMailer } from './mailer.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
};

const databases = connect({ adminUrl: required('ADMIN_DATABASE_URL'), runtimeUrl: required('RUNTIME_DATABASE_URL') });
await migrate(databases.admin);

const port = Number(process.env.PORT ?? 3000);
const appUrl = process.env.APP_URL ?? `http://localhost:${port}`;
const sendMail = createMailer(required('SMTP_URL'), process.env.MAIL_FROM ?? 'no-reply@localhost');
const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
  : undefined;
const auth = createAuth({
  pool: new pg.Pool({ connectionString: required('ADMIN_DATABASE_URL'), options: '-c search_path=core' }),
  secret: required('AUTH_SECRET'),
  baseURL: appUrl,
  sendMail,
  google,
});
serve({ fetch: createApp(databases, required('ADMIN_TOKEN'), { auth, sendMail, appUrl }).fetch, port });
console.log(`agent-crm listening on :${port}`);
