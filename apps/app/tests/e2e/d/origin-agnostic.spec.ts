/**
 * The build carries no absolute-origin assumption (docs/plans/web.md W9, docs/desktop.md).
 *
 * **What this is for.** Desktop v1 is the installed PWA from this same `dist/`,
 * and if a Tauri shell is ever built it must be a packaging job rather than a
 * porting job — the same requirement Capacitor already has. Both serve `dist/`
 * from the root of an origin that is not the one it was built on:
 * `tauri://localhost/`, `capacitor://localhost/`, `http://localhost` on Android.
 * So the build may not assume it knows its own scheme, host or port, and — the
 * sharper half — it may not assume it is at the document root either, because a
 * path that is hard-coded to `/` is the same class of mistake one layer down.
 *
 * `web.md` W1 ran both checks by hand, once. W9's criterion is that they become
 * **standing**: a spec `pnpm e2e` runs at every phase gate. There is no CI in
 * this repository and no plan in the set creates one, so a check nobody runs is
 * a check that does not exist.
 *
 * **Two halves, and the second one is the one with teeth.**
 *
 *  1. The default build, served from a second port. Proves the app boots on an
 *     origin it was not built for, asks nothing of the origin it was, and — the
 *     control for the second half — that its service worker really does register
 *     when the base is `/`.
 *  2. A second build made with `--base=/sub/`, served behind a `/sub/` prefix.
 *     Everything the app fetches has to move with the base: the entry chunk and
 *     stylesheet, the twenty-five `unicode-range` font slices W6 delivers
 *     through the module graph, the sqlite wasm binary and its worker, and the
 *     dictionary's *content-addressed* artifact — whose filename the app reads
 *     out of `dict-manifest.json` at runtime, so both the pointer and the file
 *     it names have to be base-relative. A spec that only asserted "the document
 *     loaded" would miss every one of those, and those are exactly what an
 *     absolute-origin assumption breaks.
 *
 * **The documented boundary, named in full, because a partial list is worse than
 * none.** Four things here are rooted at `/` by construction, and a real
 * subdirectory deployment would have to parameterise all four:
 *
 *  - `components/pwa/register-sw.tsx` — `SW_URL` is `/sw.js`, registered with
 *    `scope: '/'`.
 *  - `scripts/sw.template.js` **and** `scripts/build-sw.ts` — the worker's five
 *    path rules, its `/offline.html`, its `cache.match('/')` document fallback,
 *    and `precacheList()`'s `['/', '/offline.html', '/<hashed asset>']`.
 *  - `public/manifest.webmanifest` — `id`, `start_url`, `scope` and all five
 *    `icons[].src`. It is copied verbatim, so a `--base` never reaches it;
 *    `tests/unit/pwa/manifest.test.ts` pins those fields.
 *  - `apps/app/vercel.json` — every `source` is `/`-anchored, including the
 *    `no-cache` on `dict-manifest.json` and the `immutable` on the artifact. A
 *    subpath deploy matches none of them, which is how the pointer at a 43 MB
 *    file becomes cacheable. The in-process hosts below apply no header rules,
 *    so nothing in this spec can observe that half.
 *
 * None of it reaches a native shell — the worker is deliberately not registered
 * inside one, no native shell reads a web manifest, and `vercel.json` is the web
 * host's — and none of it affects a root deploy, which is the only web deploy
 * this project has. So the subpath case allows `/sw.js` **by name** and asserts
 * that nothing else escapes the prefix: a genuinely new root-absolute path fails
 * the suite instead of hiding behind the four above.
 *
 * **Cost, stated because it is charged to every `pnpm e2e` run from here on:**
 * one extra `vite build` (1.3 s measured) and a transient 67 MB `dist-sub`,
 * which is a second copy of `public/` — the 43 MB dictionary and its 17 MB
 * brotli sibling. `afterAll` removes it, the way `access-gate.spec.ts` disposes
 * of `dist-gated`; a leftover matters less for the disk than for `pnpm lint` and
 * the unit suite's directory walkers, which would read it as source.
 *
 * The two static servers are in-process rather than spawned: they serve files
 * and answer an SPA fallback, and an in-process server cannot be orphaned by a
 * failed run. Their ports are the suite's `PORT` plus 120 and 121 — clear of
 * `access-gate.spec.ts`, which takes `PORT + 100` and `PORT + 111`.
 *
 * **Every `page.goto` below writes its origin and its prefix out in full** rather
 * than interpolating a base constant. `tests/unit/shell/tab-routes.test.ts` reads
 * every `goto(...)` literal in this directory as *text* and checks the path
 * against the tab model — the guard that stops a spec quietly navigating to a
 * route that no longer exists. A target beginning with an interpolation is a
 * path it cannot read, so it would pass by being illegible.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { MANIFEST_FILE, type DictManifest } from '../../../lib/dict/artifact';
import { appRoot } from '../../../lib/server/roots';

const APP_ROOT = appRoot(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT ?? 3000);
/** The suite's own origin. Nothing served below may ever ask it for anything. */
const SUITE_ORIGIN = `http://localhost:${PORT}`;

const SECOND_PORT = PORT + 120;
const SUBPATH_PORT = PORT + 121;
const SECOND_BASE = `http://127.0.0.1:${SECOND_PORT}`;
const SUBPATH_BASE = `http://127.0.0.1:${SUBPATH_PORT}`;
const PREFIX = '/sub';
/** Its own output directory, so the suite's `dist/` is untouched. `.gitignore`d. */
const SUB_OUT_DIR = 'dist-sub';
/** The one root-absolute path this build is allowed to ask for. See the header. */
const ROOT_SCOPED = new Set(['/sw.js']);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** A host, plus what it was asked for and would not serve. */
interface Host {
  server: Server;
  /** Pathnames matching `DENIED` that reached this host, in order. */
  refused: string[];
  /** Pathnames that fell outside the prefix and were 404'd, in order. */
  outside: string[];
}

/**
 * The dictionary artifact, refused by the host rather than fetched.
 *
 * The spec asserts the URL the app *asks* for; the 43 MB import itself is
 * `d/dict-wasm.spec.ts`'s, at the root base. Serving those bytes here would add
 * tens of megabytes to every `pnpm e2e` run with no assertion behind them — and
 * refusing at the host is also the stronger evidence, because a pathname in
 * `refused` reached a socket, where a browser-side route only proves the page
 * announced an intention. (`page.route` does not see it at all: the fetch is
 * made from the dictionary's dedicated worker.)
 */
const DENIED = /^\/dict-.+\.sqlite(\.br)?$/;

/**
 * A static host with an SPA fallback, optionally mounted under a prefix.
 *
 * The prefix is what makes the second half a real test: a request that leaves
 * `/sub/` gets a 404 from here rather than being quietly answered, which is
 * exactly how a subdirectory deployment behaves and is not how `vite preview`
 * behaves.
 *
 * **A path carrying a file extension 404s rather than falling back.**
 * `apps/app/vite-plugins/headers.ts` exists because a host that answers every
 * miss with `index.html` made W2's "delete the entry chunk and watch it fail"
 * criterion unprovable — a build with no entry chunk passed everything. The same
 * leniency here would mask a wrong-but-inside-the-prefix asset path as a 200
 * HTML body, so the exclusion mirrors `vercel.json`'s own SPA rewrite.
 */
function staticHost(root: string, prefix: string, port: number): Promise<Host> {
  const refused: string[] = [];
  const outside: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // A malformed escape (`%zz`) throws, and an uncaught throw in this handler
      // takes the Playwright worker with it.
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end('bad path');
      return;
    }
    if (prefix) {
      if (pathname === prefix) {
        response.writeHead(302, { location: `${prefix}/` });
        response.end();
        return;
      }
      if (!pathname.startsWith(`${prefix}/`)) {
        outside.push(pathname);
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end(`outside ${prefix}`);
        return;
      }
      pathname = pathname.slice(prefix.length);
    }
    if (DENIED.test(pathname)) {
      refused.push(`${prefix}${pathname}`);
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('the dictionary artifact is not served to this spec');
      return;
    }
    // `normalize` on a leading-slash path cannot escape `root`: `/../x` -> `/x`.
    const file = join(root, normalize(pathname));
    let target = file;
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (/\.[A-Za-z0-9]+$/.test(pathname)) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('no such file');
        return;
      }
      target = join(root, 'index.html');
    }
    response.writeHead(200, {
      // Derived from what is actually served rather than from what was asked
      // for, so an SPA fallback is `text/html` and not the requested extension.
      'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    });
    const stream = createReadStream(target);
    // `apps/app/vite-plugins/dict-assets.ts` carries the post-mortem: a `pipe`
    // with no error handler leaves `error` unhandled, and an unhandled stream
    // `error` THROWS in the Node process — here the Playwright worker, which
    // takes every later spec in the run with it and points back at nothing.
    stream.on('error', () => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('read failed');
    });
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  return new Promise((ready, failed) => {
    server.on('error', failed);
    server.listen(port, '127.0.0.1', () => ready({ server, refused, outside }));
  });
}

function close(host: Host | undefined): Promise<void> {
  if (!host) return Promise.resolve();
  return new Promise((done) => {
    host.server.closeAllConnections();
    host.server.close(() => done());
  });
}

/**
 * Every URL this page's context asked for, in order, including the ones that
 * failed.
 *
 * **On the context, not the page**, and that is the difference between a check
 * and a decoration: Playwright reports a **service worker's own script fetch on
 * the context only**. Recording on the page would hide the one root-absolute
 * request this build actually makes, so the spec would pass by not looking
 * rather than by the boundary being where it says it is. Dedicated-worker
 * fetches — the dictionary's, and the sqlite wasm binary — are reported either
 * way.
 */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.context().on('request', (request) => urls.push(request.url()));
  return urls;
}

let secondHost: Host | undefined;
let subpathHost: Host | undefined;

test.beforeAll(async () => {
  test.setTimeout(600_000);

  // `dist/` is the suite webServer's build and this file reads it three times.
  // `playwright.config.ts` sets `reuseExistingServer: true`, so a server already
  // answering on $PORT means `pnpm -w run build:e2e` never ran — and a missing
  // `dist/` should say that here rather than surface as an empty page.
  const dist = resolve(APP_ROOT, 'dist');
  if (!existsSync(join(dist, 'index.html')) || !existsSync(join(dist, 'assets'))) {
    throw new Error(
      `${dist} holds no build. The suite's webServer normally makes one; with ` +
        '`reuseExistingServer` and something already on $PORT it does not. Run `pnpm -w run build:e2e`.',
    );
  }

  // The subpath build. `--mode e2e` so it is the same build the suite serves in
  // every other respect — the e2e-only routes and `.env.e2e`'s `VITE_API_BASE`
  // — with the base as the single variable.
  //
  // It is `vite build` alone rather than the app's `build:e2e`, so it runs
  // neither `dict:copy` (the artifacts are already in `public/`, which this
  // copies) nor `pnpm sw` (which writes only into `public/` and `dist/`).
  // **`dist-sub/sw.js` is therefore the root build's worker**, stamped over the
  // root build's bytes and precaching its asset hashes. Nothing fetches it —
  // the registration under a prefix asks for a `/sw.js` that is not there — but
  // the day the worker becomes base-aware, this is the line to read.
  const build = spawnSync(
    resolve(APP_ROOT, 'node_modules/.bin/vite'),
    ['build', '--mode', 'e2e', `--base=${PREFIX}/`, '--outDir', SUB_OUT_DIR],
    { cwd: APP_ROOT, encoding: 'utf8' },
  );
  if (build.status !== 0) {
    throw new Error(`the ${PREFIX}/ build failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
  }

  secondHost = await staticHost(dist, '', SECOND_PORT);
  subpathHost = await staticHost(resolve(APP_ROOT, SUB_OUT_DIR), PREFIX, SUBPATH_PORT);
});

test.afterAll(async () => {
  await close(secondHost);
  await close(subpathHost);
  // The second build goes with the run that made it, the way
  // `core/gallery-excluded.spec.ts` disposes of its two.
  rmSync(resolve(APP_ROOT, SUB_OUT_DIR), { recursive: true, force: true });
});

test.describe('the default build, on an origin it was not built for', () => {
  // Two servers, a browser and a 67 MB tree of static files. Every sibling spec
  // in this directory raises the per-test timeout (180 s in `dict-ask`,
  // `dict-offline` and `access-gate`); `test.setTimeout` inside `beforeAll`
  // raises only that hook, so it has to be said here too.
  test.setTimeout(180_000);

  test('boots, and asks the origin it was built on for nothing', async ({ page }) => {
    const urls = recordRequests(page);

    await page.goto(`http://127.0.0.1:${SECOND_PORT}/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    // A deep route too: the SPA fallback answers it with the same document, and
    // that document's root-absolute asset URLs have to resolve from a nested
    // path. This is the same property `d/spa-fallback.spec.ts` asserts against
    // the preview server; here it is asserted on a different origin, which is
    // the half a single-origin run cannot see.
    await page.goto(`http://127.0.0.1:${SECOND_PORT}/library/lists/does-not-exist-yet`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    // A list page, headed with the list's name — and there is no such list.
    await expect(page.getByRole('heading', { level: 1, name: 'List not found' })).toBeVisible();

    const strays = urls.filter((url) => new URL(url).origin === SUITE_ORIGIN);
    expect(strays, 'nothing may be fetched from the origin the build was made on').toEqual([]);
  });

  test('registers its service worker here, which is the control for the prefix case', async ({
    page,
  }) => {
    // The subpath case asserts that NO worker registers, and an absence proves
    // nothing without the presence beside it: if registration were broken
    // everywhere — a bad path, a 500 on `/sw.js`, a `shouldRegister` regression
    // — that assertion would still be green and would be asserting the wrong
    // reason. `http://127.0.0.1` is a secure context, so a production build
    // registers here exactly as it does over https.
    await page.goto(`http://127.0.0.1:${SECOND_PORT}/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    const scriptURL = await page.evaluate(async () => {
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((done) => setTimeout(() => done(null), 30_000)),
      ]);
      if (!registration) return null;
      return registration.active?.scriptURL ?? registration.installing?.scriptURL ?? 'registered';
    });
    expect(scriptURL, 'no worker registered at the root base').not.toBeNull();
    expect(scriptURL).toContain('/sw.js');
  });

  test('reaches exactly two origins: itself, and the configured API base', async ({ page }) => {
    const urls = recordRequests(page);
    await page.goto(`http://127.0.0.1:${SECOND_PORT}/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    const apiBase = configuredApiBase();
    const origins = new Set(urls.map((url) => new URL(url).origin));
    for (const origin of origins) {
      expect([SECOND_BASE, apiBase], `unexpected origin ${origin}`).toContain(origin);
    }
    // The page's own origin is always in there; the assertion above is only
    // meaningful because this one proves the set was not empty.
    expect(origins.has(SECOND_BASE)).toBe(true);
  });

  test('bakes in no origin of its own beyond the configured API base', async () => {
    // The runtime checks see only the paths a boot happens to touch. This one
    // reads every text file the build emitted — the entry document and the
    // service worker included, not just `assets/` — because W9's wording is "no
    // hard-coded scheme, host or port **anywhere** in the app or its assets". A
    // `http(s)://<local host>:<port>` literal is either the API base the build
    // was *told* about, or a development origin somebody hard-coded, and the
    // second is the one a shell cannot survive: `capacitor://localhost` and
    // `tauri://localhost` have no dev server behind them. React Router carries a
    // bare `http://localhost` with no port as a URL-parsing fallback, which is
    // why the pattern requires a port.
    //
    // A subset rather than an equality: a production build points at a real API
    // domain and would legitimately hold no local origin at all. What is
    // asserted is that nothing local got in that was not asked for.
    const apiBase = configuredApiBase();
    const scanned = textFiles(resolve(APP_ROOT, 'dist'));
    const found = new Map<string, string>();
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/g)) {
        found.set(match[0], file);
      }
    }
    // A scan of nothing passes trivially, so the scan itself is asserted.
    expect(scanned.length, 'no JS, CSS or HTML was scanned — has dist/ moved?').toBeGreaterThan(0);
    for (const [origin, file] of found) {
      expect([apiBase], `baked-in origin ${origin} in ${file}`).toContain(origin);
    }
  });
});

test.describe(`the ${PREFIX}/ build, behind its prefix`, () => {
  test.setTimeout(180_000);

  test('boots, and routes from the base rather than from the root', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${SUBPATH_PORT}/sub/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    // The router's `basename` is `import.meta.env.BASE_URL` (src/main.tsx).
    // Without it React Router matches `/sub/` against `/`, finds nothing and
    // renders its own 404 — every asset 200, page blank. Every in-app link
    // carrying the prefix is the observable form of that being right.
    const hrefs = await page
      .locator('a[href^="/"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href.startsWith(`${PREFIX}/`), href).toBe(true);

    // And it navigates: a click has to land on a prefixed URL, not on `/practice`.
    await page.getByRole('link', { name: 'Practice' }).first().click();
    await expect(page).toHaveURL(`${SUBPATH_BASE}${PREFIX}/practice`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  test('a deep route under the prefix boots from its own document', async ({ page }) => {
    // The three-way interaction `vite.config.ts` spends fifteen lines on: base,
    // SPA fallback and a nested path, which is the configuration where it is
    // hardest. The document comes back from the fallback and its script URL
    // must still be `/sub/assets/…`; resolve it relative to the document
    // instead and the fallback answers the script with HTML and nothing boots.
    await page.goto(`http://127.0.0.1:${SUBPATH_PORT}/sub/library/lists/does-not-exist-yet`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    // A list page, headed with the list's name — and there is no such list.
    await expect(page.getByRole('heading', { level: 1, name: 'List not found' })).toBeVisible();
  });

  test('fetches its code, its fonts and its wasm from under the prefix', async ({ page }) => {
    const urls = recordRequests(page);
    await page.goto(`http://127.0.0.1:${SUBPATH_PORT}/sub/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    // The font slices and the sqlite worker are fetched after first paint.
    await page.waitForLoadState('networkidle');

    const paths = urls
      .filter((url) => url.startsWith(SUBPATH_BASE))
      .map((url) => new URL(url).pathname);
    const escaped = paths.filter((path) => !path.startsWith(`${PREFIX}/`) && !ROOT_SCOPED.has(path));
    expect(escaped, `every same-origin request must stay under ${PREFIX}/`).toEqual([]);

    // Named individually, because "nothing escaped" is also true of a page that
    // fetched nothing. W6 delivers the fonts through the module graph precisely
    // so the base moves them; the wasm binary is located with a URL relative to
    // its own module. Both are assertions about someone else's phase holding.
    expect(paths.some((path) => path.endsWith('.js')), 'an entry chunk').toBe(true);
    expect(paths.some((path) => path.endsWith('.css')), 'a stylesheet').toBe(true);
    expect(paths.some((path) => path.endsWith('.woff2')), 'a font slice').toBe(true);
    expect(paths.some((path) => path.endsWith('.wasm')), 'the sqlite binary').toBe(true);
  });

  test("the stylesheet's every url() is base-relative", async () => {
    // The runtime check above sees only the slices this boot happened to need —
    // two, of the twenty-five W6 cuts, because `unicode-range` is doing its job.
    // The other twenty-three are only visible here.
    const assets = resolve(APP_ROOT, SUB_OUT_DIR, 'assets');
    const css = readdirSync(assets).filter((name) => name.endsWith('.css'));
    expect(css.length).toBeGreaterThan(0);

    const urls: string[] = [];
    for (const name of css) {
      const text = readFileSync(join(assets, name), 'utf8');
      for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) urls.push(match[1]);
    }
    expect(urls.length, 'W6 self-hosts 25 font slices; a stylesheet with no url() is a red flag')
      .toBeGreaterThan(20);
    for (const url of urls) {
      // Not `data:`, not an absolute origin, and not rooted above the base.
      expect(url.startsWith(`${PREFIX}/`), url).toBe(true);
    }
  });

  test("the dictionary's manifest and its content-addressed artifact are under the prefix", async ({
    page,
  }) => {
    // What is under test is `lib/dict/asset-url.ts` prefixing
    // `import.meta.env.BASE_URL`, not the import — `d/dict-wasm.spec.ts` does
    // the import, at the root base. Without the prefix the fetch reaches outside
    // the deploy and an SPA fallback answers it with HTML and a 200 — a
    // dictionary that reports itself corrupt, truthfully and uselessly.
    //
    // Two things have to move together and both are asserted, because they fail
    // differently: `dict-manifest.json`, the pointer, and the content-addressed
    // filename it names, which is a literal nowhere in the app. The glob matches
    // a root-absolute request too, so a regression fails the pathname assertion
    // rather than timing out with nothing to read.
    const artifact = JSON.parse(
      readFileSync(resolve(APP_ROOT, SUB_OUT_DIR, MANIFEST_FILE), 'utf8'),
    ) as DictManifest;

    const manifestRequest = page.waitForRequest(`**/${MANIFEST_FILE}`, { timeout: 60_000 });

    await page.goto(`http://127.0.0.1:${SUBPATH_PORT}/sub/`);
    await page.getByRole('button', { name: /get it/i }).first().click();

    expect(new URL((await manifestRequest).url()).pathname).toBe(`${PREFIX}/${MANIFEST_FILE}`);
    await expect
      .poll(() => subpathHost?.refused ?? [], {
        message: 'the artifact was never requested',
        timeout: 60_000,
      })
      .toContain(`${PREFIX}/${artifact.file}`);
    // The other half, and this one can fail: a request that left the prefix
    // never reaches the deny rule — it 404s — so a `dict-` path in the host's
    // out-of-prefix log is exactly the regression this test exists to catch.
    expect(
      subpathHost?.outside.filter((path) => path.includes('dict-')),
      'a dictionary path escaped the prefix',
    ).toEqual([]);
  });

  test('no service worker registers, which is the boundary this build has', async ({ page }) => {
    // Documented, not accidental: `SW_URL` is `/sw.js`, its scope is `/`, and
    // the worker's own rules, `precacheList()` and `vercel.json` are rooted the
    // same way (see the header). Under a prefix the registration asks for a file
    // that is not there and fails — silently, by design, because a missing
    // worker is a missing enhancement.
    //
    // **`getRegistrations()`, not `controller`.** A null `controller` is also
    // what you see while a perfectly good worker is still installing, so a
    // `controller === null` assertion would go green on a loaded container even
    // after someone made `SW_URL` base-relative — passing by winning a race in
    // the direction that hides the change. An empty registration list cannot be
    // explained that way, and the control is the root-base test above.
    await page.goto(`http://127.0.0.1:${SUBPATH_PORT}/sub/`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

    await expect
      .poll(
        () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
        { message: 'a worker registered under the prefix', timeout: 15_000 },
      )
      .toBe(0);
    // The app is fully usable without it — the point of the whole exercise is
    // that nothing on the critical path depends on a browser-only convenience.
    await expect(page.getByRole('heading', { name: 'Look up' }).first()).toBeVisible();
  });
});

/** Every text file the build emitted, recursively. Binaries are not scanned. */
function textFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) textFiles(full, out);
    else if (/\.(js|css|html|webmanifest)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * `VITE_API_BASE` as the e2e build was given it.
 *
 * Read from `.env.e2e` rather than hard-coded, because that file is what
 * `vite build --mode e2e` loads and a spec that carried its own copy would agree
 * with itself after somebody changed the real one.
 */
function configuredApiBase(): string {
  const text = readFileSync(resolve(APP_ROOT, '.env.e2e'), 'utf8');
  const match = text.match(/^\s*VITE_API_BASE\s*=\s*(\S+)\s*$/m);
  if (!match) throw new Error('apps/app/.env.e2e no longer declares VITE_API_BASE');
  return new URL(match[1]).origin;
}
