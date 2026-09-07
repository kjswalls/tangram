/**
 * Schema v1 (PLAN.md §3.3). **Frozen after Phase 0.**
 *
 * The rules that make a later Supabase move a swap rather than a rewrite:
 * every table keys on a client-generated `id: string` (`crypto.randomUUID()`,
 * Dexie `'id'`, never `'++id'`); rows carry `createdAt`/`updatedAt` as epoch ms
 * and a nullable `deletedAt` (soft delete — repository `list*` calls filter
 * tombstones); foreign keys are UUID strings and are indexed.
 *
 * Table names are the store names verbatim (`known_words`, not `knownWords`) so
 * the same identifiers survive into SQL.
 *
 * This module is types plus constants only: no Dexie import, no `server-only`,
 * no side effects — importing it from anywhere, on any runtime, is free.
 */

import type { CardContext, HskBand } from '@/lib/types';

export const DB_NAME = 'tangram';

/** Dexie version 1. A schema change stops the build (see CLAUDE.md). */
export const DB_VERSION = 1;

/** Columns every soft-deletable row carries. */
export interface BaseRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * A dictionary entry as it was when the card was made. Cards render from the
 * snapshot, so a dictionary rebuild can never silently change what is on a card.
 * Decomposition data is deliberately absent — different licence (CLAUDE.md).
 */
export interface EntrySnapshot {
  simp: string;
  trad: string;
  pinyinMarked: string;
  pinyinNum: string;
  glosses: string[];
  classifiers: string[];
  hskBand?: HskBand;
  /**
   * jieba rank, 1 = most frequent. Present so `lib/srs/profile.ts` can order
   * `knownSample` by frequency (§3.3): the sample is truncated to 200 in the
   * browser, before the ask request reaches a server that has the dictionary,
   * so ordering it any later would already have dropped the wrong words.
   */
  freqRank?: number;
  dictVersion: string;
}

/** One token of a phrase card: a cited entry, or free text the model produced. */
export interface PhraseToken {
  text: string;
  entryId?: string;
  pinyinMarked?: string;
  /** True when the token could not be grounded in the dictionary (§3.4). */
  unverified?: boolean;
}

/** A phrase card's front: the rendered tokens plus the English it answers. */
export interface PhraseSnapshot {
  tokens: PhraseToken[];
  simp: string;
  pinyinMarked: string;
  en: string;
  dictVersion: string;
}

export type CardSnapshot = EntrySnapshot | PhraseSnapshot;

export function isPhraseSnapshot(snapshot: CardSnapshot): snapshot is PhraseSnapshot {
  return 'tokens' in snapshot;
}

/** `ts-fsrs` `State` as stored: 0 New, 1 Learning, 2 Review, 3 Relearning. */
export type FsrsStateValue = 0 | 1 | 2 | 3;

/** `ts-fsrs` `Rating` as stored. Manual (0) is never written. */
export type StoredRating = 1 | 2 | 3 | 4;

/**
 * A `ts-fsrs` card with every date as epoch ms.
 *
 * `elapsed_days` is deliberately absent: it is deprecated upstream and the
 * scheduler recomputes it from `last_review`, which is the only elapsed-time
 * source v1 trusts (§3.3).
 */
export interface FsrsCardState {
  state: FsrsStateValue;
  due: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  learning_steps: number;
  last_review?: number;
}

/** A `ts-fsrs` `ReviewLog` with every date as epoch ms. */
export interface StoredReviewLog {
  rating: StoredRating;
  state: FsrsStateValue;
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  review: number;
}

/** One dictionary entry the learner has met. Cards hang off it. */
export interface WordRow extends BaseRow {
  entryId: string;
  snapshot: EntrySnapshot;
}

export interface CardRow extends BaseRow {
  /** Phrase cards have no single word behind them. */
  wordId: string | null;
  entryId: string | null;
  kind: 'word' | 'phrase';
  direction: 'recognition';
  snapshot: CardSnapshot;
  /** Which gloss the card is about, when a sense was chosen (§3.4). */
  senseIndex?: number;
  note?: string;
  context?: CardContext;
  fsrs: FsrsCardState;
  /** Mirrors `fsrs.due`; the indexed column the due queue reads. */
  due: number;
}

/** Append-only: one row per grade, enough to replay the card from scratch. */
export interface ReviewRow {
  id: string;
  cardId: string;
  rating: StoredRating;
  reviewedAt: number;
  /** The card's FSRS state *before* this grade. */
  before: FsrsCardState;
  log: StoredReviewLog;
  createdAt: number;
}

export interface ListRow extends BaseRow {
  name: string;
  owner: 'system' | 'user';
  kind: 'hsk' | 'looked-up' | 'custom';
  band?: HskBand;
  active: boolean;
  order: number;
}

export interface ListMemberRow {
  id: string;
  listId: string;
  entryId: string;
  /**
   * Always `null` in v1: membership joins on `entryId`, which is also the
   * compound index (`[listId+entryId]`), and nothing reads this column. A
   * backfill would need a repository member of its own — see HANDOFF.md.
   */
  wordId: string | null;
  order: number;
  createdAt: number;
  deletedAt: number | null;
}

/** Append-only. A word the learner has declared known (§3.3). */
export interface KnownWordRow {
  id: string;
  entryId: string;
  createdAt: number;
}

export interface TextRow extends BaseRow {
  title: string;
  body: string;
}

/** Ids and indexes only — never gloss text (CLAUDE.md, licence boundary). */
export interface AskCacheRow {
  /** The cache key itself: sha1(promptVersion, provider, query, context, band). */
  id: string;
  response: unknown;
  createdAt: number;
}

export type ScriptPreference = 'simp' | 'trad';
export type ProviderPreference = 'fake' | 'anthropic';

export interface SettingsRow {
  id: 'singleton';
  newPerDay: number;
  spineStartBand: HskBand;
  knownBand: HskBand;
  /** Local hour the study day rolls over at (§3.3, `lib/srs/day.ts`). */
  dayRollover: number;
  script: ScriptPreference;
  provider: ProviderPreference;
  /** dayKey → how many new cards were introduced that day. Persisted, per §3.3. */
  introduced: Record<string, number>;
  createdAt: number;
  updatedAt: number;
}

export const SETTINGS_ID = 'singleton';

export const DEFAULT_SETTINGS: Omit<SettingsRow, 'createdAt' | 'updatedAt'> = {
  id: SETTINGS_ID,
  newPerDay: 10,
  spineStartBand: 3,
  knownBand: 2,
  dayRollover: 4,
  script: 'simp',
  provider: 'fake',
  introduced: {},
};

/**
 * Dexie store definitions, version 1.
 *
 * `id` is always the primary key. Booleans and nulls are not valid IndexedDB
 * keys, so `active` and `deletedAt` are intentionally not indexed — tombstones
 * are filtered in the repository, not by the index.
 */
export const STORES_V1 = {
  words: 'id, entryId, updatedAt',
  cards: 'id, wordId, entryId, kind, due, createdAt, updatedAt',
  reviews: 'id, cardId, reviewedAt, [cardId+reviewedAt]',
  lists: 'id, kind, owner, order',
  list_members: 'id, listId, entryId, wordId, order, [listId+entryId]',
  known_words: 'id, entryId',
  texts: 'id, updatedAt',
  ask_cache: 'id, createdAt',
  settings: 'id',
} as const;

export type StoreName = keyof typeof STORES_V1;
