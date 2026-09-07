/**
 * The ask cache key (PLAN.md §3.4).
 *
 * The load-bearing assertion is the last one: this derivation and
 * `demoAskCacheKey` in `lib/dev/seed.ts` must produce the same string, or the
 * demo seed's two pre-warmed rows are orphans that no ask will ever find.
 */
import { describe, expect, it } from 'vitest';

import { ASK_PROMPT_VERSION, askCacheKey, askCachePayload, askContextKey } from '@/lib/ai/cache-key';
import { DEMO_PROMPT_VERSION, demoAskCacheKey } from '@/lib/dev/seed';
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
      context: { sentence: '我看了一下', offset: 9, length: 1, query: '看' },
      estimatedBand: 2,
    });
    expect(first).toBe(second);
  });

  it('changes with the band, the provider and the prompt version', async () => {
    const base = await askCacheKey(BASE);
    expect(await askCacheKey({ ...BASE, estimatedBand: 3 })).not.toBe(base);
    expect(await askCacheKey({ ...BASE, provider: 'anthropic' })).not.toBe(base);
    expect(await askCacheKey({ ...BASE, promptVersion: 'v2' })).not.toBe(base);
  });

  it('reads a context down to the field that carries the question', () => {
    expect(askContextKey(undefined)).toBe('');
    expect(askContextKey('已经是字符串')).toBe('已经是字符串');
    expect(askContextKey({ sentence: 'a', question: 'b' })).toBe('a');
    expect(askContextKey({ question: 'b' })).toBe('b');
    expect(askContextKey({ query: 'c' })).toBe('c');
  });
});

describe('the demo seed’s warm rows', () => {
  it('is keyed exactly as `demoAskCacheKey` keys them', async () => {
    expect(ASK_PROMPT_VERSION).toBe(DEMO_PROMPT_VERSION);

    const cases = [
      { query: "how do I say I'm just browsing", context: undefined, estimatedBand: 2 },
      { query: '开始', context: '我们开始吧', estimatedBand: 2 },
    ] as const;

    for (const input of cases) {
      const seeded = demoAskCacheKey({
        query: input.query,
        ...(input.context === undefined ? {} : { context: input.context }),
        estimatedBand: input.estimatedBand,
      });
      const derived = await askCacheKey({
        query: input.query,
        ...(input.context === undefined ? {} : { context: { sentence: input.context } }),
        estimatedBand: input.estimatedBand,
      });
      expect(derived).toBe(seeded);
    }
  });
});
