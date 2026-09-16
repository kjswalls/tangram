// @vitest-environment node
/**
 * FTS5 returns matching rowids in ascending order, and the gloss path depends on
 * it (docs/plans/data.md D3, D4).
 *
 * **Why this file exists.** D3 wrote `ORDER BY e.rowid` into the gloss candidate
 * query and said why: FTS5's ascending-rowid scan "is not a documented guarantee
 * and the correct result is worth the sort", measured at about 10 ms on the
 * worst query in native SQLite. D4 measured the same sort **in wasm** and it is
 * not 10 ms — `"to"` matches 31,561 rows and the sort materialises all of them
 * before the `LIMIT`, at **1,117 ms against 46 ms** for the same statement in
 * the container's Chromium against the real artifact. So the sort came out and
 * this took its place.
 *
 * **It is a stronger guarantee than the comment it replaces, not a weaker one.**
 * A sort protects against an order that is wrong today; this protects against an
 * order that becomes wrong tomorrow, and it does it against the artifact and the
 * SQLite the tree actually has rather than against a claim in a document. It
 * runs on every runner the store ever gets, which matters twice over: the
 * SQLCipher builds behind `@capacitor-community/sqlite` are a *different* FTS5
 * build (`data.md` D5a/D5b, STACK register #20), and this is the assertion that
 * says whether they agree.
 *
 * **Two things depend on the order, and neither is cosmetic.** Rowid order is
 * frequency order (D1 assigns rowids in `compareEntries` order), so
 * `LIMIT 5000` means "the 5,000 most frequent matches" — and `isGlossToken`
 * returns true on the *first* candidate whose `glossTier` is 0 or 1, which is
 * only meaningful in frequency order. That is the `sun`/`can`/`women`-versus-
 * `shi` rule that decides which section of a result page leads.
 *
 * **The tokens tested are the ones where it could matter at all.** Below the cap
 * the two forms return the same *set* and the store sorts nothing, so any
 * difference would have to be in order alone; at or above the cap they can
 * return different sets entirely. The nine tokens whose posting lists exceed
 * 5,000 are therefore named individually, and the suite additionally derives the
 * over-cap set from the artifact rather than trusting the list — a hand-written
 * list of stopwords is exactly the thing that goes stale when CC-CEDICT moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_GLOSS_CANDIDATES, glossCandidates, glossCandidatesSorted } from '@/lib/dict/query/gloss';
import { nodeRunner } from '@/lib/dict/runners/node';
import type { SqlQuery, SqlRunner } from '@/lib/dict/sql';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

/** D1's review measured these nine as the tokens whose posting lists exceed the cap. */
const NAMED = ['of', 'to', 'a', 'the', 'in', 'and', 'or', 'for', 'idiom'];

/** A spread of ordinary queries, including the `isGlossToken` routing examples. */
const ORDINARY = ['plan', 'sun', 'can', 'women', 'shi', 'he', 'one', 'water', 'to be born'];

let runner: SqlRunner;

beforeAll(() => {
  runner = nodeRunner(dictArtifactPath());
});

afterAll(async () => {
  await runner.close();
});

function match(query: string): string {
  return query
    .split(/\s+/)
    .map((word) => `"${word}"`)
    .join(' AND ');
}

async function rowids(query: SqlQuery): Promise<number[]> {
  const [rows] = await runner.query([query]);
  return rows.map((row) => row.rowid as number);
}

describe('the gloss candidate query returns rowids in ascending order', () => {
  it('compares against an oracle that is actually a different query', () => {
    // The sorted form is built by rewriting the plain one, and a rewrite that
    // matched nothing would leave every comparison below asserting that a query
    // equals itself. `glossCandidatesSorted` throws rather than returning the
    // input, and this is the case that proves it still can.
    const plain = glossCandidates('"to"');
    const sorted = glossCandidatesSorted('"to"');
    expect(sorted.sql).not.toBe(plain.sql);
    expect(sorted.sql).toContain('ORDER BY e.rowid');
    expect(plain.sql).not.toContain('ORDER BY');
  });

  /**
   * The premise D4's cap decision rests on, pinned against the artifact.
   *
   * The orchestrator's ruling on criterion 2 keeps `MAX_GLOSS_CANDIDATES` at
   * 5,000 on one fact: at that cap the truncation binds **only English function
   * words**, while at 1,000 it starts binding content words a learner actually
   * types (bird, city, county, china, name, specie, taiwan, district, time). A
   * number in a comment rots; this does not. If a CC-CEDICT snapshot ever pushes
   * a content word over the cap, the decision needs re-taking and this is what
   * says so.
   *
   * `fts5vocab` is created in `temp`, which works on a read-only main database —
   * and `cnt` comes back null through `node:sqlite`, so `doc` (the number of
   * rows carrying the term) is the column to read.
   */
  it('pins the posting-list distribution the cap decision rests on', async () => {
    const [rows] = await runner.query([
      { sql: "CREATE VIRTUAL TABLE IF NOT EXISTS temp.gloss_vocab USING fts5vocab(main, gloss_fts, 'row')" },
      { sql: 'SELECT term, doc FROM temp.gloss_vocab WHERE doc > ? ORDER BY doc DESC', params: [MAX_GLOSS_CANDIDATES] },
    ]).then((results) => [results[1]]);

    const overCap = rows.map((row) => String(row.term));
    // Eight, and every one of them a function word or `idiom`. The list is
    // asserted by value: "eight tokens" alone would still hold if the eight
    // became eight content words, which is the failure that matters.
    expect(overCap).toEqual(['to', 'of', 'a', 'in', 'the', 'and', 'idiom', 'or']);

    // …and the boundary is real: the next token down is `for` at 4,918, so 5,000
    // sits between the last function word and the first content word rather than
    // in the middle of a run.
    const [next] = await runner.query([
      {
        sql: 'SELECT term, doc FROM temp.gloss_vocab WHERE doc <= ? ORDER BY doc DESC LIMIT 1',
        params: [MAX_GLOSS_CANDIDATES],
      },
    ]);
    expect(next[0].term).toBe('for');
    expect(Number(next[0].doc)).toBeLessThan(MAX_GLOSS_CANDIDATES);
    expect(Number(next[0].doc)).toBeGreaterThan(4000);
  });

  it('is testing tokens that really do exceed the cap, derived from the artifact', async () => {
    // Deduped: `to` is both a named token and a word inside `to be born`.
    const tokens = [...new Set([...NAMED, ...ORDINARY.flatMap((q) => q.split(/\s+/))])];
    const counts: Record<string, number> = {};
    for (const token of tokens) {
      const [counted] = await runner.query([
        {
          sql: 'SELECT count(*) AS n FROM gloss_fts WHERE gloss_fts MATCH ?',
          params: [`"${token}"`],
        },
      ]);
      counts[token] = counted[0].n as number;
    }
    const overCap = Object.entries(counts)
      .filter(([, n]) => n > MAX_GLOSS_CANDIDATES)
      .map(([token]) => token)
      .sort();

    // If this ever came back empty the whole file would be testing nothing:
    // every token would fit under the cap and the two query forms could not
    // return different sets at all.
    expect(overCap.length, JSON.stringify(counts)).toBeGreaterThanOrEqual(5);
    // Derived from the artifact, not asserted against a hand-written list — a
    // list of stopwords is exactly what goes stale when CC-CEDICT moves. What
    // *is* asserted is that `NAMED` still covers every one of them, so the
    // per-token cases below cannot quietly stop including the hard ones.
    expect(overCap.filter((token) => !NAMED.includes(token))).toEqual([]);

    // One correction to D1's HANDOFF note while this is measured: it lists nine
    // tokens as exceeding the cap and `for` is not one of them — 4,918 postings
    // in this snapshot, just under the 5,000. It is kept in `NAMED` because it
    // is the closest token to the boundary and therefore the most interesting
    // one to watch.
    expect(counts.for).toBeLessThan(MAX_GLOSS_CANDIDATES);
  });

  it.each([...NAMED, ...ORDINARY])(
    'returns ascending rowids, identical to the sorted form, for %s',
    async (query) => {
      const m = match(query);
      const plain = await rowids(glossCandidates(m));
      const sorted = await rowids(glossCandidatesSorted(m));
      expect(plain.length).toBeGreaterThan(0);
      // Strictly ascending: the property `LIMIT n` = "the n most frequent" rests
      // on, and the property `isGlossToken` reads the candidates in.
      for (let index = 1; index < plain.length; index += 1) {
        expect(plain[index], `${query} at ${index}`).toBeGreaterThan(plain[index - 1]);
      }
      // …and the same rows, which is the part that can only be checked against
      // the sorted form: an ascending list can still be the wrong ascending list
      // if the scan picked a different 5,000.
      expect(plain).toEqual(sorted);
    },
  );

  it('holds at a cap small enough that the two forms could disagree', async () => {
    // `LIMIT 5000` on a 31,561-row posting list already exercises truncation,
    // but a tiny cap makes the failure mode unmistakable: if the scan were not
    // rowid-ordered, taking 10 of 31,561 rows would almost certainly take a
    // different 10.
    for (const token of NAMED) {
      const m = `"${token}"`;
      expect(await rowids(glossCandidates(m, 10)), token).toEqual(
        await rowids(glossCandidatesSorted(m, 10)),
      );
    }
  });
});
