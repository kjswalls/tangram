/**
 * Row shapes and the entry queries (docs/plans/data.md D2).
 *
 * Two projections, deliberately. `RANK_COLUMNS` is the eight fields
 * `lib/dict/rank.ts` needs to rank a candidate, and a search reads them for up
 * to 5,000 rows per keystroke; `ENTRY_COLUMNS` is the whole row — both pinyin
 * forms, the glosses, the classifiers — and a search reads those only for the
 * ≤50 groups a page actually shows. On the Capacitor bridge every column of
 * every row is serialised through JSON, so the difference is the difference
 * between a keystroke that feels instant and one that does not.
 */
import type { SqlQuery, SqlValue } from '../sql';
import type { RankFacts } from '../rank';
import type { DictEntry, EntryId, HskBand } from '../types';

export type SqlRow = Record<string, SqlValue>;

export const ENTRY_COLUMNS =
  'rowid, id, simp, trad, pinyin_num, pinyin_marked, glosses, classifiers, ' +
  'proper_noun, is_variant, surname, variant_of, pos, hsk_band, freq_rank, freq';

export const RANK_COLUMNS = 'rowid, id, simp, trad, is_variant, proper_noun, hsk_band, freq_rank';

function text(value: SqlValue): string {
  if (typeof value !== 'string') throw new TypeError(`expected TEXT, got ${typeof value}`);
  return value;
}

function int(value: SqlValue): number {
  if (typeof value !== 'number') throw new TypeError(`expected INTEGER, got ${typeof value}`);
  return value;
}

/**
 * A row → an `Entry`, exactly as `data/dict.json` has it.
 *
 * The one trap is `classifiers`: it is `string[]` and never optional
 * (`lib/types.ts`), so a NULL column rebuilds as `[]` and not `undefined`. Every
 * other nullable column is an *absent* property, because that is what the JSON
 * has and `scripts/verify-data.ts` deep-equals all 124,188 rows against it.
 */
export function rowToEntry(row: SqlRow): DictEntry {
  const { classifiers, variant_of: variantOf, pos, hsk_band: band } = row;
  const { freq_rank: freqRank, freq } = row;
  return {
    id: text(row.id),
    simp: text(row.simp),
    trad: text(row.trad),
    pinyinNum: text(row.pinyin_num),
    pinyinMarked: text(row.pinyin_marked),
    glosses: JSON.parse(text(row.glosses)) as string[],
    classifiers: classifiers === null ? [] : (JSON.parse(text(classifiers)) as string[]),
    properNoun: int(row.proper_noun) === 1,
    isVariant: int(row.is_variant) === 1,
    surname: int(row.surname) === 1,
    ...(variantOf === null ? {} : { variantOf: text(variantOf) }),
    ...(pos === null ? {} : { pos: text(pos) }),
    ...(band === null ? {} : { hskBand: int(band) as HskBand }),
    ...(freqRank === null ? {} : { freqRank: int(freqRank) }),
    ...(freq === null ? {} : { freq: int(freq) }),
  };
}

/** A `RANK_COLUMNS` row → what ranking needs. */
export function rowToRank(row: SqlRow): RankFacts {
  const { hsk_band: band, freq_rank: freqRank } = row;
  return {
    id: text(row.id),
    simp: text(row.simp),
    trad: text(row.trad),
    isVariant: int(row.is_variant) === 1,
    properNoun: int(row.proper_noun) === 1,
    ...(band === null ? {} : { hskBand: int(band) }),
    ...(freqRank === null ? {} : { freqRank: int(freqRank) }),
  };
}

/** `?, ?, ?` for an `IN (…)` list. */
export function holes(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/**
 * How many values one statement may bind.
 *
 * SQLite's `SQLITE_MAX_VARIABLE_NUMBER` is a **compile-time option**, and the
 * three runtimes this store must run on are three different builds: Node's
 * bundled SQLite measures 32,766 here, the default was **999** before SQLite
 * 3.32, and neither `@sqlite.org/sqlite-wasm` nor the SQLCipher pod behind
 * `@capacitor-community/sqlite` has been checked. So every unbounded `IN (…)`
 * is chunked at a number that is under the oldest default, and the chunks go in
 * the same batch — **a batch is the round trip**, so this costs nothing the
 * round-trip budget is protecting.
 *
 * This is not hypothetical. `candidateSubstrings` returns every distinct
 * ≤16-character substring of every hanzi run, so a 2,100-hanzi passage produces
 * ~32,800 of them and `store.segment()` threw a raw `too many SQL variables`
 * where the JSON segmenter it replaces handled 20,000 characters — the limit
 * the deleted segment route documented, for the reader D6 re-points at the
 * store.
 */
export const MAX_BOUND_PARAMS = 900;

/** Split a list so no statement binds more than `size` values. */
export function chunked<T>(items: readonly T[], size: number = MAX_BOUND_PARAMS): T[][] {
  if (items.length <= size) return items.length > 0 ? [[...items]] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Entries for a set of ids, as one statement per chunk. The caller restores the
 * order it asked for, so the chunk boundaries are invisible above this layer.
 */
export function entriesByIds(ids: readonly EntryId[]): SqlQuery[] {
  return chunked(ids).map((batch) => ({
    sql: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE id IN (${holes(batch.length)})`,
    params: batch,
  }));
}

/** Entries at a set of rowids, in rowid order — the `char_words` second step. */
export function entriesByRowids(rowids: readonly number[]): SqlQuery[] {
  return chunked(rowids).map((batch) => ({
    sql: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE rowid IN (${holes(batch.length)}) ORDER BY rowid`,
    params: batch,
  }));
}

/**
 * Every reading of a set of simplified headwords, in frequency order.
 *
 * Keyed on `simp` because that is how `buildGroup` has always found a
 * headword's other readings; the caller filters on `trad`, since 干 splits into
 * three traditional headwords that share one simplified form.
 */
export function readingsOfHeadwords(simps: readonly string[]): SqlQuery[] {
  return chunked(simps).map((batch) => ({
    sql: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE simp IN (${holes(batch.length)}) ORDER BY rowid`,
    params: batch,
  }));
}

/** How many *readings* a simplified headword has — the polyphone warning. */
export function readingsForCount(simp: string): SqlQuery {
  return { sql: 'SELECT pinyin_num FROM entries WHERE simp = ?', params: [simp] };
}
