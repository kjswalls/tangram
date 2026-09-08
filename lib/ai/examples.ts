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
 *     that is the "+1";
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
import { parseEntryId, type EntryId, type HskBand } from '@/lib/types';

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

/** What a sampled headword sorts on: frequency first, band as the tiebreak. */
interface HeadwordRank {
  band?: HskBand;
  freqRank?: number;
}

/**
 * The simplified headwords the learner **knows**, which is the pool a sentence
 * may be built from.
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
 * Capped at `KNOWN_SAMPLE_LIMIT` and truncated **client-side**, exactly as the
 * profile is (§3.3): the server is never sent more of a learner's vocabulary
 * than it needs to answer.
 */
export function knownHeadwords(
  input: KnownSetInput,
  limit: number = KNOWN_SAMPLE_LIMIT,
): string[] {
  const knownIds = new Set(input.known);
  const found = new Map<string, HeadwordRank>();

  for (const card of input.cards) {
    if (card.kind !== 'word' || isPhraseSnapshot(card.snapshot)) continue;
    const band = card.snapshot.hskBand;
    const state = wordState({
      card: card.fsrs,
      known: card.entryId ? knownIds.has(card.entryId) : false,
      hskBand: band,
      knownBand: input.settings.knownBand,
    });
    if (state !== 'known') continue;
    if (!found.has(card.snapshot.simp)) {
      found.set(card.snapshot.simp, { band, freqRank: card.snapshot.freqRank });
    }
  }

  // A word declared known that never got a card: the headword is recoverable
  // from the entry id, so it counts without a dictionary round-trip.
  for (const entryId of knownIds) {
    const parsed = parseEntryId(entryId);
    if (parsed && !found.has(parsed.simp)) found.set(parsed.simp, {});
  }

  return [...found.entries()]
    .sort(
      ([leftWord, left], [rightWord, right]) =>
        (left.freqRank ?? Number.MAX_SAFE_INTEGER) - (right.freqRank ?? Number.MAX_SAFE_INTEGER) ||
        (left.band ?? 99) - (right.band ?? 99) ||
        // The headword itself is the last tiebreak: most of a demo learner's
        // known words come from `known_words` rows that carry neither rank, and
        // "whatever order the database handed them back" is not a cache key's
        // idea of stable.
        (leftWord < rightWord ? -1 : 1),
    )
    .slice(0, limit)
    .map(([simp]) => simp);
}

/** `knownHeadwords` over the repository. The card back's one database read. */
export async function getKnownHeadwords(
  repo: Pick<Repository, 'getSettings' | 'allCards' | 'knownEntryIds'>,
  limit?: number,
): Promise<string[]> {
  const [settings, cards, known] = await Promise.all([
    repo.getSettings(),
    repo.allCards(),
    repo.knownEntryIds(),
  ]);
  return knownHeadwords({ settings, cards, known }, limit);
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
