/**
 * "There is no API" as a first-class, visible state — against real builds.
 *
 * The first deployed build has no server behind it. Before this spec's phase,
 * `VITE_API_BASE` unset meant one `console.warn` and three AI features that
 * failed however their fetch layer happened to fail: ask with a raw status
 * line, example sentences with a generic one, free recall in silence, and the
 * `?key=` exchange reading the 404 as `unverified` — a good key called doubtful
 * forever. This spec builds the app twice more and holds each situation to
 * what the learner is now told:
 *
 *  1. **Not configured** — `VITE_API_BASE` empty in a production build. Every
 *     AI surface says so from first paint, with no spinner, no generic error
 *     and no retry (nothing the learner does changes a build-time fact). And
 *     the whole app — lookup, the reader, Practice, lists, the importer,
 *     backup, the AI surfaces too — makes **zero** requests to an API origin.
 *     That is asserted by recording every request the page makes, not inferred
 *     from reading imports.
 *  2. **Unreachable** — a base pointing at a port nothing listens on. The ask
 *     panel and the card back's sentences say the server did not answer, in a
 *     state visibly distinct from (1), and offer a retry that really asks
 *     again. Free recall stays quiet, on purpose: see `recall-input.tsx`.
 *
 * The third situation — a real base — is the rest of the suite, unchanged.
 *
 * **Why two more builds.** `VITE_API_BASE` is substituted at build time
 * (`src/access/client.ts`), so no serve-time switch can produce either state;
 * `access-gate.spec.ts` builds a second time for the same reason. Each costs
 * one `vite build`; both output directories are removed in `afterAll`. Ports
 * are the suite's `PORT` plus 130, 131 and 132 — clear of `access-gate`
 * (100, 111) and `origin-agnostic` (120, 121) — and the last is deliberately
 * left unbound, which `beforeAll` checks rather than assumes.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '../dict';

import { appRoot } from '../../../lib/server/roots';
import { DASUAN, openReview, readerContext, seed } from '../p2/fixtures';
import { ready, resetApp } from '../p3/helpers';
import { readText, token } from '../p5/helpers';

const SUITE_PORT = Number(process.env.PORT ?? 3000);
const NO_API_PORT = SUITE_PORT + 130;
const DEAD_APP_PORT = SUITE_PORT + 131;
/** Nothing listens here, by construction. */
const DEAD_API_PORT = SUITE_PORT + 132;
const NO_API_BASE = `http://127.0.0.1:${NO_API_PORT}`;
const DEAD_APP_BASE = `http://127.0.0.1:${DEAD_APP_PORT}`;
const DEAD_API_ORIGIN = `http://127.0.0.1:${DEAD_API_PORT}`;

const APP_ROOT = appRoot(fileURLToPath(new URL('.', import.meta.url)));
const WORKSPACE_ROOT = resolve(APP_ROOT, '..', '..');
/** Their own output directories, so the suite's `dist/` is untouched. `.gitignore`d. */
const NO_API_OUT = 'dist-no-api';
const DEAD_OUT = 'dist-dead-api';

const SECRET = 'e2e-no-api-key-4c1d';

const servers: ChildProcess[] = [];

async function waitFor(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** Resolves true if something accepts a TCP connection on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

function build(outDir: string, apiBase: string): void {
  const result = spawnSync(
    resolve(APP_ROOT, 'node_modules/.bin/vite'),
    ['build', '--outDir', outDir],
    {
      cwd: APP_ROOT,
      // Set explicitly, empty string included: Vite lets the process
      // environment win over `.env*` files, so this is the value baked in
      // whatever the caller's shell happens to carry.
      env: { ...process.env, VITE_API_BASE: apiBase },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`the ${outDir} build failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
}

function serve(outDir: string, port: number): ChildProcess {
  const server = spawn(
    resolve(APP_ROOT, 'node_modules/.bin/tsx'),
    [resolve(WORKSPACE_ROOT, 'scripts/preview.ts')],
    {
      cwd: APP_ROOT,
      env: { ...process.env, PORT: String(port), TANGRAM_PREVIEW_OUT_DIR: outDir },
      stdio: 'ignore',
    },
  );
  servers.push(server);
  return server;
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  expect(await listening(DEAD_API_PORT), `port ${DEAD_API_PORT} must be free`).toBe(false);

  build(NO_API_OUT, '');
  build(DEAD_OUT, DEAD_API_ORIGIN);
  serve(NO_API_OUT, NO_API_PORT);
  serve(DEAD_OUT, DEAD_APP_PORT);
  await Promise.all([waitFor(`${NO_API_BASE}/offline.html`), waitFor(`${DEAD_APP_BASE}/offline.html`)]);
});

test.afterAll(() => {
  for (const server of servers) server.kill('SIGTERM');
  rmSync(resolve(APP_ROOT, NO_API_OUT), { recursive: true, force: true });
  rmSync(resolve(APP_ROOT, DEAD_OUT), { recursive: true, force: true });
});

/**
 * Every request the page makes from this point on, from the page and from its
 * workers (the dictionary's lives in one).
 */
function record(page: Page): string[] {
  const urls: string[] = [];
  // Chromium reports a dedicated worker's fetches on the page that owns it.
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

/**
 * A request to an API origin, for a build with no base: anything under
 * `/api/`, on any origin, and anything that leaves the app's own origin at all
 * — a bundle with no base has no business with a second one.
 */
function apiRequests(urls: readonly string[], appOrigin: string): string[] {
  return urls.filter((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return false;
    const parsed = new URL(url);
    return parsed.origin !== appOrigin || parsed.pathname.startsWith('/api/');
  });
}

async function lookUp(page: Page, query: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('lookup-input').fill(query);
  await expect(page.getByTestId('search-result').first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('search-result').first().click();
  await expect(page.getByTestId('entry-detail')).toBeVisible();
}

/** A due card with free recall on, and the recall box on screen. */
async function dueCardWithRecall(page: Page): Promise<void> {
  await openReview(page);
  await page.evaluate(() =>
    window.__tangram.repo.setSettings({ freeRecall: true, examplesOnBack: true }),
  );
  await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 }]);
  await expect(page.getByTestId('recall-answer')).toBeVisible({ timeout: 30_000 });
}

test.describe('built with VITE_API_BASE empty: not configured', () => {
  test.use({ baseURL: NO_API_BASE, dictionary: 'installed' });
  test.setTimeout(240_000);

  test('every AI surface says so, and nothing anywhere asks an API', async ({ page }) => {
    const urls = record(page);

    // --- Look up, and the ask panel.
    await resetApp(page, { newPerDay: 0 });
    await lookUp(page, '打算');
    const panel = page.getByTestId('ask-panel');
    await expect(panel).toHaveAttribute('data-api', 'not-configured');
    await expect(panel).toHaveAttribute('data-ask-state', 'unavailable');
    await expect(page.getByTestId('ask-not-configured-chip')).toHaveText('Dictionary only');
    await expect(panel.getByTestId('ask-status')).toContainText('not set up');
    await expect(page.getByTestId('ask-retry')).toHaveCount(0);
    await expect(page.getByTestId('ask-offline-badge')).toHaveCount(0);
    await expect(panel).not.toContainText('Thinking about');
    await expect(panel).not.toContainText(/HTTP \d{3}|unverified|could not answer/i);
    // The dictionary half, and the add, are untouched.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');

    // --- The reader, and a tap on a word. The in-context gloss does not ask
    // and does not draw; the reader never mentions the API.
    await readText(page, '我打算明天去北京。');
    await token(page, '打算').click();
    await expect(page.getByTestId('entry-detail')).toBeVisible();
    await expect(page.getByTestId('context-gloss')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('not set up');

    // --- Practice. Both card features are on in the stored settings — the
    // sentences by default, free recall as a backup from a build with an API
    // would carry it — and neither is drawn: this build does not offer their
    // toggles, so it does not honour them either, or they would be on every
    // card with no way to turn them off.
    await openReview(page);
    await page.evaluate(() =>
      window.__tangram.repo.setSettings({ freeRecall: true, examplesOnBack: true }),
    );
    await seed(page, [{ entry: DASUAN, context: readerContext(), gradedDaysAgo: 30 }]);
    await expect(page.getByTestId('review-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('recall-answer')).toHaveCount(0);
    await page.getByTestId('reveal').click();
    await expect(page.getByTestId('card-back')).toBeVisible();
    await expect(page.getByTestId('example-sentences')).toHaveCount(0);
    // Grading is unaffected.
    await page.keyboard.press('3');
    await expect(page.getByTestId('review-empty')).toBeVisible();

    // --- Library: lists, the importer and a backup.
    await page.goto('/library');
    await ready(page);
    // The settings are there, and the two toggles for model-backed features
    // are not: this build can never serve either.
    await expect(page.getByTestId('settings-new-per-day')).toBeVisible();
    await expect(page.getByTestId('settings-card-toggles')).toHaveCount(0);
    await expect(page.getByTestId('settings-examples-on-back')).toHaveCount(0);
    await expect(page.getByTestId('settings-free-recall')).toHaveCount(0);
    await page.getByTestId('import-open').click();
    await page.getByLabel('Words to import').fill('你好\n');
    await page.getByLabel('Imported list name').fill('No API');
    await page.getByTestId('import-preview').click();
    await expect(page.getByTestId('import-row')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('import-submit').click();
    await expect(page.getByTestId('import-result')).toContainText('Added 1 word');
    const download = page.waitForEvent('download');
    await page.getByTestId('backup-download').click();
    await download;

    expect(apiRequests(urls, NO_API_BASE)).toEqual([]);
    // And the recorder was genuinely recording: the app fetched its own files.
    expect(urls.some((url) => url.startsWith(NO_API_BASE))).toBe(true);
  });

  test('a key is kept and reported as `no-api`, not as bad or unverified', async ({ page }) => {
    const urls = record(page);
    await page.goto(`/?key=${SECRET}`);
    await expect(page).toHaveURL(/[?&]access=no-api(&|$)/);
    expect(page.url()).not.toContain(SECRET);
    expect(await page.evaluate(() => localStorage.getItem('tangram.access.secret'))).toBe(SECRET);
    expect(apiRequests(urls, NO_API_BASE)).toEqual([]);
  });
});

test.describe('built with a base nothing listens on: unreachable', () => {
  test.use({ baseURL: DEAD_APP_BASE, dictionary: 'installed' });
  test.setTimeout(240_000);

  const toDeadApi = (urls: readonly string[]) =>
    urls.filter((url) => url.startsWith(DEAD_API_ORIGIN)).length;

  test('the ask panel says the server did not answer, and its retry asks again', async ({
    page,
  }) => {
    const urls = record(page);
    await resetApp(page, { newPerDay: 0 });
    await lookUp(page, '打算');

    const panel = page.getByTestId('ask-panel');
    await expect(panel).toHaveAttribute('data-api', 'unreachable', { timeout: 40_000 });
    await expect(panel.getByTestId('ask-status')).toContainText('Could not reach');
    // Distinct from not-configured: a different chip, and a retry.
    await expect(page.getByTestId('ask-not-configured-chip')).toHaveCount(0);
    await expect(page.getByTestId('ask-offline-chip')).toBeVisible();
    // A failed handshake is not the fake provider: no "set ANTHROPIC_API_KEY".
    await expect(page.getByTestId('ask-offline-badge')).toHaveCount(0);
    await expect(panel).not.toContainText(/HTTP \d{3}|unverified/i);

    const before = toDeadApi(urls);
    expect(before).toBeGreaterThan(0);
    await page.getByTestId('ask-retry').click();
    // The retry really starts over — the panel leaves the unreachable state
    // at once (the debounce holds "Thinking…" for half a second) — and really
    // asks the dead origin again, and lands back where it was.
    await expect(panel).toHaveAttribute('data-ask-state', 'thinking');
    await expect(panel).not.toHaveAttribute('data-api', 'unreachable');
    await expect.poll(() => toDeadApi(urls)).toBeGreaterThan(before);
    await expect(panel).toHaveAttribute('data-api', 'unreachable', { timeout: 40_000 });

    // The dictionary half is untouched throughout.
    await page.getByTestId('add-card').click();
    await expect(page.getByTestId('add-state')).toContainText('Added');
  });

  test('the card back says so with a retry; free recall stays quiet', async ({ page }) => {
    const urls = record(page);
    await dueCardWithRecall(page);
    await page.getByTestId('recall-answer').fill('to plan');
    await page.getByTestId('recall-answer').press('Enter');
    await expect(page.getByTestId('card-back')).toBeVisible();

    // Recall: the ordinary quiet line, no retry — a control mid-card is an
    // interruption, and this failure may be gone by the next card.
    const recall = page.getByTestId('recall-no-suggestion');
    await expect(recall).toHaveAttribute('data-api', 'ok');
    await expect(recall).toContainText('No suggestion this time');

    const examples = page.getByTestId('example-sentences');
    await expect(examples).toHaveAttribute('data-api', 'unreachable', { timeout: 40_000 });
    await expect(examples.getByTestId('examples-status')).toContainText('Could not reach');
    const before = toDeadApi(urls);
    await page.getByTestId('examples-retry').click();
    await expect.poll(() => toDeadApi(urls)).toBeGreaterThan(before);
    await expect(examples).toHaveAttribute('data-api', 'unreachable', { timeout: 40_000 });

    // Grading still works after a retry.
    await page.keyboard.press('3');
    await expect(page.getByTestId('review-empty')).toBeVisible();
  });

  test('Library still offers the two AI toggles: a server that is down is transient', async ({
    page,
  }) => {
    await page.goto('/library');
    await expect(page.getByTestId('settings-examples-on-back')).toBeVisible();
    await expect(page.getByTestId('settings-free-recall')).toBeVisible();
  });

  test('a key is kept and reported as `unreachable`, not as unverified', async ({ page }) => {
    await page.goto(`/?key=${SECRET}`);
    await expect(page).toHaveURL(/[?&]access=unreachable(&|$)/, { timeout: 30_000 });
    expect(await page.evaluate(() => localStorage.getItem('tangram.access.secret'))).toBe(SECRET);
  });
});
