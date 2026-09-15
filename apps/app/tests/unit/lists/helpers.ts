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

/**
 * The store's behaviour without the bridge: same rows, same order — **and the
 * same paging**.
 *
 * Honouring `limit`/`offset` is not politeness, it is the point: `draw.ts`
 * walks a band a window at a time (core.md C4a) and stops when a page comes
 * back short. A fake that ignored the window handed back the whole band every
 * time, the page was never short, `offset` grew for ever and the unit suite
 * hung. `bandPages` records what was actually asked for, so a test can assert
 * the draw pages rather than pulling 5,638 rows to take ten.
 */
export function dictEntrySource(): EntrySource & {
  bandCalls: HskBand[];
  bandPages: { band: HskBand; limit?: number; offset?: number }[];
} {
  const bandCalls: HskBand[] = [];
  const bandPages: { band: HskBand; limit?: number; offset?: number }[] = [];
  return {
    bandCalls,
    bandPages,
    async band(band, page) {
      bandCalls.push(band);
      bandPages.push({ band, ...(page ?? {}) });
      const all = hskBand(band);
      if (page?.limit === undefined && page?.offset === undefined) return all;
      const offset = page.offset ?? 0;
      return page.limit === undefined ? all.slice(offset) : all.slice(offset, offset + page.limit);
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
    async band(band, page) {
      const all = bands[band] ?? [];
      if (page?.limit === undefined && page?.offset === undefined) return all;
      const offset = page.offset ?? 0;
      return page.limit === undefined ? all.slice(offset) : all.slice(offset, offset + page.limit);
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
