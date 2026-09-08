/**
 * The shared-secret access gate for the routes that spend money.
 *
 * Tangram is a single-user app on a public URL. `/api/ask`, `/api/examples` and
 * `/api/recall` are the three routes that reach a paid model, so once
 * `ANTHROPIC_API_KEY` is set in the deployment anybody who finds the URL can
 * spend the owner's money on it. This module is the whole of the defence.
 *
 * Three rules shape it:
 *
 *  1. **Absent secret means absent gate.** With `TANGRAM_ACCESS_SECRET` unset —
 *     local `pnpm dev`, the unit suite, `pnpm e2e` — every function here says
 *     "open" and the app behaves exactly as it did before this file existed.
 *     A gate that changed local behaviour would be turned off within a week.
 *  2. **A cookie, not a header.** The owner tests on a phone, and a phone
 *     browser cannot set a request header. One visit to
 *     `https://<app>/?key=<secret>` leaves an `HttpOnly` cookie behind and the
 *     phone is authorised for a year; `middleware.ts` does that exchange and
 *     strips the key back out of the URL so it does not sit in history or leak
 *     through a `Referer`.
 *  3. **The comparison never short-circuits and the secret never travels.** A
 *     wrong key gets a flat `401 {"error":"unauthorized"}` — no stack trace, no
 *     hint, no echo of what was sent, and nothing is written to the log. The
 *     only thing an attacker learns is that the gate is on.
 *
 * The cookie carries the secret verbatim. That is a deliberate simplification
 * and it is worth being plain about: the cookie *is* the credential, so anyone
 * holding it has the same access as anyone holding the key. It buys two things
 * — a synchronous check with no crypto in the request path, and rotation that
 * actually works: change the environment variable and every cookie ever issued
 * stops being valid at the same instant, because there is no stored session to
 * fall out of sync with.
 *
 * Nothing here imports from `next/*`, so `middleware.ts` (Edge runtime), the
 * route handlers (Node runtime) and the unit tests all run the same code.
 */

/** The cookie `middleware.ts` sets and the routes read. */
export const ACCESS_COOKIE = 'tangram_access';

/** The query parameter that trades a key for the cookie: `/?key=<secret>`. */
export const ACCESS_QUERY_PARAM = 'key';

/**
 * The marker middleware leaves in the URL after it has taken the key out, so a
 * phone with no devtools can still tell which of the two things happened.
 */
export const ACCESS_RESULT_PARAM = 'access';

/** A year. The point of the cookie is that the phone is set up once. */
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** The routes that reach a paid model, and the only ones this gate covers. */
export const GATED_PATHS = ['/api/ask', '/api/examples', '/api/recall'] as const;

/**
 * The configured secret, or `null` when there is none.
 *
 * Whitespace-only counts as none: Vercel's UI happily stores a variable whose
 * value is a stray newline, and a gate that admits `"\n"` is worse than no gate
 * because it looks like one.
 */
export function accessSecret(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.TANGRAM_ACCESS_SECRET;
  if (typeof raw !== 'string') return null;
  const secret = raw.trim();
  return secret.length > 0 ? secret : null;
}

/** True when this deployment has a gate at all. */
export function accessGateEnabled(env?: Record<string, string | undefined>): boolean {
  return accessSecret(env) !== null;
}

/**
 * Compare two strings without leaking where they first differ.
 *
 * `a === b` returns as soon as it finds a difference, so the time it takes is a
 * measurement of how much of the secret the caller has already guessed. This
 * walks the full length of the longer input every time and folds every
 * difference — including the length difference — into one accumulator.
 *
 * It is written by hand rather than with `node:crypto.timingSafeEqual` because
 * middleware runs on the Edge runtime, where `node:crypto` is not there. The
 * loop length still follows the *candidate's* length, which tells an attacker
 * only how long their own guess was.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

/** Does this presented value open the gate? */
export function isAuthorizedValue(
  value: string | null | undefined,
  env?: Record<string, string | undefined>,
): boolean {
  const secret = accessSecret(env);
  if (secret === null) return true;
  if (typeof value !== 'string' || value.length === 0) return false;
  return constantTimeEqual(value, secret);
}

/**
 * Read one cookie out of a raw `Cookie:` header.
 *
 * Hand-rolled because `middleware.ts` has `NextRequest.cookies` but a plain
 * `Request` in a route handler does not, and one parser used by both is one
 * behaviour to test. Values are not URL-decoded: the cookie is written by
 * `accessCookie()` below, which refuses to write anything that would need it.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Is this request allowed to reach a gated route? */
export function isAuthorizedRequest(
  request: Request,
  env?: Record<string, string | undefined>,
): boolean {
  if (accessSecret(env) === null) return true;
  return isAuthorizedValue(readCookie(request.headers.get('cookie'), ACCESS_COOKIE), env);
}

/**
 * The one body a refused request ever sees. No hint, no provider name, no echo
 * of what was sent — the response is the same whether the caller sent nothing,
 * a malformed cookie or a near-miss.
 */
export function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      // A 401 that a cache or a service worker could hand to the next visitor
      // would be a gate with a memory.
      'cache-control': 'no-store',
    },
  });
}

/**
 * What every gated route handler calls first: `null` to carry on, or the
 * response to return instead.
 *
 * A helper rather than middleware alone, on purpose. Middleware is a matcher
 * away from silently not running (a matcher edit, a rewrite, a future
 * `output: 'export'`), and "the expensive route is defended by a config file"
 * is the shape of a gate that is off in production and nobody notices. The
 * handler defends itself; middleware is the layer that also handles the phone.
 */
export function requireAccess(
  request: Request,
  env?: Record<string, string | undefined>,
): Response | null {
  return isAuthorizedRequest(request, env) ? null : unauthorizedResponse();
}

/**
 * What a secret must look like to be usable verbatim as a cookie value: the
 * URL-safe alphabet, which is also every character `openssl rand -base64url`
 * and `crypto.randomUUID()` can produce. Deliberately narrower than RFC 6265's
 * cookie-octet — it also has to survive a `?key=` round trip through a phone
 * keyboard and a QR code.
 */
export const COOKIE_SAFE_SECRET = /^[A-Za-z0-9._~-]+$/;

export interface AccessCookieOptions {
  /** Add `Secure`. True on Vercel; false for a plain-HTTP local check. */
  secure: boolean;
  maxAgeSeconds?: number;
}

/**
 * The `Set-Cookie` value that authorises this browser.
 *
 * `HttpOnly` because no script needs to read it and a stored credential that
 * `document.cookie` can reach is one XSS away from being public. `SameSite=Lax`
 * so a link from a message app still arrives authorised, while a cross-site
 * `POST` does not — the gated routes are all POSTs.
 *
 * Returns `null` for a secret that cannot be written into a cookie value
 * (whitespace, `;`, `,`, quotes, anything non-ASCII). Encoding it instead would
 * mean the cookie no longer equals the secret, and two representations of one
 * credential is how a gate ends up with a hole in it. `docs/deploy.md` says to
 * use a URL-safe random string, and this is what enforces it.
 */
export function accessCookie(secret: string, options: AccessCookieOptions): string | null {
  if (!COOKIE_SAFE_SECRET.test(secret)) return null;
  const maxAge = options.maxAgeSeconds ?? ACCESS_COOKIE_MAX_AGE_SECONDS;
  const parts = [
    `${ACCESS_COOKIE}=${secret}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** The `Set-Cookie` value that removes it again. */
export function clearAccessCookie(options: AccessCookieOptions): string {
  const parts = [`${ACCESS_COOKIE}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
