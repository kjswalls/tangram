/**
 * Hanzi lookup: exact headwords and prefixes, both scripts (docs/plans/data.md D2).
 *
 * Every Chinese query is exact-or-prefix against a known headword — the lexicon
 * *is* the dictionary — so this is a B-tree range scan and nothing else.
 * STACK §2.5 is the argument for why full-text search is the wrong tool here.
 */
import { RANK_COLUMNS } from './entries';
import type { SqlQuery } from '../sql';

/** How many ids a hanzi prefix may contribute, per script. `search.ts:86`'s constant. */
export const MAX_HANZI_PREFIX_IDS = 400;

/**
 * The exclusive upper bound of a prefix range: the prefix with its **last code
 * point incremented**.
 *
 * Not the prefix with `U+FFFF` appended, which is the obvious version and is
 * wrong. SQLite's default `BINARY` collation compares UTF-8 bytes; `U+FFFF`
 * encodes as `EF BF BF` while any astral-plane character encodes as `F0 …`, and
 * `F0 > EF`. So the naive sentinel silently drops every headword whose
 * continuation is itself an extension character — 𩽾𩾌, 𫐖𮝺, 𰻝𰻝面 — which is
 * exactly the set the extension ranges exist for. For the same reason no column
 * may be declared `COLLATE NOCASE`.
 *
 * `[...prefix]` iterates code points, so incrementing the last one is safe for a
 * surrogate pair.
 */
export function upperBound(prefix: string): string {
  const points = [...prefix];
  const last = points.pop();
  if (last === undefined) throw new Error('a prefix range needs a prefix');
  return points.join('') + String.fromCodePoint((last.codePointAt(0) as number) + 1);
}

/**
 * The exact headword in either script.
 *
 * `ORDER BY rowid` *is* frequency order — `compareEntries` assigned the rowids
 * (data.md D1) — so this reproduces `index.bySimp.get(q)` followed by
 * `index.byTrad.get(q)` as one statement, deduped by the candidate set.
 */
export function hanziExact(query: string): SqlQuery {
  return {
    sql: `SELECT ${RANK_COLUMNS} FROM entries WHERE simp = ?1 OR trad = ?1 ORDER BY rowid`,
    params: [query],
  };
}

/**
 * Headwords starting with `query`, one script at a time.
 *
 * `hanziGroups` calls `prefixIds` once per script today, so a prefix query
 * admits up to 400 + 400 ids and this is issued twice in the same batch.
 *
 * **The truncation differs from today's, deliberately** (data.md D2). The JSON
 * `prefixIds` walks the sorted key array and emits whole key buckets in
 * *lexicographic key order* until the cap is reached, so an overflowing prefix
 * keeps the alphabetically-first headwords. `ORDER BY rowid LIMIT n` keeps the
 * *n most frequent* across all matching keys — a learner typing `da` wants 大
 * and 打, not whatever sorts first — and it is also the only form that does not
 * need a two-step distinct-keys-then-ids query across the Capacitor bridge.
 */
export function hanziPrefix(
  query: string,
  script: 'simp' | 'trad',
  limit = MAX_HANZI_PREFIX_IDS,
): SqlQuery {
  const column = script === 'simp' ? 'simp' : 'trad';
  return {
    sql:
      `SELECT ${RANK_COLUMNS} FROM entries ` +
      `WHERE ${column} >= ? AND ${column} < ? ORDER BY rowid LIMIT ?`,
    params: [query, upperBound(query), limit],
  };
}

/**
 * "Which words contain 算" — the packed posting list for one (character, script).
 *
 * The blob is delta-varints of `entries.rowid` and only TypeScript can decode
 * it, so this is the first of two round trips; `entriesByRowids` is the second.
 * `data.md` D2's budget table says one, which is not achievable while the
 * postings are a BLOB — see HANDOFF.md, D2. The alternative, a single
 * `instr(simp, ?) > 0` scan in rowid order, measured 2.6 ms for a common
 * character and 12.9 ms for a rare one against 0.1 ms for the two steps here.
 */
export function charWords(ch: string, script: 'simp' | 'trad'): SqlQuery {
  return {
    sql: 'SELECT n, rowids FROM char_words WHERE ch = ? AND script = ?',
    params: [ch, script],
  };
}
