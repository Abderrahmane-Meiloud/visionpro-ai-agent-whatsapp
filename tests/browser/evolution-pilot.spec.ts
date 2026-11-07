import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

// Same shared app instance + DB as admin.spec.ts (one global-setup for the whole Playwright run).
test.describe.configure({ mode: 'serial' });

const ADMIN_PW = 'browser-test-admin-password';
const SCREENSHOT_DIR = path.join(process.cwd(), 'test-results', 'evolution-pilot-screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/');
  await expect(page.locator('#login')).toBeVisible();
  await page.locator('#login-user').fill(username);
  await page.locator('#login-pass').fill(password);
  await page.locator('#login-btn').click();
  await expect(page.locator('#app')).toBeVisible();
}

test.describe('Evolution pilot — dashboard (signed in as admin)', () => {
  test.beforeEach(async ({ page }) => loginAs(page, 'admin', ADMIN_PW));

  test('header shows honest AI-provider status and Evolution pilot kill-switch status', async ({ page }) => {
    await expect(page.locator('#aiprov')).toContainText('MOCK'); // AGENT_MOCK=true — must never say "real"
    await expect(page.locator('#evopilot')).toContainText('SIMULATION');
    await expect(page.locator('#evopilot')).toContainText('auto-reply OFF'); // the kill switch, visibly off
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-dashboard-status-pills.png'), fullPage: true });
  });

  test('channel filter: shows only the Evolution pilot conversation, tagged PILOT', async ({ page }) => {
    await page.locator('#f-channel').selectOption('whatsapp_evolution_pilot');
    await expect(page.locator('#list .row')).toHaveCount(1);
    await expect(page.locator('#list .row')).toContainText('PilotCustomer');
    await expect(page.locator('#list .tag.whatsapp_evolution_pilot')).toHaveText('PILOT');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-channel-filter-pilot.png'), fullPage: true });
    await page.locator('#f-channel').selectOption('whatsapp');
    await expect(page.locator('#list .row')).toHaveCount(2); // Alice + Bob, pilot excluded
    await page.locator('#f-channel').selectOption('');
    await expect(page.locator('#list .row')).toHaveCount(3);
  });

  test('unread indicator: shown before viewing, cleared after opening the conversation', async ({ page }) => {
    await page.locator('#f-channel').selectOption('whatsapp_evolution_pilot');
    const row = page.locator('#list .row', { hasText: 'PilotCustomer' });
    await expect(row).toHaveClass(/unread/);
    await row.click();
    // Waiting for the message text proves loadConv() (which marks the conversation read
    // server-side) has already completed — the list itself just hasn't been re-fetched yet.
    await expect(page.locator('#msgs')).toContainText('Hello, do you have the test rug in stock');
    // Force an immediate list refresh (don't wait for the 5s poll): re-firing the channel filter
    // re-triggers loadList(), which now picks up the already-updated unread state.
    await page.locator('#f-channel').selectOption('');
    await page.locator('#f-channel').selectOption('whatsapp_evolution_pilot');
    await expect(page.locator('#list .row', { hasText: 'PilotCustomer' })).not.toHaveClass(/unread/);
  });

  test('linked orders: the pilot conversation shows its DRAFT order inline', async ({ page }) => {
    await page.locator('#f-channel').selectOption('whatsapp_evolution_pilot');
    await page.locator('#list .row', { hasText: 'PilotCustomer' }).click();
    await expect(page.locator('#convorders')).toBeVisible();
    await expect(page.locator('#convorders')).toContainText('DRAFT');
    await expect(page.locator('#convorders')).toContainText('RUG-1');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '03-linked-orders.png'), fullPage: true });
  });

  test('manual reply on a pilot-channel conversation: takeover then send (the exact bug that was fixed)', async ({ page }) => {
    await page.locator('#f-channel').selectOption('whatsapp_evolution_pilot');
    await page.locator('#list .row', { hasText: 'PilotCustomer' }).click();
    await page.locator('#take').click();
    await expect(page.locator('#convmode')).toHaveText('HUMAN');
    await page.locator('#text').fill('BROWSER_MANUAL_REPLY_ON_PILOT_CHANNEL');
    await page.locator('#send').click();
    await expect(page.locator('#msgs')).toContainText('BROWSER_MANUAL_REPLY_ON_PILOT_CHANNEL');
    await expect(page.locator('#banner')).not.toHaveClass(/show/); // no error banner — the send did not 500
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '04-manual-reply-pilot-channel.png'), fullPage: true });
    page.once('dialog', (d) => d.accept());
    await page.locator('#ret').click();
    await expect(page.locator('#convmode')).toHaveText('AI');
  });

  test('mobile viewport: pilot conversation detail view works the same as desktop', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator('#f-channel').selectOption('whatsapp_evolution_pilot');
    await page.locator('#inbox-view .row', { hasText: 'PilotCustomer' }).click();
    await expect(page.locator('#inbox-view')).toHaveClass(/detail/);
    await expect(page.locator('#convorders')).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '05-mobile-pilot-detail.png'), fullPage: true });
    await page.locator('#back').click();
    await expect(page.locator('#inbox-view')).not.toHaveClass(/detail/);
  });
});
