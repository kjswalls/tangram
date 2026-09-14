/**
 * Pinyin lookup over the two derived key columns (docs/plans/data.md D2).
 *
 * The normalisation is `lib/dict/pinyin.ts`'s and it moves to the client
 * unchanged — that is the whole point. The same function computes the stored key
 * at build time (`scripts/build-data.ts`) and the query key at query time, so
 * `dasuan`, `da3suan4`, `dǎsuàn`, `da suan` and `da'suan` all land on one row
 * because they all fold to one key before any SQL runs.
 *
 * What must survive the port is in `pinyin.ts`'s own comments and in
 * `scripts/verify-data.ts`: keys carry no separators, ü/v/`u:` fold to u, the
 * neutral tone contributes no digit, `xx5` readings are NULL in both columns,
 * and the build uses `readingKeys() ?? normalizePinyin()`.
 */
import { RANK_COLUMNS } from './entries';
import { upperBound } from './hanzi';
import type { SqlQuery } from '../sql';

/** `search.ts:87`'s constant. A pinyin prefix admits up to 600 ids. */
export const MAX_PINYIN_PREFIX_IDS = 600;

export function pinyinExact(key: string, toned: boolean): SqlQuery {
  const column = toned ? 'py_toned' : 'py_toneless';
  return {
    sql: `SELECT ${RANK_COLUMNS} FROM entries WHERE ${column} = ? ORDER BY rowid`,
    params: [key],
  };
}

/**
 * Readings starting with `key`.
 *
 * The upper bound is `hanzi.ts`'s incremented code point for the same reason,
 * even though a pinyin key is ASCII: one rule, one place, no second version to
 * get wrong later. `ORDER BY rowid LIMIT` is **in the SQL** — `da` matches
 * thousands of rows and sorting after the fact would pull all of them across the
 * Capacitor bridge on every keystroke.
 */
export function pinyinPrefix(key: string, toned: boolean, limit = MAX_PINYIN_PREFIX_IDS): SqlQuery {
  const column = toned ? 'py_toned' : 'py_toneless';
  return {
    sql:
      `SELECT ${RANK_COLUMNS} FROM entries ` +
      `WHERE ${column} >= ? AND ${column} < ? ORDER BY rowid LIMIT ?`,
    params: [key, upperBound(key), limit],
  };
}
