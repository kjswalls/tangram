import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = `http://localhost:${PORT}`;

/**
 * The API, on its own origin (docs/plans/backend.md B1).
 *
 * It must match `apps/app/.env.e2e`'s `VITE_API_BASE`, which is what the build
 * bakes in, and it is a **different origin from `baseURL` on purpose**: every
 * call the app makes is then a real cross-origin call, preflighted because of
 * the `X-Tangram-Access` header, exactly as it will be against
 * `api.<domain>`. A same-origin run proves none of that (`web.md` R10), and
 * B1's CORS criterion says to assert the POST half from a browser rather than
 * with `curl`, which ignores CORS and will cheerfully tell you it works.
 */
const API_PORT = 8787;
const apiBaseURL = `http://127.0.0.1:${API_PORT}`;

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
  webServer: [
    {
      // `pnpm -w build` is the WORKSPACE root's build: it runs `data:ensure` at
      // the root, where `data/` lives, and only then builds the app. The app's
      // own `build` deliberately does not generate data (docs/plans/web.md W0).
      //
      // `pnpm -w preview` is `scripts/preview.ts`, not `vite preview`, because
      // it pins the port to 3000 — the one `pnpm smoke` and this file both
      // default to — and takes `TANGRAM_PREVIEW_OUT_DIR`, which
      // `tests/e2e/d/access-gate.spec.ts` uses to serve a second build. It ran
      // under `tsx` for a third reason until `backend.md` B1: the preview
      // server has no transform pipeline, so the deleted API adapter could not
      // import a `.ts` route handler without tsx's loader hook. That adapter is
      // gone and the handlers are in `apps/server`.
      //
      // `build:e2e`, not `build`: it is the same production build with
      // `--mode e2e`, which does two things — it puts the dev-only `/gallery`
      // route in the bundle (docs/plans/core.md C1, and the note in
      // src/routes.tsx) and it loads `.env.e2e`, which is where `VITE_API_BASE`
      // comes from. `import.meta.env.PROD` is still true — the mode changes
      // which constants Vite substitutes, not whether this is a production
      // build — so the service worker still registers and
      // tests/e2e/p6/pwa.spec.ts is unaffected.
      command: 'pnpm -w run build:e2e && pnpm -w run preview',
      env: { PORT: String(PORT) },
      url: baseURL,
      reuseExistingServer: true,
      timeout: 600_000,
    },
    {
      /**
       * `apps/server`, the deployable the three model routes moved to.
       *
       * It rebuilds rather than assuming the first entry got there first:
       * Playwright starts web servers in parallel, the esbuild bundle takes
       * tens of milliseconds, and a stale `dist/index.js` answering the suite
       * is the exact shape of failure this whole phase is about.
       *
       * `TANGRAM_ACCESS_SECRET` is deliberately NOT set. The suite runs with
       * the gate absent — rule 1 of `@tangram/access`, and what keeps `pnpm
       * e2e` identical to a deployment with no gate. `tests/e2e/d/access-gate.spec.ts`
       * starts a second, gated instance of this same server for the other half.
       *
       * The allowlist names the app's origin explicitly rather than relying on
       * the built-in development origins, so the suite proves the mechanism a
       * deployment uses (`TANGRAM_ALLOWED_ORIGINS`) rather than a default.
       */
      command: 'pnpm -F server build && pnpm -F server start',
      env: {
        TANGRAM_SERVER_PORT: String(API_PORT),
        TANGRAM_ALLOWED_ORIGINS: `${baseURL},http://127.0.0.1:${PORT}`,
        NODE_ENV: 'development',
      },
      url: `${apiBaseURL}/health`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
