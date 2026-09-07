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

export interface AskCache {
  get(key: string): Promise<AskCacheRow | undefined>;
  set(key: string, response: unknown): Promise<AskCacheRow>;
}

export interface Repository {
  /**
   * Add (or find) the word card for a dictionary entry. Idempotent per
   * (entryId, senseIndex): tapping Add twice does not make two cards.
   */
  addCardFromEntry(
    entry: Entry,
    context?: CardContext,
    senseIndex?: number,
    dictVersion?: string,
  ): Promise<CardRow>;

  /** A phrase card whose front is rendered from cited entries (§3.4). */
  addPhraseCard(tokens: PhraseToken[], en: string, context: CardContext): Promise<CardRow>;

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

  /** Every entry in `known_words`. */
  knownEntryIds(): Promise<string[]>;

  /** Every card, tombstones excluded. */
  allCards(): Promise<CardRow[]>;

  /** The word row for an entry, if the learner has met it. */
  wordByEntryId(entryId: string): Promise<WordRow | undefined>;

  lists(): Promise<ListRow[]>;
  createList(input: CreateListInput): Promise<ListRow>;
  listMembers(listId: string): Promise<ListMemberRow[]>;
  addListMembers(listId: string, entryIds: string[]): Promise<ListMemberRow[]>;
  setListActive(id: string, active: boolean): Promise<ListRow | undefined>;

  saveText(input: SaveTextInput): Promise<TextRow>;
  texts(): Promise<TextRow[]>;

  getSettings(): Promise<SettingsRow>;
  setSettings(patch: Partial<Omit<SettingsRow, 'id' | 'createdAt'>>): Promise<SettingsRow>;

  askCache: AskCache;

  /** Wipe every table. The `/settings` reset and the demo seed both use it. */
  resetAll(): Promise<void>;
}
