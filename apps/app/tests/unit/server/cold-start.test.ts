/**
 * The cold-start work: the dictionary indexes are built lazily, and the two
 * fast paths inside them answer exactly what the slow ones did.
 *
 * Both halves are *proved against the built dictionary*, not against a handful
 * of chosen examples. A faster spelling of a function that is right about 124k
 * readings and wrong about the 125th is a word that quietly stops being
 * findable, which is the one bug a learner cannot diagnose.
 */
import { describe, expect, it } from 'vitest';

import {
  builtIndexParts,
  getDictIndex,
  glossTokens,
  hskBand,
  stemToken,
} from '@/lib/dict/index';
import { getDict, resetDictCache } from '@/lib/dict/load';
import { hasUnknownReading, normalizePinyin, readingKeys } from '@/lib/dict/pinyin';
import { search } from '@/lib/dict/search';
import { segment } from '@/lib/dict/segment';

describe('readingKeys — the fast path over the dictionary’s own pinyin', () => {
  // Generous timeouts: these walk the whole 124k-entry dictionary, and the
  // suite runs on a box shared with the other builders.
  it('agrees with the query parser on every reading in the built dictionary', () => {
    let checked = 0;
    let fellBack = 0;
    const disagreements: string[] = [];

    for (const entry of getDict().entries) {
      if (hasUnknownReading(entry.pinyinNum)) continue;
      checked += 1;
      const fast = readingKeys(entry.pinyinNum);
      if (fast === null) {
        fellBack += 1;
        continue;
      }
      const slow = normalizePinyin(entry.pinyinNum);
      if (fast.toneless !== slow.toneless || fast.toned !== slow.toned) {
        if (disagreements.length < 5) {
          disagreements.push(
            `${entry.pinyinNum}: fast ${fast.toneless}/${fast.toned} · slow ${slow.toneless}/${slow.toned}`,
          );
        }
      }
    }

    expect(disagreements).toEqual([]);
    expect(checked).toBeGreaterThan(100_000);
    // A few hundred readings carry a bare Latin letter (`san1 C`, `A quan1 r5`)
    // and take the slow path. If this ever becomes "most of them", the
    // optimisation has stopped being one and the number should say so.
    expect(fellBack).toBeLessThan(checked / 100);
  }, 60_000);

  it('declines rather than guessing on anything that is not numbered pinyin', () => {
    expect(readingKeys('A quan1 r5')).toBeNull();
    expect(readingKeys('san1 C')).toBeNull();
    expect(readingKeys('')).toBeNull();
    expect(readingKeys('dasuan')).toBeNull();
    // And answers what the parser answers on the shapes it does take.
    expect(readingKeys('da3 suan4')).toEqual({ toneless: 'dasuan', toned: 'da3suan4' });
    expect(readingKeys('lu:4')).toEqual({ toneless: 'lu', toned: 'lu4' });
    // The neutral tone contributes no digit: a learner typing `wǒmen` must land
    // on the same key as the dictionary's `wo3 men5`.
    expect(readingKeys('wo3 men5')).toEqual({ toneless: 'women', toned: 'wo3men' });
  });
});

describe('glossTokens — one scan instead of four passes', () => {
  /** The implementation this replaced, kept here as the oracle. */
  function reference(gloss: string): string[] {
    const tokens = gloss
      .toLowerCase()
      .replace(/[^a-z0-9']+/g, ' ')
      .split(' ')
      .map((token) => stemToken(token.replace(/^'+|'+$/g, '')))
      .filter(Boolean);
    return [...new Set(tokens)];
  }

  it('answers identically for every gloss in the built dictionary', () => {
    let glosses = 0;
    const disagreements: string[] = [];
    for (const entry of getDict().entries) {
      for (const gloss of entry.glosses) {
        glosses += 1;
        const fast = glossTokens(gloss);
        const slow = reference(gloss);
        if (fast.length !== slow.length || fast.some((token, i) => token !== slow[i])) {
          if (disagreements.length < 5) disagreements.push(gloss);
        }
      }
    }
    expect(disagreements).toEqual([]);
    expect(glosses).toBeGreaterThan(100_000);
  }, 60_000);

  it('still strips edge apostrophes, dedupes and keeps order', () => {
    expect(glossTokens("to plan; 'plans' (CL)")).toEqual(reference("to plan; 'plans' (CL)"));
    // An apostrophe inside a word belongs to it; only the edges are punctuation.
    expect(glossTokens("don't")).toEqual(["don't"]);
    expect(glossTokens("'''")).toEqual([]);
    expect(glossTokens('')).toEqual([]);
  });
});

describe('the indexes are built one at a time', () => {
  it('builds only what the route in front of it asked for', () => {
    // One walk through a fresh cache, because reopening it costs a 33 MB parse
    // each time. The order is the order a deployment meets these routes in.
    resetDictCache();
    expect(builtIndexParts()).toEqual([]);

    // Nothing is built by asking for the index itself.
    getDictIndex();
    expect(builtIndexParts()).toEqual([]);

    // /api/dict/hsk — the Today page's first request. It must not build the
    // 47,000-key English inverted index it will never read.
    hskBand(1);
    expect(builtIndexParts()).toEqual(['sorted', 'entries', 'hsk']);

    // /api/dict/segment adds the hanzi maps and nothing else.
    segment('我们今天去北京');
    expect(builtIndexParts()).toEqual(['sorted', 'entries', 'hanzi', 'hsk']);

    // An English query is what finally pays for the gloss index.
    search('plan', { limit: 5 });
    expect(builtIndexParts()).toContain('gloss');

    // A pinyin query is the one that needs everything.
    search('dasuan', { limit: 5 });
    expect(builtIndexParts()).toEqual(['sorted', 'entries', 'hanzi', 'pinyin', 'gloss', 'hsk']);
  }, 60_000);

  it('answers the same as it always did once everything is built', () => {
    const index = getDictIndex();
    expect(index.entries.size).toBe(getDict().entries.length);
    expect(index.bySimp.get('学习')).toContain('學習|学习[xue2 xi2]');
    expect(index.byTrad.get('學習')).toContain('學習|学习[xue2 xi2]');
    expect(index.byPinyinToneless.keys).toEqual([...index.byPinyinToneless.keys].sort());
    expect(index.byPinyinToned.keys).toEqual([...index.byPinyinToned.keys].sort());
    expect((index.byHsk.get(1) ?? []).length).toBeGreaterThan(0);
    expect(index.byGloss.size).toBeGreaterThan(10_000);
    // Same object across calls, so the WeakMaps in search.ts and segment.ts
    // that key on it keep their caches.
    expect(getDictIndex()).toBe(index);
  }, 60_000);
});
