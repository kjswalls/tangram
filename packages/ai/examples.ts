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
 * *value* import. The card back imports it for the cached shape; the route
 * imports it for the filter.
 *
 * **What is NOT here, and where it went.** `backend.md` B1 moved the learner's
 * known set — `knownSet`, `knownHeadwords`, `getKnownSet`, `knownEntryFilter`,
 * `allowedEntryIds` and `filterCachedSentences` — to
 * `apps/app/lib/srs/known-set.ts`. Those six
 * were the only thing in `packages/ai` that read `lib/db`, and from B1 the
 * server imports this package, so `lib/db/schema.ts` (the file B4 rewrites)
 * would otherwise have been a dependency of the server's bundle. They are
 * browser-side by `wave-zero.md` §5's own rule: this package holds what the app
 * and the server BOTH need, and the server resolves nothing out of Dexie. What
 * is left here is exactly the half both sides run.
 */

import { z } from 'zod';

import {
  ground,
  groundedAskResponseSchema,
  type GroundContext,
  type GroundedSayIt,
} from './ground.js';
import type { ParsedExampleSentences } from './provider.js';
import type { EntryId } from '@/lib/types';

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

/**
 * How many "known inside the assumed bands, but not actually known" ids may
 * travel. It is a list of exceptions to the band assumption — cards the learner
 * is still learning in a band they told us to assume — so in practice it is
 * short. The cap is the same on both sides of the wire (`/api/examples` reads
 * no more than this), so client and server judge the same set.
 */
export const MAX_BAND_EXCEPTIONS = 500;

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
