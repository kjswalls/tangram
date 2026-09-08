/**
 * `POST /api/examples` (PLAN.md §4, Phase 6 item 1) — i+1 example sentences for
 * one card.
 *
 *   1. resolve the target entry, and the learner's known headwords into the
 *      dictionary rows behind them (the **support** pool);
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

import { DEFAULT_MODEL } from '@/lib/ai/anthropic';
import { EXAMPLES_PROMPT_VERSION } from '@/lib/ai/cache-key';
import { withDeadline } from '@/lib/ai/deadline';
import { citedEntryIds, groundExamples, type ExampleSentence } from '@/lib/ai/examples';
import {
  exampleSentencesSchema,
  ProviderError,
  selectProvider,
  type LLMProvider,
  type ProviderName,
} from '@/lib/ai/provider';
import { getDictIndex, getEntry, readingCount } from '@/lib/dict/index';
import { dictErrorResponse } from '@/lib/dict/load';
import { segment } from '@/lib/dict/segment';
import type { Entry, EntryId, HskBand, LearnerProfile } from '@/lib/types';

// The dictionary is read from disk per process; never prerender this at build time.
export const dynamic = 'force-dynamic';

/**
 * How many dictionary rows the prompt may be built from. The learner may know
 * thousands of words; a prompt that listed them all would cost more than the
 * sentence is worth and would bury the frequent words the sentence should
 * actually use. The pool is frequency-ordered before it is cut, so what
 * survives is the vocabulary a natural sentence reaches for first.
 */
export const SUPPORT_CAP = 40;

/** How many headwords a request may carry. `KNOWN_SAMPLE_LIMIT` client-side. */
const MAX_KNOWN_WORDS = 200;
const MAX_HEADWORD_CHARS = 24;

/**
 * The learner is mid-review with a grade to press, so the card back gives up
 * sooner than the lookup panel does. Overridable by env for the same two
 * reasons `/api/ask`'s deadlines are: a test can prove the deadline exists
 * without waiting for it, and a slower upstream can be accommodated without a
 * rebuild.
 */
export const EXAMPLES_TIMEOUT_MS = 20_000;

function timeoutMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export interface ExamplesRouteInfo {
  provider: ProviderName;
  promptVersion: string;
  /** Present only for the live provider; the fake has no model. */
  model?: string;
}

export interface ExamplesRouteResponse extends ExamplesRouteInfo {
  entryId: EntryId;
  senseIndex?: number;
  /** The CC-CEDICT snapshot the entries came from. */
  dictVersion: string;
  /** Validated and filtered: ids and indexes only. This is what the client caches. */
  sentences: ExampleSentence[];
  /** Every entry the sentences cite, so the client can render without a round trip. */
  entries: Entry[];
  /** How many entries the prompt was allowed to build from. Diagnostic only. */
  support: number;
  /**
   * False when nothing survived the filter. An empty answer must not be cached:
   * it is a statement about how many words the learner knew today, and tomorrow
   * it would be wrong in the one direction the learner cannot fix.
   */
  cacheable: boolean;
}

interface ExamplesRequestBody {
  entryId: EntryId;
  senseIndex?: number;
  profile: LearnerProfile;
  /**
   * The learner's known headwords (`knownHeadwords`, `lib/ai/examples.ts`).
   * Optional: a bare `{entryId, profile}` request is legal and falls back to
   * `profile.knownSample`, which is the looser set — it counts words the
   * learner is still *learning* as well. The client sends the strict set.
   */
  known?: string[];
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

  return {
    entryId,
    ...(senseIndex === undefined ? {} : { senseIndex }),
    profile: { estimatedBand, knownSample },
    ...(known === undefined ? {} : { known }),
  };
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
 * The dictionary rows behind a list of simplified headwords, most frequent
 * first. Every reading of a headword is included: the learner knows the word
 * they see, and which of its readings a sentence wants is the model's problem —
 * both are equally known.
 */
export function supportEntries(headwords: readonly string[], exclude: EntryId): Entry[] {
  const index = getDictIndex();
  const seen = new Set<EntryId>();
  const out: Entry[] = [];
  for (const word of headwords) {
    for (const id of index.bySimp.get(word) ?? []) {
      if (id === exclude || seen.has(id)) continue;
      const entry = getEntry(id);
      if (!entry) continue;
      seen.add(id);
      out.push(entry);
    }
  }
  return out.sort(
    (a, b) =>
      (a.freqRank ?? Number.MAX_SAFE_INTEGER) - (b.freqRank ?? Number.MAX_SAFE_INTEGER) ||
      (a.id < b.id ? -1 : 1),
  );
}

export interface ExamplesInput {
  entry: Entry;
  senseIndex?: number;
  profile: LearnerProfile;
  /** The known headwords the sentences may be built from. */
  known: readonly string[];
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
): Promise<ExamplesOutcome> {
  const support = supportEntries(input.known, input.entry.id);
  const offered = support.slice(0, SUPPORT_CAP);

  let raw: unknown;
  try {
    raw = await withDeadline(
      provider.exampleSentences(input.entry, input.profile, input.senseIndex, offered),
      timeoutMs('TANGRAM_EXAMPLES_TIMEOUT_MS', EXAMPLES_TIMEOUT_MS),
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
  // *and shown*. They are the same set by construction here — the model is only
  // ever offered words the learner knows — and they are still enforced
  // separately, because the day the route offers a wider pool (a live provider
  // that needs a particle the learner has not formally met) the promise on the
  // card back must not quietly widen with it.
  const sentences = groundExamples(
    parsed.data,
    {
      retrieved: [input.entry, ...offered],
      segment: (text: string) => segment(text).tokens,
      entry: (id: EntryId) => getEntry(id),
      readings: readingCount,
    },
    {
      targetId: input.entry.id,
      allowed: new Set(offered.map((entry) => entry.id)),
    },
  );

  const entries = citedEntryIds(sentences)
    .map((id) => getEntry(id))
    .filter((entry): entry is Entry => entry !== undefined);

  return { ok: true, sentences, entries, support: offered.length };
}

function info(provider: ProviderName): ExamplesRouteInfo {
  return {
    provider,
    promptVersion: EXAMPLES_PROMPT_VERSION,
    ...(provider === 'anthropic'
      ? { model: process.env.TANGRAM_MODEL?.trim() || DEFAULT_MODEL }
      : {}),
  };
}

export function GET(): Response {
  return Response.json(info(selectProvider().name));
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest('send JSON { entryId, senseIndex?, profile, known? }');
  }

  const parsedBody = parseBody(payload);
  if (typeof parsedBody === 'string') return badRequest(parsedBody);
  const { entryId, senseIndex, profile, known } = parsedBody;

  const provider = selectProvider();

  // Everything that touches the dictionary sits inside this try: a missing
  // data/ build is a 503 with the same body the other routes answer with.
  let entry: Entry | undefined;
  let dictVersion: string;
  try {
    dictVersion = getDictIndex().meta.version;
    entry = getEntry(entryId);
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
      known: known ?? profile.knownSample,
    },
    provider,
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
