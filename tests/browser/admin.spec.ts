import { test, expect, type Page } from '@playwright/test';

// Shared app instance + DB; run serially. Each test logs in fresh (no shared cookie between contexts).
test.describe.configure({ mode: 'serial' });

const ADMIN_PW = 'browser-test-admin-password'; // bootstrap admin, seeded from ADMIN_PASSWORD at boot

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/');
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login-user').fill(username);
  await page.locator('#login-pass').fill(password);
  await page.locator('#login-btn').click();
  await expect(page.locator('#app')).toBeVisible();
}

test('login: wrong credentials show an error and do not enter the app', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login-user').fill('admin');
  await page.locator('#login-pass').fill('nope');
  await page.locator('#login-btn').click();
  await expect(page.locator('#loginerr')).toHaveText(/Invalid credentials/);
  await expect(page.locator('#app')).toBeHidden();
});

test('login: correct credentials enter the dashboard; logout returns to the login screen', async ({ page }) => {
  await loginAs(page, 'admin', ADMIN_PW);
  await expect(page.locator('#whoami')).toContainText('admin');
  await page.locator('#logout').click();
  await expect(page.locator('#login')).toBeVisible();
});

test.describe('dashboard (signed in as admin)', () => {
  test.beforeEach(async ({ page }) => loginAs(page, 'admin', ADMIN_PW));

  test('lists seeded conversations with distinct state badges', async ({ page }) => {
    await expect(page.locator('#list .row')).toHaveCount(2);
    await expect(page.locator('#list .tag.HUMAN_PENDING')).toBeVisible();
    await expect(page.locator('#list .tag.AI')).toBeVisible();
  });

  test('selecting a conversation loads its messages', async ({ page }) => {
    await page.locator('#list .row', { hasText: 'Alice' }).click();
    await expect(page.locator('#msgs .m')).toHaveCount(2);
    await expect(page.locator('#msgs')).toContainText('Comment puis-je vous aider');
  });

  test('handoff: take over flips the controls and the conversation badge', async ({ page }) => {
    await page.locator('#list .row', { hasText: 'Alice' }).click();
    await expect(page.locator('#take')).toBeEnabled();
    await expect(page.locator('#ret')).toBeDisabled();
    await page.locator('#take').click();
    await expect(page.locator('#convmode')).toHaveText('HUMAN');
    await expect(page.locator('#take')).toBeDisabled();
    await expect(page.locator('#ret')).toBeEnabled();
    page.once('dialog', (d) => d.accept());
    await page.locator('#ret').click();
    await expect(page.locator('#convmode')).toHaveText('AI');
  });

  test('accessibility: landmark roles, labels, keyboard activation', async ({ page }) => {
    await expect(page.locator('#list')).toHaveAttribute('role', 'list');
    await expect(page.locator('#banner')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#list .row').first()).toHaveAttribute('aria-label', /Conversation with/);
    await page.locator('#list .row').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#msgs .m').first()).toBeVisible();
  });

  test('responsive: mobile viewport switches to a detail view with a Back control', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('#inbox-view .row', { hasText: 'Bob' }).click();
    await expect(page.locator('#inbox-view')).toHaveClass(/detail/);
    await expect(page.locator('#back')).toBeVisible();
    await page.locator('#back').click();
    await expect(page.locator('#inbox-view')).not.toHaveClass(/detail/);
  });

  test('inbox: search filters the conversation list', async ({ page }) => {
    await expect(page.locator('#list .row')).toHaveCount(2);
    await page.locator('#search').fill('Alice');
    await expect(page.locator('#list .row')).toHaveCount(1);
    await expect(page.locator('#list .row')).toContainText('Alice');
    await page.locator('#search').fill('');
    await expect(page.locator('#list .row')).toHaveCount(2);
  });

  test('inbox: status change persists and the status filter works', async ({ page }) => {
    await page.locator('#list .row', { hasText: 'Alice' }).click();
    await page.locator('#cstatus').selectOption('CLOSED');
    await page.locator('#f-status').selectOption('CLOSED');
    await expect(page.locator('#list .row', { hasText: 'Alice' })).toHaveCount(1);
    await page.locator('#f-status').selectOption('OPEN');
    await expect(page.locator('#list .row', { hasText: 'Alice' })).toHaveCount(0);
  });

  test('inbox: internal notes are saved, shown, and never appear in the message thread', async ({ page }) => {
    await page.locator('#list .row', { hasText: 'Alice' }).click();
    await page.locator('#notesbtn').click();
    await expect(page.locator('#notespanel')).toBeVisible();
    await page.locator('#note-input').fill('BROWSER_NOTE_123');
    await page.locator('#note-add').click();
    await expect(page.locator('#noteslist')).toContainText('BROWSER_NOTE_123');
    await expect(page.locator('#msgs')).not.toContainText('BROWSER_NOTE_123');
  });
});

test('knowledge: admin can create an article, sees the volatile lint, and previews the prompt', async ({ page }) => {
  await loginAs(page, 'admin', ADMIN_PW);
  await page.locator('#nav-knowledge').click();
  await expect(page.locator('#knowledge-view')).toBeVisible();
  await page.locator('#k-new').click();
  await page.locator('#k-title').fill('BrowserKB');
  await page.locator('#k-content').fill('The price is 500 MRU');
  await expect(page.locator('#k-warnings')).toContainText(/volatile/i); // lint flags the price
  await page.locator('#k-status').selectOption('published');
  await page.locator('#k-save').click();
  await expect(page.locator('#k-list')).toContainText('BrowserKB');
  await page.locator('#k-preview').click();
  await expect(page.locator('#k-previewbox')).toBeVisible();
  await expect(page.locator('#k-previewbox')).toContainText('Precedence'); // safety rules present in the prompt
});

test('errors: a failing API surfaces a visible, assertive error banner', async ({ page }) => {
  await page.route('**/api/conversations', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
  await loginAs(page, 'admin', ADMIN_PW); // login succeeds; the first dashboard load then fails
  const banner = page.locator('#banner');
  await expect(banner).toHaveClass(/show/);
  await expect(banner).toContainText(/Could not load/);
});

test('analytics: the dashboard renders operational metrics', async ({ page }) => {
  await loginAs(page, 'admin', ADMIN_PW);
  await page.locator('#nav-analytics').click();
  await expect(page.locator('#analytics-view')).toBeVisible();
  await expect(page.locator('#a-stats .stat')).toHaveCount(5);
  await expect(page.locator('#a-stats')).toContainText('Handoffs');
});

test('orders: admin can confirm a seeded draft order (becomes CONFIRMED)', async ({ page }) => {
  await loginAs(page, 'admin', ADMIN_PW);
  await page.locator('#nav-orders').click();
  await expect(page.locator('#orders-view')).toBeVisible();
  const row = page.locator('#o-list .ordrow', { hasText: 'RUG-1' });
  await expect(row).toContainText('DRAFT');
  await row.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('#o-list .ordrow', { hasText: 'RUG-1' })).toContainText('CONFIRMED');
});

test('templates: a closed-window conversation shows the approved-template picker, not free-form', async ({ page }) => {
  await loginAs(page, 'admin', ADMIN_PW);
  await page.locator('#list .row', { hasText: 'Bob' }).click();
  await expect(page.locator('#tmplwrap')).toBeVisible();
  await expect(page.locator('#text')).toBeDisabled();            // free-form blocked outside the 24h window
  await expect(page.locator('#tmplsel option')).toHaveCount(1);  // the seeded approved template
});

test('RBAC: an agent does not see admin-only controls (Pause AI + Knowledge hidden)', async ({ page }) => {
  await loginAs(page, 'agent1', 'agentpass123');
  await expect(page.locator('#whoami')).toContainText('agent');
  await expect(page.locator('#toggle')).toBeHidden();         // manage_settings only
  await expect(page.locator('#nav-knowledge')).toBeHidden();  // manage_knowledge only
  await page.locator('#list .row').first().click();
  await expect(page.locator('#take')).toBeVisible();          // agents can still handle conversations
});
