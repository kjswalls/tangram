/**
 * `POST /api/examples` (PLAN.md §4, Phase 6 item 1) — i+1 example sentences for
 * one card.
 *
 *   1. resolve the target entry, and what the learner declared knowing — exact
 *      entry ids, plus the /settings "assume known through HSK N" band, minus
 *      the cards that outrank it — into dictionary rows (the **support** pool);
 *   2. `exampleSentences(entry, profile, senseIndex, support)` — the prompt
 *      asks for sentences built from those words and the target;
 *   3. `groundExamples()` — ground exactly as `/api/ask` grounds an answer, and
 *      then **drop** every sentence that cites anything but the target and the
 *      known set, or that carries a token the model wrote itself;
 *   4. return the survivors plus the entries needed to draw them.
 *
 * Step 3 is why this is a route at all rather than a client-side fetch: the
 * filter is the feature, and a filter that ran in the browser would be a
 * promise the server had already broken. Nothing unfiltered is ever serialised.
 *
 * `GET /api/examples` is the same handshake `/api/ask` offers — which provider
 * is active and under which prompt version — because the card back has to
 * derive its cache key before it can look in the cache.
 *
 * Failure modes match `/api/ask`: a missing `data/` build is
 * `503 {error:'dict-data-missing'}`, a malformed body is a 400, an entry id
 * that is not in this dictionary is a 404, and a provider that throws, times
 * out or answers off-schema is a 502.
 */

import { DEFAULT_MODEL } from '@tangram/ai/anthropic';
import { EXAMPLES_PROMPT_VERSION } from '@tangram/ai/cache-key';
import { withDeadline } from '@tangram/ai/deadline';
import {
  citedEntryIds,
  groundExamples,
  MAX_BAND_EXCEPTIONS,
  type ExampleSentence,
} from '@tangram/ai/examples';
import {
  exampleSentencesSchema,
  ProviderError,
  selectProvider,
  type LLMProvider,
  type ProviderName,
} from '@tangram/ai/provider';
import { withStoreContext } from '@tangram/ai/retrieve';
import { dictErrorResponse, serverDictStore } from '@/lib/server/dict';
import type { DictStore } from '@/lib/dict/store';
import type { ExamplesRouteInfo, ExamplesRouteResponse } from '@/lib/api/contract';
import { HSK_BANDS, type Entry, type EntryId, type HskBand, type LearnerProfile } from '@/lib/types';
import { requireAccess } from '@tangram/access';
import { deadlineMs, modelName } from '../config.ts';

/**
 * How many dictionary rows the prompt may be built from. The learner may know
 * thousands of words; a prompt that listed them all would cost more than the
 * sentence is worth and would bury the frequent words the sentence should
 * actually use. The pool is frequency-ordered before it is cut, so what
 * survives is the vocabulary a natural sentence reaches for first.
 */
export const SUPPORT_CAP = 40;

/** How many headwords or ids a request may carry. `KNOWN_SAMPLE_LIMIT` client-side. */
const MAX_KNOWN_WORDS = 200;
const MAX_HEADWORD_CHARS = 24;
/** `trad|simp[pinyin]` for a long phrase, with room to spare. */
const MAX_ENTRY_ID_CHARS = 160;

/**
 * The learner is mid-review with a grade to press, so the card back gives up
 * sooner than the lookup panel does — 20 s, in `DEADLINE_DEFAULTS`
 * (`src/config.ts`) with the other three. Overridable by env for the same two
 * reasons `/api/ask`'s deadlines are: a test can prove the deadline exists
 * without waiting for it, and a slower upstream can be accommodated without a
 * rebuild.
 */

interface ExamplesRequestBody {
  entryId: EntryId;
  senseIndex?: number;
  profile: LearnerProfile;
  /**
   * What the learner knows (`knownSet`, `lib/ai/examples.ts`), in the three
   * shapes `wordState` needs: `known` is the headwords, `knownIds` the exact
   * entries, and `knownBand` + `excludeIds` the /settings band assumption with
   * its exceptions.
   *
   * All four are optional and a bare `{entryId, profile}` request is still
   * legal — it simply declares nothing, so nothing but the target may be cited
   * and the answer is the word by itself. `profile.knownSample` is **not** used
   * as a stand-in: it counts words the learner is still *learning*, and the one
   * promise this route makes is that it does not.
   */
  known?: string[];
  knownIds?: string[];
  knownBand?: HskBand;
  excludeIds?: string[];
}

function badRequest(hint: string): Response {
  return Response.json({ error: 'bad-request', hint }, { status: 400 });
}

function parseBody(payload: unknown): ExamplesRequestBody | string {
  if (typeof payload !== 'object' || payload === null) return 'send JSON { entryId, profile }';
  const body = payload as Record<string, unknown>;

  const entryId = typeof body.entryId === 'string' ? body.entryId.trim() : '';
  if (!entryId) return 'pass a non-empty { entryId }';

  let senseIndex: number | undefined;
  if (body.senseIndex !== undefined && body.senseIndex !== null) {
    const value = Number(body.senseIndex);
    if (!Number.isInteger(value) || value < 0) return 'senseIndex must be a non-negative integer';
    senseIndex = value;
  }

  const rawProfile = (body.profile ?? {}) as Record<string, unknown>;
  const band = Number(rawProfile.estimatedBand);
  const estimatedBand: HskBand =
    Number.isInteger(band) && band >= 1 && band <= 7 ? (band as HskBand) : 1;
  const knownSample = words(rawProfile.knownSample);

  const known = body.known === undefined ? undefined : words(body.known);
  const knownIds = body.knownIds === undefined ? undefined : ids(body.knownIds, MAX_KNOWN_WORDS);
  const excludeIds =
    body.excludeIds === undefined ? undefined : ids(body.excludeIds, MAX_BAND_EXCEPTIONS);

  const rawBand = Number(body.knownBand);
  const knownBand: HskBand | undefined =
    Number.isInteger(rawBand) && rawBand >= 1 && rawBand <= 7 ? (rawBand as HskBand) : undefined;

  return {
    entryId,
    ...(senseIndex === undefined ? {} : { senseIndex }),
    profile: { estimatedBand, knownSample },
    ...(known === undefined ? {} : { known }),
    ...(knownIds === undefined ? {} : { knownIds }),
    ...(knownBand === undefined ? {} : { knownBand }),
    ...(excludeIds === undefined ? {} : { excludeIds }),
  };
}

/**
 * A list of entry ids, bounded. Unlike a headword an id is never trimmed to
 * length — half an id is a different id, and the honest move is to ignore it.
 */
function ids(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > MAX_ENTRY_ID_CHARS) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** A list of headwords, cleaned and bounded. Anything else in it is ignored. */
function words(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const word = item.trim().slice(0, MAX_HEADWORD_CHARS);
    if (word) out.push(word);
    if (out.length >= MAX_KNOWN_WORDS) break;
  }
  return out;
}

/**
 * What the client declared about the learner's vocabulary. `KnownSet` on the
 * other side of the wire (`lib/ai/examples.ts`) — the same three shapes, minus
 * the dictionary the browser does not have.
 */
export interface KnownPool {
  /** Exact entry ids: a `known_words` row, or a card mature enough to count. */
  ids?: readonly string[];
  /** `settings.knownBand` — every entry at or below it is assumed known. */
  knownBand?: HskBand;
  /** Entries inside those bands the learner is still learning: a card outranks the band. */
  excludeIds?: readonly string[];
  /** Simplified headwords, for a caller that has no ids. See below. */
  headwords?: readonly string[];
}

/**
 * The dictionary rows the learner knows, most frequent first — the **support**
 * pool, which is both what the prompt may build from and (after the cap) what a
 * sentence may cite.
 *
 * It is assembled from ids and bands, never from characters, and that is the
 * whole point. A headword is not a word: 看 is `看|看[kan4]` "to see" (HSK 1)
 * *and* `看|看[kan1]` "to look after" (HSK 6); 会 is huì and kuài; 还 is hái,
 * huán and the surname Huán. Expanding a known headword into every entry that
 * shares its characters — which is what this function used to do — put readings
 * the learner has never met into the whitelist, and the card back then showed
 * them under the heading "Sentences from words you know". The tone is the whole
 * difference in meaning (`lib/ai/fake.ts`), and a learner cannot check it —
 * that is why they are here.
 *
 * The three sources:
 *
 *  1. **`ids`** — exact, and the only one that needs no judgement.
 *  2. **`knownBand`** — the /settings "Assume known through HSK N" control.
 *     `hskBand` is a property of an *entry*, so the expansion is per reading and
 *     stays exact: 看[kan4] is band 1, 看[kan1] is band 6. `excludeIds` carries
 *     `wordState`'s rule that a card outranks the band, so a word in band 1 the
 *     learner is being taught today does not come back as known.
 *  3. **`headwords`** — the fallback for a caller with no ids, and deliberately
 *     lossy: a headword with more than one entry is **skipped**, because
 *     "the learner knows 看" does not say which 看. Variants, proper nouns and
 *     surnames are dropped too; none of them is a word somebody learned.
 */
export async function supportEntries(
  store: DictStore,
  pool: KnownPool,
  exclude: EntryId,
): Promise<Entry[]> {
  const excluded = new Set<string>(pool.excludeIds ?? []);
  const seen = new Set<EntryId>([exclude]);
  const out: Entry[] = [];

  const add = (entry: Entry | undefined): void => {
    if (!entry || seen.has(entry.id) || excluded.has(entry.id)) return;
    seen.add(entry.id);
    out.push(entry);
  };

  for (const entry of await store.entries(pool.ids ?? [])) add(entry);

  if (pool.knownBand !== undefined) {
    for (const band of HSK_BANDS) {
      if (band > pool.knownBand) continue;
      for (const entry of await store.hskBand(band)) add(entry);
    }
  }

  for (const word of pool.headwords ?? []) {
    const bucket = await readingsOf(store, word);
    if (bucket.length !== 1) continue;
    const [entry] = bucket;
    if (entry.properNoun || entry.isVariant || entry.surname) continue;
    add(entry);
  }

  return out.sort(
    (a, b) =>
      (a.freqRank ?? Number.MAX_SAFE_INTEGER) - (b.freqRank ?? Number.MAX_SAFE_INTEGER) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * Every entry whose **simplified** headword is exactly `word` — what
 * `lib/dict/index.ts`'s `bySimp.get(word)` answered before `data.md` D6 deleted
 * it (docs/plans/data.md D6).
 *
 * A `DictStore` has no `bySimp`, deliberately: the frozen interface asks
 * questions a learner asks, and "every row under this simplified form" is an
 * index, not a question. The exact-match section of a hanzi search is the same
 * set — `search('看')`'s exact groups are the headwords equal to 看 in either
 * script — so the rows are taken from there and filtered to the simplified side.
 *
 * It spans **groups**, not one group, and that is the whole reason it is a
 * function rather than an inline `groups[0]`: a group is one `trad|simp` pair,
 * while CC-CEDICT keeps a row per traditional variant, so 后 is 后|后 *and*
 * 後|后 and the caller's rule ("skip a headword with more than one entry,
 * because 'the learner knows 看' does not say which 看") reads the count across
 * both. The limit is 200 because the exact matches lead the page and no
 * headword has anything near that many readings; prefix matches are dropped by
 * the `simp === word` filter.
 *
 * **One thing `bySimp` answered that this cannot**, measured rather than
 * assumed: `DictStore.search` routes on whether the query contains CJK, so the
 * 274 CC-CEDICT headwords that contain **none** — `OK`, `3Q`, `ACG`, `110`, `%`
 * — go down the English/pinyin path and never match themselves exactly. A
 * mixed headword (`X光`, `卡拉OK`) is fine; a wholly Latin one resolves to
 * nothing and is skipped. Reaching them would need a `bySimp`-shaped question
 * on the frozen `DictStore` interface, which CLAUDE.md says a builder does not
 * add mid-phase, so the need is recorded in HANDOFF.md under D6 and the gap is
 * taken: it costs one Latin abbreviation out of a support pool that is already
 * lossy by design, and none of the 274 is a word an example sentence leans on.
 */
async function readingsOf(store: DictStore, word: string): Promise<Entry[]> {
  const result = await store.search(word, { limit: 200 });
  return result.groups
    .filter((group) => group.simp === word)
    .flatMap((group) => group.entries);
}

export interface ExamplesInput {
  entry: Entry;
  senseIndex?: number;
  profile: LearnerProfile;
  /** What the learner knows: the pool the sentences may be built from. */
  known: KnownPool;
}

export type ExamplesOutcome =
  | { ok: true; sentences: ExampleSentence[]; entries: Entry[]; support: number }
  | { ok: false; hint: string; invalid?: boolean };

/**
 * The pipeline, with the provider injected.
 *
 * Exported so the tests can hand it a provider that misbehaves — cites a word
 * the learner does not know, writes its own characters, times out. The fake
 * cannot do any of those, and "the filter enforces" is not a claim that can be
 * tested against a provider that never breaks the rules.
 */
export async function examplesFor(
  input: ExamplesInput,
  provider: LLMProvider,
  store: DictStore,
): Promise<ExamplesOutcome> {
  const support = await supportEntries(store, input.known, input.entry.id);
  const offered = support.slice(0, SUPPORT_CAP);

  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.exampleSentences(input.entry, input.profile, input.senseIndex, offered),
      deadlineMs('examples'),
      'the sentences',
    );
  } catch (error) {
    const hint =
      error instanceof ProviderError || error instanceof Error
        ? error.message
        : 'the provider failed';
    return { ok: false, hint };
  }

  const parsed = exampleSentencesSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      invalid: true,
      hint: `the sentences did not match the schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }

  // `retrieved` is what may be cited at all; `allowed` is what may be cited
  // *and shown*. They are the same set by construction here — `supportEntries`
  // resolves ids and bands, so every entry in it is one `wordState` calls known
  // — and they are still enforced separately, because the day the route offers
  // a wider pool (a live provider that needs a particle the learner has not
  // formally met) the promise on the card back must not quietly widen with it.
  //
  // `withStoreContext` is `lib/ai/retrieve.ts`'s synchronous/asynchronous seam
  // (docs/plans/data.md D3): `groundExamples` is pure and still takes a
  // synchronous `GroundContext`, and the store answers what each round asked
  // for and could not be told.
  const sentences = await withStoreContext(store, [input.entry, ...offered], (context) =>
    groundExamples(parsed.data, context, {
      targetId: input.entry.id,
      allowed: new Set(offered.map((entry) => entry.id)),
    }),
  );

  const entries = await store.entries(citedEntryIds(sentences));

  return { ok: true, sentences, entries, support: offered.length };
}

function info(provider: ProviderName): ExamplesRouteInfo {
  return {
    provider,
    promptVersion: EXAMPLES_PROMPT_VERSION,
    ...(provider === 'anthropic' ? { model: modelName(DEFAULT_MODEL) } : {}),
  };
}

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

  return Response.json(info(selectProvider().name));
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAccess(request);
  if (denied) return denied;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('send JSON { entryId, senseIndex?, profile, known? }');
  }

  const parsedBody = parseBody(payload);
  if (typeof parsedBody === 'string') return badRequest(parsedBody);
  const { entryId, senseIndex, profile, known, knownIds, knownBand, excludeIds } = parsedBody;

  const provider = selectProvider();

  // Everything that touches the dictionary sits inside this try: a missing
  // data/ build is a 503 with the same body the other routes answer with.
  let entry: Entry | undefined;
  let dictVersion: string;
  let store: DictStore;
  try {
    store = await serverDictStore();
    dictVersion = store.status.state === 'ready' ? store.status.version : '';
    [entry] = await store.entries([entryId]);
  } catch (error) {
    const missing = dictErrorResponse(error);
    if (missing) return missing;
    throw error;
  }

  if (!entry) {
    return Response.json(
      { error: 'entry-not-found', hint: `no dictionary entry with id ${entryId}` },
      { status: 404 },
    );
  }

  const outcome = await examplesFor(
    {
      entry,
      ...(senseIndex === undefined ? {} : { senseIndex }),
      profile,
      known: {
        ...(known === undefined ? {} : { headwords: known }),
        ...(knownIds === undefined ? {} : { ids: knownIds }),
        ...(knownBand === undefined ? {} : { knownBand }),
        ...(excludeIds === undefined ? {} : { excludeIds }),
      },
    },
    provider,
    store,
  );

  if (!outcome.ok) {
    return Response.json(
      {
        error: outcome.invalid ? 'provider-invalid' : 'provider-failed',
        provider: provider.name,
        hint: outcome.hint,
      },
      { status: 502 },
    );
  }

  const body: ExamplesRouteResponse = {
    ...info(provider.name),
    entryId: entry.id,
    ...(senseIndex === undefined ? {} : { senseIndex }),
    dictVersion,
    sentences: outcome.sentences,
    entries: outcome.entries,
    support: outcome.support,
    cacheable: outcome.sentences.length > 0,
  };
  return Response.json(body);
}
