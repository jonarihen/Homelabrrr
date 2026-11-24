import { defineConfig } from '@playwright/test';

// CI runners share one host network, so each job passes its own free port.
const port = process.env.E2E_PORT || 4173;

// Separate from playwright.config.js so `npm run e2e` never runs it.
export default defineConfig({
  testDir: './screenshots',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
