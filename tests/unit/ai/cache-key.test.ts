/**
 * The ask cache key (PLAN.md §3.4).
 *
 * The load-bearing assertion is the last one. The demo seed writes its warm
 * rows through *this* function now (the second derivation it used to carry is
 * gone), but it passes its context as a bare string while the ask panel arrives
 * with a `CardContext`. Both have to land on the same row, or the seed's warm
 * rows are orphans no ask will ever find.
 */
import { describe, expect, it } from 'vitest';

import {
  ASK_PROMPT_VERSION,
  EXAMPLES_PROMPT_VERSION,
  RECALL_PROMPT_VERSION,
  askCacheKey,
  askCachePayload,
  askContextKey,
  examplesCacheKey,
  examplesCachePayload,
  recallCacheKey,
  recallCachePayload,
} from '@/lib/ai/cache-key';
import { sha1Hex } from '@/lib/dev/sha1';

const BASE = { query: 'how do I say I am just browsing', estimatedBand: 2 };

describe('askCacheKey', () => {
  it('is a sha1 hex digest and is deterministic', async () => {
    const key = await askCacheKey(BASE);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    expect(await askCacheKey(BASE)).toBe(key);
  });

  it('agrees with the dependency-free implementation, whichever ran', async () => {
    // Web Crypto answers in the browser; `sha1Hex` answers under jsdom. A row
    // written by one has to be found by the other.
    expect(await askCacheKey(BASE)).toBe(sha1Hex(askCachePayload(BASE)));
  });

  it('changes with the context', async () => {
    const bare = await askCacheKey({ query: '看', estimatedBand: 2 });
    const oneSentence = await askCacheKey({
      query: '看',
      context: { sentence: '我看了一下' },
      estimatedBand: 2,
    });
    const otherSentence = await askCacheKey({
      query: '看',
      context: { sentence: '你看着孩子' },
      estimatedBand: 2,
    });

    expect(new Set([bare, oneSentence, otherSentence]).size).toBe(3);
  });

  it('ignores the parts of a context that cannot change the answer', async () => {
    // Two taps on the same word in the same sentence are one question.
    const first = await askCacheKey({
      query: '看',
      context: { sentence: '我看了一下', offset: 1, length: 1 },
      estimatedBand: 2,
    });
    const second = await askCacheKey({
      query: '看',
      context: { sentence: '我看了一下', offset: 9, length: 1 },
      estimatedBand: 2,
    });
    expect(first).toBe(second);
  });

  it('keys over every field the prompt is given, not just the first one set', async () => {
    // `contextBlock` sends the sentence, the question *and* the query, so two
    // asks that differ in any of them are two questions — collapsing to the
    // first non-empty field served one answer for both.
    const keys = await Promise.all(
      [
        { sentence: '你看着孩子' },
        { question: '你看着孩子' },
        { sentence: '你看着孩子', question: 'which reading is this?' },
        { sentence: '你看着孩子', query: '看' },
      ].map((context) => askCacheKey({ query: '看', context, estimatedBand: 2 })),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('changes with the band, the provider and the prompt version', async () => {
    const base = await askCacheKey(BASE);
    expect(await askCacheKey({ ...BASE, estimatedBand: 3 })).not.toBe(base);
    expect(await askCacheKey({ ...BASE, provider: 'anthropic' })).not.toBe(base);
    expect(await askCacheKey({ ...BASE, promptVersion: 'v2' })).not.toBe(base);
  });

  it('reads a context as the tuple the prompt sees', () => {
    expect(askContextKey(undefined)).toBe('');
    expect(askContextKey({})).toBe('');
    // A bare string is the seed's shape and means the sentence.
    expect(askContextKey('已经是字符串')).toBe(askContextKey({ sentence: '已经是字符串' }));
    expect(askContextKey({ sentence: 'a', question: 'b' })).not.toBe(askContextKey({ sentence: 'a' }));
    expect(askContextKey({ question: 'b' })).not.toBe(askContextKey({ sentence: 'b' }));
    expect(askContextKey({ query: 'c' })).not.toBe(askContextKey({ question: 'c' }));
  });
});

describe('the demo seed’s warm rows', () => {
  it('key the same whether the context is a bare string or a CardContext', async () => {
    // The two rows `loadDemo` pre-warms, with the context in the shape the seed
    // stores it and in the shape a panel would arrive with.
    const cases = [
      { query: "how do I say I'm just browsing", context: undefined, estimatedBand: 2 },
      { query: '开始', context: '我们开始吧', estimatedBand: 2 },
    ] as const;

    for (const input of cases) {
      const seeded = await askCacheKey({
        query: input.query,
        ...(input.context === undefined ? {} : { context: input.context }),
        estimatedBand: input.estimatedBand,
      });
      const fromPanel = await askCacheKey({
        query: input.query,
        ...(input.context === undefined
          ? {}
          : { context: { sentence: input.context } }),
        estimatedBand: input.estimatedBand,
      });
      expect(fromPanel).toBe(seeded);
      expect(seeded).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('are written under the current prompt version, so a bump retires them', () => {
    expect(ASK_PROMPT_VERSION).toBe('v1');
    expect(askCachePayload({ query: 'q', estimatedBand: 2 })).toBe(
      JSON.stringify([ASK_PROMPT_VERSION, 'fake', 'q', '', 2]),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — three key spaces, one `ask_cache` table
// ---------------------------------------------------------------------------

describe('the examples and recall keys', () => {
  const ENTRY_ID = '打算|打算[da3 suan4]';

  it('are sha1 digests of a tagged payload, and agree with the sync fallback', async () => {
    const examples = { entryId: ENTRY_ID, estimatedBand: 2 };
    const recall = { entryId: ENTRY_ID, answer: 'to plan' };

    expect(await examplesCacheKey(examples)).toMatch(/^[0-9a-f]{40}$/);
    expect(await examplesCacheKey(examples)).toBe(sha1Hex(examplesCachePayload(examples)));
    expect(await recallCacheKey(recall)).toBe(sha1Hex(recallCachePayload(recall)));

    expect(JSON.parse(examplesCachePayload(examples))[0]).toBe('examples');
    expect(JSON.parse(recallCachePayload(recall))[0]).toBe('recall');
  });

  it('cannot collide with an ask key, or with each other', async () => {
    // The three caches share one table. Nothing about the inputs may make two
    // of them land on the same row — the tag and the payload length are what
    // guarantee it, rather than the improbability of a hash collision.
    const keys = await Promise.all([
      askCacheKey({ query: ENTRY_ID, estimatedBand: 2 }),
      examplesCacheKey({ entryId: ENTRY_ID, estimatedBand: 2 }),
      recallCacheKey({ entryId: ENTRY_ID, answer: ENTRY_ID }),
    ]);
    expect(new Set(keys).size).toBe(3);

    const payloads = [
      askCachePayload({ query: ENTRY_ID, estimatedBand: 2 }),
      examplesCachePayload({ entryId: ENTRY_ID, estimatedBand: 2 }),
      recallCachePayload({ entryId: ENTRY_ID, answer: ENTRY_ID }),
    ];
    expect(new Set(payloads).size).toBe(3);
  });

  it('change with everything the prompt sees, and nothing else', async () => {
    const base = { entryId: ENTRY_ID, estimatedBand: 2 };
    const varied = await Promise.all([
      examplesCacheKey(base),
      examplesCacheKey({ ...base, senseIndex: 0 }),
      examplesCacheKey({ ...base, senseIndex: 1 }),
      examplesCacheKey({ ...base, estimatedBand: 3 }),
      examplesCacheKey({ ...base, provider: 'anthropic' }),
      examplesCacheKey({ ...base, promptVersion: 'v2' }),
    ]);
    expect(new Set(varied).size).toBe(6);

    // Case and spacing are not what a learner meant, so they do not re-ask.
    const typed = await recallCacheKey({ entryId: ENTRY_ID, answer: '  To  PLAN ' });
    expect(typed).toBe(await recallCacheKey({ entryId: ENTRY_ID, answer: 'to plan' }));
    expect(typed).not.toBe(await recallCacheKey({ entryId: ENTRY_ID, answer: 'to intend' }));
  });

  it('keeps a version per prompt, so one bump does not retire the other two', () => {
    expect(EXAMPLES_PROMPT_VERSION).toMatch(/^v\d+$/);
    expect(RECALL_PROMPT_VERSION).toMatch(/^v\d+$/);
    expect(ASK_PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
