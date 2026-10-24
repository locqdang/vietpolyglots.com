const { defineConfig } = require('@playwright/test');

// Headless Chromium ties compositor BeginFrames to the X display when
// DISPLAY is set. On workstations where that display's vsync source is
// unavailable (idle/locked sessions, multi-GPU setups) requestAnimationFrame
// never fires, so Playwright's "stable" actionability check hangs and every
// .click() times out. Run the headless suite without DISPLAY. No-op on CI,
// which has no DISPLAY set anyway.
if (!process.argv.includes('--headed')) {
  delete process.env.DISPLAY;
}

module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'on-first-retry',
  },
  webServer: {
    command:
      'E2E_TEST_MODE=1 NEXT_PUBLIC_FRONTEND_URL=http://127.0.0.1:3100 npm run dev -- --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
