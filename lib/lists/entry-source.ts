/**
 * Where the lists layer gets dictionary rows (PLAN.md §3.2, §4 P3).
 *
 * The dictionary lives on the server behind `/api/dict/*`; the lists, the queue
 * and the demo seed live in the browser next to IndexedDB. This interface is the
 * one seam between them, so every one of those can be unit-tested against a
 * handful of entries instead of a 35 MB file.
 */

import { fetchEntriesResponse, fetchHskResponse, fetchSearch } from '@/lib/dict/client';
import { normalizePinyin } from '@/lib/dict/pinyin';
import type { Entry, EntryId, HskBand } from '@/lib/types';

export interface EntrySource {
  /** One HSK band, frequency-ordered — the order the spine introduces it in. */
  band(band: HskBand): Promise<Entry[]>;
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
  /** Origin to prefix. Empty in the browser, set it on the server or in a test. */
  baseUrl?: string;
}

/**
 * The real source. Band responses are memoised per instance: the spine draw, the
 * lists page and the seed all want band 3, and it is the same 1 MB either way.
 */
export function createHttpEntrySource(options: HttpEntrySourceOptions = {}): EntrySource {
  const bands = new Map<HskBand, Promise<Entry[]>>();
  // Every entry-bearing route reports it and they all read the same file, so the
  // last answer is the current one.
  let version: string | undefined;

  const band: EntrySource['band'] = (value) => {
    const cached = bands.get(value);
    if (cached) return cached;
    const pending = fetchHskResponse(value, options)
      .then((body) => {
        version = body.meta.version || version;
        return body.entries;
      })
      .catch((error: unknown) => {
        // A failed fetch must not poison the cache: the next visit should retry.
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
        const body = await fetchEntriesResponse(ids.slice(i, i + ID_CHUNK), options);
        version = body.meta.version || version;
        out.push(...body.entries);
      }
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
      const viaRoute = await searchRoute(query, limit, options, (seen) => {
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
 * `null` when the route could not answer (a 503 with no `data/` build, a network
 * failure), so the caller falls back to scanning the bands.
 *
 * The route answers in *groups* — one per headword, carrying every reading — and
 * a list holds entries, so the groups are flattened in display order. Each
 * group already lists the readings that matched first, so the flattening keeps
 * P1's ranking rather than inventing one.
 */
async function searchRoute(
  query: string,
  limit: number,
  options: HttpEntrySourceOptions,
  noteVersion: (version: string) => void,
): Promise<Entry[] | null> {
  try {
    const result = await fetchSearch(query, { baseUrl: options.baseUrl, limit });
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
