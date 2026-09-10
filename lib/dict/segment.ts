/**
 * Segmentation (PLAN.md §3.2) — jieba's algorithm, minus the HMM, over Tangram's
 * own dictionary.
 *
 * Two passes:
 *
 *   1. **Classify runs.** A stretch of hanzi is segmented; everything else —
 *      Latin, digits, whitespace, and every flavour of punctuation, `。！？` very
 *      much included — passes straight through as a `text` token that is never
 *      looked up and never coloured. Chinese punctuation is not in the ideograph
 *      blocks, so this falls out of the character test rather than a list.
 *   2. **Max-probability DP** over the headword DAG of each hanzi run, scoring a
 *      word at `log(freq / total)` with jieba's frequencies and giving an unknown
 *      single character the floor weight `log(1 / total)`. Longer words win ties,
 *      which is jieba's own tie-break. No HMM: an unknown name stays a run of
 *      single characters instead of being guessed at, and a guess is exactly what
 *      a learner cannot check.
 *
 * `entryIds` carries **every** reading of the matched headword, frequency-ordered
 * and never truncated: 了 is one token with `le` and `liǎo` on it, and the panel
 * that opens from a tap is the thing that decides between them.
 */
import { drain, SLICE } from './incremental';
import { getDictIndex, type DictIndex } from './index';
import { hasCjk } from './search';
import type { DictEntry, EntryId } from './types';
import type { Token } from '../types';

export type SegmentScript = 'simp' | 'trad';

export interface SegmentOptions {
  /** Force a script instead of inferring it from the text. */
  script?: SegmentScript;
}

export interface SegmentResult {
  text: string;
  /** The script the DAG was matched against. */
  script: SegmentScript;
  tokens: Token[];
}

/** Longest headword the DAG will try. CC-CEDICT's proverbs run longer; a 16-hanzi
 *  span is already far past any word a reader taps, and it bounds the scan. */
const MAX_WORD_CHARS = 16;

interface ScriptStats {
  logTotal: number;
  maxLen: number;
}

interface SegmentIndex {
  simp: ScriptStats;
  trad: ScriptStats;
}

/** Keyed off the index object, so `resetDictCache()` drops this with everything else. */
const STATS = new WeakMap<DictIndex, SegmentIndex>();

function headwordFreq(index: DictIndex, ids: readonly EntryId[]): number {
  // Ids are stored frequency-descending, so the first one carries the word's freq.
  const first = ids.length > 0 ? index.entries.get(ids[0]) : undefined;
  return first?.freq ?? 1;
}

function* statsForInSlices(
  index: DictIndex,
  map: Map<string, EntryId[]>,
): Generator<void, ScriptStats> {
  let total = 0;
  let maxLen = 1;
  let seen = 0;
  for (const [word, ids] of map) {
    total += headwordFreq(index, ids);
    const length = [...word].length;
    if (length > maxLen && length <= MAX_WORD_CHARS) maxLen = length;
    seen += 1;
    if (seen % SLICE === 0) yield;
  }
  return { logTotal: Math.log(total || 1), maxLen };
}

/**
 * Build the DAG statistics in bounded steps — two walks of a 120k-key map, ~110 ms
 * together, which the warm-up must not do in one go. One implementation, two
 * drivers: see `lib/dict/incremental.ts`.
 */
export function* warmSegmentStatsInSlices(index: DictIndex): Generator<void> {
  if (STATS.has(index)) return;
  const simp = yield* statsForInSlices(index, index.bySimp);
  const trad = yield* statsForInSlices(index, index.byTrad);
  STATS.set(index, { simp, trad });
}

function segmentIndex(index: DictIndex): SegmentIndex {
  let cached = STATS.get(index);
  if (!cached) {
    drain(warmSegmentStatsInSlices(index));
    cached = STATS.get(index) as SegmentIndex;
  }
  return cached;
}

/**
 * Build the DAG's per-script statistics now, in one go, if this process has not
 * already — the eager sibling of `warmSegmentStatsInSlices`.
 *
 * Same reason as `warmHeadwords` in search.ts: `STATS` is not one of
 * `DICT_INDEX_PARTS`, so a warm-up that walks the index parts leaves the first
 * reader paste of a session paying for it, and both spellings live here so the
 * WeakMap keeps one owner. Returns whether this call did the building.
 */
export function warmSegmentStats(index: DictIndex): boolean {
  if (STATS.has(index)) return false;
  segmentIndex(index);
  return true;
}

/** Whether this process has the segmenter statistics for `index`. Diagnostic. */
export function segmentStatsWarm(index: DictIndex): boolean {
  return STATS.has(index);
}

/**
 * Which script the text is written in. A character counts as evidence only when
 * the two scripts disagree about it — 我 and 的 are the same in both and say
 * nothing, 學 and 学 each say a great deal. Ties go to simplified, the app default.
 */
export function detectScript(index: DictIndex, text: string): SegmentScript {
  let simp = 0;
  let trad = 0;
  for (const char of text) {
    if (!hasCjk(char)) continue;
    for (const id of index.bySimp.get(char) ?? []) {
      const entry = index.entries.get(id) as DictEntry;
      if (entry.trad !== char) {
        simp += 1;
        break;
      }
    }
    for (const id of index.byTrad.get(char) ?? []) {
      const entry = index.entries.get(id) as DictEntry;
      if (entry.simp !== char) {
        trad += 1;
        break;
      }
    }
  }
  return trad > simp ? 'trad' : 'simp';
}

interface Cut {
  /** Exclusive end, as an index into the run's character array. */
  end: number;
  score: number;
}

/** One hanzi run → the character indexes it should be cut at. */
function route(
  chars: readonly string[],
  lookup: (word: string) => EntryId[] | undefined,
  freqOf: (ids: readonly EntryId[]) => number,
  stats: ScriptStats,
): Cut[] {
  const n = chars.length;
  const floor = -stats.logTotal;
  const best: Cut[] = new Array(n + 1);
  best[n] = { end: n, score: 0 };
  for (let i = n - 1; i >= 0; i -= 1) {
    let chosen: Cut | null = null;
    const span = Math.min(stats.maxLen, n - i);
    for (let length = 1; length <= span; length += 1) {
      const end = i + length;
      const word = chars.slice(i, end).join('');
      const ids = lookup(word);
      if (!ids && length > 1) continue;
      const weight = ids ? Math.log(freqOf(ids)) - stats.logTotal : floor;
      const score = weight + best[end].score;
      // jieba compares `(score, end)`, so a longer word wins an exact tie.
      if (chosen === null || score > chosen.score || (score === chosen.score && end > chosen.end)) {
        chosen = { end, score };
      }
    }
    best[i] = chosen as Cut;
  }
  return best;
}

/**
 * Segment a string. Throws `DictDataMissingError` when `data/` has not been built,
 * which the route turns into a 503.
 */
export function segment(text: string, options: SegmentOptions = {}): SegmentResult {
  const index = getDictIndex();
  const script = options.script ?? detectScript(index, text);
  const stats = segmentIndex(index)[script];
  const primary = script === 'simp' ? index.bySimp : index.byTrad;
  const secondary = script === 'simp' ? index.byTrad : index.bySimp;
  const lookup = (word: string): EntryId[] | undefined =>
    primary.get(word) ?? secondary.get(word);
  const freqOf = (ids: readonly EntryId[]): number => headwordFreq(index, ids);

  const tokens: Token[] = [];
  // Character array plus its UTF-16 offsets: `Token.start`/`end` are code units
  // (lib/types.ts), while the DAG has to run over code points or a rare
  // extension-B character would be cut in half.
  const chars: string[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  for (const char of text) {
    chars.push(char);
    offsets.push(cursor);
    cursor += char.length;
  }
  offsets.push(cursor);

  let i = 0;
  while (i < chars.length) {
    if (!hasCjk(chars[i])) {
      let end = i;
      while (end < chars.length && !hasCjk(chars[end])) end += 1;
      tokens.push({
        text: text.slice(offsets[i], offsets[end]),
        start: offsets[i],
        end: offsets[end],
        kind: 'text',
        entryIds: [],
        via: 'fallback',
      });
      i = end;
      continue;
    }

    let runEnd = i;
    while (runEnd < chars.length && hasCjk(chars[runEnd])) runEnd += 1;
    const run = chars.slice(i, runEnd);
    const cuts = route(run, lookup, freqOf, stats);
    let at = 0;
    while (at < run.length) {
      const end = cuts[at].end;
      const word = run.slice(at, end).join('');
      const ids = lookup(word);
      tokens.push({
        text: word,
        start: offsets[i + at],
        end: offsets[i + end],
        kind: 'word',
        entryIds: ids ? [...ids] : [],
        via: ids ? 'entry' : 'fallback',
      });
      at = end;
    }
    i = runEnd;
  }

  return { text, script, tokens };
}
