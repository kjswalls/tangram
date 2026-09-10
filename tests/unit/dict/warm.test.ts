/**
 * `warmDictionary()` — the thing that decides whether the first lookup of a
 * session costs a second or nothing.
 *
 * Most of the assertions are about **work done**, never about wall clock: the
 * property that matters is not "fast" but "there is nothing left to build", which
 * is observable and is what makes it fast.
 *
 * The last case is the deliberate exception. The warm-up's *other* promise is that
 * it does not freeze the instance while it runs, and that promise is only about
 * time — the first version of this test asserted "the loop was handed back at
 * least once" and passed happily on an implementation that stalled for 400 ms at a
 * stretch, while `GET /lookup` went from 21 ms to 1.32 s behind it. So this one
 * measures the longest gap between 1 ms timer ticks and bounds it. The bound is
 * loose enough for a loaded runner (50 ms against a measured 23–25 ms) and still
 * an order of magnitude below the behaviour it exists to catch.
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

  it('yields inside each part, so a request landing mid-warm-up is served', async () => {
    // The state a real instance is in when `after()` fires: the HEAD probe has
    // paid for the parse and its own three parts, and the ~1.3 s that is left is
    // what everything else on this instance has to share the CPU with.
    resetDictCache();
    void getDictIndex().byHsk;

    const gaps: number[] = [];
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
    }, 1);

    last = performance.now();
    const result = await warmDictionary();
    clearInterval(timer);

    // How long the event loop was held each time, not how often it was handed
    // back: the first version of this test asserted `ticks > 0`, which one yield
    // in the middle of a two-second block satisfies — and that is exactly what the
    // implementation was doing, at 400 ms a stall.
    const sorted = [...gaps].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const worst = sorted[sorted.length - 1];

    // Alone on the build box this run measures p99 ~10 ms and a worst stall of
    // 23–25 ms; inside a full `pnpm test`, where eight workers share four cores,
    // p99 ~11–16 ms and worst 28–45 ms. The bounds are those with room for a
    // loaded runner, and the point is that the behaviour they replace scored 400
    // on both, with six samples in the whole warm-up.
    expect(p99).toBeLessThan(30);
    expect(worst).toBeLessThan(150);
    // And it really ran in slices rather than finishing before the timer could
    // fire: one step per part would be 8.
    expect(result.steps).toBeGreaterThan(100);
    expect(gaps.length).toBeGreaterThan(50);
  }, 120_000);
});
