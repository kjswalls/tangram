/**
 * The character sets the font pipeline is measured and cut against
 * (docs/plans/web.md W6, docs/plans/core.md C0, docs/STACK.md register #9).
 *
 * Three scripts read these and they must not disagree about what "the
 * dictionary's characters" means: `font-coverage.ts` measures a *candidate*
 * face against them, `font-subset.ts` cuts the *shipped* files from them, and
 * `font-coverage-check.ts` asserts the shipped files cover them. A second
 * extractor written a second time is how a subset and its coverage check end up
 * agreeing with each other about the wrong set.
 *
 * **Two sets, because the app renders two different things in two different
 * stacks.**
 *
 * - `headwordChars()` — every code point in a `simp` or `trad` headword. This
 *   is register #9's question and it is what `--font-hanzi` must cover.
 * - `pinyinChars()` — every code point in a `pinyinMarked` or `pinyin` field.
 *   This is what `--font-ui` and `--font-display` must cover, because marked
 *   pinyin is rendered in the UI face (`components/hanzi/ruby.css` sets
 *   `rt { font-family: var(--font-ui) }`) and NOT in the hanzi face. Nobody had
 *   measured it before W6 and the answer is in HANDOFF.md: DM Sans and
 *   Newsreader are both missing the nine caron/diaeresis tone vowels, which is
 *   every third tone on a, i, o, u and every tone on ü.
 *
 * Gloss text is deliberately **not** a gated set. It is real-world English with
 * 6,804 distinct non-ASCII code points in it — Greek, Cyrillic, Hebrew, kana,
 * hanzi, hexagrams, card suits — and no shipped face is going to cover that.
 * What it is is a *report*, which `font-coverage.ts` can print and W6 records.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { dirOf, workspaceRoot } from '../apps/app/lib/server/roots';

import type { DictFile } from '../apps/app/lib/types';

export const repoRoot = workspaceRoot(dirOf(import.meta.url));

export function dataDir(): string {
  return process.env.TANGRAM_DATA_DIR
    ? resolve(repoRoot, process.env.TANGRAM_DATA_DIR)
    : resolve(repoRoot, 'data');
}

export interface CharFacts {
  /** Every distinct code point, as single-code-point strings. */
  chars: string[];
  /** char → the best (lowest) freqRank of any entry that contains it. */
  bestRank: Map<string, number>;
  entries: number;
}

let cached: DictFile | undefined;

function dict(): DictFile {
  if (cached) return cached;
  const file = resolve(dataDir(), 'dict.json');
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing. Run \`pnpm data\` first — the coverage set is the dictionary's own headwords.`,
    );
  }
  cached = JSON.parse(readFileSync(file, 'utf8')) as DictFile;
  return cached;
}

/**
 * Iterate by code point, never by UTF-16 unit: CC-CEDICT headwords reach into
 * the astral planes (CJK Ext B lives at U+20000) and a unit loop would measure
 * surrogate halves, which no cmap has and every font would "fail".
 */
function collect(texts: (entry: DictFile['entries'][number]) => readonly string[]): CharFacts {
  const bestRank = new Map<string, number>();
  const seen = new Set<string>();
  const file = dict();
  for (const entry of file.entries) {
    // `freqRank` is jieba's rank, 1 = most frequent. An entry with no rank is
    // ranked after every entry that has one rather than dropped, so a character
    // that only ever appears in unranked entries still gets a number.
    const rank = entry.freqRank ?? Number.MAX_SAFE_INTEGER;
    for (const text of texts(entry)) {
      for (const ch of text) {
        seen.add(ch);
        const best = bestRank.get(ch);
        if (best === undefined || rank < best) bestRank.set(ch, rank);
      }
    }
  }
  return { chars: [...seen], bestRank, entries: file.entries.length };
}

/** Register #9's set: what `--font-hanzi` has to cover. */
export function headwordChars(): CharFacts {
  return collect((entry) => [entry.simp, entry.trad]);
}

/**
 * What `--font-ui` and `--font-display` have to cover. See the header.
 *
 * Both forms: `pinyinMarked` is what a learner is shown (`dǎsuàn`) and
 * `pinyinNum` is what CC-CEDICT stores and what the lookup box is typed in
 * (`da3 suan4`, with `u:` for ü) — the search field renders the second and the
 * ruby renders the first, so both are on screen in the UI face.
 */
export function pinyinChars(): CharFacts {
  return collect((entry) => [entry.pinyinMarked, entry.pinyinNum]);
}

/** Reported, never gated. See the header. */
export function glossChars(): CharFacts {
  return collect((entry) => entry.glosses ?? []);
}

/**
 * Latin text the app writes itself, which the dictionary cannot supply: the
 * ASCII the UI is written in, plus the typographic marks the copy actually
 * uses — curly quotes, the en and em dash, the ellipsis, the multiplication
 * sign in "43 MB × 2". Kept as an explicit list rather than "all of Latin-1"
 * so that a character appearing here is a character somebody decided to ship.
 */
export const UI_EXTRA: readonly string[] = [
  ...Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCodePoint(0x20 + i)),
  '\u00a0', // no-break space
  '\u00ad', // soft hyphen
  '°',
  '·', // · — the pinyin middle dot, and CC-CEDICT's proper-noun separator
  '×',
  '–',
  '—',
  '‘',
  '’', // ’ — the apostrophe in "It’s", used throughout the copy
  '“',
  '”',
  '…',
  '→',
  '−',
];

/**
 * The hanzi the app draws **as chrome**, on every screen, whatever the
 * dictionary says: the wordmark beside "Tangram" in `components/shell/site-header.tsx`
 * and the same three characters in `components/practice/tangram-progress.tsx`.
 *
 * It is here because frequency order put them in slices 3 and 7, so a first
 * paint of any route fetched **607 KB of hanzi to draw three characters of
 * branding** — measured, on the first build that shipped these fonts. They go
 * in the first slice with the rest of the app's own text.
 * `tests/unit/fonts/app-hanzi.test.ts` fails if the chrome grows a character
 * this list does not have.
 */
export const APP_HANZI = '七巧板';

/**
 * CJK punctuation and symbols a Chinese run carries with it. They belong in the
 * hanzi face's first slice: a pasted sentence is headwords plus these, and
 * falling back to a system face for the comma alone is the mid-word font switch
 * that makes a passage look broken.
 */
export const HANZI_EXTRA: readonly string[] = [
  // The Latin the hanzi face has to draw itself. `.hanzi` is a *span* of
  // Chinese, and Chinese carries digits and the odd Latin word inside it —
  // "2020年", "PM2.5" — so without these the run switches font mid-word to
  // whatever the stack's `serif` fallback is, which is the exact seam the
  // bundled face exists to remove. Noto Serif SC has real Latin glyphs;
  // ninety-five code points in the first slice costs about 3 KB.
  ...UI_EXTRA,
  ...APP_HANZI,
  ...'、。〃〈〉《》「」『』【】〔〕〖〗〝〞〟・ー―‖…‥',
  ...'！＂＃＄％＆＇（）＊＋，－．／：；＜＝＞？＠［＼］＾＿｀｛｜｝～',
  '\u3000', // ideographic space
  '〇',
  '・',
];
