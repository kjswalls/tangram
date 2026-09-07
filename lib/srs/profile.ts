/**
 * The learner profile (PLAN.md §3.3). It travels with every ask request because
 * it lives in the client's IndexedDB and the server has no copy.
 */

import type { CardRow, KnownWordRow, SettingsRow } from '@/lib/db/schema';
import { isPhraseSnapshot } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { wordState } from '@/lib/srs/states';
import { HSK_BANDS, parseEntryId, type HskBand, type LearnerProfile } from '@/lib/types';

export const KNOWN_SAMPLE_LIMIT = 200;

/** Share of a band that must be known or learning before the band counts as reached. */
export const BAND_COVERAGE = 0.8;

export interface ProfileInput {
  settings: Pick<SettingsRow, 'knownBand'>;
  cards: CardRow[];
  known: Pick<KnownWordRow, 'entryId'>[];
  /**
   * How many words each band holds, from the dictionary. Only the server has
   * this, so it is injected; without it the estimate falls back to `knownBand`.
   */
  bandSizes?: Partial<Record<HskBand, number>>;
}

/** What a sampled headword sorts on: frequency first, band as the tiebreak. */
interface SampleRank {
  band?: HskBand;
  freqRank?: number;
}

/** Pure core, so the estimate can be unit-tested without a database. */
export function buildLearnerProfile(input: ProfileInput): LearnerProfile {
  const knownIds = new Set(input.known.map((row) => row.entryId));
  const knownBand = input.settings.knownBand;

  /** simplified headword → how it should sort, for everything we can see. */
  const sample = new Map<string, SampleRank>();
  const reachedPerBand = new Map<HskBand, number>();

  for (const card of input.cards) {
    if (card.kind !== 'word' || isPhraseSnapshot(card.snapshot)) continue;
    const band = card.snapshot.hskBand;
    const state = wordState({
      card: card.fsrs,
      known: card.entryId ? knownIds.has(card.entryId) : false,
      hskBand: band,
      knownBand,
    });
    if (state === 'new') continue;
    if (!sample.has(card.snapshot.simp)) {
      sample.set(card.snapshot.simp, { band, freqRank: card.snapshot.freqRank });
    }
    if (band !== undefined) reachedPerBand.set(band, (reachedPerBand.get(band) ?? 0) + 1);
  }

  let estimatedBand: HskBand = knownBand;
  if (input.bandSizes) {
    for (const band of HSK_BANDS) {
      const total = input.bandSizes[band] ?? 0;
      if (total <= 0) continue;
      const reached = band <= knownBand ? total : (reachedPerBand.get(band) ?? 0);
      if (reached / total >= BAND_COVERAGE && band > estimatedBand) estimatedBand = band;
    }
  }

  // Words declared known without ever getting a card: the headword is recoverable
  // from the entry id, so they still count towards the sample.
  for (const entryId of knownIds) {
    const parsed = parseEntryId(entryId);
    if (parsed && !sample.has(parsed.simp)) sample.set(parsed.simp, {});
  }

  // §3.3 asks for a frequency-ordered sample: the 200 that survive the cut should
  // be the words the model is most likely to need. Band breaks the ties, and a
  // word with neither (a `known_words` row with no card) sorts last.
  const knownSample = [...sample.entries()]
    .sort(
      ([, a], [, b]) =>
        (a.freqRank ?? Number.MAX_SAFE_INTEGER) - (b.freqRank ?? Number.MAX_SAFE_INTEGER) ||
        (a.band ?? 99) - (b.band ?? 99),
    )
    .slice(0, KNOWN_SAMPLE_LIMIT)
    .map(([simp]) => simp);

  return { estimatedBand, knownSample };
}

export async function getLearnerProfile(
  repo: Repository,
  bandSizes?: Partial<Record<HskBand, number>>,
): Promise<LearnerProfile> {
  const [settings, cards, knownIds] = await Promise.all([
    repo.getSettings(),
    repo.allCards(),
    repo.knownEntryIds(),
  ]);
  return buildLearnerProfile({
    settings,
    cards,
    known: knownIds.map((entryId) => ({ entryId })),
    ...(bandSizes === undefined ? {} : { bandSizes }),
  });
}
