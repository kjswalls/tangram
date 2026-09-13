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
    //
    // `pnpm -w preview` is `scripts/preview.ts` under tsx, not `vite preview`,
    // and the difference is load-bearing: the preview server has no transform
    // pipeline, so the API adapter cannot import a `.ts` route handler without
    // tsx's loader hook (docs/plans/web.md W1). PORT rather than a flag because
    // that is what the script reads and what `pnpm smoke` already passes.
    command: 'pnpm -w build && pnpm -w run preview',
    env: { PORT: String(PORT) },
    url: baseURL,
    reuseExistingServer: true,
    timeout: 600_000,
  },
});
