/**
 * The access gate, against a real server with the secret actually set.
 *
 * The rest of the suite runs with `TANGRAM_ACCESS_SECRET` unset, which is the
 * point — the gate must be invisible without it. So this spec starts a *second*
 * preview server on its own port with the variable set, reusing the `dist/` the
 * suite already built, and drives what is left of the flow through it.
 *
 * **HALF OF THIS SPEC IS GONE BETWEEN W1 AND W4 AND THAT IS A DEPLOYMENT FACT,
 * NOT A TEST DETAIL** (docs/plans/web.md W1, W4). `middleware.ts` is what did
 * the `?key=` → cookie exchange, and Next is what invoked it; there is no
 * middleware in a Vite SPA, so until W4 rebuilds the gate as a header check
 * there is no way to authorise a device at all. On any deployment made in this
 * window with the secret set, `/api/ask`, `/api/examples` and `/api/recall` are
 * unusable and cannot be authorised from a phone.
 *
 * What was removed, each mapped to the W4 criterion that restores it:
 *
 *  1. `?key=<secret>` → 303 with `access=granted`, the key stripped from the
 *     Location, and a `tangram_access` cookie carrying HttpOnly / SameSite=Lax
 *     / Path=/ (and no `Secure` over plain HTTP).   → W4's authorise flow.
 *  2. A wrong `?key=` → 303 with `access=denied`, the key stripped, and the
 *     existing cookie actively cleared.             → W4's revoke-on-wrong-key.
 *  3. The cookie, once set, admitting a POST to `/api/ask`.
 *                                                   → W4's admitted-request.
 *
 * What survives, and is still worth running every time: with the secret set,
 * the three paid routes still refuse — `requireAccess` in `lib/server/access.ts`
 * is untouched by this phase and is the half that never depended on Next — and
 * the five dictionary routes, the pages, the manifest, `sw.js` and
 * `/offline.html` all stay open. Those are the assertions that prove the gate
 * is a gate and not a wall, and they are exactly the ones W4 must not break.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appRoot } from '../../../lib/server/roots';

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';

const SECRET = 'e2e-access-secret-9f3a';
const PORT = Number(process.env.PORT ?? 3000) + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = appRoot(fileURLToPath(new URL('.', import.meta.url)));

let server: ChildProcess | undefined;
let api: APIRequestContext;

async function waitForServer(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/offline.html`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`the gated server did not come up on ${BASE}`);
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
  await waitForServer();
  // `maxRedirects: 0` — the redirect *is* the behaviour under test.
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

  test('leaves the dictionary and the pages open', async () => {
    // They cost CPU, not money, and the PWA has to install without a key.
    expect((await api.get('/api/dict/search?q=%E4%BD%A0%E5%A5%BD')).status()).toBe(200);
    expect((await api.get('/api/dict/hsk?band=1')).status()).toBe(200);
    for (const page of ['/', '/lookup', '/review', '/settings', '/offline.html']) {
      expect((await api.get(page)).status(), page).toBe(200);
    }
  });

  /**
   * The `?key=` exchange, the cookie and the admitted request lived here. They
   * were middleware's, middleware was Next's, and both are gone until W4 — see
   * the three numbered items in this file's header for what each becomes.
   *
   * They are NOT replaced with a weaker assertion, and they are not skipped
   * with `test.skip`: a skipped test reads as "temporarily flaky" in a report
   * and this is a capability the product does not currently have.
   */
  test('cannot authorise a device at all: there is no ?key= exchange in this window', async () => {
    // Stated as a passing assertion rather than a comment so that the day W4
    // makes it false, this test fails and has to be rewritten into the real one.
    const response = await api.get(`/?key=${SECRET}`);
    expect(response.status(), 'W4 makes this a 303 — rewrite this test then').not.toBe(303);
    expect((await api.post('/api/ask', { data: { query: 'x' } })).status()).toBe(401);
  });
});
