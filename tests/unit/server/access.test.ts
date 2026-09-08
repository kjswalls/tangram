/**
 * The access gate (`lib/server/access.ts`), and the three routes that call it.
 *
 * The property that matters most is the one asserted first: with
 * `TANGRAM_ACCESS_SECRET` unset, nothing changes. Every other test in this repo
 * runs in that state, so a gate that leaked into the default would be a
 * thousand failures, not one — but it is worth one deliberate test anyway,
 * because "we would have noticed" is not a test.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  ACCESS_COOKIE,
  accessCookie,
  accessGateEnabled,
  accessSecret,
  clearAccessCookie,
  constantTimeEqual,
  GATED_PATHS,
  isAuthorizedRequest,
  readCookie,
  requireAccess,
  unauthorizedResponse,
} from '@/lib/server/access';

const SECRET = 'sesame-open-1234';

/** An env object, so nothing here mutates `process.env` for its neighbours. */
const gated = { TANGRAM_ACCESS_SECRET: SECRET };
const open: Record<string, string | undefined> = {};

function request(cookie?: string, url = 'https://tangram.example/api/ask'): Request {
  return new Request(url, cookie ? { headers: { cookie } } : undefined);
}

afterEach(() => {
  delete process.env.TANGRAM_ACCESS_SECRET;
});

describe('with no secret configured', () => {
  it('is not a gate at all', () => {
    expect(accessSecret(open)).toBeNull();
    expect(accessGateEnabled(open)).toBe(false);
    expect(isAuthorizedRequest(request(), open)).toBe(true);
    expect(requireAccess(request(), open)).toBeNull();
  });

  it('treats a whitespace-only value as no secret', () => {
    // Vercel will happily store a variable whose value is a stray newline, and
    // a gate that admitted "\n" would look like a gate and not be one.
    expect(accessSecret({ TANGRAM_ACCESS_SECRET: '   \n' })).toBeNull();
    expect(isAuthorizedRequest(request(`${ACCESS_COOKIE}=   `), { TANGRAM_ACCESS_SECRET: ' ' })).toBe(
      true,
    );
  });

  it('trims the configured secret rather than requiring the padding back', () => {
    expect(accessSecret({ TANGRAM_ACCESS_SECRET: ` ${SECRET}\n` })).toBe(SECRET);
  });
});

describe('with a secret configured', () => {
  it('refuses a request with no cookie', () => {
    expect(isAuthorizedRequest(request(), gated)).toBe(false);
  });

  it('refuses the wrong cookie, including a prefix of the right one', () => {
    expect(isAuthorizedRequest(request(`${ACCESS_COOKIE}=nope`), gated)).toBe(false);
    expect(isAuthorizedRequest(request(`${ACCESS_COOKIE}=${SECRET.slice(0, -1)}`), gated)).toBe(false);
    expect(isAuthorizedRequest(request(`${ACCESS_COOKIE}=${SECRET}x`), gated)).toBe(false);
  });

  it('accepts the right cookie, wherever it sits in the header', () => {
    expect(isAuthorizedRequest(request(`${ACCESS_COOKIE}=${SECRET}`), gated)).toBe(true);
    expect(
      isAuthorizedRequest(request(`a=1; ${ACCESS_COOKIE}=${SECRET}; theme=dark`), gated),
    ).toBe(true);
  });

  it('is not fooled by a cookie whose name merely ends with ours', () => {
    expect(isAuthorizedRequest(request(`not_${ACCESS_COOKIE}=${SECRET}`), gated)).toBe(false);
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

describe('readCookie', () => {
  it('handles absent, empty and malformed headers', () => {
    expect(readCookie(null, ACCESS_COOKIE)).toBeNull();
    expect(readCookie('', ACCESS_COOKIE)).toBeNull();
    expect(readCookie('justaflag', ACCESS_COOKIE)).toBeNull();
    expect(readCookie(`${ACCESS_COOKIE}=`, ACCESS_COOKIE)).toBe('');
    expect(readCookie(` ${ACCESS_COOKIE} = v `, ACCESS_COOKIE)).toBe('v');
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

describe('the cookie', () => {
  it('is HttpOnly, Lax, rooted and long-lived', () => {
    const cookie = accessCookie(SECRET, { secure: true }) as string;
    expect(cookie).toContain(`${ACCESS_COOKIE}=${SECRET}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/Max-Age=\d{6,}/);
  });

  it('drops Secure for a plain-HTTP check, or the local test never authorises', () => {
    expect(accessCookie(SECRET, { secure: false })).not.toContain('Secure');
  });

  it('refuses a secret that cannot be a cookie value verbatim', () => {
    // Encoding it would mean the cookie no longer equals the secret, and two
    // representations of one credential is how a gate grows a hole.
    expect(accessCookie('has spaces', { secure: true })).toBeNull();
    expect(accessCookie('has;semicolon', { secure: true })).toBeNull();
    expect(accessCookie('密码', { secure: true })).toBeNull();
    expect(accessCookie('fine-Secret_1.2~3', { secure: true })).not.toBeNull();
  });

  it('clears with Max-Age=0', () => {
    expect(clearAccessCookie({ secure: true })).toContain('Max-Age=0');
  });
});

describe('the routes', () => {
  it('names exactly the three that reach a paid model', () => {
    expect([...GATED_PATHS]).toEqual(['/api/ask', '/api/examples', '/api/recall']);
  });

  it('401s a POST with no cookie and lets one with the cookie through', async () => {
    process.env.TANGRAM_ACCESS_SECRET = SECRET;

    // Imported lazily: with the variable set *before* the handlers run, this
    // exercises the gate as the deployment does.
    const [ask, examples, recall] = await Promise.all([
      import('@/app/api/ask/route'),
      import('@/app/api/examples/route'),
      import('@/app/api/recall/route'),
    ]);

    const post = (path: string, cookie?: string): Request =>
      new Request(`https://tangram.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
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

      // With the cookie the gate is out of the way: the empty body is now the
      // route's own 400, which is the proof it got past the gate.
      const admitted = await handler(post(path, `${ACCESS_COOKIE}=${SECRET}`));
      expect(admitted.status, path).toBe(400);
    }

    // The handshakes are gated too — they are on the same routes.
    expect(ask.GET(new Request('https://tangram.example/api/ask')).status).toBe(401);
    expect(examples.GET(new Request('https://tangram.example/api/examples')).status).toBe(401);
  });

  it('leaves the dictionary routes open — they cost CPU, not money', async () => {
    process.env.TANGRAM_ACCESS_SECRET = SECRET;
    const search = await import('@/app/api/dict/search/route');
    const response = search.GET(new Request('https://tangram.example/api/dict/search?q=%E4%BD%A0'));
    expect(response.status).toBe(200);
  });
});
