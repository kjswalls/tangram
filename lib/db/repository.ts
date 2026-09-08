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
   */
  addCardFromEntry(
    entry: Entry,
    context?: CardContext,
    senseIndex?: number,
    dictVersion?: string,
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
   * stability below the known threshold, or any non-Review state. With
   * `enable_short_term: false` the FSRS Learning and Relearning states never
   * occur, so a state-based reading of "learning" would always return [].
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
   */
  cardForEntry(entryId: string, senseIndex?: number): Promise<CardRow | undefined>;

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
