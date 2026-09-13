/**
 * English gloss search over FTS5 (docs/plans/data.md D3).
 *
 * **FTS5 is a posting-list store here and nothing else** — precisely the role
 * `index.byGloss` plays today. The ranking is `glossTier`, which encodes
 * PLAN.md §3.2's four tiers and is what makes `plan` rank 打算 above a gloss that
 * merely mentions planning. That is not a preference: on a contentless
 * `detail=none` table **`bm25()` returns 0 for every row** (reproduced on SQLite
 * 3.51.2 here and on 3.45.1 elsewhere), so buying a real bm25 would cost
 * `detail=full`'s +3.4 MB for a ranking function Tangram does not use.
 *
 * Two consequences of `detail=none` the queries must respect:
 *
 * - **A phrase query raises an error, not an empty result**
 *   (`fts5: phrase queries are not supported (detail!=full)`), so `"to plan"`
 *   must never be sent. Every MATCH term is a single token.
 * - The index stores **pre-stemmed tokens**, the output of `glossTokens()`, so
 *   `unicode61` is only a whitespace splitter and the build-time and query-time
 *   stemmers cannot drift. `tokenchars ''''` is what keeps the apostrophe inside
 *   `one's`.
 */
import { RANK_COLUMNS } from './entries';
import type { SqlQuery } from '../sql';

/**
 * `search.ts:89`'s constant, and the cap this phase deliberately keeps.
 *
 * D3 required this to be an explicit decision. Today's pre-ranking pool is
 * `MAX_GLOSS_CANDIDATES = 5000` per query word; a tighter cap would make this a
 * redesign rather than a port, because `glossTier` would rank only what the cap
 * admits, `SearchResult.total` would become a capped count, and `nextCursor`
 * paging would terminate early. Measured cost at this cap, native: 0.4 ms for
 * `"plan"`, 0.6 ms for `"to" AND "plan"`, 25 ms for the worst single common
 * token (`"to"`, which fills the cap). D4 may lower it if WASM makes the worst
 * case bite, and if it does it must say what to, why, and what happened to
 * `total` and to the group sequence of `da` and `to` paged to the end.
 */
export const MAX_GLOSS_CANDIDATES = 5000;

/**
 * Quote one token for an FTS5 MATCH string.
 *
 * Building the MATCH string is a security-shaped problem rather than a
 * formatting one: FTS5 has its own query syntax, and an unescaped learner query
 * is an injection into it. The rule is to drop anything that is not
 * `[a-z0-9']`, wrap what is left in double quotes, and never emit a bare `*`,
 * `^`, `:`, `-`, `NEAR`, or a multi-word quoted string. A `"` inside a quoted
 * FTS5 string is escaped by doubling it; the character class makes that
 * unreachable, and it is done anyway because a guard that depends on another
 * guard is one edit from being wrong.
 */
export function quoteToken(token: string): string | null {
  const cleaned = token.toLowerCase().replace(/[^a-z0-9']/g, '');
  if (!cleaned) return null;
  return `"${cleaned.replace(/"/g, '""')}"`;
}

/**
 * One MATCH string: every term ANDed, one quoted token each.
 *
 * Returns null when nothing survives cleaning, which is the caller's signal to
 * answer with no results rather than to send a syntactically empty MATCH (FTS5
 * raises on one).
 */
export function buildMatch(tokens: readonly string[]): string | null {
  const terms: string[] = [];
  for (const token of tokens) {
    const quoted = quoteToken(token);
    if (quoted) terms.push(quoted);
  }
  return terms.length > 0 ? terms.join(' AND ') : null;
}

/**
 * The ranked candidate path.
 *
 * `ORDER BY e.rowid` is the frequency ordering (D1 assigned the rowids in
 * `compareEntries` order), which is exactly the ordering today's posting lists
 * have and which today's 5,000-row slice depends on. It costs about 10 ms of
 * temp B-tree on the worst query: FTS5 happens to return rowids ascending
 * already, but that is not a documented guarantee and the correct result is
 * worth the sort. See HANDOFF.md, D3.
 *
 * `glosses` is in the projection because `glossTier` needs the text, and it is
 * the only place in the layer where up to 5,000 rows carry it.
 */
export function glossCandidates(match: string, cap = MAX_GLOSS_CANDIDATES): SqlQuery {
  return {
    sql:
      `SELECT e.${RANK_COLUMNS.split(', ').join(', e.')}, e.glosses ` +
      `FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid ` +
      `WHERE f.gloss_fts MATCH ? ORDER BY e.rowid LIMIT ?`,
    params: [match, cap],
  };
}
