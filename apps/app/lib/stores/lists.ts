'use client';

/**
 * Lists store (PLAN.md §4 P3).
 *
 * Holds the eight system lists plus the learner's own, their counts, and the
 * settings row the queue reads. The repository is imported lazily inside the
 * actions, so importing this module never opens IndexedDB.
 *
 * HSK membership is materialised in the background, band by band: a list is
 * 5,622 `entryId` strings at worst, and the alternative — inserting the whole
 * dictionary as `words` rows up front — is the thing §3.3 forbids.
 */

import { create } from 'zustand';

import type { CardRow, ListRow, SettingsRow } from '@/lib/db/schema';
import type { Repository } from '@/lib/db/repository';
import { getEntrySource } from '@/lib/lists/entry-source';
import { ensureMembers, markListKnown } from '@/lib/lists/members';
import { ensureSystemLists } from '@/lib/lists/system-lists';
import { preferRecognition } from '@/lib/srs/direction';
import { wordState } from '@/lib/srs/states';
import type { EntryId } from '@/lib/types';

export interface ListView {
  list: ListRow;
  /** Members known to the database. Zero until the list is materialised. */
  count: number;
  knownCount: number;
}

export interface ListsState {
  lists: ListRow[];
  views: ListView[];
  settings?: SettingsRow;
  loading: boolean;
  /** Lists with an action in flight, by id. */
  busy: Record<string, boolean>;
  /** True while HSK membership is still being filled in. */
  filling: boolean;
  error?: string;
  load: () => Promise<void>;
  setActive: (id: string, active: boolean) => Promise<void>;
  updateSettings: (patch: Partial<Omit<SettingsRow, 'id' | 'createdAt'>>) => Promise<void>;
  markAllKnown: (id: string) => Promise<void>;
  createCustomList: (name: string) => Promise<ListRow | undefined>;
  addWords: (listId: string, entryIds: EntryId[]) => Promise<void>;
  /** Fill in every HSK list that has no members yet, oldest band first. */
  fillMembers: () => Promise<void>;
}

async function repository(): Promise<Repository> {
  const { getRepository } = await import('@/lib/db/get-db');
  return getRepository();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The counts on the index, read the way the detail page reads its badges: the
 * same `wordState` over the same three inputs (a `known_words` row, the card,
 * the band). Counting `known_words` alone made "7 words · 1 known" sit next to
 * a detail page showing three "known" badges — the number and the badges have
 * to come from one rule or one of them is wrong.
 *
 * An HSK list's members are all of that list's band, which is where `hskBand`
 * comes from without a dictionary round trip. A custom or "Looked up" list has
 * no single band, so its rows fall back to the card and `known_words` alone —
 * the detail page can see each entry's real band and this cannot, so a custom
 * list holding HSK-1 words is the one case where the two still differ.
 */
async function readViews(repo: Repository): Promise<{ lists: ListRow[]; views: ListView[] }> {
  const lists = await ensureSystemLists(repo);
  const [known, settings, cards] = await Promise.all([
    repo.knownEntryIds(),
    repo.getSettings(),
    repo.allCards(),
  ]);
  const knownIds = new Set(known);
  // One word, up to two cards since Phase 8 (one per direction). The count is
  // about the word, so the recognition card answers for it (`preferRecognition`).
  const cardByEntry = new Map<string, CardRow>();
  for (const card of cards) {
    if (!card.entryId) continue;
    cardByEntry.set(card.entryId, preferRecognition(cardByEntry.get(card.entryId), card));
  }

  const views: ListView[] = [];
  for (const list of lists) {
    const members = await repo.listMembers(list.id);
    views.push({
      list,
      count: members.length,
      knownCount: members.filter(
        (row) =>
          wordState({
            card: cardByEntry.get(row.entryId)?.fsrs ?? null,
            known: knownIds.has(row.entryId),
            ...(list.band === undefined ? {} : { hskBand: list.band }),
            knownBand: settings.knownBand,
          }) === 'known',
      ).length,
    });
  }
  return { lists, views };
}

export const useListsStore = create<ListsState>((set, get) => ({
  lists: [],
  views: [],
  settings: undefined,
  loading: false,
  busy: {},
  filling: false,
  error: undefined,

  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const repo = await repository();
      const [{ lists, views }, settings] = await Promise.all([readViews(repo), repo.getSettings()]);
      set({ lists, views, settings, loading: false });
    } catch (error) {
      set({ loading: false, error: message(error) });
    }
  },

  setActive: async (id, active) => {
    // Optimistic: the checkbox is controlled, and a round trip through Dexie
    // plus a full re-read would leave it visibly stuck on its old value.
    set((state) => ({
      lists: state.lists.map((row) => (row.id === id ? { ...row, active } : row)),
      views: state.views.map((view) =>
        view.list.id === id ? { ...view, list: { ...view.list, active } } : view,
      ),
    }));
    const repo = await repository();
    await repo.setListActive(id, active);
    await get().load();
  },

  updateSettings: async (patch) => {
    const repo = await repository();
    const settings = await repo.setSettings(patch);
    set({ settings });
  },

  markAllKnown: async (id) => {
    const list = get().lists.find((row) => row.id === id);
    if (!list) return;
    set((state) => ({ busy: { ...state.busy, [id]: true }, error: undefined }));
    try {
      const repo = await repository();
      await markListKnown(repo, list, getEntrySource());
      await get().load();
    } catch (error) {
      set({ error: message(error) });
    } finally {
      set((state) => ({ busy: { ...state.busy, [id]: false } }));
    }
  },

  createCustomList: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) return undefined;
    const repo = await repository();
    const lists = await repo.lists();
    const row = await repo.createList({
      name: trimmed,
      owner: 'user',
      kind: 'custom',
      active: true,
      order: lists.length,
    });
    await get().load();
    return row;
  },

  addWords: async (listId, entryIds) => {
    const repo = await repository();
    await repo.addListMembers(listId, entryIds);
    await get().load();
  },

  fillMembers: async () => {
    if (get().filling) return;
    set({ filling: true });
    try {
      const repo = await repository();
      const source = getEntrySource();
      // One band at a time: seven parallel fetches of an HSK band is several
      // megabytes at once, and the counts are more useful appearing in order.
      for (const list of get().lists.filter((row) => row.kind === 'hsk')) {
        if ((get().views.find((view) => view.list.id === list.id)?.count ?? 0) > 0) continue;
        await ensureMembers(repo, list, source);
        const { lists, views } = await readViews(repo);
        set({ lists, views });
      }
    } catch (error) {
      set({ error: message(error) });
    } finally {
      set({ filling: false });
    }
  },
}));
