/**
 * i+1 example sentences (PLAN.md §4, Phase 6 item 1) — the filter half.
 *
 * **The prompt asks; the filter enforces.** `exampleSentences` is told which
 * words the learner knows and asked to build from those plus the target, but a
 * model is a suggestion engine, not a guarantee: the promise this feature makes
 * — *every word in this sentence is one you already know* — is only worth
 * anything if something downstream checks it. That is this module, and it runs
 * on the server, so an unfiltered sentence never reaches a browser.
 *
 * Three rules, and they are deliberately blunt:
 *
 *  1. a sentence is **shown whole or not at all**. One flagged word in it and
 *     the whole sentence goes: a sentence with a hole in it teaches nothing,
 *     and a sentence with an unknown word in it is exactly what the learner was
 *     promised they would not get;
 *  2. a cited entry that is neither the **target** nor in the **known set** is
 *     a drop. The target is the one word the sentence is allowed to teach —
 *     that is the "+1". The set is a set of entry *ids*, never of headwords:
 *     看 kàn "to see" and 看 kān "to look after" are two words that share their
 *     characters, and a learner who knows one of them has never met the other;
 *  3. an uncited `{text}` token is a drop, always. It is the model's own
 *     string: no dictionary row stands behind it, so its reading is unknowable
 *     and its characters are unverifiable.
 *
 * Rendering is **not** re-implemented here. The sentences go through
 * `lib/ai/ground.ts` exactly as `/api/ask` grounds an answer — a sentence is a
 * `sayIt` phrase without a register — so the hanzi and the pinyin on the card
 * back come from dictionary rows and nowhere else, and everything grounding
 * already knows (a citation outside the retrieved set, an unverifiable run of
 * characters, prose that needs scrubbing) applies unchanged.
 *
 * The module stays pure and browser-safe: no dictionary, no Dexie, no provider
 * *value* import. The card back imports it for the cached shape and the
 * repository reads; the route imports it for the filter.
 */

import { z } from 'zod';

import {
  ground,
  groundedAskResponseSchema,
  type GroundContext,
  type GroundedSayIt,
} from '@/lib/ai/ground';
import type { ParsedExampleSentences } from '@/lib/ai/provider';
import type { Repository } from '@/lib/db/repository';
import { isPhraseSnapshot, type CardRow, type SettingsRow } from '@/lib/db/schema';
import { KNOWN_SAMPLE_LIMIT } from '@/lib/srs/profile';
import { wordState } from '@/lib/srs/states';
import { parseEntryId, type Entry, type EntryId, type HskBand } from '@/lib/types';

/**
 * How many sentences reach the card back. The provider may return up to
 * `MAX_EXAMPLE_SENTENCES` (4) and the filter thins them; two is what fits under
 * the glosses without turning the back of a card into a reading exercise.
 */
export const EXAMPLES_SHOWN = 2;

/**
 * One validated sentence. Structurally a grounded `sayIt` phrase — same tokens,
 * same flags, same renderer (`renderPhrase`) — with an empty `register`, which
 * is the one field a sentence has no use for. Sharing the shape is what lets
 * the card back reuse the ask panel's rendering instead of growing a second
 * copy of it.
 */
export type ExampleSentence = GroundedSayIt;

/**
 * What an `ask_cache` row holds for an entry's sentences: ids and indexes only,
 * re-resolved against the dictionary at render, like every other row in that
 * table (CLAUDE.md, licence boundary).
 *
 * The array schema is `groundedAskResponseSchema`'s own, reached through
 * `.shape` rather than copied — a token union that drifted from the one
 * `renderPhrase` expects would be a parse that succeeds and a card back that
 * renders nothing.
 */
export const groundedExamplesSchema = z.object({
  sentences: groundedAskResponseSchema.shape.sayIt,
});

export type GroundedExamples = z.infer<typeof groundedExamplesSchema>;

// ---------------------------------------------------------------------------
// The known set
// ---------------------------------------------------------------------------

export interface KnownSetInput {
  settings: Pick<SettingsRow, 'knownBand'>;
  cards: readonly CardRow[];
  /** `known_words`, as `repo.knownEntryIds()` returns it. */
  known: readonly EntryId[];
}

/** What a known word sorts on: frequency first, band as the tiebreak. */
interface HeadwordRank {
  band?: HskBand;
  freqRank?: number;
}

/**
 * How many "known inside the assumed bands, but not actually known" ids may
 * travel. It is a list of exceptions to the band assumption — cards the learner
 * is still learning in a band they told us to assume — so in practice it is
 * short. The cap is the same on both sides of the wire (`/api/examples` reads
 * no more than this), so client and server judge the same set.
 */
export const MAX_BAND_EXCEPTIONS = 500;

/**
 * The learner's known vocabulary, in the three shapes this feature needs.
 *
 * Membership is `wordState` (`lib/srs/states.ts`) — the same call the reader
 * colours a token with and Lists labels a row with — so "known" means here what
 * it means everywhere else, and the three thresholds behind it are stated in
 * one place. Note the difference from `LearnerProfile.knownSample`, which is
 * deliberately looser (it counts *learning* words too, because the profile's
 * job is to describe the learner to a model, not to promise anything): a
 * sentence containing a word the learner is still learning is not a sentence
 * made of words they know, so this set is the strict one.
 *
 * `wordState` has three branches and each one needs a different shape to cross
 * the wire, which is why this is not just a list of words:
 *
 *  - **`ids`** is the exact entries the learner has met — a `known_words` row,
 *    or a card mature enough to count. Ids, not headwords: 看 is two entries
 *    (kàn "to see", kān "to look after") and a learner who knows one of them
 *    has never met the other. The filter's whitelist is built from *these*, so
 *    a sentence that cites the other reading is dropped.
 *  - **`headwords`** is the same set as characters, for the prompt only. A
 *    model reads words, not ids, and offering it a headword costs nothing —
 *    the filter is what enforces.
 *  - **`knownBand` + `excludeIds`** is the /settings "Assume known through HSK
 *    N" control, which names words the learner has no card for and no
 *    `known_words` row for. It cannot be expanded here — that needs the
 *    dictionary, which is the server's — so it travels as the band plus the
 *    exceptions to it, `wordState`'s rule that a card outranks the band.
 *
 * `headwords` and `ids` are capped at `KNOWN_SAMPLE_LIMIT` and truncated
 * **client-side**, exactly as the profile is (§3.3): the server is never sent
 * more of a learner's vocabulary than it needs to answer.
 */
export interface KnownSet {
  /** Simplified headwords, most frequent first. What the prompt is shown. */
  headwords: string[];
  /** The exact entries. What the filter's whitelist is built from. */
  ids: EntryId[];
  /** `settings.knownBand`: bands at or below it are assumed known. */
  knownBand: HskBand;
  /** Entries inside those bands the learner is *not* done with, by id. */
  excludeIds: EntryId[];
}

export function knownSet(input: KnownSetInput, limit: number = KNOWN_SAMPLE_LIMIT): KnownSet {
  const declared = new Set(input.known);
  const knownBand = input.settings.knownBand;
  const found = new Map<string, HeadwordRank>();
  const ids = new Map<EntryId, HeadwordRank>();
  const excludeIds: EntryId[] = [];

  for (const card of input.cards) {
    if (card.kind !== 'word' || isPhraseSnapshot(card.snapshot)) continue;
    const band = card.snapshot.hskBand;
    const state = wordState({
      card: card.fsrs,
      known: card.entryId ? declared.has(card.entryId) : false,
      hskBand: band,
      knownBand,
    });
    if (state !== 'known') {
      // The band assumption is a guess about words the learner has never
      // touched, and a card outranks it (`wordState`). Without this list the
      // server's band expansion would quietly promote the word the learner is
      // being taught right now back into "words you know".
      if (card.entryId && band !== undefined && band <= knownBand) excludeIds.push(card.entryId);
      continue;
    }
    const rank: HeadwordRank = { band, freqRank: card.snapshot.freqRank };
    if (card.entryId && !ids.has(card.entryId)) ids.set(card.entryId, rank);
    if (!found.has(card.snapshot.simp)) found.set(card.snapshot.simp, rank);
  }

  // A word declared known that never got a card: the headword is recoverable
  // from the entry id, so it counts without a dictionary round-trip.
  for (const entryId of declared) {
    if (!ids.has(entryId)) ids.set(entryId, {});
    const parsed = parseEntryId(entryId);
    if (parsed && !found.has(parsed.simp)) found.set(parsed.simp, {});
  }

  const byRank = (left: HeadwordRank, right: HeadwordRank): number =>
    (left.freqRank ?? Number.MAX_SAFE_INTEGER) - (right.freqRank ?? Number.MAX_SAFE_INTEGER) ||
    (left.band ?? 99) - (right.band ?? 99);

  return {
    headwords: [...found.entries()]
      .sort(
        ([leftWord, left], [rightWord, right]) =>
          byRank(left, right) ||
          // The headword itself is the last tiebreak: most of a demo learner's
          // known words come from `known_words` rows that carry neither rank,
          // and "whatever order the database handed them back" is not a cache
          // key's idea of stable.
          (leftWord < rightWord ? -1 : 1),
      )
      .slice(0, limit)
      .map(([simp]) => simp),
    ids: [...ids.entries()]
      .sort(([leftId, left], [rightId, right]) => byRank(left, right) || (leftId < rightId ? -1 : 1))
      .slice(0, limit)
      .map(([id]) => id),
    knownBand,
    excludeIds: excludeIds.slice(0, MAX_BAND_EXCEPTIONS),
  };
}

/** Just the headwords, for callers that only need the prompt's half. */
export function knownHeadwords(
  input: KnownSetInput,
  limit: number = KNOWN_SAMPLE_LIMIT,
): string[] {
  return knownSet(input, limit).headwords;
}

/** `knownSet` over the repository. The card back's one database read. */
export async function getKnownSet(
  repo: Pick<Repository, 'getSettings' | 'allCards' | 'knownEntryIds'>,
  limit?: number,
): Promise<KnownSet> {
  const [settings, cards, known] = await Promise.all([
    repo.getSettings(),
    repo.allCards(),
    repo.knownEntryIds(),
  ]);
  return knownSet({ settings, cards, known }, limit);
}

/**
 * Does the learner know this **entry**? The client's half of the same question
 * `/api/examples` answers with the dictionary in hand.
 *
 * The band branch is why this takes an `Entry` rather than an id: a band is a
 * property of the dictionary row, and the row only reaches the browser once
 * `/api/dict/entries` has resolved it. It reads `wordState` in the one order
 * that matters — a declared id, then the band, minus the cards that outrank it.
 */
export function knownEntryFilter(
  set: KnownSet,
): (entry: Pick<Entry, 'id' | 'hskBand'>) => boolean {
  const ids = new Set(set.ids);
  const excluded = new Set(set.excludeIds);
  return (entry) =>
    ids.has(entry.id) ||
    (!excluded.has(entry.id) && entry.hskBand !== undefined && entry.hskBand <= set.knownBand);
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

export interface ExampleFilter {
  /** The entry the card is about. Always allowed: it is the one new word. */
  targetId: EntryId;
  /** Every entry id the learner knows. Anything else drops its sentence. */
  allowed: ReadonlySet<EntryId>;
}

/**
 * Is this sentence one the learner was promised?
 *
 * Every clause is a reason to drop the whole sentence, never to trim it:
 *
 *  - `unverified` is grounding's own verdict — an uncited token, a character
 *    the dictionary does not have, a run that does not read as words;
 *  - a token with no `entryId` is a `{text}` token, the model's own string;
 *  - a citation outside the known set is the failure this feature exists to
 *    prevent, and the target is the single exception to it;
 *  - a sentence that never mentions the target is a fine sentence about
 *    something else, and this is the back of a card about one word.
 */
export function keepSentence(sentence: ExampleSentence, filter: ExampleFilter): boolean {
  if (sentence.unverified) return false;
  let mentionsTarget = false;
  for (const token of sentence.tokens) {
    if (token.entryId === undefined) return false;
    if (token.unverified) return false;
    if (token.entryId === filter.targetId) {
      mentionsTarget = true;
      continue;
    }
    if (!filter.allowed.has(token.entryId)) return false;
  }
  return mentionsTarget;
}

export interface ExamplesGroundOptions extends ExampleFilter {
  /** How many survivors reach the card. Defaults to `EXAMPLES_SHOWN`. */
  limit?: number;
}

/**
 * Ground the provider's sentences, then filter them.
 *
 * Grounding is `lib/ai/ground.ts` unchanged — a sentence is a `sayIt` phrase
 * with no register — so citations outside `context.retrieved` are already gone
 * and what is left is rendered from dictionary rows. The filter above is the
 * second, independent gate: it is the one that knows the difference between an
 * entry the route *retrieved* and an entry the learner *knows*, which is the
 * whole of i+1.
 */
export function groundExamples(
  raw: ParsedExampleSentences,
  context: GroundContext,
  options: ExamplesGroundOptions,
): ExampleSentence[] {
  const grounded = ground(
    {
      interpretation: '',
      matches: [],
      sayIt: raw.sentences.map((sentence) => ({
        tokens: sentence.tokens,
        en: sentence.en,
        register: '',
      })),
      notes: [],
    },
    context,
  );

  return grounded.sayIt
    .filter((sentence) => keepSentence(sentence, options))
    .slice(0, options.limit ?? EXAMPLES_SHOWN);
}

/** Every entry a set of sentences cites, deduped, in the order they appear. */
export function citedEntryIds(sentences: readonly ExampleSentence[]): EntryId[] {
  const ids = new Set<EntryId>();
  for (const sentence of sentences) {
    for (const token of sentence.tokens) if (token.entryId) ids.add(token.entryId);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// The cache's re-check
// ---------------------------------------------------------------------------

/** Which of these resolved entries the learner knows, as `keepSentence` wants them. */
export function allowedEntryIds(entries: readonly Entry[], set: KnownSet): Set<EntryId> {
  const known = knownEntryFilter(set);
  return new Set(entries.filter(known).map((entry) => entry.id));
}

/**
 * The filter, run again on a **cached** row before it is drawn.
 *
 * A cached sentence is a statement about a known set, and the cache key does
 * not hold one (`examplesCachePayload`). Two ordinary things then make a warm
 * row a lie:
 *
 *  - **The known set shrinks.** Every explicit Add un-marks the word it was
 *    built from (`repo.unmarkKnown`, `lib/lists/looked-up.ts`) and the new card
 *    outranks the band assumption, so the most common action in the app can
 *    turn a word in yesterday's sentence into a word the learner is currently
 *    being taught.
 *  - **The dictionary is rebuilt.** An entry id is content-derived, so a
 *    CC-CEDICT snapshot that respells a reading retires the id — and the token
 *    that cited it resolves to nothing. `renderPhrase` reports that as
 *    `missing`, and a sentence with a hole in it is the one thing the module
 *    header says must never be shown.
 *
 * So: every token must still resolve, and every cited entry must still be the
 * target or known. What does not survive is dropped, and the caller asks again
 * rather than drawing a sentence it can no longer stand behind.
 */
export function filterCachedSentences(
  sentences: readonly ExampleSentence[],
  options: { targetId: EntryId; entries: readonly Entry[]; set: KnownSet },
): ExampleSentence[] {
  const resolved = new Set(options.entries.map((entry) => entry.id));
  const allowed = allowedEntryIds(options.entries, options.set);
  return sentences.filter(
    (sentence) =>
      sentence.tokens.every(
        (token) => token.entryId !== undefined && resolved.has(token.entryId),
      ) && keepSentence(sentence, { targetId: options.targetId, allowed }),
  );
}
