/**
 * The client half of the access gate (docs/plans/web.md W4).
 *
 * **What this replaces.** `middleware.ts` traded `?key=<secret>` for an
 * `HttpOnly` cookie and stripped the key back out of the URL, and Next invoked
 * it. There is no middleware in a static SPA, so between W1 and W4 nothing
 * could authorise a device at all: with `TANGRAM_ACCESS_SECRET` set, the three
 * routes that reach a paid model refused everyone. This module is the
 * replacement, and it does the same three things the middleware's redirect did,
 * in the page instead of in front of it.
 *
 * `lib/server/access.ts`'s own header said why the credential was a cookie:
 * *"The owner tests on a phone, and a phone browser cannot set a request
 * header."* In an SPA, JavaScript sets the header — which is the whole of the
 * change, and the reason `@tangram/access` could move without the phone
 * workflow being lost.
 *
 * **The flow, unchanged from the learner's side.**
 *
 *  1. Visit `https://<app>/?key=<secret>` once, on the phone.
 *  2. The secret is kept, `key` is removed from the URL — so it is not left in
 *     history, in a bookmark or in a `Referer` — and `?access=granted` is left
 *     behind as the only feedback a phone with no devtools can read.
 *  3. A wrong key leaves `?access=denied` **and revokes** whatever was stored,
 *     because a wrong key is an attempt to change the key.
 *  4. Every call to the API base then carries `X-Tangram-Access`.
 *
 * **Where the secret is kept, and the posture change that comes with it.**
 * `localStorage`, under one key, read once at boot into module state. Not
 * IndexedDB — that is the learner's data store and is what W5's export dumps —
 * and not memory alone, since the point of the exchange is that the phone is
 * set up once. The credential is now **script-readable**: it was `HttpOnly`,
 * and the old code said why (*"a stored credential that `document.cookie` can
 * reach is one XSS away from being public"*). That is a real change in posture
 * and it is acceptable for exactly one reason, which belongs here rather than
 * in a commit message: **this gate protects spend on three routes, not user
 * data.** Every card, review and setting lives in this browser's IndexedDB and
 * was never behind it; the gate exists because "anybody who finds the URL can
 * spend the owner's money". It is superseded by real accounts (STACK §2.8), and
 * it rotates the way it always did — change the environment variable and every
 * issued secret dies at once.
 *
 * **What the gate does not cover, stated because it is now visible.** Not the
 * page HTML. The middleware's matcher already excluded the static shell and a
 * static host serves it to anyone who asks. If the app's HTML itself must be
 * private, that is host-level protection, not application code
 * (`docs/deploy.md` §5).
 */
import { ACCESS_HEADER, ACCESS_QUERY_PARAM, ACCESS_RESULT_PARAM } from '@tangram/access';

/** One key, and a name that says what it is when somebody opens devtools. */
export const ACCESS_STORAGE_KEY = 'tangram.access.secret';

/**
 * Where the API lives.
 *
 * **Required from `backend.md` B1 onwards.** It was optional while the dev and
 * preview servers answered `/api/**` themselves through the adapter W1 built;
 * B1 moved the three model routes to `apps/server` and deleted that adapter, so
 * an empty base now means "this origin", which serves no API. `pnpm e2e` sets
 * it in `apps/app/.env.e2e`, `pnpm dev` in `.env.development`, and a deployment
 * sets it to `https://api.<domain>` (`docs/deploy.md` §4). See `readApiBase`
 * for what happens when nobody does.
 *
 * Read once, here, rather than at each call site: `import.meta.env` is
 * substituted at build time, so a second reading is a second chance to spell it
 * differently.
 */
export const API_BASE: string = readApiBase();

/**
 * Whether this build has an API to talk to at all.
 *
 * **False means "not configured on this deployment"**: a production build made
 * with `VITE_API_BASE` empty. It is decided at build time and nothing the
 * learner does changes it, which is why it is a constant rather than something
 * a surface discovers by trying — and why every AI surface can say so on first
 * paint instead of after a request fails. The other way there can be no API,
 * "configured but unreachable right now", is transient and can only be learnt
 * by asking; `lib/api/availability.ts` reads that one off a failed request.
 *
 * Outside a production build an empty base is left alone: vitest and the unit
 * suite stub `fetch` against relative paths, and `pnpm dev` always sets a base
 * through `.env.development`.
 */
export const API_CONFIGURED: boolean = apiConfigured(import.meta.env as ApiEnv | undefined);

/** The two build-time constants the decision reads. */
export interface ApiEnv {
  VITE_API_BASE?: string;
  PROD?: boolean;
}

/** Pure, so the derivation has a unit test that is not a second build. */
export function apiConfigured(env: ApiEnv | undefined): boolean {
  const base = (env?.VITE_API_BASE ?? '').trim();
  return base.length > 0 || env?.PROD !== true;
}

/**
 * What `apiFetch` rejects with when there is no API to call, **without calling
 * anything**. Distinct from the `TypeError` a refused connection produces, so a
 * caller can tell "there is no server" from "the server did not answer".
 */
export class ApiNotConfiguredError extends Error {
  constructor() {
    super('This build has no API configured (VITE_API_BASE is empty).');
    this.name = 'ApiNotConfiguredError';
  }
}

function readApiBase(): string {
  // `import.meta.env` is Vite's, substituted at build time. The optional chain
  // is not defensive programming for its own sake: this module is reachable
  // from code that has run under plain Node, where `import.meta.env` does not
  // exist and a bare property read throws before anything can catch it.
  const env = import.meta.env as ApiEnv | undefined;
  const base = (env?.VITE_API_BASE ?? '').trim().replace(/\/$/, '');

  // **An empty base in a production build is an app with no AI, and it says
  // so.** Until `backend.md` B1 the dev and preview servers answered `/api/**`
  // on the app's own origin; since B1 this origin serves no API at all. The
  // app's answer is `API_CONFIGURED` above: `apiFetch` refuses without touching
  // the network, and ask, example sentences and free recall each show the
  // not-configured state instead of failing into a generic error.
  //
  // Nothing can fail the build over it: `pnpm build` is run locally by someone
  // who has no server, and refusing would be worse than the disease. The
  // console line stays for the one person debugging a deployment from
  // devtools. `docs/deploy.md` §4 is the other half.
  if (!apiConfigured(env)) {
    console.warn(
      'tangram: VITE_API_BASE is unset in a production build, so this app has no API. ' +
        'Ask, example sentences and free recall say so on screen. See docs/deploy.md §4.',
    );
  }
  return base;
}

/** Module state, populated by `initAccess()` at boot. */
let secret: string | null = null;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari in a blocked-storage mode throws on the *property*, not on use.
    return null;
  }
}

function read(): string | null {
  try {
    const value = storage()?.getItem(ACCESS_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function write(value: string | null): void {
  try {
    if (value === null) storage()?.removeItem(ACCESS_STORAGE_KEY);
    else storage()?.setItem(ACCESS_STORAGE_KEY, value);
  } catch {
    // A private window with storage denied still gets the header for this
    // session — `secret` is module state and the exchange already happened.
  }
}

export type AccessExchange =
  | 'granted'
  | 'denied'
  | 'unverified'
  | 'unreachable'
  | 'no-api'
  | 'none';

/**
 * What the exchange can say about a key. `none` is "there was no key to trade".
 *
 * Three of these are verdicts **about the key** and two are not, and keeping
 * them apart is the point:
 *
 *  - `granted` / `denied` — the server checked it.
 *  - `unverified` — a server answered and could not say (a 5xx, a 429).
 *  - `unreachable` — nothing that answered was the API: the connection was
 *    refused or dropped, or whatever is at the base 404s the probe. Transient
 *    as far as the client can tell, so the key is kept.
 *  - `no-api` — this build has no API configured (`API_CONFIGURED`). Nothing
 *    was asked, because there is nobody to ask, and the key is kept for the
 *    day a build that has one is deployed to the same origin.
 *
 * Before these two existed, both collapsed into `unverified`, so a phone with
 * a perfectly good key on a deployment with no server was told its key could
 * not be checked — forever, and with nothing it could do about it.
 */
export type AccessVerdict = Exclude<AccessExchange, 'none'>;

/**
 * Take `?key=` out of a URL and say what should replace it.
 *
 * Pure, and separated from the browser so its cases have a unit test that is
 * not a jsdom navigation. Returns `null` for a URL that carried no key, which
 * is the overwhelmingly common case and must not rewrite history.
 */
export function exchangeUrl(
  href: string,
  result: AccessVerdict | null,
): { url: string; key: string } | null {
  const url = new URL(href);
  const key = url.searchParams.get(ACCESS_QUERY_PARAM);
  if (key === null) return null;

  url.searchParams.delete(ACCESS_QUERY_PARAM);
  if (result !== null) url.searchParams.set(ACCESS_RESULT_PARAM, result);
  return { url: `${url.pathname}${url.search}${url.hash}`, key };
}

/**
 * What counts as a usable key before it is presented.
 *
 * A **shape** check and nothing more: only the server holds the secret, so this
 * cannot say whether a key is right — see `probe` below for what does. What it
 * catches is the case a phone actually produces: an empty `?key=`, or one
 * mangled by a QR scan or an autocorrecting keyboard. It keeps the stored value
 * to the alphabet `docs/deploy.md` tells the owner to generate.
 */
export const KEY_SHAPE = /^[A-Za-z0-9._~-]{8,512}$/;

/** The handshake the exchange presents the key to. Free: it calls no model. */
export const PROBE_PATH = '/api/ask';

/**
 * Ask the server whether this key opens the gate.
 *
 * **This is the half `middleware.ts` got for free and an SPA does not.** The
 * middleware ran on the server and could compare the presented key against the
 * secret itself; page script cannot, so it presents the key to the one route
 * that will answer cheaply and reads the status. 200 means the gate let it
 * through (or there is no gate); 401 means the key is wrong.
 */
async function probe(key: string): Promise<AccessVerdict> {
  try {
    const response = await fetch(apiUrl(PROBE_PATH), {
      headers: { accept: 'application/json', [ACCESS_HEADER]: key },
    });
    return verdictOf(response.status);
  } catch {
    // A transient network failure must NOT revoke a key. Reporting `denied`
    // here would throw away a correct credential because the phone happened to
    // be on a dead connection at the moment of setup — the one moment the owner
    // is most likely to be somewhere with bad signal.
    return 'unreachable';
  }
}

/**
 * The probe's status, read as a verdict. Pure, for the unit test.
 *
 * **404 is `unreachable`, not `unverified`.** The probe path is one the API
 * always serves, so a 404 means whatever answered is not the API — a static
 * host, a wrong base — and the key was never looked at. Calling that
 * "unverified" is how a good key used to be reported as doubtful when the real
 * news was that there is no server.
 */
export function verdictOf(status: number): AccessVerdict {
  if (status === 401) return 'denied';
  if (status === 404) return 'unreachable';
  return status >= 200 && status < 300 ? 'granted' : 'unverified';
}

/**
 * Run the exchange, and load whatever was stored before it.
 *
 * Called once from the client entry, before anything can reach the API. The
 * key is stripped out of the URL **synchronously**, before the first `await`,
 * so it is never in an address bar the router then reads or a `Referer` the
 * first navigation sends. The verdict lands a round trip later.
 *
 * Idempotent: a second call re-reads storage and finds no `?key=` to trade.
 */
export function initAccess(
  location: Location = globalThis.location,
  check: (key: string) => Promise<AccessVerdict> = probe,
  configured: boolean = API_CONFIGURED,
): Promise<AccessExchange> {
  secret = read();

  const stripped = exchangeUrl(location.href, null);
  if (!stripped) return Promise.resolve('none');
  // Taken from `href` rather than from `location.origin`: the two always agree
  // in a browser, and taking it from one place means a caller passing a stub
  // (the unit tests do) has one field to supply rather than two.
  const origin = new URL(location.href).origin;

  // A key whose shape is wrong never reaches the network, and it revokes: see
  // below for why any bad key revokes.
  if (!KEY_SHAPE.test(stripped.key)) {
    revokeAccess();
    replaceUrl(exchangeUrl(location.href, 'denied')?.url);
    return Promise.resolve('denied');
  }

  // Stored and attached from this moment, so a component that fires during the
  // first render is already carrying it. The verdict only decides whether it
  // stays.
  secret = stripped.key;
  write(stripped.key);
  replaceUrl(stripped.url);

  // No API in this build: there is nobody to present the key to, so nobody is
  // asked, and the key is kept — it is not bad, it is unchecked for a reason
  // that has nothing to do with it.
  if (!configured) {
    replaceUrl(withResult(stripped.url, origin, 'no-api'));
    return Promise.resolve('no-api');
  }

  return check(stripped.key).then((result) => {
    if (result === 'denied') {
      // REVOKE, exactly as the middleware's `clearAccessCookie` did: arriving
      // with a bad key is an attempt to change the key, and leaving the old one
      // in place would make the failure unexplainable on a phone with no
      // devtools.
      revokeAccess();
    }
    replaceUrl(withResult(stripped.url, origin, result));
    return result;
  });
}

function replaceUrl(url: string | undefined): void {
  if (url !== undefined) globalThis.history?.replaceState(null, '', url);
}

/**
 * The stripped URL with `?access=<result>` on it.
 *
 * Separate from `exchangeUrl` because by this point the key is already gone —
 * `exchangeUrl` returns null for a URL with no `key`, deliberately, so that the
 * common case cannot rewrite history.
 */
export function withResult(
  path: string,
  origin: string,
  result: AccessVerdict,
): string {
  const url = new URL(path, origin);
  url.searchParams.set(ACCESS_RESULT_PARAM, result);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The stored secret, or null. Exported for the tests and for `apiFetch`. */
export function accessSecretValue(): string | null {
  return secret;
}

/** Forget the credential — sign-out, and what a wrong key does. */
export function revokeAccess(): void {
  secret = null;
  write(null);
}

/**
 * The headers a gated call carries. Empty when there is no secret, which is
 * every local run and is what keeps `pnpm dev`, `pnpm test` and `pnpm e2e`
 * identical to a deployment with no gate.
 */
export function accessHeaders(): Record<string, string> {
  return secret === null ? {} : { [ACCESS_HEADER]: secret };
}

/** An API URL: the configured base, or same-origin when there is none. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * `fetch` against the API base, with the credential attached.
 *
 * **Every call that reaches `/api/**` goes through this**, gated or not. Two
 * reasons it is not "only the three paid routes": the base has to be applied
 * uniformly or a dictionary call goes to the wrong origin the day the API
 * moves, and a caller that has to remember which of two fetchers to use is a
 * caller that will eventually pick the wrong one. Sending the header to an
 * ungated route costs nothing — the routes that do not read it ignore it.
 *
 * `credentials` is deliberately left at the default (`same-origin`): the
 * credential is a header, so there is nothing to include, and asking for
 * `include` would make every cross-origin call a *credentialed* CORS request,
 * which needs an exact-origin `Access-Control-Allow-Origin` and cannot use `*`.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  // The one chokepoint for "no API in this build". Every surface also checks
  // `API_CONFIGURED` itself so it can say so before anything is tried; this is
  // what makes it impossible for one that forgot to reach the network anyway.
  if (!API_CONFIGURED) return Promise.reject(new ApiNotConfiguredError());
  return fetch(apiUrl(path), {
    ...init,
    headers: { ...accessHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
}
