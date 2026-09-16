/**
 * The gate and the allowlist, asserted against the app rather than the module
 * (docs/plans/backend.md B1, criteria 1, 2 and 4).
 *
 * `packages/access` already has unit tests for `isGatedPath` and
 * `isAuthorizedRequest`, and `apps/app/tests/unit/ai/contract.test.ts` pins the
 * prefix rule against the frozen paths. What none of them can say is whether
 * **this server** actually puts that check in front of these handlers — which
 * is the whole of B1's first criterion, and which HANDOFF.md records a previous
 * review catching the absence of on two money-spending routes.
 *
 * So every assertion below goes through `buildApp().fetch`. No socket: a
 * `Request` in, a `Response` out, which is what lets the money routes be
 * exercised without a provider, a dictionary or a port.
 */
import { describe, expect, it } from 'vitest';

import { GATED_PATHS } from '@tangram/access';

import { buildApp } from '../src/app.ts';
import { ALLOWED_HEADERS, allowedMethods, readCorsPolicy } from '../src/cors.ts';

const SECRET = 'a-secret-long-enough-to-be-redacted';
const GATED_ENV = { TANGRAM_ACCESS_SECRET: SECRET };
const APP_ORIGIN = 'https://app.tangram.example';

function server(env: Record<string, string | undefined> = {}) {
  return buildApp({
    env,
    cors: readCorsPolicy({ TANGRAM_ALLOWED_ORIGINS: APP_ORIGIN }, true),
  });
}

function post(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://api.tangram.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
}

describe('the gate, with TANGRAM_ACCESS_SECRET set', () => {
  const app = server(GATED_ENV);

  it('refuses every gated path without the header, and echoes nothing back', async () => {
    for (const path of GATED_PATHS) {
      const response = await app.fetch(post(path));
      expect(response.status, path).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized' });
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('refuses a wrong key the same way it refuses none — no hint, no near-miss', async () => {
    const wrong = await app.fetch(post('/api/ask', { 'x-tangram-access': `${SECRET}x` }));
    const none = await app.fetch(post('/api/ask'));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe(await none.text());
  });

  it('refuses the PREFIX, which is the two paths B2 adds under /api/ask', async () => {
    // `wave-zero.md` §10a, and it names these two explicitly: they are the
    // routes that actually spend the money. An exact-string gate would leave
    // both open with the secret set and every existing test green. They do not
    // exist yet, so the proof that the gate covers them is that an unkeyed
    // request gets 401 rather than the 404 the table would otherwise give.
    for (const path of ['/api/ask/propose', '/api/ask/answer']) {
      expect((await app.fetch(post(path))).status, path).toBe(401);
    }
  });

  it('does not gate a path that merely starts with the same letters', async () => {
    // `/api/asking` is not under `/api/ask`; the boundary is a separator. It is
    // not a route either, so the honest answer is 404 — a 401 here would mean
    // the gate had silently widened to cover paths nobody listed.
    expect((await app.fetch(post('/api/asking'))).status).toBe(404);
  });

  it('answers 404, not 401, for the five dictionary routes data.md D6 deleted', async () => {
    // B1's own words: "a gate that quietly widened is a broken PWA". A 401 here
    // would mean the app could not tell "that route is gone" from "you are not
    // authorised" and would show the wrong banner forever.
    for (const name of ['entries', 'hsk', 'search', 'segment', 'decomp']) {
      const response = await app.fetch(post(`/api/dict/${name}`));
      expect(response.status, name).toBe(404);
    }
  });

  it('never gates /health, so a deploy can be checked without the secret', async () => {
    expect((await app.fetch(new Request('https://api.tangram.example/health'))).status).toBe(200);
  });

  it('lets the preflight through unkeyed — a preflight carries no credentials', async () => {
    // If the gate refused `OPTIONS`, the browser would never send the header the
    // gate is asking for, and every cross-origin POST would fail before the
    // handler was reached. That failure looks exactly like a CORS bug and is
    // one of the two ways this phase could ship a dead app.
    const response = await app.fetch(
      new Request('https://api.tangram.example/api/ask', {
        method: 'OPTIONS',
        headers: {
          origin: APP_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-tangram-access',
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
  });

  it('puts the CORS headers on the 401 itself', async () => {
    // Without them a cross-origin 401 reaches page script as a network error
    // rather than as a status, and `initAccess`'s probe reports `unverified`
    // for a key that is definitely wrong — so a bad key is never revoked and
    // the phone gives no feedback at all.
    const response = await app.fetch(post('/api/ask', { origin: APP_ORIGIN }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });
});

describe('the gate, with TANGRAM_ACCESS_SECRET unset', () => {
  // Rule 1 of `packages/access`: absent secret means absent gate, and every
  // local run — `pnpm dev`, the unit suite, `pnpm e2e` — depends on it.
  const app = server({});

  it('lets a gated POST reach its handler, which answers on its own terms', async () => {
    // 400, because the body is `{}`. The point is that it is the *handler's*
    // answer: 401 here would mean the gate existed with nothing configured.
    for (const path of GATED_PATHS) {
      const response = await app.fetch(post(path));
      expect(response.status, path).toBe(400);
    }
  });
});

describe('the allowlist', () => {
  const app = server(GATED_ENV);

  it('names the access header in the preflight, or every gated POST dies unsent', async () => {
    const response = await app.fetch(
      new Request('https://api.tangram.example/api/examples', {
        method: 'OPTIONS',
        headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST' },
      }),
    );
    expect(response.headers.get('access-control-allow-headers')).toBe(ALLOWED_HEADERS);
    expect(response.headers.get('access-control-allow-headers')).toContain('x-tangram-access');
    expect(response.headers.get('access-control-allow-methods')).toBe(allowedMethods(['GET', 'POST']));
  });

  it('advertises only the methods each route actually answers', async () => {
    // `/api/recall` has no handshake. A preflight that offered `GET` would let
    // a browser send one through to a 405 it could have refused locally, and a
    // server describing a verb it does not answer is the same small lie as an
    // `Allow` header that omits one.
    const response = await app.fetch(
      new Request('https://api.tangram.example/api/recall', {
        method: 'OPTIONS',
        headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST' },
      }),
    );
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  });

  it('gives an origin off the allowlist no Access-Control-Allow-Origin', async () => {
    for (const method of ['OPTIONS', 'POST'] as const) {
      const response = await app.fetch(
        new Request('https://api.tangram.example/api/ask', {
          method,
          headers: { origin: 'https://not-tangram.example' },
          ...(method === 'POST' ? { body: '{}' } : {}),
        }),
      );
      expect(response.headers.get('access-control-allow-origin'), method).toBeNull();
      // …and `Vary` regardless, so a shared cache cannot hand one origin's
      // answer to another.
      expect(response.headers.get('vary'), method).toBe('Origin');
    }
  });

  it('allows both Capacitor WebView origins in production', async () => {
    // One build ships to three places. iOS serves `capacitor://localhost` and
    // Android `http://localhost`; neither is on any domain, so neither can be
    // configured per deployment and both are built in.
    for (const origin of ['capacitor://localhost', 'http://localhost']) {
      const response = await app.fetch(
        new Request('https://api.tangram.example/api/ask', {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST' },
        }),
      );
      expect(response.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
  });

  it('keeps the dev origins out of a production allowlist and in a development one', () => {
    const production = readCorsPolicy({}, true).origins;
    const development = readCorsPolicy({}, false).origins;
    expect(production.has('http://localhost:3000')).toBe(false);
    expect(development.has('http://localhost:3000')).toBe(true);
    // The native two are in both: a device build is not a development build.
    for (const origin of ['capacitor://localhost', 'http://localhost']) {
      expect(production.has(origin), origin).toBe(true);
    }
  });

  it('never lets a configured origin replace the native ones', () => {
    const origins = readCorsPolicy({ TANGRAM_ALLOWED_ORIGINS: APP_ORIGIN }, true).origins;
    expect(origins.has(APP_ORIGIN)).toBe(true);
    expect(origins.has('capacitor://localhost')).toBe(true);
  });

  it('reads a list, and forgives the trailing slash a hosting UI encourages', () => {
    const origins = readCorsPolicy(
      { TANGRAM_ALLOWED_ORIGINS: ' https://a.example/ , https://b.example , nonsense ' },
      true,
    ).origins;
    expect(origins.has('https://a.example')).toBe(true);
    expect(origins.has('https://b.example')).toBe(true);
    // A value that is not an absolute URL is dropped rather than half-matched.
    expect(origins.has('nonsense')).toBe(false);
  });

  it('answers a request with no Origin at all, which is every curl and the smoke', async () => {
    const response = await app.fetch(new Request('https://api.tangram.example/health'));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
