/**
 * The access gate, against a real server with the secret actually set.
 *
 * The rest of the suite runs with `TANGRAM_ACCESS_SECRET` unset, which is the
 * point — the gate must be invisible without it. So this spec starts a *second*
 * `next start` on its own port with the variable set, reusing the `.next` build
 * the suite already made, and drives the whole phone flow through it: refused,
 * `?key=`, cookie, admitted.
 *
 * It is the only place the gate is exercised end to end. A unit test can prove
 * the handler returns 401; only a server can prove that middleware runs, that
 * the redirect strips the key, that the cookie comes back with the right
 * attributes, and that the dictionary and the pages stay open.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';

const SECRET = 'e2e-access-secret-9f3a';
const PORT = Number(process.env.PORT ?? 3000) + 100;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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
  server = spawn('node_modules/.bin/next', ['start', '-p', String(PORT)], {
    cwd: REPO_ROOT,
    env: { ...process.env, TANGRAM_ACCESS_SECRET: SECRET, PORT: String(PORT) },
    stdio: 'ignore',
  });
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

  test('a wrong ?key= is refused, and takes the key back out of the URL', async () => {
    const response = await api.get(`/?key=${SECRET}-wrong`);
    expect(response.status()).toBe(303);
    const location = response.headers().location as string;
    expect(location).toContain('access=denied');
    expect(location).not.toContain('key=');
    // It also revokes whatever this device had: a wrong key is an attempt to
    // change the key, and silently keeping the old one is worse.
    const cookies = response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
    expect(cookies.some((h) => /tangram_access=;/.test(h.value))).toBe(true);
  });

  test('the right ?key= leaves a cookie behind, and the cookie opens the routes', async () => {
    const response = await api.get(`/?key=${SECRET}`);
    expect(response.status()).toBe(303);
    const location = response.headers().location as string;
    expect(location).toContain('access=granted');
    // The secret must not survive in the address bar, the history or a Referer.
    expect(location).not.toContain('key=');
    expect(location).not.toContain(SECRET);

    const setCookie = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value)
      .find((value) => value.startsWith('tangram_access='));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    // Plain HTTP here, so `Secure` is correctly absent — with it the cookie
    // would never be stored and this local check could not exist.
    expect(setCookie).not.toContain('Secure');

    // Same context, so the cookie it just stored travels with the next call.
    const admitted = await api.post('/api/ask', {
      data: { query: '你好', profile: { estimatedBand: 1, knownSample: [] } },
    });
    expect(admitted.status()).toBe(200);
    const body = (await admitted.json()) as { response?: unknown };
    expect(body.response).toBeDefined();
  });
});
