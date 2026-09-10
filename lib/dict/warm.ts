/**
 * Warming the dictionary — building, once per process and off the critical path,
 * everything a session is going to need anyway.
 *
 * The indexes in `lib/dict/index.ts` are lazy on purpose (see the comment on
 * `DICT_INDEX_PARTS`): a route pays only for the parts it reads. That is the right
 * default and it is not what this file changes. What it changes is *when* the bill
 * arrives. Measured in one warm process, a session pays:
 *
 *   - app open, the banner's `HEAD /api/dict/hsk` → `sorted`, `entries`, `hsk`
 *     (~1.0 s, nobody waiting on it);
 *   - **first lookup** → `hanzi`, `pinyin`, `gloss` and the search headword cache
 *     (~1.0–1.4 s, and a learner is watching the box);
 *   - **first reader paste** → the segmenter's DAG statistics (~0.1–0.3 s, likewise).
 *
 * `warmDictionary()` moves the second and third bills onto the first moment, which
 * is already unattended. Two properties make that safe rather than merely earlier:
 *
 *  1. **It yields between parts.** Each part is up to ~800 ms of uninterruptible
 *     synchronous work, so without a yield a request landing on this instance
 *     mid-warm-up would queue behind the whole ~2.3 s. With one, it waits for at
 *     most the part in flight.
 *  2. **It is memoised on the in-flight promise.** Two overlapping calls — the
 *     banner's probe racing a real request that also warms — must not build the
 *     47,000-key gloss index twice.
 *
 * Everything it touches is already memoised per process by `dictCache()`, so a
 * second call once things are warm is a WeakMap lookup and a few getter reads.
 */
import {
  builtIndexParts,
  DICT_INDEX_PARTS,
  getDictIndex,
  type DictIndex,
  type DictIndexPart,
} from './index';
import { headwordsWarm, warmHeadwords } from './search';
import { segmentStatsWarm, warmSegmentStats } from './segment';

/**
 * The caches that are *not* index parts: `search.ts`'s headword prefix indexes and
 * `segment.ts`'s DAG statistics. They are keyed off the index object rather than
 * stored in it, so `builtIndexParts()` cannot see them and a warm-up that only
 * walked `DICT_INDEX_PARTS` would leave both of the felt pauses in place.
 */
export const DICT_WARM_CACHES = ['headwords', 'segment-stats'] as const;
export type DictWarmCache = (typeof DICT_WARM_CACHES)[number];

export interface WarmResult {
  /** Index parts this process had already built when the warm-up started. */
  alreadyBuilt: DictIndexPart[];
  /** Index parts this warm-up built, in `DICT_INDEX_PARTS` order. */
  built: DictIndexPart[];
  /** Non-part caches this warm-up built. */
  caches: DictWarmCache[];
  /** Wall clock spent, yields included. Diagnostic; nothing branches on it. */
  ms: number;
}

/**
 * One index part → the public getters that force it.
 *
 * `#sorted` has no getter of its own — every other part is derived from it — so
 * the way to force it is the thinnest part built on top of it, `entries`. The two
 * rows are therefore the same expression, and that is fine: the second is a
 * memoised read, and `built` is computed by diffing `builtIndexParts()` rather
 * than by counting rows here.
 */
const TOUCH: Record<DictIndexPart, (index: DictIndex) => void> = {
  sorted: (index) => void index.entries,
  entries: (index) => void index.entries,
  hanzi: (index) => {
    void index.bySimp;
    void index.byTrad;
  },
  pinyin: (index) => {
    void index.byPinyinToneless;
    void index.byPinyinToned;
  },
  gloss: (index) => void index.byGloss,
  hsk: (index) => void index.byHsk,
};

/**
 * Hand the event loop back.
 *
 * `setImmediate`, not `await null`: a microtask yield runs before pending I/O, so
 * it would let the warm-up finish end to end without ever serving the request that
 * arrived in the middle. A macrotask is the one that puts the socket first.
 */
function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * The warm-up in flight, keyed on the index object it is warming. A WeakMap and
 * not a module variable so that `resetDictCache()` — which drops the index — drops
 * this with it, exactly as the two caches it warms already do.
 */
const IN_FLIGHT = new WeakMap<DictIndex, Promise<WarmResult>>();

async function warmAll(index: DictIndex): Promise<WarmResult> {
  const startedAt = performance.now();
  const alreadyBuilt = builtIndexParts();

  for (const part of DICT_INDEX_PARTS) {
    // Yield *before* each part rather than after, so that a caller which awaits
    // this cannot be handed the whole first part synchronously.
    await yieldToLoop();
    TOUCH[part](index);
  }

  const caches: DictWarmCache[] = [];
  await yieldToLoop();
  if (warmHeadwords(index)) caches.push('headwords');
  await yieldToLoop();
  if (warmSegmentStats(index)) caches.push('segment-stats');

  const built = builtIndexParts().filter((part) => !alreadyBuilt.includes(part));
  return { alreadyBuilt, built, caches, ms: performance.now() - startedAt };
}

/**
 * Build every dictionary index part and both out-of-band caches, yielding between
 * them. Idempotent, cheap once warm, and safe to call concurrently with itself.
 *
 * Throws `DictDataMissingError` when `data/` has not been built — synchronously,
 * from the same `getDictIndex()` every route already calls, so a caller inside a
 * route's `try` gets the usual 503 rather than a rejected promise it forgot about.
 */
export function warmDictionary(): Promise<WarmResult> {
  const index = getDictIndex();
  const existing = IN_FLIGHT.get(index);
  if (existing) return existing;

  const run = warmAll(index);
  IN_FLIGHT.set(index, run);
  // A settled promise is kept: a later call then costs one WeakMap lookup and
  // reports, truthfully, what this process built. A *rejected* one is forgotten,
  // so a warm-up that died half-way can be retried instead of being remembered as
  // done. `.catch` here also means the memo never counts as an unhandled
  // rejection; the promise handed to the caller is a separate handle.
  void run.catch(() => {
    IN_FLIGHT.delete(index);
  });
  return run;
}

/** Whether everything `warmDictionary()` builds is built in this process. */
export function dictionaryWarm(): boolean {
  const parts = builtIndexParts();
  if (parts.length !== DICT_INDEX_PARTS.length) return false;
  const index = getDictIndex();
  return headwordsWarm(index) && segmentStatsWarm(index);
}
