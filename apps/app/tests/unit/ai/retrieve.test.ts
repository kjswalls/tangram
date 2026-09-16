// @vitest-environment node
/**
 * `lib/ai/retrieve.ts` against the route's originals (docs/plans/data.md D3,
 * criterion 9).
 *
 * Two things are being proved. First, that the ported `mergedSearch` and
 * `candidateEntries` return the same entries, in the same order, as
 * `app/api/ask/route.ts`'s did — the route's copies were exported for exactly
 * this comparison rather than re-implemented here as an oracle that could be
 * wrong in the same way, and **`data.md` D6 deleted them**. What they answered
 * for the two query lists below was frozen first, on the commit before, and the
 * comparison now reads `golden/retrieve.json`. `../dict/golden.test.ts` is what
 * fails, by itself and by name, if the dictionary moves under that fixture.
 *
 * Second, and this is the harder half, that the synchronous/asynchronous seam
 * holds: `GroundContext.segment` is `(text: string) => Token[]` and
 * `DictStore.segment` is a promise, and the resolution must not be to make
 * `ground.ts` async. The rules in `ground.ts` are the product's core promise —
 * PLAN.md §3.4, the dictionary is ground truth and the model never emits a
 * headword for display — and `tests/unit/ai/ground.test.ts` and `attacks.test.ts`
 * encode them. **`ground.ts` is unmodified by this phase**, and this file proves
 * the grounded answer is identical whichever way the dictionary was reached.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ground } from '@tangram/ai/ground';
import {
  candidateEntries,
  groundWithStore,
  mergeRetrieved,
  mergedSearch,
} from '@tangram/ai/retrieve';
import { nodeRunner } from '@/lib/dict/runners/node';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
import { goldenRetrieve } from '../dict/golden';
import { getEntry, readingCount, segment } from '../dict/json-oracle';
import type { GroundContext, RawAskResponse } from '@tangram/ai/ground';
import type { DictStore } from '@/lib/dict/store';
import type { Entry } from '@/lib/types';
import { dictArtifactPath, requireDictData } from '../dict/data-required';

requireDictData();

let store: SqliteDictStore;

beforeAll(async () => {
  store = new SqliteDictStore({ connect: async () => nodeRunner(dictArtifactPath()) });
  await store.open();
});

afterAll(async () => {
  await store.close();
});

const ids = (entries: readonly Entry[]): string[] => entries.map((entry) => entry.id);

/** Ask-shaped queries: English sentences, single words, hanzi, and a mixed one. */
const ASK_QUERIES = [
  'how do I say I am just browsing',
  'what does this mean',
  'how do you say thank you in Chinese',
  'I would like to order the beef noodles',
  'is this seat taken',
  'where is the nearest subway station',
  'plan',
  'water',
  'tomorrow',
  'expensive',
  'beautiful',
  '打算',
  '我打算明天去北京',
  '学习',
  '中华人民共和国',
  '你好吗',
  '这个多少钱',
  'how do I say 打算',
  'what is 学习',
  'the difference between 二 and 两',
  'zzzqqqnothing',
  '',
];

describe('mergedSearch — the ported retrieval matches the route’s', () => {
  it.each(ASK_QUERIES)('%j', async (query) => {
    const frozen = goldenRetrieve.mergedSearch[query];
    expect(frozen, `${JSON.stringify(query)} has no frozen answer in golden/retrieve.json`).toBeDefined();
    expect(ids(await mergedSearch(store, query))).toEqual(frozen);
  });

  it('covers every query the fixture froze, and no more', () => {
    // Both directions. A query dropped from `ASK_QUERIES` would otherwise leave
    // a frozen answer nothing reads, and a query added without regenerating the
    // fixture would fail above — but only as "undefined", which reads like a
    // typo rather than like a missing freeze.
    expect([...ASK_QUERIES].sort()).toEqual(Object.keys(goldenRetrieve.mergedSearch).sort());
  });
});

describe('candidateEntries — every token of every proposed phrase, in phrase order', () => {
  const PHRASES = [
    ['我随便看看'],
    ['我打算明天去北京', '这个多少钱'],
    ['谢谢', '不客气', '对不起'],
    ['学习中文很有意思'],
    // The cap: only the first eight phrases are used, and each is cut to 40 chars.
    ...[Array.from({ length: 12 }, (_, i) => `第${i}个句子测试`)],
    ['   ', ''],
    ['a'.repeat(80)],
    ['我'.repeat(60)],
  ];

  it.each(PHRASES.map((phrases, index) => [phrases, index] as const))('%j', async (phrases, index) => {
    const frozen = goldenRetrieve.candidateEntries[index];
    expect(frozen, `phrase set ${index} has no frozen answer`).toBeDefined();
    expect(frozen.phrases, `phrase set ${index} drifted from the fixture`).toEqual(phrases);
    expect(ids(await candidateEntries(store, phrases))).toEqual(frozen.ids);
  });

  it('covers every phrase set the fixture froze', () => {
    expect(PHRASES.length).toBe(goldenRetrieve.candidateEntries.length);
  });
});

describe('mergeRetrieved', () => {
  it('takes the search head, then the proposals, then the rest, to the cap', async () => {
    // `mergeRetrieved` is pure and shared — the route imports the same function
    // now — so the thing worth asserting is the merge's own rule rather than a
    // second call to it. The inputs are the frozen ones, so the assertion is
    // still anchored to what the JSON pipeline retrieved.
    const proposals = goldenRetrieve.candidateEntries[1];
    const fromCandidates = await candidateEntries(store, proposals.phrases);
    expect(ids(fromCandidates)).toEqual(proposals.ids);

    for (const query of ASK_QUERIES.slice(0, 8)) {
      const fromSearch = await mergedSearch(store, query);
      expect(ids(fromSearch)).toEqual(goldenRetrieve.mergedSearch[query]);
      const merged = mergeRetrieved(fromSearch, fromCandidates);
      expect(merged.length).toBeLessThanOrEqual(40);
      // The head of the search leads, then the proposals, then the rest.
      const head = ids(fromSearch).slice(0, Math.min(16, merged.length));
      expect(ids(merged).slice(0, head.length)).toEqual(head);
      for (const id of proposals.ids.slice(0, 40 - head.length)) {
        expect(ids(merged)).toContain(id);
      }
      expect(new Set(ids(merged)).size).toBe(merged.length);
    }
  });
});

// ---------------------------------------------------------------------------
// The synchronous/asynchronous seam
// ---------------------------------------------------------------------------

/**
 * The `GroundContext` the route used to build, over the JSON index.
 *
 * It is the oracle for the fixed point below: `groundWithStore` reaches the same
 * grounded answer asynchronously, and this is the synchronous one it has to
 * match. The index is `scripts/dict-json.ts`'s — alive because `pnpm data`
 * builds the artifact out of it — so this comparison stayed differential through
 * D6 instead of becoming a fixture.
 */
function routeContext(retrieved: readonly Entry[]): GroundContext {
  return {
    retrieved,
    segment: (text) => segment(text).tokens,
    entry: (id) => getEntry(id),
    readings: readingCount,
  };
}

describe('groundWithStore — the same answer, reached asynchronously', () => {
  async function bothWays(raw: RawAskResponse, words: string[]): Promise<void> {
    const retrieved = await mergedSearch(store, words.join(' '));
    const mine = await groundWithStore(raw, store, retrieved);
    const theirs = ground(raw, routeContext(retrieved));
    expect(mine).toEqual(theirs);
  }

  it('grounds an answer whose citations are all in the retrieved set', async () => {
    const retrieved = await mergedSearch(store, '打算');
    const cited = retrieved[0];
    await bothWays(
      {
        interpretation: 'You are asking about making plans.',
        matches: [{ entryId: cited.id, senseIndex: 0, whyThisOne: 'the ordinary verb' }],
        sayIt: [{ tokens: [{ entryId: cited.id }], en: 'to plan', register: 'neutral' }],
        notes: ['A very common word.'],
      },
      ['打算'],
    );
  });

  it('drops a citation the model invented, exactly as the route does', async () => {
    await bothWays(
      {
        interpretation: 'Something about planning.',
        matches: [{ entryId: 'not|an[id]', senseIndex: 0, whyThisOne: 'invented' }],
        sayIt: [{ tokens: [{ entryId: 'also|not[real]' }], en: 'nope', register: 'neutral' }],
        notes: [],
      },
      ['打算'],
    );
  });

  it('flags a phrase built out of the model’s own text', async () => {
    const retrieved = await mergedSearch(store, '我随便看看');
    await bothWays(
      {
        interpretation: 'Browsing.',
        matches: [],
        sayIt: [
          {
            tokens: [{ text: '随' }, { text: '看' }, { text: '随' }, { text: '买' }],
            en: 'browsing and buying',
            register: 'colloquial',
          },
          { tokens: [{ entryId: retrieved[0]?.id ?? '' }], en: 'a real one', register: 'neutral' },
        ],
        notes: ['One note.'],
      },
      ['我随便看看'],
    );
  });

  it('handles a multi-token phrase mixing citations and text', async () => {
    const retrieved = await mergedSearch(store, '我打算明天去北京');
    const cited = retrieved.slice(0, 3).map((entry) => ({ entryId: entry.id }));
    await bothWays(
      {
        interpretation: 'A plan for tomorrow.',
        matches: retrieved.slice(0, 2).map((entry) => ({
          entryId: entry.id,
          senseIndex: 0,
          whyThisOne: 'cited',
        })),
        sayIt: [
          { tokens: [...cited, { text: '啊' }], en: 'tomorrow I plan to go', register: 'neutral' },
        ],
        notes: ['No CJK here.'],
      },
      ['我打算明天去北京'],
    );
  });

  it('answers an empty response the same way', async () => {
    await bothWays(
      { interpretation: '', matches: [], sayIt: [], notes: [] },
      ['打算'],
    );
  });

  it('converges rather than looping, even when every citation is unknown', async () => {
    // The fixed point closes because an id the dictionary does not have is
    // remembered as answered-no. Without that it would be re-requested every
    // round and the loop would run to its bound and throw.
    const retrieved = await mergedSearch(store, 'plan');
    const grounded = await groundWithStore(
      {
        interpretation: 'Invented.',
        matches: Array.from({ length: 8 }, (_, i) => ({
          entryId: `fake${i}|fake${i}[x]`,
          senseIndex: 0,
          whyThisOne: 'no',
        })),
        sayIt: [],
        notes: [],
      },
      store,
      retrieved,
    );
    expect(grounded.matches).toEqual([]);
  });

  it('closes even if ground() asks for an id the store cannot answer', async () => {
    // The case the `asked` set exists for, driven directly. `ground()` happens
    // to drop an id outside the retrieved set *before* asking, so this path is
    // not reachable through it today — which is why the guard is on the loop's
    // shape rather than on that behaviour. Here the store answers nothing at
    // all: if the guard were "did we find it" rather than "did we ask", the
    // fixed point would never close and this would throw.
    const blind: DictStore = {
      status: { state: 'ready', version: 'x' },
      subscribe: () => () => {},
      open: async () => {},
      entries: async () => [],
      search: (query, options) => store.search(query, options),
      segment: (text, options) => store.segment(text, options),
      hskBand: async () => [],
      readingCount: async () => 0,
      wordsContaining: async () => [],
    };
    const grounded = await groundWithStore(
      {
        interpretation: 'Nothing resolvable.',
        matches: [{ entryId: '打算|打算[da3 suan4]', senseIndex: 0, whyThisOne: 'cited' }],
        sayIt: [{ tokens: [{ text: '随' }, { text: '看' }], en: 'x', register: 'neutral' }],
        notes: [],
      },
      blind,
      [],
    );
    expect(grounded.matches).toEqual([]);
  });

  it('leaves ground.ts unmodified — the seam is entirely on this side', async () => {
    // Not a slogan: `ground` is imported here and called directly with a plain
    // synchronous context, which is only possible because its signature did not
    // change. If a later phase makes it async this line stops compiling.
    const context = routeContext([]);
    const result = ground({ interpretation: 'x', matches: [], sayIt: [], notes: [] }, context);
    expect(result.interpretation).toBe('x');
  });
});
