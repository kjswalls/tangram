/**
 * The access gate, against a real server with the secret actually set
 * (docs/plans/web.md W4).
 *
 * The rest of the suite runs with `TANGRAM_ACCESS_SECRET` unset, which is the
 * point — the gate must be invisible without it. So this spec starts a *second*
 * preview server on its own port with the variable set, reusing the `dist/` the
 * suite already built, and drives the whole flow through it.
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
 *
 * **And one case that could not exist before.** The API moves to another origin
 * in `backend.md`, and a custom request header makes every cross-origin POST a
 * *preflighted* one: the browser sends `OPTIONS` first, and a server that does
 * not answer it with `X-Tangram-Access` in `Access-Control-Allow-Headers` fails
 * every gated call before the handler is reached. `web.md` R10 says a
 * same-origin run proves none of that, so the last describe block runs the app
 * against a second local origin with an explicit allowlist.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCESS_HEADER } from '@tangram/access';

import { appRoot } from '../../../lib/server/roots';

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';

const SECRET = 'e2e-access-secret-9f3a';
const PORT = Number(process.env.PORT ?? 3000) + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = appRoot(fileURLToPath(new URL('.', import.meta.url)));

let server: ChildProcess | undefined;
let api: APIRequestContext;

async function waitForServer(base: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/offline.html`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`the gated server did not come up on ${base}`);
}

test.beforeAll(async () => {
  // The same preview entry the main webServer uses, on its own port with the
  // secret set. `tsx` because the API adapter has to import `.ts` handlers.
  server = spawn(
    resolve(REPO_ROOT, 'node_modules/.bin/tsx'),
    [resolve(REPO_ROOT, '..', '..', 'scripts/preview.ts')],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TANGRAM_ACCESS_SECRET: SECRET, PORT: String(PORT) },
      stdio: 'ignore',
    },
  );
  await waitForServer(BASE);
  api = await playwrightRequest.newContext({ baseURL: BASE, maxRedirects: 0 });
});

test.afterAll(async () => {
  await api?.dispose();
  server?.kill('SIGTERM');
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

  test('admits the paid routes once the header is sent', async () => {
    // The gate is out of the way; the empty body is the route's own complaint,
    // which is the proof the request got past it.
    const response = await api.post('/api/ask', {
      data: {},
      headers: { [ACCESS_HEADER]: SECRET },
    });
    expect(response.status()).toBe(400);
    expect((await api.get('/api/ask', { headers: { [ACCESS_HEADER]: SECRET } })).status()).toBe(200);
  });

  test('leaves the dictionary, the pages and the PWA files open', async () => {
    // They cost CPU, not money, and the PWA has to install without a key. A
    // gate that quietly widened would break offline review for a stranger.
    //
    // The two dictionary routes that used to lead this list went with `data.md`
    // D6; the dictionary is a **static file** now, and the manifest below is
    // what a learner's first load fetches before anything else. If the gate ever
    // reached it, the app would install and then have no words in it.
    expect((await api.get('/dict-manifest.json')).status()).toBe(200);
    for (const path of ['/', '/read', '/practice', '/library', '/offline.html', '/sw.js', '/manifest.webmanifest']) {
      expect((await api.get(path)).status(), path).toBe(200);
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
    // is off.
    const result = await page.evaluate(async () => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch('/api/ask', {
        headers: { accept: 'application/json', 'x-tangram-access': stored ?? '' },
      });
      return { stored, status: response.status };
    });
    expect(result.stored).toBe(SECRET);
    expect(result.status).toBe(200);
  });

  test('revokes on a wrong key, rather than leaving the old one in place', async ({ page }) => {
    await page.goto(`/?key=${SECRET}`);
    await expect(page).toHaveURL(/access=granted/);

    await page.goto('/?key=obviously-the-wrong-key');
    await expect(page).toHaveURL(/access=denied/);

    // Revoked, not merely not-replaced: the good secret is gone from storage…
    const result = await page.evaluate(async () => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch('/api/ask', {
        headers: { accept: 'application/json', 'x-tangram-access': stored ?? '' },
      });
      return { stored, status: response.status };
    });
    expect(result.stored).toBeNull();
    // …and the route refuses whatever is left.
    expect(result.status).toBe(401);
  });

  test('a device that never ran the exchange is refused', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch('/api/ask', { headers: { accept: 'application/json' } });
      return { stored, status: response.status };
    });
    expect(result.stored).toBeNull();
    expect(result.status).toBe(401);
  });
});

/**
 * The cross-origin path, which `web.md` R10 says is the one thing a same-origin
 * run proves nothing about.
 *
 * A second local origin stands in for `backend.md`'s server: it answers the
 * preflight with an explicit allowlist, refuses a POST with no
 * `X-Tangram-Access`, and answers one that carries it. What is under test is
 * the **browser's** behaviour — that it preflights at all, and that the header
 * survives the round trip — so every request is made from inside the page.
 */
test.describe('across origins, which is where the header earns its keep', () => {
  test.setTimeout(180_000);
  test.use({ baseURL: BASE });

  const API_PORT = PORT + 11;
  const API_BASE = `http://127.0.0.1:${API_PORT}`;
  let apiServer: Server | undefined;
  const preflights: { origin: string | undefined; requested: string | undefined }[] = [];

  test.beforeAll(async () => {
    apiServer = createServer((req, res) => {
      const origin = req.headers.origin;
      // An explicit allowlist, not `*`: this is what `backend.md` B1 owns, and
      // what it must include or every gated POST fails before the handler.
      if (origin === BASE) {
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('access-control-allow-headers', `content-type, ${ACCESS_HEADER}`);
        res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      }
      if (req.method === 'OPTIONS') {
        preflights.push({
          origin,
          requested: req.headers['access-control-request-headers'] as string | undefined,
        });
        res.statusCode = 204;
        res.end();
        return;
      }
      const presented = req.headers[ACCESS_HEADER];
      res.setHeader('content-type', 'application/json');
      res.statusCode = presented === SECRET ? 200 : 401;
      res.end(JSON.stringify(presented === SECRET ? { ok: true } : { error: 'unauthorized' }));
    });
    await new Promise<void>((done) => apiServer!.listen(API_PORT, '127.0.0.1', done));
  });

  test.afterAll(async () => {
    if (apiServer) await new Promise<void>((done) => apiServer!.close(() => done()));
  });

  test('preflights, names the header, and then succeeds', async ({ page }) => {
    await page.goto(`/?key=${SECRET}`);
    await expect(page).toHaveURL(/access=granted/);

    const result = await page.evaluate(async (base) => {
      const stored = localStorage.getItem('tangram.access.secret');
      const response = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-tangram-access': stored ?? '',
        },
        body: JSON.stringify({ query: 'x' }),
      });
      return { status: response.status, stored: stored !== null };
    }, API_BASE);

    expect(result.stored).toBe(true);
    // (a) the browser preflighted, and asked for our header by name…
    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.at(-1)?.origin).toBe(BASE);
    expect(preflights.at(-1)?.requested).toContain(ACCESS_HEADER);
    // (b) …and the POST then succeeded.
    expect(result.status).toBe(200);
  });

  test('the same call without the header is 401', async ({ page }) => {
    await page.goto('/');
    const status = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      });
      return response.status;
    }, API_BASE);
    expect(status).toBe(401);
  });
});
