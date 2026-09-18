/**
 * The cross-origin allowlist (docs/plans/backend.md B0 and B1).
 *
 * The app and the API are two origins on purpose — `app.<domain>` and
 * `api.<domain>` (B0), `web.md` W7's split — and on phones the app is not on a
 * domain at all: Capacitor serves `capacitor://localhost` on iOS and
 * `http://localhost` on Android, and `ios.md` I1 and `android.md` A1 owe this
 * plan exactly those two strings. So every call the app makes is cross-origin
 * on every platform, which is why this file exists at all.
 *
 * **Why the preflight is the part that matters.** `web.md` W4 authorises a
 * request with the `X-Tangram-Access` header, and a custom request header makes
 * every cross-origin `POST` a *preflighted* one. So the allowlist is not one
 * header: the browser sends `OPTIONS` first, and unless that answer names the
 * method **and** `x-tangram-access` in `Access-Control-Allow-Headers`, the
 * `POST` is never sent. B1's acceptance criterion says so, and it also says to
 * assert it with a browser rather than with `curl` — `curl` ignores CORS
 * entirely and will cheerfully tell you it works.
 *
 * **CORS is not the gate and must never be mistaken for one.** It is a rule a
 * *browser* applies to a response it has already received; `curl`, a script and
 * a native HTTP client ignore it. What stops a stranger spending the owner's
 * money is `@tangram/access` (`wave-zero.md` §10a, matched by PREFIX), and that
 * runs in front of the handler whatever the origin says. Two consequences are
 * deliberate here:
 *
 *  - **A request with no `Origin` header is answered normally.** `curl`,
 *    `pnpm -F server smoke`, a native fetch and a server-to-server call all
 *    send none. Refusing them would break the smoke and the phones and protect
 *    nothing.
 *  - **A request from a disallowed origin is also answered** — it simply gets
 *    no `Access-Control-Allow-Origin`, so the browser discards the response
 *    before any script sees it. Refusing it outright would leak the allowlist's
 *    contents to anyone probing, and would still not stop a non-browser caller.
 *
 * `Vary: Origin` is on every response this module touches, allowed or not: the
 * body varies by origin, and a shared cache that missed that would hand one
 * origin's `Access-Control-Allow-Origin` to another.
 */
import type { Env } from './config.ts';

/**
 * The origins a shipped Tangram runs from that are not on any domain.
 *
 * Both are recorded facts rather than guesses. `HANDOFF.md` under `ios.md` I1:
 * "the default origin is `capacitor://localhost`", read off the generated
 * project. `web.md` §393: "Capacitor serves `capacitor://localhost` on iOS and
 * `http://localhost` on Android". They are in every deployment's allowlist
 * because one build ships to three places and the phones have no other origin
 * to be given.
 */
export const NATIVE_ORIGINS = ['capacitor://localhost', 'http://localhost'] as const;

/**
 * The development origins, allowed only when the server is not in production.
 *
 * 3000 is `pnpm preview` and the Playwright base URL (CLAUDE.md, and
 * `playwright.config.ts`'s `PORT`); 5173 is Vite's dev default. Both spellings
 * of loopback are listed because an `Origin` header carries the host verbatim
 * and `localhost` and `127.0.0.1` are different origins to a browser.
 *
 * They are **not** in a production allowlist. A production server that trusted
 * `http://localhost:3000` would let a page on any developer's machine call it
 * cross-origin; the gate still stands in front, but an allowlist that admits
 * an origin nobody deploys to is an allowlist that is not saying anything.
 */
export const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

/** The variable a deployment sets to `https://app.<domain>`; comma-separated. */
export const ORIGINS_ENV = 'TANGRAM_ALLOWED_ORIGINS';

export interface CorsPolicy {
  /** Every origin this server will echo back, lowercased and trimmed. */
  origins: ReadonlySet<string>;
}

/**
 * Read the allowlist.
 *
 * `env` is required rather than defaulted, so that this module contains no
 * `process` reference at all: `tests/config.test.ts` walks `src/` and allows
 * that only in the four modules that exist to read the environment. `index.ts`
 * hands it in.
 *
 * The configured origins are additive to the native ones, never a replacement:
 * a deployment that sets `TANGRAM_ALLOWED_ORIGINS=https://app.example.com` and
 * thereby locked out both phone builds is a failure that would show up only on
 * a device, which is the one place this project cannot test
 * (`backend.md` §4 item 4).
 */
export function readCorsPolicy(env: Env, production: boolean): CorsPolicy {
  const origins = new Set<string>(NATIVE_ORIGINS);
  if (!production) for (const origin of DEV_ORIGINS) origins.add(origin);
  for (const raw of (env[ORIGINS_ENV] ?? '').split(',')) {
    const origin = normalise(raw);
    if (origin !== null) origins.add(origin);
  }
  return { origins };
}

/**
 * An origin in the one form this module compares.
 *
 * An `Origin` header is a serialized origin — scheme, host and (if non-default)
 * port, with no path and no trailing slash. A configured value is typed by a
 * person into a hosting UI, so `https://app.example.com/` and a stray space are
 * both expected. Scheme and host are case-insensitive; anything that is not a
 * parseable absolute URL is dropped rather than half-matched.
 */
export function normalise(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    // `URL.origin` is the serialization, and it is `'null'` for a scheme the
    // URL standard calls opaque — which `capacitor://localhost` is. So the
    // string is normalised by hand for those and only validated by `URL`.
    const url = new URL(trimmed);
    const origin = url.origin;
    if (origin !== 'null') return origin;
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export function isAllowedOrigin(origin: string, policy: CorsPolicy): boolean {
  const normalised = normalise(origin);
  return normalised !== null && policy.origins.has(normalised);
}

/**
 * The methods a preflight advertises, for one route.
 *
 * Per route rather than a constant: `/api/recall` answers `POST` only, and a
 * preflight that advertised `GET` would let a browser send one through to a 405
 * it could have refused locally. It is not a security boundary — the gate and
 * the router are — but a preflight is the server describing itself, and
 * describing a verb it does not answer is the same class of small lie as an
 * `Allow` header that omits one.
 */
export function allowedMethods(methods: readonly string[]): string {
  return [...methods, 'OPTIONS'].join(', ');
}

/**
 * The request headers a cross-origin caller may send.
 *
 * `x-tangram-access` is the one that makes this file load-bearing: it is the
 * credential `web.md` W4's client attaches, its name is the contract between
 * the two plans, and a preflight that omits it fails every gated `POST` before
 * the handler is reached. `content-type` is needed because `application/json`
 * is not a CORS-safelisted value, and `accept` because the handshake sends one.
 */
export const ALLOWED_HEADERS = 'content-type, accept, x-tangram-access';

/** How long a browser may cache the preflight. 24 h; Chromium caps it there. */
export const PREFLIGHT_MAX_AGE = '86400';

/**
 * The CORS headers for one request, or just `Vary` when there is nothing to
 * allow.
 *
 * `credentials` is deliberately absent, and its absence is what lets the
 * allowlist be an exact list rather than a wildcard problem: the credential is
 * a header, not a cookie, so the app never asks for `credentials: 'include'`
 * (`apps/app/src/access/client.ts` says so at the one `fetch` that matters) and
 * this server never has to answer `Access-Control-Allow-Credentials`.
 */
export function corsHeaders(origin: string | null, policy: CorsPolicy): Record<string, string> {
  const headers: Record<string, string> = { vary: 'Origin' };
  if (origin === null || !isAllowedOrigin(origin, policy)) return headers;
  headers['access-control-allow-origin'] = origin;
  return headers;
}

/** The extra headers a preflight answer carries on top of `corsHeaders`. */
export function preflightHeaders(
  origin: string | null,
  policy: CorsPolicy,
  methods: readonly string[],
): Record<string, string> {
  const headers = corsHeaders(origin, policy);
  if (headers['access-control-allow-origin'] === undefined) return headers;
  return {
    ...headers,
    'access-control-allow-methods': allowedMethods(methods),
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': PREFLIGHT_MAX_AGE,
  };
}
