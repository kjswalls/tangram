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
import { getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
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
    for (const entry of await source.band(band)) {
      if (!spineEligible(entry)) continue;
      if (entry.hskBand !== undefined && entry.hskBand <= input.settings.knownBand) continue;
      if (take({ entryId: entry.id, from: 'spine', listId: list.id, band, entry })) return out;
    }
  }

  return out;
}
