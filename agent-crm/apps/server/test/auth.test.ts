import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { SMTPServer } from 'smtp-server';
import { connect, createRole, migrate, type Databases } from '@agent-crm/core';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { createMailer } from '../src/mailer.js';

const ADMIN_TOKEN = 'test-admin-token';
const ORIGIN = 'http://localhost:3000';
const adminUrl = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/agentcrm';
const runtimeUrl = process.env.RUNTIME_DATABASE_URL ?? 'postgres://app_runtime:app_runtime@localhost:5432/agentcrm';
const run = Date.now();

let databases: Databases;
let authPool: pg.Pool;
let smtp: SMTPServer;
let app: ReturnType<typeof createApp>;
const inbox: { to: string; body: string }[] = [];

const decodeQuotedPrintable = (text: string) =>
  text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

const lastMailTo = (email: string) => {
  const mail = [...inbox].reverse().find((entry) => entry.to === email);
  if (!mail) throw new Error(`No mail for ${email}`);
  return mail.body;
};

const cookieOf = (response: Response) =>
  response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');

const request = (path: string, init: { method?: string; cookie?: string; workspaceId?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.request(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.workspaceId ? { 'x-workspace-id': init.workspaceId } : {}),
      ...init.headers,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

const signUpAndVerify = async (email: string, name: string) => {
  const password = 'correct-horse-battery';
  const signUp = await request('/api/auth/sign-up/email', { body: { email, password, name } });
  expect(signUp.status).toBe(200);
  const link = lastMailTo(email).match(/https?:\/\/\S+verify-email\S+/)?.[0];
  expect(link).toBeTruthy();
  const verified = await app.request(new URL(link!).pathname + new URL(link!).search, { headers: { origin: ORIGIN } });
  return { password, cookie: cookieOf(verified), verifyStatus: verified.status };
};

const signIn = async (email: string, password: string) => {
  const response = await request('/api/auth/sign-in/email', { body: { email, password } });
  return { status: response.status, cookie: cookieOf(response) };
};

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, done) {
      let data = '';
      stream.on('data', (chunk) => (data += chunk));
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo[0]!.address, body: decodeQuotedPrintable(data) });
        done();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const smtpPort = (smtp.server.address() as { port: number }).port;

  databases = connect({ adminUrl, runtimeUrl });
  await migrate(databases.admin);
  authPool = new pg.Pool({ connectionString: adminUrl, options: '-c search_path=core' });
  const sendMail = createMailer(`smtp://127.0.0.1:${smtpPort}`, 'no-reply@test.local');
  const auth = createAuth({ pool: authPool, secret: 'test-secret-test-secret-test-secret', baseURL: ORIGIN, sendMail });
  app = createApp(databases, ADMIN_TOKEN, { auth, sendMail, appUrl: ORIGIN });
});

afterAll(async () => {
  await authPool.end();
  await databases.close();
  await new Promise((resolve) => smtp.close(resolve));
});

const alice = `alice+${run}@example.com`;
const bob = `bob+${run}@example.com`;
let aliceCookie: string;
let workspaceId: string;

describe('email and password with verification', () => {
  it('refuses sign-in until the email is verified, then signs the user in', async () => {
    const password = 'correct-horse-battery';
    expect((await request('/api/auth/sign-up/email', { body: { email: alice, password, name: 'Alice' } })).status).toBe(200);
    expect((await signIn(alice, password)).status).toBe(403);

    const link = lastMailTo(alice).match(/https?:\/\/\S+verify-email\S+/)![0];
    const verified = await app.request(new URL(link).pathname + new URL(link).search, { headers: { origin: ORIGIN } });
    expect(verified.status).toBeLessThan(400);

    const signedIn = await signIn(alice, password);
    expect(signedIn.status).toBe(200);
    aliceCookie = signedIn.cookie;
    expect((await request('/api/auth/sign-in/email', { body: { email: alice, password: 'wrong-password-123' } })).status).toBe(401);
  });

  it('rejects weak passwords', async () => {
    const response = await request('/api/auth/sign-up/email', { body: { email: `weak+${run}@example.com`, password: 'short', name: 'Weak' } });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('records the sign-in method on the session', async () => {
    const rows = await databases.admin.query(
      'SELECT s."authMethod" FROM core.session s JOIN core."user" u ON u.id = s."userId" WHERE u.email = $1',
      [alice],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((row) => row.authMethod === 'password')).toBe(true);
  });
});

describe('workspaces and membership', () => {
  it('needs a session to create a workspace, and lists memberships', async () => {
    expect((await request('/v1/workspaces', { body: { name: 'Nope' } })).status).toBe(403);
    const created = await request('/v1/workspaces', { cookie: aliceCookie, body: { name: 'Alice Co' } });
    expect(created.status).toBe(201);
    workspaceId = ((await created.json()) as { workspaceId: string }).workspaceId;
    const me = (await (await request('/v1/me', { cookie: aliceCookie })).json()) as { workspaces: { workspaceId: string }[] };
    expect(me.workspaces.map((workspace) => workspace.workspaceId)).toEqual([workspaceId]);
  });

  it('acts inside a workspace only with an explicit workspace id and membership', async () => {
    const call = (workspace?: string) => request('/v1/tools/list_definitions', { cookie: aliceCookie, workspaceId: workspace, body: {} });
    expect((await call(workspaceId)).status).toBe(200);
    expect((await call()).status).toBe(400);
    expect((await call('11111111-1111-4111-8111-111111111111')).status).toBe(403);
  });
});

describe('workspace-specific sign-in methods', () => {
  it('lets only bypass-capable admins in after password sign-in is switched off', async () => {
    const patch = (body: object) => request(`/v1/workspaces/${workspaceId}/auth-settings`, { method: 'PATCH', cookie: aliceCookie, workspaceId, body });
    expect((await patch({ passwordAuthEnabled: false, googleAuthEnabled: false })).status).toBe(400);
    expect((await patch({ passwordAuthBypassEnabled: true })).status).toBe(200);
    expect((await patch({ passwordAuthEnabled: false })).status).toBe(200);

    const stillAdmin = await request('/v1/tools/list_definitions', { cookie: aliceCookie, workspaceId, body: {} });
    expect(stillAdmin.status).toBe(200);

    expect((await patch({ passwordAuthBypassEnabled: false })).status).toBe(200);
    const locked = await request('/v1/tools/list_definitions', { cookie: aliceCookie, workspaceId, body: {} });
    expect(locked.status).toBe(403);
    expect(((await locked.json()) as { error: string }).error).toMatch(/not enabled/);
  });
});

describe('invitations', () => {
  let invitationToken: string;
  let roleId: string;

  it('lets an admin invite a person who then joins with the invited email only', async () => {
    await databases.admin.query('UPDATE core.workspaces SET password_auth_enabled = true, password_auth_bypass_enabled = false WHERE id = $1', [workspaceId]);
    roleId = await createRole(databases.admin, workspaceId, { name: 'member' });

    const invited = await request(`/v1/workspaces/${workspaceId}/invitations`, { cookie: aliceCookie, workspaceId, body: { email: bob, roleIds: [roleId] } });
    expect(invited.status).toBe(201);
    invitationToken = lastMailTo(bob).match(/token=([\w-]+)/)![1]!;

    const { cookie: bobCookie } = await signUpAndVerify(bob, 'Bob');
    const bobSignedIn = (await signIn(bob, 'correct-horse-battery')).cookie || bobCookie;
    expect((await request('/v1/tools/list_definitions', { cookie: bobSignedIn, workspaceId, body: {} })).status).toBe(403);

    const carolEmail = `carol+${run}@example.com`;
    const carol = await signUpAndVerify(carolEmail, 'Carol');
    const carolCookie = (await signIn(carolEmail, carol.password)).cookie;
    expect((await request('/v1/invitations/accept', { cookie: carolCookie, body: { token: invitationToken } })).status).toBe(403);

    const accepted = await request('/v1/invitations/accept', { cookie: bobSignedIn, body: { token: invitationToken } });
    expect(accepted.status).toBe(201);
    expect((await request('/v1/tools/list_definitions', { cookie: bobSignedIn, workspaceId, body: {} })).status).toBe(200);
    expect((await request('/v1/invitations/accept', { cookie: bobSignedIn, body: { token: invitationToken } })).status).toBe(404);

    const forbiddenAdmin = await request(`/v1/workspaces/${workspaceId}/auth-settings`, { cookie: bobSignedIn, workspaceId });
    expect(forbiddenAdmin.status).toBe(403);
  });

  it('applies the workspace sign-in methods to invited members too', async () => {
    await databases.admin.query('UPDATE core.workspaces SET password_auth_enabled = false, google_auth_enabled = true WHERE id = $1', [workspaceId]);
    const bobCookie = (await signIn(bob, 'correct-horse-battery')).cookie;
    const response = await request('/v1/tools/list_definitions', { cookie: bobCookie, workspaceId, body: {} });
    expect(response.status).toBe(403);
  });
});

describe('API keys stay the machine path', () => {
  it('works without any browser session and ignores the workspace header', async () => {
    const boot = await request('/v1/bootstrap', { headers: { 'x-admin-token': ADMIN_TOKEN }, body: { workspaceName: `keys-${run}` } });
    expect(boot.status).toBe(201);
    const { apiKey } = (await boot.json()) as { apiKey: string };
    const viaKey = await request('/v1/tools/list_definitions', { headers: { authorization: `Bearer ${apiKey}` }, body: {} });
    expect(viaKey.status).toBe(200);
    expect((await request('/v1/tools/list_definitions', { headers: { authorization: 'Bearer ak_wrong' }, body: {} })).status).toBe(403);
  });
});
