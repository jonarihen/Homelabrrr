import { defineConfig } from '@playwright/test';

// CI runners share one host network, so each job passes its own free port.
const port = process.env.E2E_PORT || 4173;

export default defineConfig({
  testDir: './e2e',
  // The CI runners share one host, so cap parallelism and retry once on load timeouts;
  // a test that passes only on retry is reported as flaky, not hidden.
  workers: process.env.CI ? 3 : undefined,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
