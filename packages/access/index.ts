/**
 * The shared-secret access gate for the routes that spend money.
 *
 * Tangram is a single-user app on a public URL. `/api/ask`, `/api/examples` and
 * `/api/recall` are the routes that reach a paid model, so once
 * `ANTHROPIC_API_KEY` is set in a deployment anybody who finds the URL can
 * spend the owner's money on them. This module is the whole of the defence.
 *
 * **It is a workspace package because two deployables run it.** It was
 * `apps/app/lib/server/access.ts`, next to the handlers; `web.md` W4 moves it
 * here and `backend.md` B1's Files list already names `packages/access/**`.
 * Nothing here has ever imported from a framework — that was deliberate from
 * the day it was written, and it is why the move costs nothing.
 *
 * Four rules shape it:
 *
 *  1. **Absent secret means absent gate.** With `TANGRAM_ACCESS_SECRET` unset —
 *     local `pnpm dev`, the unit suite, `pnpm e2e` — every function here says
 *     "open" and the app behaves exactly as it did before this file existed.
 *     A gate that changed local behaviour would be turned off within a week.
 *  2. **A header, not a cookie** — `X-Tangram-Access`, carrying the secret
 *     verbatim exactly as the cookie did. See the note below; this is the one
 *     behavioural change W4 makes and it is a real change in posture.
 *  3. **The comparison never short-circuits and the secret never travels.** A
 *     wrong key gets a flat `401 {"error":"unauthorized"}` — no stack trace, no
 *     hint, no echo of what was sent, and nothing is written to the log. The
 *     only thing an attacker learns is that the gate is on.
 *  4. **A gated path is matched by PREFIX, never by exact string.**
 *     `wave-zero.md` §10a, and it has a security consequence rather than a
 *     stylistic one: `backend.md` B2's frozen contract adds `/api/ask/propose`
 *     and `/api/ask/answer` — **the two routes that actually spend the money** —
 *     under `/api/ask`. An exact-string gate leaves both open with the secret
 *     set, and every existing test passes. `isGatedPath` is that rule, and
 *     `packages/ai/schemas.ts` records it beside the paths themselves.
 *
 * **Who enforces it.** Each handler calls `requireAccess` as its first line —
 * a helper rather than a matcher-driven middleware on purpose, because "the
 * expensive route is defended by a config file" is the shape of a gate that is
 * off in production and nobody notices. `isGatedPath` is for the layer *in
 * front* of the handlers, which is `backend.md` B1's, on the server where the
 * three routes now live. **`web.md` W4 owns only the client half — attaching
 * the header** (`apps/app/src/access/client.ts`) — and ships this rule here
 * rather than leaving B1 to re-derive it from a path list.
 *
 * **The posture change, stated rather than sold as free.** The credential used
 * to be an `HttpOnly` cookie, and the old code said why: *"a stored credential
 * that `document.cookie` can reach is one XSS away from being public."* Under
 * W4 the same verbatim secret is script-readable, attached by page script, and
 * there is no CSP in this repo. It is acceptable for exactly one reason: this
 * gate protects **spend on three routes**, not user data — every card, review
 * and setting lives in the learner's own IndexedDB — and it is superseded by
 * real accounts (STACK §2.8). Why the header at all, when a cookie would still
 * cross from `app.<domain>` to `api.<domain>`: a Capacitor WebView on
 * `capacitor://localhost` or `http://localhost` is cross-site to the API and
 * gets no cookie at all, and `ios.md`, `android.md` and `web.md` W9 all consume
 * that same build. A header also avoids credentialed CORS on every platform.
 *
 * It rotates the way it always did: change the environment variable and every
 * issued secret dies at once, because there is no session store to fall out of
 * sync with.
 */

/**
 * The header every gated request carries. **This name is the contract between
 * two plans written by different sessions** — `web.md` W4 attaches it,
 * `backend.md` B1 reads it, and B1's CORS allowlist must name it in
 * `Access-Control-Allow-Headers` or the browser's preflight fails every
 * cross-origin POST before the handler is reached.
 */
export const ACCESS_HEADER = 'x-tangram-access';

/** The query parameter that trades a key for a stored credential: `/?key=<secret>`. */
export const ACCESS_QUERY_PARAM = 'key';

/**
 * The marker the client leaves in the URL after it has taken the key out, so a
 * phone with no devtools can still tell which of the two things happened.
 */
export const ACCESS_RESULT_PARAM = 'access';

/** The routes that reach a paid model, and the only ones this gate covers. */
export const GATED_PATHS = ['/api/ask', '/api/examples', '/api/recall'] as const;

/**
 * Is this path behind the gate?
 *
 * **Prefix, not equality** — see rule 4. This is exactly what the deleted
 * `middleware.ts` did (`pathname === path || pathname.startsWith(path + '/')`),
 * which nobody had written down anywhere, which is how the question came to be
 * reopened by the server session and answered in `wave-zero.md` §10a.
 *
 * `/api/asking` is NOT gated by `/api/ask`: the boundary is a path separator,
 * not a string prefix, or `GATED_PATHS` would silently cover routes nobody
 * listed.
 */
export function isGatedPath(pathname: string, paths: readonly string[] = GATED_PATHS): boolean {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * The configured secret, or `null` when there is none.
 *
 * Whitespace-only counts as none: a hosting UI happily stores a variable whose
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
 * Written by hand rather than with `node:crypto.timingSafeEqual` because this
 * module has to run wherever the gate does, including runtimes with no
 * `node:crypto`. The loop length still follows the *candidate's* length, which
 * tells an attacker only how long their own guess was.
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
 * Is this request allowed to reach a gated route?
 *
 * Reads `X-Tangram-Access`. `Headers.get` is case-insensitive and returns the
 * value with surrounding whitespace already stripped by the HTTP layer, so
 * there is no parser here the way there was for the cookie — the whole of
 * `readCookie` went with the cookie, and one fewer hand-rolled parser in front
 * of a credential is the one unambiguous improvement in this change.
 */
export function isAuthorizedRequest(
  request: Request,
  env?: Record<string, string | undefined>,
): boolean {
  if (accessSecret(env) === null) return true;
  return isAuthorizedValue(request.headers.get(ACCESS_HEADER), env);
}

/**
 * The one body a refused request ever sees. No hint, no provider name, no echo
 * of what was sent — the response is the same whether the caller sent nothing,
 * a malformed header or a near-miss.
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
 */
export function requireAccess(
  request: Request,
  env?: Record<string, string | undefined>,
): Response | null {
  return isAuthorizedRequest(request, env) ? null : unauthorizedResponse();
}
