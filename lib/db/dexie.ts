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
  DEFAULT_SETTINGS,
  SETTINGS_ID,
  STORES_V1,
  type AskCacheRow,
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
  CreateListInput,
  GradeOutcome,
  Repository,
  SaveTextInput,
} from '@/lib/db/repository';
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
    this.version(DB_VERSION).stores(STORES_V1);
  }
}

const alive = <T extends { deletedAt: number | null }>(row: T): boolean => row.deletedAt === null;

/** The three sources that mean "the learner chose this word" (§3.3). */
const EXPLICIT_SOURCES = new Set<CardContext['source']>(['lookup', 'ask', 'reader']);

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

  async function getSettings(): Promise<SettingsRow> {
    const existing = await db.settings.get(SETTINGS_ID);
    if (existing) return existing;
    const now = Date.now();
    const row: SettingsRow = { ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now };
    await db.settings.put(row);
    return row;
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
    async addCardFromEntry(entry, context, senseIndex, dictVersion = UNKNOWN_DICT_VERSION) {
      const now = Date.now();
      // The whole read-check-write runs in one transaction, because the promise
      // this returns is what a double-tapped Add awaits twice. IndexedDB
      // serialises overlapping readwrite scopes, so the second call sees the
      // first card instead of racing it into a duplicate card and word row.
      return db.transaction('rw', db.words, db.cards, async () => {
        const existing = (await db.cards.where('entryId').equals(entry.id).toArray())
          .filter(alive)
          .find((card) => card.kind === 'word' && card.senseIndex === senseIndex);
        if (existing) {
          // Idempotent per (entryId, senseIndex) — but not silent: an Add that
          // brings provenance the stored card has not got writes it on.
          const merged = mergeCardContext(existing.context, context);
          if (!merged) return existing;
          const updated: CardRow = { ...existing, context: merged, updatedAt: now };
          await db.cards.put(updated);
          return updated;
        }

        const word = await ensureWord(entry, dictVersion, now);
        const fsrs = newCard(now);
        const card: CardRow = {
          id: newId(),
          wordId: word.id,
          entryId: entry.id,
          kind: 'word',
          direction: 'recognition',
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
        return card;
      });
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
        direction: 'recognition',
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
          // With enable_short_term:false the Learning and Relearning states never
          // occur — every grade lands in Review. So "learning" here is the reader's
          // definition (§3.3): reviewed, but not yet consolidated.
          if (card.fsrs.state === 0) return false;
          return card.fsrs.state !== 2 || card.fsrs.stability < KNOWN_STABILITY_DAYS;
        })
        .sort((a, b) => a.due - b.due);
    },

    async grade(cardId: string, rating: StoredRating, now: number = Date.now()): Promise<GradeOutcome> {
      return db.transaction('rw', db.cards, db.reviews, async () => {
        const card = await db.cards.get(cardId);
        if (!card || !alive(card)) throw new Error(`grade: no card ${cardId}`);

        const before = card.fsrs;
        const { next, log } = gradeCard(before, rating, now);
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

      const cards = (await db.cards.where('entryId').anyOf(unique).toArray()).filter(alive);
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

    async cardForEntry(entryId, senseIndex) {
      return (await db.cards.where('entryId').equals(entryId).toArray())
        .filter(alive)
        .find((card) => card.kind === 'word' && card.senseIndex === senseIndex);
    },

    async wordByEntryId(entryId) {
      return (await db.words.where('entryId').equals(entryId).toArray()).find(alive);
    },

    async lists() {
      return (await db.lists.toArray()).filter(alive).sort((a, b) => a.order - b.order);
    },

    async createList(input: CreateListInput) {
      const now = Date.now();
      const row: ListRow = {
        id: newId(),
        name: input.name,
        owner: input.owner ?? 'user',
        kind: input.kind,
        ...(input.band === undefined ? {} : { band: input.band }),
        active: input.active ?? true,
        order: input.order ?? (await db.lists.count()),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await db.lists.add(row);
      return row;
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
        if (row && alive(row)) await db.lists.put({ ...row, deletedAt: now, updatedAt: now });
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
