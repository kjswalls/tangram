/**
 * Where the lists layer gets dictionary rows (PLAN.md §3.2, §4 P3).
 *
 * The dictionary lives on the server behind `/api/dict/*`; the lists, the queue
 * and the demo seed live in the browser next to IndexedDB. This interface is the
 * one seam between them, so every one of those can be unit-tested against a
 * handful of entries instead of a 35 MB file.
 */

import { fetchEntries, fetchHskBand } from '@/lib/dict/client';
import { normalizePinyin } from '@/lib/dict/pinyin';
import type { Entry, EntryId, HskBand } from '@/lib/types';

export interface EntrySource {
  /** One HSK band, frequency-ordered — the order the spine introduces it in. */
  band(band: HskBand): Promise<Entry[]>;
  /** Entries by id, in the order asked for. Unknown ids are simply absent. */
  entries(ids: readonly EntryId[]): Promise<Entry[]>;
  /** Headword search for "add a word to this list". */
  search(query: string, limit?: number): Promise<Entry[]>;
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

  const band: EntrySource['band'] = (value) => {
    const cached = bands.get(value);
    if (cached) return cached;
    const pending = fetchHskBand(value, options).catch((error: unknown) => {
      // A failed fetch must not poison the cache: the next visit should retry.
      bands.delete(value);
      throw error;
    });
    bands.set(value, pending);
    return pending;
  };

  return {
    band,

    async entries(ids) {
      const out: Entry[] = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        out.push(...(await fetchEntries(ids.slice(i, i + ID_CHUNK), options)));
      }
      return out;
    },

    /**
     * P1 owns `/api/dict/search`; until it lands this walks the HSK bands, which
     * is every word a list is plausibly built from and nothing like the whole
     * dictionary. TODO(merge): call `/api/dict/search?q=` once P1 has landed and
     * keep this as the offline fallback.
     */
    async search(query, limit = SEARCH_LIMIT) {
      const viaRoute = await searchRoute(query, limit, options);
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

/** `null` when the route is not there yet (P1), so the caller can fall back. */
async function searchRoute(
  query: string,
  limit: number,
  options: HttpEntrySourceOptions,
): Promise<Entry[] | null> {
  try {
    const response = await fetch(
      `${options.baseUrl ?? ''}/api/dict/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const entries = readEntries(body);
    return entries ? entries.slice(0, limit) : null;
  } catch {
    return null;
  }
}

/**
 * P1's response body is not written yet, so accept the two shapes it can
 * reasonably have and treat anything else as "route not ready".
 */
function readEntries(body: unknown): Entry[] | null {
  if (Array.isArray(body)) return body as Entry[];
  if (body && typeof body === 'object') {
    const record = body as { entries?: unknown; results?: unknown };
    if (Array.isArray(record.entries)) return record.entries as Entry[];
    if (Array.isArray(record.results)) return record.results as Entry[];
  }
  return null;
}

let shared: EntrySource | undefined;

/** The browser's one source. Tests pass their own instead. */
export function getEntrySource(): EntrySource {
  return (shared ??= createHttpEntrySource());
}
