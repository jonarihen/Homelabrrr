import { defineConfig } from '@playwright/test';

// CI runners share one host network, so each job passes its own free port.
const port = process.env.E2E_PORT || 4173;

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
});
