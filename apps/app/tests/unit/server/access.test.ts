/**
 * The access gate (`@tangram/access`), its client half, and the three routes
 * that call it (docs/plans/web.md W4).
 *
 * The property that matters most is the one asserted first: with
 * `TANGRAM_ACCESS_SECRET` unset, nothing changes. Every other test in this repo
 * runs in that state, so a gate that leaked into the default would be a
 * thousand failures, not one — but it is worth one deliberate test anyway,
 * because "we would have noticed" is not a test.
 *
 * **Rewritten, not carried over.** The credential was an `HttpOnly` cookie and
 * this file had a whole `describe('readCookie')` block plus six assertions
 * driving `isAuthorizedRequest` through `Cookie:` header strings. W4 makes it
 * `X-Tangram-Access`. The *case list* is deliberately the same one — absent,
 * empty, near-miss, one trailing character, wrong header name, and
 * secret-unset-means-open — because that list is what has kept the gate honest,
 * and losing a case is how a gate quietly widens.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCESS_HEADER,
  accessGateEnabled,
  accessSecret,
  constantTimeEqual,
  GATED_PATHS,
  isAuthorizedRequest,
  isGatedPath,
  requireAccess,
  unauthorizedResponse,
} from '@tangram/access';
import {
  ACCESS_STORAGE_KEY,
  accessHeaders,
  accessSecretValue,
  apiUrl,
  exchangeUrl,
  initAccess,
  KEY_SHAPE,
  revokeAccess,
  withResult,
} from '@/src/access/client';

const SECRET = 'sesame-open-1234';

/** An env object, so nothing here mutates `process.env` for its neighbours. */
const gated = { TANGRAM_ACCESS_SECRET: SECRET };
const open: Record<string, string | undefined> = {};

function request(value?: string, url = 'https://tangram.example/api/ask'): Request {
  return new Request(url, value === undefined ? undefined : { headers: { [ACCESS_HEADER]: value } });
}

afterEach(() => {
  delete process.env.TANGRAM_ACCESS_SECRET;
  revokeAccess();
});

describe('with no secret configured', () => {
  it('is not a gate at all', () => {
    expect(accessSecret(open)).toBeNull();
    expect(accessGateEnabled(open)).toBe(false);
    expect(isAuthorizedRequest(request(), open)).toBe(true);
    expect(requireAccess(request(), open)).toBeNull();
  });

  it('treats a whitespace-only value as no secret', () => {
    // A hosting UI will happily store a variable whose value is a stray
    // newline, and a gate that admitted "\n" would look like a gate and not be
    // one.
    expect(accessSecret({ TANGRAM_ACCESS_SECRET: '   \n' })).toBeNull();
    expect(isAuthorizedRequest(request('   '), { TANGRAM_ACCESS_SECRET: ' ' })).toBe(true);
  });

  it('trims the configured secret rather than requiring the padding back', () => {
    expect(accessSecret({ TANGRAM_ACCESS_SECRET: ` ${SECRET}\n` })).toBe(SECRET);
  });
});

describe('with a secret configured', () => {
  it('refuses a request with no header', () => {
    expect(isAuthorizedRequest(request(), gated)).toBe(false);
  });

  it('refuses an empty header', () => {
    expect(isAuthorizedRequest(request(''), gated)).toBe(false);
  });

  it('refuses the wrong value, including a prefix of the right one', () => {
    expect(isAuthorizedRequest(request('nope'), gated)).toBe(false);
    expect(isAuthorizedRequest(request(SECRET.slice(0, -1)), gated)).toBe(false);
  });

  it('refuses one trailing character too many', () => {
    expect(isAuthorizedRequest(request(`${SECRET}x`), gated)).toBe(false);
  });

  it('accepts the right value, whatever case the header name arrives in', () => {
    expect(isAuthorizedRequest(request(SECRET), gated)).toBe(true);
    const upper = new Request('https://tangram.example/api/ask', {
      headers: { 'X-Tangram-Access': SECRET },
    });
    expect(isAuthorizedRequest(upper, gated)).toBe(true);
  });

  it('is not fooled by a header whose name merely ends with ours', () => {
    const near = new Request('https://tangram.example/api/ask', {
      headers: { [`not-${ACCESS_HEADER}`]: SECRET },
    });
    expect(isAuthorizedRequest(near, gated)).toBe(false);
  });

  it('does not read a cookie any more, whatever it carries', () => {
    // The old credential must not still work: two live spellings of one
    // credential is how a gate grows a hole, and the cookie was `HttpOnly`
    // precisely so nothing else would set it.
    const cookie = new Request('https://tangram.example/api/ask', {
      headers: { cookie: `tangram_access=${SECRET}` },
    });
    expect(isAuthorizedRequest(cookie, gated)).toBe(false);
  });
});

describe('the comparison', () => {
  it('agrees with === on what is equal', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual(SECRET, SECRET)).toBe(true);
    expect(constantTimeEqual(SECRET, `${SECRET} `)).toBe(false);
    expect(constantTimeEqual('a', 'b')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('ü', 'u')).toBe(false);
  });

  it('answers the same for a difference in the first byte and in the last', () => {
    // A timing assertion is unrunnable on a shared box, so this is the
    // structural half: both mismatches take the same path and neither is a
    // special case. The no-early-exit property itself lives in the loop, and
    // the comment above it says why it must stay.
    const base = 'x'.repeat(64);
    expect(constantTimeEqual(`y${base.slice(1)}`, base)).toBe(false);
    expect(constantTimeEqual(`${base.slice(0, 63)}y`, base)).toBe(false);
    expect(constantTimeEqual(base, base)).toBe(true);
  });
});

describe('which paths the gate covers', () => {
  it('names exactly the three that reach a paid model', () => {
    expect([...GATED_PATHS]).toEqual(['/api/ask', '/api/examples', '/api/recall']);
  });

  it('matches by PREFIX, so the two routes that spend the money are covered', () => {
    // `wave-zero.md` §10a, ruling 4: name them explicitly. A test that only
    // proves the three parents are gated is the test that would have passed
    // while both children were wide open with the secret set.
    expect(isGatedPath('/api/ask/propose')).toBe(true);
    expect(isGatedPath('/api/ask/answer')).toBe(true);
    for (const path of GATED_PATHS) expect(isGatedPath(path), path).toBe(true);
  });

  it('stops at a path separator, so it never covers a route nobody listed', () => {
    expect(isGatedPath('/api/asking')).toBe(false);
    expect(isGatedPath('/api/ask-anything')).toBe(false);
    // Any path nobody listed. It was a dictionary route until `data.md` D6
    // deleted all five; the assertion is about the prefix match rather than
    // about that route, so it keeps its meaning with a path that does not exist.
    expect(isGatedPath('/api/unknown')).toBe(false);
    expect(isGatedPath('/')).toBe(false);
    expect(isGatedPath('/sw.js')).toBe(false);
  });
});

describe('the refusal', () => {
  it('is a plain 401 that says nothing', async () => {
    const response = unauthorizedResponse();
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'unauthorized' });
    // No hint, no stack, and above all no secret.
    expect(text).not.toContain(SECRET);
    expect(text.length).toBeLessThan(64);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the ?key= exchange', () => {
  it('takes the key out of the URL and hands it back for checking', () => {
    const stripped = exchangeUrl(`https://app.example/lookup?q=hi&key=${SECRET}`, null);
    expect(stripped).not.toBeNull();
    expect(stripped!.key).toBe(SECRET);
    // The key is gone — not in history, not in a bookmark, not in a Referer.
    expect(stripped!.url).not.toContain(SECRET);
    expect(stripped!.url).not.toContain('key=');
    // …and the rest of the URL survives, which the middleware's redirect did too.
    expect(stripped!.url).toContain('/lookup');
    expect(stripped!.url).toContain('q=hi');
  });

  it('leaves the result a phone with no devtools can read', () => {
    expect(exchangeUrl(`https://app.example/?key=${SECRET}`, 'granted')!.url).toContain(
      'access=granted',
    );
    expect(exchangeUrl('https://app.example/?key=x', 'denied')!.url).toContain('access=denied');
    expect(withResult('/lookup?q=hi', 'https://app.example', 'granted')).toBe(
      '/lookup?q=hi&access=granted',
    );
  });

  it('leaves a URL with no key completely alone', () => {
    // The overwhelmingly common case, and it must not rewrite history.
    expect(exchangeUrl('https://app.example/lookup?q=hi', 'granted')).toBeNull();
  });

  it('accepts only the alphabet docs/deploy.md tells the owner to generate', () => {
    expect(KEY_SHAPE.test('fine-Secret_1.2~3-and-long-enough')).toBe(true);
    expect(KEY_SHAPE.test('')).toBe(false);
    expect(KEY_SHAPE.test('short')).toBe(false);
    expect(KEY_SHAPE.test('has spaces in it')).toBe(false);
    expect(KEY_SHAPE.test('has;semicolon;in;it')).toBe(false);
    expect(KEY_SHAPE.test('密码密码密码密码')).toBe(false);
  });
});

describe('the stored credential', () => {
  function location(href: string): Location {
    return { href } as Location;
  }
  const grants = () => Promise.resolve('granted' as const);
  const refuses = () => Promise.resolve('denied' as const);
  const unreachable = () => Promise.resolve('unverified' as const);

  it('is attached to a gated call once the exchange has run', async () => {
    expect(accessHeaders()).toEqual({});
    await expect(initAccess(location(`https://app.example/?key=${SECRET}`), grants)).resolves.toBe(
      'granted',
    );
    expect(accessSecretValue()).toBe(SECRET);
    expect(accessHeaders()).toEqual({ [ACCESS_HEADER]: SECRET });
    expect(globalThis.localStorage.getItem(ACCESS_STORAGE_KEY)).toBe(SECRET);
  });

  it('attaches the key BEFORE the verdict lands', () => {
    // A component that fires a gated request during the first render must carry
    // the credential; waiting a round trip for permission to use a key the
    // learner just typed would 401 that first request for no reason.
    let settle: (verdict: 'granted') => void = () => {};
    const pending = initAccess(
      location(`https://app.example/?key=${SECRET}`),
      () => new Promise((done) => { settle = done; }),
    );
    expect(accessHeaders()).toEqual({ [ACCESS_HEADER]: SECRET });
    settle('granted');
    return pending;
  });

  it('survives a reload, which is the whole point of storing it', async () => {
    globalThis.localStorage.setItem(ACCESS_STORAGE_KEY, SECRET);
    await expect(initAccess(location('https://app.example/'), grants)).resolves.toBe('none');
    expect(accessHeaders()).toEqual({ [ACCESS_HEADER]: SECRET });
  });

  it('is REVOKED by a key the server refuses, not merely not-replaced', async () => {
    // The middleware cleared the cookie on a bad key, because arriving with one
    // is an attempt to change the key. Leaving the old one in place would make
    // the failure unexplainable on a phone with no devtools.
    await initAccess(location(`https://app.example/?key=${SECRET}`), grants);
    await expect(
      initAccess(location('https://app.example/?key=a-well-formed-wrong-key'), refuses),
    ).resolves.toBe('denied');
    expect(accessSecretValue()).toBeNull();
    expect(accessHeaders()).toEqual({});
    expect(globalThis.localStorage.getItem(ACCESS_STORAGE_KEY)).toBeNull();
  });

  it('is REVOKED by a malformed key without asking the server', async () => {
    await initAccess(location(`https://app.example/?key=${SECRET}`), grants);
    let asked = false;
    await expect(
      initAccess(location('https://app.example/?key=%20'), () => {
        asked = true;
        return Promise.resolve('granted' as const);
      }),
    ).resolves.toBe('denied');
    expect(asked, 'a key that cannot be a key is not worth a round trip').toBe(false);
    expect(accessSecretValue()).toBeNull();
  });

  it('does NOT revoke when the server could not be reached', async () => {
    // A dead connection at the moment of setup — which is the moment the owner
    // is most likely to be somewhere with bad signal — must not throw away a
    // correct credential.
    await expect(
      initAccess(location(`https://app.example/?key=${SECRET}`), unreachable),
    ).resolves.toBe('unverified');
    expect(accessSecretValue()).toBe(SECRET);
    expect(accessHeaders()).toEqual({ [ACCESS_HEADER]: SECRET });
  });

  it('sends nothing at all when there has been no exchange', async () => {
    await expect(initAccess(location('https://app.example/lookup'), grants)).resolves.toBe('none');
    expect(accessHeaders()).toEqual({});
  });
});

describe('the API base', () => {
  it('is same-origin when no VITE_API_BASE was built in', () => {
    // Which is every build so far: `backend.md` has not deployed a server, and
    // the dev and preview servers answer /api/** themselves.
    expect(apiUrl('/api/ask')).toBe('/api/ask');
    expect(apiUrl('/api/examples?band=1')).toBe('/api/examples?band=1');
  });
});

describe('the routes', () => {
  it('401s a POST with no header and lets one with the header through', async () => {
    process.env.TANGRAM_ACCESS_SECRET = SECRET;

    // Imported lazily: with the variable set *before* the handlers run, this
    // exercises the gate as the deployment does.
    const [ask, examples, recall] = await Promise.all([
      import('@/app/api/ask/route'),
      import('@/app/api/examples/route'),
      import('@/app/api/recall/route'),
    ]);

    const post = (path: string, value?: string): Request =>
      new Request(`https://tangram.example${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(value ? { [ACCESS_HEADER]: value } : {}),
        },
        body: JSON.stringify({}),
      });

    for (const [path, handler] of [
      ['/api/ask', ask.POST],
      ['/api/examples', examples.POST],
      ['/api/recall', recall.POST],
    ] as const) {
      const refused = await handler(post(path));
      expect(refused.status, path).toBe(401);
      expect(await refused.json(), path).toEqual({ error: 'unauthorized' });

      // With the header the gate is out of the way: the empty body is now the
      // route's own 400, which is the proof it got past the gate.
      const admitted = await handler(post(path, SECRET));
      expect(admitted.status, path).toBe(400);
    }

    // The handshakes are gated too — they are on the same routes.
    expect(ask.GET(new Request('https://tangram.example/api/ask')).status).toBe(401);
    expect(examples.GET(new Request('https://tangram.example/api/examples')).status).toBe(401);
  });

  // "It leaves the dictionary routes open — they cost CPU, not money" lived
  // here and went with them (`data.md` D6): every API route this app still has
  // reaches a paid model, so there is no ungated handler left to assert against.
  // The gate's own boundary is covered by `isGatedPath` above, and
  // `apps/server/tests/routes.test.ts` is what asserts the server answers 404
  // rather than 401 for a deleted dictionary path (wave-zero §10a).
});
