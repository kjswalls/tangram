/**
 * The auto-draw (PLAN.md §3.3): which words the app introduces next, when the
 * learner has not chosen any.
 *
 * Order, and it is the whole of the rule:
 *   1. unstarted explicit adds — handled in `lib/lists/queue.ts`, because they
 *      are already cards and this module only produces candidates that are not;
 *   2. unstarted words in active user lists, in list order;
 *   3. active spine bands from `settings.spineStartBand` upward, frequency order
 *      inside a band, skipping variants and proper nouns per `spineEligible`.
 *
 * Words the learner has already met — a card of any state, a `known_words` row,
 * or an HSK band at or below `settings.knownBand` — are never candidates. Cards
 * are not created here: a candidate is an `entryId` until `introduceCards` runs.
 */

import type { CardRow, ListRow, SettingsRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { BAND_PAGE, getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
import { spineEligible } from '@/lib/lists/spine';
import { memberEntryIds } from '@/lib/lists/members';
import { hskLists, userLists } from '@/lib/lists/system-lists';
import { HSK_BANDS, type Entry, type EntryId, type HskBand } from '@/lib/types';

export interface DrawCandidate {
  entryId: EntryId;
  /** Which pass produced it: a list the learner keeps, or the HSK spine. */
  from: 'list' | 'spine';
  listId: string;
  band?: HskBand;
  /** Present when the pass had the row in hand; saves a round trip later. */
  entry?: Entry;
}

export interface DrawInput {
  repo: Repository;
  settings: SettingsRow;
  lists: readonly ListRow[];
  /** How many candidates the cap still allows. Zero means "do not even fetch". */
  limit: number;
  /** Cards the learner already has; their entries are not candidates. */
  cards?: readonly CardRow[];
  /** `known_words` entry ids. Fetched from the repository when omitted. */
  knownEntryIds?: readonly EntryId[];
  source?: EntrySource;
}

/** Entry ids that must never be drawn: already carded, or already known. */
export async function drawExclusions(input: DrawInput): Promise<Set<EntryId>> {
  const cards = input.cards ?? (await input.repo.allCards());
  const known = input.knownEntryIds ?? (await input.repo.knownEntryIds());
  const out = new Set<EntryId>(known);
  for (const card of cards) if (card.entryId) out.add(card.entryId);
  return out;
}

export async function collectDrawCandidates(input: DrawInput): Promise<DrawCandidate[]> {
  if (input.limit <= 0) return [];
  const source = input.source ?? getEntrySource();
  const excluded = await drawExclusions(input);
  const out: DrawCandidate[] = [];

  const take = (candidate: DrawCandidate): boolean => {
    if (excluded.has(candidate.entryId)) return false;
    excluded.add(candidate.entryId);
    out.push(candidate);
    return out.length >= input.limit;
  };

  // (2) Active user lists, in list order. Their members were chosen by hand, so
  // the variant/proper-noun skip does not apply — only "already met" does.
  for (const list of userLists(input.lists)) {
    if (!list.active) continue;
    for (const entryId of await memberEntryIds(input.repo, list, source)) {
      if (take({ entryId, from: 'list', listId: list.id })) return out;
    }
  }

  // (3) The spine, band by band.
  const banded = hskLists(input.lists);
  for (const band of HSK_BANDS) {
    if (band < input.settings.spineStartBand) continue;
    if (band <= input.settings.knownBand) continue;
    const list = banded.find((row) => row.band === band);
    if (!list || !list.active) continue;
    /**
     * **Paged, not pulled whole** (core.md C4a).
     *
     * A band is up to 5,638 entries and this loop stops as soon as it has
     * `input.limit` of them — ten, by default. Reading the whole band to take
     * ten was affordable over a socket and is not over a Capacitor JSON
     * bridge, which is why `DictStore.hskBand` gained `limit`/`offset`. The
     * window asks for the next one only when the queue is still short; a short
     * answer means the band is exhausted.
     */
    let previousFirst: EntryId | undefined;
    /**
     * A hard bound as well as the two soft ones below.
     *
     * The largest HSK band is 5,638 entries, so 64 windows of 250 is nearly
     * three times the whole spine — a number no correct source can reach. It is
     * here because the failure mode of a loop that does not terminate is a
     * **hang**, and a hang in `pnpm test` reads as an infrastructure problem
     * rather than as the bug it is. Bounded, the same mistake becomes a short
     * queue, which a test can see.
     */
    const MAX_PAGES = 64;
    for (let offset = 0, page = 0; page < MAX_PAGES; offset += BAND_PAGE, page += 1) {
      const window = await source.band(band, { limit: BAND_PAGE, offset });
      /**
       * **Terminate on a source that ignores the window, not only on a short
       * page.** `EntrySource.band`'s options are optional, and a fake — or an
       * implementation that has not caught up — may hand back the whole band
       * every time. Then `offset` grows, the page stays full, and the loop
       * never ends: it hung the unit suite the first time this was written. A
       * page whose first entry is the one the last page started with has not
       * advanced, whatever its length says.
       */
      const first = window[0]?.id;
      if (offset > 0 && first !== undefined && first === previousFirst) break;
      previousFirst = first;

      for (const entry of window) {
        if (!spineEligible(entry)) continue;
        if (entry.hskBand !== undefined && entry.hskBand <= input.settings.knownBand) continue;
        if (take({ entryId: entry.id, from: 'spine', listId: list.id, band, entry })) return out;
      }
      if (window.length < BAND_PAGE) break;
    }
  }

  return out;
}
