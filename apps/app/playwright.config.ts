import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL, trace: 'on-first-retry' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The container ships Chromium; `playwright install` is not available here.
        launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
      },
    },
  ],
  webServer: {
    // `pnpm -w build` is the WORKSPACE root's build: it runs `data:ensure` at the
    // root, where `data/` lives, and only then builds the app. The app's own
    // `build` deliberately does not generate data (docs/plans/web.md W0).
    command: `pnpm -w build && pnpm start -p ${PORT}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 600_000,
  },
});
