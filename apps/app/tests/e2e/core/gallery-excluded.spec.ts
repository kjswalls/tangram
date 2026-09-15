/**
 * A production build serves no `/gallery` (docs/plans/core.md C1).
 *
 * **The negative case has to be tested or the guard rots** — and a negative
 * test with no positive control is itself rot. So this spec builds the app
 * twice and asserts both directions:
 *
 *   - **production mode**, with `VITE_TANGRAM_GALLERY=1` deliberately *in the
 *     environment*: the gallery must still be absent. An earlier draft keyed
 *     the guard to that variable and a plain `vite build` shipped the whole
 *     gallery whenever it was set — which `pnpm e2e` itself put there. The
 *     guard is now the build MODE, which nothing in the environment can turn
 *     on, and this case is what proves it.
 *   - **`--mode e2e`**: the gallery must be present. Without this control, a
 *     reworded intro paragraph would leave the marker check passing against a
 *     bundle that contained the entire gallery, and the spec would report green
 *     for a guard that had stopped guarding anything.
 *
 * `GALLERY_MARKER` is imported from the gallery module rather than copied here,
 * for the same reason: a copy edit has to move both or neither.
 *
 * **Why two separate output directories.** The suite's own web server is
 * serving `apps/app/dist`, and `vite build` has `emptyOutDir: true`; building
 * into the same place would delete the bundle every other spec is running
 * against.
 *
 * C1 also says `pnpm smoke` needs no exemption — W2 derives its cases from the
 * production route table, which by construction has no `/gallery` in it. **W2
 * must not "fix" the missing case by adding one.**
 */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { GALLERY_MARKER } from '../../../components/gallery/gallery';
import { HARNESS_PATH } from '../../../components/gallery/span-select-harness';

const APP_DIR = resolve(import.meta.dirname, '..', '..', '..');
const VITE = resolve(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
/** Deliberately not named after the gallery: the basename check below globs for it. */
const PROD_DIR = resolve(APP_DIR, 'dist-prod-check');
const E2E_DIR = resolve(APP_DIR, 'dist-e2e-check');
const PORT = 3177;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function emittedText(dir: string): string[] {
  return walk(dir).filter((path) => /\.(js|css|html)$/.test(path));
}

/** `dist/` with an SPA fallback, which is how the real host serves it. */
function serve(root: string): Promise<Server> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
    const asFile = resolve(root, `.${url.pathname}`);
    const path =
      asFile.startsWith(root) && existsSync(asFile) && statSync(asFile).isFile()
        ? asFile
        : join(root, 'index.html');
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    response.end(readFileSync(path));
  });
  return new Promise((ready) => server.listen(PORT, '127.0.0.1', () => ready(server)));
}

function build(outDir: string, mode: string | undefined, env: NodeJS.ProcessEnv): void {
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(
    'node',
    [VITE, 'build', ...(mode ? ['--mode', mode] : []), '--outDir', outDir, '--emptyOutDir'],
    { cwd: APP_DIR, env, stdio: 'pipe' },
  );
}

test.describe('a production build has no gallery', () => {
  let server: Server | undefined;

  test.beforeAll(async () => {
    // The hostile case: the flag an earlier draft trusted, set in the
    // environment, against a plain production build.
    build(PROD_DIR, undefined, { ...process.env, VITE_TANGRAM_GALLERY: '1' });
    // The control.
    build(E2E_DIR, 'e2e', { ...process.env });
    server = await serve(PROD_DIR);
  });

  test.afterAll(async () => {
    await new Promise<void>((done) => {
      if (!server) return done();
      server.close(() => done());
    });
    rmSync(PROD_DIR, { recursive: true, force: true });
    rmSync(E2E_DIR, { recursive: true, force: true });
  });

  test('the control: an --mode e2e build DOES contain the gallery', () => {
    const carriers = emittedText(E2E_DIR).filter((path) =>
      readFileSync(path, 'utf8').includes(GALLERY_MARKER),
    );
    // Without this, every assertion below passes against a marker that no
    // build contains any more.
    expect(carriers.length).toBeGreaterThan(0);
  });

  test('no gallery module reaches a production build, even with the env var set', () => {
    const emitted = emittedText(PROD_DIR);
    expect(emitted.length).toBeGreaterThan(0);
    const offenders = emitted.filter((path) => readFileSync(path, 'utf8').includes(GALLERY_MARKER));
    expect(offenders).toEqual([]);
    // …and no chunk is named after it either. Weak on its own — this build
    // emits one `index-<hash>.js` with no code-splitting — but it is the
    // assertion that starts meaning something the day W6 splits the bundle.
    expect(emitted.map((path) => basename(path)).filter((name) => /gallery/i.test(name))).toEqual(
      [],
    );
  });

  /**
   * The drag-select harness goes with it (core.md C5a).
   *
   * It is a **top-level** route, outside `<Root>`, so it does not benefit from
   * the gallery's guard by accident — it carries the same one, and it has to,
   * because `ios.md` I2 opens it on a device and nothing else may.
   */
  test('the control: an --mode e2e build DOES contain the span-select harness', () => {
    const carriers = emittedText(E2E_DIR).filter((path) =>
      readFileSync(path, 'utf8').includes(HARNESS_PATH),
    );
    expect(carriers.length).toBeGreaterThan(0);
  });

  test('no span-select module reaches a production build', () => {
    const offenders = emittedText(PROD_DIR).filter((path) =>
      readFileSync(path, 'utf8').includes(HARNESS_PATH),
    );
    expect(offenders).toEqual([]);
  });

  test('requesting /span-select renders the not-found surface', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/span-select`);
    await expect(page.getByTestId('span-select-harness')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Go to Today' })).toBeVisible();
  });

  test('requesting /gallery renders the not-found surface, not the gallery', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/gallery`);
    await expect(page.getByTestId('gallery')).toHaveCount(0);
    // The way back, which both branches of `NotFoundRoute` render. The heading
    // is deliberately NOT asserted: in a production build an unmatched URL
    // currently reaches that component through the root `errorElement` with an
    // error defined, so it says "Something went wrong" rather than "Not found".
    // That is `web.md` W1's `src/routes/not-found.tsx`, it is the same for
    // `/nope` as for `/gallery`, and it is recorded in HANDOFF.md for web.md
    // rather than fixed here — asserting the wrong heading would freeze the
    // defect, and asserting the right one would fail for a reason that has
    // nothing to do with the gallery guard.
    await expect(page.getByRole('link', { name: 'Go to Today' })).toBeVisible();
  });

  test('the same server still serves the app, so the build itself is sound', async ({ page }) => {
    await page.goto(`http://localhost:${PORT}/lookup`);
    await expect(page.getByRole('heading', { name: 'Lookup' })).toBeVisible();
  });
});
