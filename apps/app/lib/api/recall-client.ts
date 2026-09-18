/**
 * Free recall's request, pointed at the API base and carrying the credential.
 *
 * **This fixes a bug `backend.md` B1 would otherwise have shipped, and the bug
 * predates B1.** `requestRecallGrade` (`packages/ai/recall.ts`) calls
 * `fetchImpl('/api/recall', …)` — a **relative** path, through the global
 * `fetch`. Until B1 that happened to work: the dev and preview servers mounted
 * the handlers on the app's own origin, so a same-origin `/api/recall` found
 * one. Two things were already wrong with it and one becomes fatal:
 *
 *  - **It never carried `X-Tangram-Access`.** Against a deployment with
 *    `TANGRAM_ACCESS_SECRET` set, every free-recall grade was already a 401 —
 *    swallowed silently, because `requestRecallGrade` turns any failure into
 *    "no suggestion" and the four grade buttons stay live either way. A feature
 *    that fails invisibly is a feature nobody reports.
 *  - **It ignored `VITE_API_BASE`.** After B1 the handlers are on
 *    `apps/server`, and a relative `/api/recall` from a static build reaches
 *    the app's own origin, which has no API at all. That is the "dead path the
 *    adapter's removal leaves behind" this phase had to look for.
 *
 * The seam was already there — `RecallRequestOptions.fetchImpl`, "injected by
 * tests; production uses the global" — so the fix is to stop production using
 * the global. `packages/ai/recall.ts` is unchanged, which matters: it is a
 * frozen shared surface and the path it sends is correct *relative to whatever
 * fetch it is given*. What was missing was an app-side default, and this is it.
 *
 * It lives beside `contract.ts` rather than in `lib/ai/`: `wave-zero.md` §5
 * reserves `apps/app/lib/ai/` for `backend.md` B2's `ask-client.ts` alone and
 * `tests/unit/ai/contract.test.ts` enforces it. `lib/api/` is where this app's
 * view of the server lives, which is what this is.
 *
 * `ask-panel.tsx`, `example-sentences.tsx` and `context-gloss.tsx` already went
 * through `apiFetch`; this was the one caller that did not.
 * `tests/unit/server/routes.test.ts` now refuses a literal `/api/…` fetch
 * anywhere in `apps/app`, so the next one fails in the suite rather than in a
 * deployment.
 */
import { requestRecallGrade, type RecallRequest } from '@tangram/ai/recall';

import { apiFetch } from '@/src/access/client';

/**
 * `apiFetch` in the shape `RecallRequestOptions.fetchImpl` wants.
 *
 * `fetchImpl` is typed `typeof fetch`, whose first argument is a
 * `RequestInfo | URL`; `requestRecallGrade` only ever passes the string
 * `'/api/recall'`, and `apiFetch` only accepts a path. The coercion is
 * therefore honest for every call that actually happens, and anything else is
 * a caller bug rather than a case to handle.
 */
const apiFetchImpl: typeof fetch = (input, init) => apiFetch(String(input), init ?? {});

/**
 * The production `RecallRequest`: the same pipeline, over the API base, with
 * the access header attached.
 *
 * `options` spreads **after** the default so a caller — a test, or
 * `productionRecallRequest`'s pass-through — can still supply its own
 * `fetchImpl` and win.
 */
export const appRecallRequest: RecallRequest = (input, options) =>
  requestRecallGrade(input, { fetchImpl: apiFetchImpl, ...options });
