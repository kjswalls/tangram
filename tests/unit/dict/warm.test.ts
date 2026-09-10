/**
 * `warmDictionary()` — the thing that decides whether the first lookup of a
 * session costs a second or nothing.
 *
 * The assertions are about **work done**, never about wall clock. A threshold in
 * milliseconds is exactly the test that goes green on a quiet box and red on a
 * shared CI runner, and the property that matters here is not "fast" but "there is
 * nothing left to build" — which is observable, and is what makes it fast.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { builtIndexParts, DICT_INDEX_PARTS, getDictIndex } from '@/lib/dict/index';
import { resetDictCache } from '@/lib/dict/load';
import { headwordsWarm, search, warmHeadwords } from '@/lib/dict/search';
import { segment, segmentStatsWarm, warmSegmentStats } from '@/lib/dict/segment';
import { dictionaryWarm, warmDictionary } from '@/lib/dict/warm';
import { requireDictData } from './data-required';

const ALL_PARTS = [...DICT_INDEX_PARTS];

describe('warmDictionary', () => {
  /** The first test's result, so the second can check it is handed back as-is. */
  let first: Awaited<ReturnType<typeof warmDictionary>>;

  beforeAll(requireDictData);

  it('finishes the job the banner’s probe starts', async () => {
    // The state a real instance is in when the warm-up runs: the HEAD probe has
    // already built the parts `hsk` needs, and nothing else.
    resetDictCache();
    void getDictIndex().byHsk;
    expect(builtIndexParts()).toEqual(['sorted', 'entries', 'hsk']);

    const result = await warmDictionary();
    first = result;

    // It reports what it built, not what it touched — the three parts the probe
    // had already paid for are in `alreadyBuilt`.
    expect(result.alreadyBuilt).toEqual(['sorted', 'entries', 'hsk']);
    expect(result.built).toEqual(['hanzi', 'pinyin', 'gloss']);
    expect(result.caches).toEqual(['headwords', 'segment-stats']);
    expect(builtIndexParts()).toEqual(ALL_PARTS);

    // And the two caches that are not index parts, which are the whole reason
    // this function exists rather than a loop over `DICT_INDEX_PARTS`.
    const index = getDictIndex();
    expect(headwordsWarm(index)).toBe(true);
    expect(segmentStatsWarm(index)).toBe(true);
    expect(dictionaryWarm()).toBe(true);

    // The two calls a session actually makes first now have nothing left to
    // build: they answer, and `builtIndexParts()` is unchanged afterwards.
    expect(search('dasuan', { limit: 5 }).groups.length).toBeGreaterThan(0);
    expect(segment('我们今天去北京').tokens.length).toBeGreaterThan(0);
    expect(builtIndexParts()).toEqual(ALL_PARTS);
    expect(warmHeadwords(index)).toBe(false);
    expect(warmSegmentStats(index)).toBe(false);
  }, 120_000);

  it('is cheap and idempotent once everything is warm', async () => {
    // No reset: this rides on the previous test's warm process, which is the
    // state every call after the first one is made in. The settled promise is
    // kept, so a repeat call is one WeakMap lookup and hands back the *same*
    // result — which is a stronger statement than "it rebuilt nothing quickly".
    const again = await warmDictionary();
    expect(again).toBe(first);
    expect(builtIndexParts()).toEqual(ALL_PARTS);
    expect(dictionaryWarm()).toBe(true);
  }, 60_000);

  it('does the work once when two callers overlap', async () => {
    // The real race: the banner's probe schedules a warm-up while a request that
    // also warms lands on the same instance. Building the 47,000-key gloss index
    // twice would double the pause it exists to remove.
    resetDictCache();
    expect(builtIndexParts()).toEqual([]);

    const first = warmDictionary();
    const second = warmDictionary();
    // One in-flight promise, so there is only one traversal to be had.
    expect(second).toBe(first);

    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);
    // Both callers see one full build credited to that single run.
    expect(a.built).toEqual(ALL_PARTS);
    expect(a.caches).toEqual(['headwords', 'segment-stats']);
    expect(dictionaryWarm()).toBe(true);
  }, 120_000);

  it('yields between parts, so a request landing mid-warm-up is served', async () => {
    resetDictCache();
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 1);

    await warmDictionary();
    clearInterval(timer);

    // A fully synchronous warm-up would hold the loop for ~2 s and the timer
    // would never fire. The count is not a latency claim — it is the proof that
    // the loop was handed back at all.
    expect(ticks).toBeGreaterThan(0);
  }, 120_000);
});
