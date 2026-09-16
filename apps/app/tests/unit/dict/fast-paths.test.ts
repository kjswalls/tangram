/**
 * The two fast paths, proved against the whole built dictionary
 * (docs/plans/data.md D6).
 *
 * `readingKeys` is a fast spelling of `normalizePinyin` for the one shape the
 * dictionary's own pinyin always has, and `glossTokens` is one scan where there
 * used to be four passes. Both are *optimisations of something that already
 * worked*, and the only honest way to check an optimisation is against the thing
 * it replaced, over everything — a function that is right about 124,000 readings
 * and wrong about the 125th is a word that quietly stops being findable, which
 * is the one bug a learner cannot diagnose.
 *
 * ## Why this file exists, and why that is a correction
 *
 * These two cases lived in `tests/unit/server/cold-start.test.ts`, whose third
 * describe block was about `LazyDictIndex`'s build order. `data.md` D6's
 * disposition table says that file may be deleted — but **only** because "D1
 * already carries its two load-bearing properties … re-asserted against the
 * artifact". **That is not true, and this phase deleted the file on the strength
 * of it before an adversarial reviewer caught the error.**
 *
 * `scripts/verify-data.ts` does check the artifact's `py_toneless`/`py_toned`
 * columns and its `gloss_fts` posting lists — but it computes what it expects
 * with `readingKeys(…) ?? normalizePinyin(…)` and `glossTokens(gloss)`, which is
 * the *same expression* `scripts/build-data.ts` wrote them with. That comparison
 * can catch a SQL or insert bug and can never catch a wrong `readingKeys`: both
 * sides are the function under test. Deleting these two cases would have left a
 * change to either function green through `pnpm test`, green through
 * `pnpm data:verify`, and wrong in the artifact on every platform.
 *
 * So they move here, beside the functions they are about, which is where they
 * always belonged: neither has anything to do with a route, a loader or a cold
 * start. The build-order block did die with `LazyDictIndex`, exactly as D6 says.
 * The dictionary comes through `json-oracle.ts`, which reads `data/dict.json` —
 * still emitted, still the build's input — so both are live differentials rather
 * than frozen answers.
 */
import { describe, expect, it } from 'vitest';

import { glossTokens, stemToken } from '@/lib/dict/rank';
import { hasUnknownReading, normalizePinyin, readingKeys } from '@/lib/dict/pinyin';
import { getDict } from './json-oracle';
import { requireDictData } from './data-required';

requireDictData();

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
