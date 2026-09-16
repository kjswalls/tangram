'use client';

/**
 * The ask module — the browser half of `backend.md` B2's contract flip, and the
 * **only** file `wave-zero.md` §5 allows under `apps/app/lib/ai/`.
 *
 * Everything the merged `POST /api/ask` used to do on the server happens here,
 * except the model call:
 *
 *   1. the cache, keyed on `askCacheKey` — checked before anything is asked;
 *   2. **retrieval**, against the dictionary this device now holds
 *      (`mergedSearch`, and `candidateEntries` over phrases the model proposes);
 *   3. the two round trips — `/api/ask/propose` (skipped when
 *      `needsProposals()` says the dictionary already answered) and
 *      `/api/ask/answer`;
 *   4. **`ground()`**, over the same dictionary, which is what makes the answer
 *      renderable at all;
 *   5. the empty-answer fallback, and the rule about what may be cached.
 *
 * ## Why this is where the grounding contract now lives
 *
 * `PLAN.md` §3.4 and `CLAUDE.md`'s "the dictionary is ground truth and the model
 * never emits a headword for display" are unchanged by the flip — but the party
 * that enforces them moved, because the party that holds the dictionary moved.
 * The server returns `response` **schema-validated and not grounded**; nothing
 * between here and the screen does any of it. So, concretely, every one of these
 * is this module's:
 *
 *  - a cited id outside `retrieved` is dropped (`ground()`, and `retrieved` is a
 *    set this module built, not one a response can widen);
 *  - a sense index past the end of the cited entry's glosses is dropped;
 *  - CJK runs and model-written pinyin are stripped from every prose field;
 *  - a `{text}` token is flagged "AI-generated, not in dictionary" on that token
 *    alone, and a rendered phrase that does not re-segment as real words is
 *    flagged `unverified`.
 *
 * `ground.ts` is imported, not reimplemented, and it is **not** made async:
 * `withStoreContext` (`packages/ai/retrieve.ts`) is the seam that runs a pure
 * synchronous `ground()` over an asynchronous `DictStore`, and
 * `tests/unit/ai/ground.test.ts` and `attacks.test.ts` are the encoding of the
 * promise. They did not change in this phase and must not.
 *
 * ## The fallback, and the one rule about the cache
 *
 * A schema-valid answer can ground to **nothing at all** — the commonest thing a
 * live model does is write the Chinese into `interpretation` and cite an id it
 * was never given. §3.4's "no query ever renders an empty panel" is a promise
 * about what is on screen, so the dictionary answers instead, in its own voice
 * (`retrievalEcho`). That substitution used to be the server's, along with the
 * `cacheable: false` it set; after the flip the server cannot compute it,
 * because the server no longer grounds. So `cacheable` left the wire and the
 * rule is stated once, here: **the cache stores the grounded response, and the
 * echoed fallback is never cached.**
 *
 * Two consequences, both load-bearing and both unchanged by the flip. Rows
 * written before it still parse, because the cached shape is
 * `GroundedAskResponse` exactly as before — which is what keeps `lib/dev/seed.ts`'s
 * two pre-warmed rows valid. And `AskCacheRow`'s licence invariant ("ids and
 * indexes only — never gloss text") still holds, because a grounded response is
 * cited ids and an ungrounded one is model prose.
 */

import { askCacheKey } from '@tangram/ai/cache-key';
import { retrievalEcho } from '@tangram/ai/fake';
import {
  groundWithStore,
  candidateEntries,
  mergeRetrieved,
  mergedSearch,
  needsProposals,
} from '@tangram/ai/retrieve';
import { groundedAskResponseSchema, type GroundedAskResponse } from '@tangram/ai/ground';
import {
  ASK_ANSWER_PATH,
  ASK_INFO_PATH,
  ASK_PROPOSE_PATH,
  toRetrieved,
  type AskAnswerResponse,
  type AskInfoResponse,
  type AskProposeResponse,
  type ProviderName,
} from '@tangram/ai/schemas';

import type { AskUnavailableReason } from '@/components/lookup/ask-state';
import { getRepository } from '@/lib/db/get-db';
import { getDictStore } from '@/lib/dict/browser-store';
import type { DictStore } from '@/lib/dict/store';
import type { Repository } from '@/lib/db/repository';
import { getLearnerProfile } from '@/lib/srs/profile';
import type { CardContext, Entry, EntryId } from '@/lib/types';

import { apiFetch } from '@/src/access/client';

/** The seam a test replaces. Production is `apiFetch`, which applies the API
 *  base and attaches `X-Tangram-Access` (`web.md` W4). */
export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The handshake the app falls back to when it cannot be read.
 *
 * Exported because the trustworthiness test below compares against it **by
 * identity**: a guessed handshake must never key a cache row.
 */
export const FALLBACK_INFO: AskInfoResponse = { provider: 'fake', promptVersion: 'v1' };

let infoRequest: Promise<AskInfoResponse> | undefined;

/**
 * Which provider is live and under which prompt version — two of the five parts
 * of the cache key, so the client has to know them before it can look in the
 * cache. Memoised per page load; it is one small request.
 *
 * A *failed* handshake is never memoised. Guessing "fake" once and keeping the
 * guess for the life of the page keys every later cache row under the wrong
 * provider, writes live answers into fake-shaped rows, and paints the offline
 * badge over an answer a model wrote. One transient error must not do that.
 */
export function askInfo(fetchImpl: ApiFetch = apiFetch): Promise<AskInfoResponse> {
  infoRequest ??= fetchImpl(ASK_INFO_PATH, { headers: { accept: 'application/json' } })
    .then((res) => {
      if (res.ok) return res.json() as Promise<AskInfoResponse>;
      infoRequest = undefined;
      return FALLBACK_INFO;
    })
    .catch(() => {
      infoRequest = undefined;
      return FALLBACK_INFO;
    });
  return infoRequest;
}

/** Tests only: the handshake is memoised for the life of the page, not the suite. */
export function resetAskInfo(): void {
  infoRequest = undefined;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Our own deadline, not the learner navigating away: this one is worth saying. */
export function isTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}

/**
 * Why no model could be reached. The chip does not show it — it is here so the
 * state is a *reachability* fact rather than a shrug, and so a later phase can
 * say "rate-limited" without re-deriving it from a message string.
 */
export function unavailableReason(error: unknown): AskUnavailableReason {
  if (isTimeout(error)) return 'timeout';
  // A fetch that never reached a server throws a TypeError, and the browser
  // already knows the likeliest reason.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (error instanceof TypeError) return 'offline';
  return 'server';
}

/** The same, for a response that did arrive. */
export function statusReason(status: number): AskUnavailableReason {
  if (status === 429) return 'rate-limited';
  if (status === 401 || status === 403) return 'no-key';
  return 'server';
}

/** Every entry a grounded answer cites, deduped. */
export function citedIds(response: GroundedAskResponse): EntryId[] {
  const ids = new Set<EntryId>();
  for (const match of response.matches) ids.add(match.entryId);
  for (const phrase of response.sayIt) {
    for (const token of phrase.tokens) if (token.entryId) ids.add(token.entryId);
  }
  return [...ids];
}

export interface AskInput {
  query: string;
  context?: CardContext;
}

export interface AskOptions {
  signal?: AbortSignal;
  /** Injected by tests. Production reads the browser dictionary and Dexie. */
  store?: DictStore;
  repository?: Repository;
  fetchImpl?: ApiFetch;
  /**
   * Write a trustworthy grounded answer to `ask_cache`. Default true.
   *
   * `useContextGloss` (`core.md` C4) passes false: the panel owns this key and
   * its trustworthiness rules, and a second writer with a simpler idea of when
   * an answer is worth keeping is how a cache starts lying.
   */
  cache?: boolean;
}

export type AskOutcome =
  | {
      state: 'answered';
      /** Grounded. Ids and indexes; every hanzi on screen is rendered from `entries`. */
      response: GroundedAskResponse;
      /** Every entry the answer cites, read from this device's dictionary. */
      entries: Entry[];
      /** The CC-CEDICT snapshot those rows came from; stamped onto any card added. */
      dictVersion: string;
      provider: ProviderName;
      /** The answer came out of `ask_cache` rather than off the wire. */
      cached: boolean;
      /**
       * The provider's own answer grounded to nothing and the dictionary
       * answered instead. Never cached, and the panel still has something to
       * draw — which is the whole of "no query ever renders an empty panel".
       */
      fallback: boolean;
    }
  | { state: 'unavailable'; reason: AskUnavailableReason; message: string };

/** A body the three routes may answer with when they refuse (`ContractErrorBody`). */
interface ErrorBody {
  error?: string;
  hint?: string;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  return body?.hint ?? `The ask service answered HTTP ${res.status}.`;
}

/**
 * Ask about a query, and come back with something renderable or with a reason.
 *
 * It never throws for an ordinary failure — a refused network, a 502, a
 * timeout, a dictionary that will not open are all `unavailable`, because the
 * dictionary card beside this panel is already on screen and already addable
 * and none of them is allowed to take it away. An `AbortError` from the
 * caller's own signal is the one exception and is rethrown, because "the
 * learner typed another letter" is not a state worth rendering.
 */
export async function ask(input: AskInput, options: AskOptions = {}): Promise<AskOutcome> {
  const fetchImpl = options.fetchImpl ?? apiFetch;
  const { signal } = options;
  const query = input.query.trim();
  const context = input.context;

  if (!query) {
    return { state: 'unavailable', reason: 'server', message: 'Nothing to ask about.' };
  }

  try {
    const repo = options.repository ?? getRepository();
    const [info, profile] = await Promise.all([askInfo(fetchImpl), getLearnerProfile(repo)]);

    const key = await askCacheKey({
      query,
      ...(context ? { context } : {}),
      estimatedBand: profile.estimatedBand,
      provider: info.provider,
      promptVersion: info.promptVersion,
    });

    const store = options.store ?? getDictStore();
    const dictVersion = (): string => (store.status.state === 'ready' ? store.status.version : '');

    // 1 — the cache. Ids and indexes are all it holds, so the dictionary text is
    // read fresh from this device rather than redistributed out of IndexedDB.
    const row = await repo.askCache.get(key).catch(() => undefined);
    const cached = row ? groundedAskResponse(row.response) : undefined;
    if (cached) {
      const ids = citedIds(cached);
      const entries = ids.length > 0 ? await store.entries(ids) : [];
      return {
        state: 'answered',
        response: cached,
        entries,
        dictVersion: dictVersion(),
        provider: info.provider,
        cached: true,
        fallback: false,
      };
    }

    // 2 — retrieval, on this device. `mergedSearch` is the dictionary's own
    // answer; the proposals are the model helping it find words an English
    // question does not match as a gloss.
    const fromSearch = await mergedSearch(store, query);
    let candidates: string[] = [];
    if (await needsProposals(store, query)) {
      candidates = await propose(fetchImpl, query, context, signal);
    }
    const retrieved = mergeRetrieved(fromSearch, await candidateEntries(store, candidates));

    // 3 — the answer. `toRetrieved` is what makes the six-field projection true
    // at runtime: assignability is a compile-time fact and `JSON.stringify` is
    // not, so without it the whole `Entry` would go on the wire.
    const res = await fetchImpl(ASK_ANSWER_PATH, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        query,
        ...(context ? { context } : {}),
        profile,
        dictVersion: dictVersion(),
        retrieved: retrieved.map(toRetrieved),
      }),
    });
    if (!res.ok) {
      return {
        state: 'unavailable',
        reason: statusReason(res.status),
        message: await errorMessage(res),
      };
    }
    const body = (await res.json()) as AskAnswerResponse;

    // 4 — grounding, against the same entries the prompt was built from. Nothing
    // the model cited outside `retrieved` survives this line.
    let response = await groundWithStore(body.response, store, retrieved);
    let fallback = false;
    if (
      response.interpretation.length === 0 &&
      response.matches.length === 0 &&
      response.sayIt.length === 0
    ) {
      response = await groundWithStore(retrievalEcho(retrieved), store, retrieved);
      fallback = true;
    }

    // 5 — the cache. Three things must hold: the answer is the provider's own
    // rather than the dictionary's stand-in, the handshake was real rather than
    // the offline guess, and the provider that answered is the one the key was
    // derived for.
    const trustworthy = !fallback && info !== FALLBACK_INFO && body.provider === info.provider;
    if (trustworthy && options.cache !== false) {
      await repo.askCache.set(key, response).catch(() => undefined);
    }

    const ids = citedIds(response);
    const entries = ids.length > 0 ? await store.entries(ids) : [];
    return {
      state: 'answered',
      response,
      entries,
      dictVersion: dictVersion(),
      provider: body.provider,
      cached: false,
      fallback,
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      state: 'unavailable',
      reason: unavailableReason(error),
      message: isTimeout(error)
        ? 'The ask took too long and was given up on.'
        : 'The ask panel could not answer that one.',
    };
  }
}

/**
 * The first round trip, and the reason it is allowed to fail quietly.
 *
 * Proposals are *retrieval help* (§3.4): the dictionary search already stands
 * without them, and a query that needed them simply retrieves less well. That
 * is what `app/api/ask/route.ts` did inside one request — `catch { candidates =
 * [] }` — and it is what the split has to keep doing, one process further
 * along. The caller's own abort is rethrown, because that is not a failure.
 */
async function propose(
  fetchImpl: ApiFetch,
  query: string,
  context: CardContext | undefined,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  try {
    const res = await fetchImpl(ASK_PROPOSE_PATH, {
      method: 'POST',
      ...(signal ? { signal } : {}),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, ...(context ? { context } : {}) }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as AskProposeResponse;
    return Array.isArray(body.candidates) ? body.candidates : [];
  } catch (error) {
    if (isAbort(error)) throw error;
    return [];
  }
}

/**
 * A cache row, parsed back into something renderable, or `undefined`.
 *
 * `groundedAskResponseSchema`'s flags are optional precisely so that rows
 * written before those flags existed — `lib/dev/seed.ts`'s two pre-warmed ones,
 * and anything written before B2 — still parse and still render.
 */
function groundedAskResponse(value: unknown): GroundedAskResponse | undefined {
  const parsed = groundedAskResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
