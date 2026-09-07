/**
 * Turning a draw candidate into a card (PLAN.md §3.3).
 *
 * This is the only place `settings.introduced[dayKey]` goes up, and it goes up
 * when a card is **created**, not when one is answered — a learner who opens
 * Today, sees ten new words and closes the tab has spent the day's ten. The
 * counter is persisted, so a reload cannot hand out another ten.
 *
 * Every non-explicit creation goes through here for that reason: the spine
 * draw, a list's "Add to queue" (`queueFromList`) and the demo seed
 * (`chargeIntroduced`). A card created any other way would be free until it was
 * graded and would then hand its slot back — which is exactly the bug that made
 * "grade 10 new, reload → no further spine cards today" false.
 *
 * The `words` row is created here too, by the repository, which is what "words
 * are materialised on demand" means: the HSK spine is 11k dictionary rows and
 * none of them exist locally until they are actually being learned.
 */

import type { CardRow, SettingsRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import type { DrawCandidate } from '@/lib/lists/draw';
import { getEntrySource, type EntrySource } from '@/lib/lists/entry-source';
import { todayKey } from '@/lib/srs/day';
import type { Entry, EntryId } from '@/lib/types';

export interface IntroduceOptions {
  now?: number;
  source?: EntrySource;
  /** Saves a read when the caller has it; the counter is written off a fresh read. */
  settings?: SettingsRow;
  /** Entry ids that already have a card, so a re-draw is not counted twice. */
  carded?: ReadonlySet<EntryId>;
  /** `meta.version` of `data/dict.json`, when the caller knows it. */
  dictVersion?: string;
}

export interface IntroduceResult {
  /** Cards that did not exist before this call. */
  created: CardRow[];
  /** Every card the candidates resolve to, created or already there. */
  cards: CardRow[];
  settings: SettingsRow;
}

export async function introduceCards(
  repo: Repository,
  candidates: readonly DrawCandidate[],
  options: IntroduceOptions = {},
): Promise<IntroduceResult> {
  const now = options.now ?? Date.now();
  const settings = options.settings ?? (await repo.getSettings());
  if (candidates.length === 0) return { created: [], cards: [], settings };

  const source = options.source ?? getEntrySource();
  const carded = new Set<EntryId>(
    options.carded ??
      (await repo.allCards()).flatMap((card) => (card.entryId ? [card.entryId] : [])),
  );

  // The spine pass already holds its rows; only list draws need a round trip.
  const known = new Map<EntryId, Entry>();
  for (const candidate of candidates) if (candidate.entry) known.set(candidate.entryId, candidate.entry);
  const missing = candidates.filter((candidate) => !known.has(candidate.entryId));
  if (missing.length > 0) {
    for (const entry of await source.entries(missing.map((candidate) => candidate.entryId))) {
      known.set(entry.id, entry);
    }
  }

  const created: CardRow[] = [];
  const cards: CardRow[] = [];
  for (const candidate of candidates) {
    const entry = known.get(candidate.entryId);
    // An id the dictionary no longer has (a rebuilt snapshot, a stale list) is
    // skipped rather than throwing: one dead row must not empty the queue.
    if (!entry) continue;
    const card = await repo.addCardFromEntry(
      entry,
      { source: 'list', addedAt: now },
      undefined,
      options.dictVersion,
    );
    cards.push(card);
    if (!carded.has(entry.id)) {
      carded.add(entry.id);
      created.push(card);
    }
  }

  if (created.length === 0) return { created, cards, settings };

  const fresh = await repo.getSettings();
  const key = todayKey(now, fresh.dayRollover);
  const next = await repo.setSettings({
    introduced: { ...fresh.introduced, [key]: (fresh.introduced[key] ?? 0) + created.length },
  });
  return { created, cards, settings: next };
}

export interface QueueFromListOptions {
  now?: number;
  dictVersion?: string;
  /** The list the word was queued from, for the draw's own bookkeeping. */
  listId?: string;
}

/**
 * Queue one word by hand from a list view. Provenance says `list`, so it is not
 * an explicit lookup and does not bypass the cap — it *spends* one of the day's
 * introductions, exactly as a spine draw does, which is why it goes through
 * `introduceCards` rather than writing the card itself.
 */
export async function queueFromList(
  repo: Repository,
  entry: Entry,
  options: QueueFromListOptions = {},
): Promise<CardRow> {
  const now = options.now ?? Date.now();
  const outcome = await introduceCards(
    repo,
    [{ entryId: entry.id, from: 'list', listId: options.listId ?? '', entry }],
    {
      now,
      ...(options.dictVersion === undefined ? {} : { dictVersion: options.dictVersion }),
    },
  );
  // `introduceCards` skips an id the dictionary no longer has; here the entry is
  // in hand, so there is always exactly one card.
  return outcome.cards[0];
}

/**
 * Charge the day's counter for cards a caller created outside `introduceCards`
 * — the demo seed, which needs its own provenance on each row. Same rule, one
 * write: `settings.introduced[dayKey] += count`.
 */
export async function chargeIntroduced(
  repo: Repository,
  count: number,
  now: number = Date.now(),
): Promise<SettingsRow> {
  const fresh = await repo.getSettings();
  if (count <= 0) return fresh;
  const key = todayKey(now, fresh.dayRollover);
  return repo.setSettings({
    introduced: { ...fresh.introduced, [key]: (fresh.introduced[key] ?? 0) + count },
  });
}
