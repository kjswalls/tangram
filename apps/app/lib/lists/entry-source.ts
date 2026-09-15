/**
 * Where the lists layer gets dictionary rows (PLAN.md §3.2, §4 P3).
 *
 * The dictionary lives on the server behind `/api/dict/*`; the lists, the queue
 * and the demo seed live in the browser next to IndexedDB. This interface is the
 * one seam between them, so every one of those can be unit-tested against a
 * handful of entries instead of a 35 MB file.
 */

import { getDictStore } from '@/lib/dict/browser-store';
import { normalizePinyin } from '@/lib/dict/pinyin';
import type { DictStore } from '@/lib/dict/store';
import type { Entry, EntryId, HskBand } from '@/lib/types';

/**
 * How many entries one band request asks for (core.md C4a).
 *
 * `DictStore.hskBand` gained `limit`/`offset` because the call crosses a bridge
 * now rather than a socket, and band 7 is 5,638 entries — not a thing to
 * serialise whole over a Capacitor JSON round trip. The spine builder is the
 * caller that pages, and 250 is chosen against what it actually needs: it takes
 * at most `settings.newPerDay` entries (default 10), and it discards the ones
 * that fail `spineEligible` or that sit at or below `knownBand`, which in the
 * worst observed case is most of a window. 250 is ~25× the headroom the first
 * window needs and still an order of magnitude below a whole band; when it is
 * not enough, `draw.ts` asks for the next window rather than guessing bigger.
 *
 * Written down because it is the first number a low-end device will feel: too
 * small and the draw makes five bridge trips before it has a queue, too large
 * and the first one blocks.
 */
export const BAND_PAGE = 250;

export interface BandOptions {
  limit?: number;
  offset?: number;
}

export interface EntrySource {
  /**
   * One HSK band, frequency-ordered — the order the spine introduces it in.
   * With no options it is the whole band, which is what the reader index and
   * the demo seed want; the spine passes a window.
   */
  band(band: HskBand, options?: BandOptions): Promise<Entry[]>;
  /** Entries by id, in the order asked for. Unknown ids are simply absent. */
  entries(ids: readonly EntryId[]): Promise<Entry[]>;
  /** Headword search for "add a word to this list". */
  search(query: string, limit?: number): Promise<Entry[]>;
  /**
   * `meta.version` of the snapshot the rows above came from, once anything has
   * been fetched — what a card records as its `dictVersion`. Optional so a test
   * fake need not implement it; a card made from a source that cannot say falls
   * back to the repository's `'unknown'`.
   */
  dictVersion?(): string | undefined;
}

/** `/api/dict/entries` refuses more than 200 ids in one request. */
const ID_CHUNK = 200;

export const SEARCH_LIMIT = 20;

const CJK = /[㐀-鿿豈-﫿]/;

/**
 * Ranking for the fallback search below. Lower is better; `undefined` drops the
 * entry. Mirrors the shape of §3.2's ranking (exact > prefix, real words before
 * variants and proper nouns) without pretending to be it.
 */
export function scoreEntry(entry: Entry, query: string): number | undefined {
  const q = query.trim();
  if (!q) return undefined;
  const penalty = (entry.isVariant ? 2 : 0) + (entry.properNoun ? 1 : 0);

  if (CJK.test(q)) {
    if (entry.simp === q || entry.trad === q) return 0 + penalty;
    if (entry.simp.startsWith(q) || entry.trad.startsWith(q)) return 4 + penalty;
    return undefined;
  }

  const lower = q.toLowerCase();
  const pinyin = normalizePinyin(q);
  if (pinyin.fullyParsed) {
    const entryPinyin = normalizePinyin(entry.pinyinNum);
    if (entryPinyin.toned === pinyin.toned) return 8 + penalty;
    if (entryPinyin.toneless === pinyin.toneless) return 10 + penalty;
    if (entryPinyin.toneless.startsWith(pinyin.toneless)) return 12 + penalty;
  }

  const glosses = entry.glosses.map((gloss) => gloss.toLowerCase());
  if (glosses.some((gloss) => gloss === lower || gloss === `to ${lower}`)) return 14 + penalty;
  if (glosses.some((gloss) => new RegExp(`\\b${escapeRegExp(lower)}\\b`).test(gloss))) {
    return 16 + penalty;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface HttpEntrySourceOptions {
  /** The store to read through. Defaults to the browser's one. */
  store?: DictStore;
}

/**
 * The real source, over `DictStore` (core.md C4a).
 *
 * Whole-band responses are memoised per instance: the reader index, the lists
 * page and the seed all want band 3, and it is the same rows either way. A
 * **paged** request is not memoised — it is a window into a band the caller is
 * walking, and caching windows would mean caching the band one slice at a time
 * under a different key for no gain.
 */
export function createHttpEntrySource(options: HttpEntrySourceOptions = {}): EntrySource {
  const bands = new Map<HskBand, Promise<Entry[]>>();
  // Every entry-bearing route reports it and they all read the same file, so the
  // last answer is the current one.
  let version: string | undefined;

  const store = () => options.store ?? getDictStore();

  const noteVersion = () => {
    const status = store().status;
    if (status.state === 'ready') version = status.version || version;
  };

  const band: EntrySource['band'] = (value, page) => {
    if (page?.limit !== undefined || page?.offset !== undefined) {
      return store()
        .hskBand(value, page)
        .then((entries) => {
          noteVersion();
          return entries;
        });
    }
    const cached = bands.get(value);
    if (cached) return cached;
    const pending = store()
      .hskBand(value)
      .then((entries) => {
        noteVersion();
        return entries;
      })
      .catch((error: unknown) => {
        // A failed read must not poison the cache: the next visit should retry.
        bands.delete(value);
        throw error;
      });
    bands.set(value, pending);
    return pending;
  };

  return {
    band,

    dictVersion: () => version,

    async entries(ids) {
      const out: Entry[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        out.push(...(await store().entries(ids.slice(i, i + ID_CHUNK))));
      }
      noteVersion();
      return out;
    },

    /**
     * `/api/dict/search` is P1's router and ranker — the same one `/lookup` uses —
     * so "add a word to this list" and the lookup box agree on what a query means.
     * The HSK-band scan below stays as the fallback for the case the route cannot
     * answer (no `data/` build, a 503): 11k words is every word a list is
     * plausibly built from, and it is better than an empty box.
     */
    async search(query, limit = SEARCH_LIMIT) {
      const viaRoute = await searchRoute(query, limit, store(), (seen) => {
        version = seen || version;
      });
      if (viaRoute) return viaRoute;

      const scored: { entry: Entry; score: number }[] = [];
      for (const value of [1, 2, 3, 4, 5, 6, 7] as HskBand[]) {
        for (const entry of await band(value)) {
          const score = scoreEntry(entry, query);
          if (score !== undefined) scored.push({ entry, score });
        }
        // An exact hit in an early band is the answer; do not pull 5,622 more
        // rows over the wire to confirm it.
        if (scored.some((row) => row.score <= 1)) break;
        if (scored.filter((row) => row.score <= 4).length >= limit) break;
      }
      return scored
        .sort((a, b) => a.score - b.score || (a.entry.freqRank ?? 1e9) - (b.entry.freqRank ?? 1e9))
        .slice(0, limit)
        .map((row) => row.entry);
    },
  };
}

/**
 * `null` when the store could not answer (no dictionary on device, a network
 * failure), so the caller falls back to scanning the bands.
 *
 * The store answers in *groups* — one per headword, carrying every reading — and
 * a list holds entries, so the groups are flattened in display order. Each
 * group already lists the readings that matched first, so the flattening keeps
 * P1's ranking rather than inventing one.
 */
async function searchRoute(
  query: string,
  limit: number,
  store: DictStore,
  noteVersion: (version: string) => void,
): Promise<Entry[] | null> {
  try {
    const result = await store.search(query, { limit });
    if (result.dictVersion) noteVersion(result.dictVersion);
    // An empty answer is still an answer: the router looked and there is nothing
    // there, so do not pull 11k rows over the wire to confirm a typo.
    return result.groups.flatMap((group) => group.entries).slice(0, limit);
  } catch {
    return null;
  }
}

let shared: EntrySource | undefined;

/** The browser's one source. Tests pass their own instead. */
export function getEntrySource(): EntrySource {
  return (shared ??= createHttpEntrySource());
}
