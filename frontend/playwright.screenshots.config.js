import { defineConfig } from '@playwright/test';

// Separate from playwright.config.js so `npm run e2e` never runs it.
export default defineConfig({
  testDir: './screenshots',
  use: { baseURL: 'http://127.0.0.1:4173', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});
