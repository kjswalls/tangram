// @vitest-environment node
/**
 * English gloss search over FTS5, against the JSON index (docs/plans/data.md D3).
 *
 * D3 budgets **two** behavioural changes for the gloss port and this file is
 * where both are made visible rather than absorbed:
 *
 *  1. **Multi-word recall goes up.** Today's code intersects per-word posting
 *     lists that were each truncated to 5,000 *before* the intersection, so a
 *     two-word query can come back nearly empty even when many entries carry
 *     both words. FTS5's `AND` is an exact intersection and the cap applies
 *     after it. Note the precision of the claim — for a *single*-word query,
 *     FTS5 plus `LIMIT 5000` is the same pool today's code has.
 *  2. **`isGlossToken` is a separate statement** rather than a slice of a shared
 *     in-memory posting list. Its candidate order and its 5,000-row window are
 *     preserved exactly, and if either drifts the `sun`/`can`/`women`-versus-`shi`
 *     routing drifts with it.
 *
 * There is a third difference, smaller and not in the plan, recorded in
 * HANDOFF.md: `index.byGloss` pushes an id into a token's posting list once **per
 * gloss**, so a list there can carry the same id several times, while an FTS5
 * index carries a rowid once per term. For the nine tokens whose lists exceed the
 * 5,000 cap, the JSON slice spends places on duplicates and the FTS one does not.
 *
 * **The JSON side is `golden/search.json` since `data.md` D6.** The router and
 * the ranker it compared against are deleted; what they answered for this file's
 * 200-query corpus, its six routing cases and its two paging walks was frozen on
 * the commit before. `golden.test.ts` is what fails, by itself and by name, when
 * the data moves under those fixtures. The segmentation oracle is still **live**
 * — `segment()` survives at `scripts/dict-json.ts` because `pnpm data` needs the
 * JSON index to build the artifact — so the long-passage case asserts against
 * both it and the frozen digest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDict, segment as jsonSegment } from './json-oracle';
import { glossTier, glossTokens, lemmas } from '@/lib/dict/rank';
import { nodeRunner } from '@/lib/dict/runners/node';
import type { SearchGroup, SearchResult } from '@/lib/dict/search';
import { goldenSearch, sha256 } from './golden';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import { buildMatch, quoteToken } from '@/lib/dict/query/gloss';
import type { SqlQuery, SqlRunner } from '@/lib/dict/sql';
import { dictArtifactPath, requireDictData } from './data-required';

requireDictData();

let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
});

afterAll(async () => {
  await store.close();
});

/** A runner that records the SQL it was asked to run. */
function spyingRunner(): { runner: SqlRunner; batches: SqlQuery[][] } {
  const inner = nodeRunner(dictArtifactPath());
  const batches: SqlQuery[][] = [];
  return {
    runner: {
      async query(batch, signal) {
        batches.push([...batch]);
        return inner.query(batch, signal);
      },
      close: () => inner.close(),
    },
    batches,
  };
}

async function spied(work: (store: SqliteDictStore) => Promise<unknown>): Promise<SqlQuery[][]> {
  const spy = spyingRunner();
  const instance = new SqliteDictStore({ connect: async () => spy.runner });
  await instance.open();
  const before = spy.batches.length;
  await work(instance);
  await instance.close();
  return spy.batches.slice(before);
}

/** A page big enough that neither implementation's section is cut by paging. */
const WHOLE = { limit: 100_000 };

/**
 * A long passage of *varied* hanzi.
 *
 * Varied matters: `candidateSubstrings` dedupes, so repeating one phrase 2,000
 * times produces a few hundred substrings and proves nothing about scale. Real
 * prose has near-unique five-grams, which is what the headword walk imitates.
 */
function longPassage(chars: number): string {
  const headwords = [...new Set(getDict().entries.map((entry) => entry.simp))].filter(
    (word) => [...word].length >= 2 && [...word].length <= 4,
  );
  let out = '';
  let i = 0;
  while ([...out].length < chars) {
    out += headwords[(i * 37) % headwords.length];
    i += 1;
  }
  return [...out].slice(0, chars).join('');
}

function keysOf(result: { sections: { source: string; groups: { key: string }[] }[] }, source: string): string[] {
  return result.sections
    .filter((part) => part.source === source)
    .flatMap((part) => part.groups.map((group) => group.key));
}

function sectionGroups(result: SearchResult, source: string): SearchGroup[] {
  return result.sections.filter((part) => part.source === source).flatMap((part) => part.groups);
}

// ---------------------------------------------------------------------------
// The MATCH string (criterion 6, 7)
// ---------------------------------------------------------------------------

describe('building the MATCH string', () => {
  // FTS5 has its own query syntax, so an unescaped learner query is an injection
  // into it rather than a formatting mistake.
  it('keeps letters, digits and the apostrophe, and drops everything else', () => {
    expect(quoteToken('plan')).toBe('"plan"');
    expect(quoteToken("one's")).toBe('"one\'s"');
    expect(quoteToken('3c')).toBe('"3c"');
    expect(quoteToken('NEAR')).toBe('"near"');
    expect(quoteToken('pl*an')).toBe('"plan"');
    expect(quoteToken('^plan:')).toBe('"plan"');
    expect(quoteToken('"')).toBeNull();
    expect(quoteToken('***')).toBeNull();
    expect(quoteToken('')).toBeNull();
  });

  it('ANDs one quoted term per word and never emits a phrase', () => {
    expect(buildMatch(['to', 'plan'])).toBe('"to" AND "plan"');
    expect(buildMatch(['plan'])).toBe('"plan"');
    expect(buildMatch(['***', 'plan'])).toBe('"plan"');
    expect(buildMatch([])).toBeNull();
    expect(buildMatch(['***'])).toBeNull();
  });

  it('never puts two words inside one pair of quotes', () => {
    // A phrase query does not return an empty result on a `detail=none` table —
    // it raises `fts5: phrase queries are not supported`. So `"to plan"` must
    // never be constructed, and the only defence is that a term is one token.
    for (const input of ['to plan', 'a b c', '  spaced  out  ']) {
      const built = quoteToken(input);
      expect(built === null || !/\s/.test(built)).toBe(true);
    }
  });
});

describe('the MATCH strings the store actually sends', () => {
  const QUERIES = [
    'plan',
    'to plan',
    'women',
    'sun',
    'one more thing',
    "one's own",
    'NEAR plan',
    'plan*',
    '^plan',
    'plan:',
    'plan"',
    '"unbalanced',
    'plan AND scheme',
    'plan OR scheme',
    'plan (scheme)',
    'a'.repeat(200),
  ];

  async function matchStrings(query: string): Promise<string[]> {
    const batches = await spied((instance) => instance.search(query, { limit: 5 }));
    return batches
      .flat()
      .filter((statement) => statement.sql.includes('gloss_fts MATCH'))
      .map((statement) => String(statement.params?.[0] ?? ''));
  }

  it('never constructs a phrase query', async () => {
    for (const query of QUERIES) {
      for (const match of await matchStrings(query)) {
        // Every term is `"word"`, and the only thing between terms is ` AND `.
        expect(match, query).toMatch(/^"[a-z0-9']+"(?: AND "[a-z0-9']+")*$/);
      }
    }
  });

  it('never emits an OR group', async () => {
    // The guard against an irregular-plural OR group creeping back into the
    // ranked path and widening recall — a third behavioural change D3 does not
    // budget for. The union that today's code really does compute for a plural
    // of a plural is expressed as separate statements instead; see
    // `formCombinations` in `lib/dict/sqlite-store.ts`.
    for (const query of [...QUERIES, 'mens', 'womens', 'peoples']) {
      for (const match of await matchStrings(query)) {
        expect(match, query).not.toContain(' OR ');
      }
    }
  });
});

describe('the fuzz corpus never reaches SQLite as a syntax error', () => {
  const FUZZ = [
    '"', '""', '"""', '*', '**', '^', ':', '-', '(', ')', '()', '(((',
    'NEAR', 'NEAR(a b)', 'AND', 'OR', 'NOT', 'a AND', 'AND a',
    '"to plan"', 'plan*', '^plan', 'col:plan', 'a-b', '{a}', '[a]',
    'a"b"c', '"unbalanced', 'unbalanced"', 'план', '打算 plan', '😀',
    'a'.repeat(200), '  ', '\t\n', "''''", "a''b",
  ];

  it.each(FUZZ)('%j', async (query) => {
    // The assertion is that nothing throws. A broken MATCH string is a 500 in a
    // search box, and FTS5 raises rather than returning nothing.
    const result = await store.search(query, { limit: 5 });
    expect(result.query).toBe(query.trim());
    expect(Array.isArray(result.groups)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The differential corpus (criterion 4)
// ---------------------------------------------------------------------------

/**
 * Two hundred English queries, taken from the dictionary's own gloss tokens in
 * rowid order so the corpus is deterministic and is not a list of words somebody
 * thought of.
 *
 * Read back from the fixture rather than recomputed, so a query and its frozen
 * answer can never be misaligned — and then recomputed anyway and compared, so
 * that a dictionary which has moved says so here instead of looking like 180
 * lost groups. `golden.test.ts` carries the same alarm against the file's sha.
 */
function corpus(): string[] {
  const frozen = goldenSearch.corpus;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of getDict().entries) {
    if (entry.isVariant) continue;
    for (const gloss of entry.glosses) {
      for (const token of glossTokens(gloss)) {
        if (token.length < 3 || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
        if (out.length >= 180) {
          expect(
            [...out, ...PHRASES],
            'the gloss corpus no longer derives from this dictionary — see golden/README.md',
          ).toEqual(frozen);
          return frozen;
        }
      }
    }
  }
  expect([...out, ...PHRASES]).toEqual(frozen);
  return frozen;
}

/** Multi-word queries, which is where the intersection change shows. */
const PHRASES = [
  'to plan', 'to eat', 'old man', 'young woman', 'to go to', 'one hundred',
  'water and fire', 'big brother', 'to be able to', 'not yet', 'a lot of',
  'to look at', 'to make a', 'in front of', 'point of view', 'to take care of',
  'to be born', 'to get up', 'south of the', 'to come back',
];

describe('the 200-query differential corpus', () => {
  it('reports every group-set difference, and every one is explained', () => {
    const queries = corpus();
    expect(queries.length).toBeGreaterThanOrEqual(200);

    const wider: string[] = [];
    const narrower: string[] = [];
    const identical: string[] = [];
    return (async () => {
      for (const query of queries) {
        // A page big enough that neither side's section is cut by paging. With a
        // 50-group page the comparison is confounded: a wider candidate set
        // pushes groups off the end of the page, which looks like a loss and is
        // not one.
        const answer = goldenSearch.gloss[query];
        // Without this, a query with no frozen answer reads as an empty set —
        // nothing lost, nothing to explain — and the case passes by having no
        // oracle at all, which is the exact failure D6's freeze exists to stop.
        expect(answer, `${query} has no frozen answer in golden/search.json`).toBeDefined();
        const mine = new Set(keysOf(await store.search(query, WHOLE), 'english'));
        const theirs = new Set(answer);
        const lost = [...theirs].filter((key) => !mine.has(key));
        if (lost.length === 0 && mine.size === theirs.size) identical.push(query);
        else if (lost.length === 0) wider.push(query);
        else narrower.push(`${query} (-${lost.length})`);
      }

      process.stdout.write(
        `\n200-query English corpus: ${identical.length} identical, ${wider.length} wider ` +
          `(the exact-intersection change), ${narrower.length} narrower\n` +
          (wider.length > 0 ? `  wider: ${wider.slice(0, 12).join(', ')}${wider.length > 12 ? ' …' : ''}\n` : '') +
          (narrower.length > 0 ? `  narrower: ${narrower.join(', ')}\n` : ''),
      );

      // **Nothing may be lost.** Wider is D3's budgeted change 1 — FTS5's AND is
      // an exact intersection where the JSON side intersects pre-truncated lists
      // — and it only ever adds. A query where the store returns FEWER groups
      // than the JSON index is not explained by that, and is a bug.
      expect(narrower).toEqual([]);

      // …and "wider" is not a licence to return anything: every group the store
      // adds must be a real gloss match for the query's own words. Without this
      // the test has only one direction and a store that returned the whole
      // dictionary for every query would pass it.
      const unexplained: string[] = [];
      for (const query of [...wider].slice(0, 8)) {
        const queryWords = lemmas(query);
        const mine = sectionGroups(await store.search(query, WHOLE), 'english');
        const theirs = new Set(goldenSearch.gloss[query] ?? []);
        for (const group of mine) {
          if (theirs.has(group.key)) continue;
          const tier = Math.min(
            ...group.entries.map((entry) => glossTier(entry, queryWords)),
          );
          if (!Number.isFinite(tier)) unexplained.push(`${query} → ${group.key}`);
        }
      }
      expect(unexplained).toEqual([]);
    })();
  }, 120_000);

  // The `isGlossToken` rule's own examples, each with its own assertion on which
  // section leads. An aggregate diff count would not show a section swapping
  // places, and swapping places is the whole failure mode.
  const ROUTING: [string, 'english' | 'pinyin'][] = [
    ['sun', 'english'],
    ['can', 'english'],
    ['women', 'english'],
    ['shi', 'pinyin'],
    ['he', 'pinyin'],
    ['ta', 'pinyin'],
  ];

  it.each(ROUTING)('%s leads with the %s section', async (query, leads) => {
    const mine = await store.search(query, { limit: 50 });
    const frozen = goldenSearch.routing[query];
    expect(frozen, `${query} has no frozen routing in golden/search.json`).toBeDefined();
    // Both directions: the section the plan names, and the whole section order
    // the JSON router produced. The first is the readable claim; the second is
    // what catches a section quietly swapping places.
    expect(mine.sections[0].source).toBe(leads);
    expect(frozen[0]).toBe(leads);
    expect(mine.sections.map((part) => part.source)).toEqual(frozen);
  });

  it('routes a romanised syllable to pinyin and a real gloss word to English', async () => {
    // 是, 事, 十 must not be buried under a section that had nothing a learner
    // typing `shi` wanted.
    const shi = await store.search('shi', { limit: 50 });
    expect(shi.groups.slice(0, 4).map((group) => group.simp)).toContain('是');
    const sun = await store.search('sun', { limit: 50 });
    expect(sun.groups.map((group) => group.simp)).toContain('太阳');
    expect(sun.groups.map((group) => group.simp)).toContain('孙');
  });
});

// ---------------------------------------------------------------------------
// Paging (criterion 5)
// ---------------------------------------------------------------------------

/** `to` is 4,718 groups at 50 a page; the guard is a runaway stop, not a budget. */
const MAX_PAGES = 200;

describe('paging a broad query to the end', () => {
  async function pages(
    query: string,
    run: (query: string, options: { limit?: number; cursor?: string }) => Promise<{
      groups: { key: string }[];
      total: number;
      nextCursor?: string;
    }>,
  ): Promise<{ keys: string[]; totals: number[]; pages: number }> {
    const keys: string[] = [];
    const totals: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await run(query, cursor ? { cursor } : {});
      keys.push(...page.groups.map((group) => group.key));
      totals.push(page.total);
      pages += 1;
      if (!page.nextCursor || pages >= MAX_PAGES) break;
      cursor = page.nextCursor;
    }
    return { keys, totals, pages };
  }

  // This is what makes a silently lowered gloss cap visible: the cap decides
  // `total` and decides where `nextCursor` terminates, so a `:cap` chosen
  // quietly would show up here as a shorter walk rather than as a wrong answer.
  //
  // `da` is a **capped pinyin** query (600 ids), so its two candidate sets differ
  // by D2's budgeted truncation change and containment is not asserted for it;
  // `to` is English-only and uncapped on the pinyin side, so nothing may be lost.
  it.each([
    ['da', false],
    ['to', true],
  ] as const)('%s', async (query, containment) => {
    const mine = await pages(query, (q, options) => store.search(q, options));
    const theirs = goldenSearch.paging[query];
    expect(theirs, `${query} has no frozen paging walk in golden/search.json`).toBeDefined();

    process.stdout.write(
      `\npaging "${query}": store ${mine.pages} pages / ${mine.keys.length} groups / total ${mine.totals[0]}` +
        `; json ${theirs.pages} pages / ${theirs.keys.length} groups / total ${theirs.total}\n`,
    );

    // `total` is constant across the walk — it is the count before the page, not
    // after it. The frozen side carries one number for the same reason.
    expect(new Set(mine.totals).size).toBe(1);
    // The walk visits every group exactly once, reaches all of them, and stops.
    expect(new Set(mine.keys).size).toBe(mine.keys.length);
    expect(mine.keys.length).toBe(mine.totals[0]);
    expect(mine.pages).toBeLessThan(MAX_PAGES);
    if (containment) {
      const seen = new Set(mine.keys);
      const lost = theirs.keys.filter((key) => !seen.has(key));
      expect(lost).toEqual([]);
    }
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The round-trip budget (criterion 8)
// ---------------------------------------------------------------------------

describe('the budget still holds with the English half in', () => {
  it('an English query is two round trips', async () => {
    expect((await spied((instance) => instance.search('plan'))).length).toBe(2);
    expect((await spied((instance) => instance.search('to plan'))).length).toBe(2);
  });

  it('a pinyin query runs both sections in the SAME two round trips', async () => {
    const batches = await spied((instance) => instance.search('sun'));
    expect(batches.length).toBe(2);
    // The pinyin statements and the gloss statements are in one array, which is
    // the whole point of a batch: on the Capacitor bridge each array is one JSON
    // round trip, not one per statement.
    const first = batches[0];
    expect(first.filter((statement) => statement.sql.includes('gloss_fts')).length).toBeGreaterThan(0);
    expect(first.filter((statement) => statement.sql.includes('py_toneless')).length).toBeGreaterThan(0);
  });

  it('isGlossToken rides in the search batch and does not raise the count', async () => {
    // It runs only for a single Latin token of three letters or more, so `sun`
    // has it and `to plan` does not — and neither costs a third trip.
    const withToken = await spied((instance) => instance.search('sun'));
    const withoutToken = await spied((instance) => instance.search('to plan'));
    expect(withToken.length).toBe(2);
    expect(withoutToken.length).toBe(2);
    const glossStatements = (batches: SqlQuery[][]) =>
      batches[0].filter((statement) => statement.sql.includes('gloss_fts MATCH')).length;
    // `sun`: ONE statement. The ranked path matches `"sun"` and the gloss-token
    // probe wants `"sun"` too, so the probe reads the ranked statement's result
    // rather than running a second 5,000-row scan per keystroke.
    expect(glossStatements(withToken)).toBe(1);
    // `to plan`: two lemmatised words, one ranked statement, no gloss-token probe.
    expect(glossStatements(withoutToken)).toBe(1);
    // …and where the two genuinely differ, both statements are there: `women`
    // lemmatises to `woman` for the ranked path while the probe keeps the raw
    // token's forms, `{women, woman}`.
    const irregular = await spied((instance) => instance.search('women'));
    expect(glossStatements(irregular)).toBe(2);
  });

  it('segmentation is two round trips whatever the passage length', async () => {
    const short = await spied((instance) => instance.segment('我打算明天去北京'));
    const long = await spied((instance) =>
      instance.segment(
        '我打算明天去北京看望我的朋友他在那里工作了很多年我们已经好久没有见面了这次我想和他一起去长城看看顺便尝尝北京的烤鸭和炸酱面真是让人期待',
      ),
    );
    expect(short.length).toBe(2);
    expect(long.length).toBe(2);
    // One statement per script per chunk, and never `word IN (…)` across both
    // scripts in one statement — that form cannot use the `(script, word)`
    // primary key and measured 45.7 ms against 1.8 ms. See HANDOFF.md, D3.
    expect(long[0].length).toBeGreaterThanOrEqual(2);
    expect(long[0].length % 2).toBe(0);
    for (const statement of long[0]) expect(statement.sql).toMatch(/script = \? AND word IN/);
  });

  it('segments a 20,000-character passage — the route’s documented limit', async () => {
    // The deleted segment route set `MAX_TEXT_CHARS = 20_000` and its header
    // said the reader posts whole paragraphs, so that is the contract the store
    // inherited. Before the `IN (…)` lists were chunked this threw a raw
    // `too many SQL variables` at about 2,100 hanzi: `candidateSubstrings` is
    // Θ(16n) and SQLite's parameter ceiling is a compile-time option that
    // differs between the three runtimes this store has to run on.
    const text = longPassage(20_000);
    const batches = await spied(async (instance) => {
      const result = await instance.segment(text);
      expect(result.tokens.length).toBeGreaterThan(5_000);
      // …and it is the same segmentation the JSON implementation gives — twice
      // over: against the live oracle (`scripts/dict-json.ts`, which `pnpm data`
      // still runs) and against the digest frozen before D6, which is what would
      // catch the JSON side itself having moved.
      expect(result.tokens).toEqual(jsonSegment(text).tokens);
      expect(sha256(text)).toBe(goldenSearch.longPassage.textSha256);
      expect(result.tokens.length).toBe(goldenSearch.longPassage.tokenCount);
      expect(sha256(JSON.stringify(result.tokens))).toBe(goldenSearch.longPassage.tokensSha256);
    });
    // Still two round trips. The chunks ride in the same batch, which is the
    // whole reason chunking is free here.
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBeGreaterThan(2);
  }, 120_000);

  it('a passage with no hanzi spends no trip on candidates', async () => {
    const batches = await spied((instance) => instance.segment('hello, world!'));
    expect(batches.length).toBe(0);
  });
});
