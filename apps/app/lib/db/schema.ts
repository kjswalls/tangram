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

/**
 * Dexie version 3. A schema change stops the build (see CLAUDE.md); both bumps
 * so far were commissioned.
 *
 * - v2 added the unique `&systemKey` index that stops two open tabs creating
 *   the eight system lists twice (`systemKey` below).
 * - v3 (Phase 8 prep) adds `[entryId+direction]` on `cards`: a card is now
 *   identified by its direction as well as its entry (`CardDirection`), so
 *   "the production card for this entry" has to be a lookup, not a scan.
 *
 * **Neither rewrites a row and neither drops one.** An index is a declaration;
 * IndexedDB rebuilds it from the rows already stored. Every `cards` row ever
 * written carries `direction: 'recognition'` (both writers set it literally,
 * since Phase 0), so the new index covers the existing data as it stands — and
 * the v3 upgrade in `lib/db/dexie.ts` stamps the default onto any row that
 * somehow lacks it rather than trusting that claim.
 *
 * The four new `settings` columns need **no** version of their own: Dexie
 * declares indexes, not shapes, and `settings` is indexed on `id` alone. They
 * are filled in on read instead (`getSettings` merges `DEFAULT_SETTINGS` under
 * the stored row), which is a repository rule rather than a Dexie one and so
 * survives the Supabase swap.
 */
export const DB_VERSION = 3;

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

/**
 * Which way round a card is asked.
 *
 * `recognition` — hanzi on the front, meaning on the back. Every card written
 * before Phase 8 is one of these, and it stays the default everywhere a
 * direction is optional.
 *
 * `production` — the meaning on the front, the hanzi recalled. It is a
 * *separate card* with its own FSRS state, not a mode the review session
 * toggles: the two directions are learned at different rates, and one schedule
 * cannot serve both. `settings.productionDirection` is the switch that decides
 * whether they get made.
 */
export type CardDirection = 'recognition' | 'production';

export const CARD_DIRECTIONS: readonly CardDirection[] = ['recognition', 'production'];

/** What a card is, when nobody says otherwise — and what v1 wrote. */
export const DEFAULT_CARD_DIRECTION: CardDirection = 'recognition';

export interface CardRow extends BaseRow {
  /** Phrase cards have no single word behind them. */
  wordId: string | null;
  entryId: string | null;
  kind: 'word' | 'phrase';
  /** Indexed with `entryId` as `[entryId+direction]` since Dexie v3. */
  direction: CardDirection;
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
  /**
   * The natural key of a system list — `'looked-up'`, or `'hsk:3'` — indexed
   * `&systemKey` so the database itself refuses a second copy. Two tabs are two
   * JS contexts over one IndexedDB and both could read "no lists yet" before
   * either wrote; a promise memoised per repository cannot see across that.
   *
   * Absent on a user's own list (nothing to be unique about) and absent on a
   * tombstone (`deleteList` releases it), because deleting a system list is a
   * reset and `ensureSystemLists` has to be able to make it again. IndexedDB
   * does not index a row whose key path is missing, so neither takes part in
   * the constraint.
   */
  systemKey?: string;
}

/**
 * The natural key of a system list, or `undefined` for a list the learner made.
 *
 * "Looked up" is one row per database and an HSK list is one row per band, so
 * those two facts *are* the key. It lives here rather than in `lib/lists`
 * because the uniqueness it names is enforced by the schema.
 */
export function systemListKey(
  kind: ListRow['kind'],
  band?: HskBand,
): string | undefined {
  if (kind === 'hsk') return band === undefined ? undefined : `hsk:${band}`;
  if (kind === 'looked-up') return 'looked-up';
  return undefined;
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

/**
 * One fit of the FSRS weights to *this* learner's review history (Phase 8).
 *
 * `w` is the parameter vector `ts-fsrs` takes: 17, 19 or 21 numbers (FSRS 4, 5
 * and 6 respectively — this build's `default_w` is 21). Nothing here is trusted
 * blindly: `lib/srs/params.ts` validates the vector before it reaches the
 * scheduler and falls back to the population defaults if it does not hold up.
 *
 * The other four fields are the fit's provenance, and they are stored because a
 * number that cannot be judged is worse than no number. `reviewCount` and
 * `fittedAt` say what it was fitted on and when; the two log-losses say whether
 * the fit is actually better than the defaults **on data it was not fitted on**
 * — `heldOutLogLoss < baselineLogLoss` is the only honest reason to keep it.
 * The optimizer (builder A) decides that; this row records the evidence.
 */
export interface FsrsWeights {
  w: number[];
  /** When the fit was made (epoch ms). */
  fittedAt: number;
  /** How many reviews it was fitted on. */
  reviewCount: number;
  /** Log loss of the fitted weights on the held-out reviews. Lower is better. */
  heldOutLogLoss: number;
  /** Log loss of the population defaults on the same held-out reviews. */
  baselineLogLoss: number;
}

export interface SettingsRow {
  id: 'singleton';
  newPerDay: number;
  spineStartBand: HskBand;
  knownBand: HskBand;
  /** Local hour the study day rolls over at (§3.3, `lib/srs/day.ts`). */
  dayRollover: number;
  script: ScriptPreference;
  provider: ProviderPreference;
  /**
   * Show i+1 example sentences on the card back (Phase 6 item 1). Optional
   * because a `settings` row written before this field existed does not carry
   * it: `getSettings` returns the stored row as it stands, so a reader has to
   * treat `undefined` as the default rather than as `false`. Adding it needs no
   * Dexie version bump — `STORES_V1.settings` indexes `id` and nothing else,
   * and IndexedDB does not police the shape of an unindexed field.
   */
  examplesOnBack?: boolean;
  /** Offer the "what does it mean?" box on the card front (Phase 6 item 2). */
  freeRecall?: boolean;

  /**
   * FSRS's target recall probability at review time — `request_retention`
   * (Phase 8). 0.9 is FSRS's own default and the one v1 ran on. Higher means
   * shorter intervals: more reviews, more of them remembered.
   *
   * Required rather than optional, unlike the two Phase 6 toggles above,
   * because `getSettings` now merges `DEFAULT_SETTINGS` under whatever is
   * stored — a row written before Phase 8 comes back carrying the default, so
   * a reader never has to spell `?? 0.9` and never has to guess whether
   * `undefined` meant "off" or "not decided".
   */
  requestRetention: number;

  /**
   * Run FSRS with its own learning steps — `enable_short_term: true` plus
   * `learning_steps: ['1m','10m']` (Phase 8). **Default true**, which restores
   * the ts-fsrs default that v1 deliberately deviated from.
   *
   * v1 set it false so that every grade scheduled at least a day and a session
   * ended cleanly. The cost was that failing a brand-new card put it away for a
   * day, which is exactly when it should have come back in ten minutes. Turning
   * it on changes queue semantics — a card can now be due inside the session —
   * and making the queue honour that is builder A's job, not this row's.
   */
  shortTermSteps: boolean;

  /**
   * Also make a production card (meaning → hanzi) for a word (Phase 8). Off by
   * default: it roughly doubles the daily review load, so it is a choice the
   * learner makes, not one made for them.
   */
  productionDirection: boolean;

  /**
   * Weights fitted to this learner's own reviews, or `null` for the population
   * defaults. `lib/srs/params.ts` is the only reader; nothing else may pull `w`
   * out of here and hand it to `ts-fsrs`.
   */
  fsrsWeights: FsrsWeights | null;

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
  examplesOnBack: true,
  freeRecall: false,
  // 0.9 is FSRS's own `default_request_retention`; the settings slider spans
  // 0.70–0.97 (`lib/srs/params.ts` clamps to the same range).
  requestRetention: 0.9,
  // TRUE on purpose: it is the ts-fsrs default, and v1's `false` was the
  // deviation. See the field’s doc block, and HANDOFF.md (Phase 8 prep).
  shortTermSteps: true,
  productionDirection: false,
  fsrsWeights: null,
  introduced: {},
};

/**
 * Dexie store definitions, version 1. Kept verbatim: a version's schema is
 * history, and Dexie needs v1 declared to upgrade a database that stopped there.
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

/**
 * Version 2 — v1 plus one index: `&systemKey` on `lists`, the constraint that
 * makes "one 'Looked up', one list per HSK band" a fact about the database
 * rather than a convention two tabs can each believe they are the first to
 * honour. Every other store is byte-identical to v1.
 */
export const STORES_V2 = {
  ...STORES_V1,
  lists: 'id, kind, owner, order, &systemKey',
} as const;

/**
 * Version 3 — v2 plus one compound index, `[entryId+direction]` on `cards`.
 *
 * The plain `entryId` index stays exactly where it was, so every existing
 * caller (`cardForEntry`, `markKnown`, `writeCard`) keeps the query it already
 * had; the compound one is what makes "the production card for 打算" a lookup
 * rather than a scan of every card the entry has. Nothing is removed, and a
 * row whose `entryId` is null (a phrase card) is absent from both, which is
 * IndexedDB's rule about null keys and not a decision made here.
 */
export const STORES_V3 = {
  ...STORES_V2,
  cards: 'id, wordId, entryId, kind, due, createdAt, updatedAt, [entryId+direction]',
} as const;

/** The current definitions. `STORES_V1`/`V2` are kept for the upgrade path. */
export const STORES = STORES_V3;

export type StoreName = keyof typeof STORES_V1;
