import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
export const MAIL_DIR = process.env.MAIL_DIR ?? path.resolve(import.meta.dirname, '../../server/.dev-mail');

export const mailLink = (email, pattern) => {
  const body = readFileSync(path.join(MAIL_DIR, `${email}.txt`), 'utf8');
  const match = body.match(pattern);
  if (!match) throw new Error(`No link in mail to ${email}`);
  return match[0];
};

export const check = (condition, message) => {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok  ${message}`);
};

export const shot = async (page, name) => {
  const dir = process.env.SHOT_DIR;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

export const signUpAndCreateWorkspace = async (page, label) => {
  const email = `${label.toLowerCase()}+${Date.now()}@example.com`;
  await page.goto(`${WEB}/sign-up`);
  await page.getByLabel('Name').fill(label);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText('Check your email').waitFor();
  await page.waitForTimeout(600);
  await page.goto(mailLink(email, /https?:\/\/\S+verify-email\S+/));
  await page.getByText('Create your workspace').waitFor({ timeout: 15000 });
  await page.getByPlaceholder('New workspace name').fill(`${label} Co`);
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}$/);
  await page.getByText(`Welcome, ${label}`).waitFor();
  return { email, workspaceUrl: page.url() };
};

export const pick = async (page, trigger, optionName) => {
  await trigger.click();
  await page.getByRole('option', { name: optionName, exact: true }).click();
};

export const addObject = async (page, base, singular, plural) => {
  await page.goto(`${base}/settings/data-model`);
  await page.getByRole('button', { name: 'New object' }).first().click();
  await page.getByLabel('Singular name').fill(singular);
  if (plural) await page.getByLabel('Plural name').fill(plural);
  await page.getByRole('button', { name: 'Create object' }).click();
  await page.getByRole('heading', { name: new RegExp(`^${plural ?? singular}`, 'i') }).waitFor();
};

export const addField = async (page, label, type, extra = {}) => {
  await page.getByRole('button', { name: 'Add field' }).first().click();
  await page.getByLabel('Label').fill(label);
  await pick(page, page.getByRole('combobox').first(), type);
  if (extra.options) await page.getByLabel('Options').fill(extra.options);
  if (extra.target) await pick(page, page.getByRole('combobox').nth(1), extra.target);
  await page.getByRole('button', { name: 'Add field' }).last().click();
  await page.getByRole('cell', { name: label, exact: true }).waitFor();
};

export const eventually = async (read, predicate, message, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read().catch(() => undefined);
    if (predicate(last)) return check(true, message);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`FAILED: ${message} (last value: ${JSON.stringify(last)})`);
};

// Calls a tool as the signed-in browser user, so a test can set up data without clicking through every screen.
export const api = (page, workspaceId, tool, args = {}) =>
  page.evaluate(
    async ({ workspaceId, tool, args }) => {
      const response = await fetch(`/v1/tools/${tool}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify(args) });
      const body = await response.json();
      if (!response.ok) throw new Error(`${tool}: ${body.error}`);
      return body.result;
    },
    { workspaceId, tool, args },
  );

export const workspaceIdOf = (url) => url.match(/\/w\/([0-9a-f-]{36})/)[1];
