/**
 * The persistence seam (PLAN.md §3.3). **Frozen after Phase 0.**
 *
 * Everything above the db layer talks to this interface and nothing else, which
 * is what makes a later move to Supabase a swap rather than a rewrite.
 * `lib/db/dexie.ts` is the only implementation in v1.
 *
 * Interface only: no Dexie import, no side effects.
 */

import type {
  AskCacheRow,
  CardDirection,
  CardRow,
  KnownWordRow,
  ListMemberRow,
  ListRow,
  PhraseToken,
  ReviewRow,
  SettingsRow,
  StoredRating,
  TextRow,
  WordRow,
} from '@/lib/db/schema';
import type { CardContext, Entry } from '@/lib/types';

export interface GradeOutcome {
  card: CardRow;
  review: ReviewRow;
}

export interface SaveTextInput {
  /** Pass an existing id to update that text in place. */
  id?: string;
  title: string;
  body: string;
}

export interface CreateListInput {
  name: string;
  owner?: ListRow['owner'];
  kind: ListRow['kind'];
  band?: ListRow['band'];
  active?: boolean;
  order?: number;
}

/** What `introduceCard` did: the card, whether this call made it, and the counter after. */
export interface IntroducedCard {
  card: CardRow;
  /** False when the card was already there — the day's counter was not charged. */
  created: boolean;
  settings: SettingsRow;
}

/**
 * How many cards sit in each FSRS state (Phase 8, the retention dashboard).
 * Keyed by name rather than by the stored 0–3, because a chart legend that
 * says "2" is a chart nobody can read.
 */
export interface CardStateCounts {
  new: number;
  learning: number;
  review: number;
  relearning: number;
  /** Every live card, including the New ones. */
  total: number;
}

/**
 * One bar of the stability histogram: cards whose FSRS stability (in days)
 * falls in `[minDays, maxDays)`. The top bucket has no upper bound.
 */
export interface StabilityBucket {
  label: string;
  minDays: number;
  maxDays: number | null;
  count: number;
}

/**
 * The buckets themselves, shared so the dashboard and the repository cannot
 * disagree about what a bar means. The 21-day edge is deliberate: it is
 * `KNOWN_STABILITY_DAYS`, the threshold the reader colours a word "known" at,
 * so the histogram reads as "how much of this is actually consolidated".
 */
export const STABILITY_BUCKETS: readonly { label: string; minDays: number; maxDays: number | null }[] =
  [
    { label: '< 1d', minDays: 0, maxDays: 1 },
    { label: '1–7d', minDays: 1, maxDays: 7 },
    { label: '7–21d', minDays: 7, maxDays: 21 },
    { label: '21–90d', minDays: 21, maxDays: 90 },
    { label: '90–365d', minDays: 90, maxDays: 365 },
    { label: '1y+', minDays: 365, maxDays: null },
  ];

export interface AskCache {
  get(key: string): Promise<AskCacheRow | undefined>;
  set(key: string, response: unknown): Promise<AskCacheRow>;
}

export interface Repository {
  /**
   * Add (or find) the word card for a dictionary entry. Idempotent per
   * (entryId, senseIndex): tapping Add twice does not make two cards.
   *
   * A second Add still delivers its `context`: fields the stored card is
   * missing (a reader's sentence, an ask's question, a lookup's query) are
   * merged onto it, and a card the spine drew is promoted to the explicit
   * source that asked for it. Nothing already recorded is overwritten.
   *
   * `direction` defaults to `'recognition'`, which is every card v1 ever wrote,
   * so an existing caller keeps the card it has always got. A production card
   * for the same entry and sense is a *different* row with its own schedule
   * (`CardDirection`), and asking for one never returns or disturbs the other.
   */
  addCardFromEntry(
    entry: Entry,
    context?: CardContext,
    senseIndex?: number,
    dictVersion?: string,
    direction?: CardDirection,
  ): Promise<CardRow>;

  /**
   * Create the card for a drawn word **and** charge the day's counter for it,
   * atomically (§3.3, `lib/lists/introduce.ts`).
   *
   * Two open tabs are two JS contexts over one IndexedDB. Both can open Today,
   * both draw the same ten words, and with the card write and the counter write
   * as separate calls both charge — so `settings.introduced` says twenty for ten
   * cards, or a lost update says ten for twenty. Here the two are one
   * transaction: whichever tab gets there second finds the card already
   * committed, reports `created: false`, and does not charge.
   *
   * `dayKey` is the caller's (`todayKey(now, settings.dayRollover)`) because the
   * repository has no notion of the study day; `settings` comes back so the
   * caller does not have to re-read what it just changed.
   */
  introduceCard(
    entry: Entry,
    context: CardContext | undefined,
    dayKey: string,
    dictVersion?: string,
  ): Promise<IntroducedCard>;

  /**
   * `settings.introduced[dayKey] += count`, read-modify-written in one
   * transaction. For the callers that create their cards themselves (the demo
   * seed) and still owe the day's allowance. A `count` at or below zero is a
   * no-op, never a decrement.
   */
  bumpIntroduced(dayKey: string, count: number): Promise<SettingsRow>;

  /**
   * A phrase card whose front is rendered from cited entries (§3.4).
   *
   * `dictVersion` is the fourth argument for the same reason
   * `addCardFromEntry` has one: a snapshot records the dictionary it was cut
   * from, and the layer that holds a phrase together (the ask panel, which has
   * just been told `meta.version` by the route that resolved the citations) is
   * the only one that knows it. Omitted, it stamps `'unknown'` — which is what
   * every phrase card written before this argument existed says.
   */
  addPhraseCard(
    tokens: PhraseToken[],
    en: string,
    context: CardContext,
    dictVersion?: string,
  ): Promise<CardRow>;

  /** Cards past their due instant, oldest first. New cards are not due. */
  listDue(now: number): Promise<CardRow[]>;

  /**
   * Cards due within the horizon that are not yet consolidated: Review with
   * stability below the known threshold, or any non-Review state. "Learning" is
   * the reader's word (§3.3), not the FSRS state — under v1's
   * `enable_short_term: false` the Learning and Relearning states never
   * occurred at all, so a state-based reading would always have returned [];
   * with the steps on (the default since Phase 8) it now takes in both.
   */
  listLearningSoon(now: number, horizonMs: number): Promise<CardRow[]>;

  /** Grade a card: writes the new FSRS state and an append-only review row. */
  grade(cardId: string, rating: StoredRating, now?: number): Promise<GradeOutcome>;

  /** Cards still in state New, oldest first — the pool the queue draws from. */
  newCandidates(limit: number): Promise<CardRow[]>;

  /** Declare entries known; existing cards are pushed out of the queue. */
  markKnown(entryIds: string[]): Promise<KnownWordRow[]>;

  /**
   * Undeclare entries: the `known_words` rows go, the cards they evicted stay
   * where they are. Returns how many rows were removed.
   *
   * Added by the Phases 4–5 review (HANDOFF.md): "known" and "has a card due
   * today" are contradictory states, and nothing could leave the first one.
   * Adding a card for a word is the learner saying they want to study it, so
   * `addCardTracked` calls this — otherwise the reader painted the word known,
   * the queue served it, and the Looked-up list read "known · Queued".
   */
  unmarkKnown(entryIds: string[]): Promise<number>;

  /** Every entry in `known_words`. */
  knownEntryIds(): Promise<string[]>;

  /** Every card, tombstones excluded. */
  allCards(): Promise<CardRow[]>;

  /**
   * The word card for an entry, if there is one — what `addCardFromEntry` would
   * find. The UI asks before adding, so it can say "already in your cards"
   * instead of claiming an Add that only found the existing row.
   *
   * `direction` defaults to `'recognition'`: an existing caller asks about the
   * card it has always meant, and a production card added later cannot silently
   * become the answer to a question about the recognition one.
   */
  cardForEntry(
    entryId: string,
    senseIndex?: number,
    direction?: CardDirection,
  ): Promise<CardRow | undefined>;

  /**
   * Review rows in the half-open window `[fromMs, toMs)`, oldest first.
   *
   * The dashboard's "reviews per day" and "how did I answer this week" both
   * read this, and the optimizer uses it to hold out a period. Half-open so
   * consecutive windows tile without double-counting the row on the boundary.
   */
  reviewsBetween(fromMs: number, toMs: number): Promise<ReviewRow[]>;

  /**
   * Every review ever written, ordered by `reviewedAt` — the optimizer's
   * training input (§3.3: the reviews table is the source of truth, and the
   * stored card is a cache of it).
   *
   * Ordered across *all* cards rather than grouped by card: FSRS is fitted on a
   * chronology, and a caller that wants per-card histories can group by
   * `cardId` from this without a second read. Reviews are append-only and carry
   * no tombstone, so nothing is filtered out.
   */
  allReviewsChronological(): Promise<ReviewRow[]>;

  /** How many live cards sit in each FSRS state. */
  cardCountsByState(): Promise<CardStateCounts>;

  /**
   * Live cards bucketed by FSRS stability (`STABILITY_BUCKETS`). New cards are
   * excluded — their stability is a placeholder, not a memory — so the bars sum
   * to `cardCountsByState().total - .new`.
   */
  stabilityHistogram(): Promise<StabilityBucket[]>;

  /** The word row for an entry, if the learner has met it. */
  wordByEntryId(entryId: string): Promise<WordRow | undefined>;

  lists(): Promise<ListRow[]>;
  createList(input: CreateListInput): Promise<ListRow>;
  listMembers(listId: string): Promise<ListMemberRow[]>;
  addListMembers(listId: string, entryIds: string[]): Promise<ListMemberRow[]>;
  setListActive(id: string, active: boolean): Promise<ListRow | undefined>;
  /**
   * Rename a list. The system lists are named by `lib/lists/system-lists.ts`,
   * which finds an HSK band by its `band` column, so renaming one is allowed and
   * does not orphan it.
   */
  renameList(id: string, name: string): Promise<ListRow | undefined>;
  /**
   * Soft-delete a list and its membership. A tombstoned list is gone from
   * `lists()`, so `ensureSystemLists` will recreate a deleted *system* list on
   * the next visit — deleting one is a reset, not a removal.
   */
  deleteList(id: string): Promise<void>;
  /** Soft-delete membership rows. The cards those words made are untouched. */
  removeListMembers(listId: string, entryIds: string[]): Promise<number>;

  saveText(input: SaveTextInput): Promise<TextRow>;
  texts(): Promise<TextRow[]>;

  getSettings(): Promise<SettingsRow>;
  setSettings(patch: Partial<Omit<SettingsRow, 'id' | 'createdAt'>>): Promise<SettingsRow>;

  askCache: AskCache;

  /** Wipe every table. The `/settings` reset and the demo seed both use it. */
  resetAll(): Promise<void>;
}
