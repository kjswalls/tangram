/**
 * `POST /api/ask` (PLAN.md §3.4) — the grounded ask pipeline.
 *
 *   1. merged dictionary search on the query; for English or sentence input,
 *      also `proposePhrases`, segment each candidate, and union every token's
 *      entries into the retrieved set (capped at 40);
 *   2. `answer(retrieved, profile, query, context)`;
 *   3. `ground()` — drop uncited ids, render phrases from the dictionary, flag
 *      what could not be verified, strip CJK from the prose;
 *   4. return the validated answer plus the entries needed to render it.
 *
 * `GET /api/ask` is a handshake: which provider is active and which prompt
 * version it answers under. The client needs both *before* it calls, because
 * they are two of the five parts of the cache key — and the offline badge has
 * to be right even when every answer on the page came from the cache.
 *
 * Failure modes, all of them answers rather than crashes: a missing `data/`
 * build is the same `503 {error:'dict-data-missing'}` the dictionary routes
 * give, a malformed body is a 400, and a provider that throws, times out or
 * returns something unparseable is a 502 with a message the panel can show.
 */

import { withDeadline } from '@tangram/ai/deadline';
import { ASK_PROMPT_VERSION } from '@tangram/ai/cache-key';
import { selectProvider, askResponseSchema, ProviderError, type AskContext } from '@tangram/ai/provider';
import { retrievalEcho } from '@tangram/ai/fake';
import {
  RETRIEVED_CAP,
  SEARCH_HEAD,
  candidateEntries,
  groundWithStore,
  mergeRetrieved,
  mergedSearch,
} from '@tangram/ai/retrieve';
import { hasCjk } from '@/lib/dict/rank';
import { dictErrorResponse, serverDictStore } from '@/lib/server/dict';
import type { DictStore } from '@/lib/dict/store';
import type { AskRouteInfo, AskRouteResponse } from '@/lib/api/contract';
import type { Entry, EntryId, HskBand, LearnerProfile } from '@/lib/types';
import { DEFAULT_MODEL } from '@tangram/ai/anthropic';
import { requireAccess } from '@tangram/access';
import { deadlineMs, isDevelopment, modelName } from '../config.ts';

/**
 * The retrieval constants live in `packages/ai/retrieve.ts` (docs/plans/data.md
 * D3 and D6) and are re-exported rather than redeclared: two copies of a cap is
 * how a cap drifts, and `tests/unit/ai/route.test.ts` reads them from here.
 */
export { RETRIEVED_CAP, SEARCH_HEAD };

/**
 * **How long a provider may take is `src/config.ts`'s now** —
 * `DEADLINE_DEFAULTS.askPropose` (8 s) and `.askAnswer` (30 s), the same two
 * numbers and the same two environment variables this file used to hold.
 *
 * A cron is not waiting on these; a person is, with "Thinking about …" on
 * screen and no way out but retyping, so a hung upstream has to become an
 * answer rather than a spinner. The proposal step gets the short one: it is
 * retrieval help (§3.4), and the dictionary search already stands without it.
 *
 * They moved because this server's rule is that a handler takes values rather
 * than reaching for `process`, and `tests/config.test.ts` names `backend.md` B1
 * — this move — as the phase the rule was written for. `deadlineMs` still reads
 * the environment on every call, so a test that sets
 * `TANGRAM_ASK_ANSWER_TIMEOUT_MS` between cases still works.
 */

/** Everything below is a limit on what a *caller* may send. */
const MAX_QUERY_CHARS = 400;
const MAX_SENTENCE_CHARS = 400;
const MAX_KNOWN_SAMPLE = 200;

interface AskRequestBody {
  query: string;
  context?: AskContext;
  profile: LearnerProfile;
}

function badRequest(hint: string): Response {
  return Response.json({ error: 'bad-request', hint }, { status: 400 });
}

function parseBody(payload: unknown): AskRequestBody | string {
  if (typeof payload !== 'object' || payload === null) return 'send JSON { query, profile }';
  const body = payload as Record<string, unknown>;

  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return 'pass a non-empty { query }';
  if (query.length > MAX_QUERY_CHARS) return `query is at most ${MAX_QUERY_CHARS} characters`;

  const rawProfile = (body.profile ?? {}) as Record<string, unknown>;
  const band = Number(rawProfile.estimatedBand);
  const estimatedBand: HskBand =
    Number.isInteger(band) && band >= 1 && band <= 7 ? (band as HskBand) : 1;
  const knownSample = Array.isArray(rawProfile.knownSample)
    ? rawProfile.knownSample
        .filter((word): word is string => typeof word === 'string')
        .slice(0, MAX_KNOWN_SAMPLE)
    : [];

  const rawContext = body.context as Record<string, unknown> | undefined | null;
  let context: AskContext | undefined;
  if (rawContext && typeof rawContext === 'object') {
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_SENTENCE_CHARS) : undefined;
    const number = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const built: AskContext = {
      ...(text(rawContext.sentence) === undefined ? {} : { sentence: text(rawContext.sentence) }),
      ...(text(rawContext.question) === undefined ? {} : { question: text(rawContext.question) }),
      ...(text(rawContext.query) === undefined ? {} : { query: text(rawContext.query) }),
      ...(number(rawContext.offset) === undefined ? {} : { offset: number(rawContext.offset) }),
      ...(number(rawContext.length) === undefined ? {} : { length: number(rawContext.length) }),
    };
    if (Object.keys(built).length > 0) context = built;
  }

  return { query, ...(context ? { context } : {}), profile: { estimatedBand, knownSample } };
}

/**
 * Does this query need the model's help to find words? A headword does not —
 * the dictionary already answered it. An English question or a whole sentence
 * does: nothing in the gloss index matches "how do I say I'm just browsing".
 */
export async function needsProposals(store: DictStore, query: string): Promise<boolean> {
  if (!hasCjk(query)) return true;
  const segmented = await store.segment(query);
  return segmented.tokens.filter((token) => token.kind === 'word').length >= 3;
}

/**
 * `mergedSearch`, `candidateEntries` and `mergeRetrieved` used to live here, in
 * a JSON-index-backed copy that `data.md` D3 ported to `lib/ai/retrieve.ts` over
 * a `DictStore` and `tests/unit/ai/retrieve.test.ts` proved equal entry for
 * entry. **D6 deletes the copy** — this route imports the port, and the equality
 * test now reads the port against `tests/unit/ai/golden/retrieve.json`, frozen
 * from these three functions on the commit before they went.
 *
 * `RETRIEVED_CAP` and `SEARCH_HEAD` are re-exported above rather than redeclared:
 * they are the port's constants now, and two copies of a cap is how a cap drifts.
 */

/**
 * The access gate (`@tangram/access`). A no-op unless `TANGRAM_ACCESS_SECRET`
 * is set in the environment; when it is, this route costs money and answers
 * nothing without the `X-Tangram-Access` header. Until `web.md` W1 this was the
 * SECOND of two layers — `middleware.ts` refused the same request one earlier —
 * and it is the only one here, because there is no middleware in a Vite SPA.
 * `backend.md` B1 puts the front layer back on the server, matching the gated
 * paths by PREFIX (`isGatedPath`, `wave-zero.md` §10a), because B2's contract
 * adds `/api/ask/propose` and `/api/ask/answer` underneath this path. The check
 * staying in the handler is what makes a missing front layer a redundancy
 * rather than a hole.
 */
export function GET(request: Request): Response {
  const denied = requireAccess(request);
  if (denied) return denied;

  const provider = selectProvider();
  const info: AskRouteInfo = {
    provider: provider.name,
    promptVersion: ASK_PROMPT_VERSION,
    ...(provider.name === 'anthropic' ? { model: modelName(DEFAULT_MODEL) } : {}),
  };
  return Response.json(info);
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAccess(request);
  if (denied) return denied;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('send JSON { query, context?, profile }');
  }

  const parsedBody = parseBody(payload);
  if (typeof parsedBody === 'string') return badRequest(parsedBody);
  const { query, context, profile } = parsedBody;

  const provider = selectProvider();

  // Everything that touches the dictionary sits inside this try: a missing
  // data/ build is a 503 with the same body the other routes answer with.
  let store: DictStore;
  let retrieved: Entry[];
  try {
    store = await serverDictStore();
    const fromSearch = await mergedSearch(store, query);
    let candidates: string[] = [];
    if (await needsProposals(store, query)) {
      try {
        candidates = (
          await withDeadline(
            provider.proposePhrases(query, context),
            deadlineMs('askPropose'),
            'proposePhrases',
          )
        ).candidates;
      } catch (error) {
        // Retrieval help is optional; the dictionary search still stands.
        candidates = [];
        if (isDevelopment()) console.warn('proposePhrases failed', error);
      }
    }
    retrieved = mergeRetrieved(fromSearch, await candidateEntries(store, candidates));
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }

  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.answer(retrieved, profile, query, context),
      deadlineMs('askAnswer'),
      'the answer',
    );
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'the provider failed';
    return Response.json(
      { error: 'provider-failed', provider: provider.name, hint: message },
      { status: 502 },
    );
  }

  const parsed = askResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        error: 'provider-invalid',
        provider: provider.name,
        hint: `the answer did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      },
      { status: 502 },
    );
  }

  // `groundWithStore` is the synchronous/asynchronous seam D3 built: `ground()`
  // itself is untouched and still takes a synchronous `GroundContext`, and the
  // store answers what each round asked for and could not be told.
  let grounded = await groundWithStore(parsed.data, store, retrieved);
  let cacheable = true;

  // A schema-valid answer can ground to nothing at all: writing the Chinese
  // into `interpretation` (the commonest thing a live model does) and citing an
  // id it was never given leaves `{interpretation:'', matches:[], sayIt:[]}` —
  // which the panel would render as a heading over an empty section, and then
  // cache. §3.4's "no query ever renders an empty panel" is a promise about
  // what is on screen, so the dictionary answers instead, in its own voice.
  if (
    grounded.interpretation.length === 0 &&
    grounded.matches.length === 0 &&
    grounded.sayIt.length === 0
  ) {
    grounded = await groundWithStore(retrievalEcho(retrieved), store, retrieved);
    cacheable = false;
  }

  // Only the entries the answer actually cites travel back: the client renders
  // hanzi and pinyin from these rows, and the other 30-odd are the model's
  // problem, not the browser's.
  const cited = new Set<EntryId>();
  for (const match of grounded.matches) cited.add(match.entryId);
  for (const phrase of grounded.sayIt) {
    for (const token of phrase.tokens) if (token.entryId) cited.add(token.entryId);
  }

  const citedEntries = await store.entries([...cited]);

  const body: AskRouteResponse = {
    provider: provider.name,
    promptVersion: ASK_PROMPT_VERSION,
    ...(provider.name === 'anthropic' ? { model: modelName(DEFAULT_MODEL) } : {}),
    query,
    dictVersion: store.status.state === 'ready' ? store.status.version : '',
    response: grounded,
    entries: citedEntries,
    retrieved: retrieved.length,
    cacheable,
  };
  return Response.json(body);
}
