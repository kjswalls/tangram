/**
 * Shared fixtures for the lists/queue/seed tests: a private database per test,
 * and an `EntrySource` backed by the real generated dictionary so the draw and
 * the seed are exercised against the data they will actually see.
 */
import { createDexieRepository, TangramDb } from '@/lib/db/dexie';
import type { Repository } from '@/lib/db/repository';
import { getDictIndex, getEntries, hskBand } from '@/lib/dict/index';
import type { EntrySource } from '@/lib/lists/entry-source';
import { scoreEntry } from '@/lib/lists/entry-source';
import type { Entry, EntryId, HskBand } from '@/lib/types';

let counter = 0;

export function freshRepository(): { db: TangramDb; repo: Repository } {
  const db = new TangramDb(`tangram-lists-${Date.now()}-${counter++}`);
  return { db, repo: createDexieRepository(db) };
}

/** The routes' behaviour without the HTTP hop: same rows, same order. */
export function dictEntrySource(): EntrySource & { bandCalls: HskBand[] } {
  const bandCalls: HskBand[] = [];
  return {
    bandCalls,
    async band(band) {
      bandCalls.push(band);
      return hskBand(band);
    },
    async entries(ids) {
      return getEntries(ids);
    },
    /** The routes report `meta.version`, so the seed and the draw can record it. */
    dictVersion() {
      return getDictIndex().meta.version;
    },
    async search(query, limit = 20) {
      const scored: { entry: Entry; score: number }[] = [];
      for (const value of [1, 2, 3, 4, 5, 6, 7] as HskBand[]) {
        for (const entry of hskBand(value)) {
          const score = scoreEntry(entry, query);
          if (score !== undefined) scored.push({ entry, score });
        }
      }
      return scored
        .sort((a, b) => a.score - b.score)
        .slice(0, limit)
        .map((row) => row.entry);
    },
  };
}

/** A hand-built source, for the ordering tests that must not depend on the data. */
export function fakeEntrySource(bands: Partial<Record<HskBand, Entry[]>>): EntrySource {
  const byId = new Map<EntryId, Entry>();
  for (const entries of Object.values(bands)) for (const entry of entries ?? []) byId.set(entry.id, entry);
  return {
    async band(band) {
      return bands[band] ?? [];
    },
    async entries(ids) {
      return ids.flatMap((id) => {
        const entry = byId.get(id);
        return entry ? [entry] : [];
      });
    },
    async search() {
      return [];
    },
  };
}

let made = 0;

export function entry(overrides: Partial<Entry> = {}): Entry {
  made += 1;
  const simp = overrides.simp ?? `词${made}`;
  return {
    id: overrides.id ?? `${simp}|${simp}[ci2 ${made}]`,
    simp,
    trad: simp,
    pinyinNum: 'ci2',
    pinyinMarked: 'cí',
    glosses: ['a test word'],
    classifiers: [],
    properNoun: false,
    isVariant: false,
    surname: false,
    ...overrides,
  };
}
