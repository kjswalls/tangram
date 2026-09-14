/**
 * One HSK band, easiest first (docs/plans/data.md D2).
 *
 * The only query in the layer that does **not** order by rowid. `index.ts` builds
 * `byHsk` from the `compareEntries`-sorted list and then re-sorts each band by
 * `freqRank ?? Number.MAX_SAFE_INTEGER`, and raw frequency and jieba rank
 * disagree about the 51 banded entries that have no `freqRank` at all — six of
 * them in HSK 1, which product-decisions §3 makes the default band. Those belong
 * at the tail, and SQLite orders NULLs *first*, so D1 folds the sentinel into
 * `hsk_sort` rather than writing `NULLS LAST` or an expression index: the
 * ordering stays a plain index scan on every SQLite the artifact may meet.
 *
 * The `rowid` tie-break is not decoration. `Array.prototype.sort` is stable and
 * its input is already `compareEntries` order, so entries sharing a `freqRank`
 * keep frequency order today and must keep it after the port.
 */
import { ENTRY_COLUMNS } from './entries';
import type { SqlQuery } from '../sql';
import type { HskBand } from '../types';

/**
 * `limit`/`offset` are new against today's `hskBand(band)`. The call crosses a
 * bridge now rather than a socket, and the 7–9 band is 5,638 entries — not a
 * thing to serialise whole on the way to a list that shows fifty.
 */
export function hskBandQuery(band: HskBand, limit?: number, offset?: number): SqlQuery {
  const base = `SELECT ${ENTRY_COLUMNS} FROM entries WHERE hsk_band = ? ORDER BY hsk_sort, rowid`;
  if (limit === undefined && offset === undefined) return { sql: base, params: [band] };
  // SQLite needs a LIMIT before it will take an OFFSET; -1 is "no limit".
  return {
    sql: `${base} LIMIT ? OFFSET ?`,
    params: [band, limit ?? -1, offset ?? 0],
  };
}
