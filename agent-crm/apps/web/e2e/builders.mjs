// Forms, grids, many-to-many, invitations and dark mode, driven through the UI. Data model setup goes through the API.
import { chromium, WEB, api, check, eventually, mailLink, pick, shot, signUpAndCreateWorkspace, workspaceIdOf } from './helpers.mjs';

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

const addFields = async (names, index = 0) => {
  for (const name of names) {
    await pick(page, page.getByRole('combobox', { name: 'Add a field' }).nth(index), name);
    await page.getByLabel(`Label for ${name}`).or(page.getByLabel(`Label for ${name}`)).first().waitFor();
  }
};

try {
  const { workspaceUrl } = await signUpAndCreateWorkspace(page, 'Builders');
  const base = workspaceUrl;
  const wid = workspaceIdOf(base);

  // data model through the API
  const company = await api(page, wid, 'create_object', { nameSingular: 'company', namePlural: 'companies', label: 'Companies' });
  const tag = await api(page, wid, 'create_object', { nameSingular: 'tag', namePlural: 'tags', label: 'Tags' });
  const deal = await api(page, wid, 'create_object', { nameSingular: 'deal', namePlural: 'deals', label: 'Deals' });
  await api(page, wid, 'create_field', { objectId: company.id, name: 'name', label: 'Name', type: 'text' });
  await api(page, wid, 'create_field', { objectId: tag.id, name: 'name', label: 'Name', type: 'text' });
  await api(page, wid, 'create_field', { objectId: deal.id, name: 'title', label: 'Title', type: 'text' });
  await api(page, wid, 'create_field', { objectId: deal.id, name: 'amount', label: 'Amount', type: 'number' });
  await api(page, wid, 'create_field', { objectId: deal.id, name: 'stage', label: 'Stage', type: 'select', options: ['new', 'won', 'lost'] });
  await api(page, wid, 'create_field', { objectId: deal.id, name: 'company', label: 'Company', type: 'relation', relationObjectId: company.id });
  await api(page, wid, 'create_field', { objectId: deal.id, name: 'tags', label: 'Tags', type: 'many_to_many', relationObjectId: tag.id });
  const acme = await api(page, wid, 'create_one_company', { data: { name: 'Acme' } });
  const red = await api(page, wid, 'create_one_tag', { data: { name: 'red' } });
  await api(page, wid, 'create_one_tag', { data: { name: 'green' } });
  for (const [title, amount, stage] of [['A1', 100, 'new'], ['A2', 50, 'new'], ['A3', 70, 'lost']]) {
    await api(page, wid, 'create_one_deal', { data: { title, amount, stage, company: acme.id } });
  }
  check(true, 'set up objects, a relation, a many-to-many field and some records');

  // ---------- many-to-many in tables and the record dialog ----------
  await page.goto(`${base}/o/deals`);
  await page.getByRole('cell', { name: 'A1', exact: true }).click();
  await page.getByLabel('Tags').click();
  await page.getByRole('checkbox', { name: 'red' }).click();
  await page.getByRole('checkbox', { name: 'green' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await eventually(() => page.getByRole('row', { name: /A1/ }).innerText(), (text) => /red/.test(text) && /green/.test(text), 'many-to-many links save from the record dialog and show in the table');
  await page.getByRole('cell', { name: 'A1', exact: true }).click();
  await eventually(() => page.getByLabel('Tags').innerText(), (text) => /red/.test(text) && /green/.test(text), 'the dialog loads existing links');
  await page.keyboard.press('Escape');

  // ---------- single form: designer and runtime ----------
  await page.goto(`${base}/forms`);
  await page.getByText('No forms yet').waitFor();
  await page.getByRole('link', { name: 'New form' }).first().click();
  await page.getByLabel('Form name').fill('quick_deal');
  await pick(page, page.getByRole('combobox', { name: 'Form object' }), 'Deals');
  await addFields(['Title', 'Amount', 'Stage', 'Tags']);
  await page.getByRole('checkbox', { name: 'Required' }).first().click();
  await page.getByLabel('Title *').waitFor();
  await shot(page, 'form-designer');
  check(true, 'single form designer previews the form as it is built');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/forms\/quick_deal\/edit$/);

  await page.goto(`${base}/forms/quick_deal`);
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText('"Title" is required').first().waitFor();
  check(true, 'a required field blocks submission with a clear message');
  await page.getByLabel('Title *').fill('From form');
  await page.getByLabel('Amount').fill('10');
  await page.getByLabel('Tags').click();
  await page.getByRole('checkbox', { name: 'red' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText('Submitted').first().waitFor();
  await page.goto(`${base}/o/deals`);
  await eventually(() => page.getByRole('row', { name: /From form/ }).innerText(), (text) => /10/.test(text) && /red/.test(text), 'a submitted single form creates the record with its links');

  // ---------- parent and child form ----------
  await page.goto(`${base}/forms/new`);
  await page.getByLabel('Form name').fill('company_with_deals');
  await page.getByRole('button', { name: /Parent and child rows/ }).click();
  await pick(page, page.getByRole('combobox', { name: 'Parent object' }), 'Companies');
  await addFields(['Name']);
  await page.getByRole('button', { name: 'Add rows' }).click();
  await addFields(['Title', 'Amount'], 1);
  await page.getByLabel('Rows 1 minimum').fill('1');
  await page.getByText('Add row').first().waitFor();
  await shot(page, 'form-parent-child');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/company_with_deals\/edit$/);
  check(true, 'parent and child form designer saves');

  await page.goto(`${base}/forms/company_with_deals`);
  await page.getByLabel('Name', { exact: true }).fill('Gamma');
  await page.getByTestId('rows_1-row').or(page.getByTestId('deals-row')).first().waitFor();
  const dealRow = (index) => page.getByTestId('deals-row').nth(index);
  await dealRow(0).getByRole('textbox').nth(0).fill('G1');
  await dealRow(0).getByRole('spinbutton').fill('5');
  await page.getByRole('button', { name: 'Add row' }).click();
  await dealRow(1).getByRole('textbox').nth(0).fill('G2');
  await dealRow(1).getByRole('spinbutton').fill('6');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText('Submitted').first().waitFor();
  await page.goto(`${base}/o/deals`);
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => rows.some((row) => /G1.*Gamma/.test(row)) && rows.some((row) => /G2.*Gamma/.test(row)), 'a parent and child form saves the header and every row, linked');

  // an invalid row rolls everything back
  await page.goto(`${base}/forms/company_with_deals`);
  await page.getByLabel('Name', { exact: true }).fill('Rolled back');
  await dealRow(0).getByRole('textbox').nth(0).fill('R1');
  await dealRow(0).getByRole('spinbutton').fill('1e999');
  expected.responses = 1; expected.consoleErrors = 1;
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.waitForTimeout(800);
  const rolledBack = await api(page, wid, 'find_many_companies', { filter: { name: 'Rolled back' } });
  check(rolledBack.total === 0, 'a failing row leaves no header record behind');

  // ---------- multi-record form ----------
  await page.goto(`${base}/forms/new`);
  await page.getByLabel('Form name').fill('company_and_deal');
  await page.getByRole('button', { name: /Multiple records/ }).click();
  await pick(page, page.getByRole('combobox', { name: 'Section 1 object' }), 'Companies');
  await addFields(['Name'], 0);
  await page.getByRole('button', { name: 'Add section' }).click();
  await pick(page, page.getByRole('combobox', { name: 'Section 2 object' }), 'Deals');
  await pick(page, page.getByRole('combobox', { name: 'Section 2 link to' }), 'Link to companies');
  await pick(page, page.getByRole('combobox', { name: 'Section 2 link field' }), 'Company');
  await addFields(['Title'], 1);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/company_and_deal\/edit$/);
  await page.goto(`${base}/forms/company_and_deal`);
  await page.getByLabel('Name', { exact: true }).fill('Delta');
  await page.getByLabel('Title', { exact: true }).fill('D1');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText('Submitted').first().waitFor();
  await page.goto(`${base}/o/deals`);
  await eventually(() => page.getByRole('row', { name: /D1/ }).innerText(), (text) => /Delta/.test(text), 'a multi-record form creates linked records together');

  // ---------- grids ----------
  await page.goto(`${base}/grids`);
  await page.getByText('No grids yet').waitFor();
  await page.getByRole('link', { name: 'New grid' }).first().click();
  await page.getByLabel('Grid name').fill('deal_board');
  await pick(page, page.getByRole('combobox', { name: 'Grid object' }), 'Deals');
  for (const column of ['Title', 'Amount', 'Stage', 'Company · Name']) await pick(page, page.getByRole('combobox', { name: 'Add a column' }), column);
  await pick(page, page.getByRole('combobox', { name: 'Sort by' }), 'Amount');
  await pick(page, page.getByRole('combobox', { name: 'Direction' }), 'Desc');
  const addAction = async (section, label, kind) => {
    await page.getByRole('button', { name: 'Add action' }).nth(section).click();
    const index = 1;
    await page.getByLabel(`Action ${index} label`).nth(section === 0 ? 0 : 0).waitFor();
  };
  // row action: mark won
  await page.getByRole('button', { name: 'Add action' }).first().click();
  await page.getByLabel('Action 1 label').first().fill('Mark won');
  await pick(page, page.getByRole('combobox', { name: 'Field to set' }), 'Stage');
  await pick(page, page.getByRole('combobox').filter({ hasText: 'None' }).first(), 'won');
  await page.getByLabel('Action 1 confirmation').first().fill('Mark these deals as won?');
  // bulk action: delete
  await page.getByRole('button', { name: 'Add action' }).last().click();
  await page.getByLabel('Action 1 label').last().fill('Delete selected');
  await pick(page, page.getByRole('combobox', { name: 'Action 1 kind' }).last(), 'Delete records');
  await page.getByLabel('Action 1 confirmation').last().fill('Delete these deals?');
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => rows.length > 3 && rows.some((row) => /Acme/.test(row)), 'grid designer previews rows with related columns');
  await shot(page, 'grid-designer');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/deal_board\/edit$/);

  await page.goto(`${base}/grids/deal_board`);
  await eventually(() => page.getByRole('row').nth(1).innerText(), (text) => /A1/.test(text), 'grid runtime sorts by the saved order (largest amount first)');
  await shot(page, 'grid-runtime');
  await page.getByRole('row', { name: /A2/ }).getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: 'Mark won' }).click();
  await page.getByText('Mark these deals as won?').waitFor();
  await page.getByRole('button', { name: 'Run' }).click();
  await eventually(() => page.getByRole('row', { name: /A2/ }).innerText(), (text) => /won/.test(text), 'a row action updates the record after confirmation');

  await page.getByRole('row', { name: /A3/ }).getByRole('checkbox').click();
  await page.getByRole('row', { name: /A2/ }).getByRole('checkbox').click();
  await page.getByRole('button', { name: /Delete selected \(2\)/ }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => !rows.some((row) => /A3/.test(row)) && !rows.some((row) => /A2/.test(row)), 'a bulk action deletes the selected records');

  // ---------- open_form action: grid row to parent-child edit ----------
  await page.goto(`${base}/grids/new`);
  await page.getByLabel('Grid name').fill('company_list');
  await pick(page, page.getByRole('combobox', { name: 'Grid object' }), 'Companies');
  await pick(page, page.getByRole('combobox', { name: 'Add a column' }), 'Name');
  await page.getByRole('button', { name: 'Add action' }).first().click();
  await page.getByLabel('Action 1 label').first().fill('Edit with deals');
  await pick(page, page.getByRole('combobox', { name: 'Action 1 kind' }).first(), 'Open a form');
  await pick(page, page.getByRole('combobox', { name: 'Action 1 form' }).first(), 'company_with_deals');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/company_list\/edit$/);
  await page.goto(`${base}/grids/company_list`);
  await page.getByRole('row', { name: /Gamma/ }).getByRole('button', { name: 'Row actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit with deals' }).click();
  await page.waitForURL(/forms\/company_with_deals\?record=/);
  await eventually(() => page.getByLabel('Name', { exact: true }).inputValue(), (value) => value === 'Gamma', 'open-form action opens the form on the chosen record');
  await eventually(() => page.getByTestId('deals-row').count(), (count) => count === 2, 'the parent and child form loads the existing rows');
  await dealRow(1).getByRole('spinbutton').fill('7');
  await page.getByRole('button', { name: 'Remove Deals row 1' }).click();
  await page.getByRole('button', { name: 'Add row' }).click();
  await dealRow(1).getByRole('textbox').nth(0).fill('G3');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Changes saved').first().waitFor();
  await page.goto(`${base}/o/deals`);
  await eventually(() => page.getByRole('row').allInnerTexts(), (rows) => !rows.some((row) => /\bG1\b/.test(row)) && rows.some((row) => /G2.*7/.test(row)) && rows.some((row) => /G3.*Gamma/.test(row)), 'editing a parent and child form updates, adds and removes rows');

  // ---------- invitations ----------
  await page.goto(`${base}/settings/members`);
  await page.getByRole('button', { name: 'Invite person' }).click();
  const invitee = `invitee+${Date.now()}@example.com`;
  await page.getByLabel('Email').fill(invitee);
  await pick(page, page.getByRole('combobox', { name: 'Invite role' }), 'admin');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await page.getByText(`Invitation sent to ${invitee}`).waitFor();
  await page.waitForTimeout(500);
  const inviteLink = mailLink(invitee, /https?:\/\/\S+accept-invitation\?token=\S+/);

  const guest = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await guest.goto(inviteLink);
  await guest.waitForURL(/sign-in\?next=/);
  await guest.getByRole('link', { name: 'Create an account' }).click();
  await guest.waitForURL(/sign-up\?next=/);
  await guest.getByLabel('Name').fill('Invitee');
  await guest.getByLabel('Email').fill(invitee);
  await guest.getByLabel('Password').fill('correct-horse-battery');
  await guest.getByRole('button', { name: 'Create account' }).click();
  await guest.getByText('Check your email').waitFor();
  await guest.waitForTimeout(600);
  await guest.goto(mailLink(invitee, /https?:\/\/\S+verify-email\S+/));
  await guest.getByRole('button', { name: 'Accept invitation' }).click();
  await guest.waitForURL(new RegExp(`/w/${wid}$`));
  await guest.getByText('Welcome, Invitee').waitFor();
  check(true, 'an invited person signs up, verifies and joins through the invitation link');
  await guest.close();

  // ---------- dark mode ----------
  await page.goto(base);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  check(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme turns on');
  await page.reload();
  check(await page.evaluate(() => document.documentElement.classList.contains('dark')), 'dark theme persists across reloads');
  await page.goto(`${base}/reports/new`);
  await shot(page, 'dark-report');
  await page.goto(`${base}/o/deals`);
  await page.getByRole('row').nth(1).waitFor();
  await shot(page, 'dark-table');
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  check(!(await page.evaluate(() => document.documentElement.classList.contains('dark'))), 'dark theme turns off');

  if (problems.length) throw new Error(`browser problems:\n${problems.join('\n')}`);
  console.log('\nbuilders test passed');
} catch (error) {
  await shot(page, 'builders-failure');
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
