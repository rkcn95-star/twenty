// Drives the web app in a real browser. Needs the API server, the web app and the dev mail sink running.
import { chromium, WEB, addField, addObject, check, eventually, pick, shot, signUpAndCreateWorkspace } from './helpers.mjs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
const expected = { responses: 0, consoleErrors: 0 };
page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (expected.consoleErrors > 0 && message.text().includes('Failed to load resource')) return void expected.consoleErrors--;
  problems.push(`console: ${message.text()}`);
});
page.on('response', async (response) => {
  if (response.status() >= 400 && response.url().includes('/v1/')) {
    if (expected.responses > 0) return void expected.responses--;
    const request = response.request();
    problems.push(`${response.status()} ${request.method()} ${response.url()} body=${(request.postData() ?? '').slice(0, 300)} -> ${(await response.text().catch(() => '')).slice(0, 200)}`);
  }
});

try {
  const { workspaceUrl } = await signUpAndCreateWorkspace(page, 'Smoke');
  const base = workspaceUrl;
  check(await page.getByText('Data model').first().isVisible(), 'signed in and in a new workspace');

  // data model
  await addObject(page, base, 'company', 'companies');
  await addField(page, 'Name', 'Text');
  await addField(page, 'Industry', 'Select', { options: 'tech, retail' });
  await addObject(page, base, 'deal', 'deals');
  await addField(page, 'Title', 'Text');
  await addField(page, 'Amount', 'Number');
  await addField(page, 'Stage', 'Select', { options: 'new, won, lost' });
  await addField(page, 'Company', 'Relation', { target: 'Companies' });
  await addField(page, 'Closed on', 'Date');
  await shot(page, 'data-model');
  check(true, 'created two objects with typed fields and a relation');
  check(await page.getByRole('link', { name: 'Deals' }).isVisible(), 'new objects appear in the sidebar');

  // records
  const newRecord = async (singular) => page.getByRole('button', { name: new RegExp(`^New ${singular}$`, 'i') }).first().click();
  await page.getByRole('link', { name: 'Companies' }).click();
  for (const [name, industry] of [['Acme', 'tech'], ['Beta', 'retail']]) {
    await newRecord('company');
    await page.getByLabel('Name').fill(name);
    await pick(page, page.getByRole('combobox').first(), industry);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('cell', { name, exact: true }).waitFor();
  }
  check(true, 'created company records');

  await page.getByRole('link', { name: 'Deals' }).click();
  const deals = [['A1', '100', 'won', 'Acme'], ['A2', '50', 'new', 'Acme'], ['B1', '30', 'won', 'Beta'], ['B2', '70', 'lost', 'Beta']];
  for (const [title, amount, stage, company] of deals) {
    await newRecord('deal');
    await page.getByLabel('Title').fill(title);
    await page.getByLabel('Amount').fill(amount);
    const combos = page.getByRole('dialog').getByRole('combobox');
    await pick(page, combos.nth(0), stage);
    await pick(page, combos.nth(1), company);
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('cell', { name: title, exact: true }).waitFor();
  }
  await shot(page, 'records');
  check((await page.getByRole('row').count()) >= 5, 'deals table lists the four records');
  check(await page.getByRole('row', { name: /A1.*Acme/ }).isVisible(), 'relation column shows the company name, not an id');
  check(await page.getByText('1–4 of 4').isVisible(), 'footer shows the total');

  // sorting
  await page.getByRole('button', { name: 'Amount' }).click();
  await eventually(() => page.getByRole('row').nth(1).innerText(), (text) => /B1/.test(text), 'sorting by amount ascending puts the smallest first');
  await page.getByRole('button', { name: 'Amount' }).click();
  await eventually(() => page.getByRole('row').nth(1).innerText(), (text) => /A1/.test(text), 'sorting again reverses the order');

  // filtering
  await page.getByRole('button', { name: /Filter/ }).click();
  await page.getByRole('button', { name: 'Add filter' }).click();
  const filterCombos = page.getByRole('dialog').or(page.locator('[data-slot=popover-content]')).getByRole('combobox');
  await pick(page, filterCombos.nth(0), 'Stage');
  await pick(page, filterCombos.nth(2), 'won');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByText('1–2 of 2').waitFor();
  await shot(page, 'filtered');
  check(true, 'filter on a select field narrows the table');

  // edit and delete
  await page.getByRole('cell', { name: 'A1', exact: true }).click();
  await page.getByLabel('Amount').fill('120');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('cell', { name: '120', exact: true }).waitFor();
  check(true, 'editing a record updates the table');

  await page.getByRole('row', { name: /B1/ }).getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByText('1–1 of 1').waitFor();
  check(true, 'deleting a record removes it');

  // report builder
  await page.getByRole('link', { name: 'Reports' }).click();
  await page.getByText('No reports yet').waitFor();
  await page.getByRole('link', { name: 'New report' }).first().click();
  await pick(page, page.getByRole('combobox').first(), 'Deals');
  await page.getByRole('button', { name: 'Add join' }).click();
  const columnField = (index) => page.getByRole('combobox', { name: 'Column field' }).nth(index);
  await page.getByRole('button', { name: 'Add column' }).click();
  await pick(page, columnField(0), 'Company → Companies · Name');
  await page.getByRole('button', { name: 'Add column' }).click();
  await pick(page, columnField(1), 'Number of records');
  await page.getByRole('button', { name: 'Add column' }).click();
  await pick(page, columnField(2), 'Deals · Amount');
  await pick(page, page.getByRole('combobox', { name: 'Aggregate' }).nth(2), 'Sum');
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => rows.some((row) => /Acme\s+2\s+170/.test(row)) && rows.some((row) => /Beta\s+1\s+70/.test(row)), 'report groups and sums deals by company name');
  await shot(page, 'report-table');
  await page.getByRole('tab', { name: /SQL/ }).click();
  await eventually(() => page.getByTestId('sql').innerText(), (text) => /GROUP BY 1/.test(text) && /LEFT JOIN/.test(text), 'SQL tab shows the generated query');
  await page.getByRole('tab', { name: 'Result' }).click();

  await page.getByRole('button', { name: 'Add filter' }).click();
  const reportFilter = page.getByRole('combobox', { name: 'Filter field' });
  await pick(page, reportFilter.first(), 'Deals · Stage');
  await pick(page, page.getByRole('combobox').filter({ hasText: 'Choose' }).first(), 'won');
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => rows.some((row) => /Acme\s+1\s+120/.test(row)) && !rows.some((row) => /Beta/.test(row)), 'report filter restricts the rows');
  await page.getByRole('button', { name: 'Remove filter' }).click();

  await pick(page, page.getByRole('combobox', { name: 'Visualization' }), 'Bar chart');
  await page.locator('.recharts-wrapper').waitFor();
  await page.getByText('2 rows').waitFor();
  await page.waitForTimeout(1200);
  await shot(page, 'report-chart');
  check(true, 'bar chart renders from the same report');

  await page.getByLabel('Report name').fill('revenue_by_company');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(/\/reports\/revenue_by_company$/);
  await page.reload();
  await page.getByRole('tab', { name: 'Definition' }).click();
  await eventually(() => page.locator('pre').first().innerText(), (text) => /"source": "deals"/.test(text) && /"type": "bar"/.test(text), 'saved report reopens with its definition and chart type');
  await page.getByRole('link', { name: 'Reports' }).click();
  await page.getByRole('link', { name: 'revenue_by_company' }).waitFor();
  check(true, 'saved report is listed');

  // members and API keys
  const toolStatus = async (key, name, body = {}) =>
    (await fetch(`${WEB}/v1/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  const toolNames = async (key) => (await (await fetch(`${WEB}/v1/tools`, { headers: { authorization: `Bearer ${key}` } })).json()).tools.map((tool) => tool.name);
  const createKey = async (name, roleName) => {
    await page.getByRole('button', { name: 'New API key' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('checkbox', { name: roleName }).click();
    await page.getByRole('button', { name: 'Create key' }).click();
    const key = (await page.getByTestId('api-key').innerText()).trim();
    await page.getByRole('button', { name: 'Done' }).click();
    return key;
  };
  await page.goto(`${base}/settings/members`);
  await page.getByText('Smoke', { exact: true }).first().waitFor();
  const adminKey = await createKey('ci', 'admin');
  check(adminKey.startsWith('ak_'), 'API key is shown once after creation');
  check((await toolStatus(adminKey, 'list_definitions')) === 200, 'the new key works against the API');
  await page.getByRole('button', { name: 'Actions for ci' }).click();
  await page.getByRole('menuitem', { name: 'Revoke key' }).click();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByText('Revoked').waitFor();
  check((await toolStatus(adminKey, 'list_definitions')) === 403, 'a revoked key stops working immediately');

  // roles
  await page.goto(`${base}/settings/roles`);
  await page.getByRole('button', { name: 'New role' }).first().click();
  await page.getByLabel('Name').fill('Viewer');
  await page.getByRole('button', { name: 'Create role' }).click();
  await page.getByRole('heading', { name: 'Viewer' }).waitFor();
  await page.getByRole('checkbox', { name: 'read Deals' }).click();
  await eventually(() => page.getByRole('checkbox', { name: 'read Deals' }).isChecked(), (checked) => checked === true, 'granting read on an object persists');
  await page.getByRole('button', { name: 'Fields of Deals' }).click();
  await page.getByRole('checkbox', { name: 'See Amount' }).click();
  await pick(page, page.getByRole('combobox', { name: 'Rule object' }), 'Deals');
  await page.getByRole('button', { name: 'Add rule' }).click();
  await page.locator('code', { hasText: 'the current user' }).waitFor();
  await shot(page, 'roles');
  await page.reload();
  await page.getByRole('button', { name: 'Viewer' }).click();
  check(await page.getByRole('checkbox', { name: 'read Deals' }).isChecked(), 'role permissions survive a reload');
  check(await page.locator('code', { hasText: 'the current user' }).isVisible(), 'row rule survives a reload');

  await page.goto(`${base}/settings/members`);
  await page.getByText('Smoke', { exact: true }).first().waitFor();
  const viewerKey = await createKey('viewer key', 'Viewer');
  const names = await toolNames(viewerKey);
  check(names.includes('find_many_deals') && !names.includes('create_one_deal') && !names.includes('create_object'), 'a key with the Viewer role only gets read tools');
  check(!names.includes('find_many_companies'), 'and nothing on objects it was not granted');

  // sign-in methods
  await page.goto(`${base}/settings/sign-in`);
  await page.getByRole('switch', { name: 'Admins can bypass disabled email and password' }).click();
  await eventually(() => page.getByRole('switch', { name: 'Admins can bypass disabled email and password' }).getAttribute('aria-checked'), (value) => value === 'true', 'bypass switch turns on');
  await page.getByRole('switch', { name: 'Email and password', exact: true }).click();
  await eventually(() => page.getByRole('switch', { name: 'Email and password', exact: true }).getAttribute('aria-checked'), (value) => value === 'false', 'email and password can be switched off');
  await page.reload();
  await page.getByText('Choose how people can sign in').waitFor({ timeout: 10000 });
  check(true, 'the admin keeps access through the bypass');
  expected.responses = 1;
  expected.consoleErrors = 1;
  await page.getByRole('switch', { name: 'Google', exact: true }).click();
  await page.getByText('At least one sign-in method must stay enabled').first().waitFor();
  check((await page.getByRole('switch', { name: 'Google', exact: true }).getAttribute('aria-checked')) === 'true', 'the last enabled sign-in method cannot be switched off');
  await page.getByRole('switch', { name: 'Email and password', exact: true }).click();
  await page.getByRole('switch', { name: 'Email and password', exact: true }).waitFor();

  // audit log
  check((await toolStatus(viewerKey, 'find_one_deal', { id: 'not-a-uuid' })) === 400, 'an invalid tool call is rejected');
  await page.goto(`${base}/settings/audit-log`);
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => rows.some((row) => /run_report/.test(row)), 'audit log lists tool calls');
  await pick(page, page.getByRole('combobox', { name: 'Outcome' }), 'Failed');
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => rows.length > 1 && rows.slice(1).every((row) => /Failed/.test(row)), 'the audit log filters to failures');
  await shot(page, 'audit-log');

  if (problems.length) throw new Error(`browser problems:\n${problems.join('\n')}`);
  console.log('\nsmoke test passed');
} catch (error) {
  await shot(page, 'failure');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
