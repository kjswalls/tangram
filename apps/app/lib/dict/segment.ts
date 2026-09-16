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
 *
 * **What is left here after `data.md` D6.** The DP — `route`, `planSegments`,
 * `attachIds`, `segmentWith` — is what D3 inverted so that it takes an injected
 * candidate map and a `SegmentStats` value instead of reaching into an in-memory
 * index, and it is **shared**: `lib/dict/sqlite-store.ts` drives it on every
 * platform. What is gone is the entry point that reached into
 * `lib/dict/index.ts` for the candidates and for `detectScript`, together with
 * the three index-shaped helpers (`headwordFreq`, `headwordTotals`,
 * `detectScript`) that only ever served the build step and its verifier. Those
 * moved to `scripts/dict-json.ts`, which is where the JSON dictionary now lives;
 * `detectScriptFrom(chars, text)` in `lib/dict/sqlite-store.ts` is the store's
 * answer to the same question, off the `chars` table.
 */
import { hasCjk } from './rank';
import type { EntryId } from './types';
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
  stats: SegmentStats,
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
 *
 * **What is left here after `data.md` D6.** The DP — `route`, `planSegments`,
 * `attachIds`, `segmentWith` — is what D3 inverted so that it takes an injected
 * candidate map and a `SegmentStats` value instead of reaching into an in-memory
 * index, and it is **shared**: `lib/dict/sqlite-store.ts` drives it on every
 * platform. What is gone is the entry point that reached into
 * `lib/dict/index.ts` for the candidates and for `detectScript`, together with
 * the three index-shaped helpers (`headwordFreq`, `headwordTotals`,
 * `detectScript`) that only ever served the build step and its verifier. Those
 * moved to `scripts/dict-json.ts`, which is where the JSON dictionary now lives;
 * `detectScriptFrom(chars, text)` in `lib/dict/sqlite-store.ts` is the store's
 * answer to the same question, off the `chars` table.
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
