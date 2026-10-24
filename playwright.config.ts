import { defineConfig } from '@playwright/test';

// Browser tests for the admin dashboard. The app is started against a DISPOSABLE local test DB by
// global-setup (with AGENT_MOCK=true and a non-routable Meta base, so nothing external is called),
// seeded with sample conversations, and torn down by global-teardown. Serial, single worker: the
// tests share one app instance + DB.
const PORT = process.env.PW_PORT || '4021';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  reporter: [['list']],
  globalSetup: './tests/browser/global-setup.ts',
  globalTeardown: './tests/browser/global-teardown.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // No httpCredentials: tests authenticate through the real cookie-session login form (P2-A).
    // Locally use the installed Google Chrome (no Chromium download). In CI set PWCHANNEL=chromium
    // after `npx playwright install chromium`.
    ...(process.env.PWCHANNEL === 'chromium' ? {} : { channel: 'chrome' }),
  },
});
