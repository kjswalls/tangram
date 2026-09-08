/**
 * The Dexie implementation of the repository seam (PLAN.md §3.3).
 *
 * No `'use client'` here and no `server-only` anywhere under `lib/db`: importing
 * this module must not open a database or throw under Node. The instance is
 * built lazily by `lib/db/get-db.ts`.
 */

import Dexie, { type Table } from 'dexie';

import {
  DB_NAME,
  DB_VERSION,
  DEFAULT_CARD_DIRECTION,
  DEFAULT_SETTINGS,
  SETTINGS_ID,
  STORES_V1,
  STORES_V2,
  STORES_V3,
  systemListKey,
  type AskCacheRow,
  type CardDirection,
  type CardRow,
  type EntrySnapshot,
  type KnownWordRow,
  type ListMemberRow,
  type ListRow,
  type PhraseSnapshot,
  type PhraseToken,
  type ReviewRow,
  type SettingsRow,
  type StoredRating,
  type TextRow,
  type WordRow,
} from '@/lib/db/schema';
import type {
  AskCache,
  CardStateCounts,
  CreateListInput,
  GradeOutcome,
  Repository,
  SaveTextInput,
  StabilityBucket,
} from '@/lib/db/repository';
import { STABILITY_BUCKETS } from '@/lib/db/repository';
import { gradeCard, newCard } from '@/lib/srs/card';
import { KNOWN_STABILITY_DAYS, knownCardState } from '@/lib/srs/states';
import type { CardContext, Entry } from '@/lib/types';

/**
 * Client-generated ids, per §3.3. jsdom does not always ship
 * `crypto.randomUUID`, so fall back to formatting random bytes ourselves.
 */
export function newId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UNKNOWN_DICT_VERSION = 'unknown';

/**
 * Table properties are named exactly like the stores (`known_words`, not
 * `knownWords`) so the same identifiers survive into SQL later.
 */
export class TangramDb extends Dexie {
  declare words: Table<WordRow, string>;
  declare cards: Table<CardRow, string>;
  declare reviews: Table<ReviewRow, string>;
  declare lists: Table<ListRow, string>;
  declare list_members: Table<ListMemberRow, string>;
  declare known_words: Table<KnownWordRow, string>;
  declare texts: Table<TextRow, string>;
  declare ask_cache: Table<AskCacheRow, string>;
  declare settings: Table<SettingsRow, string>;

  constructor(name: string = DB_NAME) {
    super(name);
    // Every version is declared as it shipped, so a database that stopped at
    // any of them upgrades rather than being rebuilt: v2 adds the `&systemKey`
    // index and stamps the key onto the system lists the old database already
    // has, v3 adds `[entryId+direction]` on `cards` (below).
    this.version(1).stores(STORES_V1);
    this.version(2)
      .stores(STORES_V2)
      .upgrade(async (tx) => {
        const table = tx.table<ListRow, string>('lists');
        const rows = (await table.toArray()).sort((a, b) => a.createdAt - b.createdAt);
        const claimed = new Set<string>();
        for (const row of rows) {
          const key = systemListKey(row.kind, row.band);
          // A tombstone never holds the key: deleting a system list is a reset,
          // and `ensureSystemLists` has to be able to create it again.
          if (key === undefined || row.deletedAt !== null) continue;
          if (claimed.has(key)) {
            // The bug this index closes could already have run: the oldest row
            // is the one the app has been using, so the later copy is retired
            // rather than left to fail the index.
            await table.put({ ...row, deletedAt: Date.now(), updatedAt: Date.now() });
            continue;
          }
          claimed.add(key);
          await table.put({ ...row, systemKey: key });
        }
      });
    // v3 declares `[entryId+direction]` on `cards`. Declaring an index is all
    // it takes — IndexedDB builds it from the rows already stored — and every
    // card ever written carries `direction: 'recognition'`, so this upgrade is
    // belt and braces: it stamps the default onto any row that somehow has no
    // direction, so that a row cannot be invisible to a compound-index query.
    // Nothing is deleted, and a row that already has one is not rewritten.
    this.version(DB_VERSION)
      .stores(STORES_V3)
      .upgrade(async (tx) => {
        const table = tx.table<CardRow, string>('cards');
        const stale = (await table.toArray()).filter((row) => !row.direction);
        if (stale.length > 0) {
          await table.bulkPut(
            stale.map((row) => ({ ...row, direction: DEFAULT_CARD_DIRECTION })),
          );
        }
      });
  }
}

const alive = <T extends { deletedAt: number | null }>(row: T): boolean => row.deletedAt === null;

/** The sources that mean "the learner chose this card" (§3.3, plus Phase 8's `reverse`). */
const EXPLICIT_SOURCES = new Set<CardContext['source']>(['lookup', 'ask', 'reader', 'reverse']);

/** The provenance fields a later Add can fill in; `source`/`addedAt` are handled apart. */
const CONTEXT_FIELDS = ['sentence', 'question', 'query', 'offset', 'length'] as const;

/**
 * What a second Add contributes to a card that already exists.
 *
 * The spine draws 了 with `{source:'list'}` before the learner ever reads it;
 * when they then add it from the reader with a sentence, the card is the same
 * row but the provenance is new, and dropping it made the UI's "it carries
 * '…'" a lie and left P5's card back with nothing to highlight. Only *absent*
 * fields are filled: a richer context is never overwritten by a poorer one, and
 * `source` is promoted only from a non-explicit source to an explicit one, so a
 * reader card that is later looked up keeps saying `reader`.
 *
 * Returns `undefined` when the incoming context adds nothing, so the caller can
 * skip the write.
 */
export function mergeCardContext(
  existing: CardContext | undefined,
  incoming: CardContext | undefined,
): CardContext | undefined {
  if (!incoming) return undefined;
  if (!existing) return incoming;
  const next: CardContext = { ...existing };
  let changed = false;
  const fill = <K extends (typeof CONTEXT_FIELDS)[number]>(field: K): void => {
    if (next[field] !== undefined || incoming[field] === undefined) return;
    next[field] = incoming[field];
    changed = true;
  };
  for (const field of CONTEXT_FIELDS) fill(field);
  if (!EXPLICIT_SOURCES.has(existing.source) && EXPLICIT_SOURCES.has(incoming.source)) {
    next.source = incoming.source;
    changed = true;
  }
  return changed ? next : undefined;
}

export function toEntrySnapshot(entry: Entry, dictVersion: string): EntrySnapshot {
  return {
    simp: entry.simp,
    trad: entry.trad,
    pinyinMarked: entry.pinyinMarked,
    pinyinNum: entry.pinyinNum,
    glosses: entry.glosses,
    classifiers: entry.classifiers,
    ...(entry.hskBand === undefined ? {} : { hskBand: entry.hskBand }),
    // Carried so the learner profile can order its sample by frequency without
    // the dictionary in hand (§3.3); the client truncates the sample to 200
    // before the server ever sees it, so a later re-sort would come too late.
    ...(entry.freqRank === undefined ? {} : { freqRank: entry.freqRank }),
    dictVersion,
  };
}

export function createDexieRepository(db: TangramDb): Repository {
  async function ensureWord(entry: Entry, dictVersion: string, now: number): Promise<WordRow> {
    const existing = (await db.words.where('entryId').equals(entry.id).toArray()).find(alive);
    if (existing) return existing;
    const word: WordRow = {
      id: newId(),
      entryId: entry.id,
      snapshot: toEntrySnapshot(entry, dictVersion),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await db.words.add(word);
    return word;
  }

  /**
   * The word-card write itself, assuming a caller that has already opened a
   * readwrite transaction over `words` and `cards`.
   *
   * It is separate from `addCardFromEntry` because `introduceCard` needs the
   * same work to happen inside a *wider* transaction — one that also holds
   * `settings` — so that "did this call create the card?" and "charge the day
   * for it" are one atomic decision rather than two a second tab can interleave.
   * `created` is that decision, and only the transaction can make it honestly.
   */
  async function writeCard(
    entry: Entry,
    context: CardContext | undefined,
    senseIndex: number | undefined,
    dictVersion: string,
    now: number,
    direction: CardDirection = DEFAULT_CARD_DIRECTION,
  ): Promise<{ card: CardRow; created: boolean }> {
    // Identity is (entryId, senseIndex, direction): the production card for a
    // word is a different card from the recognition one, with its own
    // schedule, so an Add for one must not find — or merge context onto — the
    // other. Read through the compound index; the plain `entryId` one is still
    // there for the callers that want every direction at once.
    const existing = (await db.cards.where('[entryId+direction]').equals([entry.id, direction]).toArray())
      .filter(alive)
      .find((card) => card.kind === 'word' && card.senseIndex === senseIndex);
    if (existing) {
      // Idempotent per (entryId, senseIndex) — but not silent: an Add that
      // brings provenance the stored card has not got writes it on.
      const merged = mergeCardContext(existing.context, context);
      if (!merged) return { card: existing, created: false };
      const updated: CardRow = { ...existing, context: merged, updatedAt: now };
      await db.cards.put(updated);
      return { card: updated, created: false };
    }

    const word = await ensureWord(entry, dictVersion, now);
    const fsrs = newCard(now);
    const card: CardRow = {
      id: newId(),
      wordId: word.id,
      entryId: entry.id,
      kind: 'word',
      direction,
      snapshot: toEntrySnapshot(entry, dictVersion),
      ...(senseIndex === undefined ? {} : { senseIndex }),
      ...(context === undefined ? {} : { context }),
      fsrs,
      due: fsrs.due,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await db.cards.add(card);
    return { card, created: true };
  }

  /**
   * `settings.introduced[dayKey] += count`, read and written inside whatever
   * transaction the caller has open. Two tabs that each read the counter, add
   * their own ten and write it back lose one of the two writes; the read and
   * the write have to be the same transaction, and the *caller's* transaction
   * at that, or the card creation it is counting is not covered by it.
   */
  async function bump(dayKey: string, count: number): Promise<SettingsRow> {
    const current = await getSettings();
    if (count <= 0) return current;
    const updated: SettingsRow = {
      ...current,
      introduced: { ...current.introduced, [dayKey]: (current.introduced[dayKey] ?? 0) + count },
      updatedAt: Date.now(),
    };
    await db.settings.put(updated);
    return updated;
  }

  /**
   * The settings row, with every column the current build knows about.
   *
   * A row written by an older build is missing the columns that build did not
   * have — there is real data on a phone, and Phase 8 added four. Rather than
   * making every reader spell `?? DEFAULT`, the defaults are merged *under* the
   * stored row on the way out, so a missing column reads as its default and a
   * stored one always wins. The merged row is written back once, so the fill-in
   * happens at most once per new column rather than on every read.
   *
   * The write is best-effort: `getSettings` is also called from inside
   * transactions, and a caller that only holds a read lock must still get its
   * settings rather than an exception. `id` is pinned last so a corrupt stored
   * row cannot rename the singleton.
   */
  async function getSettings(): Promise<SettingsRow> {
    const now = Date.now();
    const existing = await db.settings.get(SETTINGS_ID);
    if (!existing) {
      const row: SettingsRow = { ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now };
      await db.settings.put(row);
      return row;
    }
    const missing = (Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]).filter(
      (key) => existing[key] === undefined,
    );
    if (missing.length === 0) return existing;
    const filled: SettingsRow = { ...DEFAULT_SETTINGS, ...existing, id: SETTINGS_ID };
    try {
      await db.settings.put(filled);
    } catch {
      // A read-only transaction: the caller still gets the complete row, and
      // the next writer persists it.
    }
    return filled;
  }

  const askCache: AskCache = {
    async get(key) {
      return db.ask_cache.get(key);
    },
    async set(key, response) {
      const row: AskCacheRow = { id: key, response, createdAt: Date.now() };
      await db.ask_cache.put(row);
      return row;
    },
  };

  return {
    async addCardFromEntry(
      entry,
      context,
      senseIndex,
      dictVersion = UNKNOWN_DICT_VERSION,
      direction = DEFAULT_CARD_DIRECTION,
    ) {
      const now = Date.now();
      // The whole read-check-write runs in one transaction, because the promise
      // this returns is what a double-tapped Add awaits twice. IndexedDB
      // serialises overlapping readwrite scopes, so the second call sees the
      // first card instead of racing it into a duplicate card and word row.
      return db.transaction(
        'rw',
        db.words,
        db.cards,
        async () => (await writeCard(entry, context, senseIndex, dictVersion, now, direction)).card,
      );
    },

    async introduceCard(entry, context, dayKey, dictVersion = UNKNOWN_DICT_VERSION) {
      const now = Date.now();
      // One transaction over the card *and* the counter. Two tabs opening Today
      // at once both draw the same ten words: without this, both see an empty
      // card table, both create, and both charge — twenty introductions for ten
      // cards, or ten charged twice. Inside the transaction the second tab finds
      // the first tab's card committed, `created` is false, and the day is not
      // charged again. Serialising these writes is IndexedDB's job and it does
      // it across tabs, which a BroadcastChannel cannot (the tabs can be in
      // different processes, and the message can arrive after the write).
      return db.transaction('rw', db.words, db.cards, db.settings, async () => {
        const { card, created } = await writeCard(entry, context, undefined, dictVersion, now);
        const settings = created ? await bump(dayKey, 1) : await getSettings();
        return { card, created, settings };
      });
    },

    async bumpIntroduced(dayKey, count) {
      return db.transaction('rw', db.settings, async () => bump(dayKey, count));
    },

    async addPhraseCard(
      tokens: PhraseToken[],
      en: string,
      context: CardContext,
      dictVersion: string = UNKNOWN_DICT_VERSION,
    ) {
      const now = Date.now();
      const snapshot: PhraseSnapshot = {
        tokens,
        simp: tokens.map((token) => token.text).join(''),
        // A token with no reading leaves a `?`, never a gap. Dropping it made
        // the back of the card a *shorter* phrase than its front — 我随便看看
        // read back as "wǒ kàn kan" — which is a reading the learner would then
        // rehearse. The ask panel refuses to add a phrase with an unverified
        // token at all; this is the layer below saying the same thing.
        pinyinMarked: tokens.map((token) => token.pinyinMarked ?? '?').join(' '),
        en,
        dictVersion,
      };
      const fsrs = newCard(now);
      const card: CardRow = {
        id: newId(),
        wordId: null,
        entryId: null,
        kind: 'phrase',
        direction: DEFAULT_CARD_DIRECTION,
        snapshot,
        context,
        fsrs,
        due: fsrs.due,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.cards.add(card);
      return card;
    },

    async listDue(now) {
      const rows = await db.cards.where('due').belowOrEqual(now).toArray();
      return rows
        .filter(alive)
        .filter((card) => card.fsrs.state !== 0)
        .sort((a, b) => a.due - b.due);
    },

    async listLearningSoon(now, horizonMs) {
      const rows = await db.cards.where('due').between(now, now + horizonMs, false, true).toArray();
      return rows
        .filter(alive)
        .filter((card) => {
          // "Learning" here is the reader's definition (§3.3) — reviewed, but
          // not yet consolidated — and not the FSRS state, which is why the
          // test is on stability rather than on `state === 1`. It was the only
          // workable reading under v1's `enable_short_term: false`, where the
          // Learning states never occurred at all; with the steps on it now
          // catches both, which is the same claim either way.
          if (card.fsrs.state === 0) return false;
          return card.fsrs.state !== 2 || card.fsrs.stability < KNOWN_STABILITY_DAYS;
        })
        .sort((a, b) => a.due - b.due);
    },

    async grade(cardId: string, rating: StoredRating, now: number = Date.now()): Promise<GradeOutcome> {
      // `settings` joins the transaction because the schedule this writes is a
      // function of it (retention, short-term steps, the learner's own
      // weights): reading the parameters outside the write would let a
      // settings change land between the read and the grade, and the review
      // row would then record a schedule no parameter set ever produced.
      return db.transaction('rw', db.cards, db.reviews, db.settings, async () => {
        const card = await db.cards.get(cardId);
        if (!card || !alive(card)) throw new Error(`grade: no card ${cardId}`);

        const settings = await getSettings();
        const before = card.fsrs;
        const { next, log } = gradeCard(before, rating, now, settings);
        const updated: CardRow = { ...card, fsrs: next, due: next.due, updatedAt: now };
        const review: ReviewRow = {
          id: newId(),
          cardId,
          rating,
          reviewedAt: now,
          before,
          log,
          createdAt: now,
        };
        await db.cards.put(updated);
        await db.reviews.add(review);
        return { card: updated, review };
      });
    },

    async newCandidates(limit) {
      const rows = await db.cards.orderBy('createdAt').toArray();
      return rows
        .filter(alive)
        .filter((card) => card.fsrs.state === 0)
        .slice(0, limit);
    },

    async markKnown(entryIds) {
      const now = Date.now();
      const unique = [...new Set(entryIds)];
      const existing = new Set(
        (await db.known_words.where('entryId').anyOf(unique).toArray()).map((row) => row.entryId),
      );
      const rows: KnownWordRow[] = unique
        .filter((entryId) => !existing.has(entryId))
        .map((entryId) => ({ id: newId(), entryId, createdAt: now }));
      if (rows.length > 0) await db.known_words.bulkAdd(rows);

      // Recognition only. "Mark known" is a *reading* judgement — it is offered
      // from the reader's token panel and the list row, where the learner is
      // saying "I can read this" — and the plain `entryId` index spans both
      // directions, so it used to push a deliberately-created meaning → hanzi
      // twin to Review with a year's stability as a side effect. Being able to
      // read a word is not being able to write it, PLAN §3.3 says nothing
      // coordinates the two schedules, and `unmarkKnown` does not undo the
      // re-dating, so there was no way back. `known_words` still gets its row:
      // the reader's "known" painting is about reading and is correct.
      const cards = (await db.cards.where('entryId').anyOf(unique).toArray())
        .filter(alive)
        .filter((card) => card.direction !== 'production');
      if (cards.length > 0) {
        await db.cards.bulkPut(
          cards.map((card) => {
            const fsrs = knownCardState(card.fsrs, now);
            return { ...card, fsrs, due: fsrs.due, updatedAt: now };
          }),
        );
      }
      return rows;
    },

    async unmarkKnown(entryIds) {
      const unique = [...new Set(entryIds)];
      if (unique.length === 0) return 0;
      // The cards `markKnown` pushed a year out are deliberately left alone:
      // the caller of this is an Add, which either just made a fresh card or
      // found one, and re-dating somebody else's card is not its business.
      return db.known_words.where('entryId').anyOf(unique).delete();
    },

    async knownEntryIds() {
      return (await db.known_words.toArray()).map((row) => row.entryId);
    },

    async allCards() {
      return (await db.cards.toArray()).filter(alive);
    },

    async cardForEntry(entryId, senseIndex, direction = DEFAULT_CARD_DIRECTION) {
      // The compound index answers this directly. `senseIndex` stays a filter
      // rather than a third index column because it is optional, and IndexedDB
      // does not index a row whose key path is missing — a card with no chosen
      // sense would drop out of the index entirely.
      return (await db.cards.where('[entryId+direction]').equals([entryId, direction]).toArray())
        .filter(alive)
        .find((card) => card.kind === 'word' && card.senseIndex === senseIndex);
    },

    async reviewsBetween(fromMs, toMs) {
      if (!(toMs > fromMs)) return [];
      // Half-open [from, to): consecutive windows tile, and the row on the
      // boundary is counted by exactly one of them.
      return db.reviews.where('reviewedAt').between(fromMs, toMs, true, false).sortBy('reviewedAt');
    },

    async allReviewsChronological() {
      // `reviewedAt` is indexed, so this is an index scan rather than a sort of
      // the whole table — the optimizer reads every row it can get.
      return db.reviews.orderBy('reviewedAt').toArray();
    },

    async cardCountsByState() {
      const counts: CardStateCounts = { new: 0, learning: 0, review: 0, relearning: 0, total: 0 };
      const rows = (await db.cards.toArray()).filter(alive);
      for (const row of rows) {
        counts.total += 1;
        // 0 New, 1 Learning, 2 Review, 3 Relearning (`FsrsStateValue`).
        if (row.fsrs.state === 0) counts.new += 1;
        else if (row.fsrs.state === 1) counts.learning += 1;
        else if (row.fsrs.state === 2) counts.review += 1;
        else counts.relearning += 1;
      }
      return counts;
    },

    async stabilityHistogram() {
      const buckets: StabilityBucket[] = STABILITY_BUCKETS.map((bucket) => ({
        ...bucket,
        count: 0,
      }));
      const rows = (await db.cards.toArray()).filter(alive);
      for (const row of rows) {
        // A New card's stability is a placeholder, not a memory; counting it
        // would put every unstudied word in the first bar.
        if (row.fsrs.state === 0) continue;
        const stability = Number.isFinite(row.fsrs.stability) ? row.fsrs.stability : 0;
        const bucket =
          buckets.find(
            (candidate) =>
              stability >= candidate.minDays &&
              (candidate.maxDays === null || stability < candidate.maxDays),
          ) ?? buckets[buckets.length - 1];
        bucket.count += 1;
      }
      return buckets;
    },

    async wordByEntryId(entryId) {
      return (await db.words.where('entryId').equals(entryId).toArray()).find(alive);
    },

    async lists() {
      return (await db.lists.toArray()).filter(alive).sort((a, b) => a.order - b.order);
    },

    async createList(input: CreateListInput) {
      const now = Date.now();
      const systemKey = systemListKey(input.kind, input.band);
      // A system list is one row per natural key, and the check has to run in
      // the same transaction as the insert: two tabs both read "not there yet"
      // otherwise, and IndexedDB is the only thing either of them shares. The
      // `&systemKey` index is the backstop underneath this — if a path ever
      // inserts without asking, the database refuses it rather than growing a
      // second "Looked up" nothing reads.
      return db.transaction('rw', db.lists, async () => {
        if (systemKey !== undefined) {
          const existing = (await db.lists.where('systemKey').equals(systemKey).toArray()).find(
            alive,
          );
          if (existing) return existing;
        }
        const row: ListRow = {
          id: newId(),
          name: input.name,
          owner: input.owner ?? 'user',
          kind: input.kind,
          ...(input.band === undefined ? {} : { band: input.band }),
          active: input.active ?? true,
          order: input.order ?? (await db.lists.count()),
          ...(systemKey === undefined ? {} : { systemKey }),
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        await db.lists.add(row);
        return row;
      });
    },

    async listMembers(listId) {
      return (await db.list_members.where('listId').equals(listId).toArray())
        .filter(alive)
        .sort((a, b) => a.order - b.order);
    },

    async addListMembers(listId, entryIds) {
      const now = Date.now();
      const current = await db.list_members.where('listId').equals(listId).toArray();
      const seen = new Set(current.filter(alive).map((row) => row.entryId));
      let order = current.length;
      const rows: ListMemberRow[] = [];
      for (const entryId of entryIds) {
        if (seen.has(entryId)) continue;
        seen.add(entryId);
        rows.push({
          id: newId(),
          listId,
          entryId,
          wordId: null,
          order: order++,
          createdAt: now,
          deletedAt: null,
        });
      }
      if (rows.length > 0) await db.list_members.bulkAdd(rows);
      return rows;
    },

    async setListActive(id, active) {
      const row = await db.lists.get(id);
      if (!row || !alive(row)) return undefined;
      const updated: ListRow = { ...row, active, updatedAt: Date.now() };
      await db.lists.put(updated);
      return updated;
    },

    async renameList(id, name) {
      const trimmed = name.trim();
      const row = await db.lists.get(id);
      if (!row || !alive(row) || trimmed === '') return undefined;
      const updated: ListRow = { ...row, name: trimmed, updatedAt: Date.now() };
      await db.lists.put(updated);
      return updated;
    },

    async deleteList(id) {
      const now = Date.now();
      // The list and its membership go together: a live member row pointing at a
      // tombstoned list is a row nothing can ever read or clean up.
      await db.transaction('rw', db.lists, db.list_members, async () => {
        const row = await db.lists.get(id);
        if (row && alive(row)) {
          // The natural key goes with the row. Deleting a system list is a
          // reset — `ensureSystemLists` makes it again on the next visit — and
          // a tombstone still holding `systemKey` would make that impossible.
          const released: ListRow = { ...row, deletedAt: now, updatedAt: now };
          delete released.systemKey;
          await db.lists.put(released);
        }
        const members = (await db.list_members.where('listId').equals(id).toArray()).filter(alive);
        if (members.length > 0) {
          await db.list_members.bulkPut(members.map((member) => ({ ...member, deletedAt: now })));
        }
      });
    },

    async removeListMembers(listId, entryIds) {
      if (entryIds.length === 0) return 0;
      const wanted = new Set(entryIds);
      const now = Date.now();
      const rows = (await db.list_members.where('listId').equals(listId).toArray())
        .filter(alive)
        .filter((row) => wanted.has(row.entryId));
      if (rows.length > 0) {
        await db.list_members.bulkPut(rows.map((row) => ({ ...row, deletedAt: now })));
      }
      return rows.length;
    },

    async saveText(input: SaveTextInput) {
      const now = Date.now();
      if (input.id) {
        const existing = await db.texts.get(input.id);
        if (existing) {
          const updated: TextRow = { ...existing, title: input.title, body: input.body, updatedAt: now };
          await db.texts.put(updated);
          return updated;
        }
      }
      const row: TextRow = {
        id: input.id ?? newId(),
        title: input.title,
        body: input.body,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.texts.add(row);
      return row;
    },

    async texts() {
      return (await db.texts.toArray()).filter(alive).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    getSettings,

    async setSettings(patch) {
      const current = await getSettings();
      const updated: SettingsRow = { ...current, ...patch, id: SETTINGS_ID, updatedAt: Date.now() };
      await db.settings.put(updated);
      return updated;
    },

    askCache,

    async resetAll() {
      await db.transaction('rw', db.tables, async () => {
        await Promise.all(db.tables.map((table) => table.clear()));
      });
    },
  };
}
