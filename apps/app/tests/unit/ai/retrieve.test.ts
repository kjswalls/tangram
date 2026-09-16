// @vitest-environment node
/**
 * `lib/ai/retrieve.ts` against the route's originals (docs/plans/data.md D3,
 * criterion 9).
 *
 * Two things are being proved. First, that the ported `mergedSearch` and
 * `candidateEntries` return the same entries, in the same order, as
 * `app/api/ask/route.ts`'s — which is why those two are exported from the route
 * until D6 deletes them, rather than re-implemented here as an oracle that could
 * be wrong in the same way.
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

import { candidateEntries as routeCandidateEntries, mergedSearch as routeMergedSearch } from '@/app/api/ask/route';
import { ground } from '@tangram/ai/ground';
import {
  candidateEntries,
  groundWithStore,
  mergeRetrieved,
  mergedSearch,
} from '@tangram/ai/retrieve';
import { getEntry, readingCount } from '@/lib/dict/index';
import { nodeRunner } from '@/lib/dict/runners/node';
import { segment } from '@/lib/dict/segment';
import { SqliteDictStore } from '@/lib/dict/sqlite-store';
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
    expect(ids(await mergedSearch(store, query))).toEqual(ids(routeMergedSearch(query)));
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

  it.each(PHRASES.map((phrases) => [phrases] as const))('%j', async (phrases) => {
    expect(ids(await candidateEntries(store, phrases))).toEqual(ids(routeCandidateEntries(phrases)));
  });
});

describe('mergeRetrieved', () => {
  it('takes the search head, then the proposals, then the rest, to the cap', async () => {
    for (const query of ASK_QUERIES.slice(0, 8)) {
      const fromSearch = await mergedSearch(store, query);
      const fromCandidates = await candidateEntries(store, ['我随便看看', '这个多少钱']);
      const mine = mergeRetrieved(fromSearch, fromCandidates);
      const theirs = mergeRetrieved(routeMergedSearch(query), routeCandidateEntries(['我随便看看', '这个多少钱']));
      expect(ids(mine)).toEqual(ids(theirs));
      expect(mine.length).toBeLessThanOrEqual(40);
    }
  });
});

// ---------------------------------------------------------------------------
// The synchronous/asynchronous seam
// ---------------------------------------------------------------------------

/** The route's `GroundContext`, built the way `app/api/ask/route.ts` builds it. */
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
