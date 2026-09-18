/**
 * The access gate, against the real server with the secret actually set
 * (docs/plans/web.md W4, docs/plans/backend.md B1).
 *
 * The rest of the suite runs with `TANGRAM_ACCESS_SECRET` unset, which is the
 * point — the gate must be invisible without it. So this spec stands up its own
 * pair: a second **`apps/server`** with the variable set, and a second app build
 * pointed at it.
 *
 * **Why a second build, and why that is not overkill.** `VITE_API_BASE` is
 * substituted at build time (`apps/app/src/access/client.ts`), and the suite's
 * main build points at the *ungated* API on 8787. The `?key=` exchange decides
 * `granted` / `denied` by reading the **status** of a probe to that base, so
 * against an ungated API a wrong key would come back 200 and nothing would ever
 * be revoked. Building once more, into `dist-gated`, is what makes the two
 * browser cases below mean anything. It costs one `vite build`; the dictionary
 * and the service worker come along in `public/`, which is why `/sw.js` and
 * `/dict-manifest.json` are still assertable here.
 *
 * **What B1 changed, and it is the whole reason this file was rewritten.**
 * Until B1 the API was mounted on the app's own origin by a dev/preview adapter,
 * and the cross-origin block at the bottom stood up a **hand-written stub**
 * server to play the part of `backend.md`'s. Both are gone: there is a real
 * server now, it is on a real second origin, and the preflight, the allowlist
 * and the 401 below are its own. A stub that agrees with the implementation is
 * not evidence about the implementation.
 *
 * **What was missing between W1 and W4 is back.** `middleware.ts` did the
 * `?key=` → cookie exchange and Next invoked it; there is no middleware in a
 * static SPA, so for two phases there was no way to authorise a device at all.
 * The three assertions W1 removed, each restored here through the new
 * mechanism:
 *
 *  1. `?key=<secret>` → the key stripped out of the URL, `access=granted` left
 *     behind, and the credential stored.   → `authorises a device`
 *  2. A wrong `?key=` → `access=denied`, and any stored credential **revoked**.
 *                                          → `revokes on a wrong key`
 *  3. The credential, once held, admitting a POST to `/api/ask`.
 *                                          → `admits the paid routes`
 *
 * The first two are now a page rewriting its own URL rather than a 303, so they
 * are driven in the browser; the middleware's redirect is gone with the
 * middleware.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCESS_HEADER } from '@tangram/access';

import { appRoot } from '../../../lib/server/roots';

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';

const SECRET = 'e2e-access-secret-9f3a';
const PORT = Number(process.env.PORT ?? 3000) + 100;
const API_PORT = PORT + 11;
const BASE = `http://127.0.0.1:${PORT}`;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const REPO_ROOT = appRoot(fileURLToPath(new URL('.', import.meta.url)));
const WORKSPACE_ROOT = resolve(REPO_ROOT, '..', '..');
/** Its own output directory, so the suite's `dist/` is untouched. `.gitignore`d. */
const OUT_DIR = 'dist-gated';

let appServer: ChildProcess | undefined;
let apiServer: ChildProcess | undefined;
let api: APIRequestContext;

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

test.beforeAll(async () => {
  test.setTimeout(600_000);

  // 1 — the gated API. The bundle `pnpm -F server build` already produced; the
  // main webServer entry built it, and rebuilding here would race that.
  apiServer = spawn(process.execPath, [resolve(WORKSPACE_ROOT, 'apps/server/dist/index.js')], {
    cwd: WORKSPACE_ROOT,
    env: {
      ...process.env,
      TANGRAM_ACCESS_SECRET: SECRET,
      TANGRAM_SERVER_PORT: String(API_PORT),
      // The one origin this instance serves. Named explicitly rather than left
      // to the built-in development list, because that list is what a
      // *production* server does NOT have and this is the closer simulation.
      TANGRAM_ALLOWED_ORIGINS: BASE,
      // Production, so the built-in development origins are NOT in the
      // allowlist. The last case below depends on it: it calls this server from
      // `http://localhost:<PORT>` — the suite's own origin, which a development
      // allowlist would admit — and asserts the browser blocks it.
      NODE_ENV: 'production',
    },
    stdio: 'ignore',
  });
  await waitFor(`${API_BASE}/health`);

  // 2 — a build that points at it. Vite substitutes `VITE_API_BASE` at build
  // time, so this cannot be done with an environment variable at serve time.
  const build = spawnSync(
    resolve(REPO_ROOT, 'node_modules/.bin/vite'),
    ['build', '--outDir', OUT_DIR],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, VITE_API_BASE: API_BASE },
      encoding: 'utf8',
    },
  );
  if (build.status !== 0) {
    throw new Error(`the gated build failed:\n${build.stdout ?? ''}\n${build.stderr ?? ''}`);
  }

  // 3 — serve it.
  appServer = spawn(
    resolve(REPO_ROOT, 'node_modules/.bin/tsx'),
    [resolve(WORKSPACE_ROOT, 'scripts/preview.ts')],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(PORT), TANGRAM_PREVIEW_OUT_DIR: OUT_DIR },
      stdio: 'ignore',
    },
  );
  await waitFor(`${BASE}/offline.html`);
  api = await playwrightRequest.newContext({ baseURL: API_BASE, maxRedirects: 0 });
});

test.afterAll(async () => {
  await api?.dispose();
  appServer?.kill('SIGTERM');
  apiServer?.kill('SIGTERM');
  // The second build goes with the run that made it, the way
  // `tests/e2e/core/gallery-excluded.spec.ts` disposes of its two. Leaving 700
  // kB of emitted bundle in the tree is how `pnpm lint` ends up reporting four
  // thousand findings in generated code.
  rmSync(resolve(REPO_ROOT, OUT_DIR), { recursive: true, force: true });
});

test.describe('with TANGRAM_ACCESS_SECRET set', () => {
  test.setTimeout(180_000);

  test('refuses the paid routes with a plain 401 and nothing else', async () => {
    for (const path of ['/api/ask', '/api/examples', '/api/recall']) {
      const response = await api.post(path, { data: { query: 'x' } });
      expect(response.status(), path).toBe(401);
      const body = await response.text();
      expect(JSON.parse(body), path).toEqual({ error: 'unauthorized' });
      // No stack trace, no hint, and above all no echo of the secret.
      expect(body, path).not.toContain(SECRET);
      expect(body.length, path).toBeLessThan(64);
    }
    // The handshakes are on the same routes and are gated with them.
    expect((await api.get('/api/ask')).status()).toBe(401);
    expect((await api.get('/api/examples')).status()).toBe(401);
  });

  test('refuses the two paths under /api/ask, because the match is a prefix', async () => {
    // `wave-zero.md` §10a: `/api/ask/propose` and `/api/ask/answer` are the two
    // routes that actually spend the money, and an exact-string gate leaves
    // both open with every existing test green. `backend.md` B2 has since
    // mounted them; an unkeyed request gets 401 rather than the 404 an ungated
    // unknown path gets, and — now that they exist — rather than the 400 the
    // handler itself would answer.
    for (const path of ['/api/ask/propose', '/api/ask/answer']) {
      expect((await api.post(path, { data: {} })).status(), path).toBe(401);
    }
  });

  test('admits the paid routes once the header is sent', async () => {
    // The gate is out of the way; the empty body is the route's own complaint,
    // which is the proof the request got past it.
    //
    // `/api/ask/answer`, not `/api/ask`: `backend.md` B2 left the parent as the
    // GET handshake alone, so a POST to it is a 405 from the router rather than
    // a 400 from a handler — which would prove nothing about the gate.
    const response = await api.post('/api/ask/answer', {
      data: {},
      headers: { [ACCESS_HEADER]: SECRET },
    });
    expect(response.status()).toBe(400);
    expect((await api.get('/api/ask', { headers: { [ACCESS_HEADER]: SECRET } })).status()).toBe(200);
  });

  test('leaves /health open, so a deploy is checkable without the secret', async () => {
    expect((await api.get('/health')).status()).toBe(200);
  });

  // **"a deleted dictionary path answers 404, not 401" is asserted in
  // `apps/server/tests/gate.test.ts`, not here, and the reason is a guard.**
  // `backend.md` B1 requires it — "a gate that quietly widened is a broken PWA"
  // — but `data.md` D6's `tests/unit/dict/client-callers.test.ts` scans every
  // source file under `apps/app` for a dictionary route path and fails on any
  // hit, which is what keeps the deleted routes deleted. Spelling one here to
  // prove it is GONE would trip the guard that proves it is gone. The server's
  // own suite is outside that scan and is where the assertion belongs anyway:
  // it is a fact about `apps/server`'s route table.

  test('leaves the app, the dictionary and the PWA files open', async () => {
    // They cost CPU, not money, and the PWA has to install without a key. A
    // gate that reached them would break offline review for a stranger — and
    // the gate is on the API origin now, so this is also the assertion that the
    // static host was never behind it in the first place.
    const app = await playwrightRequest.newContext({ baseURL: BASE, maxRedirects: 0 });
    try {
      expect((await app.get('/dict-manifest.json')).status()).toBe(200);
      for (const path of ['/', '/read', '/practice', '/library', '/offline.html', '/sw.js', '/manifest.webmanifest']) {
        expect((await app.get(path)).status(), path).toBe(200);
      }
    } finally {
      await app.dispose();
    }
  });
});

test.describe('the ?key= exchange, in a browser', () => {
  test.setTimeout(180_000);
  test.use({ baseURL: BASE });

  test('authorises a device, and takes the key back out of the URL', async ({ page }) => {
    await page.goto(`/?key=${SECRET}`);

    // The feedback a phone with no devtools can read…
    await expect(page).toHaveURL(/access=granted/);
    // …and the key is gone: not in the address bar, not in history, not in the
    // Referer of the next link tapped.
    expect(page.url()).not.toContain(SECRET);
    expect(page.url()).not.toContain('key=');
    expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);

    // The app is on screen, not a redirect target.
    await expect(page.locator('[data-route="/"]')).toHaveCount(1);

    // The credential is stored, and it opens the gate. Sent explicitly rather
    // than with a bare `fetch`: the app attaches it through `apiFetch`, and a
    // raw page-script fetch carries nothing — which is a fact about the test,
    // not about the app, and asserting 200 on one would be asserting the gate
    // is off. This is also a **cross-origin** call, so it only passes if the
    // server's allowlist and preflight are right.
    const result = await page.evaluate(async (base) => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch(`${base}/api/ask`, {
        headers: { accept: 'application/json', 'x-tangram-access': stored ?? '' },
      });
      return { stored, status: response.status };
    }, API_BASE);
    expect(result.stored).toBe(SECRET);
    expect(result.status).toBe(200);
  });

  test('revokes on a wrong key, rather than leaving the old one in place', async ({ page }) => {
    await page.goto(`/?key=${SECRET}`);
    await expect(page).toHaveURL(/access=granted/);

    await page.goto('/?key=obviously-the-wrong-key');
    await expect(page).toHaveURL(/access=denied/);

    // Revoked, not merely not-replaced: the good secret is gone from storage…
    const result = await page.evaluate(async (base) => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch(`${base}/api/ask`, {
        headers: { accept: 'application/json', 'x-tangram-access': stored ?? '' },
      });
      return { stored, status: response.status };
    }, API_BASE);
    expect(result.stored).toBeNull();
    // …and the route refuses whatever is left. A 401 that page script can READ
    // is itself part of the contract: without `Access-Control-Allow-Origin` on
    // the refusal this `fetch` would throw and the exchange above could never
    // have reported `denied`.
    expect(result.status).toBe(401);
  });

  test('a device that never ran the exchange is refused', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async (base) => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch(`${base}/api/ask`, { headers: { accept: 'application/json' } });
      return { stored, status: response.status };
    }, API_BASE);
    expect(result.stored).toBeNull();
    expect(result.status).toBe(401);
  });
});

/**
 * The cross-origin path, which `web.md` R10 says is the one thing a same-origin
 * run proves nothing about — and `backend.md` B1's fourth acceptance criterion,
 * which says to assert the POST half **with a browser, not with `curl`**,
 * because `curl` ignores CORS and will cheerfully tell you it works.
 *
 * The calls that matter run from inside the page, against the real
 * `apps/server` on its own origin. What is under test is the pair: that the
 * server's answer to the preflight is right, and that a browser will act on it.
 */
test.describe('across origins, which is where the header earns its keep', () => {
  test.setTimeout(180_000);
  test.use({ baseURL: BASE });

  test('answers the preflight with the header named, and the POST then lands', async ({ page }) => {
    // **Two halves, because neither is sufficient and Chromium will not show
    // you the first one.** A preflight is issued by the browser's network stack
    // and is not surfaced to the automation client: `page.on('request')` never
    // sees the `OPTIONS`, measured. So:
    //
    //  (a) the preflight ANSWER is asserted directly. This is the `curl`-shaped
    //      half and it is exactly what B1's criterion enumerates — the allowed
    //      methods, and `X-Tangram-Access` in `Access-Control-Allow-Headers`.
    //      It is also the half a wrong answer fails loudly.
    //  (b) the real cross-origin POST is made **from the page**, which is what
    //      B1 insists on ("assert the POST half with a Playwright spec from the
    //      app origin, not with `curl` — `curl` ignores CORS and will
    //      cheerfully tell you it works"). Its success is the proof that a
    //      preflight happened AND that the browser accepted the answer: a
    //      `fetch` carrying a non-safelisted header cross-origin cannot reach
    //      the handler any other way. Take (a) away and (b) rejects.
    // `/api/ask/answer` is the path the browser actually preflights after
    // `backend.md` B2 — `/api/ask` answers GET only now, so its preflight names
    // `GET, OPTIONS` and would fail the `POST` assertion below for a reason that
    // has nothing to do with CORS.
    const preflight = await api.fetch('/api/ask/answer', {
      method: 'OPTIONS',
      headers: {
        origin: BASE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': `content-type, ${ACCESS_HEADER}`,
      },
    });
    expect(preflight.status()).toBe(204);
    const headers = preflight.headers();
    expect(headers['access-control-allow-origin']).toBe(BASE);
    expect(headers['access-control-allow-headers']).toContain(ACCESS_HEADER);
    expect(headers['access-control-allow-methods']).toContain('POST');
    // The preflight itself is NOT gated — it carries no credentials, and a
    // server that refused it would fail every gated POST before the browser
    // ever sent the header the gate is asking for.
    expect(preflight.status()).not.toBe(401);

    await page.goto(`/?key=${SECRET}`);
    await expect(page).toHaveURL(/access=granted/);

    const result = await page.evaluate(async (base) => {
      const stored = localStorage.getItem('tangram.access.secret');
      try {
        const response = await fetch(`${base}/api/ask/answer`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tangram-access': stored ?? '',
          },
          // An empty body: the handler's own 400 is the proof it was reached,
          // and this must not spend money on a provider call to prove CORS
          // works.
          body: JSON.stringify({}),
        });
        return { outcome: `status ${response.status}`, stored: stored !== null };
      } catch (error) {
        // A CORS failure is a TypeError with no status, not a status — which is
        // why the assertion below is on a string rather than on a number.
        return { outcome: `blocked: ${String(error)}`, stored: stored !== null };
      }
    }, API_BASE);

    expect(result.stored).toBe(true);
    // 400 and nothing else. `blocked:` is CORS, 401 is the gate, 404 is the
    // route — each a different bug, and the message says which.
    expect(result.outcome).toBe('status 400');
  });

  test('the same call without the header is 401', async ({ page }) => {
    await page.goto('/');
    const status = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/api/ask/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      return response.status;
    }, API_BASE);
    expect(status).toBe(401);
  });

  test('an origin off the allowlist is blocked by the browser', async ({ page }) => {
    // The other half of the allowlist, and the one that cannot be checked from
    // Node: this server's instance names only `BASE`, so the same call from the
    // suite's own origin gets no `Access-Control-Allow-Origin` and the fetch
    // rejects before any script sees a status. That rejection IS the assertion
    // — a server that answered `*` would resolve here.
    await page.goto(`http://localhost:${PORT - 100}/`);
    const outcome = await page.evaluate(async (base) => {
      try {
        const response = await fetch(`${base}/api/ask`, { headers: { accept: 'application/json' } });
        return `status ${response.status}`;
      } catch {
        return 'blocked';
      }
    }, API_BASE);
    expect(outcome).toBe('blocked');
  });
});
