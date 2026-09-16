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
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

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

  it('refuses a PERCENT-ENCODED spelling of a gated path', async () => {
    // `URL.pathname` does not decode; Hono's router does. So `/api/%61sk` was
    // "not gated" to a literal prefix match and was routed to the real
    // `/api/ask` handler anyway — caught by an adversarial reviewer, who also
    // showed the sharp end: `/api/%61sk/propose` reached the router un-gated
    // and 404'd, so `backend.md` B2's two money-spending routes would have had
    // one check in front of them instead of two. `requireAccess` in the handler
    // meant it never cost anything; the front layer's own claim was false.
    for (const path of ['/api/%61sk', '/api/%61sk/propose', '/api/%65xamples']) {
      expect((await app.fetch(post(path))).status, path).toBe(401);
    }
  });

  it('does not fall over on a malformed escape', async () => {
    // `decodeURIComponent('%zz')` throws. The raw form is still matched, and a
    // path the decoder cannot read is not one the router will match either.
    expect((await app.fetch(post('/api/ask/%zz'))).status).toBe(401);
    expect((await app.fetch(post('/nothing/%zz'))).status).toBe(404);
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
  //
  // **The ambient environment is stubbed, and that is not belt-and-braces.**
  // `buildApp`'s middleware compares against the injected `env`, but each
  // handler's own `requireAccess(request)` takes `@tangram/access`'s default,
  // which is `process.env`. So this block was green only because
  // `TANGRAM_ACCESS_SECRET` happens to be unset in vitest — run the suite with
  // it exported in the shell and the handlers would 401 while the middleware
  // waved everything through. A reviewer found it; the stub makes the two
  // layers agree on purpose rather than by luck.
  const app = server({});

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets a gated POST reach its handler, which answers on its own terms', async () => {
    vi.stubEnv('TANGRAM_ACCESS_SECRET', undefined);
    // 400, because the body is `{}`. The point is that it is the *handler's*
    // answer: 401 here would mean the gate existed with nothing configured.
    for (const path of GATED_PATHS) {
      const response = await app.fetch(post(path));
      expect(response.status, path).toBe(400);
    }
  });
});

/**
 * The source with its comments blanked out.
 *
 * Crude, and deliberately so: over-blanking can only make the scan below *miss*
 * an offender, and the alternative is a parser in a test. What it is for is the
 * opposite direction — the paragraph documenting this rule quotes the very
 * shape the rule matches, so a scan that read comments would report its own
 * explanation. (It did, first time.)
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('a provider failure never carries a secret out of the process', () => {
  it('redacts the configured secrets out of a 502 hint', async () => {
    // The three handlers answer a provider failure with the error's own
    // message, and the ask panel shows it — suppressing it is B7's call, not
    // this phase's. What this phase owed was that the message goes through
    // `log.ts`'s redactor first: a handler-authored `Response.json` is not the
    // `onError` 500, so until an adversarial reviewer put a real SDK error into
    // a public 502 it was gated on nothing and scrubbed by nothing.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-not-a-real-key-000000');
    try {
      const { redactString } = await import('../src/log.ts');
      const leaked = 'Error: 401 authentication_error sk-ant-not-a-real-key-000000 is invalid';
      const scrubbed = redactString(leaked);
      expect(scrubbed).not.toContain('sk-ant-not-a-real-key-000000');
      expect(scrubbed).toContain('[redacted]');
      // …and a message with nothing to scrub comes back byte-identical, which
      // is why this is a fix rather than a behaviour change.
      expect(redactString('the model is overloaded')).toBe('the model is overloaded');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does it on the one 502 path a test can actually drive', async () => {
    // Behavioural, not textual. `gradeRecallWith` takes its provider as an
    // argument — the seam `recall.ts` exports "so a test can hand it one that
    // throws" — so this is the real handler, the real catch, the real body.
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-not-a-real-key-000000');
    try {
      const { gradeRecallWith } = await import('../src/routes/recall.ts');
      const entry = {
        id: 'x|x[x]',
        simp: '好',
        trad: '好',
        pinyinNum: 'hao3',
        pinyinMarked: 'hǎo',
        glosses: ['good'],
      };
      const response = await gradeRecallWith(
        {
          name: 'anthropic',
          proposePhrases: () => Promise.reject(new Error('unused')),
          answer: () => Promise.reject(new Error('unused')),
          exampleSentences: () => Promise.reject(new Error('unused')),
          gradeRecall: () =>
            Promise.reject(new Error('401 authentication_error: sk-ant-not-a-real-key-000000')),
        } as unknown as Parameters<typeof gradeRecallWith>[0],
        entry as unknown as Parameters<typeof gradeRecallWith>[1],
        'good',
      );
      expect(response.status).toBe(502);
      const body = (await response.json()) as { hint: string };
      expect(body.hint).not.toContain('sk-ant-not-a-real-key-000000');
      expect(body.hint).toContain('[redacted]');
      // …and the rest of the message survives, because the panel shows it.
      expect(body.hint).toContain('authentication_error');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('wraps every hint the three routes build from a value, not only that one', () => {
    // The other two 502 paths select their own provider, so they cannot be
    // driven from here. A scan stands in: a `hint:` whose value is a literal
    // this repo wrote needs no scrubbing, and everything else does.
    for (const name of ['ask', 'examples', 'recall'] as const) {
      const source = withoutComments(
        readFileSync(
          resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', `${name}.ts`),
          'utf8',
        ),
      );
      for (const match of source.matchAll(/\bhint:\s*([^\n]*)/g)) {
        const value = (match[1] ?? '').trim();
        // A string literal, or the `hint: string` of `badRequest`'s signature.
        if (/^['"`]/.test(value) || /^string\b/.test(value)) continue;
        expect(value, `${name}.ts: ${match[0].trim()}`).toContain('redactString');
      }
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
