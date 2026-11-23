import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8799);
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 70_000,
  expect: { timeout: 12_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    launchOptions: browserPath ? { executablePath: browserPath } : {},
  },
  webServer: {
    command:
      `rm -rf .rendezvous-test && mkdir -p .rendezvous-test && ` +
      `RENDEZVOUS_HOST=127.0.0.1 PORT=${port} ` +
      `RENDEZVOUS_DATA_FILE=.rendezvous-test/e2e-store.json npm start`,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
