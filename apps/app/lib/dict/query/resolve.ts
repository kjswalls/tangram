/**
 * The list importer's bulk lookups (`wave-zero.md` §8a, §8b).
 *
 * Three statements answer a whole paste: the hanzi words against both scripts,
 * the toned reading keys, and the toneless ones. They ride in **one** batch, so
 * a 300-line paste is one round trip rather than 300 — which is the reason
 * `DictStore.resolve` is bulk at all (§8b, "Why bulk").
 *
 * Every one of them is an **exact** match. `search`'s prefix scans are
 * deliberately absent: a learner typing wants 打 to suggest 打算, and a list
 * that says 打 means 打 (§8b, rule 1).
 */
import { ENTRY_COLUMNS, MAX_BOUND_PARAMS, chunked, holes } from './entries';
import type { SqlQuery } from '../sql';

/**
 * The whole row plus the two derived reading keys.
 *
 * The keys are on the projection rather than recomputed from `pinyin_num` in
 * TypeScript, because the pinyin path has to know *which* key a row came back
 * under: a word that carries tones prefers its tone-exact matches and falls
 * back to the toneless ones, and both sets arrive in the same batch. Deriving
 * the key a second time would work — `readingKeys()` is what wrote it at build
 * time — but it would be a second implementation of the stored value, and
 * `rowToEntry` ignores the extra columns anyway.
 */
export const RESOLVE_PINYIN_COLUMNS = `${ENTRY_COLUMNS}, py_toned, py_toneless`;

/**
 * Half the bind budget, because the hanzi statement binds its list **twice**.
 *
 * `WHERE simp IN (…) OR trad IN (…)` is one list asked about under two columns.
 * SQLite's `?NNN` would let the same parameters be referenced twice — and
 * `hanziExact` already uses `?1` that way — but the reuse is only proven here
 * for a single value, and this is the statement that binds nine hundred of
 * them across three SQLite builds nobody has checked (`MAX_BOUND_PARAMS`).
 * Binding twice at half the chunk size costs one extra statement per 900 words
 * and needs nothing proven.
 */
export const RESOLVE_HANZI_CHUNK = Math.floor(MAX_BOUND_PARAMS / 2);

/**
 * Exact headwords in either script, most frequent first.
 *
 * `ORDER BY rowid` *is* frequency order (`data.md` D1 assigned the rowids from
 * `compareEntries`), which is what lets the caller drop `abe6793`'s hand-written
 * comparator: the join across the two scripts comes back already ordered, and
 * `byRowid` puts the chunks back together. That matters because the first
 * candidate is what the picker defaults to.
 *
 * An entry can be returned by two chunks — once under `simp`, once under `trad`
 * — which is exactly the case `byRowid`'s dedupe exists for.
 */
export function hanziExactMany(words: readonly string[]): SqlQuery[] {
  return chunked(words, RESOLVE_HANZI_CHUNK).map((batch) => ({
    sql:
      `SELECT ${ENTRY_COLUMNS} FROM entries ` +
      `WHERE simp IN (${holes(batch.length)}) OR trad IN (${holes(batch.length)}) ` +
      `ORDER BY rowid`,
    params: [...batch, ...batch],
  }));
}

/**
 * Every entry read exactly this way, most frequent first.
 *
 * The keys are `lib/dict/pinyin.ts`'s, computed by the same function that wrote
 * the columns at build time, so `nǐhǎo`, `ni3hao3`, `ni3 hao3` and `nihao` all
 * fold to a key before any SQL runs (`query/pinyin.ts`'s header is the long
 * version). `xx5` readings are NULL in both columns and `IN` never matches
 * NULL, so a no-known-reading row cannot be resolved by a reading it has not
 * got.
 */
export function pinyinExactMany(keys: readonly string[], toned: boolean): SqlQuery[] {
  const column = toned ? 'py_toned' : 'py_toneless';
  return chunked(keys).map((batch) => ({
    sql:
      `SELECT ${RESOLVE_PINYIN_COLUMNS} FROM entries ` +
      `WHERE ${column} IN (${holes(batch.length)}) ORDER BY rowid`,
    params: batch,
  }));
}
