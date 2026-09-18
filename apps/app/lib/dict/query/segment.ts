/**
 * The segmenter's two queries (docs/plans/data.md D3).
 *
 * One batch for the candidate substrings of every hanzi run, one for the chosen
 * words' entry ids. The `chars` table the DP's `detectScript` needs was already
 * read whole by `open()`, which is what keeps that function synchronous.
 */
import { ENTRY_COLUMNS, MAX_BOUND_PARAMS, chunked, holes } from './entries';
import type { SqlQuery } from '../sql';
import type { SegmentScript } from '../segment';

/** Longest headword the DAG will try, and the longest substring worth asking about. */
export const MAX_WORD_CHARS = 16;

/**
 * Every distinct ≤16-character substring of the hanzi runs in `text`.
 *
 * Computed over code points, not code units: a run containing an extension-B
 * character would otherwise be cut in half and the candidate would be a
 * half-surrogate nothing matches.
 */
export function candidateSubstrings(runs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const run of runs) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i += 1) {
      const span = Math.min(MAX_WORD_CHARS, chars.length - i);
      for (let length = 1; length <= span; length += 1) out.add(chars.slice(i, i + length).join(''));
    }
  }
  return [...out];
}

/**
 * The candidate frequencies for one script.
 *
 * **Two statements in one batch, not one `WHERE word IN (…)` across both
 * scripts.** D3 prints the single-statement form, and it cannot use an index:
 * `words` is `PRIMARY KEY (script, word)` and a `WITHOUT ROWID` table has no
 * other B-tree, so `word IN (…)` alone is a full scan of 242,087 rows. Measured
 * on a 67-hanzi paragraph (937 distinct substrings): **45.7 ms** for the single
 * statement against **1.8 ms** for the two. Both forms are one round trip,
 * because a batch is the round trip. See HANDOFF.md, D3.
 */
export function wordCandidates(script: SegmentScript, words: readonly string[]): SqlQuery[] {
  // Chunked: `candidateSubstrings` is Θ(16n) and unbounded, so a 2,100-hanzi
  // passage produces more placeholders than SQLite will bind — and the limit is
  // a compile-time option that differs between the three runtimes this has to
  // run on. See `MAX_BOUND_PARAMS`. The chunks ride in the same batch, so the
  // round-trip count does not move.
  return chunked(words, MAX_BOUND_PARAMS - 1).map((batch) => ({
    sql: `SELECT word, freq FROM words WHERE script = ? AND word IN (${holes(batch.length)})`,
    params: [script, ...batch],
  }));
}

/**
 * Every reading of the chosen words, in frequency order, in either script.
 *
 * Both columns, because the DP's candidate map spans both scripts: a
 * traditional headword can be chosen while segmenting as simplified, which is
 * the fallback `segment.test.ts`'s 學習 case depends on.
 */
export function readingsOfWords(words: readonly string[]): SqlQuery[] {
  // Half the chunk size, because the list is bound TWICE.
  return chunked(words, Math.floor(MAX_BOUND_PARAMS / 2)).map((batch) => {
    const list = holes(batch.length);
    return {
      sql:
        `SELECT ${ENTRY_COLUMNS} FROM entries ` +
        `WHERE simp IN (${list}) OR trad IN (${list}) ORDER BY rowid`,
      params: [...batch, ...batch],
    };
  });
}
