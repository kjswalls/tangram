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

/**
 * The frequency the DP scores a headword at, and the value `words.freq` holds in
 * the artifact. Exported because `scripts/build-data.ts` and
 * `scripts/verify-data.ts` must *call* it rather than re-implement it: SQL
 * `MAX(freq)` and replaying `compareEntries` give a different answer wherever a
 * jieba frequency is 0 or absent, and the symptom is a sentence nobody wrote a
 * segmentation case for (data.md §6).
 */
export function headwordFreq(index: DictIndex, ids: readonly EntryId[]): number {
  // Ids are stored frequency-descending, so the first one carries the word's freq.
  const first = ids.length > 0 ? index.entries.get(ids[0]) : undefined;
  return first?.freq ?? 1;
}

/**
 * The two numbers the DP needs about a script, before the log is taken:
 * the summed head frequency of every headword, and the longest headword the
 * scan will try.
 *
 * Exported for the same reason `headwordFreq` is. `scripts/build-data.ts`
 * writes both into `meta` and `scripts/verify-data.ts` checks them, and D2
 * replaces this function with a `meta` read — so all three have to agree about
 * `maxLen`'s quirk (a headword longer than `MAX_WORD_CHARS` does not raise it)
 * and about summing `headwordFreq` rather than raw `freq`. Two re-implementations
 * of a nine-line loop is how the segmenter's floor quietly shifts.
 */
export function headwordTotals(
  index: DictIndex,
  script: SegmentScript,
): { total: number; maxLen: number } {
  const map = script === 'simp' ? index.bySimp : index.byTrad;
  let total = 0;
  let maxLen = 1;
  for (const [word, ids] of map) {
    total += headwordFreq(index, ids);
    const length = [...word].length;
    if (length > maxLen && length <= MAX_WORD_CHARS) maxLen = length;
  }
  return { total, maxLen };
}

function statsFor(index: DictIndex, script: SegmentScript): ScriptStats {
  const { total, maxLen } = headwordTotals(index, script);
  return { logTotal: Math.log(total || 1), maxLen };
}

function segmentIndex(index: DictIndex): SegmentIndex {
  let cached = STATS.get(index);
  if (!cached) {
    cached = { simp: statsFor(index, 'simp'), trad: statsFor(index, 'trad') };
    STATS.set(index, cached);
  }
  return cached;
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

/**
 * One hanzi run → the character indexes it should be cut at.
 *
 * The inversion (docs/plans/data.md D3) changes the signature and **nothing
 * else**: `lookup`/`freqOf` become one `freqOf(word)`, because under a
 * `words(script, word, freq)` table there are no entry ids during the DP — they
 * are fetched for the chosen words afterwards. The loop body's two changes are
 * mechanical, `const ids = lookup(word)` → `const freq = freqOf(word)` and
 * `if (!ids && length > 1) continue` → `if (freq === undefined && length > 1)
 * continue`, and everything else is checkable as a line-level diff: the reverse
 * scan, `Math.min(stats.maxLen, n - i)`, `-stats.logTotal` as the unknown-word
 * weight, `Math.log(freq) - stats.logTotal`, and jieba's `(score, end)`
 * tie-break where a longer word wins an exact tie.
 */
function route(
  chars: readonly string[],
  freqOf: (word: string) => number | undefined,
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
      const freq = freqOf(word);
      if (freq === undefined && length > 1) continue;
      const weight = freq === undefined ? floor : Math.log(freq) - stats.logTotal;
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

// ---------------------------------------------------------------------------
// The inverted segmenter (docs/plans/data.md D3)
// ---------------------------------------------------------------------------

/** The two constants of a script. Read from `meta` by the store, computed by the index. */
export interface SegmentStats {
  logTotal: number;
  maxLen: number;
}

/**
 * Everything the DP needs that is not the text, as D3 specifies it.
 *
 * `candidates` spans **both scripts**, with the chosen script winning on
 * collision, and that is not an optimisation — a regression case depends on it.
 * `segment()` looks a word up in the chosen script's headwords and falls back to
 * the other script's, and `segment.test.ts` asserts that `segment('學習',
 * { script: 'simp' })` returns `'simp'`: 學習 is a *traditional* headword, so it
 * is found only through that fallback. A single-script candidate query returns
 * nothing for it, the DP falls back to single characters, and the assertion
 * changes meaning without failing loudly.
 */
export interface SegmentInput {
  script: SegmentScript;
  stats: SegmentStats;
  candidates: ReadonlyMap<string, number>;
  /** Every reading of a chosen word, in rowid order. */
  idsFor: (word: string) => readonly EntryId[];
}

/** What the DP decided, before any entry ids have been fetched. */
export interface SegmentPlan {
  text: string;
  script: SegmentScript;
  /** Tokens with `entryIds` still empty; `via` is already correct. */
  tokens: Token[];
  /** The distinct chosen word tokens that matched a headword, in order. */
  words: string[];
}

/**
 * Cut the text, without needing any entry ids.
 *
 * Split out from `segmentWith` because the store cannot have both halves at
 * once: D3 budgets `segment()` at two round trips, one for the candidate
 * substrings and one for "the chosen words' entry ids", and the chosen words are
 * not known until this function has run. `SegmentInput.idsFor` as D3 prints it
 * cannot be filled before the call it is an argument to.
 */
export function planSegments(
  text: string,
  input: { script: SegmentScript; stats: SegmentStats; freqOf: (word: string) => number | undefined },
): SegmentPlan {
  const { script, stats, freqOf } = input;
  const tokens: Token[] = [];
  const words: string[] = [];
  const seen = new Set<string>();

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
    const cuts = route(run, freqOf, stats);
    let at = 0;
    while (at < run.length) {
      const end = cuts[at].end;
      const word = run.slice(at, end).join('');
      const known = freqOf(word) !== undefined;
      tokens.push({
        text: word,
        start: offsets[i + at],
        end: offsets[i + end],
        kind: 'word',
        entryIds: [],
        via: known ? 'entry' : 'fallback',
      });
      if (known && !seen.has(word)) {
        seen.add(word);
        words.push(word);
      }
      at = end;
    }
    i = runEnd;
  }

  return { text, script, tokens, words };
}

/**
 * Fill in each word token's readings.
 *
 * `entryIds` carries **every** reading of the matched headword, frequency-ordered
 * and never truncated: 了 is one token with `le` and `liǎo` on it, and the panel
 * that opens from a tap is the thing that decides between them.
 */
export function attachIds(
  plan: SegmentPlan,
  idsFor: (word: string) => readonly EntryId[],
): SegmentResult {
  return {
    text: plan.text,
    script: plan.script,
    tokens: plan.tokens.map((token) =>
      token.kind === 'word' && token.via === 'entry'
        ? { ...token, entryIds: [...idsFor(token.text)] }
        : token,
    ),
  };
}

/** D3's named entry point, for a caller that already holds both halves. */
export function segmentWith(text: string, input: SegmentInput): SegmentResult {
  const plan = planSegments(text, {
    script: input.script,
    stats: input.stats,
    freqOf: (word) => input.candidates.get(word),
  });
  return attachIds(plan, input.idsFor);
}

/**
 * Segment a string against the JSON index. Throws `DictDataMissingError` when
 * `data/` has not been built, which the route turns into a 503.
 *
 * Kept until D6: it is the differential oracle `tests/unit/dict/segment.test.ts`
 * and the store's own tests compare against, and it now drives the **same** DP
 * the store does, so the two cannot disagree about the cutting — only about
 * which candidates they were given.
 */
export function segment(text: string, options: SegmentOptions = {}): SegmentResult {
  const index = getDictIndex();
  const script = options.script ?? detectScript(index, text);
  const stats = segmentIndex(index)[script];
  const primary = script === 'simp' ? index.bySimp : index.byTrad;
  const secondary = script === 'simp' ? index.byTrad : index.bySimp;
  const lookup = (word: string): EntryId[] | undefined => primary.get(word) ?? secondary.get(word);
  const freqOf = (word: string): number | undefined => {
    const ids = lookup(word);
    return ids ? headwordFreq(index, ids) : undefined;
  };
  const plan = planSegments(text, { script, stats, freqOf });
  return attachIds(plan, (word) => lookup(word) ?? []);
}
