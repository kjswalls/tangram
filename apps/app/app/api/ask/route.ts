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

import { withDeadline } from '@/lib/ai/deadline';
import { ground, type GroundedAskResponse } from '@/lib/ai/ground';
import { ASK_PROMPT_VERSION } from '@/lib/ai/cache-key';
import { selectProvider, askResponseSchema, ProviderError, type AskContext, type ProviderName } from '@/lib/ai/provider';
import { retrievalEcho } from '@/lib/ai/fake';
import { getDictIndex, getEntry, readingCount } from '@/lib/dict/index';
import { dictErrorResponse } from '@/lib/dict/load';
import { search, hasCjk } from '@/lib/dict/search';
import { segment } from '@/lib/dict/segment';
import type { Entry, EntryId, HskBand, LearnerProfile } from '@/lib/types';
import { DEFAULT_MODEL } from '@/lib/ai/anthropic';
import { requireAccess } from '@/lib/server/access';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

/** §3.4 caps the retrieved set at 40 entries. */
export const RETRIEVED_CAP = 40;
/**
 * How much of the cap the dictionary search may take before the proposed
 * phrases have had their turn. A flat "search first, then proposals" order lets
 * a broad query eat all 40 rows, and then the words the answer is actually
 * built from are missing — the demo sentence retrieves 50 groups of nothing in
 * particular and none of them are the three words it wants to say.
 */
export const SEARCH_HEAD = 16;
/**
 * How long a provider may take. A cron is not waiting on this — a person is,
 * with "Thinking about …" on screen and no way out but retyping, so a hung
 * upstream has to become an answer rather than a spinner. The proposal step
 * gets the short one: it is retrieval help (§3.4), and the dictionary search
 * already stands without it.
 */
export const PROPOSE_TIMEOUT_MS = 8_000;
export const ANSWER_TIMEOUT_MS = 30_000;

/**
 * Both are overridable by env, which is what lets a test prove the deadline
 * exists without waiting 30 s for it — and what lets a deployment behind a
 * slower upstream move them without a rebuild.
 */
function timeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
const MAX_QUERY_CHARS = 400;
const MAX_SENTENCE_CHARS = 400;
const MAX_KNOWN_SAMPLE = 200;

interface AskRequestBody {
  query: string;
  context?: AskContext;
  profile: LearnerProfile;
}

export interface AskRouteInfo {
  provider: ProviderName;
  promptVersion: string;
  /** Present only for the live provider; the fake has no model. */
  model?: string;
}

export interface AskRouteResponse extends AskRouteInfo {
  query: string;
  /** The CC-CEDICT snapshot the entries came from; stamped onto any card added. */
  dictVersion: string;
  /** Validated: ids and indexes only. This is what the client caches. */
  response: GroundedAskResponse;
  /** Every entry the answer cites, so the client can render it without a round trip. */
  entries: Entry[];
  /** How many entries were retrieved for the model. Diagnostic only. */
  retrieved: number;
  /**
   * False when the answer is a stand-in the route built because the provider's
   * own answer did not survive grounding. The client must not cache it: the
   * next ask should reach the provider again rather than repeat the fallback
   * for as long as the row lives.
   */
  cacheable: boolean;
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
export function needsProposals(query: string): boolean {
  if (!hasCjk(query)) return true;
  return segment(query).tokens.filter((token) => token.kind === 'word').length >= 3;
}

/** Entries for a query, in search order, deduped by id. */
function searchEntries(query: string, limit: number): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  for (const group of search(query, { limit }).groups) {
    for (const entry of group.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/**
 * The merged dictionary search. An English question of several words matches no
 * gloss as a whole (the index is an AND over tokens), so its words are also
 * searched one at a time — otherwise the retrieval echo has nothing to echo and
 * §3.4's "no query ever renders an empty panel" fails on the first real
 * sentence somebody types.
 */
function mergedSearch(query: string): Entry[] {
  const found = searchEntries(query, 20);
  if (found.length > 0 || hasCjk(query)) return found;

  const words = query
    .toLowerCase()
    .split(/[^a-z0-9'’-]+/i)
    .filter((word) => word.length >= 3);
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  for (const word of words.slice(0, 6)) {
    for (const entry of searchEntries(word, 3)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/** Every entry behind every token of a proposed phrase, in phrase order. */
function candidateEntries(candidates: readonly string[]): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  for (const candidate of candidates.slice(0, 8)) {
    const text = candidate.trim().slice(0, 40);
    if (!text) continue;
    for (const token of segment(text).tokens) {
      if (token.kind !== 'word') continue;
      for (const id of token.entryIds) {
        if (seen.has(id)) continue;
        const entry = getEntry(id);
        if (!entry) continue;
        seen.add(id);
        out.push(entry);
      }
    }
  }
  return out;
}

/** Search head, then the proposals, then the rest of the search, up to the cap. */
export function mergeRetrieved(fromSearch: readonly Entry[], fromCandidates: readonly Entry[]): Entry[] {
  const out: Entry[] = [];
  const seen = new Set<EntryId>();
  const take = (entries: readonly Entry[], limit: number): void => {
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry);
    }
  };
  take(fromSearch, Math.min(SEARCH_HEAD, RETRIEVED_CAP));
  take(fromCandidates, RETRIEVED_CAP);
  take(fromSearch, RETRIEVED_CAP);
  return out;
}

/**
 * The access gate (lib/server/access.ts). A no-op unless
 * `TANGRAM_ACCESS_SECRET` is set in the environment; when it is, this route
 * costs money and answers nothing without the cookie. `middleware.ts` refuses
 * the same request one layer earlier — the handler checks again because a
 * matcher is easy to break and an invoice is expensive.
 */
export function GET(request: Request): Response {
  const denied = requireAccess(request);
  if (denied) return denied;

  const provider = selectProvider();
  const info: AskRouteInfo = {
    provider: provider.name,
    promptVersion: ASK_PROMPT_VERSION,
    ...(provider.name === 'anthropic'
      ? { model: process.env.TANGRAM_MODEL?.trim() || DEFAULT_MODEL }
      : {}),
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
  let index: ReturnType<typeof getDictIndex>;
  let retrieved: Entry[];
  try {
    index = getDictIndex();
    const fromSearch = mergedSearch(query);
    let candidates: string[] = [];
    if (needsProposals(query)) {
      try {
        candidates = (
          await withDeadline(
            provider.proposePhrases(query, context),
            timeoutMs('TANGRAM_ASK_PROPOSE_TIMEOUT_MS', PROPOSE_TIMEOUT_MS),
            'proposePhrases',
          )
        ).candidates;
      } catch (error) {
        // Retrieval help is optional; the dictionary search still stands.
        candidates = [];
        if (process.env.NODE_ENV !== 'production') console.warn('proposePhrases failed', error);
      }
    }
    retrieved = mergeRetrieved(fromSearch, candidateEntries(candidates));
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }

  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.answer(retrieved, profile, query, context),
      timeoutMs('TANGRAM_ASK_ANSWER_TIMEOUT_MS', ANSWER_TIMEOUT_MS),
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

  const groundContext = {
    retrieved,
    segment: (text: string) => segment(text).tokens,
    entry: (id: EntryId) => getEntry(id),
    readings: readingCount,
  };
  let grounded = ground(parsed.data, groundContext);
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
    grounded = ground(retrievalEcho(retrieved), groundContext);
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

  const body: AskRouteResponse = {
    provider: provider.name,
    promptVersion: ASK_PROMPT_VERSION,
    ...(provider.name === 'anthropic'
      ? { model: process.env.TANGRAM_MODEL?.trim() || DEFAULT_MODEL }
      : {}),
    query,
    dictVersion: index.meta.version,
    response: grounded,
    entries: [...cited].map((id) => getEntry(id)).filter((entry): entry is Entry => entry !== undefined),
    retrieved: retrieved.length,
    cacheable,
  };
  return Response.json(body);
}
