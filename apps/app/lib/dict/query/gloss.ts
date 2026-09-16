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
 * `search.ts:89`'s constant. **5,000 is not a round number — it is a boundary in
 * this artifact**, and D4 settled that it stays.
 *
 * D3 required the cap to be an explicit decision and left it to D4 "with the
 * measurement in hand": `glossTier` ranks only what the cap admits, so a
 * low-frequency tier-0 match drops out of a broad query; `SearchResult.total`
 * becomes a capped count; `nextCursor` paging terminates earlier. D4 then
 * measured `search('to')` at 89–100 ms in wasm against its own 50 ms
 * interactive bar, which made lowering the cap the obvious lever.
 *
 * **It is the wrong lever, and the posting-list distribution is why.** Over the
 * built artifact (`fts5vocab(gloss_fts, 'row')`, 47,125 distinct terms):
 *
 *     > 5000 postings :  8 tokens    to 31561, of 20839, a 15969, in 13978,
 *     > 3000 postings : 14           the 12447, and 8706, idiom 5926, or 5506
 *     > 2000 postings : 26           ── the boundary ──  for 4918, see 3611,
 *     > 1000 postings : 52           etc 3291, on 3119, city 3095, with 2994…
 *
 * At 5,000 the cap binds **eight tokens, every one an English function word
 * plus `idiom`** — nobody searches a Chinese dictionary for "of". At 1,000 it
 * binds fifty-two, and the ones it newly catches are content words a learner
 * really types: bird, city, county, china, chinese, name, specie, taiwan,
 * district, time. D3's three consequences are acceptable on `of` and make a
 * worse dictionary on `bird`. Lowering the cap spends ranking quality on ~44
 * real searches to save 50 ms on eight queries nobody makes.
 *
 * `tests/unit/dict/gloss-order.test.ts` pins that distribution against the
 * artifact, so the premise cannot rot as CC-CEDICT moves.
 *
 * The lever that *would* close the breach without touching ranking is a
 * two-pass projection; see HANDOFF.md under D4, where it is recorded as an
 * unowned follow-up with the reason it might not pay.
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
 * Rowid order **is** the frequency ordering (D1 assigned the rowids in
 * `compareEntries` order), which is exactly the ordering today's posting lists
 * have; the 5,000-row slice and `isGlossToken`'s "first candidate that matches"
 * both depend on it.
 *
 * **There is deliberately no `ORDER BY`, and D4 changed that.** D3 wrote
 * `ORDER BY e.rowid` because FTS5's ascending-rowid scan "is not a documented
 * guarantee and the correct result is worth the sort", and measured the sort at
 * about 10 ms on the worst query — native. In wasm it is not 10 ms. Measured in
 * the container's Chromium against the real artifact: `"to"` matches **31,561**
 * rows, and `ORDER BY` makes SQLite materialise and sort *all* of them before
 * the `LIMIT` applies, so this statement costs **1,117–1,137 ms with the sort
 * and 46–51 ms without** — and, tellingly, **1,031–1,127 ms at `LIMIT 400`, the
 * same as at `LIMIT 5000`**, which is why `data.md` §6's "a smaller `LIMIT`"
 * lever does nothing at all for this shape. The whole `search('to')` call is
 * 89–100 ms without the sort. A one-second keystroke is not a thing to leave in
 * because a sort is tidier.
 *
 * What replaces the guarantee is two assertions rather than a clause, on two
 * different SQLites. `tests/unit/dict/gloss-order.test.ts` checks, against the
 * built artifact through `node:sqlite`, that this query returns strictly
 * ascending rowids and exactly the same rows as the sorted form — for **every**
 * token whose posting list exceeds the cap, which is the only case where the two
 * could differ. `tests/e2e/d/dict-wasm.spec.ts` checks the same property against
 * `@sqlite.org/sqlite-wasm`, which is the build the removal was made for. The
 * third runner, the SQLCipher FTS5 behind `@capacitor-community/sqlite`, is
 * `data.md` D5a/D5b's to add; HANDOFF.md names it as theirs.
 *
 * `glosses` is in the projection because `glossTier` needs the text, and it is
 * the only place in the layer where up to 5,000 rows carry it.
 */
export function glossCandidates(match: string, cap = MAX_GLOSS_CANDIDATES): SqlQuery {
  return {
    sql:
      `SELECT e.${RANK_COLUMNS.split(', ').join(', e.')}, e.glosses ` +
      `FROM gloss_fts f JOIN entries e ON e.rowid = f.rowid ` +
      `WHERE f.gloss_fts MATCH ? LIMIT ?`,
    params: [match, cap],
  };
}

/**
 * The sorted form, kept only so the guard test has something to compare against.
 *
 * It is never used at runtime. Exported rather than copied into the test because
 * a copy is a copy: the thing being proved is that `glossCandidates` and this
 * return the same rows, and a test that re-types the projection would go on
 * passing after somebody changed one of them.
 */
export function glossCandidatesSorted(match: string, cap = MAX_GLOSS_CANDIDATES): SqlQuery {
  const plain = glossCandidates(match, cap);
  const sql = plain.sql.replace(' LIMIT ?', ' ORDER BY e.rowid LIMIT ?');
  // `String.replace` returns its input when the needle is absent, so a future
  // edit to `glossCandidates` could quietly make this the identity function —
  // and the guard test would then be comparing a query against itself and
  // passing forever. Cheap to check, impossible to notice otherwise.
  if (sql === plain.sql) {
    throw new Error('glossCandidates no longer ends in ` LIMIT ?`; the sorted oracle is a no-op');
  }
  return { ...plain, sql };
}
