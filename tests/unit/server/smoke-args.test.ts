/**
 * The two places a script handles the access key, and the one place it handles a
 * URL somebody pasted.
 *
 * Neither is about smoke coverage; both are about a credential. `pnpm smoke` and
 * `pnpm coldstart` share `parseArgs`/`accessHeaders` (scripts/smoke.ts) so that
 * there is one implementation of "where does the key come from and where does it
 * go", and these cases pin the two ways it used to escape:
 *
 *  1. **A key `fetch` refuses.** `undici` throws `Headers.append: "tangram_access=…"
 *     is an invalid header value` — with the value inside the message — and both
 *     scripts print that message. The malformed key is not hypothetical: the gate
 *     trims the secret (`lib/server/access.ts`) precisely because Vercel's UI will
 *     store a variable whose value ends in a newline, and that variable is both
 *     scripts' default key.
 *  2. **A `?key=` in `--base-url`.** That is the URL `docs/deploy.md` tells the
 *     owner to visit to authorise a phone, so it is the paste to expect — and it
 *     used to be echoed to stdout and concatenated onto every request path, which
 *     is exactly what `middleware.ts` redirects the key out of the URL to prevent.
 */
import { describe, expect, it } from 'vitest';

import { ACCESS_COOKIE } from '@/lib/server/access';
import { accessHeaders, parseArgs, scrubSecret } from '@/scripts/smoke';

const NEWLINE_KEY = 'bad\nsecret-XYZ';

describe('accessHeaders', () => {
  it('sends the secret as the gate cookie and nothing else', () => {
    expect(accessHeaders('sekret-abc123')).toEqual({ cookie: `${ACCESS_COOKIE}=sekret-abc123` });
  });

  it('sends nothing when there is no key', () => {
    expect(accessHeaders(undefined)).toEqual({});
    expect(accessHeaders('')).toEqual({});
  });

  it('refuses a key that is not usable as a cookie value, naming the rule not the value', () => {
    // The message is printed; the key must not be in it.
    let message = '';
    try {
      accessHeaders(NEWLINE_KEY);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('COOKIE_SAFE_SECRET');
    expect(message).not.toContain('secret-XYZ');
    expect(message).not.toContain(NEWLINE_KEY);
  });
});

describe('scrubSecret', () => {
  it('takes every occurrence of the key out of a message', () => {
    const thrown = `Headers.append: "${ACCESS_COOKIE}=${NEWLINE_KEY}" is invalid (${NEWLINE_KEY})`;
    const printed = scrubSecret(thrown, NEWLINE_KEY);
    expect(printed).not.toContain('secret-XYZ');
    expect(printed).toContain('<key>');
  });

  it('leaves a message alone when there is no key to scrub', () => {
    expect(scrubSecret('fetch failed', undefined)).toBe('fetch failed');
  });
});

describe('parseArgs', () => {
  it('takes the base URL from the flag and the key from --key', () => {
    expect(parseArgs(['--base-url', 'https://x.example.com', '--key', 'abc'])).toEqual({
      baseURL: 'https://x.example.com',
      secret: 'abc',
    });
  });

  it('lifts a pasted ?key= out of the base URL instead of pasting it into every request', () => {
    expect(parseArgs(['--base-url', 'https://x.example.com/?key=s3cret'])).toEqual({
      baseURL: 'https://x.example.com',
      secret: 's3cret',
    });
  });

  it('refuses a base URL with a path, which every caller would concatenate onto', () => {
    expect(() => parseArgs(['--base-url', 'https://x.example.com/app'])).toThrow(/origin/);
    expect(() => parseArgs(['--base-url', 'not-a-url'])).toThrow(/not a URL/);
  });
});
