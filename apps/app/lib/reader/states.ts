/**
 * Colouring the reader (PLAN.md §3.5, §3.3).
 *
 * The thresholds are **not** here: `wordState` in `lib/srs/states.ts` owns them,
 * and this module is the reader's way of asking it about a whole text at once.
 * Duplicating the "Review with stability ≥ 21 is known" rule would mean a token
 * could disagree with the list badge for the same word, which is the one thing
 * §3.3 makes a single function to prevent.
 *
 * What is here is the *shape* of the question. A reader tap is per token, but a
 * repository read per token is 1,300 reads on a 2,000-character text, so every
 * input is read once into a `ReaderIndex` and every token is answered from it.
 *
 * A token carries every reading of its headword (§3.2, `entryIds` is never
 * truncated), so a token's state is the strongest state of any of its readings:
 * a learner with a card for 了 `le` has met the word, whatever 了 `liǎo` is
 * doing.
 */

import type { Repository } from '@/lib/db/repository';
import type { FsrsCardState } from '@/lib/db/schema';
import type { EntrySource } from '@/lib/lists/entry-source';
import { wordState, type WordState } from '@/lib/srs/states';
import { HSK_BANDS, type EntryId, type HskBand, type Token } from '@/lib/types';

/** Just enough of a card for `wordState`. */
export type CardState = Pick<FsrsCardState, 'state' | 'stability'>;

export interface ReaderIndex {
  /** entryId → its card's FSRS state, for every card that has an entry. */
  cards: Map<EntryId, CardState>;
  /** Everything in `known_words`. */
  known: Set<EntryId>;
  /**
   * entryId → HSK band, for the bands at or below `knownBand` only. That is
   * every band `wordState` can act on — a band above it never changes the
   * answer — so the reader pulls two lists, not seven.
   */
  bands: Map<EntryId, HskBand>;
  knownBand: HskBand;
}

const RANK: Record<WordState, number> = { new: 0, learning: 1, known: 2 };

export function emptyReaderIndex(knownBand: HskBand = 1): ReaderIndex {
  return { cards: new Map(), known: new Set(), bands: new Map(), knownBand };
}

/** One entry's state, per §3.3's order: declared known, then the card, then the band. */
export function entryState(id: EntryId, index: ReaderIndex): WordState {
  const band = index.bands.get(id);
  return wordState({
    card: index.cards.get(id) ?? null,
    known: index.known.has(id),
    ...(band === undefined ? {} : { hskBand: band }),
    knownBand: index.knownBand,
  });
}

/**
 * A token's colour. `text` tokens are not words and get no state at all —
 * §3.5 renders them plain and untappable — which is why this returns
 * `undefined` rather than `'new'` for them.
 *
 * A `word` token the dictionary has no headword for (`via: 'fallback'`, an
 * unknown name or a rare character) has no readings to ask about, so it is
 * `new`: it is a word the learner has demonstrably not met.
 */
export function tokenState(token: Token, index: ReaderIndex): WordState | undefined {
  if (token.kind !== 'word') return undefined;
  let best: WordState = 'new';
  for (const id of token.entryIds) {
    const state = entryState(id, index);
    if (RANK[state] > RANK[best]) best = state;
    if (best === 'known') break;
  }
  return best;
}

/** Every token's colour, in one pass over one index. */
export function tokenStates(
  tokens: readonly Token[],
  index: ReaderIndex,
): (WordState | undefined)[] {
  return tokens.map((token) => tokenState(token, index));
}

export interface ReaderIndexInput {
  cards: readonly { entryId?: string | null; fsrs: CardState }[];
  known: readonly EntryId[];
  /** entryId → band, for bands ≤ `knownBand`. */
  bands?: Iterable<readonly [EntryId, HskBand]>;
  knownBand: HskBand;
}

export function buildReaderIndex(input: ReaderIndexInput): ReaderIndex {
  const cards = new Map<EntryId, CardState>();
  for (const card of input.cards) {
    if (!card.entryId) continue;
    // Two cards for one entry (a second sense) is possible; the further-along
    // one is the honest answer to "have you met this word".
    const seen = cards.get(card.entryId);
    if (!seen || card.fsrs.stability > seen.stability) cards.set(card.entryId, card.fsrs);
  }
  return {
    cards,
    known: new Set(input.known),
    bands: new Map(input.bands ?? []),
    knownBand: input.knownBand,
  };
}

/**
 * The reader's one read: three repository queries and the HSK bands the learner
 * is assumed past. Band lists are memoised inside the `EntrySource`, so the
 * second text costs three IndexedDB reads and no network at all.
 */
export async function readReaderIndex(
  repo: Repository,
  source: EntrySource,
): Promise<ReaderIndex> {
  const [cards, known, settings] = await Promise.all([
    repo.allCards(),
    repo.knownEntryIds(),
    repo.getSettings(),
  ]);
  const knownBand = settings.knownBand;
  const bands: [EntryId, HskBand][] = [];
  for (const band of HSK_BANDS) {
    if (band > knownBand) break;
    for (const entry of await source.band(band)) bands.push([entry.id, band]);
  }
  return buildReaderIndex({ cards, known, bands, knownBand });
}
